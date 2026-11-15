"""Tests for pxh.sky.propagate: space motion, annual parallax and the Earth ephemeris (offline).

Reference positions were computed during research with the validated prototype; the implementation is
also cross-checked against astropy's SkyCoord.apply_space_motion (ERFA pmsafe), against JPL DE441 Earth
positions, and against published Spitzer astrometry of WISE 0855-0714 (Kirkpatrick et al. 2021).
"""

from __future__ import annotations

import json
from pathlib import Path

import astropy.units as u
import numpy as np
import pytest
from astropy.coordinates import Distance, SkyCoord
from astropy.time import Time

from pxh.models import Astrometry
from pxh.sky.coords import angular_separation_arcsec, tangent_plane_offsets_arcsec
from pxh.sky.propagate import (
    AU_KM,
    TT_MINUS_UTC_S,
    apparent_position,
    barycentric_position,
    earth_barycentric_au,
    jyear_from_mjd,
    mjd_from_jyear,
    parallax_factors,
    parallax_offsets_mas,
)
from pxh.sky.targets import TARGETS

MJD_2026_11_14 = 61358.0
MJD_FIRST_SPHEREX_BARNARD = 60902.864715

BARNARD = TARGETS["barnards-star"].astrometry
WISE0855 = TARGETS["wise-0855"].astrometry
EPS_IND_B = TARGETS["eps-indi-b"].astrometry
NO_PARALLAX = Astrometry(ra_deg=150.0, dec_deg=30.0, ref_epoch=2000.0, pmra_masyr=120.0, pmdec_masyr=-80.0)


def _sep_mas(ra1: float, dec1: float, ra2: float, dec2: float) -> float:
    return angular_separation_arcsec(ra1, dec1, ra2, dec2) * 1000.0


@pytest.mark.parametrize(
    ("astrometry", "expected"),
    [
        (BARNARD, (269.4460727, 4.7707237)),
        (WISE0855, (133.7577876, -7.2420245)),
        (EPS_IND_B, (331.0984097, -56.8012581)),
    ],
    ids=["barnard", "wise0855", "eps-ind-b"],
)
def test_barycentric_reference_positions(astrometry: Astrometry, expected: tuple[float, float]) -> None:
    ra, dec = barycentric_position(astrometry, MJD_2026_11_14)
    assert _sep_mas(ra, dec, *expected) < 50.0


def test_barnard_apparent_at_first_spherex_exposure() -> None:
    ra, dec = apparent_position(BARNARD, MJD_FIRST_SPHEREX_BARNARD)
    assert _sep_mas(ra, dec, 269.4462280, 4.7671765) < 100.0


