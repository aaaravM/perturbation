"""Propagate catalogue astrometry to observation epochs: barycentric space motion and annual parallax.

``barycentric_position`` applies rigorous space motion: the star moves uniformly along a straight line
relative to the solar-system barycentre (Gaia DR3 documentation sect. 4.1.7; Butkevich & Lindegren 2014,
A&A 570, A62). When parallax and radial velocity are both known this includes perspective acceleration
(1.3 mas/yr^2 for Barnard's Star, i.e. 0.16 arcsec between 2000 and 2016).

``apparent_position`` is the geocentric direction: the star's barycentric position minus the Earth's, so
annual parallax is included, but aberration and light deflection are not. That is the right quantity to
compare with positions measured on images whose WCS was fitted to Gaia stars (the fit absorbs aberration).
SPHEREx is in low Earth orbit; its ~7000 km offset from the geocentre moves Barnard's Star by < 0.03 mas.

Times are MJD (UTC). Where a dynamical time is needed, TT = UTC + 69.184 s is used (exact since 2017,
within 2 s for 2012-2016: far below any measurable effect). The Earth's barycentric position comes from
ERFA epv00 through astropy's builtin ephemeris (~5 km accuracy, no downloads). A missing or non-positive
parallax and a missing radial velocity count as zero: no perspective acceleration and no parallax shift.

The formulae are a numpy port of the research prototype that matched Kirkpatrick et al. (2021) Spitzer
astrometry of WISE 0855-0714 to 6-8 mas; tests cross-check them against astropy's apply_space_motion.
"""

from __future__ import annotations

import logging
from collections.abc import Sequence
from typing import overload

import astropy.units as u
import numpy as np
from astropy.coordinates import get_body_barycentric
from astropy.time import Time
from numpy.typing import ArrayLike, NDArray

from pxh.models import Astrometry

logger = logging.getLogger(__name__)

MJD_J2000 = 51544.5  # J2000.0 = JD 2451545.0
DAYS_PER_JULIAN_YEAR = 365.25
TT_MINUS_UTC_S = 69.184  # 37 leap seconds (since 2017-01-01) + 32.184 s
AU_KM = 1.495978707e8
_SECONDS_PER_DAY = 86400.0
_MAS_TO_RAD = np.pi / (180.0 * 3600.0 * 1000.0)
# 1 au/yr in km/s (4.740470464): converts radial velocity * parallax into a radial proper motion.
_KMS_PER_AU_PER_YR = AU_KM / (DAYS_PER_JULIAN_YEAR * _SECONDS_PER_DAY)

FloatArray = NDArray[np.float64]


# --- time helpers -------------------------------------------------------------------------------


@overload
def jyear_from_mjd(mjd: float) -> float: ...
@overload
def jyear_from_mjd(mjd: FloatArray | Sequence[float]) -> FloatArray: ...
def jyear_from_mjd(mjd: ArrayLike) -> float | FloatArray:
    """Julian year (e.g. 2016.0) of an MJD."""
    t = np.asarray(mjd, dtype=np.float64)
    out = 2000.0 + (t - MJD_J2000) / DAYS_PER_JULIAN_YEAR
    return float(out) if out.ndim == 0 else out


@overload
def mjd_from_jyear(jyear: float) -> float: ...
@overload
def mjd_from_jyear(jyear: FloatArray | Sequence[float]) -> FloatArray: ...
def mjd_from_jyear(jyear: ArrayLike) -> float | FloatArray:
    """MJD of a Julian year (inverse of ``jyear_from_mjd``)."""
    y = np.asarray(jyear, dtype=np.float64)
    out = MJD_J2000 + (y - 2000.0) * DAYS_PER_JULIAN_YEAR
    return float(out) if out.ndim == 0 else out


def _as_mjd_array(mjd: ArrayLike) -> FloatArray:
    t = np.asarray(mjd, dtype=np.float64)
    if not np.all(np.isfinite(t)):
        raise ValueError("mjd values must be finite")
    return t


# --- Earth ephemeris ----------------------------------------------------------------------------


@overload
def earth_barycentric_au(mjd: float) -> FloatArray: ...
@overload
def earth_barycentric_au(mjd: FloatArray | Sequence[float]) -> FloatArray: ...
def earth_barycentric_au(mjd: ArrayLike) -> FloatArray:
    """Barycentric position of the Earth (ICRS axes, au), shape ``mjd.shape + (3,)``.

    Uses astropy's builtin ephemeris (ERFA epv00), which never downloads anything. TT is passed as TDB
    (they differ by < 2 ms, 60 m of Earth motion): this skips astropy's TT->TDB step, which consults the
    leap-second table and warns "dubious year" for dates after it expires.
    """
    t = _as_mjd_array(mjd)
    tdb = Time(t + TT_MINUS_UTC_S / _SECONDS_PER_DAY, format="mjd", scale="tdb")
    xyz = get_body_barycentric("earth", tdb, ephemeris="builtin").xyz.to_value(u.au)
    return np.moveaxis(np.asarray(xyz, dtype=np.float64), 0, -1)


