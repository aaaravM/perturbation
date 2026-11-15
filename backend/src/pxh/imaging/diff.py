"""Difference images between two frames on the same grid, optionally normalised to signal-to-noise.

difference(a, b) returns a - b. Where the sky has not changed it is noise. A star that moved between the
epochs leaves a dipole: positive at its position in `a`, negative at its position in `b`, oriented along the
motion. With normalize=True the result is the S/N map (a - b) / sqrt(1/wa + 1/wb), whose weight is 1 where
valid (its data has unit variance under the noise model).

Steps:
1. Optional Gaussian PSF matching. The sharper frame is convolved with a pixel-integrated Gaussian of
   `psf_match_sigma_px`, using normalised convolution so masked holes do not spread, and the variance is
   propagated with the squared kernel. In 'auto' mode the sharper frame is the one with the smaller
   meta['psf_fwhm_arcsec']. If that is unknown, it is the choice that leaves less residual power above the
   expected noise.
2. Background offset removal. The sigma-clipped median of a - b is subtracted, so a zodi or calibration
   offset between the epochs does not show as a uniform residual.
3. Optional normalisation to S/N.
"""

from __future__ import annotations

import logging
import math
from typing import Any, Literal

import numpy as np
from scipy import ndimage
from scipy.special import erf

from pxh.imaging.align import same_grid
from pxh.models import Frame

log = logging.getLogger(__name__)

# Fraction of a convolution kernel that must fall on valid pixels for a convolved pixel to stay valid.
CONV_VALID_THRESHOLD = 0.99
KERNEL_HALF_WIDTH_SIGMAS = 4.0
BACKGROUND_CLIP_SIGMA = 3.0
BACKGROUND_CLIP_ITERS = 5
MAD_TO_SIGMA = 1.4826
MIN_BACKGROUND_PIXELS = 10

PsfTarget = Literal["auto", "a", "b"]


def difference(
    a: Frame,
    b: Frame,
    normalize: bool = True,
    psf_match_sigma_px: float | None = None,
    *,
    psf_match_target: PsfTarget = "auto",
    subtract_background: bool = True,
    label: str | None = None,
) -> Frame:
    """Return the Frame a - b (MJy/sr), or its S/N map when normalize is True.

    Raises ValueError if the frames are not on the same grid. meta records the kind ('difference'), units,
    background_offset (MJy/sr, subtracted), psf_matched ('a', 'b' or None), psf_match_sigma_px,
    snr_robust_std (1.4826 MAD of the S/N map: about 1 when the noise model holds), n_valid, the two labels,
    and mjd_a, mjd_b, dt_days. mjd_mid is that of `a`.
    """
    _check_compatible(a, b)
    da, wa = _clean(a)
    db, wb = _clean(b)
    matched: str | None = None
    if psf_match_sigma_px is not None and psf_match_sigma_px > 0:
        matched = _pick_sharper(a, b, da, wa, db, wb, float(psf_match_sigma_px), psf_match_target)
        if matched == "a":
            da, wa = convolve_gaussian(da, wa, float(psf_match_sigma_px))
        else:
            db, wb = convolve_gaussian(db, wb, float(psf_match_sigma_px))
    elif psf_match_sigma_px is not None and psf_match_sigma_px < 0:
        raise ValueError(f"psf_match_sigma_px must be >= 0, got {psf_match_sigma_px}")

    valid = (wa > 0) & (wb > 0)
    with np.errstate(invalid="ignore", divide="ignore"):
        diff = np.where(valid, da - db, np.nan)
        var = np.where(valid, 1.0 / wa + 1.0 / wb, np.nan)
    offset = robust_offset(diff[valid]) if subtract_background else 0.0
    diff = diff - offset
    if normalize:
        with np.errstate(invalid="ignore", divide="ignore"):
            data = np.where(valid, diff / np.sqrt(var), np.nan)
        weight = valid.astype(np.float32)
        units = "snr"
    else:
        data = diff
        with np.errstate(invalid="ignore", divide="ignore"):
            weight = np.where(valid, 1.0 / var, 0.0)
        units = "MJy/sr"

    meta = _meta(a, b, units, offset, matched, psf_match_sigma_px, valid, diff, var)
    return Frame(
        data=np.asarray(data, dtype=np.float32),
        weight=np.asarray(weight, dtype=np.float32),
        wcs=a.wcs,
        mjd_mid=float(a.mjd_mid),
        n_inputs=int(a.n_inputs) + int(b.n_inputs),
        label=label if label is not None else default_label(a, b),
        detector=a.detector if a.detector == b.detector else None,
        epoch_index=None,
        wavelength_um=_mean_or_one(a.wavelength_um, b.wavelength_um),
        meta=meta,
    )


