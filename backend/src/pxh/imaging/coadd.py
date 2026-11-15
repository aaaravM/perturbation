"""Co-adds of frames that share one sky grid: inverse-variance mean, median, or sigma-clipped mean.

`coadd` combines (data, weight) layers already on one grid. `coadd_stamps` reprojects `models.Stamp`s onto a
grid (`pxh.imaging.align.reproject_stamp`) and returns the co-add as a `models.Frame` (e.g. one
per-epoch, per-detector blink frame).

Methods:
- 'ivw': sum(w d) / sum(w); weight = sum(w).
- 'median': unweighted median of the valid layers; weight = sum(w) * 2/pi for 3+ layers (Gaussian efficiency
  of the median), sum(w) otherwise.
- 'sigclip': iterative clipping around the per-pixel median, then the IVW mean of the kept layers. The scale
  for each sample is max(1.4826 * MAD across layers, 1/sqrt(w_i)): the MAD absorbs real layer-to-layer changes
  (each SPHEREx exposure sees a star at a different wavelength), and the formal noise is a floor, so pure-noise
  pixels are not over-clipped. A single-exposure transient (asteroid, cosmic ray) in a stack of 5 or more is
  rejected. Pixels with fewer than 3 valid layers are not clipped.
"""

from __future__ import annotations

import logging
import math
import warnings
from collections.abc import Sequence
from typing import Any

import numpy as np
from astropy.wcs import WCS
from scipy import ndimage

from pxh.imaging.align import GridShape, reproject_stamp
from pxh.models import Frame, Stamp

log = logging.getLogger(__name__)

METHODS = ("ivw", "median", "sigclip")
MIN_LAYERS_TO_CLIP = 3
SIGCLIP_MAX_ITERS = 5
MAD_TO_SIGMA = 1.4826
MEDIAN_EFFICIENCY = 2.0 / math.pi
# Bound the per-chunk cube size (layers x rows x columns) used by the median and sigma-clip methods.
_CHUNK_ELEMENTS = 4_000_000

Layer = tuple[np.ndarray, np.ndarray]


