"""Forced photometry on SPHEREx Level-2 stamps: saturation-aware ePSF fits or apertures.

Given a ``models.Stamp`` and a sky position (already propagated to the exposure epoch by the caller),
``forced_photometry`` returns a ``models.PhotPoint``:

- position: ``stamp.wcs`` world -> pixel (0-based in the stamp); reported in full-frame pixels
  (stamp position + x0 / y0). With ``fit_position`` the ePSF fit (or a windowed centroid) moves it.
- background: sigma-clipped median of the valid pixels in an annulus (default 4-7 px), subtracted
  before measuring; falls back to the valid stamp pixels outside the inner radius, then to ZODI.
- masks: pixels with any ``mask_bits`` or ``saturation_bits`` flag, NaN data or non-positive variance
  are excluded. ``saturated`` is True when the 3x3 core holds a saturation flag or NaN.
- saturated cores (``saturated_core='ramp'``, default): SPHEREx "saturated" pixels are not clipped. The
  onboard sample-up-the-ramp fit stops at the OVERFLOW threshold (about half of full well) or at a
  detected TRANSIENT (e.g. the onset of BLOOM spill-over from a saturated neighbour), so these pixels
  keep a valid, linearity-corrected slope from the early reads, and VARIANCE accounts for the reduced
  number of reads (Explanatory Supplement v2.1, sect. 3.2.1-3.2.3, Table 16). Pixels whose only masked
  flags are OVERFLOW / TRANSIENT / SUR_ERROR / BLOOM are therefore used, with their variances, for the
  flux and position of a saturated source ("early overflow", OVERFLOW together with SUR_ERROR, is not).
  Without them a fit must use the unflagged wings, which are biased: undetected, gradual spill-over
  brightens the pixels next to a saturated core (Barnard's Star, D6: wing fit +21%, wing-based aperture
  correction +51%, core-inclusive fit within 2% of the summed charge). ``saturated_core='wings'`` forces
  the wing fit, which is also the fallback when the core has no usable slopes.
- method 'auto': ePSF fit when an EPSFGrid is given (a "wing-fit" with the background held fixed when a
  pixel of the peak 2x2 block stays unusable), else aperture photometry with an aperture correction from the PSF (the
  EPSFGrid, or a Gaussian of the header PSF_FWHM). The aperture correction is computed over the used
  aperture pixels only, so masked pixels inside the aperture are filled in by the PSF shape.
- flux: uJy, using uJy/pixel = I[MJy/sr] * 1e12 * OMEGA_sr, with OMEGA_sr from the OMEGA_MEDIAN
  header key (arcsec^2). Errors come from VARIANCE (plus the background error).
- wavelength / bandwidth: bilinear sample of ``stamp.wavelength_um`` / ``bandwidth_um`` at the position.

``measure_source`` returns the same point plus diagnostics (position errors in px and mas, S/N,
background, aperture correction); ``measure_position`` fits the position for astrometry / motion fits.
"""

from __future__ import annotations

import logging
import math
import warnings
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

import numpy as np
from astropy.stats import sigma_clipped_stats
from photutils.aperture import CircularAperture
from scipy.ndimage import map_coordinates
from scipy.special import erf

from pxh import config
from pxh.models import EPSFGrid, PhotPoint, Stamp
from pxh.photometry.centroid import (
    box_slices,
    fit_epsf,
    make_psf_model,
    render_psf,
    valid_pixels,
    windowed_centroid,
)
from pxh.photometry.motion import tangent_offsets_mas

log = logging.getLogger(__name__)

__all__ = [
    "ForcedResult",
    "PhotometryError",
    "forced_photometry",
    "gaussian_epsf",
    "local_background",
    "measure_position",
    "measure_source",
    "motion_inputs",
    "pixel_solid_angle_sr",
    "ramp_pixels",
    "ujy_per_pixel",
    "usable_for_motion",
]

