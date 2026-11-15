"""Tests for pxh.photometry.lightcurve: AB magnitudes, epoch photometry, same-channel series (offline).
"""

from __future__ import annotations

import json
import math

import numpy as np
import pytest

from pxh.models import PhotPoint
from pxh.photometry.lightcurve import (
    AB_ZEROPOINT_JY,
    _chi2_log_sf,
    ab_mag,
    epoch_photometry,
    mag_err,
    same_channel_series,
    variability_significance,
)


def pt(
    flux: float,
    err: float = 10.0,
    wl: float = 1.0,
    bw: float | None = None,
    det: int = 1,
    mjd: float = 61000.0,
    epoch: int | None = 0,
    sat: bool = False,
) -> PhotPoint:
    return PhotPoint(
        obs_id=f"obs{mjd:.3f}", detector=det, mjd=mjd, wavelength_um=wl,
        bandwidth_um=wl / 40.0 if bw is None else bw, flux_ujy=flux, flux_err_ujy=err, x=0.0, y=0.0, flags=0,
        saturated=sat, method="epsf", collection="spherex_dr1", epoch_index=epoch,
    )


# --- magnitudes ------------------------------------------------------------------------------------


def test_ab_magnitude_zero_point() -> None:
    assert AB_ZEROPOINT_JY == 3631.0
    assert ab_mag(3631.0e6) == pytest.approx(0.0, abs=1e-12)  # 3631 Jy is AB 0
    assert ab_mag(1.0) == pytest.approx(23.9, abs=1e-4)  # 1 uJy is AB 23.9
    assert ab_mag(3631.0e6 / 100.0) == pytest.approx(5.0)
    m = ab_mag(np.array([1.0e6, 0.0, -5.0, np.nan]))
    assert m[0] == pytest.approx(8.9, abs=1e-4) and np.isnan(m[1:]).all()
    assert isinstance(ab_mag(10.0), float)


def test_magnitude_error() -> None:
    assert mag_err(100.0, 1.0) == pytest.approx(2.5 / math.log(10.0) * 0.01)
    e = mag_err(np.array([100.0, 0.0]), np.array([10.0, 1.0]))
    assert e[0] == pytest.approx(0.10857, abs=1e-5) and math.isnan(e[1])
    # small-error limit: matches the difference of magnitudes
    assert ab_mag(1000.0) - ab_mag(1001.0) == pytest.approx(mag_err(1000.0, 1.0), rel=1e-3)


# --- epoch photometry ------------------------------------------------------------------------------


def light_curve_points() -> list[PhotPoint]:
    return [
        pt(100.0, wl=1.00, mjd=61000.0),
        pt(110.0, wl=1.05, mjd=61001.0),
        pt(90.0, wl=0.95, mjd=61002.0),
        pt(400.0, err=20.0, wl=3.0, det=4, mjd=61000.0),
        pt(900.0, err=5.0, wl=3.1, det=4, mjd=61001.0, sat=True),
        pt(800.0, err=8.0, wl=3.2, det=4, mjd=61190.0, epoch=1, sat=True),
        pt(810.0, err=8.0, wl=3.3, det=4, mjd=61191.0, epoch=1, sat=True),
        pt(150.0, wl=1.02, mjd=61188.0, epoch=1),
        pt(50.0, err=math.nan, wl=1.0, mjd=61500.0, epoch=None),
    ]


def test_epoch_photometry_by_detector() -> None:
    rows = epoch_photometry(light_curve_points())
    json.dumps(rows, allow_nan=False)
    assert [(r["epoch_index"], r["detector"]) for r in rows] == [(0, 1), (0, 4), (1, 1), (1, 4), (None, 1)]
    r = rows[0]
    assert r["flux_ujy"] == pytest.approx(100.0) and r["flux_err_ujy"] == pytest.approx(10.0 / math.sqrt(3))
    assert r["wavelength_um"] == pytest.approx(1.0) and r["n"] == 3 and r["n_points"] == 3
    assert r["wavelength_min_um"] == 0.95 and r["wavelength_max_um"] == 1.05
    assert r["mjd_mean"] == pytest.approx(61001.0) and r["mjd_min"] == 61000.0 and r["mjd_max"] == 61002.0
    assert r["chi2_red"] == pytest.approx((0.0 + 1.0 + 1.0) / 2.0)
    assert r["ab_mag"] == pytest.approx(ab_mag(100.0)) and r["ab_mag"] == pytest.approx(18.9, abs=1e-4)
    assert r["ab_mag_err"] == pytest.approx(mag_err(100.0, 10.0 / math.sqrt(3)))
    assert r["saturated_fraction"] == 0.0 and not r["used_saturated"]
    # default 'fallback': saturated points only when nothing else is available
    d4 = rows[1]
    assert d4["flux_ujy"] == pytest.approx(400.0) and d4["n"] == 1 and d4["n_saturated"] == 1
    assert d4["saturated_fraction"] == 0.5 and not d4["used_saturated"]
    d4_sat = rows[3]
    assert d4_sat["used_saturated"] and d4_sat["n"] == 2 and d4_sat["flux_ujy"] == pytest.approx(805.0)
    # unusable error: counted, not averaged
    assert rows[4]["n"] == 0 and rows[4]["flux_ujy"] is None and rows[4]["ab_mag"] is None and rows[4]["n_points"] == 1


