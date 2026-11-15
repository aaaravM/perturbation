"""What kind of object a SPHEREx quick-look spectrum looks like: a small 1D neural network, run with NumPy.

The model (``specclass-v1``) reads the 102-channel DR1 cube spectrum of `pxh.spherex.cube.cube_spectrum` in
its native plane order (ascending wavelength, 0.75-5.0 um; planes 50 and 51 are always blank) and returns
probabilities for seven classes: hot star (O/B/A), Sun-like star (F/G/K), cool star (M), brown dwarf (L/T/Y),
young or dusty star, galaxy and quasar. It was trained in the ``ml/`` project (PyTorch) on real SPHEREx
spectra of catalogued objects, labelled from SIMBAD and Gaia DR3, and its probabilities are calibrated
by temperature scaling on held-out sky tiles. Weights and metadata: ``weights/specclass_v1.npz`` and
``weights/specclass_v1.json``.

Inputs, per channel: the flux divided by a robust norm of the valid channels (the median absolute flux),
passed through asinh, and a validity mask (finite flux and a positive error). The network is two blocks of
1D convolutions with max pooling, a dense layer (the "penultimate" features) and the class layer.

Unusual spectra: the anomaly score is the smallest Mahalanobis distance (squared) of the penultimate
features from the training-class means, with one covariance shared by all classes. Its p-value is
conformal (`pxh.ml.fdr.conformal_p_values`) against the scores of a held-out calibration set of ordinary
labelled spectra, so ``p < 0.01`` flags about 1 in 100 ordinary spectra by chance.

The model is only used where it was trained: unsaturated sources (at most ``MAX_LOWER_LIMITS`` lower-limit
channels), at least ``MIN_VALID_CHANNELS`` complete channels and ``MIN_SNR5_CHANNELS`` channels at
signal-to-noise 5 or better. Anything else gets ``status: "none"`` and a plain ``reason``. Isolation cannot be
checked here: a neighbour blended into the 12.9-arcsec pixels changes the spectrum, which the anomaly score
may (or may not) notice. This module never imports a deep-learning library.
"""

from __future__ import annotations

import json
import logging
import threading
import warnings
from pathlib import Path
from typing import Any

import numpy as np
from numpy.typing import ArrayLike

from pxh.ml.fdr import conformal_p_values

log = logging.getLogger(__name__)

MODEL_NAME = "specclass-v1"
WEIGHTS_DIR = Path(__file__).resolve().parent / "weights"
WEIGHTS_NPZ = WEIGHTS_DIR / "specclass_v1.npz"
WEIGHTS_JSON = WEIGHTS_DIR / "specclass_v1.json"

N_CHANNELS = 102
BLANK_PLANES = (50, 51)
MIN_VALID_CHANNELS = 60
MIN_SNR5_CHANNELS = 20
MAX_LOWER_LIMITS = 2  # saturated stars: the cube's "complete" channels read low too (docs/data-findings.md)
UNUSUAL_P = 0.01

CLASSES = ("hot_star", "sunlike_star", "cool_star", "brown_dwarf", "young_dusty", "galaxy", "quasar")
PLAIN = {
    "hot_star": "hot star",
    "sunlike_star": "Sun-like star",
    "cool_star": "cool star",
    "brown_dwarf": "brown dwarf",
    "young_dusty": "young or dusty star",
    "galaxy": "galaxy",
    "quasar": "quasar",
}


# --- inputs ---------------------------------------------------------------------------------------------------


def valid_channels(flux: ArrayLike, err: ArrayLike) -> np.ndarray:
    """Boolean [..., 102]: finite flux, finite positive error, and not one of the always-blank planes."""
    f = np.asarray(flux, dtype=float)
    e = np.asarray(err, dtype=float)
    with np.errstate(invalid="ignore"):
        ok = np.isfinite(f) & np.isfinite(e) & (e > 0)
    ok[..., list(BLANK_PLANES)] = False
    return ok


