"""Tests for pxh.ml.specclass: the spectral classifier run with NumPy.

``fixtures/specclass_check.npz`` holds a few held-out test spectra with the logits, calibrated probabilities
and penultimate features that the PyTorch model gave for them at export (ml/spectra/train.py).
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

from pxh import config
from pxh.api import catalogs, field, lookup, routes
from pxh.api.app import create_app
from pxh.api.schemas import QuickSpectrum
from pxh.ml import specclass as sc

FIXTURE = Path(__file__).parent / "fixtures" / "specclass_check.npz"


@pytest.fixture(scope="module")
def check() -> dict[str, np.ndarray]:
    with np.load(FIXTURE) as z:
        return {k: z[k] for k in z.files}


def test_weights_are_small_and_described() -> None:
    assert sc.WEIGHTS_NPZ.stat().st_size < 2_000_000 and sc.WEIGHTS_JSON.stat().st_size < 2_000_000
    meta = json.loads(sc.WEIGHTS_JSON.read_text(encoding="utf-8"))
    assert meta["model"] == sc.MODEL_NAME and tuple(meta["classes"]) == sc.CLASSES
    assert set(meta["plain_names"]) == set(sc.CLASSES) and meta["temperature"] > 0
    assert len(meta["inputs"]["wavelength_um"]) == sc.N_CHANNELS
    m = meta["metrics"]
    assert 0 < m["test_accuracy"] <= 1 and 0 < m["test_macro_f1"] <= 1
    assert np.asarray(m["confusion_matrix"]).shape == (len(sc.CLASSES), len(sc.CLASSES))
    assert sc.model().cal_scores.size >= 100  # p-values down to 0.01 need >= 99 calibration scores


def test_numpy_matches_pytorch(check) -> None:
    m = sc.SpecClassifier.load()
    logits, feat = m.forward(sc.prepare(check["flux"], check["err"]))
    assert np.allclose(logits, check["logits"], atol=1e-4, rtol=1e-4)
    assert np.allclose(feat, check["features"], atol=1e-4, rtol=1e-4)
    assert np.allclose(m.probabilities(logits), check["probs"], atol=1e-5)
    res = m.predict(check["flux"], check["err"])
    assert np.allclose(res["probs"].sum(axis=1), 1.0) and np.all(res["anomaly_score"] >= 0)
    assert np.all((res["p_value"] > 0) & (res["p_value"] <= 1))


def test_classify_one_spectrum(check) -> None:
    out = sc.classify(check["flux"][0], check["err"][0], np.zeros(102, dtype=bool))
    assert out["status"] == "ok" and out["model"] == "specclass-v1"
    assert out["label"] in sc.CLASSES and out["label_text"] == sc.PLAIN[out["label"]]
    assert set(out["probs"]) == set(sc.CLASSES) and abs(sum(out["probs"].values()) - 1) < 1e-3
    assert out["confidence"] == max(out["probs"].values())
    assert set(out["anomaly"]) == {"score", "p_value", "unusual"}
    assert out["anomaly"]["unusual"] == (out["anomaly"]["p_value"] < 0.01)
    assert all(isinstance(c, str) for c in out["caveats"]) and out["channels_used"] >= sc.MIN_VALID_CHANNELS


def test_too_few_channels_or_too_faint_gives_none(check) -> None:
    f, e = check["flux"][0].astype(float).copy(), check["err"][0].astype(float).copy()
    blanked = f.copy()
    blanked[:70] = np.nan  # like the saturated core of a bright star
    out = sc.classify(blanked, e, np.r_[np.ones(70, bool), np.zeros(32, bool)])
    assert out["status"] == "none" and "channels" in out["reason"] and "saturated" in out["reason"]
    assert "label" not in out and out["model"] == "specclass-v1"
    faint = sc.classify(np.full(102, 1.0), np.full(102, 1.0))  # S/N 1 everywhere
    assert faint["status"] == "none" and faint["reason"].startswith("Too faint")
    assert sc.classify(np.ones(10), np.ones(10))["status"] == "none"
    assert sc.classify(np.full(102, np.nan), np.full(102, np.nan))["status"] == "none"


def test_a_partly_saturated_star_gets_none(check) -> None:
    lower = np.zeros(102, dtype=bool)
    lower[10:15] = True  # five lower limits: a bright star; its complete channels read low as well
    f = check["flux"][1].astype(float).copy()
    f[lower] = np.nan
    out = sc.classify(f, check["err"][1], lower)
    assert out["status"] == "none" and "saturated" in out["reason"]
    assert out["channels_used"] == int(sc.valid_channels(f, check["err"][1]).sum())


def test_lower_limits_add_a_caveat(check) -> None:
    lower = np.zeros(102, dtype=bool)
    lower[[3, 4]] = True
    f = check["flux"][1].astype(float).copy()
    f[[3, 4]] = np.nan
    out = sc.classify(f, check["err"][1], lower)
    assert out["status"] == "ok" and any("lower limits" in c for c in out["caveats"])


def test_prepare_normalises_and_masks() -> None:
    f = np.linspace(10.0, 20.0, 102)
    e = np.full(102, 1.0)
    f[7] = np.nan
    x = sc.prepare(f, e)
    assert x.shape == (1, 2, 102) and x.dtype == np.float32
    assert x[0, 1, 7] == 0 and x[0, 1, 50] == 0 and x[0, 1, 51] == 0 and x[0, 1].sum() == 99
    assert x[0, 0, 7] == 0
    assert np.allclose(sc.prepare(f * 1e3, e * 1e3), x, atol=1e-6)  # scale-free
    with pytest.raises(ValueError):
        sc.prepare(np.ones(10), np.ones(10))


def test_the_module_never_imports_torch() -> None:
    src = Path(sc.__file__).read_text(encoding="utf-8")
    assert "import torch" not in src and "from torch" not in src
    code = (
        "import sys, numpy as np; import pxh.ml.specclass as s; "
        "s.classify(np.linspace(100, 200, 102), np.full(102, 1.0)); "
        "assert 'torch' not in sys.modules; print('ok')"
    )
    run = subprocess.run([sys.executable, "-c", code], check=False, capture_output=True, text=True, timeout=120)
    assert run.returncode == 0 and run.stdout.strip() == "ok", run.stderr[-500:]


# --- API -------------------------------------------------------------------------------------------------------


@pytest.fixture
def api(monkeypatch: pytest.MonkeyPatch, tmp_path) -> TestClient:
    monkeypatch.setattr(config, "CACHE_DIR", tmp_path / "cache")
    field.clear_caches()
    catalogs._MEMO.clear()
    lookup.clear_caches()
    with TestClient(create_app()) as client:
        yield client


def _fake(flux: np.ndarray, err: np.ndarray, lower: np.ndarray | None = None) -> dict:
    wl = np.linspace(0.75, 5.0, 102)
    return {
        "wavelength_um": wl, "bandwidth_um": wl / 40, "flux_ujy": flux, "flux_err_ujy": err,
        "flux_partial_ujy": flux, "lower_limit": np.zeros(102, bool) if lower is None else lower,
        "label": "DR1 quick-look", "n_finite": int(np.isfinite(flux).sum()), "pixel_arcsec": 12.88,
        "notes": "quick look",
    }


def test_quick_spectrum_carries_the_classification(api: TestClient, monkeypatch, check) -> None:
    fake = _fake(check["flux"][2].astype(float), check["err"][2].astype(float))
    monkeypatch.setattr(routes.cube, "cube_spectrum", lambda ra, dec: fake)
    doc = api.get("/api/spectrum/quick", params={"ra": 150.0, "dec": 2.2}).json()
    QuickSpectrum.model_validate(doc)
    c = doc["classification"]
    assert c["status"] == "ok" and c["label"] in sc.CLASSES and c["model"] == "specclass-v1"
    direct = sc.classify(fake["flux_ujy"], fake["flux_err_ujy"], fake["lower_limit"])
    assert c == json.loads(json.dumps(direct))
    assert len(doc["wl_um"]) == 102 and doc["n_finite"] == fake["n_finite"]  # the old fields are unchanged


def test_saturated_spectrum_gets_none_with_a_reason(api: TestClient, monkeypatch) -> None:
    flux = np.full(102, np.nan)
    flux[:9] = 5e5
    lower = ~np.isfinite(flux)
    lower[[50, 51]] = False
    monkeypatch.setattr(routes.cube, "cube_spectrum", lambda ra, dec: _fake(flux, np.full(102, 100.0), lower))
    doc = api.get("/api/spectrum/quick", params={"ra": 269.45, "dec": 4.74}).json()
    QuickSpectrum.model_validate(doc)
    assert doc["classification"]["status"] == "none" and "saturated" in doc["classification"]["reason"]


def test_a_classifier_failure_never_breaks_the_spectrum(api: TestClient, monkeypatch, check) -> None:
    def boom(*a, **k):
        raise RuntimeError("weights corrupt")

    monkeypatch.setattr(lookup.specclass, "classify", boom)
    fake = _fake(check["flux"][2].astype(float), check["err"][2].astype(float))
    monkeypatch.setattr(routes.cube, "cube_spectrum", lambda ra, dec: fake)
    r = api.get("/api/spectrum/quick", params={"ra": 150.0, "dec": 2.2})
    assert r.status_code == 200 and r.json()["classification"]["status"] == "none"


def test_object_spectrum_part_carries_the_classification(monkeypatch, check) -> None:
    fake = _fake(check["flux"][3].astype(float), check["err"][3].astype(float))
    monkeypatch.setattr(lookup.cube, "cube_spectrum", lambda ra, dec: fake)
    part = lookup.spectrum_part(150.0, 2.2)
    assert part["status"] == "ok" and part["classification"]["status"] == "ok"
    assert part["classification"]["label"] in sc.CLASSES
