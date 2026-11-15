"""Tests for pxh.photometry.motion: proper-motion fits, parallax offsets, displacements (offline).

Synthetic astrometry mimics SPHEREx: 4 wide-survey epochs ~6 months apart, 20 exposures in 14 days
each, 300 mas position errors (0.05 px), a nearby star (parallax 500 mas). Positions are made exactly
(tangent-plane offsets about the reference position) and the fit gets the parallax offsets from
``parallax_offsets_mas``, as the pipeline will. A network test repeats the research check on real data:
Barnard's Star from 15 saturated D5/D6 exposures vs Gaia DR3 (research: 10.43 +/- 0.36 arcsec/yr).
"""

from __future__ import annotations

import json
import math
import warnings

import numpy as np
import pytest

from pxh import config
from pxh.photometry.motion import (
    MotionFit,
    SkyPosition,
    compare_to_catalog,
    displacement_between,
    fit_proper_motion,
    mean_direction,
    mean_positions_by_epoch,
    parallax_offsets_mas,
    position_angle_deg,
    tangent_offsets_mas,
    tangent_to_radec,
    wrap_angle_deg,
)

RA0, DEC0 = 150.0, 20.0
PLX = 500.0  # mas
SIGMA_MAS = 300.0
EPOCH_STARTS = (60800.0, 60983.0, 61166.0, 61349.0)


def survey_mjd(n_per_epoch: int = 20, span_days: float = 14.0) -> np.ndarray:
    return np.concatenate([s + np.linspace(0.0, span_days, n_per_epoch) for s in EPOCH_STARTS])


def synthetic_track(
    pmra: float,
    pmdec: float,
    seed: int | None = 0,
    sigma: float = SIGMA_MAS,
    plx: float = PLX,
    ra0: float = RA0,
    dec0: float = DEC0,
) -> dict[str, np.ndarray | float]:
    """Observed (ra, dec) of a star at (ra0, dec0) at the mean epoch, with motion, parallax and noise."""
    t = survey_mjd()
    ref = float(np.mean(t))
    dt = (t - ref) / 365.25
    pxi, peta = parallax_offsets_mas(ra0, dec0, plx, t)
    xi = pmra * dt + pxi
    eta = pmdec * dt + peta
    if seed is not None:
        rng = np.random.default_rng(seed)
        xi = xi + rng.normal(0.0, sigma, t.size)
        eta = eta + rng.normal(0.0, sigma, t.size)
    ra, dec = tangent_to_radec(xi, eta, ra0, dec0)
    plx_obs = parallax_offsets_mas(ra, dec, plx, t)  # what a caller computes from measured positions
    return {"mjd": t, "ra": ra, "dec": dec, "plx": np.vstack(plx_obs), "ref": ref}


def fit_track(track: dict, sigma: float = SIGMA_MAS, **kwargs) -> MotionFit:
    return fit_proper_motion(
        track["mjd"], track["ra"], track["dec"], sigma, sigma, parallax_offsets_mas=track["plx"], **kwargs
    )


# --- spherical helpers ---------------------------------------------------------------------------


def test_tangent_plane_round_trip_and_directions() -> None:
    xi = np.array([0.0, 6150.0, -2.0e5, 3.6e6])
    eta = np.array([0.0, -3000.0, 1.0e5, -1.8e6])
    ra, dec = tangent_to_radec(xi, eta, 359.99, -45.0)
    xi2, eta2 = tangent_offsets_mas(ra, dec, 359.99, -45.0)
    np.testing.assert_allclose(xi2, xi, atol=1e-6)
    np.testing.assert_allclose(eta2, eta, atol=1e-6)
    east_ra, east_dec = tangent_to_radec(1000.0, 0.0, RA0, DEC0)
    assert east_ra > RA0 and abs(east_dec - DEC0) < 1e-9  # xi is east (increasing RA)
    assert (east_ra - RA0) * math.cos(math.radians(DEC0)) * 3.6e6 == pytest.approx(1000.0, rel=1e-6)


