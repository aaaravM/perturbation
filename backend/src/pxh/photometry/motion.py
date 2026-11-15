"""Proper-motion fits from per-exposure SPHEREx positions, with parallax removal and sigma clipping.

Positions are converted to gnomonic (tangent-plane) offsets in mas about their mean direction:
``xi`` points east (it is already dRA * cos(dec)) and ``eta`` north. The caller supplies the parallax
displacement of every measurement (apparent minus barycentric, e.g. from ``parallax_offsets_mas``),
which is subtracted before fitting ``offset = offset0 + pm * (t - ref)`` independently on each axis by
weighted least squares, with iterative sigma clipping. Errors are scaled by sqrt(reduced chi2) per axis
whenever the scatter exceeds the quoted errors.

Conventions follow pxh.models: degrees, MJD (UTC), pmra = mu_alpha* in mas/yr, position angles in
degrees east of north. Time differences use Julian years (365.25 d).
"""

from __future__ import annotations

import logging
import math
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

import numpy as np
from numpy.typing import ArrayLike

from pxh import config

log = logging.getLogger(__name__)

__all__ = [
    "MotionFit",
    "SkyPosition",
    "compare_to_catalog",
    "displacement_between",
    "fit_proper_motion",
    "mean_direction",
    "mean_positions_by_epoch",
    "parallax_offsets_mas",
    "position_angle_deg",
    "tangent_offsets_mas",
    "tangent_to_radec",
    "wrap_angle_deg",
]

MAS_PER_RAD = math.degrees(1.0) * 3.6e6
DAYS_PER_JULIAN_YEAR = 365.25
AU_KM = 149_597_870.7
_MIN_POINTS = 3


# --- spherical helpers ---------------------------------------------------------------------------


def _wrap360(deg: ArrayLike) -> np.ndarray:
    """Angles in [0, 360): ``x % 360`` alone returns 360.0 for tiny negative x."""
    w = np.mod(np.asarray(deg, dtype=float), 360.0)
    return np.where(w >= 360.0, 0.0, w)[()]  # [()] keeps scalars scalar


def tangent_offsets_mas(
    ra_deg: ArrayLike, dec_deg: ArrayLike, ra0_deg: float, dec0_deg: float
) -> tuple[np.ndarray, np.ndarray]:
    """Gnomonic offsets (xi east, eta north) in mas of (ra, dec) about the tangent point (ra0, dec0)."""
    a = np.radians(np.asarray(ra_deg, dtype=float))
    d = np.radians(np.asarray(dec_deg, dtype=float))
    a0, d0 = math.radians(ra0_deg), math.radians(dec0_deg)
    cos_c = math.sin(d0) * np.sin(d) + math.cos(d0) * np.cos(d) * np.cos(a - a0)
    xi = np.cos(d) * np.sin(a - a0) / cos_c
    eta = (math.cos(d0) * np.sin(d) - math.sin(d0) * np.cos(d) * np.cos(a - a0)) / cos_c
    return xi * MAS_PER_RAD, eta * MAS_PER_RAD


def tangent_to_radec(
    xi_mas: ArrayLike, eta_mas: ArrayLike, ra0_deg: float, dec0_deg: float
) -> tuple[np.ndarray, np.ndarray]:
    """Inverse gnomonic projection: tangent-plane offsets (mas) about (ra0, dec0) -> (ra, dec) degrees."""
    x = np.asarray(xi_mas, dtype=float) / MAS_PER_RAD
    y = np.asarray(eta_mas, dtype=float) / MAS_PER_RAD
    a0, d0 = math.radians(ra0_deg), math.radians(dec0_deg)
    den = math.cos(d0) - y * math.sin(d0)
    ra = a0 + np.arctan2(x, den)
    dec = np.arctan2(math.sin(d0) + y * math.cos(d0), np.hypot(x, den))
    return _wrap360(np.degrees(ra)), np.degrees(dec)


