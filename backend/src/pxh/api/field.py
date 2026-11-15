"""Live fields for the API: coverage summaries (SIA only) and per-detector builds (a FieldManifest).

Index (``index_field``): one SIA point search at the field centre over every discovered Level-2 collection
(wide and deep), exposures grouped into epochs (``pxh.spherex.epochs``). At the ecliptic-pole deep fields at
most one exposure per detector pair per UTC day is kept, in epochs of at most 30 days, as in the Phase 1
probe. Each epoch's orientation is the header keyword ``SPS_EPA`` (0 or 180) of its first image: one
byte-range header read per epoch, cached on disk and reused by builds. (The SIA ``s_region`` polygons do not
encode it: their vertex order matched ``SPS_EPA`` for only 55-85% of 1,500 cached files, depending on the
detector.) ``survey`` is then S1/S2 (Year 1, PA 0/180) or S3/S4 (Year 2, PA 0/180).

Build (``build_field``) for one detector, or ``rgb`` (D1/D3/D6 false colour):
1. pick at most ``PXH_MAX_IMAGES_PER_EPOCH`` images per epoch (evenly spread in time) and at most a request
   budget per build (``PXH_MAX_IMAGES`` at 10 arcmin, fewer for wider fields);
2. read each image's byte-range stamp covering the grid (``pxh.spherex.l2``: IBE multi-range requests, at most
   ``config.IRSA_MAX_CONCURRENCY`` in flight) and reproject it at once onto the shared north-up grid
   (``pxh.imaging.align``: zodi subtracted, the file's science mask and OVERFLOW masked), in a thread pool;
3. inverse-variance co-add per epoch, one asinh stretch per detector shared by all epochs, the S/N
   difference last minus first (full epochs preferred), and the saturation holes as an RGBA overlay;
4. every PNG is embedded as a ``data:image/png;base64,...`` URL, so nothing needs storage.

Grids are centred exactly on the requested position (rounded to 1e-5 deg), so the manifests of the six
detectors share one ``grid`` and the client can merge them.
"""

from __future__ import annotations

import base64
import logging
import math
import time
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, wait
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

import numpy as np
from astropy.wcs import WCS
from scipy import ndimage

from pxh import config
from pxh.api.caching import TTLCache
from pxh.api.errors import ApiProblem, archive_unavailable, invalid
from pxh.api.settings import Settings, get_settings
from pxh.imaging import align, render
from pxh.imaging import coadd as coadd_mod
from pxh.imaging import diff as diff_mod
from pxh.models import DetectorImage, Epoch, Exposure, Frame, Stamp
from pxh.spherex import epochs as ep
from pxh.spherex import flags as fl
from pxh.spherex import l2, rangeio, sia

log = logging.getLogger(__name__)

FOV_MIN_ARCMIN = 2.0
FOV_MAX_ARCMIN = 30.0
FOV_DEFAULT_ARCMIN = 10.0
SEARCH_RADIUS_DEG = 0.0005  # SIA point search: images that contain the field centre
DETECTOR_KEYS = ("D1", "D2", "D3", "D4", "D5", "D6")
BUILD_DETS = (*DETECTOR_KEYS, "rgb")
MODES = ("epoch", "difference", "flags")
DEFAULT_MODES = ("epoch", "difference")
RGB_CHANNELS = (6, 3, 1)  # red, green, blue
RGB_LABEL = "D1/D3/D6"
DEEP_MAX_SPAN_DAYS = 30.0
SATURATED_RGB = (242, 137, 90)  # legend colour #f2895a
SATURATED_HEX = "#f2895a"
REQUEST_BUDGET_FOV_ARCMIN = 10.0
DIFF_MIN_LIMIT_SIGMA = 5.0
CREDITS = (
    "SPHEREx data: NASA/JPL-Caltech, from the NASA/IPAC Infrared Science Archive (IRSA): "
    "DR1 (doi:10.26131/IRSA678) and Quick Release 3."
)
ORIENTATION_BUDGET_S = 20.0  # header reads for the epochs' SPS_EPA in one index
_MJD_ZERO = datetime(1858, 11, 17, tzinfo=UTC)