ARCSEC2_TO_SR = (math.pi / 648000.0) ** 2
FWHM_PER_SIGMA = 2.0 * math.sqrt(2.0 * math.log(2.0))
METHODS = ("auto", "epsf", "aperture")
SATURATED_CORE_POLICIES = ("ramp", "wings")
# Flags that only mean "the ramp was cut short" (the slope from the earlier reads is still valid), and
# the flags that cut it. SUR_ERROR with OVERFLOW is an early overflow (<= ~3 reads): not trusted.
RAMP_FLAG_NAMES = ("OVERFLOW", "TRANSIENT", "SUR_ERROR", "BLOOM")
RAMP_TRIGGER_NAMES = ("OVERFLOW", "TRANSIENT")
_MIN_BKG_PIX = 8
_MIN_PSF_FRACTION = 0.01  # a saturated star keeps only ~5% of its light outside the 3x3 core
_WARN_APERTURE_CORRECTION = 3.0  # above this, an aperture flux is mostly a PSF extrapolation


class PhotometryError(RuntimeError):
    """The measurement is impossible for this stamp (position off the stamp, nothing valid, failed fit)."""


@dataclass(frozen=True)
class ForcedResult:
    """A PhotPoint plus the diagnostics that do not fit in it."""

    point: PhotPoint
    x_err: float  # px; NaN when the position was forced
    y_err: float
    cov_xy: float
    ra_deg: float  # sky position of (point.x, point.y)
    dec_deg: float
    ra_err_mas: float  # RA* (east) error; NaN when the position was forced
    dec_err_mas: float
    snr: float
    background: float  # MJy/sr per pixel, subtracted before measuring
    background_err: float
    background_source: str  # "annulus" | "stamp" | "zodi"
    aperture_correction: float  # aperture photometry: 1 / PSF fraction in the valid aperture; else NaN
    chi2_red: float  # ePSF fits only
    n_masked_core: int  # pixels of the 3x3 core excluded by the masks (before using early-ramp slopes)
    position_fitted: bool
    ujy_per_unit: float  # uJy per (MJy/sr x pixel) used for the conversion
    n_ramp_pixels: int = 0  # early-ramp (OVERFLOW / TRANSIENT) pixels used, within the fit box


@dataclass(frozen=True)
class _Background:
    level: float
    err: float
    std: float
    n: int
    source: str


@dataclass(frozen=True)
class _Measurement:
    x: float
    y: float
    x_err: float
    y_err: float
    cov_xy: float
    flux: float  # MJy/sr x pixels
    flux_err: float
    chi2_red: float
    aperture_correction: float
    method: str
    position_fitted: bool


# --- units, PSFs, background ---------------------------------------------------------------------


def pixel_solid_angle_sr(header: Any) -> float:
    """Pixel solid angle (sr) from OMEGA_MEDIAN (arcsec^2); falls back to the nominal 6.15" pixel."""
    omega = None
    if header is not None:
        omega = header.get("OMEGA_MEDIAN")
        if omega is None:
            omega = header.get("HIERARCH OMEGA_MEDIAN")
    try:
        omega_f = float(omega) if omega is not None else math.nan
    except (TypeError, ValueError):
        omega_f = math.nan
    if not (math.isfinite(omega_f) and omega_f > 0):
        omega_f = config.PIXEL_SCALE_ARCSEC**2
        log.warning("OMEGA_MEDIAN missing from header; using nominal %.3f arcsec^2", omega_f)
    return omega_f * ARCSEC2_TO_SR


def ujy_per_pixel(header: Any) -> float:
    """Conversion factor: flux in uJy of one pixel at 1 MJy/sr (1e12 * OMEGA_sr)."""
    return 1e12 * pixel_solid_angle_sr(header)


def gaussian_epsf(fwhm_px: float, oversampling: int = 5, size: int = 33) -> np.ndarray:
    """ePSF table of a pixel-integrated circular Gaussian with (pixel-convolved) FWHM ``fwhm_px``.

    Samples are on a ``size`` x ``size`` grid ``oversampling`` x finer than the pixels and sum to 1,
    like the SPHEREx EPSF extension. Used as an approximate PSF when no EPSFGrid is available.
    """
    if not (fwhm_px > 0):
        raise ValueError(f"fwhm_px must be positive, got {fwhm_px}")
    sigma_eff = fwhm_px / FWHM_PER_SIGMA
    sigma = math.sqrt(max(sigma_eff**2 - 1.0 / 12.0, 0.15**2))  # remove the pixel's own variance
    off = (np.arange(size) - (size - 1) / 2.0) / oversampling
    s2 = sigma * math.sqrt(2.0)
    g1 = 0.5 * (erf((off + 0.5) / s2) - erf((off - 0.5) / s2))
    tab = np.outer(g1, g1)
    return tab / tab.sum()


