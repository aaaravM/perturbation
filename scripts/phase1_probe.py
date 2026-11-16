"""Phase 1 probe: one target end to end on real SPHEREx data, with pass/fail against fixed validation criteria.

Run from backend/ (the uv project):

    uv run python ../scripts/phase1_probe.py --target barnards-star --fov-arcmin 6

Steps: resolve the name (pxh.sky) -> SIA index over the discovered Level-2 collections (deep collections for
r-dra only, capped to one exposure per detector pair per day) -> exposures and epochs -> for every detector
image the apparent (geocentric) target position at its MJD-AVG and a byte-range stamp with flags, variance,
zodi and wavelength (thread pool) -> per-epoch, per-detector inverse-variance co-adds on a shared north-up
grid (science mask; saturated pixels masked and reported) -> PNG frames, blink GIFs and S/N difference
images -> positions (per-exposure ePSF fits; per-epoch D5+D6 co-add fits for wise-0855) and a proper-motion
fit against the catalog -> forced photometry for every exposure, per-epoch spectra, epoch light curves and
the DR1 cube quick-look spectrum -> target-specific acceptance criteria.

Everything is written to docs/phase1/<slug>/ (summary.json, blink_D<n>.gif, diff_D<n>.png, spectrum.png,
lightcurve.png, motion.png, frames/), and docs/phase1/summary.json aggregates every target run so far. The
repository keeps the summaries and the figures that docs/data-findings.md shows.
Downloads are cached under data/cache (re-runs are fast). Thresholds are fixed a priori in this file and in
the project's validation criteria; they are never tuned to the data.
"""

from __future__ import annotations

import argparse
import io
import json
import logging
import math
import sys
import time
import traceback
import warnings
from collections import Counter, defaultdict
from collections.abc import Callable, Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import UTC, datetime
from itertools import pairwise
from typing import Any

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from PIL import Image, ImageDraw, ImageFont
from scipy import stats as sstats
from scipy.optimize import least_squares

from pxh import config
from pxh.imaging import align, render
from pxh.imaging import coadd as coadd_mod
from pxh.imaging import diff as diff_mod
from pxh.models import Astrometry, DetectorImage, Epoch, EPSFGrid, Exposure, Frame, PhotPoint, Stamp
from pxh.photometry import forced, lightcurve, motion, spectrum
from pxh.sky import propagate
from pxh.sky.resolve import resolve
from pxh.sky.targets import TARGETS
from pxh.spherex import cube, l2, rangeio, sia
from pxh.spherex import epochs as ep
from pxh.spherex import flags as fl

log = logging.getLogger("phase1_probe")

DOCS = config.REPO_ROOT / "docs" / "phase1"
PRIMARY = ("barnards-star", "eps-indi-b", "wise-0855", "rw-aur", "r-dra")

# --- a-priori analysis constants (not tuned to the data) ------------------------------------------------
MJD_QUERY = 61050.0  # 2025-12: middle of the SPHEREx data so far; SIA is queried at the position then
SNR_MIN_POSITION = 10.0  # per-exposure ePSF positions used for motion fits
ASTROMETRIC_FLOOR_MAS = (
    100.0  # added in quadrature to per-exposure ePSF position errors (WCS/PSF systematics)
)
DETECTION_SNR = 5.0  # "detected" / "not detected" threshold
BOOTSTRAP = 200  # resamples for co-add position and flux errors (wise-0855)
UPSCALE = 4  # nearest-neighbour upscaling of PNG/GIF products
GIF_MS = 700
MIRA_PERIOD_D = 246.12  # R Dra, AAVSO VSX
MIRA_T0_MJD = 2457370.0 - 2400000.5  # VSX epoch of maximum (JD 2457370)
CATWISE_STATIC_PM = 0.3  # arcsec/yr: CatWISE2020 sources slower than this count as static neighbours
CATWISE_W2_MAX = 17.5

# Categorical palette (fixed order) from the dataviz reference palette; text stays neutral.
PALETTE = ("#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948")
MARKERS = ("o", "s", "^", "D", "v", "P", "X", "*")
INK, INK2, GRID = "#0b0b0b", "#52514e", "#e4e3df"
DET_COLOR = {d: PALETTE[d - 1] for d in range(1, 7)}

TARGET_CFG: dict[str, dict[str, Any]] = {
    "barnards-star": {"motion": "exposures", "motion_dets": (5, 6), "diag_dets": (1, 2, 3, 4)},
    "eps-indi-b": {"motion": "exposures", "motion_dets": (1, 2, 3, 4, 5, 6)},
    "wise-0855": {"motion": "coadd", "motion_dets": (5, 6)},
    "rw-aur": {"motion": "exposures", "motion_dets": (1, 2, 3, 4, 5, 6)},
    "r-dra": {
        "motion": "exposures",
        "motion_dets": (1, 2, 3, 4, 5, 6),
        "deep": True,
        "max_span_days": 30.0,
        "motion_diagnostic_only": True,
    },
}


# --- small helpers ---------------------------------------------------------------------------------------