_INDEX_CACHE = TTLCache(maxsize=64, ttl_s=3600.0)
_COADD_CACHE = TTLCache(maxsize=24, ttl_s=6 * 3600.0)
_MANIFEST_CACHE = TTLCache(maxsize=24, ttl_s=6 * 3600.0)


def clear_caches() -> None:
    for cache in (_INDEX_CACHE, _COADD_CACHE, _MANIFEST_CACHE):
        cache.clear()


# --- input --------------------------------------------------------------------------------------------


def normalise_field(ra: float, dec: float, fov: float) -> tuple[float, float, float]:
    """Validated (ra, dec, fov): ra wrapped to [0, 360) and rounded to 1e-5 deg, fov within 2-30 arcmin."""
    for name, value in (("ra", ra), ("dec", dec), ("fov", fov)):
        if not math.isfinite(value):
            raise invalid(f"{name} must be a finite number")
    if not 0.0 <= ra <= 360.0:
        raise invalid(f"ra must be within [0, 360] degrees, got {ra}")
    if not -90.0 <= dec <= 90.0:
        raise invalid(f"dec must be within [-90, 90] degrees, got {dec}")
    if not FOV_MIN_ARCMIN <= fov <= FOV_MAX_ARCMIN:
        raise invalid(
            f"fov must be within {FOV_MIN_ARCMIN:g}-{FOV_MAX_ARCMIN:g} arcmin, got {fov:g} "
            "(larger views use the all-sky HiPS cube)"
        )
    return round(ra % 360.0, 5) % 360.0, round(dec, 5), round(fov, 2)


def parse_modes(text: str | None) -> tuple[str, ...]:
    if text is None or not text.strip():
        return DEFAULT_MODES
    modes = tuple(dict.fromkeys(m.strip().lower() for m in text.split(",") if m.strip()))
    unknown = [m for m in modes if m not in MODES]
    if unknown:
        raise invalid(f"unknown mode(s) {', '.join(unknown)}; use any of {', '.join(MODES)}")
    return modes


def parse_det(text: str | None) -> str:
    value = (text or "D6").strip()
    canon = "rgb" if value.lower() == "rgb" else value.upper()
    if value.lower() == "then_vs_now":
        raise ApiProblem(
            501,
            "not_implemented",
            "then_vs_now (WISE 2010 vs SPHEREx) is not built live yet; curated targets have it in their bundles.",
        )
    if canon not in BUILD_DETS:
        raise invalid(f"det must be one of {', '.join(BUILD_DETS)}, got {value!r}")
    return canon


# --- small helpers ------------------------------------------------------------------------------------


def mjd_to_date(mjd: float) -> str:
    return (_MJD_ZERO + timedelta(days=float(mjd))).strftime("%Y-%m-%d")


def mjd_to_label(mjd: float) -> str:
    return (_MJD_ZERO + timedelta(days=float(mjd))).strftime("%b %Y")


def utc_iso(t: float | None = None) -> str:
    when = datetime.now(UTC) if t is None else datetime.fromtimestamp(t, UTC)
    return when.strftime("%Y-%m-%dT%H:%M:%SZ")


def mjd_now() -> float:
    return (datetime.now(UTC) - _MJD_ZERO).total_seconds() / 86400.0


def data_url(png: bytes) -> str:
    return "data:image/png;base64," + base64.b64encode(png).decode("ascii")


def header_pa(image: DetectorImage) -> int | None:
    """0 or 180: the file's orientation keyword SPS_EPA (header read with byte ranges, cached on disk)."""
    try:
        value = float(l2.read_layout(image).image_header["SPS_EPA"])
    except Exception as exc:  # noqa: BLE001 - unknown orientation is reported, not fatal
        log.info("no SPS_EPA for %s: %r", image.basename, exc)
        return None
    return 180 if abs(((value + 180.0) % 360.0) - 180.0) > 90.0 else 0


