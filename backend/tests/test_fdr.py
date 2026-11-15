import numpy as np
import pytest

from pxh.ml.fdr import bh_q_values, conformal_p_values, discoveries


def test_conformal_p_values_count_null_scores_at_least_as_high():
    null = [0.1, 0.2, 0.3, 0.4]
    p = conformal_p_values([0.35, 0.5, 0.1, 0.4], null)
    np.testing.assert_allclose(p, [2 / 5, 1 / 5, 5 / 5, 2 / 5])


def test_conformal_p_values_handle_non_finite_values():
    p = conformal_p_values([np.nan, 0.9], [0.1, np.nan, 0.5])
    np.testing.assert_allclose(p, [1.0, 1 / 3])
    with pytest.raises(ValueError):
        conformal_p_values([0.5], [np.nan])


def test_conformal_p_values_are_valid_under_the_null():
    rng = np.random.default_rng(1)
    null = rng.normal(size=2000)
    p = conformal_p_values(rng.normal(size=20000), null)
    # Under the null, P(p <= t) <= t (up to sampling noise).
    for t in (0.01, 0.05, 0.2):
        assert np.mean(p <= t) <= t + 0.01


def test_bh_q_values_match_the_textbook_example():
    q = bh_q_values([0.01, 0.04, 0.03, 0.005, 0.5])
    np.testing.assert_allclose(q, [0.025, 0.05, 0.05, 0.025, 0.5])


def test_bh_q_values_are_monotone_in_p_and_capped_at_one():
    p = np.array([0.9, 0.001, 0.2, np.nan, 0.6])
    q = bh_q_values(p)
    assert q[3] == 1.0
    assert np.all(q <= 1.0)
    order = np.argsort(np.nan_to_num(p, nan=1.0))
    assert np.all(np.diff(q[order]) >= -1e-12)


def test_discoveries_controls_the_false_discovery_rate():
    rng = np.random.default_rng(2)
    n_null, n_real = 900, 100
    p = np.concatenate([rng.uniform(size=n_null), rng.uniform(0, 1e-4, size=n_real)])
    keep = discoveries(p, alpha=0.1)
    false = keep[:n_null].sum()
    assert keep[n_null:].all()
    assert false / max(keep.sum(), 1) <= 0.1
    with pytest.raises(ValueError):
        discoveries(p, alpha=1.5)


def test_empty_input():
    assert bh_q_values([]).size == 0