def mean_direction(
    ra_deg: ArrayLike, dec_deg: ArrayLike, weights: ArrayLike | None = None
) -> tuple[float, float]:
    """(Weighted) mean direction of a set of positions, via the mean unit vector."""
    a = np.radians(np.asarray(ra_deg, dtype=float))
    d = np.radians(np.asarray(dec_deg, dtype=float))
    w = np.ones_like(a) if weights is None else np.asarray(weights, dtype=float)
    v = np.array([np.sum(w * np.cos(d) * np.cos(a)), np.sum(w * np.cos(d) * np.sin(a)), np.sum(w * np.sin(d))])
    norm = float(np.linalg.norm(v))
    total = float(np.sum(np.abs(w)))
    if not (math.isfinite(norm) and total > 0 and norm > 1e-9 * total):
        raise ValueError("cannot average positions (empty or antipodal input)")
    v /= norm
    return float(_wrap360(math.degrees(math.atan2(v[1], v[0])))), math.degrees(math.asin(float(np.clip(v[2], -1, 1))))


def position_angle_deg(east: ArrayLike, north: ArrayLike) -> np.ndarray | float:
    """Position angle (degrees east of north, in [0, 360)) of a displacement or motion vector."""
    pa = _wrap360(np.degrees(np.arctan2(np.asarray(east, dtype=float), np.asarray(north, dtype=float))))
    return float(pa) if np.ndim(pa) == 0 else pa


def wrap_angle_deg(angle: ArrayLike) -> np.ndarray | float:
    """Wrap angles (degrees) into [-180, 180)."""
    w = (np.asarray(angle, dtype=float) + 180.0) % 360.0 - 180.0
    return float(w) if np.ndim(w) == 0 else w


def parallax_offsets_mas(
    ra_deg: ArrayLike,
    dec_deg: ArrayLike,
    parallax_mas: float,
    mjd: ArrayLike,
    observer_geocentric_km: ArrayLike | None = None,
) -> tuple[np.ndarray, np.ndarray]:
    """Parallax displacement (apparent minus barycentric) in mas: (dra*, ddec) at each MJD (UTC).

    The observer is the Earth (astropy built-in ephemeris, no download) plus an optional geocentric
    offset in km (e.g. the SPHEREx header X_SC, Y_SC, Z_SC; [3] or [N, 3], ICRS axes). Uses the
    standard parallax factors: dxi = plx (X sin a - Y cos a), deta = plx (X cos a sin d + Y sin a sin d
    - Z cos d), with (X, Y, Z) the observer's barycentric position in au.
    """
    import astropy.units as u
    from astropy.coordinates import get_body_barycentric
    from astropy.time import Time

    t = np.atleast_1d(np.asarray(mjd, dtype=float))
    earth = get_body_barycentric("earth", Time(t, format="mjd", scale="utc"))
    xyz = np.vstack([earth.x.to_value(u.au), earth.y.to_value(u.au), earth.z.to_value(u.au)]).T
    if observer_geocentric_km is not None:
        geo = np.asarray(observer_geocentric_km, dtype=float).reshape(-1, 3) / AU_KM
        xyz = xyz + geo
    a = np.radians(np.broadcast_to(np.asarray(ra_deg, dtype=float), t.shape))
    d = np.radians(np.broadcast_to(np.asarray(dec_deg, dtype=float), t.shape))
    x, y, z = xyz[:, 0], xyz[:, 1], xyz[:, 2]
    dxi = parallax_mas * (x * np.sin(a) - y * np.cos(a))
    deta = parallax_mas * (x * np.cos(a) * np.sin(d) + y * np.sin(a) * np.sin(d) - z * np.cos(d))
    return dxi, deta


# --- proper-motion fit ---------------------------------------------------------------------------