def epoch_orientations(epochs: list[Epoch], budget_s: float = ORIENTATION_BUDGET_S) -> dict[int, int | None]:
    """SPS_EPA per epoch from one header each (the epoch's first image), read in parallel within a budget."""
    firsts = {e.index: min((im for x in e.exposures for im in x.images), key=lambda im: (im.t_min_mjd, im.detector))
              for e in epochs if e.exposures}
    if not firsts:
        return {}
    pool = ThreadPoolExecutor(max_workers=min(4, len(firsts)), thread_name_prefix="epa")
    try:
        futures = {pool.submit(header_pa, im): e for e, im in firsts.items()}
        done, _ = wait(futures, timeout=budget_s)
        return {e: (fut.result() if fut in done else None) for fut, e in futures.items()}
    finally:
        pool.shutdown(wait=False, cancel_futures=True)


# --- index (SIA only) ---------------------------------------------------------------------------------


@dataclass
class FieldIndex:
    ra: float
    dec: float
    exposures: list[Exposure]
    epochs: list[Epoch]
    epoch_entries: list[dict[str, Any]]
    searched: list[str]
    deep: bool
    n_deep_found: int
    discovered_at: str | None
    warnings: list[str] = field(default_factory=list)

    @property
    def images(self) -> list[DetectorImage]:
        return [im for x in self.exposures for im in x.images]


def epoch_entry(epoch: Epoch, pa: int | None) -> dict[str, Any]:
    """Contract ``Epoch`` dict (docs/api-contract.md section 1) for one pxh Epoch (pa None is shown as 0)."""
    pa = 0 if pa is None else pa
    year = int(epoch.survey_year or ep.survey_year(epoch.t_start_mjd))
    return {
        "index": epoch.index,
        "label": mjd_to_label(epoch.t_mid_mjd),
        "survey": f"S{2 * (year - 1) + (1 if pa == 0 else 2)}",
        "year": year,
        "pa": pa,
        "start": mjd_to_date(epoch.t_start_mjd),
        "end": mjd_to_date(epoch.t_end_mjd),
        "mjd_mid": round(epoch.t_mid_mjd, 4),
        "n_exposures": len(epoch.exposures),
        "detectors": {str(d): int(n) for d, n in sorted(epoch.detector_counts.items()) if n > 0},
        "full": bool(epoch.full),
    }


def _discovered_at() -> str | None:
    catalog = sia.collection_catalog()
    return utc_iso(catalog.fetched_at) if catalog.fetched_at else None


def _search(ra: float, dec: float) -> FieldIndex:
    names = sia.discover_l2_collections()
    results = sia.search_position(ra, dec, SEARCH_RADIUS_DEG, names)
    failed = [r for r in results if r.source == "failed"]
    if failed:
        detail = "; ".join(f"{r.collection}: {r.error}" for r in failed)[:400]
        raise archive_unavailable(f"The SPHEREx image search at IRSA failed ({detail}). Try again in a minute.")
    warnings: list[str] = []
    stale = [r.collection for r in results if r.source == "stale-cache"]
    if stale:
        warnings.append(f"IRSA's image search failed; cached search results are shown for {', '.join(stale)}.")
    truncated = [r.collection for r in results if r.truncated]
    if truncated:
        warnings.append(f"The image search hit its row limit for {', '.join(truncated)}; some images are missing.")
    images = sia.dedupe_images(im for r in results for im in r.images)
    exposures = ep.group_exposures(images)
    wide = [x for x in exposures if not any(sia.is_deep_collection(im.collection) for im in x.images)]
    deep = [x for x in exposures if any(sia.is_deep_collection(im.collection) for im in x.images)]
    kept: dict[tuple[int, tuple[int, ...]], Exposure] = {}
    for x in sorted(deep, key=lambda e: (e.t_min_mjd, e.obs_id)):
        kept.setdefault((math.floor(x.t_min_mjd), tuple(x.detectors)), x)  # <= 1 per pair per UTC day
    used = sorted(wide + list(kept.values()), key=lambda e: (e.t_min_mjd, e.obs_id))
    epochs = ep.group_epochs(used, max_span_days=DEEP_MAX_SPAN_DAYS if kept else None)
    if kept:
        warnings.append(
            f"Deep-field position: {len(kept)} of {len(deep)} deep exposures used (at most one per detector "
            f"pair per day), grouped into epochs of at most {DEEP_MAX_SPAN_DAYS:g} days."
        )
    pas = epoch_orientations(epochs)
    unknown = [e.index for e in epochs if pas.get(e.index) is None]
    if unknown:
        warnings.append(
            "Orientation (SPS_EPA) could not be read for epoch(s) "
            + ", ".join(f"E{i}" for i in unknown) + "; their survey label assumes PA 0."
        )
    return FieldIndex(
        ra=ra,
        dec=dec,
        exposures=used,
        epochs=epochs,
        epoch_entries=[epoch_entry(e, pas.get(e.index)) for e in epochs],
        searched=list(names),
        deep=bool(kept),
        n_deep_found=len(deep),
        discovered_at=_discovered_at(),
        warnings=warnings,
    )