def _header_fwhm_px(header: Any) -> float | None:
    """PSF_FWHM header value (arcsec) converted to pixels, or None."""
    if header is None:
        return None
    try:
        fwhm = float(header.get("PSF_FWHM", math.nan))
    except (TypeError, ValueError):
        return None
    return fwhm / config.PIXEL_SCALE_ARCSEC if math.isfinite(fwhm) and fwhm > 0 else None


def local_background(
    data: np.ndarray,
    good: np.ndarray,
    x: float,
    y: float,
    annulus_px: tuple[float, float] = (4.0, 7.0),
    zodi: np.ndarray | None = None,
) -> _Background:
    """Sigma-clipped median of valid pixels in an annulus around (x, y), with fallbacks.

    Fallbacks: all valid stamp pixels beyond the inner radius, then the median ZODI model.
    Raises PhotometryError when none applies.
    """
    r_in, r_out = annulus_px
    if not (0 <= r_in < r_out):
        raise ValueError(f"bad annulus {annulus_px}")
    yy, xx = np.indices(data.shape)
    r = np.hypot(xx - x, yy - y)
    for source, sel in (("annulus", good & (r >= r_in) & (r <= r_out)), ("stamp", good & (r >= r_in))):
        vals = data[sel]
        if vals.size >= _MIN_BKG_PIX:
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                _, med, std = sigma_clipped_stats(vals, sigma=3.0, maxiters=5)
            if source != "annulus":
                log.info("background from %d stamp pixels (annulus too sparse)", vals.size)
            return _Background(float(med), 1.2533 * float(std) / math.sqrt(vals.size), float(std), int(vals.size), source)
    if zodi is not None:
        z = np.asarray(zodi, dtype=float)[r <= r_out]
        z = z[np.isfinite(z)]
        if z.size:
            log.warning("background from the ZODI model (no valid sky pixels around the source)")
            return _Background(float(np.median(z)), math.nan, math.nan, 0, "zodi")
    raise PhotometryError("no valid pixels to estimate the local background")


def _bits(flag_bits: Mapping[str, int], names: Iterable[str]) -> int:
    return sum(1 << int(flag_bits[n]) for n in names if n in flag_bits)


def ramp_pixels(
    flags: np.ndarray | None,
    data: np.ndarray,
    variance: np.ndarray | None,
    mask_bits: int,
    saturation_bits: int,
    flag_bits: Mapping[str, int] | None = None,
) -> np.ndarray:
    """Masked pixels that still hold a valid early-ramp slope (SPHEREx OVERFLOW / TRANSIENT semantics).

    A pixel qualifies when it carries a ramp-cutting flag (OVERFLOW, TRANSIENT, or any
    ``saturation_bits``), every flag of ``mask_bits | saturation_bits`` it carries is a ramp flag
    (OVERFLOW, TRANSIENT, SUR_ERROR, BLOOM), it is not an early overflow (OVERFLOW with SUR_ERROR), and
    both its value and its variance are finite with variance > 0. Bit numbers come from ``flag_bits``
    (name -> bit, as in ``Stamp.flag_bits``); without it only ``saturation_bits`` count as ramp flags.
    Returns a boolean array (all False without flags or variance: no weights, no rescue).
    """
    shape = np.shape(data)
    if flags is None or variance is None:
        return np.zeros(shape, dtype=bool)
    fb = dict(flag_bits or {})
    f = np.asarray(flags).astype(np.int64)
    sat = int(saturation_bits)
    ramp = _bits(fb, RAMP_FLAG_NAMES) | sat
    trigger = _bits(fb, RAMP_TRIGGER_NAMES) | sat
    overflow = _bits(fb, ("OVERFLOW",)) | sat
    sur_error = _bits(fb, ("SUR_ERROR",))
    offending = f & (int(mask_bits) | sat)
    ok = (offending != 0) & ((f & trigger) != 0) & ((offending & ~ramp) == 0)
    if sur_error:
        ok &= ~(((f & overflow) != 0) & ((f & sur_error) != 0))
    var = np.asarray(variance, dtype=float)
    with np.errstate(invalid="ignore"):
        ok &= np.isfinite(np.asarray(data, dtype=float)) & np.isfinite(var) & (var > 0)
    return ok