def jsonable(v: Any) -> Any:
    """Recursively convert numpy types / NaN to JSON-safe values."""
    if isinstance(v, dict):
        return {str(k): jsonable(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [jsonable(x) for x in v]
    if isinstance(v, np.ndarray):
        return jsonable(v.tolist())
    if isinstance(v, (np.bool_, bool)):
        return bool(v)
    if isinstance(v, (np.integer,)):
        return int(v)
    if isinstance(v, (float, np.floating)):
        f = float(v)
        return f if math.isfinite(f) else None
    return v


def r6(v: Any, nd: int = 6) -> Any:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return round(f, nd) if math.isfinite(f) else None


def date(mjd: float) -> str:
    return ep.mjd_to_iso(mjd)[:10]


def hms(seconds: float) -> str:
    return f"{seconds:.1f}s"


@dataclass
class Stage:
    """Wall time and transfer counters of one probe stage."""

    name: str
    seconds: float = 0.0
    requests: int = 0
    bytes: int = 0
    retries: int = 0
    cache_hits: int = 0


class Timer:
    def __init__(self) -> None:
        self.stages: list[Stage] = []

    def run(self, name: str, fn: Callable[[], Any]) -> Any:
        s0 = rangeio.stats()
        t0 = time.perf_counter()
        try:
            return fn()
        finally:
            s1 = rangeio.stats()
            st = Stage(
                name,
                time.perf_counter() - t0,
                s1.requests - s0.requests,
                s1.bytes - s0.bytes,
                s1.retries - s0.retries,
                s1.cache_hits - s0.cache_hits,
            )
            self.stages.append(st)
            log.info(
                "stage %-12s %7.1f s  %5d requests  %8.2f MB", name, st.seconds, st.requests, st.bytes / 1e6
            )

    def as_dict(self) -> dict[str, Any]:
        return {
            s.name: {
                "seconds": round(s.seconds, 2),
                "requests": s.requests,
                "bytes": s.bytes,
                "retries": s.retries,
                "cache_hits": s.cache_hits,
            }
            for s in self.stages
        }


@dataclass
class Item:
    """One detector image: its stamp, predicted position and measurements."""

    image: DetectorImage
    epoch: int
    status: str = "pending"  # ok | outside | error
    error: str = ""
    mjd: float = math.nan
    ra: float = math.nan  # apparent (geocentric) target position at MJD-AVG
    dec: float = math.nan
    stamp: Stamp | None = None
    epsf: EPSFGrid | None = None
    phot: forced.ForcedResult | None = None
    phot_error: str = ""
    pos: forced.ForcedResult | None = None
    pos_wings: forced.ForcedResult | None = None
    wing: dict[str, Any] | None = None
    wing_outer: dict[str, Any] | None = None
    seconds: float = 0.0

    @property
    def det(self) -> int:
        return int(self.image.detector)

    @property
    def ok(self) -> bool:
        return self.status == "ok" and self.stamp is not None


def masks_of(stamp: Stamp) -> tuple[int, int]:
    """(science mask bits, saturation bits) for a stamp's FLAGS bit assignment."""
    return fl.science_mask(stamp.flag_bits), fl.saturation_mask(stamp.flag_bits)


def local_catalog_pm(ast: Astrometry, mjd: float) -> tuple[float, float]:
    """Local proper motion (mas/yr) at ``mjd`` from the rigorous barycentric path (perspective acceleration)."""
    h = 0.5 * 365.25
    ra0, de0 = propagate.barycentric_position(ast, mjd)
    ra1, de1 = propagate.barycentric_position(ast, mjd - h)
    ra2, de2 = propagate.barycentric_position(ast, mjd + h)
    xi, eta = motion.tangent_offsets_mas(np.array([ra1, ra2]), np.array([de1, de2]), float(ra0), float(de0))
    return float(xi[1] - xi[0]), float(eta[1] - eta[0])


def mira_phase(mjd: Any) -> Any:
    return np.mod((np.asarray(mjd, dtype=float) - MIRA_T0_MJD) / MIRA_PERIOD_D, 1.0)


def crit(name: str, passed: bool | None, value: Any, threshold: str, notes: str = "") -> dict[str, Any]:
    return {
        "name": name,
        "pass": None if passed is None else bool(passed),
        "value": jsonable(value),
        "threshold": threshold,
        "notes": notes,
    }


# --- PNG helpers -----------------------------------------------------------------------------------------


def _font(size: int) -> ImageFont.ImageFont:
    for name in ("DejaVuSans.ttf", "arial.ttf", "Arial.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def compose_png(
    base: bytes,
    overlay: bytes | None = None,
    *,
    scale: int = 1,
    label: str | None = None,
    marks: Sequence[tuple[float, float, str]] = (),
    background=(0, 0, 0),
) -> bytes:
    """Flatten a (transparent) PNG onto black, add an overlay, upscale, draw circle marks and a label."""
    im = Image.open(io.BytesIO(base)).convert("RGBA")
    if overlay is not None:
        im = Image.alpha_composite(im, Image.open(io.BytesIO(overlay)).convert("RGBA"))
    flat = Image.new("RGBA", im.size, (*background, 255))
    im = Image.alpha_composite(flat, im).convert("RGB")
    if scale > 1:
        im = im.resize((im.width * scale, im.height * scale), Image.Resampling.NEAREST)
    draw = ImageDraw.Draw(im)
    for col, row, colour in marks:  # PNG pixel coordinates before scaling (0-based, row 0 = north)
        cx, cy, rad = (col + 0.5) * scale, (row + 0.5) * scale, 2.2 * scale
        draw.ellipse([cx - rad, cy - rad, cx + rad, cy + rad], outline=colour, width=max(1, scale // 2))
    if label:
        font = _font(max(10, 3 * scale))
        box = draw.textbbox((4, 3), label, font=font)
        draw.rectangle([box[0] - 2, box[1] - 2, box[2] + 2, box[3] + 2], fill=(0, 0, 0))
        draw.text((4, 3), label, fill=(240, 240, 240), font=font)
    buf = io.BytesIO()
    im.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


# --- catalog helper (CatWISE2020 static neighbours, cached) -----------------------------------------------


def catwise_neighbours(ra: float, dec: float, radius_arcsec: float) -> list[dict[str, Any]]:
    """CatWISE2020 sources within radius from IRSA Gator (IPAC table), cached under CACHE_DIR/catalogs."""
    path = config.CACHE_DIR / "catalogs" / f"catwise2020_{ra:.5f}_{dec:+.5f}_{radius_arcsec:.0f}.tbl"
    if path.exists():
        text = path.read_text(encoding="utf-8")
    else:
        params = {
            "catalog": "catwise_2020",
            "spatial": "cone",
            "radius": f"{radius_arcsec:.1f}",
            "radunits": "arcsec",
            "objstr": f"{ra:.6f} {dec:+.6f}",
            "outfmt": "1",
            "selcols": "source_name,ra,dec,w1mpro,w2mpro,w1sigmpro,w2sigmpro,pmra,pmdec,meanobsmjd",
        }
        text = rangeio.http_get(config.IRSA_GATOR_URL, params=params).decode("utf-8", "replace")
        if "|" not in text:
            raise RuntimeError(f"unexpected Gator answer: {text[:200]!r}")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
    header: list[str] | None = None
    rows: list[dict[str, Any]] = []
    for line in text.splitlines():
        if line.startswith("\\"):
            continue
        if line.startswith("|"):
            if header is None:
                header = [c.strip() for c in line.strip("|").split("|")]
            continue
        if header is None or not line.strip():
            continue
        vals = line.split()
        if len(vals) < len(header):
            continue
        row: dict[str, Any] = {}
        for k, v in zip(header, vals, strict=False):
            try:
                row[k] = float(v)
            except ValueError:
                row[k] = None if v == "null" else v
        rows.append(row)
    return rows


# --- the probe -------------------------------------------------------------------------------------------


class Probe:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.key = args.target
        self.cfg = TARGET_CFG.get(self.key, {"motion": "exposures", "motion_dets": (1, 2, 3, 4, 5, 6)})
        self.out = DOCS / self.key
        self.timer = Timer()
        self.issues: list[str] = []
        self.summary: dict[str, Any] = {}
        self.items: list[Item] = []
        self.frames: dict[tuple[int, int], Frame] = {}
        self.sat_masks: dict[tuple[int, int], np.ndarray] = {}
        self.epsf_memo: dict[tuple[int, str], EPSFGrid] = {}

    # ---------------------------------------------------------------- index
    def resolve_target(self) -> None:
        rn = resolve(self.key)
        self.resolved = rn
        self.ast = rn.astrometry
        self.target = TARGETS.get(rn.target_key or "")
        self.name = rn.name
        pm = math.hypot(self.ast.pmra_masyr, self.ast.pmdec_masyr)
        self.summary["target"] = {
            "key": self.key,
            "name": rn.name,
            "resolver": rn.resolver,
            "target_key": rn.target_key,
            "kind": self.target.kind if self.target else None,
            "astrometry": vars(self.ast) | {"pm_total_masyr": pm},
        }

    def index(self) -> None:
        cols = sia.discover_l2_collections()
        use_deep = bool(self.cfg.get("deep"))
        wanted = [c for c in cols if use_deep or not sia.is_deep_collection(c)]
        ra_q, dec_q = propagate.apparent_position(self.ast, MJD_QUERY)
        pm_arcsec = math.hypot(self.ast.pmra_masyr, self.ast.pmdec_masyr) / 1000.0
        radius = max(0.0005, pm_arcsec * 1.0 / 3600.0)  # one year of motion either side of the query epoch
        searches = sia.search_position(float(ra_q), float(dec_q), radius, wanted)
        failed = [s for s in searches if s.source == "failed"]
        if failed:
            raise RuntimeError("SIA failed for " + ", ".join(f"{s.collection}: {s.error}" for s in failed))
        images = sia.dedupe_images(im for s in searches for im in s.images)
        exposures = ep.group_exposures(images)
        wide = [x for x in exposures if not any(sia.is_deep_collection(im.collection) for im in x.images)]
        deep = [x for x in exposures if any(sia.is_deep_collection(im.collection) for im in x.images)]
        kept_deep: dict[tuple[int, tuple[int, ...]], Exposure] = {}
        for x in sorted(deep, key=lambda x: (x.t_min_mjd, x.obs_id)):
            kept_deep.setdefault((math.floor(x.t_min_mjd), tuple(x.detectors)), x)  # <= 1 per pair per day
        exposures = sorted(wide + list(kept_deep.values()), key=lambda x: (x.t_min_mjd, x.obs_id))
        self.epochs = ep.group_epochs(exposures, max_span_days=self.cfg.get("max_span_days"))
        self.wide_epochs = ep.group_epochs(wide) if use_deep else self.epochs
        epoch_of = {x.obs_id: e.index for e in self.epochs for x in e.exposures}
        self.wide_epoch_of = {x.obs_id: e.index for e in self.wide_epochs for x in e.exposures}
        self.items = [Item(image=im, epoch=epoch_of[x.obs_id]) for x in exposures for im in x.images]
        self.summary["index"] = {
            "query": {"ra_deg": float(ra_q), "dec_deg": float(dec_q), "mjd": MJD_QUERY, "radius_deg": radius},
            "collections_discovered": cols,
            "collections_used": {
                s.collection: {"n_images": len(s.images), "source": s.source, "truncated": s.truncated}
                for s in searches
            },
            "n_images_found": len(images),
            "n_exposures_wide": len(wide),
            "n_exposures_deep_found": len(deep),
            "n_exposures_deep_kept": len(kept_deep),
            "deep_cap": "<= 1 exposure per detector pair per UTC day" if use_deep else None,
            "n_images_used": len(self.items),
            "sia_stats": sia.sia_stats(),
        }
        log.info(
            "%s: %d images (%d exposures) in %d epochs",
            self.key,
            len(self.items),
            len(exposures),
            len(self.epochs),
        )

    # ---------------------------------------------------------------- stamps
    def _stamp_half(self, layout: l2.L2Layout) -> int:
        """Half size that covers the square grid for this detector's rotation (at least --half-size)."""
        grid_half = (self.grid_n - 1) / 2.0
        try:
            m = l2.celestial_wcs(layout.image_header).pixel_scale_matrix
            theta = math.atan2(m[0, 1], m[1, 1])
            factor = abs(math.cos(theta)) + abs(math.sin(theta))
        except Exception:  # noqa: BLE001 - fall back to the worst case
            factor = math.sqrt(2.0)
        return max(int(self.args.half_size), math.ceil(grid_half * factor) + 1)

    def _fetch(self, item: Item) -> Item:
        t0 = time.perf_counter()
        try:
            layout = l2.read_layout(item.image)
            item.mjd = float(layout.image_header["MJD-AVG"])
            ra, dec = propagate.apparent_position(self.ast, item.mjd)
            item.ra, item.dec = float(ra), float(dec)
            item.stamp = l2.read_stamp(item.image, item.ra, item.dec, half_size_px=self._stamp_half(layout))
            item.status = "ok"
        except l2.OutsideDetectorError as exc:
            item.status, item.error = "outside", str(exc)[:200]
        except Exception as exc:  # noqa: BLE001 - recorded per image, the run continues
            item.status, item.error = "error", repr(exc)[:300]
            log.warning("%s D%d: %s", item.image.obs_id, item.det, item.error)
        item.seconds = time.perf_counter() - t0
        return item

    def read_stamps(self) -> None:
        # The shared grid size is known before the stamps: side = round(fov / pixel), odd.
        _, (self.grid_n, _) = align.make_grid(0.0, 0.0, self.args.fov_arcmin)
        n = len(self.items)
        t0 = time.perf_counter()
        done = 0
        with ThreadPoolExecutor(max_workers=self.args.workers) as pool:
            for _ in pool.map(self._fetch, self.items):
                done += 1
                if done % 50 == 0 or done == n:
                    st = rangeio.stats()
                    log.info(
                        "stamps %d/%d  %.0f s  %.1f MB total",
                        done,
                        n,
                        time.perf_counter() - t0,
                        st.bytes / 1e6,
                    )
        counts = Counter(i.status for i in self.items)
        self.summary["stamps"] = {
            "n": n,
            "status": dict(counts),
            "errors": [f"{i.image.obs_id} D{i.det}: {i.error}" for i in self.items if i.status == "error"][
                :20
            ],
        }
        if counts.get("error"):
            self.issues.append(f"{counts['error']} stamp read errors")
        bits = {tuple(sorted(i.stamp.flag_bits.items())) for i in self.items if i.ok}
        if len(bits) > 1:
            sets = [dict(b) for b in bits]
            names = set().union(*sets)
            diff = sorted(n for n in names if len({s.get(n) for s in sets}) > 1)
            self.summary["stamps"]["flag_bit_variants"] = {"n_variants": len(bits), "names_differing": diff}
            if any(len({s.get(n) for s in sets} - {None}) > 1 for n in diff):
                self.issues.append(f"FLAGS bits conflict across files: {diff}")

    def read_epsfs(self) -> None:
        for item in self.items:
            if not item.ok:
                continue
            calib = l2.read_layout(item.image).epsf_calibration
            k = (item.det, calib)
            if k not in self.epsf_memo:
                try:
                    self.epsf_memo[k] = l2.read_epsf(item.image)
                except Exception as exc:  # noqa: BLE001
                    self.issues.append(f"EPSF D{item.det} {calib}: {exc!r}"[:200])
                    continue
            item.epsf = self.epsf_memo.get(k)
        self.summary["epsf"] = {"calibrations": sorted(f"D{d}:{c}" for d, c in self.epsf_memo)}

    # ---------------------------------------------------------------- photometry and positions
    def _measure(self, item: Item) -> None:
        st = item.stamp
        mask_bits, sat_bits = masks_of(st)
        try:
            item.phot = forced.measure_source(
                st, item.ra, item.dec, item.epsf, mask_bits, sat_bits, epoch_index=item.epoch
            )
        except Exception as exc:  # noqa: BLE001
            item.phot_error = repr(exc)[:200]
        if self.cfg["motion"] == "exposures" and (
            item.det in self.cfg["motion_dets"] or item.det in self.cfg.get("diag_dets", ())
        ):
            try:
                item.pos = forced.measure_position(
                    st, item.ra, item.dec, item.epsf, mask_bits, sat_bits, epoch_index=item.epoch
                )
            except Exception:  # noqa: BLE001
                item.pos = None
            if self.key == "barnards-star" and item.det in (5, 6):
                try:
                    item.pos_wings = forced.measure_position(
                        st,
                        item.ra,
                        item.dec,
                        item.epsf,
                        mask_bits,
                        sat_bits,
                        epoch_index=item.epoch,
                        saturated_core="wings",
                    )
                except Exception:  # noqa: BLE001
                    item.pos_wings = None
        if self.key == "r-dra":
            item.wing = wing_index(st, item.ra, item.dec, mask_bits, sat_bits)
            item.wing_outer = wing_index(
                st,
                item.ra,
                item.dec,
                mask_bits,
                sat_bits,
                rings=((8.0, 9.0), (9.0, 10.0), (10.0, 11.0), (11.0, 12.0)),
            )

    def photometry(self) -> None:
        ok = [i for i in self.items if i.ok]
        with ThreadPoolExecutor(max_workers=self.args.workers) as pool:
            list(pool.map(self._measure, ok))
        n_phot = sum(i.phot is not None for i in ok)
        methods = Counter(i.phot.point.method for i in ok if i.phot is not None)
        n_sat = sum(bool(i.phot.point.saturated) for i in ok if i.phot is not None)
        per_det = {}
        for d in range(1, 7):
            sel = [i for i in ok if i.det == d and i.phot is not None]
            if sel:
                per_det[f"D{d}"] = {
                    "n": len(sel),
                    "n_saturated": sum(i.phot.point.saturated for i in sel),
                    "median_snr": float(np.median([i.phot.snr for i in sel])),
                    "methods": dict(Counter(i.phot.point.method for i in sel)),
                }
        self.summary["photometry"] = {
            "n_points": n_phot,
            "n_failed": len(ok) - n_phot,
            "methods": dict(methods),
            "n_saturated": n_sat,
            "per_detector": per_det,
            "failures": [f"{i.image.obs_id} D{i.det}: {i.phot_error}" for i in ok if i.phot is None][:10],
        }

    def points(self, dets: Sequence[int] | None = None) -> list[PhotPoint]:
        return [
            i.phot.point
            for i in self.items
            if i.ok and i.phot is not None and (dets is None or i.det in dets)
        ]

    # ---------------------------------------------------------------- co-adds and rendering
    def build_coadds(self) -> None:
        ok = [i for i in self.items if i.ok]
        ra_c, dec_c = motion.mean_direction([i.ra for i in ok], [i.dec for i in ok])
        self.grid = align.make_grid(ra_c, dec_c, self.args.fov_arcmin)
        gw, shape = self.grid
        # Union over files: some DR1 files (tags v27-2026-230..232) do not define SNOWBALL (bit 27); OR-ing the
        # per-file masks keeps every defined artifact bit masked (an undefined bit is never set in its file).
        self.mask_bits = self.sat_bits = 0
        for i in ok:
            mb, sb = masks_of(i.stamp)
            self.mask_bits |= mb
            self.sat_bits |= sb
        for e in self.epochs:
            for d in range(1, 7):
                stamps = [i.stamp for i in ok if i.epoch == e.index and i.det == d]
                if not stamps:
                    continue
                label = f"D{d} E{e.index}"
                fr = coadd_mod.coadd_stamps(
                    stamps,
                    self.grid,
                    self.mask_bits,
                    label,
                    epoch_index=e.index,
                    detector=d,
                    method="ivw",
                    saturation_bits=self.sat_bits,
                )
                if fr.n_inputs == 0:
                    continue
                self.frames[(e.index, d)] = fr
                self.sat_masks[(e.index, d)] = align.saturated_mask_on_grid(stamps, gw, shape, self.sat_bits)
        self.summary["grid"] = {
            "ra_deg": ra_c,
            "dec_deg": dec_c,
            "fov_arcmin": self.args.fov_arcmin,
            "shape": list(shape),
            "pixel_arcsec": align.pixel_scale_arcsec(gw),
            "aladin_wcs": render.wcs_to_aladin(gw, shape),
            "mask_bits": self.mask_bits,
            "saturation_bits": self.sat_bits,
        }

    def _target_png_pixel(self, mjd: float) -> tuple[float, float]:
        ra, dec = propagate.apparent_position(self.ast, mjd)
        gw, shape = self.grid
        return render.world_to_png_pixel(gw, shape, float(ra), float(dec))

    def _target_grid_pixel(self, mjd: float) -> tuple[float, float]:
        ra, dec = propagate.apparent_position(self.ast, mjd)
        x, y = self.grid[0].world_to_pixel_values(float(ra), float(dec))
        return float(x), float(y)

    def render_products(self) -> None:
        _gw, _shape = self.grid
        (self.out / "frames").mkdir(parents=True, exist_ok=True)
        frames_meta: dict[str, list[dict[str, Any]]] = {}
        diffs: dict[str, Any] = {}
        for d in range(1, 7):
            keys = sorted(k for k in self.frames if k[1] == d)
            if not keys:
                continue
            fr_list = [self.frames[k] for k in keys]
            vmin, vmax = render.shared_limits(fr_list, percentiles=(0.5, 99.7))
            gif_frames, labels, meta = [], [], []
            for k, fr in zip(keys, fr_list, strict=True):
                e = self.epochs[k[0]]
                png = render.to_png(fr, vmin, vmax, stretch="asinh")
                (self.out / "frames" / f"D{d}_E{k[0]}.png").write_bytes(png)
                sat = self.sat_masks.get(k)
                # Overlay only the holes saturation leaves in the co-add (single-exposure OVERFLOW hits from
                # cosmic rays are filled by the other exposures and are not shown).
                holes = sat & (fr.weight <= 0) if sat is not None else None
                overlay = render.mask_to_png(holes) if holes is not None and holes.any() else None
                gif_frames.append(compose_png(png, overlay))
                labels.append(f"{date(fr.mjd_mid)} D{d} E{k[0]} n={fr.n_inputs}")
                tx, ty = self._target_grid_pixel(fr.mjd_mid)
                ix, iy = round(tx), round(ty)
                core = (slice(max(iy - 1, 0), iy + 2), slice(max(ix - 1, 0), ix + 2))
                meta.append(
                    {
                        "epoch": k[0],
                        "file": f"frames/D{d}_E{k[0]}.png",
                        "date": date(fr.mjd_mid),
                        "mjd_mid": fr.mjd_mid,
                        "n_inputs": fr.n_inputs,
                        "full_epoch": e.full,
                        "wavelength_um": fr.wavelength_um,
                        "wavelength_min_um": fr.meta.get("wavelength_min_um"),
                        "wavelength_max_um": fr.meta.get("wavelength_max_um"),
                        "coverage_fraction": fr.meta.get("coverage_fraction"),
                        "saturated_grid_px": int(sat.sum()) if sat is not None else 0,
                        "saturation_holes_px": int(holes.sum()) if holes is not None else 0,
                        "target_core_saturated": bool(sat[core].any()) if sat is not None else False,
                        "target_core_masked": bool((fr.weight[core] <= 0).any()),
                    }
                )
            gif = render.gif_bytes(gif_frames, GIF_MS, 0, labels, upscale=UPSCALE)
            (self.out / f"blink_D{d}.gif").write_bytes(gif)
            frames_meta[f"D{d}"] = meta
            diffs[f"D{d}"] = self._difference(d, keys)
            diffs[f"D{d}"]["display_limits"] = [vmin, vmax]
        self.summary["frames"] = frames_meta
        self.summary["differences"] = diffs

    def _difference(self, d: int, keys: list[tuple[int, int]]) -> dict[str, Any]:
        full = [k for k in keys if self.epochs[k[0]].full]
        use = full if len(full) >= 2 else keys
        if len(use) < 2:
            return {"status": "fewer than two epochs"}
        a, b = self.frames[use[-1]], self.frames[use[0]]
        dfr = diff_mod.difference(a, b, normalize=True)
        _lo, hi = render.shared_limits([dfr], percentiles=(0.5, 99.5), symmetric=True)
        lim = max(5.0, hi)
        png = render.to_png(dfr, -lim, lim, stretch="linear")
        marks = []
        for fr, colour in ((b, (90, 200, 255)), (a, (255, 220, 60))):
            col, row = self._target_png_pixel(fr.mjd_mid)
            marks.append((col, row, colour))
        label = f"D{d} S/N E{use[-1][0]}-E{use[0][0]} {date(a.mjd_mid)[:7]} - {date(b.mjd_mid)[:7]}"
        (self.out / f"diff_D{d}.png").write_bytes(
            compose_png(png, scale=UPSCALE, label=label, marks=marks, background=(128, 128, 128))
        )
        out: dict[str, Any] = {
            "file": f"diff_D{d}.png",
            "a_epoch": use[-1][0],
            "b_epoch": use[0][0],
            "dt_days": a.mjd_mid - b.mjd_mid,
            "limit_snr": lim,
            "snr_robust_std": dfr.meta.get("snr_robust_std"),
            "background_offset": dfr.meta.get("background_offset"),
            "marks": "blue circle = predicted position at the earlier epoch, yellow = later",
        }
        for tag, fr, sign in (("new_position", a, 1), ("old_position", b, -1)):
            x, y = self._target_grid_pixel(fr.mjd_mid)
            ix, iy = round(x), round(y)
            box = dfr.data[max(iy - 1, 0) : iy + 2, max(ix - 1, 0) : ix + 2]
            box = box[np.isfinite(box)]
            out[f"snr_at_{tag}"] = float(sign * np.max(sign * box)) if box.size else None
        return out

    # ---------------------------------------------------------------- motion
    def motion_from_exposures(self) -> None:
        res: dict[str, Any] = {
            "method": "per-exposure ePSF position fits (forced.measure_position, ramp policy)",
            "snr_min": SNR_MIN_POSITION,
            "astrometric_floor_mas": ASTROMETRIC_FLOOR_MAS,
        }
        groups = {"primary": tuple(self.cfg["motion_dets"])}
        if self.cfg.get("diag_dets"):
            groups["diagnostic"] = tuple(self.cfg["diag_dets"])
        for tag, dets in groups.items():
            res[tag] = self._pm_fit([i for i in self.items if i.ok and i.det in dets], "pos", tag) | {
                "detectors": list(dets)
            }
        if self.key == "barnards-star":
            res["wings_policy"] = self._pm_fit(
                [i for i in self.items if i.ok and i.det in (5, 6)], "pos_wings", "wings"
            ) | {
                "detectors": [5, 6],
                "note": "saturated_core='wings' (core pixels excluded): comparison only",
            }
        if self.cfg.get("motion_diagnostic_only"):
            res["note"] = "diagnostic only: no motion criterion for this target"
        self.summary["motion"] = res

    def _pm_fit(self, items: list[Item], attr: str, tag: str) -> dict[str, Any]:
        rows = []
        for i in items:
            r = getattr(i, attr)
            if r is None or not forced.usable_for_motion(r) or not (r.snr >= SNR_MIN_POSITION):
                continue
            rows.append((i, r))
        if len(rows) < 5:
            return {"status": f"too few usable positions ({len(rows)})"}
        mjd = np.array([i.mjd for i, _ in rows])
        ra = np.array([r.ra_deg for _, r in rows])
        dec = np.array([r.dec_deg for _, r in rows])
        era = np.hypot([r.ra_err_mas for _, r in rows], ASTROMETRIC_FLOOR_MAS)
        edec = np.hypot([r.dec_err_mas for _, r in rows], ASTROMETRIC_FLOOR_MAS)
        plx = propagate.parallax_offsets_mas(self.ast, mjd)
        fit = motion.fit_proper_motion(mjd, ra, dec, era, edec, parallax_offsets_mas=plx)
        pm_cat = local_catalog_pm(self.ast, fit.ref_mjd)
        cmp = motion.compare_to_catalog(fit, *pm_cat)
        used = fit.used
        rx, ry = fit.residuals_mas[used, 0], fit.residuals_mas[used, 1]
        # Measured vs predicted apparent position (zero point) at the fit epoch.
        ra_p, dec_p = propagate.apparent_position(self.ast, mjd)
        dxi, deta = motion.tangent_offsets_mas(ra, dec, float(np.mean(ra_p)), float(np.mean(dec_p)))
        pxi, peta = motion.tangent_offsets_mas(ra_p, dec_p, float(np.mean(ra_p)), float(np.mean(dec_p)))
        epochs_pos = motion.mean_positions_by_epoch(mjd, ra, dec, era, edec, [i.epoch for i, _ in rows])
        disp = self._epoch_displacement(epochs_pos)
        # Offsets from the catalog-predicted apparent position per epoch and detector (systematics check).
        off: dict[tuple[int, int], list[tuple[float, float]]] = defaultdict(list)
        for (i, _), a, b in zip(rows, dxi - pxi, deta - peta, strict=True):
            off[(i.epoch, i.det)].append((float(a), float(b)))
        offsets = [
            {
                "epoch": e,
                "detector": d,
                "n": len(v),
                "east_median_mas": float(np.median([a for a, _ in v])),
                "north_median_mas": float(np.median([b for _, b in v])),
                "east_std_mas": float(np.std([a for a, _ in v])),
                "north_std_mas": float(np.std([b for _, b in v])),
            }
            for (e, d), v in sorted(off.items())
        ]
        # Robustness diagnostic: parallax-corrected positions averaged per epoch (errors from the scatter within
        # the epoch), then a straight-line fit through the epoch means.
        epoch_fit = None
        rc, dc = motion.mean_direction(ra, dec)
        xi_all, eta_all = motion.tangent_offsets_mas(ra, dec, rc, dc)
        rb, db = motion.tangent_to_radec(xi_all - plx[0], eta_all - plx[1], rc, dc)
        means = motion.mean_positions_by_epoch(mjd, rb, db, era, edec, [i.epoch for i, _ in rows])
        means = [p for p in means if p.n >= 3]
        if len(means) >= 3:
            fe = motion.fit_proper_motion(
                [p.mjd for p in means],
                [p.ra_deg for p in means],
                [p.dec_deg for p in means],
                [p.ra_err_mas for p in means],
                [p.dec_err_mas for p in means],
                sigma_clip=None,
            )
            pm_e = local_catalog_pm(self.ast, fe.ref_mjd)
            epoch_fit = {
                "n_epochs": len(means),
                "fit": fe.to_dict(),
                "comparison": motion.compare_to_catalog(fe, *pm_e),
                "note": "diagnostic: epoch means of parallax-corrected positions (epochs with >= 3 points)",
            }
        out = {
            "n_positions": len(rows),
            "n_used": int(fit.n_used),
            "fit": fit.to_dict(),
            "catalog_local_pm_masyr": list(pm_cat),
            "comparison": cmp,
            "residual_rms_mas": {
                "ra": float(np.sqrt(np.mean(rx**2))),
                "dec": float(np.sqrt(np.mean(ry**2))),
                "radial": float(np.sqrt(np.mean(rx**2 + ry**2))),
            },
            "zero_point_mas": {"ra": float(np.median(dxi - pxi)), "dec": float(np.median(deta - peta))},
            "per_detector_count": dict(Counter(f"D{i.det}" for i, _ in rows)),
            "methods": dict(Counter(r.point.method for _, r in rows)),
            "epoch_positions": [vars(p) for p in epochs_pos],
            "displacement": disp,
            "offsets_from_prediction": offsets,
            "epoch_means_fit": epoch_fit,
        }
        self._plot_rows = getattr(self, "_plot_rows", {})
        self._plot_rows[tag] = (rows, fit, plx)
        return out

    def _epoch_displacement(self, positions: list[motion.SkyPosition]) -> dict[str, Any] | None:
        """First -> last full-epoch shift, measured and predicted (apparent positions, parallax included)."""
        full = [p for p in positions if self.epochs[int(p.label.split()[-1])].full] if positions else []
        use = full if len(full) >= 2 else positions
        if len(use) < 2:
            return None
        first, last = use[0], use[-1]
        meas = motion.displacement_between(first, last)
        pr = []
        for p in (first, last):
            ra, dec = propagate.apparent_position(self.ast, p.mjd)
            pr.append(motion.SkyPosition(p.mjd, float(ra), float(dec)))
        pred = motion.displacement_between(pr[0], pr[1])
        return {
            "from_epoch": first.label,
            "to_epoch": last.label,
            "measured": meas,
            "predicted": pred,
            "ratio": meas["sep_arcsec"] / pred["sep_arcsec"] if pred["sep_arcsec"] > 0 else None,
            "pa_diff_deg": float(motion.wrap_angle_deg(meas["pa_deg"] - pred["pa_deg"])),
        }

    # wise-0855: per-epoch D5+D6 co-add stacks ------------------------------------------------------------
    def motion_from_coadds(self) -> None:
        gw, shape = self.grid
        dets = tuple(self.cfg["motion_dets"])
        g = self.summary["grid"]
        try:
            nb_rows = catwise_neighbours(g["ra_deg"], g["dec_deg"], 45.0)
        except Exception as exc:  # noqa: BLE001
            nb_rows = []
            self.issues.append(f"CatWISE neighbour query failed: {exc!r}"[:200])
        neighbours = [
            r
            for r in nb_rows
            if isinstance(r.get("pmra"), float)
            and isinstance(r.get("pmdec"), float)
            and math.hypot(r["pmra"], r["pmdec"]) < CATWISE_STATIC_PM
            and isinstance(r.get("w2mpro"), float)
            and r["w2mpro"] < CATWISE_W2_MAX
        ]
        epochs_out = []
        positions_single: list[motion.SkyPosition] = []
        positions_model: list[motion.SkyPosition] = []
        rng = np.random.default_rng(20261114)
        self._coadd_stacks = {}
        for e in self.epochs:
            stamps = [i.stamp for i in self.items if i.ok and i.epoch == e.index and i.det in dets]
            if len(stamps) < 2:
                continue
            layers, mjds, totals = [], [], []
            for s in stamps:
                data, weight, _ = align.reproject_stamp(s, gw, shape, self.mask_bits, True, self.sat_bits)
                tot = float(np.sum(weight, dtype=np.float64))
                if tot > 0:
                    layers.append((data, weight))
                    mjds.append(s.mjd_avg)
                    totals.append(tot)
            if len(layers) < 2:
                continue
            data, weight, _ = coadd_mod.coadd(layers, "ivw")
            mjd_mid = float(np.sum(np.array(totals) * np.array(mjds)) / np.sum(totals))
            tx, ty = self._target_grid_pixel(mjd_mid)
            nb_xy = []
            for r in neighbours:
                x, y = gw.world_to_pixel_values(r["ra"], r["dec"])
                if 1.0 < math.hypot(float(x) - tx, float(y) - ty) * config.PIXEL_SCALE_ARCSEC < 15.0:
                    nb_xy.append((float(x), float(y), r))
            single = fit_gaussians(data, weight, tx, ty, [])
            model = fit_gaussians(data, weight, tx, ty, [(x, y) for x, y, _ in nb_xy]) if nb_xy else single
            boots = {"single": [], "model": []}
            n = len(layers)
            for _ in range(BOOTSTRAP):
                pick = rng.integers(0, n, n)
                bd, bw, _ = coadd_mod.coadd([layers[k] for k in pick], "ivw")
                for tag, nb in (("single", []), ("model", [(x, y) for x, y, _ in nb_xy])):
                    if tag == "model" and not nb:
                        continue
                    f = fit_gaussians(bd, bw, tx, ty, nb)
                    if f is not None:
                        boots[tag].append((f["x"], f["y"], f["flux"]))
            if not boots["model"]:
                boots["model"] = boots["single"]
            snr_ap = aperture_snr(data, weight, tx, ty, [(x, y) for x, y, _ in nb_xy])
            row: dict[str, Any] = {
                "epoch": e.index,
                "full": e.full,
                "n_stamps": len(layers),
                "mjd_mid": mjd_mid,
                "date": date(mjd_mid),
                "coadd_aperture": snr_ap,
                "neighbours_within_15arcsec": [
                    {
                        "name": r.get("source_name"),
                        "w1": r.get("w1mpro"),
                        "w2": r.get("w2mpro"),
                        "sep_arcsec": math.hypot(x - tx, y - ty) * config.PIXEL_SCALE_ARCSEC,
                        "ra": r["ra"],
                        "dec": r["dec"],
                    }
                    for x, y, r in nb_xy
                ],
            }
            for tag, f, pos_list in (("single", single, positions_single), ("model", model, positions_model)):
                if f is None or len(boots[tag]) < 20:
                    row[tag] = {"status": "fit failed"}
                    continue
                b = np.array(boots[tag])
                ra_f, dec_f = gw.pixel_to_world_values(f["x"], f["y"])
                # bootstrap scatter in pixels -> mas (grid is north-up: x error is RA*, y error is Dec)
                sx, sy = float(np.std(b[:, 0], ddof=1)), float(np.std(b[:, 1], ddof=1))
                scale = align.pixel_scale_arcsec(gw) * 1000.0
                pra, pdec = propagate.apparent_position(self.ast, mjd_mid)
                dxi, deta = motion.tangent_offsets_mas(float(ra_f), float(dec_f), float(pra), float(pdec))
                row[tag] = {
                    "x": f["x"],
                    "y": f["y"],
                    "ra_deg": float(ra_f),
                    "dec_deg": float(dec_f),
                    "ra_err_mas": sx * scale,
                    "dec_err_mas": sy * scale,
                    "flux_ujy_equiv": f["flux"],
                    "flux_snr_bootstrap": f["flux"] / float(np.std(b[:, 2], ddof=1)),
                    "sigma_px": f["sigma"],
                    "neighbour_fluxes": f.get("nb_flux"),
                    "offset_from_prediction_mas": [float(dxi), float(deta)],
                }
                pos_list.append(
                    motion.SkyPosition(
                        mjd_mid,
                        float(ra_f),
                        float(dec_f),
                        sx * scale,
                        sy * scale,
                        len(layers),
                        f"epoch {e.index}",
                    )
                )
            self._coadd_stacks[e.index] = (data, weight, tx, ty, nb_xy, mjd_mid)
            epochs_out.append(row)
        res: dict[str, Any] = {
            "method": "per-epoch D5+D6 IVW co-adds on the shared grid; Gaussian PSF fits, "
            "single source and with static CatWISE neighbours modelled; "
            f"bootstrap ({BOOTSTRAP}) over exposures for errors",
            "detectors": list(dets),
            "epochs": epochs_out,
            "catwise_static_neighbours": [
                {k: r.get(k) for k in ("source_name", "ra", "dec", "w1mpro", "w2mpro", "pmra", "pmdec")}
                for r in neighbours
            ],
        }
        for tag, plist in (("single", positions_single), ("model", positions_model)):
            res[f"shift_{tag}"] = self._coadd_shift(plist)
            res[f"pm_fit_{tag}"] = self._coadd_pm(plist)
        self._coadd_positions = {"single": positions_single, "model": positions_model}
        self.summary["motion"] = res
        # D1-D4 and D5+D6 detection statistics per main epoch (co-add aperture + IVW forced photometry)
        self.summary["detection"] = self.detection_table()

    def _coadd_shift(self, plist: list[motion.SkyPosition]) -> dict[str, Any] | None:
        if len(plist) < 2:
            return None
        first, last = plist[0], plist[-1]
        meas = motion.displacement_between(first, last)
        pr = []
        for p in (first, last):
            ra, dec = propagate.apparent_position(self.ast, p.mjd)
            pr.append(motion.SkyPosition(p.mjd, float(ra), float(dec)))
        pred = motion.displacement_between(pr[0], pr[1])
        return {
            "from": first.label,
            "to": last.label,
            "measured": meas,
            "predicted": pred,
            "ratio": meas["sep_arcsec"] / pred["sep_arcsec"],
            "pa_diff_deg": float(motion.wrap_angle_deg(meas["pa_deg"] - pred["pa_deg"])),
        }

    def _coadd_pm(self, plist: list[motion.SkyPosition]) -> dict[str, Any] | None:
        if len(plist) < 3:
            return None
        mjd = np.array([p.mjd for p in plist])
        plx = propagate.parallax_offsets_mas(self.ast, mjd)
        fit = motion.fit_proper_motion(
            mjd,
            [p.ra_deg for p in plist],
            [p.dec_deg for p in plist],
            [p.ra_err_mas for p in plist],
            [p.dec_err_mas for p in plist],
            parallax_offsets_mas=plx,
            sigma_clip=None,
        )
        pm_cat = local_catalog_pm(self.ast, fit.ref_mjd)
        return {
            "fit": fit.to_dict(),
            "catalog_local_pm_masyr": list(pm_cat),
            "comparison": motion.compare_to_catalog(fit, *pm_cat),
        }

    def detection_table(self) -> list[dict[str, Any]]:
        gw, shape = self.grid
        rows = []
        for e in self.epochs:
            for tag, dets in (
                ("D5+D6", (5, 6)),
                ("D1", (1,)),
                ("D2", (2,)),
                ("D3", (3,)),
                ("D4", (4,)),
                ("D1-D4", (1, 2, 3, 4)),
            ):
                its = [i for i in self.items if i.ok and i.epoch == e.index and i.det in dets]
                if not its:
                    continue
                layers = []
                for i in its:
                    data, weight, _ = align.reproject_stamp(
                        i.stamp, gw, shape, self.mask_bits, True, self.sat_bits
                    )
                    if float(np.sum(weight)) > 0:
                        layers.append((data, weight, i.mjd))
                pts = [i.phot.point for i in its if i.phot is not None]
                f = np.array([p.flux_ujy for p in pts])
                s = np.array([p.flux_err_ujy for p in pts])
                ok = np.isfinite(f) & np.isfinite(s) & (s > 0)
                ivw_snr = (
                    float(np.sum(f[ok] / s[ok] ** 2) / math.sqrt(np.sum(1 / s[ok] ** 2)))
                    if ok.any()
                    else None
                )
                row = {
                    "epoch": e.index,
                    "full": e.full,
                    "group": tag,
                    "n_exposures": len(its),
                    "forced_ivw_snr": ivw_snr,
                }
                if layers:
                    data, weight, _ = coadd_mod.coadd([(a, b) for a, b, _ in layers], "ivw")
                    mjd_mid = float(np.mean([m for _, _, m in layers]))
                    tx, ty = self._target_grid_pixel(mjd_mid)
                    stack = self._coadd_stacks.get(e.index)
                    nb = [(x, y) for x, y, _ in stack[4]] if stack is not None else []
                    row["coadd_aperture"] = aperture_snr(data, weight, tx, ty, nb)
                    # PSF photometry with the catalogued neighbours modelled (fixed positions, free fluxes)
                    fwhm = [float(i.stamp.header.get("PSF_FWHM", math.nan)) for i in its]
                    sigma = psf_sigma_on_grid(float(np.nanmean(fwhm)), align.pixel_scale_arcsec(gw))
                    row["coadd_psf_neighbours_modelled"] = forced_psf_snr(
                        [(a, b) for a, b, _ in layers],
                        tx,
                        ty,
                        nb,
                        sigma,
                        np.random.default_rng(1000 + e.index),
                    )
                rows.append(row)
        return rows

    def render_d56_stacks(self) -> None:
        """wise-0855: blink GIF and S/N difference of the per-epoch D5+D6 co-adds (the faint-target view)."""
        gw, _shape = self.grid
        keys = sorted(self._coadd_stacks)
        if len(keys) < 2:
            return
        frames = {}
        for k in keys:
            data, weight, *_ = self._coadd_stacks[k]
            mjd = self._coadd_stacks[k][5]
            frames[k] = Frame(
                data=data,
                weight=weight,
                wcs=gw,
                mjd_mid=mjd,
                n_inputs=1,
                label=f"D5+D6 E{k}",
                epoch_index=k,
                meta={"kind": "coadd"},
            )
        vmin, vmax = render.shared_limits(list(frames.values()), percentiles=(0.5, 99.5))
        pngs, labels = [], []
        for k in keys:
            png = render.to_png(frames[k], vmin, vmax, stretch="asinh")
            (self.out / "frames" / f"D56_E{k}.png").write_bytes(png)
            col, row = self._target_png_pixel(frames[k].mjd_mid)
            pngs.append(compose_png(png, marks=[(col, row, (255, 220, 60))]))
            labels.append(f"{date(frames[k].mjd_mid)} D5+D6 E{k}")
        (self.out / "blink_D56.gif").write_bytes(render.gif_bytes(pngs, GIF_MS, 0, labels, upscale=UPSCALE))
        a, b = frames[keys[-1]], frames[keys[0]]
        dfr = diff_mod.difference(a, b, normalize=True)
        png = render.to_png(dfr, -5.0, 5.0, stretch="linear")
        marks = [
            (*self._target_png_pixel(fr.mjd_mid), c) for fr, c in ((b, (90, 200, 255)), (a, (255, 220, 60)))
        ]
        label = f"D5+D6 S/N E{keys[-1]}-E{keys[0]} {date(a.mjd_mid)[:7]} - {date(b.mjd_mid)[:7]}"
        (self.out / "diff_D56.png").write_bytes(
            compose_png(png, scale=UPSCALE, label=label, marks=marks, background=(128, 128, 128))
        )
        self.summary["differences"]["D56"] = {
            "file": "diff_D56.png",
            "gif": "blink_D56.gif",
            "a_epoch": keys[-1],
            "b_epoch": keys[0],
            "dt_days": a.mjd_mid - b.mjd_mid,
            "limit_snr": 5.0,
            "snr_robust_std": dfr.meta.get("snr_robust_std"),
            "marks": "blue = predicted position at the earlier epoch, yellow = later",
        }

    # ---------------------------------------------------------------- spectra and light curves
    def spectra(self) -> None:
        pts = self.points()
        spec = spectrum.assemble_spectrum(pts)
        ok = [i for i in self.items if i.ok]
        dr1 = [i for i in ok if ep.survey_year(i.mjd) == 1] or ok
        ra_c, dec_c = motion.mean_direction([i.ra for i in dr1], [i.dec for i in dr1])
        try:
            cs = cube.cube_spectrum(ra_c, dec_c)
        except Exception as exc:  # noqa: BLE001
            cs = None
            self.issues.append(f"cube quick-look failed: {exc!r}"[:200])
        self.cube = cs
        cube_out = None
        if cs is not None:
            cube_out = {
                k: jsonable(cs[k])
                for k in ("label", "tile_url", "n_finite", "n_lower_limit", "seconds", "requests", "bytes")
                if k in cs
            }
            cube_out |= {
                "ra_deg": ra_c,
                "dec_deg": dec_c,
                "wavelength_um": jsonable(cs["wavelength_um"]),
                "flux_ujy": jsonable(cs["flux_ujy"]),
                "flux_err_ujy": jsonable(cs["flux_err_ujy"]),
                "flux_partial_ujy": jsonable(cs["flux_partial_ujy"]),
                "lower_limit": jsonable(cs["lower_limit"]),
                "quality": jsonable(cs["quality"]),
            }
            # Level-2 vs cube: median ratio over channels where both are finite (unsaturated L2 points)
            l2w = np.array([p.wavelength_um for p in pts if not p.saturated])
            l2f = np.array([p.flux_ujy for p in pts if not p.saturated])
            cw, cf = np.asarray(cs["wavelength_um"]), np.asarray(cs["flux_ujy"])
            good = np.isfinite(cf)
            if good.sum() >= 3 and l2w.size >= 3:
                order = np.argsort(l2w)
                interp = np.interp(cw[good], l2w[order], l2f[order], left=np.nan, right=np.nan)
                ratio = interp / cf[good]
                ratio = ratio[np.isfinite(ratio) & (ratio > 0)]
                cube_out["median_l2_over_cube"] = float(np.median(ratio)) if ratio.size else None
        self.summary["spectrum"] = {
            "n_points": len(pts),
            "epochs": jsonable(spec.get("epochs")),
            "cube": cube_out,
        }
        self.summary["epoch_photometry"] = lightcurve.epoch_photometry(
            pts, by="detector", saturated="fallback"
        )
        var = matched_variability(pts, self.epochs)
        if self.key == "barnards-star":
            var["note"] = (
                "control: Barnard's Star is not variable at the 0.1 mag level in the infrared, so these "
                "changes measure the systematics of saturated-star photometry"
            )
        self.summary["variability"] = var

    def field_star_check(self) -> None:
        """Relative astrometry of field stars between full-epoch co-adds (is any epoch's WCS shifted?)."""
        from photutils.centroids import centroid_2dg
        from photutils.detection import find_peaks

        gw, _ = self.grid
        scale = align.pixel_scale_arcsec(gw)

        def stars(fr: Frame, avoid: list[tuple[float, float]]) -> list[tuple[float, float]]:
            d = np.where(fr.weight > 0, fr.data, np.nan)
            med = np.nanmedian(d)
            std = 1.4826 * np.nanmedian(np.abs(d - med))
            pk = find_peaks(np.nan_to_num(d - med, nan=0.0), threshold=15 * std, box_size=5, border_width=4)
            out = []
            for x, y in zip(pk["x_peak"], pk["y_peak"], strict=True) if pk is not None else ():
                if any(math.hypot(x - ax, y - ay) < 6 for ax, ay in avoid):
                    continue
                cut = d[y - 3 : y + 4, x - 3 : x + 4]
                if cut.shape != (7, 7) or not np.isfinite(cut).all():
                    continue
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore")
                    cx, cy = centroid_2dg(cut - np.nanmin(cut))
                out.append((x - 3 + float(cx), y - 3 + float(cy)))
            return out

        rows = []
        for d in range(1, 7):
            keys = sorted(k for k in self.frames if k[1] == d and self.epochs[k[0]].full)
            if len(keys) < 2:
                continue
            track = [self._target_grid_pixel(self.frames[k].mjd_mid) for k in keys]
            ref = stars(self.frames[keys[-1]], track)
            for k in keys[:-1]:
                cur = stars(self.frames[k], track)
                dx, dy = [], []
                for x, y in ref:
                    best = min(cur, key=lambda c: math.hypot(c[0] - x, c[1] - y), default=None)
                    if best and math.hypot(best[0] - x, best[1] - y) < 1.0:
                        dx.append(best[0] - x)
                        dy.append(best[1] - y)
                if len(dx) >= 3:
                    rows.append(
                        {
                            "detector": d,
                            "epoch": k[0],
                            "reference_epoch": keys[-1][0],
                            "n_stars": len(dx),
                            "east_arcsec": -float(np.median(dx)) * scale,
                            "north_arcsec": float(np.median(dy)) * scale,
                            "east_scatter": float(np.std(dx)) * scale,
                            "north_scatter": float(np.std(dy)) * scale,
                        }
                    )
        self.summary["field_star_shifts"] = {
            "method": "15-sigma peaks in full-epoch co-adds (target track excluded), 2-D Gaussian centroids, matched "
            "within 1 px; median shift of each epoch relative to the last full epoch (grid is north-up)",
            "rows": rows,
        }

    # ---------------------------------------------------------------- plots
    def plot_spectrum(self) -> None:
        pts = self.points()
        fig, ax = plt.subplots(figsize=(9, 5.2), dpi=100)
        eps = sorted({p.epoch_index for p in pts if p.epoch_index is not None})
        many = len(eps) > len(PALETTE)
        cmap = plt.get_cmap("Blues")
        for k, e in enumerate(eps):
            sel = [p for p in pts if p.epoch_index == e and p.flux_ujy > 0]
            if not sel:
                continue
            colour = cmap(0.35 + 0.65 * k / max(1, len(eps) - 1)) if many else PALETTE[k]
            marker = "o" if many else MARKERS[k % len(MARKERS)]
            for sat in (False, True):
                ss = [p for p in sel if p.saturated == sat]
                if not ss:
                    continue
                w = np.array([p.wavelength_um for p in ss])
                f = np.array([p.flux_ujy for p in ss]) / 1000.0
                er = np.array([p.flux_err_ujy for p in ss]) / 1000.0
                ax.errorbar(
                    w,
                    f,
                    yerr=er,
                    fmt=marker,
                    ms=4.5,
                    lw=0.8,
                    color=colour,
                    mfc="none" if sat else colour,
                    mew=1.0,
                    alpha=0.9,
                    label=(
                        f"E{e} {date(self.epochs[e].t_mid_mjd)}"
                        if not sat or not any(not p.saturated for p in sel)
                        else None
                    ),
                )
        if self.cube is not None:
            cw = np.asarray(self.cube["wavelength_um"])
            cf = np.asarray(self.cube["flux_ujy"]) / 1000.0
            ll = np.asarray(self.cube["lower_limit"], dtype=bool)
            cp = np.asarray(self.cube["flux_partial_ujy"]) / 1000.0
            ok = np.isfinite(cf) & (cf > 0)
            if ok.any():
                ax.plot(cw[ok], cf[ok], "-", color=INK, lw=1.2, label="DR1 cube quick-look")
            lim = ll & np.isfinite(cp) & (cp > 0)
            if lim.any():
                ax.plot(cw[lim], cp[lim], "^", color=INK2, ms=4, label="cube lower limit (saturated core)")
        ax.set_yscale("log")
        ax.set_xlabel("wavelength (µm)", color=INK)
        ax.set_ylabel("flux density (mJy)", color=INK)
        ax.set_title(
            f"{self.name}: SPHEREx forced photometry per exposure (open = saturated core)",
            color=INK,
            fontsize=11,
        )
        ax.grid(True, color=GRID, lw=0.6)
        ax.legend(fontsize=8, ncol=2, frameon=False)
        fig.tight_layout()
        fig.savefig(self.out / "spectrum.png")
        plt.close(fig)

    def plot_lightcurve(self) -> None:
        rows = self.summary.get("epoch_photometry") or []
        extra = self.key == "r-dra" and bool(getattr(self, "_rdra_series", None))
        fig, axes = plt.subplots(
            2 if extra else 1, 1, figsize=(9, 7.5 if extra else 4.8), dpi=100, squeeze=False
        )
        ax = axes[0, 0]
        for d in range(1, 7):
            rr = [r for r in rows if r["detector"] == d and r.get("ab_mag") is not None]
            if not rr:
                continue
            t = [datetime.fromisoformat(ep.mjd_to_iso(r["mjd_mean"])) for r in rr]
            m = [r["ab_mag"] for r in rr]
            e = [r["ab_mag_err"] or 0.0 for r in rr]
            ax.errorbar(
                t,
                m,
                yerr=e,
                fmt="-o",
                ms=5,
                lw=1.4,
                color=DET_COLOR[d],
                label=f"D{d}",
                mfc="white" if all(r.get("used_saturated") for r in rr) else DET_COLOR[d],
            )
        ax.invert_yaxis()
        ax.set_ylabel("epoch-mean AB mag (band average)", color=INK)
        ax.set_title(
            f"{self.name}: epoch photometry per detector (open = saturated points only)",
            color=INK,
            fontsize=11,
        )
        ax.grid(True, color=GRID, lw=0.6)
        ax.legend(fontsize=8, ncol=6, frameon=False)
        if extra:
            ax2 = axes[1, 0]

            def dt(values):
                return [datetime.fromisoformat(ep.mjd_to_iso(m)) for m in values]

            outer = self._rdra_series.get("8-12 px annulus, robustness variant")
            inner = self._rdra_series.get("3-6 px annulus")
            if outer is not None:
                t = np.array(dt(outer["mjd"]), dtype=object)
                for d in range(1, 7):
                    sel = outer["det"] == d
                    if sel.any():
                        ax2.plot(
                            t[sel],
                            outer["dm"][sel],
                            "o",
                            ms=3,
                            color=DET_COLOR[d],
                            alpha=0.75,
                            label=f"D{d} (8-12 px)",
                        )
                tm = np.linspace(min(outer["mjd"]), max(outer["mjd"]), 400)
                ax2.plot(
                    dt(tm), outer["model"](tm), "-", color=INK, lw=1.3, label="sinusoid fit, P = 246.12 d"
                )
            if inner is not None:
                ax2.plot(
                    dt(inner["mjd"]),
                    inner["dm"],
                    "o",
                    ms=5,
                    mfc="none",
                    mec=INK2,
                    mew=0.9,
                    label="3-6 px ring (a priori)",
                )
            ax2.invert_yaxis()
            ax2.set_ylabel("Δmag vs mean spectrum (annulus index)", color=INK)
            ax2.set_title(
                "R Dra: per-exposure wing/annulus photometry, normalised per detector channel",
                color=INK,
                fontsize=10,
            )
            ax2.grid(True, color=GRID, lw=0.6)
            ax2.legend(fontsize=7.5, ncol=4, frameon=False)
        fig.tight_layout()
        fig.savefig(self.out / "lightcurve.png")
        plt.close(fig)

    def plot_motion(self) -> None:
        fig, axes = plt.subplots(1, 2, figsize=(10, 4.6), dpi=100)
        if self.cfg["motion"] == "coadd":
            self._plot_motion_coadd(axes)
        else:
            self._plot_motion_exposures(axes)
        fig.tight_layout()
        fig.savefig(self.out / "motion.png")
        plt.close(fig)

    def _plot_motion_exposures(self, axes) -> None:
        sel = getattr(self, "_plot_rows", {}).get("primary")
        if sel is None:
            for a in axes:
                a.text(0.5, 0.5, "no usable positions", ha="center", transform=a.transAxes)
            return
        rows, fit, plx = sel
        mjd = np.array([i.mjd for i, _ in rows])
        ra = np.array([r.ra_deg for _, r in rows])
        dec = np.array([r.dec_deg for _, r in rows])
        xi, eta = motion.tangent_offsets_mas(ra, dec, fit.ra0_deg, fit.dec0_deg)
        xi, eta = (xi - plx[0]) / 1000.0, (eta - plx[1]) / 1000.0  # parallax removed, arcsec
        dt = (mjd - fit.ref_mjd) / 365.25
        tt = np.linspace(dt.min() - 0.05, dt.max() + 0.05, 50)
        pm_cat = local_catalog_pm(self.ast, fit.ref_mjd)
        for ax, v, pmf, pmc, lab in (
            (axes[0], xi, fit.pmra_masyr, pm_cat[0], "Δα* east (arcsec)"),
            (axes[1], eta, fit.pmdec_masyr, pm_cat[1], "Δδ north (arcsec)"),
        ):
            for d in sorted({i.det for i, _ in rows}):
                m = np.array([i.det == d for i, _ in rows])
                used = m & fit.used
                ax.plot(dt[used], v[used], "o", ms=4, color=DET_COLOR[d], label=f"D{d}")
                if (m & ~fit.used).any():
                    ax.plot(dt[m & ~fit.used], v[m & ~fit.used], "x", ms=5, color=DET_COLOR[d])
            ax.plot(tt, pmf * tt / 1000.0, "-", color=INK, lw=1.3, label=f"fit {pmf:+.0f} mas/yr")
            ax.plot(tt, pmc * tt / 1000.0, "--", color=INK2, lw=1.1, label=f"catalog {pmc:+.0f} mas/yr")
            ax.set_xlabel(f"years from MJD {fit.ref_mjd:.1f}", color=INK)
            ax.set_ylabel(lab, color=INK)
            ax.grid(True, color=GRID, lw=0.6)
            ax.legend(fontsize=7.5, frameon=False)
        axes[0].set_title(f"{self.name}: positions (parallax removed), x = clipped", color=INK, fontsize=10)

    def _plot_motion_coadd(self, axes) -> None:
        pos = getattr(self, "_coadd_positions", {})
        plist = pos.get("model") or pos.get("single") or []
        if not plist:
            for a in axes:
                a.text(0.5, 0.5, "no co-add positions", ha="center", transform=a.transAxes)
            return
        ref = plist[0]
        tdense = np.linspace(min(p.mjd for p in plist) - 15, max(p.mjd for p in plist) + 15, 300)
        rpa, dpa = propagate.apparent_position(self.ast, tdense)
        r0, d0 = propagate.apparent_position(self.ast, ref.mjd)
        pxi, peta = motion.tangent_offsets_mas(rpa, dpa, float(r0), float(d0))
        for tag, plist_t, colour, mk in (
            ("single", pos.get("single", []), PALETTE[1], "s"),
            ("neighbour modelled", pos.get("model", []), PALETTE[0], "o"),
        ):
            if not plist_t:
                continue
            t = np.array([p.mjd for p in plist_t])
            xi, eta = motion.tangent_offsets_mas(
                [p.ra_deg for p in plist_t], [p.dec_deg for p in plist_t], float(r0), float(d0)
            )
            for ax, v, err in (
                (axes[0], xi, [p.ra_err_mas for p in plist_t]),
                (axes[1], eta, [p.dec_err_mas for p in plist_t]),
            ):
                ax.errorbar(
                    t - ref.mjd,
                    v / 1000.0,
                    yerr=np.array(err) / 1000.0,
                    fmt=mk,
                    ms=6,
                    color=colour,
                    label=f"D5+D6 co-add, {tag}",
                    capsize=2,
                )
        for ax, v, lab in ((axes[0], pxi, "Δα* east (arcsec)"), (axes[1], peta, "Δδ north (arcsec)")):
            ax.plot(
                tdense - ref.mjd, v / 1000.0, "-", color=INK2, lw=1.1, label="catalog prediction (apparent)"
            )
            ax.set_xlabel(f"days from MJD {ref.mjd:.1f}", color=INK)
            ax.set_ylabel(lab, color=INK)
            ax.grid(True, color=GRID, lw=0.6)
            ax.legend(fontsize=7.5, frameon=False)
        axes[0].set_title(f"{self.name}: per-epoch D5+D6 co-add positions vs catalog", color=INK, fontsize=10)

    # ---------------------------------------------------------------- target-specific analysis
    def analyse(self) -> list[dict[str, Any]]:
        fn = {
            "barnards-star": self._crit_barnard,
            "eps-indi-b": self._crit_epsind,
            "wise-0855": self._crit_wise,
            "rw-aur": self._crit_rwaur,
            "r-dra": self._crit_rdra,
        }.get(self.key)
        return fn() if fn else []

    def _pm_criteria(self, block: dict[str, Any], tol_ratio: float, tol_pa: float, label: str) -> list[dict]:
        if "comparison" not in block:
            return [crit(f"{label} proper motion", False, block.get("status"), f"within {tol_ratio:.0%}")]
        c, f = block["comparison"], block["fit"]
        ratio, pa = c["ratio"], c["pa_diff_deg"]
        v = {
            "pm_total_masyr": f["total_masyr"],
            "pm_err_masyr": f["total_err_masyr"],
            "catalog_masyr": c["total_cat_masyr"],
            "ratio": ratio,
            "pa_deg": f["pa_deg"],
            "pa_cat_deg": c["pa_cat_deg"],
            "pa_diff_deg": pa,
            "n_used": f["n_used"],
            "chi2_red": f["chi2_red"],
        }
        return [
            crit(
                f"{label} proper motion total within {tol_ratio:.0%} of catalog",
                abs(ratio - 1) <= tol_ratio,
                v,
                f"|ratio - 1| <= {tol_ratio}",
            ),
            crit(
                f"{label} proper-motion PA within {tol_pa:g} deg",
                abs(pa) <= tol_pa,
                pa,
                f"|dPA| <= {tol_pa} deg",
            ),
        ]

    def _saturation_criterion(self) -> dict[str, Any]:
        frames = [m for ms in self.summary.get("frames", {}).values() for m in ms]
        n_core_sat = sum(m["target_core_saturated"] for m in frames)
        n_flagged = sum(m["target_core_saturated"] or m["target_core_masked"] for m in frames)
        ph = self.summary["photometry"]
        v = {
            "exposures_saturated": ph["n_saturated"],
            "exposures_measured": ph["n_points"],
            "frames": len(frames),
            "frames_core_saturated_overlay": n_core_sat,
            "frames_core_masked_or_flagged": n_flagged,
        }
        return crit(
            "saturated core masked in co-adds and flagged",
            ph["n_saturated"] > 0 and n_flagged == len(frames),
            v,
            "every frame has its target core masked (weight 0) or in the saturation overlay; "
            "saturated exposures carry saturated=True",
        )

    def _crit_barnard(self) -> list[dict]:
        m = self.summary["motion"]
        out = self._pm_criteria(m["primary"], 0.05, 10.0, "D5/D6")
        disp = m["primary"].get("displacement")
        if disp:
            meas = disp["measured"]
            ok = (
                abs(disp["ratio"] - 1) <= 0.2
                and abs(disp["pa_diff_deg"]) <= 10.0
                and (meas["pa_deg"] >= 340 or meas["pa_deg"] <= 20)
            )
            out.append(
                crit(
                    "blink/difference: first-to-last full-epoch shift is ~10 arcsec/yr northward",
                    ok,
                    {
                        "rate_arcsec_yr": meas["rate_arcsec_yr"],
                        "sep_arcsec": meas["sep_arcsec"],
                        "pa_deg": meas["pa_deg"],
                        "dt_days": meas["dt_days"],
                        "ratio_to_prediction": disp["ratio"],
                        "pa_diff_deg": disp["pa_diff_deg"],
                        "diff_snr_at_old_new": {
                            k: [v.get("snr_at_old_position"), v.get("snr_at_new_position")]
                            for k, v in self.summary["differences"].items()
                        },
                    },
                    "shift within 20% and 10 deg of the predicted apparent shift, PA within 20 deg of north",
                )
            )
        out.append(self._saturation_criterion())
        return out

    def _crit_epsind(self) -> list[dict]:
        m = self.summary["motion"]["primary"]
        out = self._pm_criteria(m, 0.05, 3.0, "all detectors")
        if "residual_rms_mas" in m:
            rms = m["residual_rms_mas"]
            out.append(
                crit(
                    "per-exposure position scatter < 0.5 arcsec (radial RMS of residuals)",
                    rms["radial"] < 500.0,
                    rms,
                    "radial RMS < 500 mas (per-axis values also reported)",
                )
            )
        dips = tdwarf_dips(self.points())
        self.summary["tdwarf_dips"] = dips
        for name, dd in dips.items():
            out.append(
                crit(
                    f"T-dwarf {name} absorption dip >= 5 sigma",
                    dd.get("significance", 0) >= 5.0,
                    dd,
                    "continuum (interpolated from flanking bands) minus dip >= 5 sigma",
                )
            )
        return out

    def _crit_wise(self) -> list[dict]:
        out = []
        det = self.summary.get("detection", [])
        main = [e.index for e in self.epochs if e.full and e.survey_year == 1]
        rows56 = [r for r in det if r["group"] == "D5+D6" and r["epoch"] in main]
        snr56 = {r["epoch"]: (r.get("coadd_aperture") or {}).get("snr") for r in rows56}
        ok56 = len(rows56) == len(main) and all(v is not None and v >= 10 for v in snr56.values())
        out.append(
            crit(
                "detected at S/N >= 10 in D5+D6 co-adds of each main DR1 epoch",
                ok56,
                {
                    "coadd_aperture_snr": snr56,
                    "forced_ivw_snr": {r["epoch"]: r["forced_ivw_snr"] for r in rows56},
                },
                "co-add aperture S/N (r = 2 px, noise from random apertures) >= 10 in every full DR1 epoch",
            )
        )
        rows14 = [r for r in det if r["group"] in ("D1", "D2", "D3", "D4", "D1-D4") and r["epoch"] in main]
        vals = {
            f"E{r['epoch']} {r['group']}": [(r.get("coadd_aperture") or {}).get("snr"), r["forced_ivw_snr"]]
            for r in rows14
        }
        ok14 = bool(rows14) and all(abs(v[0]) < DETECTION_SNR for v in vals.values() if v[0] is not None)
        out.append(
            crit(
                "not detected in D1-D4 (main DR1 epochs)",
                ok14,
                vals,
                f"|co-add aperture S/N| < {DETECTION_SNR:g} for D1, D2, D3, D4 and D1-D4 stacks "
                "(forced IVW S/N listed second)",
                "the r = 2 px aperture contains the catalogued W1 = 15.0 / W2 = 15.2 neighbour "
                "(4-11 arcsec away), which is bright in D1-D4",
            )
        )
        # Added after the first run showed the neighbour inside the aperture: PSF photometry with the
        # catalogued static neighbours modelled; S/N from a bootstrap over exposures. Reported separately.
        psf56 = {r["epoch"]: (r.get("coadd_psf_neighbours_modelled") or {}).get("snr") for r in rows56}
        out.append(
            crit(
                "detected at S/N >= 10 in D5+D6 co-adds of each main DR1 epoch [PSF photometry, "
                "neighbour modelled]",
                len(psf56) == len(main) and all(v is not None and v >= 10 for v in psf56.values()),
                {
                    "psf_snr": psf56,
                    "flux": {
                        r["epoch"]: (r.get("coadd_psf_neighbours_modelled") or {}).get("flux") for r in rows56
                    },
                },
                "bootstrap S/N of the forced PSF flux >= 10 in every full DR1 epoch",
            )
        )
        psf14 = {
            f"E{r['epoch']} {r['group']}": (r.get("coadd_psf_neighbours_modelled") or {}).get("snr")
            for r in rows14
        }
        out.append(
            crit(
                "not detected in D1-D4 (main DR1 epochs) [PSF photometry, neighbour modelled]",
                bool(psf14) and all(abs(v) < DETECTION_SNR for v in psf14.values() if v is not None),
                psf14,
                f"|bootstrap S/N of the forced PSF flux| < {DETECTION_SNR:g} for D1-D4",
            )
        )
        m = self.summary["motion"]
        for tag in ("model", "single"):
            sh = m.get(f"shift_{tag}")
            if not sh:
                out.append(crit(f"shift ({tag})", False, None, "needs two epochs"))
                continue
            meas = sh["measured"]
            v = {
                "sep_arcsec": meas["sep_arcsec"],
                "sep_err_arcsec": meas["sep_err_arcsec"],
                "n_sigma_vs_static": meas["n_sigma"],
                "pa_deg": meas["pa_deg"],
                "predicted_sep_arcsec": sh["predicted"]["sep_arcsec"],
                "predicted_pa_deg": sh["predicted"]["pa_deg"],
                "ratio": sh["ratio"],
                "pa_diff_deg": sh["pa_diff_deg"],
                "from": sh["from"],
                "to": sh["to"],
            }
            note = (
                "neighbour modelled (primary)" if tag == "model" else "single-source fit (neighbour ignored)"
            )
            out.append(
                crit(
                    f"shift rejects a static source at > 4 sigma [{note}]",
                    (meas["n_sigma"] or 0) > 4,
                    v,
                    "n_sigma > 4",
                )
            )
            out.append(
                crit(
                    f"shift within 25 deg and 30% of the prediction [{note}]",
                    abs(sh["pa_diff_deg"]) <= 25 and abs(sh["ratio"] - 1) <= 0.30,
                    v,
                    "|dPA| <= 25 deg and |ratio - 1| <= 0.30",
                )
            )
        return out

    def _crit_rwaur(self) -> list[dict]:
        out = []
        m = self.summary["motion"]["primary"]
        if "fit" in m:
            f = m["fit"]
            mu, err = f["total_masyr"], f["total_err_masyr"]
            c = m["comparison"]
            v = {
                "pm_total_masyr": mu,
                "pm_err_masyr": err,
                "n_sigma_from_zero": mu / err if err else None,
                "pmra": f["pmra_masyr"],
                "pmdec": f["pmdec_masyr"],
                "pa_deg": f["pa_deg"],
                "catalog_masyr": c["total_cat_masyr"],
                "n_sigma_from_catalog": c["n_sigma"],
                "n_used": f["n_used"],
                "zero_point_mas": m.get("zero_point_mas"),
            }
            note = ""
            comp = TARGETS.get("rw-aur-b")
            if comp is not None:  # unresolved companion: does the apparent motion point at it?
                ra_a, de_a = propagate.barycentric_position(self.ast, f["ref_mjd"])
                ra_b, de_b = propagate.barycentric_position(comp.astrometry, f["ref_mjd"])
                xi, eta = motion.tangent_offsets_mas(float(ra_b), float(de_b), float(ra_a), float(de_a))
                v["companion_rw_aur_b"] = {
                    "sep_mas": math.hypot(float(xi), float(eta)),
                    "pa_deg": float(motion.position_angle_deg(xi, eta)),
                }
                note = (
                    f"RW Aur B ({v['companion_rw_aur_b']['sep_mas'] / 1000:.2f} arcsec, PA "
                    f"{v['companion_rw_aur_b']['pa_deg']:.0f} deg) is unresolved; the fitted motion points at "
                    f"PA {f['pa_deg']:.0f} deg: the A+B photocentre moves toward B as A fades "
                    "(variability-induced shift), see offsets_from_prediction"
                )
            out.append(
                crit(
                    "proper-motion null test |mu| < 3 sigma",
                    err > 0 and mu / err < 3.0,
                    v,
                    "|mu|/sigma < 3",
                    note,
                )
            )
        else:
            out.append(crit("proper-motion null test", False, m.get("status"), "|mu|/sigma < 3"))
        var = self.summary["variability"]
        best = var.get("first_to_last", {}).get("best")
        control = None
        bpath = DOCS / "barnards-star" / "summary.json"
        if bpath.exists():  # saturated-photometry systematics measured on a non-variable star
            bv = json.loads(bpath.read_text(encoding="utf-8")).get("variability", {}).get("first_to_last", {})
            control = {
                d: {"dmag": x.get("dmag"), "err": x.get("err")} for d, x in bv.get("per_detector", {}).items()
            }
        out.append(
            crit(
                "brightness change > 0.2 mag at > 5 sigma at matched wavelengths (first vs last epoch)",
                bool(best) and abs(best["dmag"]) > 0.2 and best["n_sigma"] > 5,
                {"best": best, "barnard_control_dmag": control},
                "some detector: |weighted mean dmag| > 0.2 and |dmag|/err > 5 (err scaled by sqrt(chi2_red))",
                "all RW Aur points are saturated; compare with the Barnard's Star control (same method, "
                "non-variable star)",
            )
        )
        return out

    def _crit_rdra(self) -> list[dict]:
        out = []
        ph = self.summary["photometry"]
        ok = [i for i in self.items if i.ok and i.phot is not None]
        n_sat = sum(i.phot.point.saturated for i in ok)
        out.append(
            crit(
                "100% of exposures flagged saturated",
                n_sat == len(ok) and len(ok) > 0,
                {"saturated": n_sat, "measured": len(ok), "per_detector": ph["per_detector"]},
                "every measured exposure has saturated=True",
            )
        )
        self.summary["mira"] = {}
        self._rdra_series = {}
        for attr, tag, note in (
            ("wing", "3-6 px annulus", "a-priori ring"),
            (
                "wing_outer",
                "8-12 px annulus, robustness variant",
                (
                    "chosen after the run showed the 3-6 px ring masked (BLOOM / TRANSIENT / SUR_ERROR) in 82-94% of "
                    "exposures; reported alongside, the a-priori rows above are the criteria of record"
                ),
            ),
        ):
            rd = rdra_phase_analysis(self.items, self.wide_epochs, self.wide_epoch_of, attr)
            self.summary["mira"][tag] = {k: v for k, v in rd.items() if k != "series"} | {"note": note}
            self._rdra_series[tag] = rd.get("series")
            order = rd.get("wide_epochs")
            if order:
                out.append(
                    crit(
                        f"brightness of the wide-survey epochs ordered as the Mira phase predicts [{tag}]",
                        rd["order_match"],
                        order,
                        "rank order of epoch-mean brightness (annulus index) equals rank order of "
                        "<cos 2 pi phase> over the epoch's exposures",
                        note,
                    )
                )
            fitp = rd.get("sinusoid")
            if fitp:
                okf = fitp["amp_snr"] > 5 and abs(((fitp["phase_max"] + 0.5) % 1.0) - 0.5) <= 0.25
                out.append(
                    crit(
                        f"full light curve: P = 246.12 d sinusoid detected, maximum within 0.25 cycle of the "
                        f"VSX visual maximum [{tag}]",
                        okf,
                        fitp | {"n_points": rd.get("n_points")},
                        "amplitude > 5 sigma and |phase of max| <= 0.25",
                        note,
                    )
                )
        return out

    # ---------------------------------------------------------------- coverage table and summary
    def coverage(self) -> None:
        s = ep.summarize(self.epochs)
        ok_by = Counter((i.epoch, i.det) for i in self.items if i.ok)
        lam: dict[tuple[int, int], list[float]] = defaultdict(list)
        for i in self.items:
            if i.ok and i.phot is not None and math.isfinite(i.phot.point.wavelength_um):
                lam[(i.epoch, i.det)].append(i.phot.point.wavelength_um)
        table = []
        for row in s["epochs"]:
            e = row["index"]
            r = {
                "epoch": e,
                "start": row["start"][:10],
                "end": row["end"][:10],
                "span_days": row["span_days"],
                "survey_year": row["survey_year"],
                "full": row["full"],
                "n_exposures": row["n_exposures"],
                "collections": row["collections"],
            }
            for d in range(1, 7):
                ws = lam.get((e, d), [])
                ch = {spectrum.channel_index(d, w) for w in ws} - {None}
                r[f"D{d}"] = {
                    "n": row["detector_counts"].get(str(d), 0),
                    "stamps_ok": ok_by.get((e, d), 0),
                    "channels_sampled": len(ch),
                    "lambda_um": [round(min(ws), 3), round(max(ws), 3)] if ws else None,
                }
            table.append(r)
        self.summary["coverage"] = {k: v for k, v in s.items() if k != "epochs"} | {"table": table}
        if self.wide_epochs is not self.epochs:
            self.summary["coverage"]["wide_epochs"] = [
                {k: x[k] for k in ("index", "start", "end", "span_days", "n_exposures", "full")}
                for x in ep.summarize(self.wide_epochs)["epochs"]
            ]

    def run(self) -> dict[str, Any]:
        t_start = time.perf_counter()
        self.out.mkdir(parents=True, exist_ok=True)
        self.summary["run"] = {
            "started_utc": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "fov_arcmin": self.args.fov_arcmin,
            "half_size_px_min": self.args.half_size,
            "workers": self.args.workers,
            "irsa_max_concurrency": config.IRSA_MAX_CONCURRENCY,
        }
        T = self.timer
        T.run("resolve", self.resolve_target)
        T.run("sia", self.index)
        T.run("stamps", self.read_stamps)
        T.run("epsf", self.read_epsfs)
        T.run("photometry", self.photometry)
        T.run("coadds", self.build_coadds)
        T.run("render", self.render_products)
        if self.cfg["motion"] == "coadd":
            T.run("motion", self.motion_from_coadds)
            T.run("render_d56", self.render_d56_stacks)
        else:
            T.run("motion", self.motion_from_exposures)
        T.run("spectra", self.spectra)
        try:
            T.run("field_stars", self.field_star_check)
        except Exception as exc:  # noqa: BLE001
            self.issues.append(f"field-star check failed: {exc!r}"[:200])
        self.coverage()
        try:
            self.summary["criteria"] = T.run("criteria", self.analyse)
        except Exception as exc:  # noqa: BLE001
            self.issues.append(f"criteria evaluation failed: {exc!r}")
            log.error(traceback.format_exc())
            self.summary["criteria"] = []
        for fn in (self.plot_spectrum, self.plot_lightcurve, self.plot_motion):
            try:
                T.run(fn.__name__, fn)
            except Exception as exc:  # noqa: BLE001
                self.issues.append(f"{fn.__name__} failed: {exc!r}")
                log.error(traceback.format_exc())
        total = rangeio.stats()
        self.summary["timings"] = T.as_dict()
        self.summary["totals"] = {
            "seconds": round(time.perf_counter() - t_start, 1),
            "range_requests": total.requests,
            "range_bytes": total.bytes,
            "range_retries": total.retries,
            "range_cache_hits": total.cache_hits,
            "sia": sia.sia_stats(),
            "note": "bytes are network bytes in this run; cached reads cost 0",
        }
        # Keep the network cost of earlier runs (re-runs read the cache and download almost nothing).
        history: list[dict[str, Any]] = []
        old_path = self.out / "summary.json"
        if old_path.exists():
            try:
                old = json.loads(old_path.read_text(encoding="utf-8"))
                history = old.get("download_history") or [
                    {
                        "started_utc": old.get("run", {}).get("started_utc"),
                        "range_bytes": old.get("totals", {}).get("range_bytes"),
                        "range_requests": old.get("totals", {}).get("range_requests"),
                        "range_retries": old.get("totals", {}).get("range_retries"),
                    }
                ]
            except (OSError, ValueError):
                history = []
        history.append(
            {
                "started_utc": self.summary["run"]["started_utc"],
                "range_bytes": total.bytes,
                "range_requests": total.requests,
                "range_retries": total.retries,
            }
        )
        self.summary["download_history"] = history
        self.summary["totals"]["range_bytes_all_runs"] = sum(h.get("range_bytes") or 0 for h in history)
        self.summary["issues"] = self.issues
        crits = self.summary["criteria"]
        self.summary["verdict"] = {
            "n_criteria": len(crits),
            "n_pass": sum(c["pass"] is True for c in crits),
            "n_fail": sum(c["pass"] is False for c in crits),
            "all_pass": bool(crits) and all(c["pass"] is True for c in crits),
        }
        self.summary["files"] = sorted(
            str(p.relative_to(self.out)).replace("\\", "/") for p in self.out.rglob("*") if p.is_file()
        )
        (self.out / "summary.json").write_text(json.dumps(jsonable(self.summary), indent=1), encoding="utf-8")
        return self.summary


# --- analysis functions ----------------------------------------------------------------------------------


def wing_index(
    stamp: Stamp,
    ra: float,
    dec: float,
    mask_bits: int,
    sat_bits: int,
    rings: Sequence[tuple[float, float]] = ((3.0, 4.0), (4.0, 5.0), (5.0, 6.0)),
    sky: tuple[float, float] = (18.0, 28.0),
) -> dict[str, Any] | None:
    """Annulus (wing) brightness index for a saturated star: sum over sub-rings of (mean valid SB x ring area).

    Pixels with science-mask or saturation flags are excluded; each sub-ring's mean surface brightness is
    scaled by its full area, so masked pixels do not bias the sum. Background: sigma-clipped median of the
    valid pixels at 18-28 px. Returns flux-like index in uJy (not aperture corrected: relative use only).
    """
    data = np.asarray(stamp.data, dtype=float)
    var = np.asarray(stamp.variance, dtype=float) if stamp.variance is not None else None
    flags = (
        np.asarray(stamp.flags).astype(np.int64)
        if stamp.flags is not None
        else np.zeros(data.shape, np.int64)
    )
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        x, y = stamp.wcs.world_to_pixel_values(ra, dec)
    x, y = float(x), float(y)
    yy, xx = np.indices(data.shape)
    r = np.hypot(xx - x, yy - y)
    good = np.isfinite(data) & ((flags & (int(mask_bits) | int(sat_bits))) == 0)
    if var is not None:
        good &= np.isfinite(var) & (var > 0)
    sky_sel = good & (r >= sky[0]) & (r <= sky[1])
    if sky_sel.sum() < 30:
        return None
    from astropy.stats import sigma_clipped_stats

    _, b, bstd = sigma_clipped_stats(data[sky_sel], sigma=3.0, maxiters=5)
    total, var_total, n_used, n_all = 0.0, 0.0, 0, 0
    for r0, r1 in rings:
        ring = (r >= r0) & (r < r1)
        sel = ring & good
        n_all += int(ring.sum())
        if sel.sum() < 3:
            return None
        area = math.pi * (r1**2 - r0**2)
        mean = float(np.mean(data[sel] - b))
        total += mean * area
        v = float(np.sum(var[sel])) / sel.sum() ** 2 if var is not None else bstd**2 / sel.sum()
        var_total += v * area**2
        n_used += int(sel.sum())
    k = forced.ujy_per_pixel(stamp.header)
    lam = bw = math.nan
    if stamp.wavelength_um is not None:
        from scipy.ndimage import map_coordinates

        lam = float(
            map_coordinates(np.asarray(stamp.wavelength_um, float), [[y], [x]], order=1, mode="nearest")[0]
        )
        bw = float(
            map_coordinates(np.asarray(stamp.bandwidth_um, float), [[y], [x]], order=1, mode="nearest")[0]
        )
    return {
        "flux_ujy": total * k,
        "err_ujy": math.sqrt(var_total) * k,
        "n_used": n_used,
        "n_ring": n_all,
        "valid_fraction": n_used / max(n_all, 1),
        "wavelength_um": lam,
        "bandwidth_um": bw,
        "detector": int(stamp.image.detector),
        "mjd": float(stamp.mjd_avg),
    }


def fit_gaussians(
    data: np.ndarray,
    weight: np.ndarray,
    x0: float,
    y0: float,
    neighbours: Sequence[tuple[float, float]],
    radius: float = 5.0,
) -> dict[str, Any] | None:
    """Least-squares fit of a target Gaussian (free x, y, flux) + fixed-position neighbours (free fluxes) +
    constant background, common free sigma, on grid pixels within ``radius`` px of the start position."""
    yy, xx = np.indices(data.shape)
    sel = (np.hypot(xx - x0, yy - y0) <= radius) & (weight > 0) & np.isfinite(data)
    if sel.sum() < 15:
        return None
    X, Y, D, W = xx[sel].astype(float), yy[sel].astype(float), data[sel].astype(float), np.sqrt(weight[sel])
    nb = list(neighbours)

    def g(xc, yc, s):
        return np.exp(-((X - xc) ** 2 + (Y - yc) ** 2) / (2 * s * s)) / (2 * math.pi * s * s)

    def resid(p):
        m = p[4] + p[2] * g(p[0], p[1], p[3])
        for k, (xn, yn) in enumerate(nb):
            m = m + p[5 + k] * g(xn, yn, p[3])
        return (D - m) * W

    peak = float(np.nanmax(D)) if D.size else 1.0
    p0 = [x0, y0, max(peak, 1e-3) * 2 * math.pi * 0.8**2, 0.8, float(np.nanmedian(D))] + [0.0] * len(nb)
    lo = [x0 - 3, y0 - 3, -np.inf, 0.35, -np.inf] + [0.0] * len(nb)
    hi = [x0 + 3, y0 + 3, np.inf, 2.5, np.inf] + [np.inf] * len(nb)
    try:
        r = least_squares(resid, p0, bounds=(lo, hi), x_scale="jac")
    except Exception:  # noqa: BLE001
        return None
    if not r.success:
        return None
    p = r.x
    return {
        "x": float(p[0]),
        "y": float(p[1]),
        "flux": float(p[2]),
        "sigma": float(p[3]),
        "bkg": float(p[4]),
        "nb_flux": [float(v) for v in p[5:]],
        "cost": float(r.cost),
    }


def psf_sigma_on_grid(fwhm_arcsec: float, pixel_arcsec: float) -> float:
    """Gaussian sigma (grid px) of a star on a bilinearly resampled co-add: PSF plus the triangle kernel (1/6 px^2)."""
    if not (math.isfinite(fwhm_arcsec) and fwhm_arcsec > 0):
        fwhm_arcsec = 8.6
    return math.sqrt((fwhm_arcsec / 2.3548 / pixel_arcsec) ** 2 + 1.0 / 6.0)


def _psf_columns(
    shape: tuple[int, int], sel: np.ndarray, pos: Sequence[tuple[float, float]], sigma: float
) -> np.ndarray:
    yy, xx = np.indices(shape)
    cols = [
        np.exp(-((xx[sel] - x) ** 2 + (yy[sel] - y) ** 2) / (2 * sigma**2)) / (2 * math.pi * sigma**2)
        for x, y in pos
    ]
    return np.column_stack([*cols, np.ones(int(sel.sum()))])


def forced_psf_snr(
    layers: Sequence[tuple[np.ndarray, np.ndarray]],
    x: float,
    y: float,
    neighbours: Sequence[tuple[float, float]],
    sigma: float,
    rng: np.random.Generator,
    radius: float = 4.0,
    n_boot: int = BOOTSTRAP,
) -> dict[str, Any]:
    """Forced Gaussian-PSF flux at (x, y) on the IVW co-add of ``layers``, with fixed-position neighbours (free
    fluxes) and a constant background fitted together; S/N from a bootstrap over the input exposures."""

    formal: list[float] = []

    def fit(sub: Sequence[tuple[np.ndarray, np.ndarray]], keep_formal: bool = False) -> np.ndarray | None:
        data, weight, _ = coadd_mod.coadd(sub, "ivw")
        yy, xx = np.indices(data.shape)
        sel = (np.hypot(xx - x, yy - y) <= radius) & (weight > 0) & np.isfinite(data)
        if sel.sum() < 12:
            return None
        A = _psf_columns(data.shape, sel, [(x, y), *neighbours], sigma)
        w = np.sqrt(weight[sel].astype(float))
        coef, *_ = np.linalg.lstsq(A * w[:, None], data[sel] * w, rcond=None)
        if keep_formal:  # least-squares error from the co-add weights (pipeline VARIANCE), pixels independent
            aw = A * w[:, None]
            formal.append(float(np.sqrt(np.linalg.inv(aw.T @ aw)[0, 0])))
        return coef

    best = fit(layers, keep_formal=True)
    if best is None:
        return {"status": "target region masked"}
    n = len(layers)
    boots = [
        c[0]
        for c in (fit([layers[k] for k in rng.integers(0, n, n)]) for _ in range(n_boot))
        if c is not None
    ]
    err = float(np.std(boots, ddof=1)) if len(boots) >= 20 else math.nan
    return {
        "flux": float(best[0]),
        "flux_err_bootstrap": err,
        "snr": float(best[0]) / err if err > 0 else None,
        "formal_snr_variance": float(best[0]) / formal[0] if formal and formal[0] > 0 else None,
        "neighbour_fluxes": [float(v) for v in best[1:-1]],
        "sigma_px": sigma,
        "n_neighbours": len(neighbours),
        "n_boot": len(boots),
        "note": "snr: bootstrap over exposures (conservative: includes the target's flux change across the "
        "D5/D6 wavelengths); formal_snr_variance: from the co-add weights, ignores the pixel "
        "correlations of the bilinear resampling (optimistic)",
    }


def aperture_snr(
    data: np.ndarray,
    weight: np.ndarray,
    x: float,
    y: float,
    avoid: Sequence[tuple[float, float]],
    r_ap: float = 2.0,
    annulus: tuple[float, float] = (4.0, 7.0),
    n_random: int = 400,
) -> dict[str, Any]:
    """Aperture S/N on a co-add with an empirical noise from random apertures (correlated noise included)."""
    yy, xx = np.indices(data.shape)
    valid = (weight > 0) & np.isfinite(data)

    def ap(xc, yc):
        rr = np.hypot(xx - xc, yy - yc)
        a = rr <= r_ap
        if not valid[a].all():
            return None
        an = valid & (rr >= annulus[0]) & (rr <= annulus[1])
        if an.sum() < 10:
            return None
        return float(np.sum(data[a] - np.median(data[an])))

    target = ap(x, y)
    rng = np.random.default_rng(7)
    ny, nx = data.shape
    sums = []
    tries = 0
    while len(sums) < n_random and tries < 20 * n_random:
        tries += 1
        xc, yc = rng.uniform(annulus[1], nx - 1 - annulus[1]), rng.uniform(annulus[1], ny - 1 - annulus[1])
        if math.hypot(xc - x, yc - y) < 8.0 or any(math.hypot(xc - a, yc - b) < 4.0 for a, b in avoid):
            continue
        v = ap(xc, yc)
        if v is not None:
            sums.append(v)
    if target is None or len(sums) < 30:
        return {
            "snr": None,
            "status": "target aperture masked or too few random apertures",
            "n_random": len(sums),
        }
    s = np.array(sums)
    noise = 1.4826 * float(np.median(np.abs(s - np.median(s))))
    return {
        "snr": target / noise if noise > 0 else None,
        "sum": target,
        "noise": noise,
        "n_random": len(sums),
    }


def band_mean(points: Sequence[PhotPoint], lo: float, hi: float) -> dict[str, Any]:
    sel = [p for p in points if lo <= p.wavelength_um <= hi and not p.saturated]
    f = [p.flux_ujy for p in sel]
    e = [p.flux_err_ujy for p in sel]
    mean, err, n, chi2 = spectrum.weighted_mean(f, e)
    if n and math.isfinite(chi2) and chi2 > 1:
        err *= math.sqrt(chi2)
    lam = float(np.mean([p.wavelength_um for p in sel])) if sel else math.nan
    return {"band_um": [lo, hi], "flux_ujy": mean, "err_ujy": err, "n": n, "chi2_red": chi2, "lambda_um": lam}


def tdwarf_dips(points: Sequence[PhotPoint]) -> dict[str, Any]:
    """H2O (1.4 um) and CH4 (3.3 um) dips relative to continuum interpolated between flanking peaks."""
    defs = {
        "H2O 1.4um": ((1.20, 1.31), (1.36, 1.48), (1.53, 1.68)),
        "CH4 3.3um": ((2.05, 2.25), (3.20, 3.40), (3.95, 4.15)),
    }
    out = {}
    for name, (left, mid, right) in defs.items():
        a, m, b = band_mean(points, *left), band_mean(points, *mid), band_mean(points, *right)
        if min(a["n"], m["n"], b["n"]) == 0:
            out[name] = {"status": "missing band", "left": a, "dip": m, "right": b}
            continue
        t = (m["lambda_um"] - a["lambda_um"]) / (b["lambda_um"] - a["lambda_um"])
        cont = a["flux_ujy"] + t * (b["flux_ujy"] - a["flux_ujy"])
        econt = math.hypot((1 - t) * a["err_ujy"], t * b["err_ujy"])
        sig = (cont - m["flux_ujy"]) / math.hypot(econt, m["err_ujy"])
        out[name] = {
            "continuum_ujy": cont,
            "dip_ujy": m["flux_ujy"],
            "depth": 1 - m["flux_ujy"] / cont,
            "significance": sig,
            "left": a,
            "dip": m,
            "right": b,
        }
    return out


def matched_variability(
    points: Sequence[PhotPoint],
    epochs: Sequence[Epoch],
    max_gap_bw: float = 1.5,
    exclude_saturated: bool = False,
) -> dict[str, Any]:
    """Magnitude change between epochs at matched wavelengths (later epoch interpolated, in log flux, at the
    earlier epoch's wavelengths), per detector; dmag > 0 means fading."""
    usable = [p for p in points if p.flux_ujy > 0 and p.flux_err_ujy > 0 and math.isfinite(p.wavelength_um)]
    eps_idx = sorted({p.epoch_index for p in usable if p.epoch_index is not None})
    full = [e.index for e in epochs if e.full and e.index in eps_idx]
    main = full if len(full) >= 2 else eps_idx

    def compare(ea: int, eb: int, excl: bool) -> dict[str, Any]:
        per = {}
        for d in range(1, 7):
            A = [p for p in usable if p.epoch_index == ea and p.detector == d and not (excl and p.saturated)]
            B = sorted(
                [p for p in usable if p.epoch_index == eb and p.detector == d and not (excl and p.saturated)],
                key=lambda p: p.wavelength_um,
            )
            if len(A) < 2 or len(B) < 2:
                continue
            lb = np.array([p.wavelength_um for p in B])
            mb = np.array([lightcurve.ab_mag(p.flux_ujy) for p in B])
            sb = np.array([lightcurve.mag_err(p.flux_ujy, p.flux_err_ujy) for p in B])
            dms, errs = [], []
            for p in A:
                j = int(np.searchsorted(lb, p.wavelength_um))
                if j == 0 or j == len(lb):
                    continue
                gap = lb[j] - lb[j - 1]
                if gap > max_gap_bw * p.bandwidth_um:
                    continue
                t = (p.wavelength_um - lb[j - 1]) / gap
                m_int = (1 - t) * mb[j - 1] + t * mb[j]
                s_int = math.hypot((1 - t) * sb[j - 1], t * sb[j])
                dms.append(m_int - lightcurve.ab_mag(p.flux_ujy))
                errs.append(math.hypot(s_int, lightcurve.mag_err(p.flux_ujy, p.flux_err_ujy)))
            if len(dms) < 2:
                continue
            mean, err, n, chi2 = spectrum.weighted_mean(dms, errs)
            err_s = err * math.sqrt(max(1.0, chi2)) if math.isfinite(chi2) else err
            per[f"D{d}"] = {
                "dmag": mean,
                "err": err_s,
                "n_sigma": abs(mean) / err_s if err_s > 0 else None,
                "n": n,
                "chi2_red": chi2,
                "lambda_um": [min(p.wavelength_um for p in A), max(p.wavelength_um for p in A)],
                "n_saturated_a": sum(p.saturated for p in A),
                "n_saturated_b": sum(p.saturated for p in B),
            }
        best = None
        for d, v in per.items():
            more_significant = best is None or abs(v["dmag"]) / v["err"] > abs(best["dmag"]) / best["err"]
            if v["n_sigma"] is not None and abs(v["dmag"]) > 0.2 and more_significant:
                best = v | {"detector": d}
        if best is None and per:
            d, v = max(per.items(), key=lambda kv: abs(kv[1]["dmag"]))
            best = v | {"detector": d}
        return {"from_epoch": ea, "to_epoch": eb, "per_detector": per, "best": best}

    out: dict[str, Any] = {
        "method": "later epoch log-flux interpolated in wavelength at the earlier epoch's points "
        f"(gap <= {max_gap_bw} bandwidths); dmag > 0 = fading; errors scaled by "
        "sqrt(chi2_red)",
        "epochs_compared": main,
    }
    if len(main) >= 2:
        out["first_to_last"] = compare(main[0], main[-1], exclude_saturated)
        out["first_to_last_unsaturated"] = compare(main[0], main[-1], True)
        out["pairs"] = [compare(a, b, exclude_saturated) for a, b in pairwise(main)]
    return out


def rdra_phase_analysis(
    items: Sequence[Item], wide_epochs: Sequence[Epoch], wide_epoch_of: dict[str, int], attr: str = "wing"
) -> dict[str, Any]:
    """Annulus-index light curve of R Dra normalised by the mean spectrum, against the Mira phase."""
    sel_items = [
        i for i in items if i.ok and getattr(i, attr) is not None and getattr(i, attr)["flux_ujy"] > 0
    ]
    rows = [getattr(i, attr) for i in sel_items]
    obs = [i.image.obs_id for i in sel_items]
    if len(rows) < 20:
        return {"status": f"too few annulus measurements ({len(rows)})"}
    det = np.array([r["detector"] for r in rows])
    lam = np.array([r["wavelength_um"] for r in rows])
    flux = np.array([r["flux_ujy"] for r in rows])
    mjd = np.array([r["mjd"] for r in rows])
    ch = np.array(
        [
            spectrum.channel_index(int(d), float(w)) if math.isfinite(w) else -1
            for d, w in zip(det, lam, strict=True)
        ],
        dtype=object,
    )
    dm = np.full(len(rows), np.nan)
    for d in range(1, 7):
        for c in set(ch[det == d]):
            if c is None or c == -1:
                continue
            sel = (det == d) & (ch == c)
            if sel.sum() >= 3:
                dm[sel] = -2.5 * np.log10(flux[sel] / np.median(flux[sel]))
    good = np.isfinite(dm)
    phase = mira_phase(mjd)
    rho, p_rho = sstats.spearmanr(dm[good], np.cos(2 * math.pi * phase[good]))
    # sinusoid dm = c + a cos(2 pi phi) + b sin(2 pi phi); brightness maximum where dm is minimal
    A = np.column_stack(
        [np.ones(good.sum()), np.cos(2 * math.pi * phase[good]), np.sin(2 * math.pi * phase[good])]
    )
    coef, *_ = np.linalg.lstsq(A, dm[good], rcond=None)
    res = dm[good] - A @ coef
    s2 = float(np.sum(res**2) / max(1, good.sum() - 3))
    cov = s2 * np.linalg.inv(A.T @ A)
    a, b = coef[1], coef[2]
    amp = math.hypot(a, b)
    amp_err = (
        math.sqrt(a * a * cov[1, 1] + b * b * cov[2, 2] + 2 * a * b * cov[1, 2]) / amp
        if amp > 0
        else math.nan
    )
    phase_max = (math.atan2(-b, -a) / (2 * math.pi)) % 1.0

    def model(t):
        ph = mira_phase(t)
        return coef[0] + a * np.cos(2 * math.pi * ph) + b * np.sin(2 * math.pi * ph)

    # wide-survey epochs (as in research): epoch-mean dm and expected <cos 2 pi phase>
    wide = []
    for e in wide_epochs:
        sel = np.array([wide_epoch_of.get(o) == e.index for o in obs]) & good
        if sel.sum() < 5:
            continue
        wide.append(
            {
                "epoch": e.index,
                "start": date(e.t_start_mjd),
                "end": date(e.t_end_mjd),
                "n": int(sel.sum()),
                "mean_phase": float(
                    np.angle(np.mean(np.exp(2j * math.pi * phase[sel]))) / (2 * math.pi) % 1.0
                ),
                "expected_brightness_cos": float(np.mean(np.cos(2 * math.pi * phase[sel]))),
                "mean_dmag": float(np.mean(dm[sel])),
                "dmag_err": float(np.std(dm[sel], ddof=1) / math.sqrt(sel.sum())),
            }
        )
    order_match = None
    if len(wide) >= 2:
        by_expect = [w["epoch"] for w in sorted(wide, key=lambda w: -w["expected_brightness_cos"])]
        by_bright = [w["epoch"] for w in sorted(wide, key=lambda w: w["mean_dmag"])]
        order_match = by_expect == by_bright
    return {
        "method": f"annulus wing index per exposure ({attr}); dmag relative to the median of the same detector "
        "channel over all epochs; phase = (MJD - 57369.5)/246.12 mod 1 (VSX maximum JD 2457370)",
        "n_points": int(good.sum()),
        "spearman_dmag_vs_cos_phase": {"rho": float(rho), "p": float(p_rho)},
        "sinusoid": {
            "amplitude_mag": amp,
            "amp_err": amp_err,
            "amp_snr": amp / amp_err if amp_err > 0 else None,
            "phase_max": phase_max,
            "offset": float(coef[0]),
            "rms_mag": math.sqrt(s2),
        },
        "wide_epochs": wide,
        "order_match": order_match,
        "series": {"mjd": mjd[good], "dm": dm[good], "det": det[good], "model": model},
    }


# --- aggregation and CLI ---------------------------------------------------------------------------------


def aggregate() -> dict[str, Any]:
    agg: dict[str, Any] = {"generated_utc": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"), "targets": {}}
    tot_bytes = tot_req = 0
    for key in PRIMARY:
        p = DOCS / key / "summary.json"
        if not p.exists():
            agg["targets"][key] = {"status": "not run"}
            continue
        s = json.loads(p.read_text(encoding="utf-8"))
        tot_bytes += (
            s.get("totals", {}).get("range_bytes_all_runs", s.get("totals", {}).get("range_bytes", 0)) or 0
        )
        tot_req += (
            sum(h.get("range_requests") or 0 for h in s.get("download_history", []))
            or s.get("totals", {}).get("range_requests", 0)
            or 0
        )
        cov = s.get("coverage", {})
        agg["targets"][key] = {
            "name": s.get("target", {}).get("name"),
            "verdict": s.get("verdict"),
            "criteria": [
                {k: c.get(k) for k in ("name", "pass", "threshold")} | {"value": c.get("value")}
                for c in s.get("criteria", [])
            ],
            "n_images": s.get("index", {}).get("n_images_used"),
            "n_epochs": cov.get("n_epochs"),
            "n_full": cov.get("n_full"),
            "baseline_days": cov.get("baseline_days"),
            "seconds": s.get("totals", {}).get("seconds"),
            "range_bytes": s.get("totals", {}).get("range_bytes"),
            "issues": s.get("issues"),
            "files": [f"{key}/{f}" for f in s.get("files", []) if not f.startswith("frames/")],
        }
    agg["totals"] = {
        "range_bytes": tot_bytes,
        "range_requests": tot_req,
        "note": "network bytes downloaded by every probe run so far (byte ranges only; cached re-runs "
        "cost almost nothing)",
    }
    (DOCS / "summary.json").write_text(json.dumps(jsonable(agg), indent=1), encoding="utf-8")
    return agg


def main(argv: Sequence[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--target", help="target slug (barnards-star, eps-indi-b, wise-0855, rw-aur, r-dra)")
    ap.add_argument("--fov-arcmin", type=float, default=6.0)
    ap.add_argument("--half-size", type=int, default=30, help="minimum stamp half size in pixels")
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--aggregate-only", action="store_true")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )
    for noisy in ("httpx", "httpcore", "pxh.spherex.sia", "pxh.spherex.l2", "pxh.photometry.forced"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
    warnings.filterwarnings("ignore", module="astropy")
    if not args.aggregate_only:
        if not args.target:
            ap.error("--target is required")
        s = Probe(args).run()
        print(
            json.dumps(
                jsonable(
                    {
                        "target": args.target,
                        "verdict": s["verdict"],
                        "criteria": [(c["name"], c["pass"]) for c in s["criteria"]],
                        "issues": s["issues"],
                        "totals": s["totals"],
                    }
                ),
                indent=1,
            )
        )
    aggregate()
    return 0


if __name__ == "__main__":
    sys.exit(main())