def index_field(ra: float, dec: float) -> FieldIndex:
    """SIA index of the field centred on (ra, dec) (cached per instance for an hour)."""
    return _INDEX_CACHE.get_or_compute((round(ra, 5), round(dec, 5)), lambda: _search(ra, dec))


def release_info(index: FieldIndex, used: list[DetectorImage] | None = None) -> dict[str, Any]:
    images = index.images if used is None else used
    doc: dict[str, Any] = {
        "collections": sorted({im.collection for im in images}),
        "file_tags": sorted({im.file_tag for im in images if im.file_tag}),
        "latest_obs": mjd_to_date(max(im.t_max_mjd for im in images)) if images else "",
    }
    if index.discovered_at:
        doc["discovered_at"] = index.discovered_at
    return doc


def field_summary(ra: float, dec: float, fov: float) -> dict[str, Any]:
    """Coverage of a field from the SIA index alone: epochs, counts per detector, collections."""
    ra, dec, fov = normalise_field(ra, dec, fov)
    index = index_field(ra, dec)
    images = index.images
    per_det = Counter(im.detector for im in images)
    return {
        "schema": "pxh-field-summary/1",
        "generated_at": utc_iso(),
        "center": {"ra": ra, "dec": dec},
        "fov_arcmin": fov,
        "epochs": index.epoch_entries,
        "n_epochs": len(index.epochs),
        "n_images": len(images),
        "n_exposures": len(index.exposures),
        "collections": sorted({im.collection for im in images}),
        "detectors": {f"D{d}": int(per_det.get(d, 0)) for d in range(1, 7)},
        "deep_field": index.deep,
        "release": release_info(index),
        "warnings": list(index.warnings),
    }


# --- stamps -> grid layers ----------------------------------------------------------------------------


@dataclass
class _Layer:
    epoch: int
    data: np.ndarray
    weight: np.ndarray
    saturated: np.ndarray
    mjd: float
    total_weight: float
    wavelength_um: float | None
    image: DetectorImage


@dataclass
class DetectorCoadds:
    """Per-epoch co-adds of one detector on the shared grid, plus what it took to make them."""

    det: int
    frames: dict[int, Frame]
    saturated: dict[int, np.ndarray]
    used: list[DetectorImage]
    n_available: int
    n_selected: int
    n_failed: int
    n_outside: int
    n_skipped: int
    per_epoch_cap: int
    seconds: float
    requests: int
    bytes: int


def image_budget(fov: float, settings: Settings) -> int:
    """Images per detector build: PXH_MAX_IMAGES at 10 arcmin, fewer for wider fields (more rows to read)."""
    scale = min(1.0, (REQUEST_BUDGET_FOV_ARCMIN + 2.0) / (fov + 2.0))
    return max(8, int(settings.max_images * scale))