# --- geometry helpers ----------------------------------------------------------------------------


def _world_to_stamp(stamp: Stamp, ra: float, dec: float) -> tuple[float, float]:
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            x, y = stamp.wcs.world_to_pixel_values(ra, dec)
    except Exception as exc:  # astropy NoConvergence and friends
        raise PhotometryError(f"world->pixel failed for ({ra}, {dec}): {exc}") from exc
    return float(x), float(y)


def _pixel_jacobian_mas(stamp: Stamp, x: float, y: float, h: float = 0.5) -> np.ndarray:
    """d(xi, eta)/d(x, y) in mas per pixel at stamp position (x, y)."""
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        ra0, dec0 = stamp.wcs.pixel_to_world_values(x, y)
        ra, dec = stamp.wcs.pixel_to_world_values(np.array([x + h, x - h, x, x]), np.array([y, y, y + h, y - h]))
    xi, eta = tangent_offsets_mas(ra, dec, float(ra0), float(dec0))
    return np.array([[xi[0] - xi[1], xi[2] - xi[3]], [eta[0] - eta[1], eta[2] - eta[3]]]) / (2.0 * h)


def _core_status(data: np.ndarray, sat: np.ndarray, good: np.ndarray, x: float, y: float) -> tuple[bool, int]:
    sy, sx = box_slices(data.shape, x, y, 3)
    core_sat = sat[sy, sx] | ~np.isfinite(data[sy, sx])
    return bool(core_sat.any()), int((~good[sy, sx]).sum())


def _aperture_weights(shape: tuple[int, int], x: float, y: float, radius: float) -> np.ndarray:
    img = CircularAperture((x, y), r=radius).to_mask(method="exact").to_image(shape)
    return np.zeros(shape) if img is None else np.asarray(img, dtype=float)


def _sample(arr: np.ndarray | None, x: float, y: float) -> float:
    if arr is None:
        return math.nan
    a = np.asarray(arr, dtype=float)
    v = map_coordinates(a, [[y], [x]], order=1, mode="nearest")[0]
    return float(v)


def _select_psf(epsf: EPSFGrid | None, x_full: float, y_full: float) -> tuple[np.ndarray | None, int]:
    if epsf is None:
        return None, 5
    return np.asarray(epsf.nearest(x_full, y_full), dtype=float), int(epsf.oversampling)


# --- measurements --------------------------------------------------------------------------------


def _background_flux_term(
    psf_img: np.ndarray, good: np.ndarray, var: np.ndarray | None, x: float, y: float, box: int, bkg_err: float
) -> float:
    """Flux error of a PSF fit caused by an error ``bkg_err`` in a background that was held fixed."""
    if not math.isfinite(bkg_err) or bkg_err <= 0:
        return 0.0
    sy, sx = box_slices(psf_img.shape, x, y, box)
    sel = good[sy, sx]
    g = psf_img[sy, sx][sel]
    w = 1.0 / np.asarray(var, dtype=float)[sy, sx][sel] if var is not None else np.ones_like(g)
    den = float(np.sum(w * g * g))
    return abs(bkg_err * float(np.sum(w * g)) / den) if den > 0 else 0.0


def _epsf_measurement(
    sub: np.ndarray,
    var: np.ndarray | None,
    good: np.ndarray,
    psf: np.ndarray,
    oversampling: int,
    x: float,
    y: float,
    box: int,
    fit_position: bool,
    wing: bool,
    bkg: _Background,
) -> _Measurement | None:
    fit = fit_epsf(
        sub, var, good, psf, x, y, box=box, oversampling=oversampling, fit_position=fit_position,
        fit_background=not wing,
    )
    if not fit.ok:
        log.info("ePSF fit failed at (%.2f, %.2f): %s", x, y, fit.message)
        return None
    flux_err = fit.flux_err
    if wing:
        model = make_psf_model(psf, oversampling)
        psf_img = render_psf(model, sub.shape, fit.x, fit.y)
        flux_err = math.hypot(flux_err, _background_flux_term(psf_img, good, var, fit.x, fit.y, box, bkg.err))
    return _Measurement(
        x=fit.x, y=fit.y, x_err=fit.x_err, y_err=fit.y_err, cov_xy=fit.cov_xy, flux=fit.flux,
        flux_err=flux_err, chi2_red=fit.chi2_red, aperture_correction=math.nan,
        method="wing-fit" if wing else "epsf", position_fitted=fit_position,
    )