@dataclass(frozen=True, eq=False)
class MotionFit:
    """Linear proper-motion fit. Motions in mas/yr, positions at ``ref_mjd`` (parallax removed)."""

    pmra_masyr: float  # mu_alpha* (east)
    pmdec_masyr: float
    pmra_err_masyr: float
    pmdec_err_masyr: float
    total_masyr: float
    total_err_masyr: float
    pa_deg: float  # east of north, [0, 360)
    pa_err_deg: float
    ra0_deg: float
    dec0_deg: float
    ra0_err_mas: float  # error of the RA* (east) offset
    dec0_err_mas: float
    ref_mjd: float
    chi2: float  # both axes, used points only
    dof: int
    n_used: int
    n_total: int
    used: np.ndarray  # bool [N], False for sigma-clipped points
    residuals_mas: np.ndarray  # [N, 2] (dra*, ddec) observed minus model, parallax removed
    time_span_days: float  # of the used points
    error_scale: tuple[float, float]  # sqrt(max(1, reduced chi2)) applied to (RA*, Dec) errors

    @property
    def chi2_red(self) -> float:
        return self.chi2 / self.dof if self.dof > 0 else math.nan

    def to_dict(self) -> dict[str, Any]:
        """JSON-ready summary (lists instead of arrays, NaN -> None)."""

        def f(v: float) -> float | None:
            return float(v) if v is not None and math.isfinite(v) else None

        return {
            "pmra_masyr": f(self.pmra_masyr), "pmdec_masyr": f(self.pmdec_masyr),
            "pmra_err_masyr": f(self.pmra_err_masyr), "pmdec_err_masyr": f(self.pmdec_err_masyr),
            "total_masyr": f(self.total_masyr), "total_err_masyr": f(self.total_err_masyr),
            "pa_deg": f(self.pa_deg), "pa_err_deg": f(self.pa_err_deg),
            "ra0_deg": f(self.ra0_deg), "dec0_deg": f(self.dec0_deg),
            "ra0_err_mas": f(self.ra0_err_mas), "dec0_err_mas": f(self.dec0_err_mas),
            "ref_mjd": f(self.ref_mjd), "chi2": f(self.chi2), "dof": int(self.dof),
            "chi2_red": f(self.chi2_red), "n_used": int(self.n_used), "n_total": int(self.n_total),
            "time_span_days": f(self.time_span_days),
            "used": [bool(u) for u in self.used],
            "residuals_mas": [[f(a), f(b)] for a, b in self.residuals_mas],
            "error_scale": [f(self.error_scale[0]), f(self.error_scale[1])],
        }


@dataclass(frozen=True)
class _Line:
    intercept: float
    slope: float
    cov: np.ndarray  # unscaled 2x2 covariance of (intercept, slope)
    chi2: float


def _wls_line(dt: np.ndarray, v: np.ndarray, err: np.ndarray) -> _Line:
    w = 1.0 / err**2
    s, sx, sxx = np.sum(w), np.sum(w * dt), np.sum(w * dt * dt)
    sy, sxy = np.sum(w * v), np.sum(w * dt * v)
    det = s * sxx - sx * sx
    if det <= 0 or not math.isfinite(det):
        raise ValueError("degenerate time sampling: need at least two distinct epochs")
    a = (sxx * sy - sx * sxy) / det
    b = (s * sxy - sx * sy) / det
    cov = np.array([[sxx, -sx], [-sx, s]]) / det
    r = v - a - b * dt
    return _Line(float(a), float(b), cov, float(np.sum(w * r * r)))


def _as_1d(name: str, values: ArrayLike, n: int) -> np.ndarray:
    arr = np.asarray(values, dtype=float)
    if arr.ndim == 0:
        arr = np.full(n, float(arr))
    if arr.shape != (n,):
        raise ValueError(f"{name} must be a scalar or have shape ({n},), got {arr.shape}")
    return arr


def _parse_parallax(offsets: Any, n: int) -> np.ndarray:
    """Accept a pair (dra*, ddec) of length-N arrays, or an [N, 2] array; return [2, N]."""
    if offsets is None:
        return np.zeros((2, n))
    arr = np.asarray(offsets, dtype=float)
    if arr.shape == (2, n):
        return arr
    if arr.shape == (n, 2):
        return arr.T
    raise ValueError(f"parallax_offsets_mas must be (dra*, ddec) arrays of length {n}, got shape {arr.shape}")


def _clip_mask(
    chi_x: np.ndarray, chi_y: np.ndarray, used: np.ndarray, nsigma: float
) -> np.ndarray:
    """Keep points within nsigma x max(1, robust scatter of the normalised residuals) on both axes."""
    sx = max(1.0, 1.4826 * float(np.median(np.abs(chi_x[used]))))
    sy = max(1.0, 1.4826 * float(np.median(np.abs(chi_y[used]))))
    return (np.abs(chi_x) <= nsigma * sx) & (np.abs(chi_y) <= nsigma * sy)