def select_images(index: FieldIndex, det: int, budget: int, per_epoch_cap: int) -> tuple[dict[int, list[DetectorImage]], int, int]:
    """Images of one detector per epoch (evenly spread in time), within the per-epoch cap and the budget."""
    groups: dict[int, list[DetectorImage]] = defaultdict(list)
    for epoch in index.epochs:
        for x in epoch.exposures:
            for im in x.images:
                if im.detector == det:
                    groups[epoch.index].append(im)
    available = sum(len(v) for v in groups.values())
    cap = max(1, per_epoch_cap)
    while cap > 1 and sum(min(cap, len(v)) for v in groups.values()) > budget:
        cap -= 1
    chosen: dict[int, list[DetectorImage]] = {}
    for e, ims in groups.items():
        ims = sorted(ims, key=lambda im: (im.t_min_mjd, im.obs_id))
        if len(ims) > cap:
            picks = np.unique(np.round(np.linspace(0, len(ims) - 1, cap)).astype(int))
            ims = [ims[i] for i in picks]
        chosen[e] = ims
    return chosen, available, cap


def _stamp_half(layout: l2.L2Layout, grid_n: int) -> int:
    """Half size of a native-pixel box covering the square grid at this detector's rotation."""
    grid_half = (grid_n - 1) / 2.0
    try:
        m = l2.celestial_wcs(layout.image_header).pixel_scale_matrix
        theta = math.atan2(m[0, 1], m[1, 1])
        factor = abs(math.cos(theta)) + abs(math.sin(theta))
    except Exception:  # noqa: BLE001 - any WCS problem: assume the worst rotation
        factor = math.sqrt(2.0)
    return math.ceil(grid_half * factor) + 2


def _wavelength_at(stamp: Stamp, ra: float, dec: float) -> float | None:
    if stamp.wavelength_um is None:
        return None
    wl = np.asarray(stamp.wavelength_um, dtype=np.float64)
    if wl.shape != np.shape(stamp.data):
        return None
    x, y = (float(v) for v in stamp.wcs.world_to_pixel_values(ra, dec))
    ny, nx = wl.shape
    if not (-0.5 <= x <= nx - 0.5 and -0.5 <= y <= ny - 0.5):
        return None
    value = float(ndimage.map_coordinates(wl, [[y], [x]], order=1, mode="nearest")[0])
    return value if math.isfinite(value) else None


def fetch_stamp(image: DetectorImage, ra: float, dec: float, grid_n: int, use_cache: bool) -> Stamp:
    """Byte-range stamp of one image covering the grid (headers cached on disk; pixels optional)."""
    layout = l2.read_layout(image)
    return l2.read_stamp(image, ra, dec, half_size_px=_stamp_half(layout, grid_n), use_cache=use_cache)


def _make_layer(
    epoch: int, image: DetectorImage, ra: float, dec: float, grid: tuple[WCS, tuple[int, int]], use_cache: bool
) -> _Layer | None:
    gw, shape = grid
    stamp = fetch_stamp(image, ra, dec, shape[0], use_cache)
    mask_bits, sat_bits = fl.science_mask(stamp.flag_bits), fl.saturation_mask(stamp.flag_bits)
    data, weight, _ = align.reproject_stamp(stamp, gw, shape, mask_bits, True, sat_bits)
    total = float(np.sum(weight, dtype=np.float64))
    if total <= 0.0:
        return None
    saturated = align.saturated_mask_on_grid(stamp, gw, shape, sat_bits)
    return _Layer(epoch, data, weight, saturated, float(stamp.mjd_avg), total, _wavelength_at(stamp, ra, dec), image)


def _coadd_epoch(layers: list[_Layer], grid: tuple[WCS, tuple[int, int]], det: int, epoch: int) -> Frame:
    gw, _ = grid
    data, weight, n_used = coadd_mod.coadd([(lay.data, lay.weight) for lay in layers], method="ivw")
    totals = np.array([lay.total_weight for lay in layers])
    mjds = np.array([lay.mjd for lay in layers])
    wls = [lay.wavelength_um for lay in layers if lay.wavelength_um is not None]
    meta: dict[str, Any] = {
        "kind": "coadd",
        "method": "ivw",
        "obs_ids": [lay.image.obs_id for lay in layers],
        "n_used_max": int(n_used.max()) if n_used.size else 0,
        "coverage_fraction": float(np.mean(weight > 0)),
    }
    if wls:
        meta["wavelength_min_um"], meta["wavelength_max_um"] = float(min(wls)), float(max(wls))
    return Frame(
        data=data,
        weight=weight,
        wcs=gw,
        mjd_mid=float(np.sum(totals * mjds) / np.sum(totals)),
        n_inputs=len(layers),
        label=f"D{det} E{epoch}",
        detector=det,
        epoch_index=epoch,
        wavelength_um=float(np.average(wls)) if wls else None,
        meta=meta,
    )


