"""Centroids and effective-PSF (ePSF) fits for undersampled SPHEREx point sources.

SPHEREx pixels are 6.15 arcsec and the PSF FWHM is only 1.2-1.5 px, so an intensity-weighted centroid
is pulled toward the pixel centre. Positions and fluxes therefore come from a least-squares fit of the
effective PSF shipped in every Level-2 file (EPSF extension: 33x33 samples, 5x oversampled, summing to
1). The ePSF already includes the pixel response, so evaluating it at native pixel centres gives the
fraction of the flux that lands in each pixel (photutils ``ImagePSF(data=epsf * oversampling**2)``).

Pixels outside ``valid_mask`` (and NaNs) are left out of the fit; with the core masked a saturated star
is fitted on its wings (a "wing fit"). Because ~95% of the flux falls in the 3x3 core, wing fits need
bright stars, and on real SPHEREx data they are biased high by spill-over next to the core, so
pxh.photometry.forced keeps the OVERFLOW / TRANSIENT core pixels that still hold valid early-ramp slopes
and uses wing fits only as a fallback.

Coordinates are 0-based indices of the array passed in: pixel (x, y) is centred on ``data[y, x]``.
All functions are pure and thread-safe.
"""

from __future__ import annotations

import logging
import math
import warnings
from dataclasses import dataclass
from typing import NamedTuple

import numpy as np
from photutils.psf import ImagePSF
from scipy.optimize import least_squares

log = logging.getLogger(__name__)

__all__ = [
    "EPSFFit",
    "EPSFFitResult",
    "box_slices",
    "centroid_2dg_masked",
    "centroid_quadratic_masked",
    "fit_epsf",
    "fit_epsf_position",
    "make_psf_model",
    "render_psf",
    "valid_pixels",
    "windowed_centroid",
]

_MIN_EXTRA_DOF = 1  # pixels required beyond the number of free parameters


class EPSFFitResult(NamedTuple):
    """Compact ePSF fit result, unpackable as ``x, y, flux, x_err, y_err, chi2, ok``.

    ``chi2`` is the reduced chi-square (chi2 / dof) of the fit.
    """

    x: float
    y: float
    flux: float
    x_err: float
    y_err: float
    chi2: float
    ok: bool


@dataclass(frozen=True)
class EPSFFit:
    """Full ePSF fit result. Fluxes are in data units summed over pixels (e.g. MJy/sr x pixels)."""

    x: float
    y: float
    flux: float
    background: float  # constant background per pixel (0.0 when not fitted)
    x_err: float  # NaN when the position was held fixed
    y_err: float
    flux_err: float
    background_err: float
    cov_xy: float
    chi2: float  # total chi-square of the fit
    dof: int
    n_pix: int  # pixels used
    ok: bool
    fit_position: bool
    fit_background: bool
    message: str = ""

    @property
    def chi2_red(self) -> float:
        return self.chi2 / self.dof if self.dof > 0 else math.nan

    def as_tuple(self) -> EPSFFitResult:
        return EPSFFitResult(self.x, self.y, self.flux, self.x_err, self.y_err, self.chi2_red, self.ok)


# --- PSF model helpers ---------------------------------------------------------------------------


def make_psf_model(epsf_oversampled: np.ndarray, oversampling: int = 5) -> ImagePSF:
    """photutils model of a unit-flux ePSF table whose oversampled samples sum to 1."""
    arr = np.asarray(epsf_oversampled, dtype=float)
    if arr.ndim != 2:
        raise ValueError(f"ePSF must be a 2-D array, got shape {arr.shape}")
    if not np.all(np.isfinite(arr)):
        raise ValueError("ePSF contains non-finite values")
    if oversampling < 1:
        raise ValueError(f"oversampling must be >= 1, got {oversampling}")
    return ImagePSF(data=arr * float(oversampling) ** 2, oversampling=int(oversampling))


def render_psf(
    epsf_oversampled: np.ndarray | ImagePSF,
    shape: tuple[int, int],
    x: float,
    y: float,
    flux: float = 1.0,
    oversampling: int = 5,
) -> np.ndarray:
    """Pixel image of a point source of ``flux`` at (x, y) on a grid of ``shape`` (ny, nx)."""
    model = epsf_oversampled if isinstance(epsf_oversampled, ImagePSF) else make_psf_model(
        epsf_oversampled, oversampling
    )
    yy, xx = np.mgrid[0 : shape[0], 0 : shape[1]]
    return np.asarray(model.evaluate(xx.astype(float), yy.astype(float), flux, x, y), dtype=float)