def prepare(flux: ArrayLike, err: ArrayLike) -> np.ndarray:
    """Network input [N, 2, 102] (float32) from fluxes and errors [N, 102] (or one spectrum [102]).

    Channel 0: asinh(flux / norm) with norm the median absolute flux of the valid channels (0 elsewhere);
    channel 1: the validity mask. A spectrum without valid channels gives zeros.
    """
    f = np.atleast_2d(np.asarray(flux, dtype=float))
    e = np.atleast_2d(np.asarray(err, dtype=float))
    if f.shape[-1] != N_CHANNELS or f.shape != e.shape:
        raise ValueError(f"expected [N, {N_CHANNELS}] fluxes and errors, got {f.shape} and {e.shape}")
    ok = valid_channels(f, e)
    a = np.where(ok, np.abs(f), np.nan)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)  # all-NaN rows: no valid channel
        norm = np.nanmedian(a, axis=1)
    norm = np.where(np.isfinite(norm) & (norm > 0), norm, 1.0)
    x = np.where(ok, np.arcsinh(np.where(ok, f, 0.0) / norm[:, None]), 0.0)
    return np.stack([x, ok.astype(float)], axis=1).astype(np.float32)


def snr_channels(flux: ArrayLike, err: ArrayLike, threshold: float = 5.0) -> np.ndarray:
    """Number of valid channels with flux / error >= threshold, per spectrum."""
    f = np.atleast_2d(np.asarray(flux, dtype=float))
    e = np.atleast_2d(np.asarray(err, dtype=float))
    ok = valid_channels(f, e)
    with np.errstate(all="ignore"):
        return np.sum(ok & (np.where(ok, f, 0.0) >= threshold * np.where(ok, e, np.inf)), axis=1)


# --- network ------------------------------------------------------------------------------------------------------


def _conv1d(x: np.ndarray, w: np.ndarray, b: np.ndarray) -> np.ndarray:
    """'Same' 1D convolution (odd kernel, stride 1): x [N, C, L], w [O, C, K], b [O] -> [N, O, L]."""
    k = w.shape[2]
    p = k // 2
    xp = np.pad(x, ((0, 0), (0, 0), (p, p)))
    win = np.lib.stride_tricks.sliding_window_view(xp, k, axis=2)  # [N, C, L, K]
    return np.einsum("nclk,ock->nol", win, w, optimize=True) + b[None, :, None]


def _maxpool2(x: np.ndarray) -> np.ndarray:
    n, c, length = x.shape
    m = length // 2
    return x[:, :, : 2 * m].reshape(n, c, m, 2).max(axis=3)