def detector_coadds(
    index: FieldIndex, fov: float, det: int, *, settings: Settings | None = None
) -> DetectorCoadds:
    """Per-epoch co-adds of detector ``det`` (cached per instance; shared by D<n> and rgb builds)."""
    settings = settings or get_settings()
    key = (index.ra, index.dec, fov, det, settings.max_images, settings.max_images_per_epoch)
    cached = _COADD_CACHE.get(key)
    if cached is not None:
        return cached
    result = _build_detector(index, fov, det, settings)
    if not (result.n_failed or result.n_skipped):
        _COADD_CACHE.put(key, result)  # incomplete co-adds are rebuilt on the next request
    return result


def _build_detector(index: FieldIndex, fov: float, det: int, settings: Settings) -> DetectorCoadds:
    t0 = time.perf_counter()
    stats0 = rangeio.stats()
    grid = align.make_grid(index.ra, index.dec, fov)
    chosen, available, cap = select_images(index, det, image_budget(fov, settings), settings.max_images_per_epoch)
    jobs = [(e, im) for e, ims in sorted(chosen.items()) for im in ims]
    layers: list[_Layer] = []
    n_failed = n_outside = n_skipped = 0
    if jobs:
        pool = ThreadPoolExecutor(max_workers=min(settings.build_workers, len(jobs)), thread_name_prefix="field")
        try:
            futures = {
                pool.submit(_make_layer, e, im, index.ra, index.dec, grid, settings.stamp_cache): (e, im)
                for e, im in jobs
            }
            done, pending = wait(futures, timeout=settings.build_budget_s)
            for fut in pending:
                fut.cancel()
            n_skipped = len(pending)
            for fut in done:
                e, im = futures[fut]
                try:
                    layer = fut.result()
                except l2.OutsideDetectorError:
                    n_outside += 1
                    continue
                except Exception as exc:  # noqa: BLE001 - one bad image never fails the field
                    n_failed += 1
                    log.warning("D%d %s (%s): %r", det, im.obs_id, im.collection, exc)
                    continue
                if layer is None:
                    n_outside += 1
                else:
                    layers.append(layer)
        finally:
            pool.shutdown(wait=False, cancel_futures=True)
    by_epoch: dict[int, list[_Layer]] = defaultdict(list)
    for layer in layers:
        by_epoch[layer.epoch].append(layer)
    frames: dict[int, Frame] = {}
    saturated: dict[int, np.ndarray] = {}
    for e, group in sorted(by_epoch.items()):
        group.sort(key=lambda lay: (lay.mjd, lay.image.obs_id))
        frames[e] = _coadd_epoch(group, grid, det, e)
        saturated[e] = np.logical_or.reduce([lay.saturated for lay in group])
    stats1 = rangeio.stats()
    seconds = time.perf_counter() - t0
    log.info(
        "field (%.5f, %+.5f) %.1f' D%d: %d/%d images, %d epochs, %.1f s, %d requests, %.1f MB",
        index.ra, index.dec, fov, det, len(layers), available, len(frames), seconds,
        stats1.requests - stats0.requests, (stats1.bytes - stats0.bytes) / 1e6,
    )
    return DetectorCoadds(
        det=det,
        frames=frames,
        saturated=saturated,
        used=[lay.image for lay in layers],
        n_available=available,
        n_selected=len(jobs),
        n_failed=n_failed,
        n_outside=n_outside,
        n_skipped=n_skipped,
        per_epoch_cap=cap,
        seconds=seconds,
        requests=stats1.requests - stats0.requests,
        bytes=stats1.bytes - stats0.bytes,
    )


# --- rendering ----------------------------------------------------------------------------------------