def _aperture_measurement(
    sub: np.ndarray,
    var: np.ndarray | None,
    good: np.ndarray,
    psf: np.ndarray | None,
    oversampling: int,
    x: float,
    y: float,
    radius: float,
    fit_position: bool,
    core_excluded: bool,
    bkg: _Background,
    fwhm_px: float | None,
    box: int,
) -> _Measurement:
    x_err = y_err = cov_xy = math.nan
    fitted = False
    if fit_position:
        x, y, x_err, y_err, cov_xy, fitted = _aperture_position(
            sub, var, good, psf, oversampling, x, y, core_excluded, fwhm_px, box
        )
    w = _aperture_weights(sub.shape, x, y, radius)
    wv = w * good
    if not np.any(wv > 0):
        raise PhotometryError("no valid pixels inside the aperture")
    total = float(np.sum(wv * np.where(good, sub, 0.0)))
    var_pix = np.where(good, var, 0.0) if var is not None else np.full(sub.shape, bkg.std**2)
    bkg_var = bkg.err**2 if math.isfinite(bkg.err) else 0.0
    var_ap = float(np.sum(wv**2 * var_pix)) + float(np.sum(wv)) ** 2 * bkg_var
    if psf is not None:
        frac = float(np.sum(wv * render_psf(make_psf_model(psf, oversampling), sub.shape, x, y)))
    else:
        frac = 1.0
        if np.any((w > 0) & ~good):
            log.warning("masked pixels in the aperture and no PSF for a correction: flux is a lower limit")
    if frac < _MIN_PSF_FRACTION:
        raise PhotometryError(f"only {frac:.3f} of the PSF falls on valid aperture pixels")
    if 1.0 / frac > _WARN_APERTURE_CORRECTION:
        log.warning("aperture correction %.1f: the flux is mostly a PSF extrapolation over masked pixels", 1.0 / frac)
    flux = total / frac
    flux_err = math.sqrt(var_ap) / frac if var_ap > 0 else math.nan
    if fitted and not math.isfinite(x_err) and flux_err > 0 and flux > 0:
        sigma_psf = (fwhm_px or 1.3) / FWHM_PER_SIGMA
        x_err = y_err = math.sqrt(2.0) * sigma_psf * flux_err / flux  # rough centroid error
        cov_xy = 0.0
    return _Measurement(
        x=x, y=y, x_err=x_err, y_err=y_err, cov_xy=cov_xy, flux=flux, flux_err=flux_err, chi2_red=math.nan,
        aperture_correction=1.0 / frac, method="aperture", position_fitted=fitted,
    )


def _aperture_position(
    sub: np.ndarray,
    var: np.ndarray | None,
    good: np.ndarray,
    psf: np.ndarray | None,
    oversampling: int,
    x: float,
    y: float,
    core_excluded: bool,
    fwhm_px: float | None,
    box: int,
) -> tuple[float, float, float, float, float, bool]:
    """Position for aperture photometry: PSF fit if possible, else a windowed centroid.

    The PSF is the file's ePSF or, without one, the Gaussian approximation from PSF_FWHM: a fit of a
    pixel-integrated model avoids the pixel-phase bias (~0.1 px) of centroids on undersampled stars.
    The background is held fixed when core pixels are excluded (wings alone cannot separate the two).
    """
    if psf is not None:
        fit = fit_epsf(
            sub, var, good, psf, x, y, box=box, oversampling=oversampling, fit_background=not core_excluded
        )
        if fit.ok:
            return fit.x, fit.y, fit.x_err, fit.y_err, fit.cov_xy, True
        log.info("PSF position fit failed (%s); trying a windowed centroid", fit.message)
    sigma = (fwhm_px or 1.3) / FWHM_PER_SIGMA
    cx, cy = windowed_centroid(sub, good, x, y, sigma_px=max(sigma, 0.5))
    if math.isfinite(cx) and math.isfinite(cy) and math.hypot(cx - x, cy - y) <= 2.0:
        return cx, cy, math.nan, math.nan, math.nan, True
    log.info("centroid failed near (%.2f, %.2f); keeping the forced position", x, y)
    return x, y, math.nan, math.nan, math.nan, False


