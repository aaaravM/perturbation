"""Build the static FieldManifest bundles of the five challenge targets (docs/api-contract.md, section 1).

Run from backend/ (the uv project):

    uv run python ../scripts/build_bundles.py                    # all five targets
    uv run python ../scripts/build_bundles.py --target wise-0855
    uv run python ../scripts/build_bundles.py --stage stamps     # only prefetch the 10 arcmin stamps

Output: frontend/public/bundles/<slug>/manifest.json and frames/*.png, so the demo works with IRSA and the
backend down. Each target:

1. Analysis: the Phase 1 probe (scripts/phase1_probe.py) runs unchanged on its cached 6 arcmin stamps, into
   data/tmp/bundles/<slug>/phase1. Its forced photometry, motion fits, spectra, light curves and acceptance
   criteria give the manifest's motion, spectrum, lightcurve and checks, so the numbers
   are the Phase 1 numbers.
2. Frames: a 10 arcmin north-up TAN grid centred on the target's barycentric position at the middle of the
   baseline. Stamps of every image are re-read around the grid centre, large enough to cover the grid for the
   detector's rotation, and co-added per epoch and detector: IMAGE minus ZODI, weights 1/VARIANCE, pixels
   with a bit of the official photometry mask (Explanatory Supplement v2.1 section 3.3, 0x3C028E44)
   rejected, OVERFLOW (saturation) kept and drawn in the flags overlay, then an inverse-variance mean after
   3-sigma clipping (single-exposure streaks and transients drop out). One asinh stretch per detector is
   shared by all epochs, so brightness changes between frames are real. R Dra keeps its many deep-field
   epochs for the light curve but at most MAX_BLINK_EPOCHS of them become blink frames.
3. Then vs Now: AllWISE W2 atlas cutouts (IRSA SIA collection wise_allwise, about 2010.5; a second tile
   fills the field near a tile edge) resampled onto the same grid (flux-conserving), next to the latest full
   SPHEREx D6 epoch, both with the same percentile-based stretch so the blink only shows what changed.
4. Differences (last minus first full epoch, S/N), RGB (D6, D3, D1 as red, green, blue) and RGBA flag
   overlays for the target's best detector.

PNG encoding: 8-bit, row 0 = north, east left, matching grid.wcs (pxh.imaging.render). Epoch frames are
grey + alpha (transparent where no data); difference frames are opaque grey, 127.5 = 0 sigma, mapped
linearly to the symmetric limits (the frontend recolours them, so they carry no transparency).
"""

from __future__ import annotations

import argparse
import io
import json
import logging
import math
import shutil
import sys
import time
import warnings
from collections import Counter, defaultdict
from collections.abc import Sequence
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import numpy as np
from astropy.io import fits
from astropy.io.votable import parse as parse_votable
from astropy.wcs import WCS
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
import phase1_probe as p1  # the Phase 1 analysis, reused as is

from pxh import config
from pxh.imaging import align, render
from pxh.imaging import coadd as coadd_mod
from pxh.imaging import diff as diff_mod
from pxh.models import Frame, Stamp
from pxh.photometry import lightcurve
from pxh.sky import propagate
from pxh.sky.targets import TARGETS
from pxh.spherex import epochs as ep
from pxh.spherex import flags as fl
from pxh.spherex import l2, rangeio

log = logging.getLogger("build_bundles")

BUNDLES = config.REPO_ROOT / "frontend" / "public" / "bundles"
WORK = config.REPO_ROOT / "data" / "tmp" / "bundles"
SLUGS = p1.PRIMARY
SCHEMA = "pxh-field/1"

# --- a-priori rendering constants -------------------------------------------------------------------------
FOV_ARCMIN = 10.0
# Official SPHEREx photometry mask (Explanatory Supplement v2.1 section 3.3): SUR_ERROR, NONFUNC,
# MISSING_DATA, HOT, COLD, NONLINEAR, PERSIST, BLOOM, SNOWBALL, HALO, SATELLITE_HALO. OVERFLOW is not in it.
PHOT_MASK = 0x3C028E44
PHOT_MASK_NAMES = (
    "SUR_ERROR",
    "NONFUNC",
    "MISSING_DATA",
    "HOT",
    "COLD",
    "NONLINEAR",
    "PERSIST",
    "BLOOM",
    "SNOWBALL",
    "HALO",
    "SATELLITE_HALO",
)
STRETCH_PERCENTILES = (0.5, 99.7)
COADD_METHOD = "sigclip"  # inverse-variance mean after 3-sigma clipping around the per-pixel median
MAX_BLINK_EPOCHS = 12
MAX_STAMPS_PER_EPOCH_DET = 16  # deep fields only (R Dra): evenly spaced in time within an epoch
FLAG_FRACTION = 0.5  # overlay a grid pixel when its flag is set in >= half of the exposures covering it
SATURATED_COLOR = "#f2895a"
ARTIFACT_COLOR = "#9a9994"
OVERLAY_ALPHA = 200
DIFF_MIN_LIMIT = 5.0
RGB_CHANNELS = (6, 3, 1)  # red, green, blue
WISE_CUTOUT_DEG = 0.2
ALLWISE_SIA_COLLECTION = "wise_allwise"

# Best detector per target (flags overlay, first difference frame, Sky-mode visits): where the object is
# best seen or changes most, fixed from the Phase 1 results.
BEST_DETECTOR = {"barnards-star": 6, "eps-indi-b": 6, "wise-0855": 6, "rw-aur": 5, "r-dra": 6}


# --- small helpers ------------------------------------------------------------------------------------------


def iso_now() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def rnd(v: Any, nd: int = 6) -> Any:
    """Round floats for JSON (None for non-finite)."""
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return v
    return round(f, nd) if math.isfinite(f) else None


def month_label(mjd: float) -> str:
    return datetime.fromisoformat(ep.mjd_to_iso(mjd)).strftime("%b %Y")


def day_label(mjd: float) -> str:
    d = datetime.fromisoformat(ep.mjd_to_iso(mjd))
    return f"{d.day} {d.strftime('%b %Y')}"


def encode_png(pixels: np.ndarray) -> bytes:
    """8-bit PNG: L for (H, W), LA for (H, W, 2), RGBA for (H, W, 4) uint8; pixels are already north-up."""
    buf = io.BytesIO()
    Image.fromarray(np.ascontiguousarray(pixels, dtype=np.uint8)).save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def grey_png(values: np.ndarray, vmin: float, vmax: float, stretch: str = "asinh") -> bytes:
    """Grey (+ alpha where invalid) PNG of a grid array in FITS order, with pxh.imaging.render's stretches."""
    level = render.apply_stretch((np.asarray(values, float) - vmin) / (vmax - vmin), stretch)
    grey = np.round(np.nan_to_num(level, nan=0.0) * 255.0).astype(np.uint8)
    invalid = ~np.isfinite(values)
    if invalid.any():
        alpha = np.where(invalid, 0, 255).astype(np.uint8)
        return encode_png(np.flipud(np.stack([np.where(invalid, 0, grey), alpha], axis=-1)))
    return encode_png(np.flipud(grey))


def frame_values(fr: Frame) -> np.ndarray:
    return np.where(fr.weight > 0, fr.data, np.nan)