def _wl_range(frame: Frame, det: int) -> list[float]:
    lo, hi = frame.meta.get("wavelength_min_um"), frame.meta.get("wavelength_max_um")
    if lo is None or hi is None:
        lo, hi = config.DETECTOR_BANDS_UM[det]
    return [round(float(lo), 3), round(float(hi), 3)]


def render_detector(
    co: DetectorCoadds, index: FieldIndex, modes: tuple[str, ...]
) -> tuple[list[dict], list[dict], list[dict]]:
    """(epoch frames, difference frames, flags frames) of one detector as contract dicts with data URLs."""
    det = co.det
    keys = sorted(co.frames)
    if not keys:
        return [], [], []
    frames = [co.frames[e] for e in keys]
    vmin, vmax = render.shared_limits(frames, percentiles=(0.5, 99.7))
    epoch_frames: list[dict] = []
    flags: list[dict] = []
    for e, fr in zip(keys, frames, strict=True):
        if "epoch" in modes:
            epoch_frames.append({
                "epoch": e,
                "url": data_url(render.to_png(fr, vmin, vmax, stretch="asinh")),
                "mjd": round(fr.mjd_mid, 4),
                "n": int(fr.n_inputs),
                "wl_um": _wl_range(fr, det),
            })
        if "flags" in modes:
            holes = co.saturated[e] & (fr.weight <= 0)
            if holes.any():
                flags.append({
                    "detector": f"D{det}",
                    "epoch": e,
                    "url": data_url(render.mask_to_png(holes, color=SATURATED_RGB, alpha=200)),
                    "legend": {"saturated": SATURATED_HEX},
                })
    difference: list[dict] = []
    if "difference" in modes:
        full = {entry["index"] for entry in index.epoch_entries if entry["full"]}
        use = [e for e in keys if e in full]
        use = use if len(use) >= 2 else keys
        if len(use) >= 2:
            a, b = co.frames[use[-1]], co.frames[use[0]]
            dfr = diff_mod.difference(a, b, normalize=True)
            _, hi = render.shared_limits([dfr], percentiles=(0.5, 99.5), symmetric=True)
            lim = round(max(DIFF_MIN_LIMIT_SIGMA, float(hi)), 1)
            difference.append({
                "detector": f"D{det}",
                "a": use[-1],
                "b": use[0],
                "url": data_url(render.to_png(dfr, -lim, lim, stretch="linear")),
                "units": "sigma",
                "limits": [-lim, lim],
            })
    return epoch_frames, difference, flags


def render_rgb(channels: list[DetectorCoadds]) -> list[dict]:
    """False-colour epoch frames (R = D6, G = D3, B = D1) for epochs where all three channels exist."""
    common = sorted(set.intersection(*(set(c.frames) for c in channels))) if channels else []
    if not common:
        return []
    limits = [render.shared_limits([c.frames[e] for e in common], percentiles=(0.5, 99.7)) for c in channels]
    out = []
    for e in common:
        r, g, b = (c.frames[e] for c in channels)
        png = render.rgb_composite(r, g, b, limits=limits, stretch="asinh")
        out.append({
            "epoch": e,
            "url": data_url(png),
            "mjd": round(float(np.mean([r.mjd_mid, g.mjd_mid, b.mjd_mid])), 4),
            "n": int(min(r.n_inputs, g.n_inputs, b.n_inputs)),
            "channels": RGB_LABEL,
        })
    return out


# --- manifest -----------------------------------------------------------------------------------------


def _links(ra: float, dec: float) -> list[dict[str, str]]:
    return [{
        "label": "SIMBAD objects within 5 arcmin (CfA mirror)",
        "url": f"https://simbad.cfa.harvard.edu/simbad/sim-coo?Coord={ra:.5f}%20{dec:+.5f}&Radius=5&Radius.unit=arcmin",
    }]


