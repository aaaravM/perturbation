"""False-discovery-rate control for candidate lists.

A detector or classifier gives every candidate a score (higher means more signal-like). Two steps turn the
scores into a list that can be trusted at a stated error rate:

1. Conformal p-values. Score a held-out *null* set: examples known to contain no real signal (noise,
   artifacts, stars that did not change). A candidate's p-value is the fraction of null scores at least as
   high as its own, ``p = (1 + #{null >= s}) / (n_null + 1)``. If the candidate is just another null example,
   this p-value is valid (never too small) whatever the distribution of the scores, so no Gaussian or other
   noise model is assumed.
2. Benjamini-Hochberg q-values. Listing every candidate with ``q <= alpha`` keeps the expected fraction of
   false discoveries in the list at or below ``alpha`` (for independent or positively dependent p-values).

A p-value can be no smaller than ``1 / (n_null + 1)``, so the null set must be large enough for the
thresholds used: with 2,000 null examples the smallest p-value is about 0.0005.
"""

from __future__ import annotations

import numpy as np
from numpy.typing import ArrayLike


def conformal_p_values(scores: ArrayLike, null_scores: ArrayLike) -> np.ndarray:
    """p-value of each score against a null set: ``(1 + #{null >= s}) / (n_null + 1)``.

    Non-finite scores get p = 1. Non-finite null scores are ignored.
    """
    s = np.asarray(scores, dtype=float).ravel()
    null = np.asarray(null_scores, dtype=float).ravel()
    null = np.sort(null[np.isfinite(null)])
    n = null.size
    if n == 0:
        raise ValueError("null_scores has no finite values")
    at_least = n - np.searchsorted(null, s, side="left")
    p = (1.0 + at_least) / (n + 1.0)
    p[~np.isfinite(s)] = 1.0
    return p


def bh_q_values(p_values: ArrayLike) -> np.ndarray:
    """Benjamini-Hochberg q-values, in the input order. NaN p-values are treated as 1."""
    p = np.asarray(p_values, dtype=float).ravel().copy()
    p[~np.isfinite(p)] = 1.0
    p = np.clip(p, 0.0, 1.0)
    m = p.size
    if m == 0:
        return p
    order = np.argsort(p, kind="mergesort")
    ranked = p[order] * m / np.arange(1, m + 1)
    q_sorted = np.minimum.accumulate(ranked[::-1])[::-1]
    q = np.empty(m, dtype=float)
    q[order] = np.minimum(q_sorted, 1.0)
    return q


def discoveries(p_values: ArrayLike, alpha: float = 0.05) -> np.ndarray:
    """Boolean mask of the candidates kept at false-discovery rate ``alpha``."""
    if not 0.0 < alpha < 1.0:
        raise ValueError("alpha must be between 0 and 1")
    return bh_q_values(p_values) <= alpha
