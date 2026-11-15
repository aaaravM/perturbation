"""NumPy inference for the mover/variable classifier (a small convolutional network trained in ``ml/movers``).

The network takes the finder's 4 x 21 x 21 stamps (``pxh.ml.movers.STAMP_CONVENTION``) and returns
probabilities for four classes: mover, variable, artifact, nothing. Architecture (as trained in PyTorch):

    conv 3x3 (4->16), ReLU, conv 3x3 (16->16), ReLU, max-pool 2      21 -> 10
    conv 3x3 (16->32), ReLU, conv 3x3 (32->32), ReLU, max-pool 2     10 -> 5
    conv 3x3 (32->64), ReLU
    [global mean pool, global max pool] (128) -> dense 64, ReLU -> dense 4

All convolutions use padding 1. Probabilities are ``softmax(logits / T)`` with the temperature ``T`` fitted on
the validation fields (temperature scaling), so they are calibrated on held-out data.

The candidate score is ``P(mover) + P(variable)``. ``p_values`` compares scores with the scores of validation
null examples shipped with the weights (``null_scores``), via ``pxh.ml.fdr.conformal_p_values``.

Weights: ``weights/<name>.npz`` (arrays) and ``weights/<name>.json`` (classes, normalisation, temperature,
training summary and metrics). Only NumPy is used here: the API never imports PyTorch.
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view

from pxh.ml.fdr import conformal_p_values

WEIGHTS_DIR = Path(__file__).resolve().parent / "weights"
DEFAULT_MODEL = "realbogus_v1"
CONV_LAYERS = ("conv1", "conv2", "conv3", "conv4", "conv5")
POOL_AFTER = {"conv2", "conv4"}


def _conv3x3(x: np.ndarray, w: np.ndarray, b: np.ndarray) -> np.ndarray:
    """2-D cross-correlation, 3x3 kernel, stride 1, zero padding 1. x [N, C, H, W], w [O, C, 3, 3]."""
    n, c, h, wd = x.shape
    xp = np.pad(x, ((0, 0), (0, 0), (1, 1), (1, 1)))
    win = sliding_window_view(xp, (3, 3), axis=(2, 3))  # [N, C, H, W, 3, 3]
    cols = win.transpose(0, 2, 3, 1, 4, 5).reshape(n * h * wd, c * 9)
    out = cols @ w.reshape(w.shape[0], c * 9).T + b
    return out.reshape(n, h, wd, w.shape[0]).transpose(0, 3, 1, 2)


def _maxpool2(x: np.ndarray) -> np.ndarray:
    n, c, h, w = x.shape
    h2, w2 = h // 2, w // 2
    return x[:, :, : 2 * h2, : 2 * w2].reshape(n, c, h2, 2, w2, 2).max(axis=(3, 5))


def softmax(z: np.ndarray) -> np.ndarray:
    z = z - z.max(axis=1, keepdims=True)
    e = np.exp(z)
    return e / e.sum(axis=1, keepdims=True)


class RealBogus:
    """The trained classifier: ``predict_proba(stamps)``, ``score(probs)`` and ``p_values(scores)``."""

    def __init__(self, weights: dict[str, np.ndarray], meta: dict[str, Any]):
        self.weights = {k: np.asarray(v, dtype=np.float64) for k, v in weights.items()}
        self.meta = meta
        self.classes: list[str] = list(meta["classes"])
        self.temperature = float(meta.get("temperature", 1.0))
        null = self.weights.get("null_scores")
        self.null_scores = np.asarray(null, dtype=np.float64) if null is not None else None

    @classmethod
    def load(cls, name: str = DEFAULT_MODEL, directory: str | Path = WEIGHTS_DIR) -> RealBogus:
        directory = Path(directory)
        with np.load(directory / f"{name}.npz", allow_pickle=False) as z:
            weights = {k: z[k] for k in z.files}
        meta = json.loads((directory / f"{name}.json").read_text(encoding="utf-8"))
        return cls(weights, meta)

    @property
    def name(self) -> str:
        return str(self.meta.get("name", DEFAULT_MODEL))

    def logits(self, stamps: np.ndarray, batch: int = 256) -> np.ndarray:
        x_all = np.asarray(stamps, dtype=np.float64)
        if x_all.ndim != 4 or x_all.shape[1] != 4:
            raise ValueError(f"stamps must be [N, 4, H, W], got {x_all.shape}")
        out = []
        for i in range(0, len(x_all), batch):
            x = x_all[i : i + batch]
            for name in CONV_LAYERS:
                x = np.maximum(_conv3x3(x, self.weights[f"{name}.weight"], self.weights[f"{name}.bias"]), 0.0)
                if name in POOL_AFTER:
                    x = _maxpool2(x)
            feat = np.concatenate([x.mean(axis=(2, 3)), x.max(axis=(2, 3))], axis=1)
            h = np.maximum(feat @ self.weights["fc1.weight"].T + self.weights["fc1.bias"], 0.0)
            out.append(h @ self.weights["fc2.weight"].T + self.weights["fc2.bias"])
        if not out:
            return np.zeros((0, len(self.classes)))
        return np.concatenate(out, axis=0)

    def predict_proba(self, stamps: np.ndarray, calibrated: bool = True) -> np.ndarray:
        z = self.logits(stamps)
        return softmax(z / self.temperature if calibrated else z)

    def score(self, probs: np.ndarray) -> np.ndarray:
        """Candidate score: P(mover) + P(variable)."""
        p = np.asarray(probs)
        return p[:, self.classes.index("mover")] + p[:, self.classes.index("variable")]

    def p_values(self, scores: np.ndarray) -> np.ndarray:
        if self.null_scores is None or self.null_scores.size == 0:
            raise ValueError(f"model {self.name} has no null scores")
        return conformal_p_values(scores, self.null_scores)


@lru_cache(maxsize=4)
def load_model(name: str = DEFAULT_MODEL) -> RealBogus:
    return RealBogus.load(name)


def available(name: str = DEFAULT_MODEL) -> bool:
    return (WEIGHTS_DIR / f"{name}.npz").exists() and (WEIGHTS_DIR / f"{name}.json").exists()