def _aperture_flags(flags: np.ndarray | None, x: float, y: float, radius: float) -> int:
    if flags is None:
        return 0
    w = _aperture_weights(flags.shape, x, y, radius)
    inside = np.asarray(flags)[w > 0]
    return int(np.bitwise_or.reduce(inside.astype(np.int64))) if inside.size else 0


@dataclass(frozen=True)
class _Pixels:
    """Pixel masks of one measurement."""

    good: np.ndarray  # valid by the caller's masks (also the background pixels)
    use: np.ndarray  # pixels measured: good plus usable early-ramp pixels of a saturated core
    sat: np.ndarray  # carries a saturation flag
    saturated: bool  # the 3x3 core holds a saturation flag or NaN
    n_masked_core: int
    core_excluded: bool  # saturated and a pixel of the peak 2x2 block is unusable: a wing fit


def _peak_block(shape: tuple[int, ...], x: float, y: float) -> tuple[slice, slice]:
    """The 2x2 pixels whose centres surround (x, y): where an undersampled PSF has most of its light."""
    ix, iy = math.floor(x), math.floor(y)
    return slice(max(iy, 0), max(min(iy + 2, shape[0]), 0)), slice(max(ix, 0), max(min(ix + 2, shape[1]), 0))


def _select_pixels(
    stamp: Stamp,
    data: np.ndarray,
    var: np.ndarray | None,
    flags: np.ndarray | None,
    mask_bits: int,
    saturation_bits: int,
    saturated_core: str,
    x: float,
    y: float,
) -> _Pixels:
    bad = np.zeros(data.shape, bool) if flags is None else (flags & int(mask_bits)) != 0
    sat = np.zeros(data.shape, bool) if flags is None else (flags & int(saturation_bits)) != 0
    good = valid_pixels(data, var, ~(bad | sat))
    saturated, n_masked_core = _core_status(data, sat, good, x, y)
    use = good
    if saturated and saturated_core == "ramp":
        ramp = ramp_pixels(flags, data, var, mask_bits, saturation_bits, stamp.flag_bits)
        if ramp.any():
            use = good | ramp
    core_excluded = saturated and not bool(use[_peak_block(data.shape, x, y)].all())
    return _Pixels(good, use, sat, saturated, n_masked_core, core_excluded)


def _epsf_with_fallback(
    sub: np.ndarray,
    var: np.ndarray | None,
    pix: _Pixels,
    psf: np.ndarray,
    oversampling: int,
    x: float,
    y: float,
    box: int,
    fit_position: bool,
    bkg: _Background,
) -> tuple[_Measurement | None, _Pixels]:
    """ePSF fit on the selected pixels; if a core-inclusive fit fails, retry as a wing fit."""
    meas = _epsf_measurement(sub, var, pix.use, psf, oversampling, x, y, box, fit_position, pix.core_excluded, bkg)
    if meas is not None or pix.use is pix.good:
        return meas, pix
    log.info("core-inclusive ePSF fit failed at (%.2f, %.2f); trying a wing fit", x, y)
    wings = _Pixels(pix.good, pix.good, pix.sat, pix.saturated, pix.n_masked_core, pix.saturated)
    return _epsf_measurement(sub, var, wings.use, psf, oversampling, x, y, box, fit_position, True, bkg), wings