def nice_limit(x: float) -> float:
    """Smallest of 5, 10, 20, 50, 100, 200, 500, ... that is >= x (a readable legend in sigma)."""
    m, k = DIFF_MIN_LIMIT, 0
    while m < x:
        k += 1
        m = (5.0, 10.0, 20.0)[k % 3] * 10.0 ** (k // 3)
    return float(m)


def hex_rgb(color: str) -> tuple[int, int, int]:
    c = color.lstrip("#")
    return int(c[0:2], 16), int(c[2:4], 16), int(c[4:6], 16)


# --- stage 1: the Phase 1 analysis --------------------------------------------------------------------------


def probe_args(slug: str, workers: int) -> argparse.Namespace:
    # Exactly the Phase 1 settings (fov 6 arcmin, minimum half size 30 px): the cached stamps are reused.
    return argparse.Namespace(target=slug, fov_arcmin=6.0, half_size=30, workers=workers, verbose=False)


def run_analysis(slug: str, workers: int) -> p1.Probe:
    P = p1.Probe(probe_args(slug, workers))
    P.out = WORK / slug / "phase1"  # never overwrite docs/phase1
    P.run()
    return P


def index_only(slug: str, workers: int) -> p1.Probe:
    P = p1.Probe(probe_args(slug, workers))
    P.out = WORK / slug / "phase1"
    P.resolve_target()
    P.index()
    return P


# --- stage 2: the 10 arcmin grid and its stamps -------------------------------------------------------------


class FieldPlan:
    """Grid, blink epochs and the images that feed the frames of one target."""

    def __init__(self, P: p1.Probe) -> None:
        self.P = P
        t0 = min(i.image.t_min_mjd for i in P.items)
        t1 = max(i.image.t_max_mjd for i in P.items)
        self.mjd_mid = 0.5 * (t0 + t1)
        ra, dec = propagate.barycentric_position(P.ast, self.mjd_mid)
        self.ra, self.dec = float(ra), float(dec)
        self.grid = align.make_grid(self.ra, self.dec, FOV_ARCMIN)
        self.gw, self.shape = self.grid
        self.n = self.shape[0]
        self.blink = self._blink_epochs()
        self.items = self._frame_items()

    def _blink_epochs(self) -> list[int]:
        eps = self.P.epochs
        if len(eps) <= MAX_BLINK_EPOCHS:
            return [e.index for e in eps]
        # The epochs with the most exposures (deepest co-adds; at the deep fields each month samples only some
        # detector pairs, so this also spreads frames over all six detectors), shown in time order.
        ranked = sorted(eps, key=lambda e: (-len(e.exposures), not e.full, e.index))[:MAX_BLINK_EPOCHS]
        return sorted(e.index for e in ranked)

    def _frame_items(self) -> list[p1.Item]:
        keep = set(self.blink)
        groups: dict[tuple[int, int], list[p1.Item]] = defaultdict(list)
        for i in self.P.items:
            if i.epoch in keep:
                groups[(i.epoch, i.det)].append(i)
        out: list[p1.Item] = []
        for _, its in sorted(groups.items()):
            its.sort(key=lambda i: (i.image.t_min_mjd, i.image.obs_id))
            deep = any(ep_is_deep(i) for i in its)
            if deep and len(its) > MAX_STAMPS_PER_EPOCH_DET:
                pick = np.unique(np.round(np.linspace(0, len(its) - 1, MAX_STAMPS_PER_EPOCH_DET)).astype(int))
                its = [its[k] for k in pick]
            out.extend(its)
        return out

    def half_size(self, layout: l2.L2Layout) -> int:
        """Stamp half size that covers this grid for the detector's rotation (the probe's own rule)."""
        saved = getattr(self.P, "grid_n", None)
        self.P.grid_n = self.n
        try:
            return self.P._stamp_half(layout)
        finally:
            if saved is not None:
                self.P.grid_n = saved

    def read(self, item: p1.Item) -> Stamp | None:
        try:
            layout = l2.read_layout(item.image)
            return l2.read_stamp(item.image, self.ra, self.dec, half_size_px=self.half_size(layout))
        except l2.OutsideDetectorError:
            return None
        except Exception as exc:  # noqa: BLE001 - one bad image must not stop a bundle
            log.warning("%s D%d: %r", item.image.obs_id, item.det, exc)
            return None

    def read_all(self, workers: int) -> dict[str, Stamp]:
        t0 = time.perf_counter()
        out: dict[str, Stamp] = {}
        n = len(self.items)
        with ThreadPoolExecutor(max_workers=workers) as pool:
            for k, (item, st) in enumerate(zip(self.items, pool.map(self.read, self.items), strict=True)):
                if st is not None:
                    out[item.image.cache_key] = st
                if (k + 1) % 50 == 0 or k + 1 == n:
                    s = rangeio.stats()
                    log.info(
                        "%s 10' stamps %d/%d  %.0f s  %.1f MB downloaded so far",
                        self.P.key,
                        k + 1,
                        n,
                        time.perf_counter() - t0,
                        s.bytes / 1e6,
                    )
        return out


def ep_is_deep(item: p1.Item) -> bool:
    from pxh.spherex import sia

    return sia.is_deep_collection(item.image.collection)


# --- stage 3: co-adds, overlays and PNGs ----------------------------------------------------------------------


def check_phot_mask(stamps: Sequence[Stamp]) -> None:
    """The fixed PHOT_MASK bits must carry the documented names in every file used (undefined bits are never set)."""
    want = {n: b for n, b in zip(PHOT_MASK_NAMES, [b for b in range(32) if PHOT_MASK >> b & 1], strict=True)}
    for st in stamps:
        for name, bit in want.items():
            got = st.flag_bits.get(name)
            if got is not None and got != bit:
                raise RuntimeError(f"{st.image.basename}: {name} is bit {got}, PHOT_MASK expects {bit}")


def coadd_epochs(plan: FieldPlan, stamps: dict[str, Stamp]) -> dict[tuple[int, int], Frame]:
    """Per-epoch, per-detector co-adds on the plan's grid: PHOT_MASK pixels rejected, OVERFLOW kept, then a
    sigma-clipped inverse-variance mean (pxh.imaging.coadd 'sigclip': single-exposure streaks, ghosts and
    unflagged transients are dropped; stacks of fewer than 3 are plain IVW means)."""
    frames: dict[tuple[int, int], Frame] = {}
    groups: dict[tuple[int, int], list[Stamp]] = defaultdict(list)
    for item in plan.items:
        st = stamps.get(item.image.cache_key)
        if st is not None:
            groups[(item.epoch, item.det)].append(st)
    for (e, d), sts in sorted(groups.items()):
        fr = coadd_mod.coadd_stamps(
            sts,
            plan.grid,
            PHOT_MASK,
            f"D{d} E{e}",
            epoch_index=e,
            detector=d,
            method=COADD_METHOD,
            saturation_bits=0,
        )
        if fr.n_inputs > 0:
            fr.meta["stamps"] = sts
            frames[(e, d)] = fr
    return frames


def flag_fraction_maps(plan: FieldPlan, stamps: Sequence[Stamp]) -> tuple[np.ndarray, np.ndarray]:
    """Fraction of the exposures covering each grid pixel in which OVERFLOW / an artifact flag is set."""
    cover = np.zeros(plan.shape, float)
    sat = np.zeros(plan.shape, float)
    art = np.zeros(plan.shape, float)
    for st in stamps:
        _, _, fp = align.reproject_stamp(st, plan.gw, plan.shape, 0, True, 0)
        on = fp > 0
        cover += on
        sat += on & align.saturated_mask_on_grid(st, plan.gw, plan.shape, fl.saturation_mask(st.flag_bits))
        art += on & align.saturated_mask_on_grid(st, plan.gw, plan.shape, fl.artifact_mask(st.flag_bits))
    with np.errstate(invalid="ignore", divide="ignore"):
        return np.where(cover > 0, sat / cover, 0.0), np.where(cover > 0, art / cover, 0.0)


def flags_png(sat_frac: np.ndarray, art_frac: np.ndarray) -> bytes:
    rgba = np.zeros((*sat_frac.shape, 4), np.uint8)
    art = art_frac >= FLAG_FRACTION
    sat = sat_frac >= FLAG_FRACTION
    rgba[art] = (*hex_rgb(ARTIFACT_COLOR), OVERLAY_ALPHA)
    rgba[sat] = (*hex_rgb(SATURATED_COLOR), OVERLAY_ALPHA)  # saturation drawn over artifacts
    return encode_png(np.flipud(rgba))


def difference_png(snr: np.ndarray, limit: float) -> bytes:
    """Opaque grey: 0 = -limit, 255 = +limit, 127.5 = 0 sigma (no data drawn as 0 sigma)."""
    t = np.clip(np.nan_to_num(np.asarray(snr, float), nan=0.0) / limit, -1.0, 1.0)
    return encode_png(np.flipud(np.round(127.5 + 127.5 * t).astype(np.uint8)))


def rgb_png(planes: Sequence[np.ndarray], limits: Sequence[tuple[float, float]]) -> bytes:
    return render.rgb_composite(*planes, limits=list(limits), stretch="asinh", nan_transparent=True)


# --- AllWISE W2 ------------------------------------------------------------------------------------------------


def allwise_w2_tiles(ra: float, dec: float) -> list[tuple[np.ndarray, WCS, dict[str, Any]]]:
    """AllWISE W2 atlas cutouts around (ra, dec) from every tile that overlaps the field (nearest tile first).

    IRSA SIA (collection wise_allwise) lists the tiles; IBE cuts each one (?center=RA,DEC&size=0.2), clipped at
    the tile edge, so a field near a tile boundary needs two tiles. Cached under CACHE_DIR/imaging/allwise.
    """
    root = config.CACHE_DIR / "imaging" / "allwise"
    index_path = root / f"sia_w2_{ra:.5f}_{dec:+.5f}.json"
    if not index_path.exists():
        # Point queries (fast on IRSA SIA) at the centre and the four corners of the field: every tile that
        # contains a corner is needed to cover it.
        h = WISE_CUTOUT_DEG / 2 / math.sqrt(2)
        cosd = max(math.cos(math.radians(dec)), 1e-6)
        points = [(ra, dec)] + [(ra + sx * h / cosd, dec + sy * h) for sx in (-1, 1) for sy in (-1, 1)]
        tiles: dict[str, dict[str, Any]] = {}
        for pra, pdec in points:
            body = rangeio.http_get(
                config.IRSA_SIA_URL,
                params={
                    "COLLECTION": ALLWISE_SIA_COLLECTION,
                    "POS": f"CIRCLE {pra % 360:.6f} {pdec:.6f} 0.001",
                    "RESPONSEFORMAT": "VOTABLE",
                },
            )
            tab = parse_votable(io.BytesIO(body)).get_first_table()
            names = [f.name or f.ID for f in tab.fields]
            for r in (dict(zip(names, row, strict=True)) for row in tab.array):
                url = str(r.get("access_url", ""))
                if str(r.get("energy_bandpassname")) == "W2" and url.endswith("-w2-int-3.fits"):
                    tiles[url] = {
                        "url": url,
                        "coadd_id": str(r.get("obs_id")),
                        "s_ra": float(r["s_ra"]),
                        "s_dec": float(r["s_dec"]),
                        "t_min": float(r["t_min"]),
                        "t_max": float(r["t_max"]),
                    }
        if not tiles:
            raise RuntimeError(f"no AllWISE W2 atlas image near {ra:.5f} {dec:+.5f}")
        ordered = sorted(tiles.values(), key=lambda t: _sep_deg(ra, dec, t["s_ra"], t["s_dec"]))
        root.mkdir(parents=True, exist_ok=True)
        index = {"fetched_utc": iso_now(), "tiles": ordered}
        rangeio.write_atomic(index_path, json.dumps(index).encode("utf-8"))
    index = json.loads(index_path.read_text(encoding="utf-8"))
    out = []
    for t in index["tiles"][:4]:
        path = root / f"{t['coadd_id']}_w2_{ra:.5f}_{dec:+.5f}_{WISE_CUTOUT_DEG:g}.fits"
        if not path.exists():
            cut = rangeio.http_get(
                t["url"], params={"center": f"{ra:.6f},{dec:.6f}", "size": f"{WISE_CUTOUT_DEG:g}"}
            )
            rangeio.write_atomic(path, cut)
        with fits.open(path) as hdul:
            hdu = next(h for h in hdul if h.data is not None)
            data = np.asarray(hdu.data, float)
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                wcs = WCS(hdu.header).celestial
        out.append((data, wcs, t | {"fetched_utc": index["fetched_utc"]}))
    return out


def _sep_deg(ra1: float, dec1: float, ra2: float, dec2: float) -> float:
    d = ((ra2 - ra1 + 180.0) % 360.0 - 180.0) * math.cos(math.radians(0.5 * (dec1 + dec2)))
    return math.hypot(d, dec2 - dec1)


def wise_on_grid(plan: FieldPlan) -> tuple[np.ndarray, dict[str, Any]]:
    """AllWISE W2 on the plan's grid (flux-conserving reprojection); tiles fill each other's gaps, each with its
    sky level (sigma-clipped median) removed so there is no seam. meta: tiles used and the mean epoch."""
    from astropy.stats import sigma_clipped_stats
    from reproject import reproject_exact

    mosaic = np.full(plan.shape, np.nan)
    used: list[tuple[dict[str, Any], int]] = []
    for data, wcs, meta in allwise_w2_tiles(plan.ra, plan.dec):
        img, footprint = reproject_exact((data, wcs), plan.gw, shape_out=plan.shape)
        img = np.where(np.nan_to_num(footprint) > 0.99, img, np.nan)
        good = np.isfinite(img)
        if good.sum() < 50:
            continue
        _, sky, _ = sigma_clipped_stats(img[good], sigma=3.0, maxiters=5)
        fill = good & ~np.isfinite(mosaic)
        if fill.any():
            mosaic[fill] = img[fill] - sky
            used.append((meta, int(fill.sum())))
        if np.isfinite(mosaic).all():
            break
    if not used:
        raise RuntimeError("AllWISE W2 cutouts do not cover the grid")
    n = sum(k for _, k in used)
    mjd = sum(0.5 * (m["t_min"] + m["t_max"]) * k for m, k in used) / n
    return mosaic, {
        "tiles": [m["coadd_id"] for m, _ in used],
        "mjd": mjd,
        "fetched_utc": used[0][0]["fetched_utc"],
    }


# --- manifest pieces ---------------------------------------------------------------------------------------------


def frontend_targets() -> dict[str, dict[str, Any]]:
    """Name, kind, summary and facts of each featured target, read from frontend/src/lib/targets.ts."""
    import re

    text = (config.REPO_ROOT / "frontend" / "src" / "lib" / "targets.ts").read_text(encoding="utf-8")
    out: dict[str, dict[str, Any]] = {}
    lit = r'"((?:[^"\\]|\\.)*)"'
    for block in text.split("slug: ")[1:]:
        if not block.startswith('"'):  # the interface declaration
            continue
        slug = re.match(lit, block).group(1)
        body = block.split("watchFor:")[0]
        out[slug] = {
            "name": re.search(r"name: " + lit, body).group(1),
            "kind": re.search(r"kind: " + lit, body).group(1),
            "summary": re.search(r"summary:\s*" + lit, body).group(1),
            "facts": [
                {"label": a, "value": b}
                for a, b in re.findall(r"\{ label: " + lit + r", value: " + lit + r" \}", body)
            ],
        }
    return out


def epoch_pa(P: p1.Probe, e: Any) -> int | None:
    """Majority SPS_EPA over the epoch's images (headers from the cached layouts): 0 or 180 in the wide survey;
    other values occur at the ecliptic-pole deep field, where the direction of ecliptic north turns quickly."""
    vals = []
    for x in e.exposures:
        for im in x.images:
            lay = l2.cached_layout(im)
            if lay is not None and "SPS_EPA" in lay.image_header:
                vals.append(round(float(lay.image_header["SPS_EPA"])) % 360)
    return Counter(vals).most_common(1)[0][0] if vals else None


def survey_name(year: int | None, pa: int | None) -> str:
    """Contract rule: S1 = PA 0 and S2 = PA 180 in Year 1; S3 = PA 0 and S4 = PA 180 in Year 2. A deep-field PA
    that is neither goes with the nearer of the two orientations."""
    if year is None or pa is None:
        return ""
    base = 1 if year == 1 else 3
    near_180 = abs((pa - 180 + 180) % 360 - 180) < abs((pa + 180) % 360 - 180)
    return f"S{base + (1 if near_180 else 0)}"


def epochs_block(P: p1.Probe) -> list[dict[str, Any]]:
    rows = []
    for e in P.epochs:
        mids = [im.t_mid_mjd for x in e.exposures for im in x.images]
        mjd = float(np.mean(mids))
        pa = epoch_pa(P, e)
        rows.append(
            {
                "index": e.index,
                "label": month_label(mjd),
                "survey": survey_name(e.survey_year, pa),
                "year": e.survey_year,
                "pa": pa,
                "start": p1.date(e.t_start_mjd),
                "end": p1.date(e.t_end_mjd),
                "mjd_mid": rnd(mjd, 4),
                "n_exposures": len(e.exposures),
                "detectors": {str(d): int(n) for d, n in sorted(e.detector_counts.items())},
                "full": bool(e.full),
            }
        )
    dup = Counter(r["label"] for r in rows)
    for r in rows:
        if dup[r["label"]] > 1:
            r["label"] = day_label(r["mjd_mid"])
    return rows


def _rms(a: float | None, b: float | None) -> float | None:
    if a is None or b is None or not (math.isfinite(a) and math.isfinite(b)):
        return None
    return math.sqrt(0.5 * (a * a + b * b))


def _crit(P: p1.Probe, prefix: str) -> dict[str, Any] | None:
    return next((c for c in P.summary.get("criteria", []) if c["name"].startswith(prefix)), None)


def motion_block(P: p1.Probe, epochs: list[dict[str, Any]]) -> dict[str, Any] | None:
    slug, ast = P.key, P.ast
    mjds = np.array([e["mjd_mid"] for e in epochs], float)
    pra, pdec = propagate.apparent_position(ast, mjds)
    path = [[rnd(a, 7), rnd(b, 7)] for a, b in zip(np.atleast_1d(pra), np.atleast_1d(pdec), strict=True)]
    m = P.summary.get("motion") or {}
    cat_source = "Kirkpatrick et al. 2021 (Spitzer)" if slug == "wise-0855" else "Gaia DR3"
    if P.cfg["motion"] == "coadd":
        plist = getattr(P, "_coadd_positions", {}).get("model") or []
        positions = [
            {
                "epoch": int(p.label.split()[-1]),
                "mjd": p.mjd,
                "ra": p.ra_deg,
                "dec": p.dec_deg,
                "err_mas": _rms(p.ra_err_mas, p.dec_err_mas),
            }
            for p in plist
        ]
        block = m.get("pm_fit_model") or {}
        method = (
            "Per-epoch D5+D6 co-adds; Gaussian PSF fit with the static CatWISE2020 neighbours modelled; "
            "errors from a bootstrap over exposures; parallax removed in the fit"
        )
    else:
        block = m.get("primary") or {}
        positions = [
            {
                "epoch": int(p["label"].split()[-1]),
                "mjd": p["mjd"],
                "ra": p["ra_deg"],
                "dec": p["dec_deg"],
                "err_mas": _rms(p["ra_err_mas"], p["dec_err_mas"]),
            }
            for p in block.get("epoch_positions", [])
        ]
        dets = "+".join(f"D{d}" for d in P.cfg["motion_dets"]) if len(P.cfg["motion_dets"]) < 6 else "D1-D6"
        method = (
            f"Per-exposure ePSF position fits ({dets}, S/N >= {p1.SNR_MIN_POSITION:g}, "
            f"{p1.ASTROMETRIC_FLOOR_MAS:g} mas floor); sigma-clipped linear fit with parallax removed"
        )
    f, cmp_ = block.get("fit"), block.get("comparison")
    if not f or not cmp_:
        return {
            "method": method,
            "epoch_positions": [],
            "fit": None,
            "catalog": None,
            "predicted_path": path,
            "verdict": "fail",
            "verdict_text": "Too few usable positions for a fit.",
        }
    fit = {
        "pmra": rnd(f["pmra_masyr"], 1),
        "pmdec": rnd(f["pmdec_masyr"], 1),
        "pmra_err": rnd(f["pmra_err_masyr"], 1),
        "pmdec_err": rnd(f["pmdec_err_masyr"], 1),
        "total_arcsec_yr": rnd(f["total_masyr"] / 1000.0, 4),
        "total_err": rnd(f["total_err_masyr"] / 1000.0, 4),
        "pa_deg": rnd(f["pa_deg"], 2),
    }
    cat_pm = block.get("catalog_local_pm_masyr") or [ast.pmra_masyr, ast.pmdec_masyr]
    catalog = {
        "pmra": rnd(cat_pm[0], 1),
        "pmdec": rnd(cat_pm[1], 1),
        "total_arcsec_yr": rnd(cmp_["total_cat_masyr"] / 1000.0, 4),
        "pa_deg": rnd(cmp_["pa_cat_deg"], 2),
        "source": cat_source,
    }
    verdict, text = motion_verdict(P, f, cmp_, positions, epochs)
    return {
        "method": method,
        "epoch_positions": [
            {
                "epoch": p["epoch"],
                "mjd": rnd(p["mjd"], 4),
                "ra": rnd(p["ra"], 7),
                "dec": rnd(p["dec"], 7),
                "err_mas": rnd(p["err_mas"], 1),
            }
            for p in positions
        ],
        "fit": fit,
        "catalog": catalog,
        "predicted_path": path,
        "verdict": verdict,
        "verdict_text": text,
    }


def _label_of(epochs: list[dict[str, Any]], index: int) -> str:
    return next((e["label"] for e in epochs if e["index"] == index), f"epoch {index}")


def motion_verdict(
    P: p1.Probe,
    f: dict[str, Any],
    c: dict[str, Any],
    positions: list[dict[str, Any]],
    epochs: list[dict[str, Any]],
) -> tuple[str, str]:
    slug = P.key
    tot, err, pa = f["total_masyr"] / 1000.0, f["total_err_masyr"] / 1000.0, f["pa_deg"]
    cat, pac, ratio, dpa = c["total_cat_masyr"] / 1000.0, c["pa_cat_deg"], c["ratio"], c["pa_diff_deg"]
    if slug in ("barnards-star", "eps-indi-b"):
        crits = [x for x in P.summary["criteria"] if "proper" in x["name"]]
        ok = bool(crits) and all(x["pass"] for x in crits)
        disp = (P.summary["motion"]["primary"] or {}).get("displacement") or {}
        meas = disp.get("measured") or {}
        span = ""
        if meas:
            a = _label_of(epochs, int(disp["from_epoch"].split()[-1]))
            b = _label_of(epochs, int(disp["to_epoch"].split()[-1]))
            span = f" Between {a} and {b} it moved {meas['sep_arcsec']:.1f}″, as predicted to within {abs(disp['ratio'] - 1) * 100:.1f}%."
        text = (
            f"SPHEREx measures {tot:.2f} ± {err:.2f}″ per year toward PA {pa:.0f}°; {('Gaia DR3')} predicts "
            f"{cat:.2f}″ per year toward PA {pac:.0f}°: the speed agrees within {abs(ratio - 1) * 100:.1f}%."
            + span
        )
        if slug == "barnards-star":
            text += (
                f" The direction is {abs(dpa):.0f}° off because the saturated core biases the east-west "
                "positions (the north-south motion agrees closely)."
            )
        else:
            text += f" The direction agrees within {abs(dpa):.1f}°."
        return ("pass" if ok else "partial"), text
    if slug == "wise-0855":
        sh = P.summary["motion"].get("shift_model") or {}
        meas, pred = sh.get("measured") or {}, sh.get("predicted") or {}
        crits = [
            x
            for x in P.summary["criteria"]
            if x["name"].startswith("shift") and "neighbour modelled" in x["name"]
        ]
        ok = bool(crits) and all(x["pass"] for x in crits)
        a = _label_of(epochs, int(sh.get("from", "epoch 0").split()[-1]))
        b = _label_of(epochs, int(sh.get("to", "epoch 0").split()[-1]))
        text = (
            f"Between {a} and {b} the faint spot moved {meas.get('sep_arcsec', math.nan):.1f} ± "
            f"{meas.get('sep_err_arcsec', math.nan):.1f}″ toward PA {meas.get('pa_deg', math.nan):.0f}°; the Spitzer "
            f"astrometry predicts {pred.get('sep_arcsec', math.nan):.1f}″ toward PA {pred.get('pa_deg', math.nan):.0f}°. "
            f"A static source is rejected at {meas.get('n_sigma', math.nan):.0f}σ. Positions come from D5+D6 co-adds "
            "with the catalogued neighbour 4–11″ away modelled; the detection itself is weak (S/N about 8 per epoch)."
        )
        return ("pass" if ok else "partial"), text
    if slug == "rw-aur":
        cr = _crit(P, "proper-motion null test")
        comp = ((cr or {}).get("value") or {}).get("companion_rw_aur_b") or {}
        best = (P.summary.get("variability", {}).get("first_to_last", {}) or {}).get("best") or {}
        text = (
            f"The fit gives {tot:.2f} ± {err:.2f}″ per year toward PA {pa:.0f}°, but Gaia DR3 says RW Aur A moves only "
            f"{cat:.3f}″ per year. This is not real motion: RW Aur B, {comp.get('sep_mas', 1520) / 1000:.1f}″ away at "
            f"PA {comp.get('pa_deg', 74):.0f}°, is unresolved by SPHEREx, and as A faded (by "
            f"{best.get('dmag', math.nan):.2f} mag at 3.8–4.4 µm) the combined light centre slid toward B. "
            "Astronomers call this variability-induced motion."
        )
        return "fail", text
    # r-dra
    chi2 = f.get("chi2_red") or math.nan
    text = (
        f"R Dra barely moves ({cat * 1000:.0f} mas per year in Gaia DR3). The apparent {tot:.1f} ± {err:.1f}″ per "
        f"year from saturated-core positions (χ²/dof {chi2:.0f}) is an artefact of saturation, not motion: R Dra is "
        "here for its brightness changes."
    )
    return "fail", text


def spectrum_block(P: p1.Probe) -> dict[str, Any]:
    pts = [
        p
        for p in P.points()
        if all(math.isfinite(v) for v in (p.wavelength_um, p.bandwidth_um, p.flux_ujy, p.flux_err_ujy))
    ]
    points = [
        {
            "wl_um": rnd(p.wavelength_um, 4),
            "bw_um": rnd(p.bandwidth_um, 4),
            "flux_ujy": rnd(p.flux_ujy, 3),
            "err_ujy": rnd(p.flux_err_ujy, 3),
            "epoch": int(p.epoch_index),
            "detector": int(p.detector),
            "saturated": bool(p.saturated),
        }
        for p in sorted(pts, key=lambda p: (p.wavelength_um, p.mjd))
    ]
    cs = getattr(P, "cube", None)
    quick = None
    if cs is not None:
        quick = {
            "wl_um": [rnd(v, 4) for v in cs["wavelength_um"]],
            "flux_ujy": [rnd(v, 3) for v in cs["flux_ujy"]],
            "label": str(cs.get("label", "DR1 quick-look")),
        }
    n_sat = sum(p["saturated"] for p in points)
    notes = [
        (
            "Each point is one exposure: forced photometry at the catalogue position (ePSF fit, or a fit to the PSF "
            "wings when the core is saturated)."
        ),
        "Saturated points are shown hollow and excluded from fits.",
    ]
    if n_sat:
        notes.append(f"{n_sat} of {len(points)} points are saturated (OVERFLOW in the core).")
    if quick is not None:
        notes.append(
            "The quick-look curve is the Year-1 spectral cube at 12.9″ pixels: it blends close neighbours, and "
            "channels where the star saturates are left empty."
        )
    return {"points": points, "quicklook": quick, "notes": notes}


def variability_block(P: p1.Probe) -> dict[str, Any] | None:
    """Variability in the target's best detector.

    R Dra (near-daily deep-field epochs sample every channel): chi2 and largest change of the full-epoch means.
    Others (two visits a year sample different channels): first vs last full epoch at matched wavelengths
    (phase1_probe.matched_variability), because detector means mix channels differently in each epoch.
    """
    d = BEST_DETECTOR[P.key]
    if P.key == "r-dra":
        full = {e.index for e in P.epochs if e.full}
        rows = [
            r
            for r in P.summary.get("epoch_photometry") or []
            if r.get("detector") == d and r.get("epoch_index") in full and r.get("flux_ujy")
        ]
        v = lightcurve.variability_significance(rows)
        c = _crit(P, "full light curve")
        if v.get("chi2_red") is None:
            return None
        return {
            "chi2_dof": rnd(v["chi2_red"], 3),
            "max_delta_mag": rnd(v["max_delta_mag"], 4),
            "significant": bool(c and c["pass"]),
        }
    ftl = P.summary.get("variability", {}).get("first_to_last", {}) or {}
    best = (ftl.get("per_detector") or {}).get(f"D{d}") or ftl.get("best")
    if not best:
        return None
    if P.key == "barnards-star":
        significant = (
            False  # the control star: its epoch-to-epoch changes measure saturated-photometry systematics
        )
    elif P.key == "rw-aur":
        c = _crit(P, "brightness change")
        significant = bool(c and c["pass"])
    else:  # the a-priori RW Aur threshold
        significant = abs(best["dmag"]) > 0.2 and (best.get("n_sigma") or 0) > 5
    return {
        "chi2_dof": rnd(best.get("chi2_red"), 3),
        "max_delta_mag": rnd(abs(best["dmag"]), 4),
        "significant": bool(significant),
    }


def lightcurve_block(P: p1.Probe) -> dict[str, Any]:
    rows = []
    for r in P.summary.get("epoch_photometry") or []:
        if r.get("flux_ujy") is None or r.get("ab_mag") is None or r.get("epoch_index") is None:
            continue
        rows.append(
            {
                "epoch": int(r["epoch_index"]),
                "detector": int(r["detector"]),
                "mjd": rnd(r["mjd_mean"], 4),
                "flux_ujy": rnd(r["flux_ujy"], 3),
                "err_ujy": rnd(r["flux_err_ujy"], 3),
                "mag_ab": rnd(r["ab_mag"], 4),
                "wl_um": rnd(r["wavelength_um"], 4),
                "saturated_frac": rnd(r.get("saturated_fraction") or 0.0, 3),
            }
        )
    same: list[dict[str, Any]] = []
    if P.key == "r-dra":  # near-daily deep-field cadence: one SPHEREx channel followed through time
        from pxh.photometry import spectrum as spec_mod

        d = BEST_DETECTOR[P.key]
        pts = [p for p in P.points([d]) if math.isfinite(p.flux_ujy) and p.flux_ujy > 0]
        chans = Counter(
            spec_mod.channel_index(d, p.wavelength_um) for p in pts if math.isfinite(p.wavelength_um)
        )
        chans.pop(None, None)
        if chans:
            ch = chans.most_common(1)[0][0]
            sel = [p for p in pts if spec_mod.channel_index(d, p.wavelength_um) == ch]
            wl = float(np.median([p.wavelength_um for p in sel]))
            series = lightcurve.same_channel_series(pts, wl, detector=d)
            same = [
                {
                    "mjd": rnd(p.mjd, 4),
                    "flux_ujy": rnd(p.flux_ujy, 3),
                    "err_ujy": rnd(p.flux_err_ujy, 3),
                    "wl_um": rnd(p.wavelength_um, 4),
                }
                for p in series
            ]
    return {"epoch_photometry": rows, "same_channel": same, "variability": variability_block(P)}


def _fmt_check(name: str, v: Any) -> str:
    """Human-readable value of one Phase 1 criterion."""
    try:
        if "proper motion total" in name:
            return (
                f"{v['pm_total_masyr'] / 1000:.2f} ± {v['pm_err_masyr'] / 1000:.2f}″/yr vs "
                f"{v['catalog_masyr'] / 1000:.2f}″/yr (ratio {v['ratio']:.3f})"
            )
        if "proper-motion PA" in name:
            return f"ΔPA = {float(v):+.1f}°"
        if name.startswith("blink/difference"):
            return (
                f"{v['sep_arcsec']:.1f}″ toward PA {v['pa_deg']:.0f}° in {v['dt_days']:.0f} d "
                f"({v['rate_arcsec_yr']:.2f}″/yr; {v['ratio_to_prediction']:.3f} × prediction)"
            )
        if name.startswith("saturated core"):
            return (
                f"{v['exposures_saturated']} of {v['exposures_measured']} exposures saturated; core masked or "
                f"flagged in {v['frames_core_masked_or_flagged']} of {v['frames']} Phase 1 co-adds"
            )
        if "position scatter" in name:
            return f"radial RMS {v['radial']:.0f} mas (RA {v['ra']:.0f}, Dec {v['dec']:.0f})"
        if name.startswith("T-dwarf"):
            return f"depth {v['depth'] * 100:.0f}% at {v['significance']:.0f}σ"
        if name.startswith("detected at S/N") and "PSF" in name:
            return "PSF S/N " + ", ".join(f"E{k} {s:.1f}" for k, s in v["psf_snr"].items())
        if name.startswith("detected at S/N"):
            ap = ", ".join(f"E{k} {s:.1f}" for k, s in v["coadd_aperture_snr"].items())
            fo = ", ".join(f"E{k} {s:.0f}" for k, s in v["forced_ivw_snr"].items())
            return f"aperture S/N {ap} (per-exposure forced photometry combined: {fo})"
        if name.startswith("not detected") and "PSF" in name:
            return f"largest |S/N| {max(abs(s) for s in v.values() if s is not None):.1f}"
        if name.startswith("not detected"):
            worst = max(((k, s[0]) for k, s in v.items() if s[0] is not None), key=lambda kv: abs(kv[1]))
            return (
                f"largest aperture S/N {worst[1]:.1f} ({worst[0]}): the 2 px aperture contains a neighbour "
                "that is bright in D1–D4"
            )
        if "rejects a static source" in name:
            return f"{v['sep_arcsec']:.2f} ± {v['sep_err_arcsec']:.2f}″ ({v['n_sigma_vs_static']:.1f}σ)"
        if name.startswith("shift within"):
            return (
                f"{v['sep_arcsec']:.2f}″ toward PA {v['pa_deg']:.1f}° vs predicted {v['predicted_sep_arcsec']:.2f}″ "
                f"toward {v['predicted_pa_deg']:.1f}°"
            )
        if name.startswith("proper-motion null test"):
            comp = v.get("companion_rw_aur_b") or {}
            return (
                f"{v['pm_total_masyr'] / 1000:.2f} ± {v['pm_err_masyr'] / 1000:.2f}″/yr "
                f"({v['n_sigma_from_zero']:.1f}σ from zero) toward PA {v['pa_deg']:.0f}°: the unresolved "
                f"companion lies at PA {comp.get('pa_deg', math.nan):.0f}°, so this is a variability-induced "
                "photocentre shift, not motion"
            )
        if name.startswith("brightness change"):
            b = v["best"]
            return (
                f"{b['dmag']:+.2f} ± {b['err']:.2f} mag in {b['detector']} at {b['lambda_um'][0]:.2f}–"
                f"{b['lambda_um'][1]:.2f} µm ({b['n_sigma']:.0f}σ; positive = fading)"
            )
        if name.startswith("100% of exposures"):
            return f"{v['saturated']} of {v['measured']} exposures saturated"
        if name.startswith("brightness of the wide-survey epochs"):
            return "epoch order: " + ", ".join(f"E{w['epoch']} {w['mean_dmag']:+.2f} mag" for w in v)
        if name.startswith("full light curve"):
            return (
                f"amplitude {v['amplitude_mag']:.2f} ± {v['amp_err']:.2f} mag ({v['amp_snr']:.0f}σ), maximum at "
                f"phase {((v['phase_max'] + 0.5) % 1.0) - 0.5:+.2f}, {v['n_points']} points"
            )
    except (KeyError, TypeError, ValueError) as exc:
        log.warning("check %r: cannot format value (%r)", name, exc)
    return json.dumps(v)[:200]


def checks_block(P: p1.Probe) -> list[dict[str, Any]]:
    out = []
    for c in P.summary.get("criteria", []):
        value = _fmt_check(c["name"], c["value"])
        if c.get("notes") and "chosen after the run" in c["notes"]:
            value += " (robustness variant chosen after the first run; the a-priori ring is the criterion of record)"
        out.append({"name": c["name"], "value": value, "pass": bool(c["pass"])})
    return out


def warnings_block(P: p1.Probe, frames: dict[tuple[int, int], Frame]) -> list[str]:
    pts = P.points()
    n_sat = sum(p.saturated for p in pts)
    out = []
    if n_sat:
        out.append(
            f"Saturated (OVERFLOW) in {n_sat} of {len(pts)} exposures. Saturated pixels are kept in the images and "
            "outlined in the flags overlay; their brightness comes from fits to the PSF wings."
        )
    cmp_ = ((P.summary.get("motion") or {}).get("primary") or {}).get("comparison") or {}
    fit_ = ((P.summary.get("motion") or {}).get("primary") or {}).get("fit") or {}
    if P.key == "barnards-star":
        dpa = cmp_.get("pa_diff_deg", 0.0)
        out.append(
            f"The saturated core biases the east-west positions: the measured direction is {abs(dpa):.0f}° "
            f"{'west' if dpa < 0 else 'east'} of Gaia's while the speed agrees."
        )
        var = (P.summary.get("variability", {}).get("first_to_last", {}) or {}).get("per_detector", {})
        big = max((abs(x["dmag"]) for x in var.values()), default=0.0)
        out.append(
            f"Barnard's Star is the control star: epoch-to-epoch changes of up to {big:.1f} mag in the saturated "
            "photometry are systematics, not variability."
        )
    elif P.key == "eps-indi-b":
        out.append(
            "Epsilon Indi Ba and Bb (about 0.7″ apart) are unresolved: SPHEREx measures their combined light and "
            "photocentre."
        )
        out.append(
            "The bright star Epsilon Indi A lies just beyond the right (west) edge: its glow, and probably the "
            "ring-shaped ghost north of the target, show in the long-wavelength frames. The October 2025 D5 and D6 "
            "co-adds also show a faint streak "
            "running south-east from the target that appears in no other epoch: an unflagged artefact or a faint "
            "moving object, not the brown dwarfs."
        )
    elif P.key == "wise-0855":
        out.append(
            "Faint: S/N about 8 per epoch in the D5+D6 co-adds, below the a-priori 10. Invisible in D1–D4."
        )
        out.append(
            "Blending: a catalogued star (W2 = 15.2) 4–11″ away overlaps it at SPHEREx resolution; it was modelled "
            "in the position fits, and dominates the D1–D4 images."
        )
    elif P.key == "rw-aur":
        out.append(
            "Variability-induced motion (VIM): RW Aur A and B (1.5″ apart) are unresolved, so the light centre moves "
            "toward B whenever A fades. The fitted proper motion is this shift, not motion of the star."
        )
        out.append("Blending: the A+B pair is measured as one source in every detector.")
    elif P.key == "r-dra":
        out.append(
            "Too bright for SPHEREx: the core saturates in every exposure, so brightness comes from the PSF wings "
            "and the light curve is relative."
        )
        out.append(
            f"Positions from saturated cores are biased (apparent {fit_.get('total_masyr', math.nan) / 1000:.1f}″/yr, "
            f"χ²/dof {fit_.get('chi2_red') or math.nan:.0f}); R Dra's real motion is "
            f"{cmp_.get('total_cat_masyr', math.nan) / 1000:.2f}″/yr."
        )
    n_partial = sum(not e.full for e in P.epochs)
    if n_partial:
        out.append(
            f"{n_partial} of {len(P.epochs)} epochs are partial (fewer than "
            f"{config.FULL_EPOCH_MIN_PER_DETECTOR} images per detector): shown greyed out."
        )
    return out


def links_block(P: p1.Probe, target: Any) -> list[dict[str, str]]:
    from urllib.parse import quote_plus

    sid = target.simbad_id if target and target.simbad_id else P.name
    links = [
        {"label": "SIMBAD", "url": f"https://simbad.cfa.harvard.edu/simbad/sim-id?Ident={quote_plus(sid)}"}
    ]
    if P.ast.source.startswith("Gaia DR3"):
        links.append(
            {
                "label": f"Gaia archive ({P.ast.source.split(' (')[0]})",
                "url": "https://gea.esac.esa.int/archive/",
            }
        )
    if P.key == "wise-0855":
        links.append(
            {
                "label": "Kirkpatrick et al. 2021 (astrometry)",
                "url": "https://ui.adsabs.harvard.edu/abs/2021ApJS..253....7K",
            }
        )
    links.append({"label": "IRSA SPHEREx", "url": "https://irsa.ipac.caltech.edu/Missions/spherex.html"})
    links.append({"label": "WISE at IRSA", "url": "https://irsa.ipac.caltech.edu/Missions/wise.html"})
    return links


def credits_text(P: p1.Probe) -> str:
    astro = (
        "Astrometry: Kirkpatrick et al. 2021 (Spitzer)."
        if P.key == "wise-0855"
        else "Gaia DR3: ESA/Gaia/DPAC."
    )
    return (
        "SPHEREx data: NASA/JPL-Caltech, IRSA (doi:10.26131/IRSA678, IRSA662). "
        f"{astro} AllWISE: NASA/JPL-Caltech/UCLA."
    )


# --- the bundle ------------------------------------------------------------------------------------------------


def build_bundle(slug: str, workers: int) -> dict[str, Any]:
    P = run_analysis(slug, workers)
    plan = FieldPlan(P)
    stamps = plan.read_all(workers)
    check_phot_mask(list(stamps.values()))
    frames = coadd_epochs(plan, stamps)
    out = BUNDLES / slug
    fdir = out / "frames"
    if fdir.exists():
        shutil.rmtree(fdir)
    fdir.mkdir(parents=True)
    epochs = epochs_block(P)
    by_index = {e["index"]: e for e in epochs}
    best = BEST_DETECTOR[slug]

    # Blink frames: one stretch per detector, shared by every epoch.
    frames_epoch: dict[str, list[dict[str, Any]]] = {f"D{d}": [] for d in range(1, 7)}
    limits: dict[int, tuple[float, float]] = {}
    for d in range(1, 7):
        keys = sorted(k for k in frames if k[1] == d)
        if not keys:
            continue
        limits[d] = render.shared_limits([frames[k] for k in keys], percentiles=STRETCH_PERCENTILES)
        for k in keys:
            fr = frames[k]
            name = f"frames/D{d}_E{k[0]}.png"
            (out / name).write_bytes(grey_png(frame_values(fr), *limits[d], stretch="asinh"))
            # The detector's band (SIA em_min/em_max of the images used): the Lab shows it as the detector range.
            sts = fr.meta["stamps"]
            wl = [min(st.image.em_min_um for st in sts), max(st.image.em_max_um for st in sts)]
            frames_epoch[f"D{d}"].append(
                {
                    "epoch": k[0],
                    "url": name,
                    "mjd": rnd(fr.mjd_mid, 4),
                    "n": fr.n_inputs,
                    "wl_um": [rnd(wl[0], 3), rnd(wl[1], 3)],
                }
            )
    # False colour: D6, D3, D1 as red, green, blue. Each channel keeps its detector's shared upper limit, with
    # the black point at the detector's median sky (all epochs), so noisier channels do not tint the background.
    rgb = []
    rgb_limits = {}
    for d in RGB_CHANNELS:
        if d in limits:
            vals = np.concatenate([frame_values(frames[k]).ravel() for k in frames if k[1] == d])
            rgb_limits[d] = (float(np.nanmedian(vals)), limits[d][1])
    for e in sorted({k[0] for k in frames}):
        if not all((e, d) in frames for d in RGB_CHANNELS):
            continue
        fr3 = [frames[(e, d)] for d in RGB_CHANNELS]
        name = f"frames/RGB_E{e}.png"
        (out / name).write_bytes(
            rgb_png([frame_values(f) for f in fr3], [rgb_limits[d] for d in RGB_CHANNELS])
        )
        rgb.append(
            {
                "epoch": e,
                "url": name,
                "mjd": rnd(float(np.mean([f.mjd_mid for f in fr3])), 4),
                "channels": "/".join(f"D{d}" for d in RGB_CHANNELS),
            }
        )
    frames_epoch["rgb"] = rgb

    # Differences: last minus first full epoch, per detector, in sigma (best detector first).
    diffs = []
    for d in [best] + [x for x in range(1, 7) if x != best]:
        keys = sorted(k for k in frames if k[1] == d and by_index[k[0]]["full"])
        if len(keys) < 2:
            continue
        a, b = frames[keys[-1]], frames[keys[0]]
        dfr = diff_mod.difference(a, b, normalize=True)
        _, hi = render.shared_limits([dfr], percentiles=(0.5, 99.5), symmetric=True)
        lim = nice_limit(max(DIFF_MIN_LIMIT, hi))
        name = f"frames/DIFF_D{d}_E{keys[-1][0]}-E{keys[0][0]}.png"
        (out / name).write_bytes(difference_png(frame_values(dfr), lim))
        diffs.append(
            {
                "detector": f"D{d}",
                "a": keys[-1][0],
                "b": keys[0][0],
                "url": name,
                "units": "sigma",
                "limits": [-lim, lim],
            }
        )

    # Flags overlays for the best detector.
    flags_out = []
    for k in sorted(k for k in frames if k[1] == best):
        sat_f, art_f = flag_fraction_maps(plan, frames[k].meta["stamps"])
        name = f"frames/FLAGS_D{best}_E{k[0]}.png"
        (out / name).write_bytes(flags_png(sat_f, art_f))
        flags_out.append(
            {
                "detector": f"D{best}",
                "epoch": k[0],
                "url": name,
                "legend": {"saturated": SATURATED_COLOR, "artifact": ARTIFACT_COLOR},
            }
        )

    # Then vs Now: AllWISE W2 and the latest full D6 epoch, the same percentile stretch for both.
    then_now = []
    d6_full = sorted(k for k in frames if k[1] == 6 and by_index[k[0]]["full"])
    wise_meta: dict[str, Any] | None = None
    if d6_full:
        try:
            wise, wise_meta = wise_on_grid(plan)
        except Exception as exc:  # noqa: BLE001 - the bundle is still useful without it
            log.error("%s: AllWISE W2 unavailable: %r", slug, exc)
            wise = None
        if wise is not None and np.isfinite(wise).sum() > 0.5 * wise.size:
            now = frames[d6_full[-1]]
            wmjd = wise_meta["mjd"]
            for img, name in (
                (wise, "frames/WISE_W2.png"),
                (frame_values(now), f"frames/NOW_D6_E{d6_full[-1][0]}.png"),
            ):
                lo, hi = render.shared_limits([img], percentiles=STRETCH_PERCENTILES)
                (out / name).write_bytes(grey_png(img, lo, hi, stretch="asinh"))
            lo_um, hi_um = next(f["wl_um"] for f in frames_epoch["D6"] if f["epoch"] == d6_full[-1][0])
            then_now = [
                {
                    "label": f"WISE {datetime.fromisoformat(ep.mjd_to_iso(wmjd)).year}",
                    "url": "frames/WISE_W2.png",
                    "mjd": rnd(wmjd, 2),
                    "instrument": "AllWISE W2 4.6 µm",
                },
                {
                    "label": f"SPHEREx {datetime.fromisoformat(ep.mjd_to_iso(now.mjd_mid)).year}",
                    "url": f"frames/NOW_D6_E{d6_full[-1][0]}.png",
                    "mjd": rnd(now.mjd_mid, 4),
                    "instrument": f"SPHEREx D6 {lo_um:.2f}–{hi_um:.2f} µm",
                },
            ]

    target = TARGETS.get(slug)
    ft = frontend_targets()[slug]
    ast = P.ast
    used_images = [i.image for i in P.items if i.ok] + [s.image for s in stamps.values()]
    collections = sorted({im.collection for im in used_images})
    tags = sorted({im.file_tag for im in used_images if im.file_tag})
    # release lists the SPHEREx collections only (the UI reads it as "SPHEREx <collections> from IRSA"); the
    # AllWISE tiles are named in frames.then_vs_now and in credits.
    manifest = {
        "schema": SCHEMA,
        "generated_at": iso_now(),
        "source": "bundle",
        "target": {
            "key": slug,
            "name": ft["name"],
            "kind": ft["kind"],
            "aliases": list(target.aliases) if target else [],
            "simbad_id": target.simbad_id if target else "",
            "summary_plain": ft["summary"],
            "facts": ft["facts"],
            "astrometry": {
                "ra": ast.ra_deg,
                "dec": ast.dec_deg,
                "ref_epoch": ast.ref_epoch,
                "pmra": ast.pmra_masyr,
                "pmdec": ast.pmdec_masyr,
                "parallax": ast.parallax_mas,
                "rv": ast.rv_kms,
                "source": ast.source,
            },
        },
        "center": {"ra": rnd(plan.ra, 7), "dec": rnd(plan.dec, 7), "epoch_mjd": rnd(plan.mjd_mid, 3)},
        "fov_arcmin": rnd(plan.n * config.PIXEL_SCALE_ARCSEC / 60.0, 3),
        "release": {
            "collections": collections,
            "file_tags": tags,
            "latest_obs": p1.date(max(im.t_max_mjd for im in used_images)),
            "discovered_at": P.summary["run"]["started_utc"],
        },
        "grid": {
            "width": plan.n,
            "height": plan.n,
            "pixscale_arcsec": rnd(align.pixel_scale_arcsec(plan.gw), 4),
            "wcs": render.wcs_to_aladin(plan.gw, plan.shape),
        },
        "epochs": epochs,
        "frames": {"epoch": frames_epoch, "then_vs_now": then_now, "difference": diffs, "flags": flags_out},
        "render": {
            "stretch": "asinh",
            "note": (
                "One asinh stretch per detector (0.5-99.7 percentiles of all its epochs), shared by every epoch, so "
                "brightness changes between frames are real. Co-adds: IMAGE minus ZODI, official photometry mask "
                "0x3C028E44 rejected, OVERFLOW kept and flagged, then an inverse-variance mean after 3-sigma "
                "clipping (drops single-exposure streaks). Then vs Now: each image "
                "stretched by its own 0.5-99.7 percentiles. Differences: S/N, linear between the limits."
            ),
        },
        "motion": motion_block(P, epochs),
        "spectrum": spectrum_block(P),
        "lightcurve": lightcurve_block(P),
        "checks": checks_block(P),
        "warnings": warnings_block(P, frames),
        "links": links_block(P, target),
        "credits": credits_text(P),
    }
    n_blink = len({k[0] for k in frames})
    if len(rgb) < n_blink:
        manifest["warnings"].append(
            f"False colour exists for {len(rgb)} of {n_blink} epochs: it needs D1, D3 and D6 in the same epoch"
            + (", and the deep-field visits sample one detector pair at a time." if P.key == "r-dra" else ".")
        )
    if len(plan.blink) < len(P.epochs):
        manifest["warnings"].append(
            f"Blink frames show {len(plan.blink)} of the {len(P.epochs)} epochs (those with the most exposures, at most "
            f"{MAX_STAMPS_PER_EPOCH_DET} exposures per detector each); the light curve and spectrum use all of them."
        )
    (out / "manifest.json").write_text(
        json.dumps(p1.jsonable(manifest), indent=1, ensure_ascii=False, allow_nan=False) + "\n",
        encoding="utf-8",
    )
    size = sum(p.stat().st_size for p in out.rglob("*") if p.is_file())
    log.info("%s: %d frames, %.2f MB", slug, len(list(fdir.glob("*.png"))), size / 1e6)
    return manifest


# --- contact sheets (visual check of a written bundle) --------------------------------------------------------

# The frontend's diverging map (frontend/src/components/lab/diverging.ts), for previewing difference frames.
_DIVERGING = (
    (-1, (158, 176, 255)),
    (-0.6, (62, 120, 196)),
    (-0.25, (24, 52, 80)),
    (0, (14, 13, 12)),
    (0.25, (74, 22, 12)),
    (0.6, (176, 70, 50)),
    (1, (255, 172, 160)),
)


def _diverging_rgb(grey: np.ndarray) -> np.ndarray:
    t = (grey.astype(float) - 127.5) / 127.5
    xs = np.array([s for s, _ in _DIVERGING])
    cs = np.array([c for _, c in _DIVERGING], float)
    return np.stack([np.interp(t, xs, cs[:, k]) for k in range(3)], axis=-1).round().astype(np.uint8)


def contact_sheet(slug: str, out_dir: Path, scale: int = 2) -> Path:
    """One PNG per bundle: every frame with the catalogue position at its date (circle) and a label."""
    from PIL import ImageDraw

    m = json.loads((BUNDLES / slug / "manifest.json").read_text(encoding="utf-8"))
    w = WCS(naxis=2)
    cards = m["grid"]["wcs"]
    w.wcs.ctype = [cards["CTYPE1"], cards["CTYPE2"]]
    w.wcs.crval = [cards["CRVAL1"], cards["CRVAL2"]]
    w.wcs.crpix = [cards["CRPIX1"], cards["CRPIX2"]]
    w.wcs.cd = [[cards["CD1_1"], cards["CD1_2"]], [cards["CD2_1"], cards["CD2_2"]]]
    shape = (m["grid"]["height"], m["grid"]["width"])
    t = TARGETS[slug].astrometry

    def marks(mjd: float) -> list[tuple[float, float, tuple[int, int, int]]]:
        ra, dec = propagate.apparent_position(t, mjd)
        col, row = render.world_to_png_pixel(w, shape, float(ra), float(dec))
        return [(col, row, (255, 220, 60))]

    def tile(
        url: str, label: str, mjd: float | None, overlay: str | None = None, diverging: bool = False
    ) -> Image.Image:
        raw = (BUNDLES / slug / url).read_bytes()
        if diverging:
            g = np.asarray(Image.open(io.BytesIO(raw)).convert("L"))
            raw = encode_png(_diverging_rgb(g))
        ov = (BUNDLES / slug / overlay).read_bytes() if overlay else None
        png = p1.compose_png(raw, ov, scale=scale, label=label, marks=marks(mjd) if mjd else ())
        return Image.open(io.BytesIO(png)).convert("RGB")

    rows: list[list[Image.Image]] = []
    lab = {e["index"]: e["label"] + ("" if e["full"] else " (partial)") for e in m["epochs"]}
    for key in ("D1", "D2", "D3", "D4", "D5", "D6", "rgb"):
        rows.append(
            [tile(f["url"], f"{key} {lab[f['epoch']]}", f["mjd"]) for f in m["frames"]["epoch"].get(key, [])]
        )
    best = {f["epoch"]: f["url"] for f in m["frames"]["flags"]}
    if best:
        det = m["frames"]["flags"][0]["detector"]
        rows.append(
            [
                tile(f["url"], f"{det}+flags {lab[f['epoch']]}", f["mjd"], overlay=best[f["epoch"]])
                for f in m["frames"]["epoch"][det]
                if f["epoch"] in best
            ]
        )
    rows.append(
        [tile(f["url"], f"{f['label']}", f["mjd"]) for f in m["frames"]["then_vs_now"]]
        + [
            tile(d["url"], f"DIFF {d['detector']} ±{d['limits'][1]:g}σ", None, diverging=True)
            for d in m["frames"]["difference"]
        ]
    )
    rows = [r for r in rows if r]
    tw, th = rows[0][0].size
    sheet = Image.new("RGB", (max(len(r) for r in rows) * (tw + 4), len(rows) * (th + 4) + 24), (40, 40, 40))
    for j, r in enumerate(rows):
        for i, im in enumerate(r):
            sheet.paste(im, (i * (tw + 4), 24 + j * (th + 4)))
    ImageDraw.Draw(sheet).text(
        (4, 4),
        f"{slug}: circle = catalogue position at each frame's date "
        "(Then vs Now: at the WISE and SPHEREx dates)",
        fill=(255, 255, 255),
    )
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"{slug}.png"
    sheet.save(path)
    return path


# --- main ----------------------------------------------------------------------------------------------------


def main(argv: Sequence[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--target", action="append", help="slug (repeatable); default: all five")
    ap.add_argument("--stage", choices=("stamps", "all", "sheet"), default="all")
    ap.add_argument("--sheet-dir", type=Path, help="also write contact sheets of the bundles here")
    ap.add_argument("--workers", type=int, default=6)
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
    slugs = args.target or list(SLUGS)
    for slug in slugs:
        if slug not in SLUGS:
            ap.error(f"unknown target {slug!r}")
    for slug in slugs:
        t0 = time.perf_counter()
        if args.stage == "stamps":
            plan = FieldPlan(index_only(slug, args.workers))
            got = plan.read_all(args.workers)
            log.info("%s: %d/%d stamps in %.0f s", slug, len(got), len(plan.items), time.perf_counter() - t0)
            continue
        if args.stage == "all":
            build_bundle(slug, args.workers)
            log.info("%s: bundle built in %.0f s", slug, time.perf_counter() - t0)
        if args.sheet_dir:
            log.info("%s: contact sheet %s", slug, contact_sheet(slug, args.sheet_dir))
    return 0


if __name__ == "__main__":
    sys.exit(main())