def _astropy_barycentric(astrometry: Astrometry, mjd: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Oracle: ERFA pmsafe via astropy. Missing RV -> 0; missing parallax -> 1 mas.

    With zero RV the barycentric direction does not depend on the parallax, and pmsafe overrides tiny
    parallaxes that imply a transverse speed above 1% of c. Times are given as TDB (= TT to < 2 ms) so
    astropy does no leap-second lookups for future dates.
    """
    parallax = astrometry.parallax_mas if astrometry.parallax_mas else 1.0
    coord = SkyCoord(
        ra=astrometry.ra_deg * u.deg,
        dec=astrometry.dec_deg * u.deg,
        distance=Distance(parallax=parallax * u.mas),
        pm_ra_cosdec=astrometry.pmra_masyr * u.mas / u.yr,
        pm_dec=astrometry.pmdec_masyr * u.mas / u.yr,
        radial_velocity=(astrometry.rv_kms or 0.0) * u.km / u.s,
        obstime=Time(astrometry.ref_epoch, format="jyear", scale="tdb"),
    )
    moved = coord.apply_space_motion(
        new_obstime=Time(mjd + TT_MINUS_UTC_S / 86400.0, format="mjd", scale="tdb")
    )
    return moved.ra.deg, moved.dec.deg


@pytest.mark.parametrize("key", sorted(TARGETS))
def test_matches_astropy_apply_space_motion(key: str) -> None:
    astrometry = TARGETS[key].astrometry
    mjd = np.array([mjd_from_jyear(2000.0), 55400.0, 57633.39, MJD_FIRST_SPHEREX_BARNARD, 61358.0, 62500.0])
    ra, dec = barycentric_position(astrometry, mjd)
    ra_ref, dec_ref = _astropy_barycentric(astrometry, mjd)
    assert np.max(angular_separation_arcsec(ra, dec, ra_ref, dec_ref)) * 1000.0 < 1.0


def test_no_parallax_matches_astropy_and_has_no_parallax_shift() -> None:
    mjd = np.array([51544.5, 60000.0, 61358.0])
    ra, dec = barycentric_position(NO_PARALLAX, mjd)
    ra_ref, dec_ref = _astropy_barycentric(NO_PARALLAX, mjd)
    assert np.max(angular_separation_arcsec(ra, dec, ra_ref, dec_ref)) * 1000.0 < 1.0
    ra_app, dec_app = apparent_position(NO_PARALLAX, mjd)
    np.testing.assert_array_equal(ra_app, ra)
    np.testing.assert_array_equal(dec_app, dec)
    dx, dy = parallax_offsets_mas(NO_PARALLAX, mjd)
    np.testing.assert_array_equal(dx, 0.0)
    np.testing.assert_array_equal(dy, 0.0)


def test_negative_parallax_treated_as_zero() -> None:
    odd = Astrometry(ra_deg=10.0, dec_deg=20.0, ref_epoch=2016.0, parallax_mas=-0.3, rv_kms=50.0)
    assert apparent_position(odd, 61000.0) == pytest.approx((10.0, 20.0), abs=1e-12)


def test_zero_motion_is_static() -> None:
    fixed = Astrometry(ra_deg=359.999999, dec_deg=-45.0, ref_epoch=2000.0)
    ra, dec = barycentric_position(fixed, np.array([40000.0, 61358.0]))
    np.testing.assert_allclose(ra, 359.999999, atol=1e-10)
    np.testing.assert_allclose(dec, -45.0, atol=1e-10)


def test_vectorised_shapes_and_scalar_types() -> None:
    mjd = np.array([[60900.0, 60950.0, 61000.0], [61050.0, 61100.0, 61150.0]])
    for func in (barycentric_position, apparent_position, parallax_offsets_mas):
        a, b = func(BARNARD, mjd)
        assert a.shape == mjd.shape and b.shape == mjd.shape
        a0, b0 = func(BARNARD, float(mjd[1, 2]))
        assert isinstance(a0, float) and isinstance(b0, float)
        assert a0 == pytest.approx(a[1, 2], abs=1e-12) and b0 == pytest.approx(b[1, 2], abs=1e-12)
    ra, dec = barycentric_position(BARNARD, [61000.0, 61100.0])
    assert ra.shape == (2,)
    fx, fy = parallax_factors(BARNARD.ra_deg, BARNARD.dec_deg, mjd)
    assert fx.shape == mjd.shape and fy.shape == mjd.shape


def test_rejects_non_finite_mjd() -> None:
    with pytest.raises(ValueError):
        barycentric_position(BARNARD, np.array([61000.0, np.nan]))


def test_parallax_offsets_are_apparent_minus_barycentric() -> None:
    mjd = np.linspace(60800.0, 61200.0, 41)
    dx, dy = parallax_offsets_mas(BARNARD, mjd)
    ra_b, dec_b = barycentric_position(BARNARD, mjd)
    ra_a, dec_a = apparent_position(BARNARD, mjd)
    for k in range(mjd.size):
        xi, eta = tangent_plane_offsets_arcsec(ra_a[k], dec_a[k], ra_b[k], dec_b[k])
        assert dx[k] == pytest.approx(xi * 1000.0, abs=0.01)
        assert dy[k] == pytest.approx(eta * 1000.0, abs=0.01)
    # The parallactic ellipse of Barnard's Star (ecliptic latitude ~ +28 deg) has semi-axes plx and ~0.47 plx.
    amplitude = np.hypot(dx, dy)
    assert amplitude.max() <= 1.01 * BARNARD.parallax_mas
    assert amplitude.max() > 0.9 * BARNARD.parallax_mas


def test_parallax_factors_match_rigorous_offsets() -> None:
    mjd = np.linspace(60800.0, 61200.0, 7)
    dx, dy = parallax_offsets_mas(BARNARD, mjd)
    fx, fy = parallax_factors(BARNARD.ra_deg, BARNARD.dec_deg, mjd)
    # First-order factors use the catalogue parallax; the rigorous offsets use the parallax at each epoch
    # (Barnard's Star approaches us, so its parallax has grown by ~0.06 % since 2016).
    np.testing.assert_allclose(dx, fx * BARNARD.parallax_mas, rtol=2e-3, atol=0.05)
    np.testing.assert_allclose(dy, fy * BARNARD.parallax_mas, rtol=2e-3, atol=0.05)


def test_earth_ephemeris_matches_jpl_de441(fixtures_dir: Path) -> None:
    doc = json.loads((fixtures_dir / "sky_earth_ssb_de441.json").read_text())
    rows = np.array(doc["rows"])
    # Fixture times are TDB; TDB - TT < 2 ms, and earth_barycentric_au takes UTC MJDs.
    mjd_utc = rows[:, 0] - 2400000.5 - TT_MINUS_UTC_S / 86400.0
    xyz = earth_barycentric_au(mjd_utc)
    assert xyz.shape == (rows.shape[0], 3)
    error_km = np.linalg.norm(xyz - rows[:, 1:4], axis=1) * AU_KM
    # epv00 is fitted to DE405, whose barycentre sits ~120 km from DE441's: 8e-7 au, i.e. < 0.001 mas of
    # parallax shift even for Barnard's Star.
    assert error_km.max() < 300.0
    assert earth_barycentric_au(61000.0).shape == (3,)


def test_wise0855_matches_published_spitzer_astrometry(fixtures_dir: Path) -> None:
    """Kirkpatrick et al. (2021) Spitzer positions, using the published observer positions."""
    rows = [
        line.split("\t")
        for line in (fixtures_dir / "sky_wise0855_spitzer_kirk2021.tsv").read_text().splitlines()
        if line.strip() and not line.startswith("#")
    ]
    ra_obs = np.array([float(r[2]) for r in rows])
    dec_obs = np.array([float(r[3]) for r in rows])
    mjd = np.array([float(r[7]) for r in rows])
    observer_au = np.array([[float(r[8]), float(r[9]), float(r[10])] for r in rows]) / AU_KM
    assert mjd.size == 19

    ra, dec = apparent_position(WISE0855, mjd, observer_bary_au=observer_au)
    resid = np.array(
        [tangent_plane_offsets_arcsec(ra_obs[k], dec_obs[k], ra[k], dec[k]) for k in range(mjd.size)]
    )
    rms_mas = np.sqrt(np.mean(resid**2, axis=0)) * 1000.0
    assert np.all(rms_mas < 15.0), rms_mas  # 6-8 mas in research; positions are quantised to 3.6 mas

    # Without parallax the model misses by hundreds of mas: the parallax term is doing real work.
    ra_b, dec_b = barycentric_position(WISE0855, mjd)
    miss = np.array(
        [angular_separation_arcsec(ra_obs[k], dec_obs[k], ra_b[k], dec_b[k]) for k in range(mjd.size)]
    )
    assert np.sqrt(np.mean(miss**2)) * 1000.0 > 200.0


def test_julian_year_conversions() -> None:
    assert jyear_from_mjd(51544.5) == 2000.0
    assert mjd_from_jyear(2016.0) == pytest.approx(57388.5)
    assert jyear_from_mjd(57633.39) == pytest.approx(2016.67047, abs=1e-5)
    years = jyear_from_mjd(np.array([51544.5, 61358.0]))
    np.testing.assert_allclose(mjd_from_jyear(years), [51544.5, 61358.0])