def test_position_angle_and_wrap() -> None:
    assert position_angle_deg(0.0, 1.0) == pytest.approx(0.0)  # north
    assert position_angle_deg(1.0, 0.0) == pytest.approx(90.0)  # east
    assert position_angle_deg(0.0, -1.0) == pytest.approx(180.0)
    assert position_angle_deg(-1.0, 0.0) == pytest.approx(270.0)
    assert position_angle_deg(1.0, -1.0) == pytest.approx(135.0)  # south-east
    np.testing.assert_allclose(position_angle_deg(np.array([1.0, -1.0]), np.array([1.0, 1.0])), [45.0, 315.0])
    assert wrap_angle_deg(359.0 - 1.0) == pytest.approx(-2.0)
    assert wrap_angle_deg(181.0) == pytest.approx(-179.0)


def test_mean_direction_across_ra_zero() -> None:
    ra, dec = mean_direction([359.9, 0.1], [10.0, 10.0])
    assert 0.0 <= ra < 1e-9  # in [0, 360): never 360.0
    # great-circle midpoint of two points at the same declination lies slightly poleward
    expected = math.degrees(math.atan(math.tan(math.radians(10.0)) / math.cos(math.radians(0.1))))
    assert dec == pytest.approx(expected, abs=1e-9) and dec > 10.0
    tra, _ = tangent_to_radec(-1e-12, 0.0, 0.0, 0.0)
    assert 0.0 <= float(tra) < 360.0
    with pytest.raises(ValueError):
        mean_direction([0.0, 180.0], [0.0, 0.0])


