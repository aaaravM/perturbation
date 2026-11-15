"""Light curves from forced-photometry points: epoch photometry, same-channel series, AB magnitudes.

Single SPHEREx exposures mix wavelength and time (each exposure of a position samples a different
channel), so in the wide survey brightness changes are judged either from per-epoch means per detector
(``epoch_photometry``) or from points at matched wavelengths across epochs (``same_channel_series``).
``variability_significance`` tests a series against a constant source.

Returned dicts are JSON-ready (NaN -> None).
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from itertools import combinations
from typing import Any

import numpy as np
from numpy.typing import ArrayLike
from scipy import stats

from pxh.models import PhotPoint
from pxh.photometry.spectrum import finite_or_none, weighted_mean

__all__ = [
    "AB_ZEROPOINT_JY",
    "ab_mag",
    "epoch_photometry",
    "mag_err",
    "same_channel_series",
    "variability_significance",
]

AB_ZEROPOINT_JY = 3631.0
_MAG_PER_LN = 2.5 / math.log(10.0)  # 1.0857
SATURATED_POLICIES = ("exclude", "include", "fallback")


def ab_mag(flux_ujy: ArrayLike) -> np.ndarray | float:
    """AB magnitude of a flux in uJy: -2.5 log10(F_Jy / 3631) (= 23.9 - 2.5 log10(F_uJy)); NaN if F <= 0."""
    f = np.asarray(flux_ujy, dtype=float)
    with np.errstate(divide="ignore", invalid="ignore"):
        m = np.where(f > 0, -2.5 * np.log10(np.where(f > 0, f, 1.0) * 1e-6 / AB_ZEROPOINT_JY), np.nan)
    return float(m) if m.ndim == 0 else m


def mag_err(flux_ujy: ArrayLike, flux_err_ujy: ArrayLike) -> np.ndarray | float:
    """1-sigma magnitude error 2.5 / ln(10) * err / flux; NaN if flux <= 0."""
    f = np.asarray(flux_ujy, dtype=float)
    e = np.asarray(flux_err_ujy, dtype=float)
    with np.errstate(divide="ignore", invalid="ignore"):
        m = np.where(f > 0, _MAG_PER_LN * e / np.where(f > 0, f, 1.0), np.nan)
    return float(m) if m.ndim == 0 else m


def _usable(p: PhotPoint) -> bool:
    return math.isfinite(p.flux_ujy) and math.isfinite(p.flux_err_ujy) and p.flux_err_ujy > 0


def _group_row(key_epoch: int | None, key_det: int | None, group: list[PhotPoint], saturated: str) -> dict[str, Any]:
    clean = [p for p in group if not p.saturated and _usable(p)]
    satd = [p for p in group if p.saturated and _usable(p)]
    if saturated == "include":
        used = clean + satd
    elif saturated == "exclude":
        used = clean
    else:  # fallback: saturated points only when nothing else is available
        used = clean if clean else satd
    flux, err, n, chi2_red = weighted_mean([p.flux_ujy for p in used], [p.flux_err_ujy for p in used])
    if n:
        w = np.array([1.0 / p.flux_err_ujy**2 for p in used])
        wl = float(np.sum(w * np.array([p.wavelength_um for p in used])) / np.sum(w))
        wls = [p.wavelength_um for p in used]
    else:
        wl, wls = math.nan, []
    mjds = [p.mjd for p in group]
    n_sat = sum(bool(p.saturated) for p in group)
    return {
        "epoch_index": key_epoch,
        "detector": key_det,
        "mjd_mean": finite_or_none(float(np.mean(mjds))) if mjds else None,
        "mjd_min": finite_or_none(min(mjds)) if mjds else None,
        "mjd_max": finite_or_none(max(mjds)) if mjds else None,
        "wavelength_um": finite_or_none(wl),
        "wavelength_min_um": finite_or_none(min(wls)) if wls else None,
        "wavelength_max_um": finite_or_none(max(wls)) if wls else None,
        "flux_ujy": finite_or_none(flux),
        "flux_err_ujy": finite_or_none(err),
        "ab_mag": finite_or_none(ab_mag(flux)) if n else None,
        "ab_mag_err": finite_or_none(mag_err(flux, err)) if n else None,
        "chi2_red": finite_or_none(chi2_red),
        "n": int(n),
        "n_points": len(group),
        "n_saturated": int(n_sat),
        "saturated_fraction": n_sat / len(group) if group else None,
        "used_saturated": any(p.saturated for p in used),
    }


def epoch_photometry(
    points: Sequence[PhotPoint], by: str = "detector", saturated: str = "fallback"
) -> list[dict[str, Any]]:
    """Weighted-mean flux per (epoch, detector) (``by='detector'``) or per epoch (``by='all'``).

    ``saturated`` chooses how saturated points enter the means: 'exclude', 'include', or 'fallback'
    (default: use them only when a group has no unsaturated point, e.g. R Dra; ``used_saturated`` says
    when that happened). Rows are sorted by epoch index (None last), then detector, and carry mean MJD,
    weighted mean wavelength, flux, error, AB magnitude, n, saturated fraction and reduced chi2.
    Note that a detector mean averages the channels sampled in that epoch.
    """
    if by not in ("detector", "all"):
        raise ValueError(f"by must be 'detector' or 'all', got {by!r}")
    if saturated not in SATURATED_POLICIES:
        raise ValueError(f"saturated must be one of {SATURATED_POLICIES}, got {saturated!r}")
    groups: dict[tuple[int | None, int | None], list[PhotPoint]] = {}
    for p in points:
        key = (p.epoch_index, int(p.detector) if by == "detector" else None)
        groups.setdefault(key, []).append(p)

    def order(k: tuple[int | None, int | None]) -> tuple[bool, int, int]:
        e, d = k
        return (e is None, -1 if e is None else e, -1 if d is None else d)

    return [_group_row(e, d, groups[(e, d)], saturated) for e, d in sorted(groups, key=order)]


def same_channel_series(
    points: Sequence[PhotPoint],
    wavelength_um: float,
    tol_bandwidth: float = 0.5,
    detector: int | None = None,
) -> list[PhotPoint]:
    """Points within ``tol_bandwidth`` x their own bandwidth of ``wavelength_um``, sorted by MJD.

    Optionally restricted to one detector. Points without a finite positive bandwidth are skipped.
    """
    out = []
    for p in points:
        if detector is not None and int(p.detector) != detector:
            continue
        bw = p.bandwidth_um
        if not (bw is not None and math.isfinite(bw) and bw > 0 and math.isfinite(p.wavelength_um)):
            continue
        if abs(p.wavelength_um - wavelength_um) <= tol_bandwidth * bw:
            out.append(p)
    return sorted(out, key=lambda p: p.mjd)


def _series_arrays(series: Sequence[PhotPoint | Mapping[str, Any]]) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    flux, err, mjd = [], [], []
    for s in series:
        if isinstance(s, Mapping):
            f, e, t = s.get("flux_ujy"), s.get("flux_err_ujy"), s.get("mjd", s.get("mjd_mean"))
        else:
            f, e, t = s.flux_ujy, s.flux_err_ujy, s.mjd
        flux.append(math.nan if f is None else float(f))
        err.append(math.nan if e is None else float(e))
        mjd.append(math.nan if t is None else float(t))
    f_arr, e_arr, t_arr = np.array(flux), np.array(err), np.array(mjd)
    ok = np.isfinite(f_arr) & np.isfinite(e_arr) & (e_arr > 0)
    return f_arr[ok], e_arr[ok], t_arr[ok]


def _chi2_log_sf(chi2: float, dof: int) -> float:
    """log P(X > chi2) for X ~ chi2(dof); scipy's logsf underflows to -inf already near chi2 ~ 1500."""
    log_p = float(stats.chi2.logsf(chi2, dof))
    if math.isfinite(log_p):
        return log_p
    s, x = 0.5 * dof, 0.5 * chi2  # leading term of the upper incomplete gamma function for large x
    return (s - 1.0) * math.log(x) - x - math.lgamma(s)


