"""Tests for pxh.photometry.spectrum: wavelength-sorted spectra and 17-channel binning (offline).
"""

from __future__ import annotations

import json
import math

import numpy as np
import pytest

from pxh import config
from pxh.models import PhotPoint
from pxh.photometry.spectrum import (
    assemble_spectrum,
    bin_channels,
    channel_edges_um,
    channel_index,
    finite_or_none,
    point_columns,
    weighted_mean,
)


def pt(
    wl: float,
    flux: float,
    err: float = 10.0,
    det: int = 1,
    mjd: float = 61000.0,
    epoch: int | None = 0,
    sat: bool = False,
    flags: int = 0,
    obs: str = "2026W01_1A_0001_1",
) -> PhotPoint:
    return PhotPoint(
        obs_id=obs, detector=det, mjd=mjd, wavelength_um=wl, bandwidth_um=wl / 40.0 if math.isfinite(wl) else wl,
        flux_ujy=flux, flux_err_ujy=err, x=100.0, y=200.0, flags=flags, saturated=sat, method="epsf",
        collection="spherex_dr1", epoch_index=epoch,
    )


def centre(det: int, ch: int) -> float:
    e = channel_edges_um(det)
    return float(math.sqrt(e[ch] * e[ch + 1]))


# --- helpers ---------------------------------------------------------------------------------------


def test_finite_or_none() -> None:
    assert finite_or_none(1.5) == 1.5 and finite_or_none(np.float32(2.0)) == 2.0
    assert finite_or_none(math.nan) is None and finite_or_none(math.inf) is None
    assert finite_or_none(None) is None and finite_or_none("x") is None


def test_weighted_mean_math() -> None:
    mean, err, n, chi2_red = weighted_mean([10.0, 20.0, math.nan, 5.0], [1.0, 2.0, 1.0, 0.0])
    assert n == 2  # NaN value and zero error are ignored
    assert mean == pytest.approx((10.0 + 20.0 / 4.0) / 1.25)
    assert err == pytest.approx(1.0 / math.sqrt(1.25))
    assert chi2_red == pytest.approx((10.0 - 12.0) ** 2 + (20.0 - 12.0) ** 2 / 4.0)
    m1 = weighted_mean([3.0], [0.5])
    assert m1[:3] == (3.0, 0.5, 1) and math.isnan(m1[3])
    empty = weighted_mean([], [])
    assert empty[2] == 0 and all(math.isnan(v) for v in (empty[0], empty[1], empty[3]))


# --- assemble_spectrum -----------------------------------------------------------------------------


def test_assemble_spectrum_sorts_and_groups_by_epoch() -> None:
    points = [
        pt(3.0, 300.0, det=4, epoch=1, mjd=61190.0),
        pt(0.9, 90.0, det=1, epoch=1, mjd=61185.0),
        pt(1.3, 130.0, det=2, epoch=0, mjd=61003.0),
        pt(0.8, 80.0, det=1, epoch=0, mjd=61001.0),
        pt(4.8, 480.0, det=6, epoch=0, mjd=61002.0, sat=True, flags=2),
        pt(2.0, 200.0, det=3, epoch=None, mjd=61500.0),
        pt(math.nan, 1.0, det=1, epoch=0, mjd=61004.0),
    ]
    s = assemble_spectrum(points)
    json.dumps(s, allow_nan=False)  # JSON-ready: no NaN anywhere
    assert s["n_points"] == 7 and s["n_epochs"] == 3
    assert s["units"]["wavelength"] == "um" and s["units"]["flux"] == "uJy"
    assert s["points"]["wavelength_um"] == [0.8, 0.9, 1.3, 2.0, 3.0, 4.8, None]  # no wavelength sorts last
    assert s["points"]["flux_ujy"] == [80.0, 90.0, 130.0, 200.0, 300.0, 480.0, 1.0]
    assert s["points"]["saturated"] == [False] * 5 + [True, False]
    assert s["points"]["flags"][5] == 2 and s["points"]["detector"] == [1, 1, 2, 3, 4, 6, 1]
    assert [e["epoch_index"] for e in s["epochs"]] == [0, 1, None]
    e0 = s["epochs"][0]
    assert e0["wavelength_um"] == [0.8, 1.3, 4.8, None]
    assert e0["n_points"] == 4 and e0["n_saturated"] == 1 and e0["detectors"] == [1, 2, 6]
    assert e0["mjd_min"] == 61001.0 and e0["mjd_max"] == 61004.0 and e0["mjd_mean"] == pytest.approx(61002.5)
    assert s["epochs"][1]["wavelength_um"] == [0.9, 3.0]
    assert s["epochs"][2]["epoch_index"] is None and s["epochs"][2]["n_points"] == 1


def test_assemble_spectrum_empty_and_columns() -> None:
    s = assemble_spectrum([])
    assert s["n_points"] == 0 and s["epochs"] == [] and s["points"]["flux_ujy"] == []
    cols = point_columns([pt(1.0, math.inf, err=math.nan)])
    assert cols["flux_ujy"] == [None] and cols["flux_err_ujy"] == [None] and cols["obs_id"] == ["2026W01_1A_0001_1"]


