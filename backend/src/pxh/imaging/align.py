"""Shared north-up sky grids, and reprojection of SPHEREx stamps onto them.

Every frame the app shows (a single exposure, an epoch co-add or a difference) lives on one grid built by
`make_grid`: a TAN projection centred on the target, north up and east left, with pixel (0, 0) in the
south-east corner (FITS convention; `pxh.imaging.render` flips rows so PNG row 0 is north).

`reproject_stamp` puts one `models.Stamp` on such a grid:

- data = IMAGE - ZODI, in MJy/sr;
- a pixel is invalid if any of `mask_bits | saturation_bits` is set in FLAGS, or IMAGE, ZODI or VARIANCE is
  not finite, or VARIANCE <= 0;
- data, a validity layer, the variance and the input pixel coordinates are reprojected together by one
  bilinear `reproject_interp` call (roundtrip_coords=False);
- an output pixel is kept only where the reprojected validity is >= 0.999, so a masked input pixel never bleeds
  into its neighbours. Kept values are renormalised by the validity (normalised interpolation), which
  removes the tiny leakage below that threshold;
- weight = 1 / variance. The variance of a bilinearly interpolated value is sum(k_i^2 var_i), not
  sum(k_i var_i), so by default the interpolated variance is multiplied by g(fx) g(fy), with
  g(f) = f^2 + (1 - f)^2, where fx and fy are the fractional input-pixel coordinates. That keeps
  per-pixel S/N maps of co-adds and differences calibrated (unit variance) instead of ~0.67.

Limitation: the SPHEREx PSF is undersampled (FWHM ~9 arcsec ~1.5 px). Bilinear resampling onto a rotated grid
therefore changes one exposure's star peak and sum by a few per cent, depending on the sub-pixel phase. This
averages out in co-adds and is fine for display, blinking and difference imaging. Measure fluxes on native
pixels (pxh.photometry), never on reprojected frames.
"""

from __future__ import annotations

import logging
import math
from collections.abc import Iterable

import numpy as np
from astropy.wcs import WCS
from astropy.wcs.utils import proj_plane_pixel_scales
from reproject import reproject_interp

from pxh import config
from pxh.models import Stamp

log = logging.getLogger(__name__)

# An output pixel is valid only if the bilinear interpolation weight of valid input pixels is at least this.
VALID_THRESHOLD = 0.999
# Largest grid side accepted by make_grid (a 30 arcmin view at 2x oversampling is ~586 px).
MAX_GRID_NPIX = 4096
# Extra grid pixels around a stamp's projected outline when cropping the reprojection to its bounding box.
_BBOX_MARGIN_PX = 2
_EDGE_SAMPLES = 9

GridShape = tuple[int, int]


def make_grid(
    ra: float,
    dec: float,
    fov_arcmin: float,
    pixscale_arcsec: float = config.PIXEL_SCALE_ARCSEC,
    oversample: int = 1,
) -> tuple[WCS, GridShape]:
    """Build a square north-up, east-left TAN grid centred on (ra, dec).

    The side is round(fov / pixel), forced odd so the centre falls on the middle pixel, index (n - 1) / 2.
    Returns (wcs, (ny, nx)). The WCS uses CDELT1 < 0, CDELT2 > 0, an identity PC matrix and RADESYS ICRS.
    """
    _check_finite(ra=ra, dec=dec, fov_arcmin=fov_arcmin, pixscale_arcsec=pixscale_arcsec)
    if not -90.0 <= dec <= 90.0:
        raise ValueError(f"dec must be in [-90, 90], got {dec}")
    if fov_arcmin <= 0 or pixscale_arcsec <= 0:
        raise ValueError("fov_arcmin and pixscale_arcsec must be positive")
    if int(oversample) != oversample or oversample < 1:
        raise ValueError(f"oversample must be a positive integer, got {oversample}")
    scale_arcsec = pixscale_arcsec / int(oversample)
    n = max(3, round(fov_arcmin * 60.0 / scale_arcsec))
    if n % 2 == 0:
        n += 1
    if n > MAX_GRID_NPIX:
        raise ValueError(f"grid of {n}x{n} px exceeds MAX_GRID_NPIX={MAX_GRID_NPIX}; reduce fov or oversample")

    wcs = WCS(naxis=2)
    wcs.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    wcs.wcs.cunit = ["deg", "deg"]
    wcs.wcs.crval = [float(ra) % 360.0, float(dec)]
    wcs.wcs.crpix = [(n + 1) / 2.0, (n + 1) / 2.0]
    wcs.wcs.cdelt = [-scale_arcsec / 3600.0, scale_arcsec / 3600.0]
    wcs.wcs.radesys = "ICRS"
    wcs.wcs.set()  # initialise wcslib now, so later concurrent reads do not race on a lazy set()
    wcs.pixel_shape = (n, n)
    return wcs, (n, n)