def _exact_parallax(ra: float, dec: float, plx_mas: float, mjd: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Apparent minus barycentric direction, computed geometrically (star at 1/plx au)."""
    import astropy.units as u
    from astropy.coordinates import get_body_barycentric
    from astropy.time import Time

    e = get_body_barycentric("earth", Time(mjd, format="mjd", scale="utc"))
    obs = np.vstack([e.x.to_value(u.au), e.y.to_value(u.au), e.z.to_value(u.au)]).T
    a, d = math.radians(ra), math.radians(dec)
    star = np.array([math.cos(d) * math.cos(a), math.cos(d) * math.sin(a), math.sin(d)]) / (plx_mas / 206264806.247)
    s = star[None, :] - obs
    ra_app = np.degrees(np.arctan2(s[:, 1], s[:, 0])) % 360.0
    dec_app = np.degrees(np.arcsin(s[:, 2] / np.linalg.norm(s, axis=1)))
    return tangent_offsets_mas(ra_app, dec_app, ra, dec)


@pytest.mark.parametrize(("ra", "dec"), [(270.0, 66.56), (150.0, 20.0), (40.0, -70.0)])
def test_parallax_offsets_match_geometry(ra: float, dec: float) -> None:
    mjd = np.linspace(60800.0, 61165.0, 25)
    dxi, deta = parallax_offsets_mas(ra, dec, 546.98, mjd)
    exi, eeta = _exact_parallax(ra, dec, 546.98, mjd)
    np.testing.assert_allclose(dxi, exi, atol=0.01)
    np.testing.assert_allclose(deta, eeta, atol=0.01)
    amp = np.hypot(dxi, deta)
    assert amp.max() == pytest.approx(546.98, rel=0.03)  # semi-major axis of the parallax ellipse ~ plx
    if dec > 60:  # near the ecliptic pole the ellipse is a circle
        assert amp.min() == pytest.approx(546.98, rel=0.05)


def test_parallax_offsets_with_spacecraft_offset() -> None:
    mjd = np.array([61000.0, 61100.0])
    base = np.vstack(parallax_offsets_mas(150.0, 20.0, 1000.0, mjd))
    geo = np.array([[7000.0, 0.0, 0.0], [0.0, -7000.0, 0.0]])  # LEO, km
    shifted = np.vstack(parallax_offsets_mas(150.0, 20.0, 1000.0, mjd, observer_geocentric_km=geo))
    step = 1000.0 * 7000.0 / 149_597_870.7  # mas
    a = math.radians(150.0)
    np.testing.assert_allclose(shifted[0] - base[0], [step * math.sin(a), step * math.cos(a)], atol=1e-9)


# --- proper-motion fits --------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("pmra", "pmdec", "pa"),
    [(0.0, 1000.0, 0.0), (700.0, -700.0, 135.0)],
    ids=["due-north", "south-east"],
)
def test_noiseless_fit_recovers_motion_exactly(pmra: float, pmdec: float, pa: float) -> None:
    track = synthetic_track(pmra, pmdec, seed=None)
    fit = fit_track(track)
    assert fit.pmra_masyr == pytest.approx(pmra, abs=0.05)
    assert fit.pmdec_masyr == pytest.approx(pmdec, abs=0.05)
    assert abs(wrap_angle_deg(fit.pa_deg - pa)) < 0.01
    assert fit.ra0_deg == pytest.approx(RA0, abs=1e-7) and fit.dec0_deg == pytest.approx(DEC0, abs=1e-7)
    assert fit.ref_mjd == pytest.approx(track["ref"])
    assert fit.n_used == fit.n_total == 80 and fit.used.all()
    assert np.abs(fit.residuals_mas).max() < 0.1
    assert fit.time_span_days == pytest.approx(EPOCH_STARTS[-1] + 14.0 - EPOCH_STARTS[0])


@pytest.mark.parametrize(
    ("pmra", "pmdec", "pa"),
    [(0.0, 1000.0, 0.0), (700.0, -700.0, 135.0)],
    ids=["due-north", "south-east"],
)
def test_noisy_fits_are_within_one_sigma_at_the_gaussian_rate(pmra: float, pmdec: float, pa: float) -> None:
    """Over 300 noise realisations: 68% of fits within 1 sigma per component, unbiased, calibrated PA."""
    pulls, pa_pulls = [], []
    for seed in range(300):
        fit = fit_track(synthetic_track(pmra, pmdec, seed=seed))
        pulls.append(((fit.pmra_masyr - pmra) / fit.pmra_err_masyr, (fit.pmdec_masyr - pmdec) / fit.pmdec_err_masyr))
        pa_pulls.append(float(wrap_angle_deg(fit.pa_deg - pa)) / fit.pa_err_deg)
    p = np.array(pulls)
    within = np.mean(np.abs(p) < 1.0, axis=0)
    assert np.all((within > 0.60) & (within < 0.76)), within
    assert np.all(np.abs(p.mean(axis=0)) < 0.15)
    assert np.all((p.std(axis=0) > 0.85) & (p.std(axis=0) < 1.15))
    q = np.array(pa_pulls)
    assert abs(q.mean()) < 0.15 and 0.85 < q.std() < 1.15
    assert 0.60 < np.mean(np.abs(q) < 1.0) < 0.76


def test_single_fit_summary_and_catalog_comparison() -> None:
    pmra, pmdec = 700.0, -700.0
    fit = fit_track(synthetic_track(pmra, pmdec, seed=1))
    expected_err = SIGMA_MAS / math.sqrt(np.sum((survey_mjd() - survey_mjd().mean()) ** 2)) * 365.25
    assert fit.pmra_err_masyr == pytest.approx(expected_err, rel=0.15)
    assert fit.total_masyr == pytest.approx(math.hypot(pmra, pmdec), abs=4 * fit.total_err_masyr)
    assert 0.6 < fit.chi2_red < 1.5 and fit.dof == 2 * 80 - 4
    cmp = compare_to_catalog(fit, pmra, pmdec)
    assert cmp["n_sigma"] < 3.5
    assert abs(cmp["ratio"] - 1.0) < 4 * fit.total_err_masyr / fit.total_masyr
    assert abs(cmp["pa_diff_deg"]) < 4 * fit.pa_err_deg
    assert cmp["pa_cat_deg"] == pytest.approx(135.0) and cmp["total_cat_masyr"] == pytest.approx(989.95, abs=0.01)
    d = fit.to_dict()
    json.dumps(d)  # JSON-ready
    assert d["n_used"] == 80 and len(d["residuals_mas"]) == 80


def test_compare_to_catalog_numbers() -> None:
    fit = fit_track(synthetic_track(0.0, 1000.0, seed=None))
    cmp = compare_to_catalog(fit, 0.0, 1000.0)
    assert cmp["ratio"] == pytest.approx(1.0, abs=1e-4)
    assert cmp["delta_masyr"] < 0.1 and abs(cmp["pa_diff_deg"]) < 0.01
    off = compare_to_catalog(fit, 100.0, 900.0, pmra_cat_err=10.0, pmdec_cat_err=10.0)
    assert off["dpmra_masyr"] == pytest.approx(-100.0, abs=0.1) and off["dpmdec_masyr"] == pytest.approx(100.0, abs=0.1)
    assert off["delta_masyr"] == pytest.approx(math.hypot(100.0, 100.0), abs=0.1)
    assert off["pa_diff_deg"] == pytest.approx(-math.degrees(math.atan2(100.0, 900.0)), abs=0.01)  # fit is west
    assert off["ratio"] == pytest.approx(1000.0 / math.hypot(100.0, 900.0), rel=1e-4)
    sx, sy = math.hypot(fit.pmra_err_masyr, 10.0), math.hypot(fit.pmdec_err_masyr, 10.0)
    assert off["n_sigma"] == pytest.approx(math.hypot(100.0 / sx, 100.0 / sy), rel=1e-3)


def test_parallax_must_be_removed_for_nearby_stars() -> None:
    """6-month epochs alternate sides of the parallax ellipse: left in, it biases the motion."""
    exact = synthetic_track(300.0, 200.0, seed=None)
    good = fit_track(exact, sigma_clip=None)
    biased = fit_proper_motion(exact["mjd"], exact["ra"], exact["dec"], SIGMA_MAS, SIGMA_MAS, sigma_clip=None)
    assert math.hypot(good.pmra_masyr - 300.0, good.pmdec_masyr - 200.0) < 0.1
    assert math.hypot(biased.pmra_masyr - 300.0, biased.pmdec_masyr - 200.0) > 200.0
    track = synthetic_track(300.0, 200.0, seed=2)
    with_plx = fit_track(track, sigma_clip=None)
    no_plx = fit_proper_motion(track["mjd"], track["ra"], track["dec"], SIGMA_MAS, SIGMA_MAS, sigma_clip=None)
    assert 0.6 < with_plx.chi2_red < 1.5 and with_plx.error_scale[0] < 1.3
    assert no_plx.chi2_red > with_plx.chi2_red + 0.5  # the parallax is left in the residuals
    assert max(no_plx.error_scale) > 1.3  # and the errors are inflated to match
    # an [N, 2] array is accepted as well as (dra*, ddec)
    alt = fit_proper_motion(track["mjd"], track["ra"], track["dec"], SIGMA_MAS, SIGMA_MAS,
                            parallax_offsets_mas=track["plx"].T, sigma_clip=None)
    assert alt.pmra_masyr == pytest.approx(with_plx.pmra_masyr)


def test_sigma_clipping_removes_outliers() -> None:
    track = synthetic_track(0.0, 1000.0, seed=3)
    xi, eta = tangent_offsets_mas(track["ra"], track["dec"], RA0, DEC0)
    bad = [5, 47]
    xi[bad] += [8000.0, -6000.0]  # a blend and a cosmic-ray-corrupted centroid
    track["ra"], track["dec"] = tangent_to_radec(xi, eta, RA0, DEC0)
    fit = fit_track(track)
    assert not fit.used[bad].any() and 76 <= fit.n_used <= 78  # plus at most ~1 Gaussian >3-sigma point
    assert abs(fit.pmra_masyr) < 3 * fit.pmra_err_masyr
    assert abs(fit.pmdec_masyr - 1000.0) < 3 * fit.pmdec_err_masyr
    assert abs(fit.residuals_mas[bad[0], 0]) > 5000.0  # residuals are reported for clipped points too
    raw = fit_track(track, sigma_clip=None)
    assert raw.used.all() and raw.chi2_red > 5


def test_reference_epoch_and_errors_per_point() -> None:
    track = synthetic_track(500.0, 0.0, seed=4)
    t = track["mjd"]
    fit = fit_proper_motion(t, track["ra"], track["dec"], np.full(t.size, SIGMA_MAS), SIGMA_MAS,
                            parallax_offsets_mas=track["plx"], ref_mjd=float(t[0]))
    assert fit.ref_mjd == float(t[0])
    # position at the first epoch: 500 mas/yr earlier than at the mean epoch
    shift = 500.0 * (t[0] - t.mean()) / 365.25
    xi0, _ = tangent_offsets_mas(fit.ra0_deg, fit.dec0_deg, RA0, DEC0)
    assert float(xi0) == pytest.approx(shift, abs=4 * fit.ra0_err_mas)
    assert fit.ra0_err_mas > 300.0 / math.sqrt(t.size)  # extrapolated to the first epoch


def test_invalid_inputs_raise() -> None:
    t = survey_mjd()[:5]
    with pytest.raises(ValueError):
        fit_proper_motion(t[:2], [1.0, 1.0], [1.0, 1.0], 1.0, 1.0)  # fewer than 3 points
    with pytest.raises(ValueError):
        fit_proper_motion(np.full(5, 61000.0), np.ones(5), np.ones(5), 1.0, 1.0)  # one epoch
    with pytest.raises(ValueError):
        fit_proper_motion(t, np.ones(5), np.ones(5), 0.0, 1.0)
    with pytest.raises(ValueError):
        fit_proper_motion(t, np.ones(5), np.ones(5), 1.0, 1.0, parallax_offsets_mas=np.zeros((3, 5)))
    with pytest.raises(ValueError):
        fit_proper_motion(t, np.ones(4), np.ones(5), 1.0, 1.0)
    ra = np.ones(5)
    ra[2] = np.nan
    with pytest.raises(ValueError):
        fit_proper_motion(t, ra, np.ones(5), 1.0, 1.0)


# --- epoch positions and displacements -----------------------------------------------------------


def test_mean_positions_by_epoch() -> None:
    rng = np.random.default_rng(5)
    t = survey_mjd(n_per_epoch=10)
    epoch = [i // 10 for i in range(t.size)]
    epoch[-1] = None  # an unassigned point gets its own group, sorted last
    xi = np.array([1000.0 * (e if e is not None else 9) for e in epoch]) + rng.normal(0.0, 100.0, t.size)
    eta = rng.normal(0.0, 100.0, t.size)
    ra, dec = tangent_to_radec(xi, eta, RA0, DEC0)
    err = np.full(t.size, 100.0)
    err[0] = 1.0e4  # a poor point hardly moves its epoch mean
    out = mean_positions_by_epoch(t, ra, dec, err, 100.0, epoch)
    assert [p.label for p in out] == ["epoch 0", "epoch 1", "epoch 2", "epoch 3", ""]
    assert [p.n for p in out] == [10, 10, 10, 9, 1]
    for k, p in enumerate(out[:4]):
        mxi, meta = tangent_offsets_mas(p.ra_deg, p.dec_deg, RA0, DEC0)
        assert float(mxi) == pytest.approx(1000.0 * k, abs=4 * p.ra_err_mas)
        assert float(meta) == pytest.approx(0.0, abs=4 * p.dec_err_mas)
        assert p.mjd == pytest.approx(np.mean(t[np.array(epoch, dtype=object) == k]))
    assert out[1].ra_err_mas == pytest.approx(100.0 / math.sqrt(10), rel=0.5)
    with pytest.raises(ValueError):
        mean_positions_by_epoch(t, ra, dec, err, 100.0, epoch[:-1])


def test_displacement_between_epochs() -> None:
    first = SkyPosition(mjd=61000.0, ra_deg=RA0, dec_deg=DEC0, ra_err_mas=100.0, dec_err_mas=100.0)
    ra, dec = tangent_to_radec(config.PIXEL_SCALE_ARCSEC * 1000.0, 0.0, RA0, DEC0)  # one pixel east
    last = SkyPosition(mjd=61365.25, ra_deg=float(ra), dec_deg=float(dec), ra_err_mas=100.0, dec_err_mas=100.0)
    d = displacement_between(first, last)
    assert d["sep_px"] == pytest.approx(1.0, rel=1e-6) and d["sep_arcsec"] == pytest.approx(6.15, rel=1e-6)
    assert d["pa_deg"] == pytest.approx(90.0, abs=1e-6)
    assert d["dra_arcsec"] == pytest.approx(6.15, rel=1e-6) and abs(d["ddec_arcsec"]) < 1e-6
    assert d["rate_arcsec_yr"] == pytest.approx(6.15, rel=1e-6) and d["dt_days"] == pytest.approx(365.25)
    assert d["sep_err_arcsec"] == pytest.approx(0.1414, abs=1e-3)
    assert d["n_sigma"] == pytest.approx(6150.0 / math.hypot(100.0, 100.0), rel=1e-6)
    ra, dec = tangent_to_radec(-3000.0, -4000.0, RA0, DEC0)  # 5" towards the south-west
    sw = displacement_between(first, SkyPosition(mjd=61000.0, ra_deg=float(ra), dec_deg=float(dec)))
    assert sw["sep_arcsec"] == pytest.approx(5.0, rel=1e-6)
    assert sw["pa_deg"] == pytest.approx(180.0 + math.degrees(math.atan2(3.0, 4.0)), abs=1e-6)
    assert math.isnan(sw["rate_arcsec_yr"]) and math.isnan(sw["n_sigma"])


# --- live: Barnard's Star from saturated D5/D6 exposures -------------------------------------------

_IBE = "https://irsa.ipac.caltech.edu/ibe/data/spherex/"
BARNARD_D56 = (  # research selection (2 per detector per epoch), DR1 + QR3
    "dr1/level2/2025W34_2B/l2b-v27-2026-229/5/level2_2025W34_2B_0090_4D5_spx_l2b-v27-2026-229.fits",
    "dr1/level2/2025W35_2A/l2b-v27-2026-231/5/level2_2025W35_2A_0418_1D5_spx_l2b-v27-2026-231.fits",
    "dr1/level2/2025W33_2C/l2b-v27-2026-228/6/level2_2025W33_2C_0321_1D6_spx_l2b-v27-2026-228.fits",
    "dr1/level2/2025W35_1A/l2b-v27-2026-230/6/level2_2025W35_1A_0484_2D6_spx_l2b-v27-2026-230.fits",
    "dr1/level2/2026W11_2A/l2b-v27-2026-234/5/level2_2026W11_2A_0501_1D5_spx_l2b-v27-2026-234.fits",
    "dr1/level2/2026W12_2A/l2b-v27-2026-235/5/level2_2026W12_2A_0496_1D5_spx_l2b-v27-2026-235.fits",
    "dr1/level2/2026W12_1A/l2b-v27-2026-235/6/level2_2026W12_1A_0598_1D6_spx_l2b-v27-2026-235.fits",
    "dr1/level2/2026W15_2A/l2b-v27-2026-240/6/level2_2026W15_2A_0137_1D6_spx_l2b-v27-2026-240.fits",
    "dr1/level2/2026W19_1A/l2b-v27-2026-245/6/level2_2026W19_1A_0046_1D6_spx_l2b-v27-2026-245.fits",
    "dr1/level2/2026W19_1A/l2b-v27-2026-245/6/level2_2026W19_1A_0403_1D6_spx_l2b-v27-2026-245.fits",
    "qr3/level2/2026W34_1A/l2b-v27-2026-243/5/level2_2026W34_1A_0363_1D5_spx_l2b-v27-2026-243.fits",
    "qr3/level2/2026W35_2A/l2b-v27-2026-246/5/level2_2026W35_2A_0126_1D5_spx_l2b-v27-2026-246.fits",
    "qr3/level2/2026W33_2A/l2b-v27-2026-241/6/level2_2026W33_2A_0594_4D6_spx_l2b-v27-2026-241.fits",
    "qr3/level2/2026W34_2A/l2b-v27-2026-243/6/level2_2026W34_2A_0081_1D6_spx_l2b-v27-2026-243.fits",
    "qr3/level2/2026W39_1A/l2b-v27-2026-268/5/level2_2026W39_1A_0371_1D5_spx_l2b-v27-2026-268.fits",
)
# Gaia DR3 4472832130942575872 (epoch J2016.0)
BARNARD = {"ra": 269.44850252543836, "dec": 4.739420051112412, "pmra": -801.551, "pmdec": 10362.394, "plx": 546.9759}


def _barnard_guess(mjd: float) -> tuple[float, float]:
    """Linear propagation + parallax: good to ~0.1", enough as a starting position."""
    dt = (mjd - 57388.5) / 365.25  # J2016.0 = MJD 57388.5
    pxi, peta = parallax_offsets_mas(BARNARD["ra"], BARNARD["dec"], BARNARD["plx"], [mjd])
    ra, dec = tangent_to_radec(BARNARD["pmra"] * dt + pxi[0], BARNARD["pmdec"] * dt + peta[0], BARNARD["ra"], BARNARD["dec"])
    return float(ra), float(dec)


@pytest.mark.network
@pytest.mark.timeout(900)
def test_live_barnard_proper_motion_from_saturated_d5_d6() -> None:
    from astropy.io import fits
    from test_forced import default_masks, fetch_cutout, stamp_from_hdul

    from pxh.photometry.forced import measure_position, usable_for_motion

    rows = []
    for rel in BARNARD_D56:
        url = _IBE + rel
        path = fetch_cutout(url, 269.4462, 4.7686, 0.05)
        with fits.open(path) as hdul, warnings.catch_warnings():
            warnings.simplefilter("ignore")
            stamp, grid = stamp_from_hdul(hdul, collection=rel.split("/")[0], access_url=url)
            geo = [float(hdul["IMAGE"].header.get(k, 0.0)) for k in ("X_SC", "Y_SC", "Z_SC")]
        mask_bits, sat_bits = default_masks(stamp.flag_bits)
        res = measure_position(stamp, *_barnard_guess(stamp.mjd_avg), grid, mask_bits, sat_bits)
        assert res.point.saturated
        if usable_for_motion(res):
            rows.append((stamp.mjd_avg, res.ra_deg, res.dec_deg, res.ra_err_mas, res.dec_err_mas, geo))
    assert len(rows) >= 12
    t, ra, dec, ex, ey = (np.array([r[k] for r in rows]) for k in range(5))
    plx = parallax_offsets_mas(ra, dec, BARNARD["plx"], t, observer_geocentric_km=np.array([r[5] for r in rows]))
    fit = fit_proper_motion(t, ra, dec, ex, ey, parallax_offsets_mas=plx)
    cmp = compare_to_catalog(fit, BARNARD["pmra"], BARNARD["pmdec"])
    print(f"Barnard D5+D6: {fit.total_masyr / 1e3:.3f} +/- {fit.total_err_masyr / 1e3:.3f} arcsec/yr, "
          f"PA {fit.pa_deg:.2f} +/- {fit.pa_err_deg:.2f}, n={fit.n_used}/{fit.n_total}, chi2_red {fit.chi2_red:.1f}; "
          f"ratio {cmp['ratio']:.4f}, PA diff {cmp['pa_diff_deg']:+.2f}, {cmp['n_sigma']:.2f} sigma")
    assert abs(cmp["ratio"] - 1.0) < 0.05
    assert abs(cmp["pa_diff_deg"]) < 3.0
    assert cmp["n_sigma"] < 3.0