# --- channel binning -------------------------------------------------------------------------------


@pytest.mark.parametrize("det", sorted(config.DETECTOR_BANDS_UM))
def test_channel_edges_are_log_uniform(det: int) -> None:
    e = channel_edges_um(det)
    lo, hi = config.DETECTOR_BANDS_UM[det]
    assert e.size == config.CHANNELS_PER_DETECTOR + 1
    assert e[0] == pytest.approx(lo) and e[-1] == pytest.approx(hi)
    np.testing.assert_allclose(e[1:] / e[:-1], (hi / lo) ** (1.0 / 17.0))
    for ch in (0, 8, 16):
        assert channel_index(det, centre(det, ch)) == ch


def test_channel_index_edges_and_invalid() -> None:
    e = channel_edges_um(5)
    step = e[1] / e[0]
    assert channel_index(5, e[0] / step**0.5) == 0  # within one bin below the nominal band
    assert channel_index(5, e[-1] * step**0.5) == 16  # within one bin above
    assert channel_index(5, e[0] / step**1.5) is None and channel_index(5, e[-1] * step**1.5) is None
    for bad in (math.nan, 0.0, -1.0, math.inf):
        assert channel_index(5, bad) is None
    assert channel_index(7, 1.0) is None
    with pytest.raises(ValueError):
        channel_edges_um(0)
    with pytest.raises(ValueError):
        channel_edges_um(1, 0)


def test_bin_channels_inverse_variance_means_and_saturation() -> None:
    wl = centre(1, 3)
    points = [
        pt(wl * 0.999, 100.0, err=10.0, mjd=61000.0),
        pt(wl * 1.001, 130.0, err=20.0, mjd=61002.0),
        pt(wl, 500.0, err=5.0, sat=True),  # saturated: reported, not averaged in
        pt(centre(6, 16), 50.0, err=5.0, det=6),
        pt(10.0, 1.0, det=6),  # far outside D6
        pt(wl, math.nan, det=1),  # no flux
        pt(wl, 1.0, err=0.0, det=1),  # no error
    ]
    b = bin_channels(points)
    json.dumps(b, allow_nan=False)
    assert b["n_per_detector"] == 17 and b["n_outside"] == 1 and b["n_invalid"] == 2
    assert [d["detector"] for d in b["detectors"]] == [1, 2, 3, 4, 5, 6]
    d1 = b["detectors"][0]
    assert len(d1["flux_ujy"]) == 17 and len(d1["edges_um"]) == 18
    w = np.array([1 / 100.0, 1 / 400.0])
    assert d1["flux_ujy"][3] == pytest.approx((100.0 * w[0] + 130.0 * w[1]) / w.sum())
    assert d1["flux_err_ujy"][3] == pytest.approx(1.0 / math.sqrt(w.sum()))
    assert d1["wavelength_um"][3] == pytest.approx((wl * 0.999 * w[0] + wl * 1.001 * w[1]) / w.sum())
    assert d1["n"][3] == 2 and d1["n_saturated"][3] == 1 and d1["mjd_mean"][3] == pytest.approx(61001.0)
    assert d1["chi2_red"][3] == pytest.approx(((100.0 - d1["flux_ujy"][3]) / 10) ** 2 + ((130.0 - d1["flux_ujy"][3]) / 20) ** 2)
    assert d1["flux_ujy_saturated"][3] == 500.0 and d1["flux_err_ujy_saturated"][3] == 5.0
    # empty bins: no flux, wavelength at the bin centre
    assert d1["flux_ujy"][0] is None and d1["n"][0] == 0 and d1["wavelength_um"][0] == pytest.approx(centre(1, 0))
    assert b["detectors"][5]["flux_ujy"][16] == 50.0
    # flat arrays over all 6 x 17 bins, sorted by wavelength
    assert len(b["center_um"]) == 102 and b["center_um"] == sorted(b["center_um"])
    k = next(i for i, (det, ch) in enumerate(zip(b["detector"], b["channel"])) if det == 1 and ch == 3)
    assert b["flux_ujy"][k] == pytest.approx(d1["flux_ujy"][3]) and b["n_saturated"][k] == 1
    assert b["bin_lo_um"][k] < wl < b["bin_hi_um"][k]


def test_bin_channels_saturated_only_bin_and_custom_count() -> None:
    wl = centre(4, 10)
    b = bin_channels([pt(wl, 7.0e6, err=1.0e5, det=4, sat=True)])
    d4 = b["detectors"][3]
    assert d4["flux_ujy"][10] is None and d4["n"][10] == 0 and d4["n_saturated"][10] == 1
    assert d4["flux_ujy_saturated"][10] == 7.0e6
    small = bin_channels([pt(1.0, 10.0)], n_per_detector=4)
    assert small["n_per_detector"] == 4 and len(small["center_um"]) == 24
    assert sum(small["n"]) == 1