def pixel_scale_arcsec(wcs: WCS) -> float:
    """Mean pixel scale of a celestial WCS, in arcsec (geometric mean of both axes)."""
    sx, sy = proj_plane_pixel_scales(wcs.celestial)
    return float(math.sqrt(sx * sy) * 3600.0)


def same_grid(wcs_a: WCS, wcs_b: WCS, shape_a: GridShape, shape_b: GridShape, atol_deg: float = 1e-9) -> bool:
    """True if two frames share one pixel grid: same shape, projection, reference point and pixel matrix."""
    if tuple(shape_a) != tuple(shape_b):
        return False
    a, b = wcs_a.wcs, wcs_b.wcs
    if list(a.ctype) != list(b.ctype):
        return False
    if (wcs_a.sip is None) != (wcs_b.sip is None):
        return False
    return bool(
        np.allclose(a.crval, b.crval, rtol=0.0, atol=atol_deg)
        and np.allclose(a.crpix, b.crpix, rtol=0.0, atol=1e-6)
        and np.allclose(wcs_a.pixel_scale_matrix, wcs_b.pixel_scale_matrix, rtol=1e-9, atol=1e-14)
    )


def reproject_stamp(
    stamp: Stamp,
    grid_wcs: WCS,
    shape: GridShape,
    mask_bits: int,
    subtract_zodi: bool = True,
    saturation_bits: int = 0,
    *,
    interp_variance_correction: bool = True,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Reproject one stamp onto the grid; see the module docstring for the method.

    mask_bits: FLAGS bits that invalidate a pixel (e.g. the invalid and artifact groups).
    saturation_bits: further bits to mask (e.g. OVERFLOW). They are kept separate so the caller can also draw
        them with `saturated_mask_on_grid`.
    Returns (data, weight, footprint), float32 arrays of `shape`: data in MJy/sr (NaN where invalid),
    weight = 1/variance (0 where invalid), footprint = 1 where the grid pixel falls on the stamp (masked or not).
    """
    ny, nx = _check_shape(shape)
    data, valid, var = _prepare_stamp(stamp, int(mask_bits) | int(saturation_bits), subtract_zodi)
    out_data = np.full((ny, nx), np.nan, dtype=np.float32)
    out_weight = np.zeros((ny, nx), dtype=np.float32)
    out_fp = np.zeros((ny, nx), dtype=np.float32)
    bbox = _stamp_bbox_on_grid(stamp.wcs, data.shape, grid_wcs, (ny, nx))
    if bbox is None:
        log.debug("stamp %s D%s does not overlap the grid", stamp.image.obs_id, stamp.image.detector)
        return out_data, out_weight, out_fp
    y0, y1, x0, x1 = bbox
    sub_wcs = grid_wcs.slice((slice(y0, y1), slice(x0, x1)))

    sny, snx = data.shape
    xs = np.broadcast_to(np.arange(snx, dtype=np.float64), (sny, snx))
    ys = np.broadcast_to(np.arange(sny, dtype=np.float64)[:, None], (sny, snx))
    stack = np.stack([np.where(valid, data, 0.0), valid.astype(np.float64), np.where(valid, var, 0.0), xs, ys])
    out, footprint = reproject_interp(
        (stack, stamp.wcs), sub_wcs, shape_out=(y1 - y0, x1 - x0), order="bilinear", roundtrip_coords=False
    )
    d_v, v, var_v, x_in, y_in = out
    fp = np.nan_to_num(footprint[0], nan=0.0)
    good = (fp > 0) & np.isfinite(v) & (v >= VALID_THRESHOLD)
    with np.errstate(invalid="ignore", divide="ignore"):
        d_sub = np.where(good, d_v / v, np.nan)
        var_sub = np.where(good, var_v / v, np.nan)
        if interp_variance_correction:
            var_sub = var_sub * _bilinear_variance_factor(x_in) * _bilinear_variance_factor(y_in)
        good &= np.isfinite(d_sub) & np.isfinite(var_sub) & (var_sub > 0)
        w_sub = np.where(good, 1.0 / var_sub, 0.0)
    out_data[y0:y1, x0:x1] = np.where(good, d_sub, np.nan)
    out_weight[y0:y1, x0:x1] = w_sub
    out_fp[y0:y1, x0:x1] = fp
    return out_data, out_weight, out_fp


def saturated_mask_on_grid(
    stamps: Stamp | Iterable[Stamp],
    grid_wcs: WCS,
    shape: GridShape,
    saturation_bits: int,
) -> np.ndarray:
    """Boolean grid mask of every grid pixel touched by a saturated input pixel (OR over stamps), for overlays.

    It matches the holes that `reproject_stamp(..., saturation_bits=...)` leaves in the data.
    """
    ny, nx = _check_shape(shape)
    mask = np.zeros((ny, nx), dtype=bool)
    if not saturation_bits:
        return mask
    for stamp in [stamps] if isinstance(stamps, Stamp) else stamps:
        if stamp.flags is None:
            continue
        flags = _as_flag_array(stamp.flags, stamp.data.shape)
        sat = (flags & int(saturation_bits)) != 0
        if not sat.any():
            continue
        bbox = _stamp_bbox_on_grid(stamp.wcs, sat.shape, grid_wcs, (ny, nx))
        if bbox is None:
            continue
        y0, y1, x0, x1 = bbox
        frac, _ = reproject_interp(
            (sat.astype(np.float64), stamp.wcs),
            grid_wcs.slice((slice(y0, y1), slice(x0, x1))),
            shape_out=(y1 - y0, x1 - x0),
            order="bilinear",
            roundtrip_coords=False,
        )
        # Same criterion as the validity cut in reproject_stamp: a saturated input weight above 1 - 0.999.
        mask[y0:y1, x0:x1] |= np.nan_to_num(frac, nan=0.0) > 1.0 - VALID_THRESHOLD
    return mask


# --- helpers -------------------------------------------------------------------------------------------


def _prepare_stamp(stamp: Stamp, bad_bits: int, subtract_zodi: bool) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Return (data - zodi, valid mask, variance) as float64/bool arrays of the stamp's shape."""
    data = np.asarray(stamp.data, dtype=np.float64)
    if data.ndim != 2 or data.size == 0:
        raise ValueError(f"stamp data must be a non-empty 2-D array, got shape {data.shape}")
    if subtract_zodi and stamp.zodi is not None:
        data = data - _plane(stamp.zodi, data.shape, "zodi")
    elif subtract_zodi:
        log.debug("stamp %s has no ZODI plane; not subtracted", stamp.image.obs_id)
    valid = np.isfinite(data)
    if stamp.flags is not None and bad_bits:
        valid &= (_as_flag_array(stamp.flags, data.shape) & int(bad_bits)) == 0
    if stamp.variance is not None:
        var = _plane(stamp.variance, data.shape, "variance")
        valid &= np.isfinite(var) & (var > 0)
    else:
        var = np.full(data.shape, _robust_variance(data[valid]))
        log.debug("stamp %s has no VARIANCE plane; using a robust global estimate", stamp.image.obs_id)
    return data, valid, var


def _plane(arr: np.ndarray, shape: tuple[int, ...], name: str) -> np.ndarray:
    out = np.asarray(arr, dtype=np.float64)
    if out.shape != shape:
        raise ValueError(f"stamp {name} shape {out.shape} does not match data shape {shape}")
    return out


def _as_flag_array(flags: np.ndarray, shape: tuple[int, ...]) -> np.ndarray:
    """FLAGS as int64, so a 32-bit mask with bit 31 set works with int32 input."""
    out = np.asarray(flags)
    if out.shape != shape:
        raise ValueError(f"stamp flags shape {out.shape} does not match data shape {shape}")
    if not np.issubdtype(out.dtype, np.integer):
        raise ValueError(f"stamp flags must be an integer bitmask, got dtype {out.dtype}")
    return out.astype(np.int64, copy=False)


def _robust_variance(values: np.ndarray) -> float:
    """(1.4826 MAD)^2 of the values, or 1.0 if that is undefined."""
    if values.size < 2:
        return 1.0
    mad = float(np.median(np.abs(values - np.median(values))))
    var = (1.4826 * mad) ** 2
    return var if np.isfinite(var) and var > 0 else 1.0


def _bilinear_variance_factor(coord: np.ndarray) -> np.ndarray:
    """Sum of squared 1-D linear-interpolation weights at fractional coordinate f: f^2 + (1 - f)^2."""
    f = coord - np.floor(coord)
    return f * f + (1.0 - f) * (1.0 - f)


def _stamp_bbox_on_grid(
    stamp_wcs: WCS, stamp_shape: tuple[int, int], grid_wcs: WCS, grid_shape: GridShape
) -> tuple[int, int, int, int] | None:
    """Grid index box (y0, y1, x0, x1) covering the stamp's projected outline, or None if they do not overlap.

    Points along all four stamp edges are projected (not only the corners, since SIP edges bow). If the
    projection fails (e.g. a point behind the tangent plane), the whole grid is returned.
    """
    sny, snx = stamp_shape
    gny, gnx = grid_shape
    t = np.linspace(0.0, 1.0, _EDGE_SAMPLES)
    left, right, bottom, top = -0.5, snx - 0.5, -0.5, sny - 0.5
    ex = np.concatenate([left + t * (right - left), np.full_like(t, right), right - t * (right - left),
                         np.full_like(t, left)])
    ey = np.concatenate([np.full_like(t, bottom), bottom + t * (top - bottom), np.full_like(t, top),
                         top - t * (top - bottom)])
    try:
        ra, dec = stamp_wcs.pixel_to_world_values(ex, ey)
        gx, gy = grid_wcs.world_to_pixel_values(ra, dec)
    except Exception:  # any projection failure: fall back to the full grid
        log.debug("could not project the stamp outline onto the grid; using the full grid", exc_info=True)
        return 0, gny, 0, gnx
    gx, gy = np.asarray(gx, dtype=np.float64), np.asarray(gy, dtype=np.float64)
    if not (np.all(np.isfinite(gx)) and np.all(np.isfinite(gy))):
        return 0, gny, 0, gnx
    x0 = max(0, math.floor(gx.min()) - _BBOX_MARGIN_PX)
    x1 = min(gnx, math.ceil(gx.max()) + _BBOX_MARGIN_PX + 1)
    y0 = max(0, math.floor(gy.min()) - _BBOX_MARGIN_PX)
    y1 = min(gny, math.ceil(gy.max()) + _BBOX_MARGIN_PX + 1)
    if x0 >= x1 or y0 >= y1:
        return None
    return y0, y1, x0, x1


def _check_shape(shape: GridShape) -> tuple[int, int]:
    if len(shape) != 2 or int(shape[0]) < 1 or int(shape[1]) < 1:
        raise ValueError(f"grid shape must be (ny, nx) with positive sizes, got {shape}")
    return int(shape[0]), int(shape[1])


def _check_finite(**values: float) -> None:
    for name, value in values.items():
        if not math.isfinite(value):
            raise ValueError(f"{name} must be finite, got {value}")