def default_label(a: Frame, b: Frame) -> str:
    """'D6 E3 - E1' style label: detector prefix, then epoch tags (falling back to the frame labels)."""
    if a.detector is not None and a.detector == b.detector:
        prefix = f"D{a.detector} "
    elif a.detector is not None and b.detector is not None:
        prefix = f"D{a.detector}/D{b.detector} "
    else:
        prefix = ""
    if a.epoch_index is not None and b.epoch_index is not None:
        return f"{prefix}E{a.epoch_index} - E{b.epoch_index}"
    return f"{a.label} - {b.label}"


def gaussian_matching_sigma(sigma_a_px: float, sigma_b_px: float) -> float:
    """Sigma of the Gaussian that blurs the sharper of two Gaussian PSFs into the broader one."""
    return float(math.sqrt(abs(sigma_a_px**2 - sigma_b_px**2)))


def convolve_gaussian(data: np.ndarray, weight: np.ndarray, sigma_px: float) -> tuple[np.ndarray, np.ndarray]:
    """Normalised convolution with a pixel-integrated Gaussian; returns (data, weight) as float64.

    Invalid pixels (weight 0 or data NaN) are excluded and renormalised over, and an output pixel stays
    valid only where >= CONV_VALID_THRESHOLD of the kernel falls on valid pixels. The variance is propagated
    with the squared kernel (var_out = sum k^2 var / (sum k)^2). The image borders are mirrored.
    """
    if not (math.isfinite(sigma_px) and sigma_px > 0):
        raise ValueError(f"sigma_px must be positive, got {sigma_px}")
    valid = (weight > 0) & np.isfinite(data)
    k = _gaussian_kernel_1d(sigma_px)
    m = valid.astype(np.float64)
    with np.errstate(divide="ignore", invalid="ignore"):
        var = np.where(valid, 1.0 / weight, 0.0)
    num = _separable(np.where(valid, data, 0.0), k)
    den = _separable(m, k)
    var_num = _separable(var, k * k)
    ok = den >= CONV_VALID_THRESHOLD
    with np.errstate(divide="ignore", invalid="ignore"):
        out = np.where(ok, num / den, np.nan)
        var_out = np.where(ok, var_num / (den * den), np.nan)
        w_out = np.where(ok & (var_out > 0), 1.0 / var_out, 0.0)
    return out, w_out


def robust_offset(values: np.ndarray) -> float:
    """Sigma-clipped median (3 sigma, MAD scale) of finite values; 0.0 if there are too few."""
    v = np.asarray(values, dtype=np.float64)
    v = v[np.isfinite(v)]
    if v.size < MIN_BACKGROUND_PIXELS:
        return 0.0
    for _ in range(BACKGROUND_CLIP_ITERS):
        med = float(np.median(v))
        scale = MAD_TO_SIGMA * float(np.median(np.abs(v - med)))
        if scale <= 0:
            return med
        keep = np.abs(v - med) <= BACKGROUND_CLIP_SIGMA * scale
        if keep.all() or keep.sum() < MIN_BACKGROUND_PIXELS:
            break
        v = v[keep]
    return float(np.median(v))


# --- helpers -------------------------------------------------------------------------------------------


def _check_compatible(a: Frame, b: Frame) -> None:
    if np.shape(a.data) != np.shape(b.data) or np.shape(a.weight) != np.shape(a.data):
        raise ValueError(f"frame shapes differ: {np.shape(a.data)} vs {np.shape(b.data)}")
    if np.shape(b.weight) != np.shape(b.data):
        raise ValueError("frame b weight shape does not match its data")
    if not same_grid(a.wcs, b.wcs, np.shape(a.data), np.shape(b.data)):
        raise ValueError(f"frames {a.label!r} and {b.label!r} are not on the same grid")


