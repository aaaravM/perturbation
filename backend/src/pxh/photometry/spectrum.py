"""Spectra from forced-photometry points: wavelength-sorted point lists and 102-channel binned spectra.

At a fixed sky position every SPHEREx exposure samples one wavelength per detector (the wavelength
changes across each detector), so a source's spectrum is the set of its PhotPoints. An epoch (one
survey window) samples ~17 channels on each of the 6 detectors, i.e. one 102-channel spectrum.

``assemble_spectrum`` returns JSON-ready arrays sorted by wavelength, overall and per epoch.
``bin_channels`` averages points into 17 channels per detector (bins uniform in log wavelength between
the nominal ``config.DETECTOR_BANDS_UM`` limits) with inverse-variance weights. Saturated points are
kept out of the default bins but reported in parallel ``*_saturated`` columns.

Every returned dict holds only str / int / float / bool / None / lists, with NaN mapped to None, so it
can go straight into a JSON response.
"""

from __future__ import annotations

import math
from collections.abc import Iterable, Sequence
from typing import Any

import numpy as np

from pxh import config
from pxh.models import PhotPoint

__all__ = [
    "assemble_spectrum",
    "bin_channels",
    "channel_edges_um",
    "channel_index",
    "finite_or_none",
    "point_columns",
    "weighted_mean",
]

UNITS = {"wavelength": "um", "flux": "uJy", "time": "MJD (UTC)"}


def finite_or_none(value: Any) -> float | None:
    """float(value) if finite, else None (JSON has no NaN)."""
    if value is None:
        return None
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def weighted_mean(values: Sequence[float], errors: Sequence[float]) -> tuple[float, float, int, float]:
    """Inverse-variance weighted mean of values with 1-sigma errors.

    Returns (mean, error, n_used, reduced chi2 about the mean); entries with non-finite values or
    non-positive errors are ignored. Returns NaNs (and n_used=0) when nothing is usable.
    """
    v = np.asarray(values, dtype=float)
    e = np.asarray(errors, dtype=float)
    ok = np.isfinite(v) & np.isfinite(e) & (e > 0)
    if not ok.any():
        return math.nan, math.nan, 0, math.nan
    w = 1.0 / e[ok] ** 2
    mean = float(np.sum(w * v[ok]) / np.sum(w))
    err = 1.0 / math.sqrt(float(np.sum(w)))
    n = int(ok.sum())
    chi2_red = float(np.sum(w * (v[ok] - mean) ** 2)) / (n - 1) if n > 1 else math.nan
    return mean, err, n, chi2_red


def _sort_key(p: PhotPoint) -> tuple[bool, float, float]:
    wl = p.wavelength_um
    finite = wl is not None and math.isfinite(wl)
    return (not finite, wl if finite else 0.0, p.mjd)


def point_columns(points: Iterable[PhotPoint]) -> dict[str, list[Any]]:
    """Column lists (JSON-ready) of PhotPoint fields, in the given order."""
    pts = list(points)
    return {
        "wavelength_um": [finite_or_none(p.wavelength_um) for p in pts],
        "bandwidth_um": [finite_or_none(p.bandwidth_um) for p in pts],
        "flux_ujy": [finite_or_none(p.flux_ujy) for p in pts],
        "flux_err_ujy": [finite_or_none(p.flux_err_ujy) for p in pts],
        "mjd": [finite_or_none(p.mjd) for p in pts],
        "detector": [int(p.detector) for p in pts],
        "saturated": [bool(p.saturated) for p in pts],
        "flags": [int(p.flags) for p in pts],
        "method": [str(p.method) for p in pts],
        "obs_id": [str(p.obs_id) for p in pts],
        "epoch_index": [None if p.epoch_index is None else int(p.epoch_index) for p in pts],
    }