def fit_proper_motion(
    mjd: ArrayLike,
    ra_deg: ArrayLike,
    dec_deg: ArrayLike,
    ra_err_mas: ArrayLike,
    dec_err_mas: ArrayLike,
    parallax_offsets_mas: Any = None,
    ref_mjd: float | None = None,
    sigma_clip: float | None = 3.0,
    max_iter: int = 10,
) -> MotionFit:
    """Weighted linear proper-motion fit with parallax removal and iterative sigma clipping.

    Args:
        mjd: epochs (MJD, UTC) of each position.
        ra_deg, dec_deg: measured positions (ICRS degrees), as observed (parallax included).
        ra_err_mas: 1-sigma error of the RA* (east, i.e. dRA cos dec) coordinate in mas; scalar or [N].
        dec_err_mas: 1-sigma Dec error in mas; scalar or [N].
        parallax_offsets_mas: (dra*, ddec) parallax displacement of each measurement in mas (apparent
            minus barycentric), subtracted before fitting; or an [N, 2] array; or None.
        ref_mjd: epoch of the fitted reference position (default: mean of ``mjd``).
        sigma_clip: clip points whose normalised residual exceeds this many sigma on either axis, where
            sigma is max(1, robust scatter); None or 0 disables clipping.
        max_iter: maximum clipping iterations.
    """
    t = np.asarray(mjd, dtype=float).ravel()
    n = t.size
    ra = _as_1d("ra_deg", ra_deg, n)
    dec = _as_1d("dec_deg", dec_deg, n)
    ex = _as_1d("ra_err_mas", ra_err_mas, n)
    ey = _as_1d("dec_err_mas", dec_err_mas, n)
    plx = _parse_parallax(parallax_offsets_mas, n)
    if n < _MIN_POINTS:
        raise ValueError(f"need at least {_MIN_POINTS} positions, got {n}")
    finite = np.isfinite(t) & np.isfinite(ra) & np.isfinite(dec) & np.isfinite(plx).all(axis=0)
    if not np.all(finite & np.isfinite(ex) & np.isfinite(ey)):
        raise ValueError("non-finite times, positions, errors or parallax offsets")
    if np.any(ex <= 0) or np.any(ey <= 0):
        raise ValueError("position errors must be positive")
    if np.unique(t).size < 2:
        raise ValueError("need at least two distinct epochs")

    ra_c, dec_c = mean_direction(ra, dec)
    xi, eta = tangent_offsets_mas(ra, dec, ra_c, dec_c)
    xi, eta = xi - plx[0], eta - plx[1]
    ref = float(np.mean(t)) if ref_mjd is None else float(ref_mjd)
    dt = (t - ref) / DAYS_PER_JULIAN_YEAR

    used = np.ones(n, dtype=bool)
    clip = sigma_clip is not None and sigma_clip > 0
    for _ in range(max(1, max_iter)):
        lx = _wls_line(dt[used], xi[used], ex[used])
        ly = _wls_line(dt[used], eta[used], ey[used])
        if not clip:
            break
        chi_x = (xi - lx.intercept - lx.slope * dt) / ex
        chi_y = (eta - ly.intercept - ly.slope * dt) / ey
        new = _clip_mask(chi_x, chi_y, used, float(sigma_clip))
        if new.sum() < _MIN_POINTS or np.unique(t[new]).size < 2:
            log.warning("sigma clipping would leave too few points; keeping %d of %d", used.sum(), n)
            break
        if np.array_equal(new, used):
            break
        used = new
    else:
        lx = _wls_line(dt[used], xi[used], ex[used])
        ly = _wls_line(dt[used], eta[used], ey[used])

    return _build_fit(t, dt, xi, eta, used, lx, ly, ra_c, dec_c, ref)


