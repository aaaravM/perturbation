"""The exported classifier: NumPy inference matches PyTorch on a saved fixture, and the API never needs torch."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

from pxh.ml import realbogus
from pxh.ml.realbogus import DEFAULT_MODEL, RealBogus, softmax

FIXTURE = Path(__file__).parent / "fixtures" / "realbogus_check.npz"


def test_numpy_matches_pytorch_on_fixture() -> None:
    with np.load(FIXTURE, allow_pickle=False) as z:
        stamps, probs, logits, temp = z["stamps"], z["probs"], z["logits"], float(z["temperature"])
        name = str(z["model"])
    model = RealBogus.load(name)
    assert model.temperature == pytest.approx(temp)
    np.testing.assert_allclose(model.logits(stamps), logits, rtol=1e-4, atol=1e-4)
    np.testing.assert_allclose(model.predict_proba(stamps), probs, rtol=1e-4, atol=1e-5)
    # batching does not change the answer
    np.testing.assert_allclose(model.logits(stamps, batch=5), logits, rtol=1e-4, atol=1e-4)


def test_exported_model_is_small_and_complete() -> None:
    weights = realbogus.WEIGHTS_DIR / f"{DEFAULT_MODEL}.npz"
    meta_path = realbogus.WEIGHTS_DIR / f"{DEFAULT_MODEL}.json"
    assert weights.stat().st_size < 2_000_000 and meta_path.stat().st_size < 2_000_000
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    assert meta["classes"] == ["mover", "variable", "artifact", "nothing"]
    assert meta["temperature"] > 0 and "trained_on" in meta and "metrics" in meta
    model = realbogus.load_model()
    assert model.null_scores is not None and model.null_scores.size >= 1000
    assert np.all(np.diff(model.null_scores) >= 0)
    p = model.p_values(np.array([-1.0, 2.0]))
    assert p[0] == 1.0 and p[1] == pytest.approx(1.0 / (model.null_scores.size + 1))


def test_softmax_rows_sum_to_one() -> None:
    z = np.array([[1000.0, 0.0, -5.0, 2.0], [0.0, 0.0, 0.0, 0.0]])
    p = softmax(z)
    np.testing.assert_allclose(p.sum(axis=1), 1.0)
    assert np.isfinite(p).all()


def test_inference_never_imports_torch() -> None:
    code = (
        "import sys\n"
        "import pxh.ml.realbogus, pxh.ml.movers, pxh.ml.finder, pxh.api.candidates\n"
        "m = pxh.ml.realbogus.load_model()\n"
        "import numpy as np\n"
        "m.predict_proba(np.zeros((2, 4, 21, 21)))\n"
        "assert 'torch' not in sys.modules, 'torch was imported'\n"
    )
    subprocess.run([sys.executable, "-c", code], check=True, timeout=120)
    for mod in (realbogus.__file__,):
        text = Path(mod).read_text(encoding="utf-8")
        assert "import torch" not in text and "from torch" not in text