def assemble_spectrum(points: Sequence[PhotPoint]) -> dict[str, Any]:
    """Wavelength-sorted spectrum of one source, overall and grouped by ``epoch_index``.

    Returns {"n_points", "n_epochs", "units", "points": columns sorted by wavelength, "epochs": [one
    entry per epoch_index (None last) with epoch_index, n_points, n_saturated, mjd_min/max/mean and the
    same columns sorted by wavelength]}. Points with no wavelength sort last.
    """
    pts = sorted(points, key=_sort_key)
    keys = sorted({p.epoch_index for p in pts}, key=lambda e: (e is None, -1 if e is None else e))
    epochs = []
    for key in keys:
        group = [p for p in pts if p.epoch_index == key]
        mjds = [p.mjd for p in group if math.isfinite(p.mjd)]
        cols = point_columns(group)
        del cols["epoch_index"]  # the scalar below; a per-point copy would overwrite it
        epochs.append({
            **cols,
            "epoch_index": None if key is None else int(key),
            "n_points": len(group),
            "n_saturated": sum(bool(p.saturated) for p in group),
            "mjd_min": finite_or_none(min(mjds)) if mjds else None,
            "mjd_max": finite_or_none(max(mjds)) if mjds else None,
            "mjd_mean": finite_or_none(float(np.mean(mjds))) if mjds else None,
            "detectors": sorted({int(p.detector) for p in group}),
        })
    return {
        "n_points": len(pts),
        "n_epochs": len(epochs),
        "units": dict(UNITS),
        "points": point_columns(pts),
        "epochs": epochs,
    }


# --- channel binning ------------------------------------------------------------------------------


def channel_edges_um(detector: int, n_per_detector: int = config.CHANNELS_PER_DETECTOR) -> np.ndarray:
    """Bin edges (n + 1) uniform in log wavelength across the detector's nominal band."""
    if detector not in config.DETECTOR_BANDS_UM:
        raise ValueError(f"unknown detector {detector}")
    if n_per_detector < 1:
        raise ValueError("n_per_detector must be >= 1")
    lo, hi = config.DETECTOR_BANDS_UM[detector]
    return np.geomspace(lo, hi, n_per_detector + 1)


def channel_index(
    detector: int, wavelength_um: float, n_per_detector: int = config.CHANNELS_PER_DETECTOR
) -> int | None:
    """Channel bin of a wavelength on a detector, or None when it is far outside the band.

    Wavelengths up to one bin width outside the nominal band (the band limits are approximate) are
    assigned to the first / last bin.
    """
    if detector not in config.DETECTOR_BANDS_UM or not (wavelength_um and math.isfinite(wavelength_um)):
        return None
    if wavelength_um <= 0:
        return None
    lo, hi = config.DETECTOR_BANDS_UM[detector]
    pos = n_per_detector * math.log(wavelength_um / lo) / math.log(hi / lo)
    idx = math.floor(pos)
    if -1 <= idx < 0:
        return 0
    if n_per_detector <= idx <= n_per_detector:
        return n_per_detector - 1
    return idx if 0 <= idx < n_per_detector else None


def _bin_stats(group: Sequence[PhotPoint]) -> dict[str, Any]:
    flux, err, n, chi2_red = weighted_mean([p.flux_ujy for p in group], [p.flux_err_ujy for p in group])
    if n:
        ok = [p for p in group if math.isfinite(p.flux_ujy) and math.isfinite(p.flux_err_ujy) and p.flux_err_ujy > 0]
        w = np.array([1.0 / p.flux_err_ujy**2 for p in ok])
        wl = float(np.sum(w * np.array([p.wavelength_um for p in ok])) / np.sum(w))
        mjd = float(np.mean([p.mjd for p in ok]))
    else:
        wl = mjd = math.nan
    return {"flux": flux, "err": err, "n": n, "chi2_red": chi2_red, "wavelength": wl, "mjd": mjd}