def measure_source(
    stamp: Stamp,
    ra: float,
    dec: float,
    epsf: EPSFGrid | None,
    mask_bits: int,
    saturation_bits: int,
    method: str = "auto",
    aperture_radius_px: float = 2.0,
    annulus_px: tuple[float, float] = (4.0, 7.0),
    fit_position: bool = False,
    *,
    epoch_index: int | None = None,
    box: int = 7,
    saturated_core: str = "ramp",
) -> ForcedResult:
    """Forced photometry with diagnostics; see the module docstring and ``forced_photometry``."""
    if method not in METHODS:
        raise ValueError(f"method must be one of {METHODS}, got {method!r}")
    if saturated_core not in SATURATED_CORE_POLICIES:
        raise ValueError(f"saturated_core must be one of {SATURATED_CORE_POLICIES}, got {saturated_core!r}")
    data = np.asarray(stamp.data, dtype=float)
    if data.ndim != 2:
        raise ValueError(f"stamp data must be 2-D, got {data.shape}")
    ny, nx = data.shape
    xs, ys = _world_to_stamp(stamp, ra, dec)
    if not (np.isfinite(xs) and np.isfinite(ys) and -0.5 <= xs <= nx - 0.5 and -0.5 <= ys <= ny - 0.5):
        raise PhotometryError(f"position ({xs:.2f}, {ys:.2f}) is outside the {nx}x{ny} stamp")
    var = None if stamp.variance is None else np.asarray(stamp.variance, dtype=float)
    flags = None if stamp.flags is None else np.asarray(stamp.flags).astype(np.int64)
    pix = _select_pixels(stamp, data, var, flags, mask_bits, saturation_bits, saturated_core, xs, ys)
    bkg = local_background(data, pix.good, xs, ys, annulus_px, stamp.zodi)
    sub = data - bkg.level

    psf, ovs = _select_psf(epsf, xs + stamp.x0, ys + stamp.y0)
    if method == "epsf" and psf is None:
        raise ValueError("method='epsf' needs an EPSFGrid")
    fwhm_px = _header_fwhm_px(stamp.header)
    meas = None
    if psf is not None and method in ("auto", "epsf"):
        meas, pix = _epsf_with_fallback(sub, var, pix, psf, ovs, xs, ys, box, fit_position, bkg)
        if meas is None and method == "epsf":
            raise PhotometryError("ePSF fit failed")
    if meas is None:
        ap_psf = psf if psf is not None else (gaussian_epsf(fwhm_px) if fwhm_px else None)
        meas = _aperture_measurement(
            sub, var, pix.use, ap_psf, ovs, xs, ys, aperture_radius_px, fit_position, pix.core_excluded, bkg,
            fwhm_px, box,
        )
    return _finish(stamp, data, pix, flags, meas, bkg, aperture_radius_px, epoch_index, (xs, ys), box)


def _finish(
    stamp: Stamp,
    data: np.ndarray,
    pix: _Pixels,
    flags: np.ndarray | None,
    meas: _Measurement,
    bkg: _Background,
    radius: float,
    epoch_index: int | None,
    forced_xy: tuple[float, float],
    box: int,
) -> ForcedResult:
    x, y = meas.x, meas.y
    saturated, n_masked_core = pix.saturated, pix.n_masked_core
    if math.hypot(x - forced_xy[0], y - forced_xy[1]) > 0.5:
        sat2, n2 = _core_status(data, pix.sat, pix.good, x, y)
        saturated, n_masked_core = saturated or sat2, max(n_masked_core, n2)
    sy, sx = box_slices(data.shape, x, y, box)
    n_ramp = int((pix.use & ~pix.good)[sy, sx].sum())
    k = ujy_per_pixel(stamp.header)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        ra_m, dec_m = stamp.wcs.pixel_to_world_values(x, y)
    ra_err = dec_err = math.nan
    if math.isfinite(meas.x_err) and math.isfinite(meas.y_err):
        jac = _pixel_jacobian_mas(stamp, x, y)
        cxy = meas.cov_xy if math.isfinite(meas.cov_xy) else 0.0
        cov_sky = jac @ np.array([[meas.x_err**2, cxy], [cxy, meas.y_err**2]]) @ jac.T
        ra_err, dec_err = math.sqrt(max(cov_sky[0, 0], 0.0)), math.sqrt(max(cov_sky[1, 1], 0.0))
    point = PhotPoint(
        obs_id=stamp.image.obs_id,
        detector=int(stamp.image.detector),
        mjd=float(stamp.mjd_avg),
        wavelength_um=_sample(stamp.wavelength_um, x, y),
        bandwidth_um=_sample(stamp.bandwidth_um, x, y),
        flux_ujy=float(meas.flux * k),
        flux_err_ujy=float(meas.flux_err * k),
        x=float(x + stamp.x0),
        y=float(y + stamp.y0),
        flags=_aperture_flags(flags, x, y, radius),
        saturated=bool(saturated),
        method=meas.method,
        collection=stamp.image.collection,
        epoch_index=epoch_index,
    )
    snr = meas.flux / meas.flux_err if meas.flux_err and math.isfinite(meas.flux_err) else math.nan
    return ForcedResult(
        point=point, x_err=meas.x_err, y_err=meas.y_err, cov_xy=meas.cov_xy, ra_deg=float(ra_m),
        dec_deg=float(dec_m), ra_err_mas=ra_err, dec_err_mas=dec_err, snr=float(snr), background=bkg.level,
        background_err=bkg.err, background_source=bkg.source, aperture_correction=meas.aperture_correction,
        chi2_red=meas.chi2_red, n_masked_core=n_masked_core, position_fitted=meas.position_fitted,
        ujy_per_unit=k, n_ramp_pixels=n_ramp,
    )