# --- space motion -------------------------------------------------------------------------------


def _normal_triad(ra_deg: float, dec_deg: float) -> tuple[FloatArray, FloatArray, FloatArray]:
    """Unit vectors towards local east (p), north (q) and the star (r)."""
    a, d = np.radians(ra_deg), np.radians(dec_deg)
    sa, ca, sd, cd = np.sin(a), np.cos(a), np.sin(d), np.cos(d)
    p = np.array([-sa, ca, 0.0])
    q = np.array([-sd * ca, -sd * sa, cd])
    r = np.array([cd * ca, cd * sa, sd])
    return p, q, r


def _usable_parallax_mas(astrometry: Astrometry) -> float:
    plx = astrometry.parallax_mas
    if plx is None or not np.isfinite(plx):
        return 0.0
    if plx <= 0.0:
        logger.debug("non-positive parallax %.3f mas treated as zero (%s)", plx, astrometry.source)
        return 0.0
    return float(plx)


def _space_motion(astrometry: Astrometry, mjd_flat: FloatArray) -> tuple[FloatArray, FloatArray]:
    """Barycentric unit vectors [N, 3] and parallaxes [N] (mas) at the given epochs."""
    p, q, r = _normal_triad(astrometry.ra_deg, astrometry.dec_deg)
    plx = _usable_parallax_mas(astrometry)
    rv = astrometry.rv_kms if astrometry.rv_kms is not None and np.isfinite(astrometry.rv_kms) else 0.0
    mu = (p * astrometry.pmra_masyr + q * astrometry.pmdec_masyr) * _MAS_TO_RAD  # rad/yr
    mu_r = rv * plx * _MAS_TO_RAD / _KMS_PER_AU_PER_YR  # radial proper motion, 1/yr
    tau = jyear_from_mjd(mjd_flat) - astrometry.ref_epoch  # yr
    # Distance ratio |b(t)| / |b(t0)| for straight-line motion; the inverse scales the parallax.
    growth = np.sqrt((1.0 + mu_r * tau) ** 2 + float(mu @ mu) * tau**2)
    vec = (r[None, :] * (1.0 + mu_r * tau)[:, None] + mu[None, :] * tau[:, None]) / growth[:, None]
    return vec, plx / growth


def _radec_deg(vec: FloatArray) -> tuple[FloatArray, FloatArray]:
    x, y, z = vec[..., 0], vec[..., 1], vec[..., 2]
    ra = np.degrees(np.arctan2(y, x)) % 360.0
    ra = np.where(ra >= 360.0, ra - 360.0, ra)
    dec = np.degrees(np.arctan2(z, np.hypot(x, y)))
    return ra, dec


def _shape_output(
    ra: FloatArray, dec: FloatArray, shape: tuple[int, ...]
) -> tuple[float, float] | tuple[FloatArray, FloatArray]:
    if shape == ():
        return float(ra[0]), float(dec[0])
    return ra.reshape(shape), dec.reshape(shape)


def _observer_vectors(t_flat: FloatArray, observer_bary_au: ArrayLike | None) -> FloatArray:
    if observer_bary_au is None:
        return earth_barycentric_au(t_flat)
    obs = np.asarray(observer_bary_au, dtype=np.float64)
    if obs.shape[-1:] != (3,):
        raise ValueError("observer_bary_au must have a trailing dimension of 3 (x, y, z in au)")
    return np.broadcast_to(obs.reshape(-1, 3), (t_flat.size, 3))


def _apparent_vectors(
    astrometry: Astrometry, t_flat: FloatArray, observer_bary_au: ArrayLike | None = None
) -> tuple[FloatArray, FloatArray]:
    """(barycentric unit vectors, observer-centric direction vectors, not normalised), both [N, 3]."""
    vec, plx = _space_motion(astrometry, t_flat)
    if not np.any(plx > 0.0):
        return vec, vec
    obs = _observer_vectors(t_flat, observer_bary_au)
    # Star at distance 1/plx (au) along vec, seen from obs; divided through by the distance.
    return vec, vec - (plx * _MAS_TO_RAD)[:, None] * obs