def coadd(
    layers: Sequence[Layer], method: str = "ivw", sigma: float = 3.0
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Combine (data, weight) layers on one grid.

    A sample is valid where weight > 0 and data is finite. Returns (data float32 with NaN where no valid
    sample, weight float32, n_used int32), where n_used counts the samples used per pixel.
    """
    if method not in METHODS:
        raise ValueError(f"unknown co-add method {method!r}; expected one of {METHODS}")
    if not layers:
        raise ValueError("coadd needs at least one layer")
    if not (math.isfinite(sigma) and sigma > 0):
        raise ValueError(f"sigma must be positive, got {sigma}")
    shape = np.shape(layers[0][0])
    if len(shape) != 2:
        raise ValueError(f"layers must be 2-D, got shape {shape}")
    for i, (d, w) in enumerate(layers):
        if np.shape(d) != shape or np.shape(w) != shape:
            raise ValueError(f"layer {i}: data {np.shape(d)} / weight {np.shape(w)} do not match {shape}")
    if method == "ivw":
        return _coadd_ivw(layers, shape)
    return _coadd_cube(layers, shape, method, sigma)


def coadd_stamps(
    stamps: Sequence[Stamp],
    grid: tuple[WCS, GridShape],
    mask_bits: int,
    label: str,
    epoch_index: int | None = None,
    detector: int | None = None,
    method: str = "ivw",
    *,
    sigma: float = 3.0,
    subtract_zodi: bool = True,
    saturation_bits: int = 0,
) -> Frame:
    """Reproject stamps onto `grid` (the (wcs, shape) from `make_grid`) and co-add them into a Frame.

    mjd_mid is the mean of stamp.mjd_avg weighted by each stamp's total weight on the grid. Stamps with no
    valid pixel on the grid are skipped (listed in meta['skipped_obs_ids']). If none is left, an empty frame
    (all NaN, weight 0, n_inputs 0) is returned. `detector` defaults to the stamps' common detector.
    meta keys: kind, method, obs_ids, input_detectors, collections, mjd_min, mjd_max, mask_bits,
    saturation_bits, n_skipped, skipped_obs_ids, n_used_max, coverage_fraction, and when available
    psf_fwhm_arcsec (weighted mean of header PSF_FWHM), wavelengths_um (per input, at the grid centre),
    wavelength_min_um and wavelength_max_um. Frame.wavelength_um is the weighted mean wavelength at the centre.
    """
    if not stamps:
        raise ValueError("coadd_stamps needs at least one stamp")
    grid_wcs, shape = grid
    layers: list[Layer] = []
    used: list[tuple[Stamp, float]] = []
    skipped: list[str] = []
    for stamp in stamps:
        data, weight, _ = reproject_stamp(stamp, grid_wcs, shape, mask_bits, subtract_zodi, saturation_bits)
        total = float(np.sum(weight, dtype=np.float64))
        if total <= 0.0:
            skipped.append(stamp.image.obs_id)
            continue
        layers.append((data, weight))
        used.append((stamp, total))
    if skipped:
        log.debug("coadd %r: %d stamp(s) with no valid pixel on the grid", label, len(skipped))

    detectors = sorted({s.image.detector for s in stamps})
    if detector is None and len(detectors) == 1:
        detector = detectors[0]
    meta: dict[str, Any] = {
        "kind": "coadd",
        "method": method,
        "mask_bits": int(mask_bits),
        "saturation_bits": int(saturation_bits),
        "n_skipped": len(skipped),
        "skipped_obs_ids": skipped,
    }
    if not layers:
        log.warning("coadd %r: no valid input among %d stamp(s)", label, len(stamps))
        meta.update(obs_ids=[], input_detectors=[], collections=[], n_used_max=0, coverage_fraction=0.0)
        return Frame(
            data=np.full(shape, np.nan, dtype=np.float32),
            weight=np.zeros(shape, dtype=np.float32),
            wcs=grid_wcs,
            mjd_mid=float(np.mean([s.mjd_avg for s in stamps])),
            n_inputs=0,
            label=label,
            detector=detector,
            epoch_index=epoch_index,
            meta=meta,
        )

    data, weight, n_used = coadd(layers, method=method, sigma=sigma)
    totals = np.array([t for _, t in used])
    mjds = np.array([s.mjd_avg for s, _ in used], dtype=np.float64)
    meta.update(
        obs_ids=[s.image.obs_id for s, _ in used],
        input_detectors=[int(s.image.detector) for s, _ in used],
        collections=sorted({s.image.collection for s, _ in used}),
        mjd_min=float(mjds.min()),
        mjd_max=float(mjds.max()),
        n_used_max=int(n_used.max()),
        coverage_fraction=float(np.mean(weight > 0)),
    )
    psf = _weighted_header_mean(used, "PSF_FWHM")
    if psf is not None:
        meta["psf_fwhm_arcsec"] = psf
    wavelength = _centre_wavelengths(used, grid_wcs, shape, meta)
    return Frame(
        data=data,
        weight=weight,
        wcs=grid_wcs,
        mjd_mid=float(np.sum(totals * mjds) / np.sum(totals)),
        n_inputs=len(used),
        label=label,
        detector=detector,
        epoch_index=epoch_index,
        wavelength_um=wavelength,
        meta=meta,
    )


# --- combination -----------------------------------------------------------------------------------------


def _coadd_ivw(layers: Sequence[Layer], shape: tuple[int, ...]) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    num = np.zeros(shape, dtype=np.float64)
    den = np.zeros(shape, dtype=np.float64)
    n_used = np.zeros(shape, dtype=np.int32)
    for d, w in layers:
        d = np.asarray(d, dtype=np.float64)
        w = np.asarray(w, dtype=np.float64)
        ok = (w > 0) & np.isfinite(d) & np.isfinite(w)
        num += np.where(ok, w * d, 0.0)
        den += np.where(ok, w, 0.0)
        n_used += ok
    return _finish(num, den, n_used)


def _coadd_cube(
    layers: Sequence[Layer], shape: tuple[int, ...], method: str, sigma: float
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    ny, nx = shape
    data = np.full(shape, np.nan, dtype=np.float32)
    weight = np.zeros(shape, dtype=np.float32)
    n_used = np.zeros(shape, dtype=np.int32)
    rows = max(1, _CHUNK_ELEMENTS // max(1, len(layers) * nx))
    for r0 in range(0, ny, rows):
        r1 = min(ny, r0 + rows)
        cube_d = np.stack([np.asarray(d[r0:r1], dtype=np.float64) for d, _ in layers])
        cube_w = np.stack([np.asarray(w[r0:r1], dtype=np.float64) for _, w in layers])
        valid = (cube_w > 0) & np.isfinite(cube_d) & np.isfinite(cube_w)
        if method == "median":
            d, w, n = _median(cube_d, cube_w, valid)
        else:
            keep = _sigclip_keep(cube_d, cube_w, valid, sigma)
            d, w, n = _finish(
                np.sum(np.where(keep, cube_w * cube_d, 0.0), axis=0),
                np.sum(np.where(keep, cube_w, 0.0), axis=0),
                keep.sum(axis=0).astype(np.int32),
            )
        data[r0:r1], weight[r0:r1], n_used[r0:r1] = d, w, n
    return data, weight, n_used


def _median(cube_d: np.ndarray, cube_w: np.ndarray, valid: np.ndarray) -> tuple[np.ndarray, ...]:
    n = valid.sum(axis=0).astype(np.int32)
    med = _nanmedian(np.where(valid, cube_d, np.nan))
    wsum = np.sum(np.where(valid, cube_w, 0.0), axis=0)
    eff = np.where(n >= 3, MEDIAN_EFFICIENCY, 1.0)
    data = np.where(n > 0, med, np.nan).astype(np.float32)
    return data, (wsum * eff).astype(np.float32), n


def _sigclip_keep(cube_d: np.ndarray, cube_w: np.ndarray, valid: np.ndarray, sigma: float) -> np.ndarray:
    """Per-sample keep mask after iterative clipping around the median (see module docstring)."""
    with np.errstate(divide="ignore", invalid="ignore"):
        noise = np.where(valid, 1.0 / np.sqrt(cube_w), np.nan)
    keep = valid.copy()
    clippable = valid.sum(axis=0) >= MIN_LAYERS_TO_CLIP
    for _ in range(SIGCLIP_MAX_ITERS):
        masked = np.where(keep, cube_d, np.nan)
        med = _nanmedian(masked)
        mad = MAD_TO_SIGMA * _nanmedian(np.abs(masked - med))
        scale = np.fmax(mad[None], noise)
        with np.errstate(invalid="ignore"):
            outlier = keep & (np.abs(cube_d - med) > sigma * scale) & clippable[None]
        if not outlier.any():
            break
        keep &= ~outlier
    return keep


def _nanmedian(cube: np.ndarray) -> np.ndarray:
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)  # all-NaN columns -> NaN, as intended
        return np.nanmedian(cube, axis=0)


def _finish(num: np.ndarray, den: np.ndarray, n_used: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    with np.errstate(invalid="ignore", divide="ignore"):
        data = np.where(den > 0, num / den, np.nan)
    return data.astype(np.float32), den.astype(np.float32), n_used.astype(np.int32)


# --- metadata --------------------------------------------------------------------------------------------


def _weighted_header_mean(used: Sequence[tuple[Stamp, float]], key: str) -> float | None:
    values, weights = [], []
    for stamp, total in used:
        try:
            value = float(stamp.header.get(key))  # type: ignore[union-attr]
        except (TypeError, ValueError, AttributeError):
            continue
        if math.isfinite(value):
            values.append(value)
            weights.append(total)
    if not values:
        return None
    return float(np.average(values, weights=weights))


def _centre_wavelengths(
    used: Sequence[tuple[Stamp, float]], grid_wcs: WCS, shape: GridShape, meta: dict[str, Any]
) -> float | None:
    """Per-input wavelength at the grid centre into meta; return their weighted mean (None if unavailable)."""
    ny, nx = shape
    ra, dec = grid_wcs.pixel_to_world_values((nx - 1) / 2.0, (ny - 1) / 2.0)
    per_input: list[float | None] = []
    values, weights = [], []
    for stamp, total in used:
        wl = _wavelength_at(stamp, float(ra), float(dec))
        per_input.append(wl)
        if wl is not None:
            values.append(wl)
            weights.append(total)
    if not values:
        return None
    meta["wavelengths_um"] = per_input
    meta["wavelength_min_um"] = float(min(values))
    meta["wavelength_max_um"] = float(max(values))
    return float(np.average(values, weights=weights))


def _wavelength_at(stamp: Stamp, ra: float, dec: float) -> float | None:
    if stamp.wavelength_um is None:
        return None
    wl = np.asarray(stamp.wavelength_um, dtype=np.float64)
    if wl.shape != np.shape(stamp.data):
        log.debug("stamp %s wavelength map shape %s != data shape", stamp.image.obs_id, wl.shape)
        return None
    x, y = (float(v) for v in stamp.wcs.world_to_pixel_values(ra, dec))
    ny, nx = wl.shape
    if not (-0.5 <= x <= nx - 0.5 and -0.5 <= y <= ny - 0.5):
        return None
    value = float(ndimage.map_coordinates(wl, [[y], [x]], order=1, mode="nearest")[0])
    return value if math.isfinite(value) else None