class SpecClassifier:
    """The exported network (batch norm folded into the convolutions), temperature and anomaly model."""

    def __init__(self, arrays: dict[str, np.ndarray], meta: dict[str, Any]) -> None:
        self.meta = meta
        self.classes = tuple(meta["classes"])
        self.blocks = [str(b) for b in meta["architecture"]["blocks"]]
        self.w = {k: np.asarray(v, dtype=np.float64) for k, v in arrays.items()}
        self.temperature = float(meta["temperature"])
        self.cal_scores = np.sort(np.asarray(arrays["anomaly_cal_scores"], dtype=float))

    @classmethod
    def load(cls, npz: Path = WEIGHTS_NPZ, meta_path: Path = WEIGHTS_JSON) -> SpecClassifier:
        meta = json.loads(Path(meta_path).read_text(encoding="utf-8"))
        with np.load(npz) as z:
            arrays = {k: z[k] for k in z.files}
        return cls(arrays, meta)

    def forward(self, x: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """(logits [N, n_classes] before temperature, penultimate features [N, H]) for inputs [N, 2, 102]."""
        h = np.asarray(x, dtype=np.float64)
        for name in self.blocks:
            if name == "pool":
                h = _maxpool2(h)
            else:
                h = np.maximum(_conv1d(h, self.w[f"{name}.weight"], self.w[f"{name}.bias"]), 0.0)
        h = h.reshape(h.shape[0], -1)
        feat = np.maximum(h @ self.w["fc1.weight"].T + self.w["fc1.bias"], 0.0)
        logits = feat @ self.w["fc2.weight"].T + self.w["fc2.bias"]
        return logits, feat

    def probabilities(self, logits: np.ndarray) -> np.ndarray:
        z = logits / self.temperature
        z = z - z.max(axis=1, keepdims=True)
        p = np.exp(z)
        return p / p.sum(axis=1, keepdims=True)

    def anomaly_scores(self, feat: np.ndarray) -> np.ndarray:
        """Smallest squared Mahalanobis distance of each feature vector from the class means."""
        mu = self.w["anomaly_means"]  # [n_classes, H]
        prec = self.w["anomaly_precision"]  # [H, H]
        d = feat[:, None, :] - mu[None, :, :]
        m = np.einsum("nch,hk,nck->nc", d, prec, d, optimize=True)
        return m.min(axis=1)

    def predict(self, flux: ArrayLike, err: ArrayLike) -> dict[str, np.ndarray]:
        """Probabilities, anomaly scores and conformal p-values for a batch of spectra [N, 102]."""
        x = prepare(flux, err)
        logits, feat = self.forward(x)
        scores = self.anomaly_scores(feat)
        return {
            "probs": self.probabilities(logits),
            "logits": logits,
            "features": feat,
            "anomaly_score": scores,
            "p_value": conformal_p_values(scores, self.cal_scores),
        }


_LOCK = threading.Lock()
_MODEL: SpecClassifier | None = None
_LOAD_ERROR: str | None = None


def model() -> SpecClassifier | None:
    """The deployed classifier, loaded once (None if the weights are missing or unreadable)."""
    global _MODEL, _LOAD_ERROR
    with _LOCK:
        if _MODEL is None and _LOAD_ERROR is None:
            try:
                _MODEL = SpecClassifier.load()
            except (OSError, ValueError, KeyError) as exc:
                _LOAD_ERROR = f"{type(exc).__name__}: {exc}"
                log.warning("spectral classifier unavailable: %s", _LOAD_ERROR)
        return _MODEL


def _none(reason: str, **extra: Any) -> dict[str, Any]:
    return {"status": "none", "reason": reason, "model": MODEL_NAME, **extra}


def classify(flux: ArrayLike, err: ArrayLike, lower_limit: ArrayLike | None = None) -> dict[str, Any]:
    """The API's ``classification`` object for one spectrum in cube plane order (102 values each).

    ``{status: "ok", label, label_text, probs: {class: p}, confidence, anomaly: {score, p_value, unusual},
    model, channels_used, caveats}``, or ``{status: "none", reason, model}`` when the spectrum is outside the
    range the model was trained on (too few complete channels, or too faint) or the model is not available.
    """
    f = np.asarray(flux, dtype=float).ravel()
    e = np.asarray(err, dtype=float).ravel()
    if f.size != N_CHANNELS or e.size != N_CHANNELS:
        return _none(f"The classifier needs the {N_CHANNELS}-channel cube spectrum; got {f.size} channels.")
    ok = valid_channels(f, e)
    n_valid = int(ok.sum())
    n_lower = int(np.sum(np.asarray(lower_limit, dtype=bool))) if lower_limit is not None else 0
    if n_valid < MIN_VALID_CHANNELS:
        why = " The cube blanks the centres of bright, saturated stars." if n_lower else ""
        return _none(
            f"Only {n_valid} of {N_CHANNELS - len(BLANK_PLANES)} channels have a complete measurement; "
            f"the classifier needs {MIN_VALID_CHANNELS}.{why}",
            channels_used=n_valid,
        )
    if n_lower > MAX_LOWER_LIMITS:
        return _none(
            f"A bright star: {n_lower} channels are saturated or masked in the cube, which also makes the others "
            "read low. The classifier only reads unsaturated spectra.",
            channels_used=n_valid,
        )
    n_snr5 = int(snr_channels(f, e)[0])
    if n_snr5 < MIN_SNR5_CHANNELS:
        return _none(
            f"Too faint to classify: {n_snr5} channels are measured at 5 sigma or better; "
            f"the classifier needs {MIN_SNR5_CHANNELS}.",
            channels_used=n_valid,
        )
    m = model()
    if m is None:
        return _none("The spectral classifier is not available on this server.")
    res = m.predict(f[None, :], e[None, :])
    probs = res["probs"][0]
    best = int(np.argmax(probs))
    label = m.classes[best]
    p_value = float(res["p_value"][0])
    caveats = []
    if n_lower:
        caveats.append(
            f"{n_lower} channels are only lower limits (saturated or masked pixels); bright stars read low in "
            "the cube, so the class may be wrong."
        )
    if n_valid < N_CHANNELS - len(BLANK_PLANES) - 10:
        caveats.append(f"{N_CHANNELS - len(BLANK_PLANES) - n_valid} channels are missing.")
    return {
        "status": "ok",
        "label": label,
        "label_text": PLAIN.get(label, label),
        "probs": {c: round(float(p), 4) for c, p in zip(m.classes, probs, strict=True)},
        "confidence": round(float(probs[best]), 4),
        "anomaly": {
            "score": round(float(res["anomaly_score"][0]), 3),
            "p_value": round(p_value, 5),
            "unusual": bool(p_value < UNUSUAL_P),
        },
        "model": MODEL_NAME,
        "channels_used": n_valid,
        "caveats": caveats,
    }