def _warnings_for(co: DetectorCoadds, name: str, modes: tuple[str, ...]) -> list[str]:
    out = []
    if co.n_available == 0:
        out.append(f"SPHEREx has no {name} images of this position yet.")
        return out
    if co.n_selected < co.n_available:
        out.append(
            f"{name}: co-added {len(co.used)} of {co.n_available} images (at most {co.per_epoch_cap} per epoch) "
            "to keep the build fast."
        )
    if co.n_failed:
        out.append(f"{name}: {co.n_failed} image(s) could not be read from IRSA and were left out.")
    if co.n_skipped:
        out.append(f"{name}: the time budget ran out; {co.n_skipped} image(s) were left out.")
    if co.n_outside:
        out.append(f"{name}: {co.n_outside} image(s) had no usable pixels in this field.")
    if any(bool((co.saturated[e] & (co.frames[e].weight <= 0)).any()) for e in co.frames):
        hint = "" if "flags" in modes else "; add flags to modes for the overlay"
        out.append(f"{name}: saturated pixels are masked (transparent){hint}.")
    return out


def build_field(
    ra: float, dec: float, fov: float, det: str, modes: tuple[str, ...], *, settings: Settings | None = None
) -> dict[str, Any]:
    """FieldManifest (source "live") for one detector (``D1``..``D6``) or ``rgb``; see the module docstring."""
    ra, dec, fov = normalise_field(ra, dec, fov)
    key = (ra, dec, fov, det, modes)
    cached = _MANIFEST_CACHE.get(key)
    if cached is not None:
        return cached
    t0 = time.perf_counter()
    settings = settings or get_settings()
    index = index_field(ra, dec)
    if not index.exposures:
        raise ApiProblem(404, "no_coverage", "SPHEREx has not released any images of this position yet.")
    grid_wcs, shape = align.make_grid(ra, dec, fov)
    epoch_frames: dict[str, list[dict]] = {}
    difference: list[dict] = []
    flags: list[dict] = []
    warnings = list(index.warnings)
    channel_numbers = RGB_CHANNELS if det == "rgb" else (int(det[1]),)
    channels = [detector_coadds(index, fov, d, settings=settings) for d in channel_numbers]
    if det == "rgb":
        epoch_frames["rgb"] = render_rgb(channels) if "epoch" in modes else []
        if "epoch" in modes and not epoch_frames["rgb"]:
            warnings.append("No epoch has all three colour channels (D1, D3, D6) in this field.")
    else:
        frames, difference, flags = render_detector(channels[0], index, modes)
        epoch_frames[det] = frames
    for co in channels:
        warnings.extend(_warnings_for(co, f"D{co.det}", modes))
    used = [im for co in channels for im in co.used]
    last_epoch_mjd = index.epoch_entries[-1]["mjd_mid"] if index.epoch_entries else round(mjd_now(), 4)
    manifest: dict[str, Any] = {
        "schema": "pxh-field/1",
        "generated_at": utc_iso(),
        "source": "live",
        "target": None,
        "center": {"ra": ra, "dec": dec, "epoch_mjd": last_epoch_mjd},
        "fov_arcmin": fov,
        "release": release_info(index, used or None),
        "grid": {
            "width": int(shape[1]),
            "height": int(shape[0]),
            "pixscale_arcsec": round(align.pixel_scale_arcsec(grid_wcs), 4),
            "wcs": render.wcs_to_aladin(grid_wcs, shape),
        },
        "epochs": index.epoch_entries,
        "frames": {"epoch": epoch_frames, "then_vs_now": [], "difference": difference, "flags": flags},
        "render": {"stretch": "asinh", "note": "one stretch per detector, shared by all epochs"},
        "motion": None,
        "spectrum": None,
        "lightcurve": None,
        "checks": [],
        "warnings": warnings,
        "links": _links(ra, dec),
        "credits": CREDITS,
        "build": {
            "det": det,
            "modes": list(modes),
            "fov_arcmin": fov,
            "n_images_available": sum(co.n_available for co in channels),
            "n_images_used": len(used),
            "n_images_failed": sum(co.n_failed for co in channels),
            "n_images_skipped": sum(co.n_skipped for co in channels),
            "seconds": round(time.perf_counter() - t0, 2),
            "requests": sum(co.requests for co in channels),
            "bytes": sum(co.bytes for co in channels),
        },
    }
    if not any(co.n_failed or co.n_skipped for co in channels):
        _MANIFEST_CACHE.put(key, manifest)  # incomplete builds are rebuilt on the next request
    return manifest