def _clean(frame: Frame) -> tuple[np.ndarray, np.ndarray]:
    d = np.asarray(frame.data, dtype=np.float64)
    w = np.asarray(frame.weight, dtype=np.float64)
    ok = (w > 0) & np.isfinite(w) & np.isfinite(d)
    return np.where(ok, d, np.nan), np.where(ok, w, 0.0)


def _pick_sharper(
    a: Frame, b: Frame, da: np.ndarray, wa: np.ndarray, db: np.ndarray, wb: np.ndarray, sigma: float,
    target: PsfTarget,
) -> str:
    """Which frame to convolve: 'a' or 'b'."""
    if target in ("a", "b"):
        return target
    if target != "auto":
        raise ValueError(f"psf_match_target must be 'auto', 'a' or 'b', got {target!r}")
    fa, fb = a.meta.get("psf_fwhm_arcsec"), b.meta.get("psf_fwhm_arcsec")
    if isinstance(fa, (int, float)) and isinstance(fb, (int, float)) and fa != fb:
        return "a" if fa < fb else "b"
    ca, cwa = convolve_gaussian(da, wa, sigma)
    cb, cwb = convolve_gaussian(db, wb, sigma)
    excess_a = _excess_residual(ca, cwa, db, wb)
    excess_b = _excess_residual(da, wa, cb, cwb)
    log.debug("PSF match: excess residual convolving a=%.4g, b=%.4g", excess_a, excess_b)
    return "a" if excess_a <= excess_b else "b"


def _excess_residual(d1: np.ndarray, w1: np.ndarray, d2: np.ndarray, w2: np.ndarray) -> float:
    """Sum of squared differences minus its expectation from noise alone, per valid pixel."""
    ok = (w1 > 0) & (w2 > 0)
    if not ok.any():
        return 0.0
    r = d1[ok] - d2[ok]
    r = r - np.median(r)
    expected = 1.0 / w1[ok] + 1.0 / w2[ok]
    return float(np.mean(r * r - expected))


def _gaussian_kernel_1d(sigma: float) -> np.ndarray:
    half = max(1, math.ceil(KERNEL_HALF_WIDTH_SIGMAS * sigma))
    edges = (np.arange(-half, half + 2) - 0.5) / (sigma * math.sqrt(2.0))
    k = 0.5 * np.diff(erf(edges))
    return k / k.sum()


def _separable(image: np.ndarray, k: np.ndarray) -> np.ndarray:
    out = ndimage.convolve1d(image, k, axis=0, mode="reflect")
    return ndimage.convolve1d(out, k, axis=1, mode="reflect")


def _mean_or_one(x: float | None, y: float | None) -> float | None:
    if x is not None and y is not None:
        return 0.5 * (x + y)
    return x if x is not None else y


def _meta(
    a: Frame, b: Frame, units: str, offset: float, matched: str | None, sigma: float | None,
    valid: np.ndarray, diff: np.ndarray, var: np.ndarray,
) -> dict[str, Any]:
    snr = diff[valid] / np.sqrt(var[valid]) if valid.any() else np.array([])
    snr = snr[np.isfinite(snr)]
    robust_std = float(MAD_TO_SIGMA * np.median(np.abs(snr - np.median(snr)))) if snr.size else float("nan")
    return {
        "kind": "difference",
        "units": units,
        "background_offset": float(offset),
        "psf_matched": matched,
        "psf_match_sigma_px": float(sigma) if matched else None,
        "snr_robust_std": robust_std,
        "n_valid": int(valid.sum()),
        "label_a": a.label,
        "label_b": b.label,
        "epoch_a": a.epoch_index,
        "epoch_b": b.epoch_index,
        "mjd_a": float(a.mjd_mid),
        "mjd_b": float(b.mjd_mid),
        "dt_days": float(a.mjd_mid - b.mjd_mid),
    }