def forced_photometry(
    stamp: Stamp,
    ra: float,
    dec: float,
    epsf: EPSFGrid | None,
    mask_bits: int,
    saturation_bits: int,
    method: str = "auto",
    aperture_radius_px: float = 2.0,
    annulus_px: tuple[float, float] = (4.0, 7.0),
    fit_position: bool = False,
    *,
    epoch_index: int | None = None,
    saturated_core: str = "ramp",
) -> PhotPoint:
    """Measure a point source at (ra, dec) on one stamp; returns a PhotPoint (flux in uJy).

    Args:
        stamp: pixel box with WCS, VARIANCE, FLAGS, header (OMEGA_MEDIAN) and wavelength maps.
        ra, dec: source position at the exposure epoch (ICRS degrees, apparent: pm + parallax applied).
        epsf: ePSF grid of the file, or None (aperture photometry only).
        mask_bits: FLAGS bits that invalidate a pixel (invalid + artifact groups; not SOURCE).
        saturation_bits: FLAGS bits that mean saturation (OVERFLOW): define ``saturated`` and are never
            used for the background.
        method: 'auto' | 'epsf' | 'aperture'.
        aperture_radius_px: aperture radius (also the radius over which ``flags`` are OR-ed).
        annulus_px: inner and outer radius of the background annulus.
        fit_position: fit the position (ePSF or centroid) instead of forcing the WCS position.
        epoch_index: copied into the PhotPoint.
        saturated_core: 'ramp' (default) measures a saturated source with the early-ramp slopes of its
            OVERFLOW / TRANSIENT pixels (see ``ramp_pixels``); 'wings' excludes them (wing fit).

    Raises:
        PhotometryError: the position is off the stamp, too few valid pixels, or an explicit ePSF fit failed.
    """
    return measure_source(
        stamp, ra, dec, epsf, mask_bits, saturation_bits, method, aperture_radius_px, annulus_px, fit_position,
        epoch_index=epoch_index, saturated_core=saturated_core,
    ).point


def measure_position(
    stamp: Stamp,
    ra: float,
    dec: float,
    epsf: EPSFGrid | None,
    mask_bits: int,
    saturation_bits: int,
    method: str = "auto",
    **kwargs: Any,
) -> ForcedResult:
    """Fit the position (and flux) of the source near (ra, dec); for astrometry and motion fits."""
    return measure_source(stamp, ra, dec, epsf, mask_bits, saturation_bits, method, fit_position=True, **kwargs)


def usable_for_motion(result: ForcedResult) -> bool:
    """True when the result has a fitted position with finite, positive sky errors."""
    return bool(
        result.position_fitted
        and math.isfinite(result.ra_err_mas)
        and math.isfinite(result.dec_err_mas)
        and result.ra_err_mas > 0
        and result.dec_err_mas > 0
    )


def motion_inputs(results: Sequence[ForcedResult]) -> dict[str, np.ndarray]:
    """Keyword arrays for ``motion.fit_proper_motion(**motion_inputs(results), parallax_offsets_mas=...)``.

    Results without a fitted position or finite errors are skipped (filter with ``usable_for_motion``
    first to keep parallax offsets aligned).
    """
    keep = [r for r in results if usable_for_motion(r)]
    return {
        "mjd": np.array([r.point.mjd for r in keep], dtype=float),
        "ra_deg": np.array([r.ra_deg for r in keep], dtype=float),
        "dec_deg": np.array([r.dec_deg for r in keep], dtype=float),
        "ra_err_mas": np.array([r.ra_err_mas for r in keep], dtype=float),
        "dec_err_mas": np.array([r.dec_err_mas for r in keep], dtype=float),
    }