def test_epoch_photometry_saturation_policies_and_grouping() -> None:
    pts = light_curve_points()
    excl = {(r["epoch_index"], r["detector"]): r for r in epoch_photometry(pts, saturated="exclude")}
    assert excl[(1, 4)]["n"] == 0 and excl[(1, 4)]["flux_ujy"] is None and excl[(1, 4)]["n_saturated"] == 2
    incl = {(r["epoch_index"], r["detector"]): r for r in epoch_photometry(pts, saturated="include")}
    w = np.array([1 / 400.0, 1 / 25.0])
    assert incl[(0, 4)]["flux_ujy"] == pytest.approx((400.0 * w[0] + 900.0 * w[1]) / w.sum())
    assert incl[(0, 4)]["used_saturated"]
    alld = epoch_photometry(pts, by="all")
    assert [r["epoch_index"] for r in alld] == [0, 1, None] and all(r["detector"] is None for r in alld)
    assert alld[0]["n_points"] == 5 and alld[0]["n"] == 4
    with pytest.raises(ValueError):
        epoch_photometry(pts, by="channel")
    with pytest.raises(ValueError):
        epoch_photometry(pts, saturated="maybe")
    assert epoch_photometry([]) == []


# --- same-channel series ---------------------------------------------------------------------------


def test_same_channel_series_selects_by_bandwidth() -> None:
    pts = [
        pt(1.0, wl=2.00, bw=0.05, det=3, mjd=61300.0),
        pt(2.0, wl=2.02, bw=0.05, det=3, mjd=61100.0),  # 0.4 bandwidths away: in
        pt(3.0, wl=2.03, bw=0.05, det=3, mjd=61200.0),  # 0.6 bandwidths away: out
        pt(4.0, wl=1.99, bw=0.05, det=2, mjd=61000.0),  # other detector (overlap region)
        pt(5.0, wl=2.00, bw=math.nan, det=3, mjd=61400.0),  # no bandwidth: skipped
        pt(6.0, wl=2.00, bw=0.0, det=3, mjd=61500.0),
    ]
    got = same_channel_series(pts, 2.0)
    assert [p.flux_ujy for p in got] == [4.0, 2.0, 1.0]  # sorted by MJD
    assert [p.flux_ujy for p in same_channel_series(pts, 2.0, detector=3)] == [2.0, 1.0]
    assert [p.flux_ujy for p in same_channel_series(pts, 2.0, tol_bandwidth=1.0)] == [4.0, 2.0, 3.0, 1.0]
    assert same_channel_series(pts, 4.0) == []


# --- variability -----------------------------------------------------------------------------------


def test_constant_source_is_not_variable() -> None:
    rng = np.random.default_rng(1)
    pts = [pt(1000.0 + rng.normal(0.0, 10.0), err=10.0, mjd=61000.0 + k) for k in range(60)]
    v = variability_significance(pts)
    json.dumps(v, allow_nan=False)
    assert v["n"] == 60 and v["dof"] == 59
    assert 0.6 < v["chi2_red"] < 1.5 and v["p_value"] > 0.01 and v["sigma"] < 2.6
    assert v["weighted_mean_ujy"] == pytest.approx(1000.0, abs=3.0)


def test_variable_source_and_largest_change() -> None:
    pts = [pt(100.0, err=1.0, mjd=61000.0), pt(100.0 * 10**0.4, err=1.0, mjd=61180.0), pt(150.0, err=1.0, mjd=61360.0)]
    v = variability_significance(pts)
    assert v["max_delta_mag"] == pytest.approx(1.0, abs=1e-9)  # the 100 -> 251 uJy pair
    assert v["pair_mjd"] == [61000.0, 61180.0]
    assert v["max_delta_sigma"] == pytest.approx((100.0 * 10**0.4 - 100.0) / math.sqrt(2.0))
    assert v["max_delta_mag_err"] == pytest.approx(math.hypot(mag_err(100.0, 1.0), mag_err(251.1886, 1.0)), rel=1e-4)
    assert v["max_pair_sigma"] == pytest.approx(v["max_delta_sigma"])
    assert v["sigma"] > 30 and v["p_value"] == pytest.approx(0.0, abs=1e-300)
    assert v["chi2_red"] > 1000
    # chi2 far in the tail (scipy's logsf is -inf there): dof 2 has P = exp(-chi2 / 2) exactly
    assert _chi2_log_sf(3000.0, 2) == pytest.approx(-1500.0)
    assert _chi2_log_sf(10.0, 2) == pytest.approx(-5.0)
    assert v["sigma"] == pytest.approx(math.sqrt(-2.0 * _chi2_log_sf(v["chi2"], 2)), rel=1e-6)


def test_variability_of_epoch_rows_and_short_series() -> None:
    rows = epoch_photometry([pt(100.0, mjd=61000.0, epoch=0), pt(200.0, mjd=61180.0, epoch=1)])
    v = variability_significance(rows)  # mappings with mjd_mean work too
    assert v["n"] == 2 and v["pair_mjd"] == [61000.0, 61180.0]
    assert v["max_delta_mag"] == pytest.approx(2.5 * math.log10(2.0))
    one = variability_significance([pt(100.0)])
    assert one["n"] == 1 and one["chi2"] is None and one["sigma"] is None and one["max_delta_mag"] is None
    neg = variability_significance([pt(-5.0, mjd=61000.0), pt(5.0, mjd=61001.0)])
    assert neg["max_delta_mag"] is None and neg["max_pair_sigma"] == pytest.approx(10.0 / math.sqrt(200.0))