@overload
def barycentric_position(astrometry: Astrometry, mjd: float) -> tuple[float, float]: ...
@overload
def barycentric_position(
    astrometry: Astrometry, mjd: FloatArray | Sequence[float]
) -> tuple[FloatArray, FloatArray]: ...
def barycentric_position(
    astrometry: Astrometry, mjd: ArrayLike
) -> tuple[float, float] | tuple[FloatArray, FloatArray]:
    """ICRS (ra_deg, dec_deg) seen from the solar-system barycentre at each MJD (UTC).

    Scalar ``mjd`` gives floats; an array gives arrays of the same shape.
    """
    t = _as_mjd_array(mjd)
    vec, _ = _space_motion(astrometry, t.ravel())
    ra, dec = _radec_deg(vec)
    return _shape_output(ra, dec, t.shape)


@overload
def apparent_position(
    astrometry: Astrometry, mjd: float, observer_bary_au: ArrayLike | None = None
) -> tuple[float, float]: ...
@overload
def apparent_position(
    astrometry: Astrometry, mjd: FloatArray | Sequence[float], observer_bary_au: ArrayLike | None = None
) -> tuple[FloatArray, FloatArray]: ...
def apparent_position(
    astrometry: Astrometry, mjd: ArrayLike, observer_bary_au: ArrayLike | None = None
) -> tuple[float, float] | tuple[FloatArray, FloatArray]:
    """Geocentric ICRS (ra_deg, dec_deg) at each MJD (UTC): space motion plus annual parallax.

    ``observer_bary_au`` optionally replaces the Earth by another observer: barycentric positions in au,
    shape (3,) or ``mjd.shape + (3,)`` (e.g. a spacecraft in heliocentric orbit).
    """
    t = _as_mjd_array(mjd)
    _, seen = _apparent_vectors(astrometry, t.ravel(), observer_bary_au)
    ra, dec = _radec_deg(seen)
    return _shape_output(ra, dec, t.shape)


@overload
def parallax_offsets_mas(astrometry: Astrometry, mjd: float) -> tuple[float, float]: ...
@overload
def parallax_offsets_mas(
    astrometry: Astrometry, mjd: FloatArray | Sequence[float]
) -> tuple[FloatArray, FloatArray]: ...
def parallax_offsets_mas(
    astrometry: Astrometry, mjd: ArrayLike
) -> tuple[float, float] | tuple[FloatArray, FloatArray]:
    """Apparent minus barycentric position, as (dra_cosdec_mas, ddec_mas) tangent-plane offsets.

    Zero when the parallax is unknown. Subtract these from measured positions to fit proper motion alone.
    """
    t = _as_mjd_array(mjd)
    if _usable_parallax_mas(astrometry) == 0.0:
        zeros = np.zeros(t.size)
        return _shape_output(zeros, zeros.copy(), t.shape)
    vec, seen = _apparent_vectors(astrometry, t.ravel())
    x, y, z = vec[:, 0], vec[:, 1], vec[:, 2]
    rho = np.maximum(np.hypot(x, y), 1e-300)
    east = np.stack([-y / rho, x / rho, np.zeros_like(x)], axis=1)
    north = np.stack([-z * x / rho, -z * y / rho, rho], axis=1)
    along = np.sum(seen * vec, axis=1)
    xi = np.sum(seen * east, axis=1) / along / _MAS_TO_RAD
    eta = np.sum(seen * north, axis=1) / along / _MAS_TO_RAD
    return _shape_output(xi, eta, t.shape)


@overload
def parallax_factors(ra_deg: float, dec_deg: float, mjd: float) -> tuple[float, float]: ...
@overload
def parallax_factors(
    ra_deg: float, dec_deg: float, mjd: FloatArray | Sequence[float]
) -> tuple[FloatArray, FloatArray]: ...
def parallax_factors(
    ra_deg: float, dec_deg: float, mjd: ArrayLike
) -> tuple[float, float] | tuple[FloatArray, FloatArray]:
    """First-order parallax factors (f_ra, f_dec) for a geocentric observer at each MJD (UTC).

    The parallactic offset of a star with parallax ``plx`` (mas) is (plx * f_ra, plx * f_dec) mas in
    (RA*cos(Dec), Dec): the design-matrix columns for fitting parallax as a free parameter.
    """
    t = _as_mjd_array(mjd)
    earth = earth_barycentric_au(t.ravel())
    p, q, _ = _normal_triad(ra_deg, dec_deg)
    return _shape_output(-(earth @ p), -(earth @ q), t.shape)
