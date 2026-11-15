"""Tests for pxh.photometry.centroid on synthetic undersampled stars (no network).

The synthetic PSF mimics the SPHEREx ePSF: a double Gaussian (85% sigma 0.53 px + 15% sigma 1.1 px,
optical FWHM 1.30 px) integrated over pixels; 94.5% of the flux falls in the 3x3 core, as in the real
EPSF tables (94-96%). The ePSF table is 33x33, 5x oversampled, and sums to 1.
"""

from __future__ import annotations

import math

import numpy as np
import pytest
from scipy.special import erf

from pxh.photometry.centroid import (
    EPSFFitResult,
    centroid_2dg_masked,
    centroid_quadratic_masked,
    fit_epsf,
    fit_epsf_position,
    render_psf,
    windowed_centroid,
)

COMPONENTS = ((0.85, 0.53), (0.15, 1.1))
OVERSAMPLING = 5
SHAPE = (21, 21)


def _pix_gauss(off: np.ndarray, sigma: float) -> np.ndarray:
    s2 = sigma * math.sqrt(2.0)
    return 0.5 * (erf((off + 0.5) / s2) - erf((off - 0.5) / s2))


def true_psf(dx: np.ndarray, dy: np.ndarray) -> np.ndarray:
    """Fraction of a unit-flux star's light in a pixel whose centre is offset (dx, dy) from the star."""
    return sum(w * _pix_gauss(dx, s) * _pix_gauss(dy, s) for w, s in COMPONENTS)


def synthetic_epsf(size: int = 33, oversampling: int = OVERSAMPLING) -> np.ndarray:
    off = (np.arange(size) - (size - 1) / 2) / oversampling
    dx, dy = np.meshgrid(off, off)
    tab = true_psf(dx, dy)
    return tab / tab.sum()


EPSF = synthetic_epsf()


def star_image(flux: float, xc: float, yc: float, bkg: float = 0.0, shape: tuple[int, int] = SHAPE) -> np.ndarray:
    yy, xx = np.mgrid[0 : shape[0], 0 : shape[1]]
    return flux * true_psf(xx - xc, yy - yc) + bkg


def sigma_for_snr(
    flux: float,
    snr: float,
    xc: float = 10.0,
    yc: float = 10.0,
    mask: np.ndarray | None = None,
    with_background: bool = True,
    box: int = 7,
) -> float:
    """Per-pixel noise giving a flux S/N of ``snr`` for a fit on the unmasked pixels of the box.

    Uses the Fisher matrix of (flux[, constant background]) at the true position, so "S/N 100" means
    the fit's flux error is 1% for the estimator being tested.
    """
    g = star_image(1.0, xc, yc)
    sel = np.zeros(SHAPE, bool)
    h = box // 2
    sel[10 - h : 10 + h + 1, 10 - h : 10 + h + 1] = True
    if mask is not None:
        sel &= mask
    cols = [g[sel]] + ([np.ones(int(sel.sum()))] if with_background else [])
    a = np.column_stack(cols)
    var_flux_unit = float(np.linalg.inv(a.T @ a)[0, 0])  # flux variance for unit pixel noise
    return flux / snr / math.sqrt(var_flux_unit)


def core_mask(xc: float, yc: float, shape: tuple[int, int] = SHAPE) -> np.ndarray:
    m = np.ones(shape, bool)
    ix, iy = math.floor(xc + 0.5), math.floor(yc + 0.5)
    m[iy - 1 : iy + 2, ix - 1 : ix + 2] = False
    return m


def test_synthetic_epsf_is_realistic() -> None:
    assert EPSF.shape == (33, 33)
    assert EPSF.sum() == pytest.approx(1.0, abs=1e-12)
    assert np.unravel_index(np.argmax(EPSF), EPSF.shape) == (16, 16)
    native = render_psf(EPSF, (11, 11), 5.0, 5.0)
    assert native.sum() == pytest.approx(1.0, abs=0.005)
    assert native[4:7, 4:7].sum() == pytest.approx(0.945, abs=0.01)  # like the real SPHEREx ePSF
    assert 0.35 < native.max() < 0.50  # undersampled: ~40% of the flux in the peak pixel


def test_render_psf_is_flux_normalised_at_any_phase() -> None:
    for x, y in [(5.0, 5.0), (5.3, 4.8), (5.5, 5.5), (4.62, 5.17)]:
        assert render_psf(EPSF, (11, 11), x, y, flux=3.0).sum() == pytest.approx(3.0, rel=0.006)


