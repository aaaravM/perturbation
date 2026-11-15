"""Round trip of the survey format (ml/survey_io.py) on a small synthetic field written to a temp dir.

The arrays here are random numbers made up for the test; no survey data is read.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pytest
from astropy.wcs import WCS

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import survey_io as sio


def _grid_wcs(n: int) -> WCS:
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.crval = [150.0, -20.0]
    w.wcs.crpix = [(n + 1) / 2, (n + 1) / 2]
    w.wcs.cdelt = [-6.15 / 3600, 6.15 / 3600]
    w.wcs.radesys = "ICRS"
    return w


def _arrays(n_ep: int = 3, n: int = 11) -> dict:
    rng = np.random.default_rng(7)
    data = rng.normal(0.0, 0.01, (n_ep, n, n)).astype(np.float32)
    weight = np.full((n_ep, n, n), 1e4, dtype=np.float32)
    sat = np.zeros((n_ep, n, n), dtype=bool)
    if n_ep >= 2:
        data[0, 0, 0] = np.nan
        weight[0, 0, 0] = 0.0
        sat[1, 5, 5] = True
    return {
        "data": data,
        "weight": weight,
        "n_used": np.full((n_ep, n, n), 12, dtype=np.int16),
        "saturated": sat,
        "epoch_index": [0, 2, 3],
        "epoch_mjd": [60907.6, 61122.8, 61270.1],
        "epoch_start_mjd": [60902.9, 61110.1, 61268.6],
        "epoch_end_mjd": [60923.1, 61140.0, 61285.3],
        "epoch_label": ["Aug 2025", "Mar 2026", "Aug 2026"],
        "survey": ["S2", "S1", "S4"],
        "year": [1, 1, 2],
        "pa": [180, 0, 180],
        "full": [True, True, False],
        "wl_min_um": [4.42, 4.41, 4.43],
        "wl_max_um": [4.96, 5.00, 4.98],
        "wl_center_um": [4.70, 4.67, 4.70],
        "psf_fwhm_arcsec": [9.04, np.nan, 9.04],
        "n_images": [12, 12, 4],
        "n_available": [17, 20, 4],
        "coverage_fraction": [1.0, 1.0, 0.99],
        "wcs_header": _grid_wcs(n).to_header().tostring(sep="\n"),
        "meta_json": json.dumps({"schema": sio.SCHEMA, "field_id": "synthetic-1", "epochs": {"0": {"obs_ids": ["x"]}}}),
    }


def _write_status(root: Path) -> None:
    sio.write_json(root / "fields.json", {
        "schema": sio.FIELDS_SCHEMA,
        "fields": [
            {"id": "synthetic-1", "kind": "control", "status": "done", "detectors_done": ["D6"]},
            {"id": "synthetic-2", "kind": "known-mover", "status": "building", "detectors_done": ["D6", "D5"]},
            {"id": "synthetic-3", "kind": "target", "status": "failed", "detectors_done": [], "error": "x"},
        ],
    })


def test_detector_round_trip(tmp_path: Path) -> None:
    arrays = _arrays()
    _write_status(tmp_path)
    sio.save_detector(sio.detector_path("synthetic-1", 6, tmp_path), arrays)
    d = sio.load_field("synthetic-1", 6, root=tmp_path)
    assert d["shape"] == (3, 11, 11)
    for name in ("data", "weight", "n_used", "saturated"):
        np.testing.assert_array_equal(d[name], arrays[name])
        assert d[name].dtype == np.dtype(sio.ARRAY_SPEC[name][0])
    np.testing.assert_allclose(d["epoch_mjd"], arrays["epoch_mjd"])
    assert list(d["epoch_label"]) == arrays["epoch_label"]
    assert list(d["survey"]) == ["S2", "S1", "S4"]
    assert d["full"].dtype == bool and list(d["full"]) == [True, True, False]
    assert np.isnan(d["psf_fwhm_arcsec"][1])
    assert d["meta"]["field_id"] == "synthetic-1"
    assert d["field"]["kind"] == "control"
    assert d["det"] == 6
    ra, dec = d["wcs"].pixel_to_world_values(5.0, 5.0)  # the centre pixel of an 11 x 11 grid
    assert ra == pytest.approx(150.0) and dec == pytest.approx(-20.0)
    assert sio.detector_keys("synthetic-1", root=tmp_path) == [6]


def test_list_fields_filters(tmp_path: Path) -> None:
    _write_status(tmp_path)
    assert [f["id"] for f in sio.list_fields(root=tmp_path)] == ["synthetic-1"]
    assert len(sio.list_fields(None, root=tmp_path)) == 3
    assert [f["id"] for f in sio.list_fields(None, det=5, root=tmp_path)] == ["synthetic-2"]
    assert [f["id"] for f in sio.list_fields(None, kind=["target", "control"], root=tmp_path)] == [
        "synthetic-1", "synthetic-3"]
    assert sio.list_fields(root=tmp_path / "missing") == []


def test_catalogs_round_trip(tmp_path: Path) -> None:
    doc = {"gaia": [{"source_id": "4472832130942575872", "ra": 269.45, "dec": 4.69}], "catwise": [], "simbad": [],
           "meta": {"gaia": {"epoch": 2016.0}}}
    sio.write_json(sio.field_dir("synthetic-1", tmp_path) / "catalogs.json", doc)
    assert sio.load_catalogs("synthetic-1", root=tmp_path) == doc


def test_gaia_at_moves_rows_with_proper_motion() -> None:
    cats = {"gaia": [
        {"source_id": "1", "ra": 10.0, "dec": 0.0, "pmra": 0.0, "pmdec": 1000.0, "parallax": 50.0,
         "phot_g_mean_mag": 12.0, "bp_rp": 2.5},
        {"source_id": "2", "ra": 10.01, "dec": 0.0, "pmra": None, "pmdec": None, "parallax": None,
         "phot_g_mean_mag": 20.5, "bp_rp": None},
    ]}
    mjd_2026 = 51544.5 + 26.0 * 365.25  # Julian year 2026.0
    g = sio.gaia_at(cats, mjd_2026)
    assert g["dec"][0] == pytest.approx(10.0 / 3600.0)  # 1 arcsec/yr north for 10 years
    assert g["ra"][1] == pytest.approx(10.01) and not g["has_pm"][1]
    fast = sio.gaia_at(cats, mjd_2026, min_pm_masyr=500.0)
    assert list(fast["source_id"]) == ["1"] and fast["pm"][0] == pytest.approx(1000.0)


def test_save_detector_rejects_bad_input(tmp_path: Path) -> None:
    arrays = _arrays()
    bad = dict(arrays)
    del bad["weight"]
    with pytest.raises(ValueError, match="missing"):
        sio.save_detector(tmp_path / "D6.npz", bad)
    bad = dict(arrays, n_used=np.zeros((3, 5, 5), dtype=np.int16))
    with pytest.raises(ValueError, match="shape"):
        sio.save_detector(tmp_path / "D6.npz", bad)
    bad = dict(arrays, epoch_mjd=[1.0, 2.0])
    with pytest.raises(ValueError, match="epochs"):
        sio.save_detector(tmp_path / "D6.npz", bad)
    with pytest.raises(ValueError, match="unknown"):
        sio.save_detector(tmp_path / "D6.npz", dict(arrays, extra=[1, 2, 3]))
    assert not (tmp_path / "D6.npz").exists()


def test_empty_detector(tmp_path: Path) -> None:
    arrays = _arrays(n_ep=0)
    for name in ("epoch_index", "epoch_mjd", "epoch_start_mjd", "epoch_end_mjd", "epoch_label", "survey", "year", "pa",
                 "full", "wl_min_um", "wl_max_um", "wl_center_um", "psf_fwhm_arcsec", "n_images", "n_available",
                 "coverage_fraction"):
        arrays[name] = []
    sio.save_detector(sio.detector_path("synthetic-1", 1, tmp_path), arrays)
    d = sio.load_field("synthetic-1", 1, root=tmp_path)
    assert d["shape"] == (0, 11, 11) and d["epoch_label"].shape == (0,)