def valid_pixels(
    data: np.ndarray, variance: np.ndarray | None = None, valid_mask: np.ndarray | None = None
) -> np.ndarray:
    """Boolean mask of usable pixels: finite data, finite positive variance and ``valid_mask``."""
    data = np.asarray(data)
    good = np.isfinite(data)
    if variance is not None:
        variance = np.asarray(variance)
        if variance.shape != data.shape:
            raise ValueError(f"variance shape {variance.shape} != data shape {data.shape}")
        good &= np.isfinite(variance) & (variance > 0)
    if valid_mask is not None:
        valid_mask = np.asarray(valid_mask, dtype=bool)
        if valid_mask.shape != data.shape:
            raise ValueError(f"valid_mask shape {valid_mask.shape} != data shape {data.shape}")
        good &= valid_mask
    return good


def _round_half_up(v: float) -> int:
    return math.floor(v + 0.5)


def _largest_odd(n: int) -> int:
    return int(n) if int(n) % 2 == 1 else int(n) - 1


def box_slices(shape: tuple[int, ...], x0: float, y0: float, box: int) -> tuple[slice, slice]:
    """(row, column) slices of a ``box`` x ``box`` window centred on the rounded (x0, y0), clipped."""
    half = max(int(box) // 2, 1)
    ix, iy = _round_half_up(x0), _round_half_up(y0)
    xa, xb = max(ix - half, 0), min(ix + half + 1, shape[1])
    ya, yb = max(iy - half, 0), min(iy + half + 1, shape[0])
    return slice(ya, max(ya, yb)), slice(xa, max(xa, xb))


# --- linear (fixed-position) solve ---------------------------------------------------------------


@dataclass(frozen=True)
class _LinearSolution:
    flux: float
    background: float
    cov: np.ndarray  # unscaled covariance of (flux[, background])
    chi2: float


def _linear_solve(
    psf: np.ndarray, d: np.ndarray, sig: np.ndarray, fit_background: bool
) -> _LinearSolution | None:
    cols = [psf] + ([np.ones_like(psf)] if fit_background else [])
    a = np.column_stack(cols) / sig[:, None]
    b = d / sig
    ata = a.T @ a
    try:
        cov = np.linalg.inv(ata)
    except np.linalg.LinAlgError:
        return None
    if not np.all(np.isfinite(cov)):
        return None
    p = cov @ (a.T @ b)
    r = b - a @ p
    bkg = float(p[1]) if fit_background else 0.0
    return _LinearSolution(flux=float(p[0]), background=bkg, cov=cov, chi2=float(r @ r))


def _coarse_start(
    model: ImagePSF,
    d: np.ndarray,
    sig: np.ndarray,
    xs: np.ndarray,
    ys: np.ndarray,
    x0: float,
    y0: float,
    radius: float,
    step: float,
    fit_background: bool,
) -> tuple[float, float]:
    """Best starting position on a coarse grid (minimum chi2 of the linear flux/background solve)."""
    best = (math.inf, x0, y0)
    offsets = np.arange(-radius, radius + 1e-9, step)
    for dy in offsets:
        for dx in offsets:
            if dx * dx + dy * dy > radius * radius + 1e-9:
                continue
            psf = model.evaluate(xs, ys, 1.0, x0 + dx, y0 + dy)
            sol = _linear_solve(psf, d, sig, fit_background)
            if sol is None or sol.flux <= 0:
                continue
            if sol.chi2 < best[0]:
                best = (sol.chi2, x0 + dx, y0 + dy)
    return best[1], best[2]


def _failed(x0: float, y0: float, n: int, fit_position: bool, fit_background: bool, msg: str) -> EPSFFit:
    nan = math.nan
    return EPSFFit(
        x=float(x0), y=float(y0), flux=nan, background=nan, x_err=nan, y_err=nan, flux_err=nan,
        background_err=nan, cov_xy=nan, chi2=nan, dof=0, n_pix=n, ok=False, fit_position=fit_position,
        fit_background=fit_background, message=msg,
    )


def _error_scale(chi2: float, dof: int, have_variance: bool) -> float:
    """Factor applied to the covariance: reduced chi2 (never below 1 when the variance is known)."""
    if dof <= 0 or not math.isfinite(chi2):
        return math.nan
    red = chi2 / dof
    return red if not have_variance else max(1.0, red)


# --- ePSF fit ------------------------------------------------------------------------------------


def fit_epsf(
    data: np.ndarray,
    variance: np.ndarray | None,
    valid_mask: np.ndarray | None,
    epsf_oversampled: np.ndarray,
    x0: float,
    y0: float,
    box: int = 7,
    oversampling: int = 5,
    *,
    fit_position: bool = True,
    fit_background: bool = True,
    max_shift: float | None = None,
    search_radius: float = 1.0,
) -> EPSFFit:
    """Least-squares fit of ``flux * ePSF(x - xc, y - yc) + background`` to the valid pixels of a box.

    Args:
        data: 2-D image (background need not be subtracted when ``fit_background``).
        variance: per-pixel variance (same shape), or None for uniform weights (errors then come from
            the residual scatter).
        valid_mask: True for usable pixels; masked pixels (saturated core, bad flags) are skipped.
        epsf_oversampled: ePSF table (e.g. 33x33, 5x oversampled) whose samples sum to 1.
        x0, y0: initial / forced position (0-based array coordinates).
        box: side of the square fitting box centred on the rounded (x0, y0).
        fit_position: fit (flux, x, y[, background]); otherwise a linear fit at fixed (x0, y0).
        fit_background: include a constant background term.
        max_shift: bound on |x - x0| and |y - y0| (default box / 2).
        search_radius: radius (px) of a coarse grid search for the starting position (0 disables).

    Errors come from the covariance scaled by the reduced chi2 (never scaled below 1 when a variance
    is given). ``ok`` is False when there are too few pixels, the fit did not converge, the position hit
    its bound, or (for position fits) the flux is not positive.
    """
    data = np.asarray(data, dtype=float)
    if data.ndim != 2:
        raise ValueError(f"data must be 2-D, got shape {data.shape}")
    good = valid_pixels(data, variance, valid_mask)
    sy, sx = box_slices(data.shape, x0, y0, box)
    yy, xx = np.mgrid[sy, sx]
    sel = good[sy, sx]
    d = data[sy, sx][sel]
    xs = xx[sel].astype(float)
    ys = yy[sel].astype(float)
    have_var = variance is not None
    sig = np.sqrt(np.asarray(variance, dtype=float)[sy, sx][sel]) if have_var else np.ones_like(d)
    n = int(d.size)
    npar = 1 + int(fit_background) + 2 * int(fit_position)
    if n < npar + _MIN_EXTRA_DOF:
        return _failed(x0, y0, n, fit_position, fit_background, f"only {n} valid pixels for {npar} parameters")

    model = make_psf_model(epsf_oversampled, oversampling)
    if not fit_position:
        return _fixed_position_fit(model, d, sig, xs, ys, x0, y0, n, fit_background, have_var)
    return _free_position_fit(
        model, d, sig, xs, ys, x0, y0, n, box, fit_background, have_var, max_shift, search_radius
    )


def _fixed_position_fit(
    model: ImagePSF,
    d: np.ndarray,
    sig: np.ndarray,
    xs: np.ndarray,
    ys: np.ndarray,
    x0: float,
    y0: float,
    n: int,
    fit_background: bool,
    have_var: bool,
) -> EPSFFit:
    psf = model.evaluate(xs, ys, 1.0, x0, y0)
    if not np.any(psf > 0):
        return _failed(x0, y0, n, False, fit_background, "PSF has no support on the valid pixels")
    sol = _linear_solve(psf, d, sig, fit_background)
    if sol is None:
        return _failed(x0, y0, n, False, fit_background, "singular linear system")
    dof = n - (1 + int(fit_background))
    scale = _error_scale(sol.chi2, dof, have_var)
    cov = sol.cov * scale
    return EPSFFit(
        x=float(x0), y=float(y0), flux=sol.flux, background=sol.background,
        x_err=math.nan, y_err=math.nan, flux_err=float(math.sqrt(cov[0, 0])),
        background_err=float(math.sqrt(cov[1, 1])) if fit_background else 0.0, cov_xy=math.nan,
        chi2=sol.chi2, dof=dof, n_pix=n, ok=bool(np.isfinite(sol.flux) and np.isfinite(cov[0, 0])),
        fit_position=False, fit_background=fit_background,
    )


def _free_position_fit(
    model: ImagePSF,
    d: np.ndarray,
    sig: np.ndarray,
    xs: np.ndarray,
    ys: np.ndarray,
    x0: float,
    y0: float,
    n: int,
    box: int,
    fit_background: bool,
    have_var: bool,
    max_shift: float | None,
    search_radius: float,
) -> EPSFFit:
    shift = float(max_shift) if max_shift is not None else max(int(box) // 2, 1)
    xstart, ystart = float(x0), float(y0)
    if search_radius > 0:
        xstart, ystart = _coarse_start(
            model, d, sig, xs, ys, x0, y0, min(search_radius, shift), 0.25, fit_background
        )
    start = _linear_solve(model.evaluate(xs, ys, 1.0, xstart, ystart), d, sig, fit_background)
    flux0 = start.flux if start is not None and start.flux > 0 else float(max(np.sum(d), 1e-12))
    p0 = [flux0, xstart, ystart] + ([start.background if start is not None else 0.0] if fit_background else [])
    lb = [-np.inf, x0 - shift, y0 - shift] + ([-np.inf] if fit_background else [])
    ub = [np.inf, x0 + shift, y0 + shift] + ([np.inf] if fit_background else [])
    p0[1] = float(np.clip(p0[1], lb[1] + 1e-6, ub[1] - 1e-6))
    p0[2] = float(np.clip(p0[2], lb[2] + 1e-6, ub[2] - 1e-6))

    def resid(p: np.ndarray) -> np.ndarray:
        m = model.evaluate(xs, ys, p[0], p[1], p[2])
        if fit_background:
            m = m + p[3]
        return (d - m) / sig

    def jac(p: np.ndarray) -> np.ndarray:
        dflux, dx0, dy0 = model.fit_deriv(xs, ys, p[0], p[1], p[2])
        cols = [dflux, dx0, dy0] + ([np.ones_like(d)] if fit_background else [])
        return -np.column_stack(cols) / sig[:, None]

    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        res = least_squares(
            resid, np.asarray(p0, float), jac=jac, bounds=(lb, ub), method="trf", x_scale="jac",
            xtol=1e-10, ftol=1e-10, gtol=1e-10, max_nfev=200,
        )
    p = res.x
    r = resid(p)
    chi2 = float(r @ r)
    npar = len(p)
    dof = n - npar
    jm = jac(p)
    try:
        cov = np.linalg.inv(jm.T @ jm)
    except np.linalg.LinAlgError:
        return _failed(x0, y0, n, True, fit_background, "singular covariance")
    cov = cov * _error_scale(chi2, dof, have_var)
    errs = np.sqrt(np.clip(np.diag(cov), 0.0, None))
    at_bound = abs(p[1] - x0) >= shift - 1e-4 or abs(p[2] - y0) >= shift - 1e-4
    ok = bool(res.success and dof > 0 and np.all(np.isfinite(errs)) and p[0] > 0 and not at_bound)
    msg = "" if ok else ("position at bound" if at_bound else (res.message if not res.success else "bad fit"))
    return EPSFFit(
        x=float(p[1]), y=float(p[2]), flux=float(p[0]), background=float(p[3]) if fit_background else 0.0,
        x_err=float(errs[1]), y_err=float(errs[2]), flux_err=float(errs[0]),
        background_err=float(errs[3]) if fit_background else 0.0, cov_xy=float(cov[1, 2]),
        chi2=chi2, dof=dof, n_pix=n, ok=ok, fit_position=True, fit_background=fit_background, message=msg,
    )


def fit_epsf_position(
    data: np.ndarray,
    variance: np.ndarray | None,
    valid_mask: np.ndarray | None,
    epsf_oversampled: np.ndarray,
    x0: float,
    y0: float,
    box: int = 7,
    oversampling: int = 5,
) -> EPSFFitResult:
    """Fit flux, x, y and a constant background with the ePSF; returns (x, y, flux, x_err, y_err, chi2, ok).

    ``chi2`` is the reduced chi-square. See ``fit_epsf`` for the full result (flux error, background,
    covariance) and options.
    """
    return fit_epsf(data, variance, valid_mask, epsf_oversampled, x0, y0, box, oversampling).as_tuple()


# --- simple centroids (fallbacks / comparison) ---------------------------------------------------


def _cutout(
    data: np.ndarray, valid_mask: np.ndarray | None, x0: float, y0: float, box: int
) -> tuple[np.ndarray, np.ndarray, int, int]:
    data = np.asarray(data, dtype=float)
    good = valid_pixels(data, None, valid_mask)
    sy, sx = box_slices(data.shape, x0, y0, box)
    return data[sy, sx], good[sy, sx], sx.start, sy.start


def centroid_quadratic_masked(
    data: np.ndarray, valid_mask: np.ndarray | None, x0: float, y0: float, box: int = 5
) -> tuple[float, float]:
    """photutils 2-D quadratic centroid in a ``box`` around (x0, y0), skipping invalid pixels.

    Expects background-subtracted data. Returns (nan, nan) when the fit fails.
    """
    from photutils.centroids import centroid_quadratic

    box = int(box) | 1  # photutils needs an odd box
    sub, good, xa, ya = _cutout(data, valid_mask, x0, y0, box + 2)
    fit_box = min(box, _largest_odd(min(sub.shape)))
    if int(good.sum()) < 6 or fit_box < 3:
        return math.nan, math.nan
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        try:
            cx, cy = centroid_quadratic(
                np.where(good, sub, 0.0), mask=~good, fit_boxsize=fit_box, xpeak=x0 - xa, ypeak=y0 - ya
            )
        except (ValueError, np.linalg.LinAlgError) as exc:
            log.debug("quadratic centroid failed: %s", exc)
            return math.nan, math.nan
    if not (np.isfinite(cx) and np.isfinite(cy)):
        return math.nan, math.nan
    return float(cx + xa), float(cy + ya)


def centroid_2dg_masked(
    data: np.ndarray,
    valid_mask: np.ndarray | None,
    x0: float,
    y0: float,
    box: int = 7,
    error: np.ndarray | None = None,
) -> tuple[float, float]:
    """photutils 2-D Gaussian centroid of a ``box`` around (x0, y0), skipping invalid pixels.

    Expects background-subtracted data. Returns (nan, nan) when the fit fails.
    """
    from photutils.centroids import centroid_2dg

    sub, good, xa, ya = _cutout(data, valid_mask, x0, y0, box)
    if int(good.sum()) < 6:
        return math.nan, math.nan
    err_sub = None
    if error is not None:
        sy, sx = box_slices(np.shape(data), x0, y0, box)
        err_sub = np.asarray(error, dtype=float)[sy, sx]
        good = good & np.isfinite(err_sub) & (err_sub > 0)
        err_sub = np.where(good, err_sub, 1.0)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        try:
            cx, cy = centroid_2dg(np.where(good, sub, 0.0), error=err_sub, mask=~good)
        except (ValueError, np.linalg.LinAlgError) as exc:
            log.debug("2-D Gaussian centroid failed: %s", exc)
            return math.nan, math.nan
    if not (np.isfinite(cx) and np.isfinite(cy)):
        return math.nan, math.nan
    return float(cx + xa), float(cy + ya)


def windowed_centroid(
    data: np.ndarray,
    valid_mask: np.ndarray | None,
    x0: float,
    y0: float,
    sigma_px: float = 1.2,
    radius_px: float = 3.5,
    max_iter: int = 30,
    tol_px: float = 1e-4,
) -> tuple[float, float]:
    """Iterative Gaussian-windowed centroid (robust for faint sources and co-adds).

    Expects background-subtracted data. Returns (nan, nan) if the windowed flux is not positive.
    """
    data = np.asarray(data, dtype=float)
    good = valid_pixels(data, None, valid_mask)
    yy, xx = np.mgrid[0 : data.shape[0], 0 : data.shape[1]]
    vals = np.where(good, data, 0.0)
    cx, cy = float(x0), float(y0)
    for _ in range(max_iter):
        r2 = (xx - cx) ** 2 + (yy - cy) ** 2
        w = np.exp(-r2 / (2.0 * sigma_px**2)) * (r2 <= radius_px**2) * good
        s = float(np.sum(w * vals))
        if s <= 0:
            return math.nan, math.nan
        nx_ = float(np.sum(w * vals * xx) / s)
        ny_ = float(np.sum(w * vals * yy) / s)
        done = abs(nx_ - cx) < tol_px and abs(ny_ - cy) < tol_px
        cx, cy = nx_, ny_
        if done:
            break
    return cx, cy