def test_epsf_fit_recovers_position_and_flux_at_snr100() -> None:
    """At S/N 100 every fit is within 0.05 px; the flux is unbiased and within 2% for >= 90% of fits.

    (A flux error of 1% makes 2% a 2-sigma bound, so it is tested over many noise realisations.)
    """
    rng = np.random.default_rng(42)
    flux = 1000.0
    sig = sigma_for_snr(flux, 100.0)
    dflux = []
    for _ in range(120):
        xc, yc = 10 + rng.uniform(-0.5, 0.5), 10 + rng.uniform(-0.5, 0.5)
        img = star_image(flux, xc, yc, bkg=5.0) + rng.normal(0.0, sig, SHAPE)
        var = np.full(SHAPE, sig**2)
        x, y, f, x_err, y_err, chi2, ok = fit_epsf_position(img, var, None, EPSF, 10.0, 10.0)
        assert ok
        assert abs(x - xc) < 0.05 and abs(y - yc) < 0.05
        assert 0.003 < x_err < 0.03 and 0.003 < y_err < 0.03
        assert 0.3 < chi2 < 2.0
        dflux.append(f / flux - 1.0)
    dflux = np.array(dflux)
    assert abs(dflux.mean()) < 0.003
    assert np.mean(np.abs(dflux) < 0.02) >= 0.90
    assert np.all(np.abs(dflux) < 0.04)


def test_epsf_fit_errors_are_calibrated() -> None:
    """Pulls (error / reported sigma) over many noise realisations have unit scatter and no bias."""
    rng = np.random.default_rng(7)
    flux = 1000.0
    sig = sigma_for_snr(flux, 50.0)
    pulls = []
    for _ in range(150):
        xc, yc = 10 + rng.uniform(-0.5, 0.5), 10 + rng.uniform(-0.5, 0.5)
        img = star_image(flux, xc, yc, bkg=2.0) + rng.normal(0.0, sig, SHAPE)
        fit = fit_epsf(img, np.full(SHAPE, sig**2), None, EPSF, 10.0, 10.0)
        assert fit.ok
        pulls.append(((fit.x - xc) / fit.x_err, (fit.y - yc) / fit.y_err, (fit.flux - flux) / fit.flux_err))
    p = np.array(pulls)
    assert np.all(np.abs(p.mean(axis=0)) < 0.3)
    assert np.all((p.std(axis=0) > 0.75) & (p.std(axis=0) < 1.25))


@pytest.mark.parametrize(
    ("fit_background", "box"),
    [(False, 7), (True, 11)],
    ids=["background-known", "background-free-box11"],
)
def test_wing_fit_with_masked_core(fit_background: bool, box: int) -> None:
    """Saturated star: the 3x3 core is masked; noise set so the unmasked wings give S/N 100.

    With 94.5% of the light in the core this star is ~25x brighter (in S/N) than the unmasked case, as
    saturated stars are. The wing flux is nearly degenerate with a free background inside a 7x7 box, so
    the background is either known (subtracted from an annulus, as forced.py does) or fitted in a
    larger box that reaches beyond the 3.3 px ePSF support.
    """
    rng = np.random.default_rng(3)
    flux, bkg = 1.0e5, 5.0
    for _ in range(8):
        xc, yc = 10 + rng.uniform(-0.5, 0.5), 10 + rng.uniform(-0.5, 0.5)
        mask = core_mask(xc, yc)
        sig = sigma_for_snr(flux, 100.0, xc, yc, mask, with_background=fit_background, box=box)
        img = star_image(flux, xc, yc, bkg=bkg) + rng.normal(0.0, sig, SHAPE)
        img[~mask] = 0.6 * img[~mask]  # garbage in the saturated core must not matter
        data = img if fit_background else img - bkg
        fit = fit_epsf(
            data, np.full(SHAPE, sig**2), mask, EPSF, 10.0, 10.0, box=box, fit_background=fit_background
        )
        assert fit.ok, fit.message
        assert abs(fit.x - xc) < 0.15 and abs(fit.y - yc) < 0.15
        assert abs(fit.flux / flux - 1.0) < 0.05
        assert fit.n_pix == box * box - 9


def test_wing_fit_without_mask_would_be_biased() -> None:
    """Sanity check of the test above: fitting the clipped core gives a badly wrong flux."""
    flux, xc, yc = 1.0e5, 10.2, 9.9
    img = star_image(flux, xc, yc, bkg=5.0)
    mask = core_mask(xc, yc)
    img[~mask] = 0.6 * img[~mask]
    fit = fit_epsf(img, np.ones(SHAPE), None, EPSF, 10.0, 10.0)
    assert abs(fit.flux / flux - 1.0) > 0.2


