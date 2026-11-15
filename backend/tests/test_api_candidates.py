"""Offline tests of GET /api/candidates: co-adds, catalogue and classifier are fakes (no network)."""

from __future__ import annotations

import base64
import io

import pytest
from fastapi.testclient import TestClient
from PIL import Image
from test_ml_movers import EPOCH_MJD, make_stack, tiny_model

from pxh import config
from pxh.api import candidates, catalogs, field
from pxh.api.app import create_app
from pxh.api.caching import CDN_DAY, NO_STORE
from pxh.api.errors import ApiProblem

FOV_DEG = 0.1042  # the synthetic grid: 61 px of 6.15 arcsec


def _index(empty: bool = False) -> field.FieldIndex:
    entries = [{"index": e, "label": "x", "survey": "S1", "year": 1, "pa": 0, "start": "2025-01-01",
                "end": "2025-01-10", "mjd_mid": mjd, "n_exposures": 50, "detectors": {"4": 12}, "full": True}
               for e, mjd in EPOCH_MJD.items()]
    return field.FieldIndex(ra=150.0, dec=2.2, exposures=[] if empty else [object()], epochs=list(EPOCH_MJD),
                            epoch_entries=entries, searched=["spherex_dr1"], deep=False, n_deep_found=0,
                            discovered_at=None)


@pytest.fixture
def api(monkeypatch: pytest.MonkeyPatch, tmp_path) -> TestClient:
    monkeypatch.setattr(config, "CACHE_DIR", tmp_path / "cache")
    candidates._RESULTS.clear()
    stack = make_stack()
    calls = {"coadds": 0, "failed_det": None, "gaia": "ok"}

    def detector_coadds(index, fov, det, *, settings=None):
        calls["coadds"] += 1
        failed = 1 if calls["failed_det"] == det else 0
        return field.DetectorCoadds(det=det, frames=stack.frames[det], saturated=stack.saturated[det], used=[],
                                    n_available=36, n_selected=36, n_failed=failed, n_outside=0, n_skipped=0,
                                    per_epoch_cap=12, seconds=0.1, requests=0, bytes=0)

    def gaia_sources(ra, dec, radius_arcmin, epoch_mjd):
        if calls["gaia"] == "down":
            raise RuntimeError("Gator is down")
        return [{"source_id": "42", "ra": 150.0, "dec": 2.2, "g": 15.0, "bp_rp": 1.0, "pmra": 0.0, "pmdec": 0.0,
                 "parallax": 1.0}]

    monkeypatch.setattr(field, "index_field", lambda ra, dec: _index())
    monkeypatch.setattr(field, "detector_coadds", detector_coadds)
    monkeypatch.setattr(catalogs, "gaia_sources", gaia_sources)
    model = tiny_model()
    monkeypatch.setattr(candidates, "load_model", lambda: model)
    monkeypatch.setattr(candidates, "available", lambda: True)
    with TestClient(create_app()) as client:
        client.calls = calls  # type: ignore[attr-defined]
        yield client


def test_candidates_complete_answer(api: TestClient) -> None:
    r = api.get("/api/candidates", params={"ra": 150.0, "dec": 2.2, "fov": FOV_DEG})
    assert r.status_code == 200, r.text
    assert r.headers["cache-control"] == CDN_DAY
    doc = r.json()
    assert set(doc) >= {"field", "candidates", "timing", "notes", "model", "fdr"}
    f = doc["field"]
    assert f["complete"] is True and f["detectors"] == ["D4", "D5", "D6"] and f["n_epochs"] == 3
    assert f["n_candidates"] >= len(doc["candidates"]) and f["n_kept"] <= f["n_candidates"]
    assert doc["fdr"]["alpha"] == 0.05 and doc["model"]["name"] == "tiny"
    qs = [c["q_value"] for c in doc["candidates"]]
    assert qs == sorted(qs) and all(q <= 0.2 for q in qs)
    for c in doc["candidates"]:
        assert c["kind"] in ("mover", "variable")
        assert c["stamp"].startswith("data:image/png;base64,")
        img = Image.open(io.BytesIO(base64.b64decode(c["stamp"].split(",", 1)[1])))
        assert img.size == (192, 64)
        assert c["match"]["status"] in ("known", "unknown")
        assert (c["motion"] is None) or set(c["motion"]) == {"pm_arcsec_yr", "pm_err_arcsec_yr", "pa_deg", "n_epochs"}
    assert doc["timing"]["total_s"] >= 0
    # a second request comes from memory
    n = api.calls["coadds"]
    assert api.get("/api/candidates", params={"ra": 150.0, "dec": 2.2, "fov": FOV_DEG}).json() == doc
    assert api.calls["coadds"] == n


def test_candidates_partial_answers_are_not_cached(api: TestClient) -> None:
    api.calls["failed_det"] = 5
    r = api.get("/api/candidates", params={"ra": 150.0, "dec": 2.2, "fov": FOV_DEG})
    assert r.status_code == 200
    assert r.headers["cache-control"] == NO_STORE
    doc = r.json()
    assert doc["field"]["complete"] is False
    assert any("D5" in n and "failed" in n for n in doc["notes"])


def test_candidates_without_gaia(api: TestClient) -> None:
    api.calls["gaia"] = "down"
    doc = api.get("/api/candidates", params={"ra": 150.0, "dec": 2.2, "fov": FOV_DEG, "dets": "6"}).json()
    assert doc["field"]["complete"] is False and doc["field"]["detectors"] == ["D6"]
    assert any("Gaia" in n for n in doc["notes"])
    assert all(c["match"]["status"] == "unknown" for c in doc["candidates"])


@pytest.mark.parametrize(
    ("params", "status"),
    [
        ({"ra": 150.0, "dec": 2.2, "fov": 1.0}, 422),
        ({"ra": 150.0, "dec": 2.2, "dets": "7"}, 422),
        ({"ra": 150.0, "dec": 95.0}, 422),
    ],
)
def test_candidates_input_errors(api: TestClient, params: dict, status: int) -> None:
    r = api.get("/api/candidates", params=params)
    assert r.status_code == status and r.json()["error"] == "invalid_input"


def test_candidates_no_coverage(api: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(field, "index_field", lambda ra, dec: _index(empty=True))
    r = api.get("/api/candidates", params={"ra": 10.0, "dec": 2.2})
    assert r.status_code == 404 and r.json()["error"] == "no_coverage"
    assert r.headers["cache-control"] == NO_STORE


def test_parse_dets() -> None:
    assert candidates.parse_dets(None) == (4, 5, 6)
    assert candidates.parse_dets("D6, 4,4") == (4, 6)
    with pytest.raises(ApiProblem):
        candidates.parse_dets("0")