def _build_fit(
    t: np.ndarray,
    dt: np.ndarray,
    xi: np.ndarray,
    eta: np.ndarray,
    used: np.ndarray,
    lx: _Line,
    ly: _Line,
    ra_c: float,
    dec_c: float,
    ref: float,
) -> MotionFit:
    n_used = int(used.sum())
    dof_axis = n_used - 2
    scales = []
    for line in (lx, ly):
        red = line.chi2 / dof_axis if dof_axis > 0 else 1.0
        scales.append(math.sqrt(max(1.0, red)))
    cx, cy = lx.cov * scales[0] ** 2, ly.cov * scales[1] ** 2
    pmra, pmdec = lx.slope, ly.slope
    var_ra, var_dec = float(cx[1, 1]), float(cy[1, 1])
    total = math.hypot(pmra, pmdec)
    if total > 0:
        total_err = math.sqrt(pmra**2 * var_ra + pmdec**2 * var_dec) / total
        pa_err = math.degrees(math.sqrt(pmdec**2 * var_ra + pmra**2 * var_dec) / total**2)
    else:
        total_err, pa_err = math.sqrt(0.5 * (var_ra + var_dec)), 180.0
    ra0, dec0 = tangent_to_radec(lx.intercept, ly.intercept, ra_c, dec_c)
    resid = np.column_stack([xi - lx.intercept - lx.slope * dt, eta - ly.intercept - ly.slope * dt])
    return MotionFit(
        pmra_masyr=pmra, pmdec_masyr=pmdec,
        pmra_err_masyr=math.sqrt(var_ra), pmdec_err_masyr=math.sqrt(var_dec),
        total_masyr=total, total_err_masyr=total_err,
        pa_deg=float(position_angle_deg(pmra, pmdec)), pa_err_deg=min(pa_err, 180.0),
        ra0_deg=float(ra0), dec0_deg=float(dec0),
        ra0_err_mas=math.sqrt(float(cx[0, 0])), dec0_err_mas=math.sqrt(float(cy[0, 0])),
        ref_mjd=ref, chi2=lx.chi2 + ly.chi2, dof=2 * n_used - 4, n_used=n_used, n_total=int(t.size),
        used=used.copy(), residuals_mas=resid,
        time_span_days=float(np.ptp(t[used])), error_scale=(scales[0], scales[1]),
    )


def compare_to_catalog(
    fit: MotionFit,
    pmra_cat: float,
    pmdec_cat: float,
    pmra_cat_err: float = 0.0,
    pmdec_cat_err: float = 0.0,
) -> dict[str, float]:
    """Compare a fitted motion with a catalog value (mas/yr; pass the local value at ``fit.ref_mjd``).

    Returns ratio (fitted / catalog total), delta_masyr (length of the vector difference),
    pa_diff_deg (fitted minus catalog, wrapped to [-180, 180)), n_sigma (Mahalanobis distance of the
    vector difference, diagonal errors) plus the per-component differences and catalog totals.
    """
    total_cat = math.hypot(pmra_cat, pmdec_cat)
    dra, ddec = fit.pmra_masyr - pmra_cat, fit.pmdec_masyr - pmdec_cat
    sx = math.hypot(fit.pmra_err_masyr, pmra_cat_err)
    sy = math.hypot(fit.pmdec_err_masyr, pmdec_cat_err)
    n_sigma = math.hypot(dra / sx, ddec / sy) if sx > 0 and sy > 0 else math.nan
    pa_cat = float(position_angle_deg(pmra_cat, pmdec_cat))
    return {
        "ratio": fit.total_masyr / total_cat if total_cat > 0 else math.nan,
        "delta_masyr": math.hypot(dra, ddec),
        "pa_diff_deg": float(wrap_angle_deg(fit.pa_deg - pa_cat)),
        "n_sigma": n_sigma,
        "dpmra_masyr": dra,
        "dpmdec_masyr": ddec,
        "delta_total_masyr": fit.total_masyr - total_cat,
        "n_sigma_total": (fit.total_masyr - total_cat) / fit.total_err_masyr if fit.total_err_masyr > 0 else math.nan,
        "total_cat_masyr": total_cat,
        "pa_cat_deg": pa_cat,
    }


# --- epoch positions and displacements -------------------------------------------------------------


@dataclass(frozen=True)
class SkyPosition:
    """A (mean) sky position at an epoch, with optional errors in mas (RA* and Dec)."""

    mjd: float
    ra_deg: float
    dec_deg: float
    ra_err_mas: float = math.nan
    dec_err_mas: float = math.nan
    n: int = 1
    label: str = ""