def test_fixed_position_fit_is_linear_and_allows_negative_flux() -> None:
    rng = np.random.default_rng(11)
    flux, xc, yc = 500.0, 10.31, 9.77
    sig = sigma_for_snr(flux, 100.0)
    img = star_image(flux, xc, yc, bkg=1.0) + rng.normal(0.0, sig, SHAPE)
    fit = fit_epsf(img, np.full(SHAPE, sig**2), None, EPSF, xc, yc, fit_position=False)
    assert fit.ok and not fit.fit_position
    assert (fit.x, fit.y) == (xc, yc)
    assert math.isnan(fit.x_err)
    assert fit.flux == pytest.approx(flux, rel=0.03)
    assert fit.flux_err == pytest.approx(flux / 100.0, rel=0.25)
    noise_only = rng.normal(0.0, 1.0, SHAPE)
    fit0 = fit_epsf(noise_only, np.ones(SHAPE), None, EPSF, 10.0, 10.0, fit_position=False)
    assert fit0.ok  # forced photometry of nothing is still a valid measurement
    assert abs(fit0.flux) < 5 * fit0.flux_err


def test_fit_without_variance_uses_residual_scatter() -> None:
    rng = np.random.default_rng(5)
    flux, sig = 1000.0, sigma_for_snr(1000.0, 100.0)
    img = star_image(flux, 10.2, 9.7) + rng.normal(0.0, sig, SHAPE)
    with_var = fit_epsf(img, np.full(SHAPE, sig**2), None, EPSF, 10.0, 10.0)
    no_var = fit_epsf(img, None, None, EPSF, 10.0, 10.0)
    assert no_var.ok
    assert no_var.x == pytest.approx(with_var.x, abs=1e-6)
    assert no_var.flux_err == pytest.approx(with_var.flux_err, rel=0.35)


def test_bad_starting_guess_is_recovered() -> None:
    flux, xc, yc = 1000.0, 10.9, 9.2
    img = star_image(flux, xc, yc, bkg=1.0)
    fit = fit_epsf(img, np.ones(SHAPE) * 1e-4, None, EPSF, 10.1, 10.0)
    assert fit.ok
    assert fit.x == pytest.approx(xc, abs=0.01) and fit.y == pytest.approx(yc, abs=0.01)


def test_fit_reports_failure_cleanly() -> None:
    img = star_image(1000.0, 10.0, 10.0)
    mask = np.zeros(SHAPE, bool)
    mask[10, 10:13] = True
    res = fit_epsf_position(img, np.ones(SHAPE), mask, EPSF, 10.0, 10.0)
    assert isinstance(res, EPSFFitResult)
    assert not res.ok and math.isnan(res.flux)
    off_image = fit_epsf(img, np.ones(SHAPE), None, EPSF, 60.0, 60.0)
    assert not off_image.ok
    with pytest.raises(ValueError):
        fit_epsf(img, np.ones((3, 3)), None, EPSF, 10.0, 10.0)


def test_nan_pixels_are_ignored() -> None:
    flux, xc, yc = 1000.0, 10.25, 10.4
    img = star_image(flux, xc, yc)
    img[10, 10] = np.nan
    fit = fit_epsf(img, np.full(SHAPE, 0.01), None, EPSF, 10.0, 10.0)
    assert fit.ok and fit.n_pix == 48
    assert fit.x == pytest.approx(xc, abs=0.005) and fit.flux == pytest.approx(flux, rel=0.005)


@pytest.mark.parametrize("func", [centroid_quadratic_masked, centroid_2dg_masked])
def test_simple_centroids_with_masks(func) -> None:
    xc, yc = 10.2, 9.85
    img = star_image(1000.0, xc, yc)
    x, y = func(img, None, 10.0, 10.0)
    assert abs(x - xc) < 0.15 and abs(y - yc) < 0.15
    mask = np.ones(SHAPE, bool)
    mask[13, 7] = False  # a masked pixel in the wings changes little
    img2 = img.copy()
    img2[13, 7] = 1e6
    x2, y2 = func(img2, mask, 10.0, 10.0)
    assert abs(x2 - xc) < 0.15 and abs(y2 - yc) < 0.15
    nothing = np.zeros(SHAPE, bool)
    assert all(math.isnan(v) for v in func(img, nothing, 10.0, 10.0))


def test_windowed_centroid() -> None:
    xc, yc = 9.7, 10.3
    img = star_image(1000.0, xc, yc)
    x, y = windowed_centroid(img, None, 10.0, 10.0)
    assert abs(x - xc) < 0.1 and abs(y - yc) < 0.1
    assert all(math.isnan(v) for v in windowed_centroid(-img, None, 10.0, 10.0))