def bin_channels(
    points: Sequence[PhotPoint], n_per_detector: int = config.CHANNELS_PER_DETECTOR
) -> dict[str, Any]:
    """Inverse-variance weighted spectrum in ``n_per_detector`` log-uniform bins per detector.

    Saturated points are excluded from ``flux_ujy`` / ``flux_err_ujy`` but binned separately into
    ``flux_ujy_saturated`` / ``flux_err_ujy_saturated`` (and counted in ``n_saturated``). Points with no
    usable flux error or a wavelength far outside their detector band are counted, not binned.

    Returns {"n_per_detector", "units", "detectors": [per detector: detector, edges_um, center_um,
    wavelength_um (weighted mean of the binned points, else the bin centre), flux_ujy, flux_err_ujy, n,
    chi2_red, mjd_mean, n_saturated, flux_ujy_saturated, flux_err_ujy_saturated], "n_outside",
    "n_invalid", and flat arrays over all 6 x n bins sorted by wavelength: detector, channel,
    bin_lo_um, bin_hi_um, center_um, wavelength_um, flux_ujy, flux_err_ujy, n, n_saturated}.
    """
    groups: dict[tuple[int, int], list[PhotPoint]] = {}
    n_outside = n_invalid = 0
    for p in points:
        if not (math.isfinite(p.flux_ujy) and math.isfinite(p.flux_err_ujy) and p.flux_err_ujy > 0):
            n_invalid += 1
            continue
        idx = channel_index(int(p.detector), p.wavelength_um, n_per_detector)
        if idx is None:
            n_outside += 1
            continue
        groups.setdefault((int(p.detector), idx), []).append(p)

    detectors = []
    flat: dict[str, list[Any]] = {k: [] for k in (
        "detector", "channel", "bin_lo_um", "bin_hi_um", "center_um", "wavelength_um", "flux_ujy",
        "flux_err_ujy", "n", "n_saturated",
    )}
    for det in sorted(config.DETECTOR_BANDS_UM):
        edges = channel_edges_um(det, n_per_detector)
        centers = np.sqrt(edges[:-1] * edges[1:])
        cols: dict[str, list[Any]] = {k: [] for k in (
            "wavelength_um", "flux_ujy", "flux_err_ujy", "n", "chi2_red", "mjd_mean", "n_saturated",
            "flux_ujy_saturated", "flux_err_ujy_saturated",
        )}
        for ch in range(n_per_detector):
            members = groups.get((det, ch), [])
            clean = _bin_stats([p for p in members if not p.saturated])
            satd = _bin_stats([p for p in members if p.saturated])
            wl = clean["wavelength"] if clean["n"] else centers[ch]
            cols["wavelength_um"].append(finite_or_none(wl))
            cols["flux_ujy"].append(finite_or_none(clean["flux"]))
            cols["flux_err_ujy"].append(finite_or_none(clean["err"]))
            cols["n"].append(int(clean["n"]))
            cols["chi2_red"].append(finite_or_none(clean["chi2_red"]))
            cols["mjd_mean"].append(finite_or_none(clean["mjd"]))
            cols["n_saturated"].append(int(satd["n"]))
            cols["flux_ujy_saturated"].append(finite_or_none(satd["flux"]))
            cols["flux_err_ujy_saturated"].append(finite_or_none(satd["err"]))
            for key, val in (
                ("detector", det), ("channel", ch), ("bin_lo_um", float(edges[ch])),
                ("bin_hi_um", float(edges[ch + 1])), ("center_um", float(centers[ch])),
                ("wavelength_um", finite_or_none(wl)), ("flux_ujy", finite_or_none(clean["flux"])),
                ("flux_err_ujy", finite_or_none(clean["err"])), ("n", int(clean["n"])),
                ("n_saturated", int(satd["n"])),
            ):
                flat[key].append(val)
        detectors.append({
            "detector": det,
            "edges_um": [float(e) for e in edges],
            "center_um": [float(c) for c in centers],
            **cols,
        })

    order = np.argsort(np.asarray(flat["center_um"]), kind="stable")
    flat_sorted = {k: [v[i] for i in order] for k, v in flat.items()}
    return {
        "n_per_detector": int(n_per_detector),
        "units": dict(UNITS),
        "detectors": detectors,
        "n_outside": n_outside,
        "n_invalid": n_invalid,
        **flat_sorted,
    }