def mean_positions_by_epoch(
    mjd: ArrayLike,
    ra_deg: ArrayLike,
    dec_deg: ArrayLike,
    ra_err_mas: ArrayLike,
    dec_err_mas: ArrayLike,
    epoch_index: Sequence[int | None],
) -> list[SkyPosition]:
    """Inverse-variance weighted mean position per epoch (sorted by epoch index; None last).

    The error of each mean is scaled by sqrt(reduced chi2) of the positions about it when > 1.
    """
    t = np.asarray(mjd, dtype=float).ravel()
    n = t.size
    ra, dec = _as_1d("ra_deg", ra_deg, n), _as_1d("dec_deg", dec_deg, n)
    ex, ey = _as_1d("ra_err_mas", ra_err_mas, n), _as_1d("dec_err_mas", dec_err_mas, n)
    if len(epoch_index) != n:
        raise ValueError("epoch_index must have one entry per position")
    keys = sorted({e for e in epoch_index}, key=lambda e: (e is None, -1 if e is None else e))
    out: list[SkyPosition] = []
    for key in keys:
        sel = np.array([e == key for e in epoch_index]) & np.isfinite(ra) & np.isfinite(dec)
        sel &= np.isfinite(ex) & np.isfinite(ey) & (ex > 0) & (ey > 0)
        if not sel.any():
            continue
        out.append(_mean_position(t[sel], ra[sel], dec[sel], ex[sel], ey[sel], key))
    return out


def _mean_position(
    t: np.ndarray, ra: np.ndarray, dec: np.ndarray, ex: np.ndarray, ey: np.ndarray, key: int | None
) -> SkyPosition:
    ra_c, dec_c = mean_direction(ra, dec)
    xi, eta = tangent_offsets_mas(ra, dec, ra_c, dec_c)
    errs = []
    means = []
    for v, e in ((xi, ex), (eta, ey)):
        w = 1.0 / e**2
        m = float(np.sum(w * v) / np.sum(w))
        err = 1.0 / math.sqrt(float(np.sum(w)))
        if v.size > 1:
            red = float(np.sum(w * (v - m) ** 2)) / (v.size - 1)
            err *= math.sqrt(max(1.0, red))
        means.append(m)
        errs.append(err)
    ra_m, dec_m = tangent_to_radec(means[0], means[1], ra_c, dec_c)
    return SkyPosition(
        mjd=float(np.mean(t)), ra_deg=float(ra_m), dec_deg=float(dec_m), ra_err_mas=errs[0],
        dec_err_mas=errs[1], n=int(t.size), label="" if key is None else f"epoch {key}",
    )


def displacement_between(
    first: SkyPosition, last: SkyPosition, *, pixel_scale_arcsec: float = config.PIXEL_SCALE_ARCSEC
) -> dict[str, float]:
    """Shift from ``first`` to ``last`` (e.g. first vs last epoch) in arcsec and pixels.

    Returns dra_arcsec (east), ddec_arcsec, sep_arcsec, sep_px, pa_deg (east of north), dt_days,
    rate_arcsec_yr, and, when both positions have errors, sep_err_arcsec and n_sigma (significance of
    the shift against a static source).
    """
    xi, eta = tangent_offsets_mas(last.ra_deg, last.dec_deg, first.ra_deg, first.dec_deg)
    dx, dy = float(xi) / 1000.0, float(eta) / 1000.0
    sep = math.hypot(dx, dy)
    dt_days = float(last.mjd - first.mjd)
    out = {
        "dra_arcsec": dx,
        "ddec_arcsec": dy,
        "sep_arcsec": sep,
        "sep_px": sep / pixel_scale_arcsec,
        "pa_deg": float(position_angle_deg(dx, dy)),
        "dt_days": dt_days,
        "rate_arcsec_yr": sep / (dt_days / DAYS_PER_JULIAN_YEAR) if dt_days != 0 else math.nan,
        "sep_err_arcsec": math.nan,
        "n_sigma": math.nan,
    }
    sx = math.hypot(first.ra_err_mas, last.ra_err_mas) / 1000.0
    sy = math.hypot(first.dec_err_mas, last.dec_err_mas) / 1000.0
    if math.isfinite(sx) and math.isfinite(sy) and sx > 0 and sy > 0:
        out["n_sigma"] = math.hypot(dx / sx, dy / sy)
        out["sep_err_arcsec"] = (
            math.sqrt((dx * sx) ** 2 + (dy * sy) ** 2) / sep if sep > 0 else math.hypot(sx, sy) / math.sqrt(2)
        )
    return out