def _gaussian_sigma(log_p: float) -> float:
    """Two-sided Gaussian-equivalent significance of a p-value given as log(p)."""
    if log_p >= 0:
        return 0.0
    if log_p > -700:
        return float(stats.norm.isf(math.exp(log_p) / 2.0))
    return math.sqrt(-2.0 * log_p)  # asymptotic for tiny p


def variability_significance(series: Sequence[PhotPoint | Mapping[str, Any]]) -> dict[str, Any]:
    """Chi2 of a series against a constant flux, and the largest pairwise magnitude change.

    ``series`` holds PhotPoints or mappings with flux_ujy, flux_err_ujy and mjd (or mjd_mean), e.g. rows
    from ``epoch_photometry``. Returns n, weighted_mean_ujy, chi2, dof, chi2_red, p_value, sigma
    (Gaussian-equivalent significance of variability), and over pairs of points with positive flux:
    max_delta_mag (|delta m| of the most different pair), its max_delta_mag_err and max_delta_sigma
    (|F1 - F2| / sqrt(e1^2 + e2^2)), the pair's MJDs, and max_pair_sigma (the most significant pair).
    """
    f, e, t = _series_arrays(series)
    n = int(f.size)
    out: dict[str, Any] = {
        "n": n, "weighted_mean_ujy": None, "chi2": None, "dof": max(n - 1, 0), "chi2_red": None,
        "p_value": None, "sigma": None, "max_delta_mag": None, "max_delta_mag_err": None,
        "max_delta_sigma": None, "pair_mjd": None, "max_pair_sigma": None,
    }
    if n < 2:
        return out
    mean, _, _, _ = weighted_mean(f, e)
    chi2 = float(np.sum(((f - mean) / e) ** 2))
    dof = n - 1
    log_p = _chi2_log_sf(chi2, dof)
    out.update(
        weighted_mean_ujy=finite_or_none(mean), chi2=finite_or_none(chi2), dof=dof, chi2_red=finite_or_none(chi2 / dof),
        p_value=finite_or_none(math.exp(log_p)), sigma=finite_or_none(_gaussian_sigma(log_p)),
    )
    best_dm: tuple[float, int, int] | None = None
    best_sig = -1.0
    for i, j in combinations(range(n), 2):
        sig = abs(f[i] - f[j]) / math.hypot(e[i], e[j])
        best_sig = max(best_sig, sig)
        if f[i] > 0 and f[j] > 0:
            dm = abs(float(ab_mag(f[i])) - float(ab_mag(f[j])))
            if best_dm is None or dm > best_dm[0]:
                best_dm = (dm, i, j)
    out["max_pair_sigma"] = finite_or_none(best_sig)
    if best_dm is not None:
        dm, i, j = best_dm
        out.update(
            max_delta_mag=finite_or_none(dm),
            max_delta_mag_err=finite_or_none(math.hypot(float(mag_err(f[i], e[i])), float(mag_err(f[j], e[j])))),
            max_delta_sigma=finite_or_none(abs(f[i] - f[j]) / math.hypot(e[i], e[j])),
            pair_mjd=[finite_or_none(t[i]), finite_or_none(t[j])],
        )
    return out
