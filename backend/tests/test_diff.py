"""Tests for pxh.imaging.diff: S/N calibration, motion dipoles (incl. the 180-degree survey flip), PSF matching.
"""

from __future__ import annotations

import math

import numpy as np
import pytest
from test_align import PSF_SIGMA_PX, full_frame_wcs, gaussian_image, make_stamp, offset_sky, stamp_centred_on

from pxh.imaging.align import make_grid
from pxh.imaging.coadd import coadd_stamps
from pxh.imaging.diff import convolve_gaussian, default_label, difference, gaussian_matching_sigma
from pxh.models import Frame

RA, DEC = 210.0, -12.0


def grid_frame(
    grid,
    stars=(),
    *,
    sky: float = 0.0,
    var: np.ndarray | float = 1.0,
    rng: np.random.Generator | None = None,
    psf_sigma: float = 1.0,
    label: str = "F",
    epoch_index: int | None = None,
    detector: int | None = 6,
    mjd: float = 60900.0,
    meta: dict | None = None,
) -> Frame:
    """A frame drawn directly on the grid: stars = ((ra, dec, flux), ...), Gaussian noise of variance `var`."""
    wcs, shape = grid
    data = np.full(shape, sky, dtype=np.float64)
    for ra, dec, flux in stars:
        x, y = (float(v) for v in wcs.world_to_pixel_values(ra, dec))
        data += flux * gaussian_image(shape, x, y, psf_sigma)
    var_map = np.broadcast_to(np.asarray(var, dtype=np.float64), shape)
    if rng is not None:
        data += rng.normal(0.0, 1.0, shape) * np.sqrt(var_map)
    return Frame(data=data.astype(np.float32), weight=(1.0 / var_map).astype(np.float32), wcs=wcs, mjd_mid=mjd,
                 n_inputs=1, label=label, detector=detector, epoch_index=epoch_index, meta=dict(meta or {}))


def lobe_offset_east_north(snr: Frame, near: tuple[float, float], threshold: float = 3.0) -> tuple[float, float]:
    """Sky offset (east, north) in arcsec from the negative-lobe centroid to the positive-lobe centroid."""
    wcs = snr.wcs
    x0, y0 = (float(v) for v in wcs.world_to_pixel_values(*near))
    yy, xx = np.mgrid[: snr.data.shape[0], : snr.data.shape[1]]
    close = np.hypot(xx - x0, yy - y0) < 6
    d = np.nan_to_num(snr.data)
    cents = []
    for sign in (1.0, -1.0):
        m = close & (sign * d > threshold)
        assert m.sum() >= 2, "lobe not detected"
        w = sign * d[m]
        cents.append(wcs.pixel_to_world_values((w * xx[m]).sum() / w.sum(), (w * yy[m]).sum() / w.sum()))
    (ra_p, dec_p), (ra_n, dec_n) = cents
    east = (float(ra_p) - float(ra_n)) * math.cos(math.radians(DEC)) * 3600.0
    north = (float(dec_p) - float(dec_n)) * 3600.0
    return east, north


def position_angle(east: float, north: float) -> float:
    return math.degrees(math.atan2(east, north)) % 360.0


def angle_diff(a: float, b: float) -> float:
    return abs((a - b + 180.0) % 360.0 - 180.0)


# --- noise calibration ---------------------------------------------------------------------------------


def test_identical_noisy_frames_give_unit_snr_and_zero_mean() -> None:
    grid = make_grid(RA, DEC, 30.0)
    rng = np.random.default_rng(42)
    ny, nx = grid[1]
    var = np.linspace(0.5, 2.0, nx)[None, :] * np.ones((ny, 1))  # noise varies across the field
    stars = [(*offset_sky(RA, DEC, e, n), f) for e, n, f in [(60, 40, 500), (-300, 120, 2000), (200, -500, 80)]]
    a = grid_frame(grid, stars, sky=4.0, var=var, rng=rng, label="E2")
    b = grid_frame(grid, stars, sky=4.37, var=var, rng=rng, label="E1")  # same sky, +0.37 MJy/sr offset

    d = difference(a, b)
    ok = d.weight > 0
    assert ok.all()
    assert abs(float(np.mean(d.data[ok]))) < 0.02
    assert float(np.std(d.data[ok])) == pytest.approx(1.0, abs=0.03)
    assert d.meta["snr_robust_std"] == pytest.approx(1.0, abs=0.03)
    assert d.meta["background_offset"] == pytest.approx(-0.37, abs=0.02)
    assert d.meta["units"] == "snr" and d.meta["kind"] == "difference"
    assert np.all(d.weight[ok] == 1.0) and d.data.dtype == np.float32


def test_snr_is_calibrated_end_to_end_through_reprojection_and_coadd() -> None:
    """Noise-only stamps at random orientations -> per-epoch co-adds -> difference: S/N std ~1 per pixel."""
    rng = np.random.default_rng(5)
    grid = make_grid(RA, DEC, 6.0)
    epochs = []
    for e in range(2):
        stamps = []
        for k in range(8):
            full = full_frame_wcs(float(rng.uniform(0, 360)), crval=(RA, DEC))
            x0, y0 = stamp_centred_on(full, RA, DEC, shape=(87, 87))
            x0, y0 = x0 + int(rng.integers(-2, 3)), y0 + int(rng.integers(-2, 3))
            stamps.append(make_stamp(full, x0, y0, shape=(87, 87), sky=2.0, noise_sigma=0.7, rng=rng,
                                     obs_id=f"E{e}_{k}", mjd=60900.0 + 180 * e + k))
        epochs.append(coadd_stamps(stamps, grid, mask_bits=0, label=f"E{e}", epoch_index=e))
    d = difference(epochs[1], epochs[0])
    ok = d.weight > 0
    assert ok.mean() > 0.95
    assert float(np.std(d.data[ok])) == pytest.approx(1.0, abs=0.07)
    assert abs(float(np.mean(d.data[ok]))) < 0.05


# --- motion dipole ---------------------------------------------------------------------------------------


def test_moving_star_gives_dipole_along_motion() -> None:
    grid = make_grid(RA, DEC, 6.0)
    rng = np.random.default_rng(3)
    old = offset_sky(RA, DEC, 10.0, -5.0)
    new = offset_sky(old[0], old[1], 4.0, 8.0)  # moved 4" east, 8" north (PA 26.6 deg)
    a = grid_frame(grid, [(*new, 400.0)], var=0.25, rng=rng, psf_sigma=PSF_SIGMA_PX, epoch_index=3, mjd=61100.0)
    b = grid_frame(grid, [(*old, 400.0)], var=0.25, rng=rng, psf_sigma=PSF_SIGMA_PX, epoch_index=1, mjd=60900.0)
    d = difference(a, b)
    east, north = lobe_offset_east_north(d, old)
    assert angle_diff(position_angle(east, north), position_angle(4.0, 8.0)) < 10.0
    # the positive peak sits on the new position, the negative one on the old position
    yx_max = np.unravel_index(np.nanargmax(d.data), d.data.shape)
    yx_min = np.unravel_index(np.nanargmin(d.data), d.data.shape)
    for (py, px), pos in ((yx_max, new), (yx_min, old)):
        ex, ey = (float(v) for v in grid[0].world_to_pixel_values(*pos))
        assert math.hypot(px - ex, py - ey) < 1.0
    assert d.data[yx_max] > 20 and d.data[yx_min] < -20
    assert d.label == "D6 E3 - E1"
    assert d.meta["dt_days"] == pytest.approx(200.0) and d.mjd_mid == 61100.0


def test_dipole_orientation_survives_the_180_degree_survey_flip() -> None:
    """Epoch 1 seen at PA ~5 deg, epoch 2 at ~185 deg (SPS_EPA flip): the dipole still points along the motion."""
    rng = np.random.default_rng(8)
    grid = make_grid(RA, DEC, 4.0)
    old = offset_sky(RA, DEC, -8.0, 6.0)
    new = offset_sky(old[0], old[1], -7.0, -5.0)  # moved 7" west and 5" south (PA 234.5 deg)
    frames = []
    for e, theta in enumerate((5.0, 185.0)):
        stamps = []
        for k in range(6):
            full = full_frame_wcs(theta + rng.uniform(-1, 1), crval=(RA + 0.3, DEC - 0.2))
            x0, y0 = stamp_centred_on(full, RA, DEC)
            pos = new if e == 1 else old
            stamps.append(make_stamp(full, x0 + int(rng.integers(-3, 4)), y0 + int(rng.integers(-3, 4)),
                                     stars=((*pos, 600.0),), sky=1.0, noise_sigma=0.5, rng=rng,
                                     obs_id=f"S{e}_{k}", mjd=60900.0 + 183 * e + k))
        frames.append(coadd_stamps(stamps, grid, mask_bits=0, label=f"D6 E{e + 1}", epoch_index=e + 1))
    d = difference(frames[1], frames[0])
    east, north = lobe_offset_east_north(d, old)
    assert angle_diff(position_angle(east, north), position_angle(-7.0, -5.0)) < 15.0
    assert d.label == "D6 E2 - E1"


# --- PSF matching ----------------------------------------------------------------------------------------


def _psf_pair(sigma_a: float, sigma_b: float, meta_fwhm: bool = False):
    grid = make_grid(RA, DEC, 6.0)
    rng = np.random.default_rng(9)
    stars = [(*offset_sky(RA, DEC, e, n), f) for e, n, f in [(0, 0, 800), (-90, 60, 500), (70, -100, 1200)]]
    fwhm = (lambda s: {"psf_fwhm_arcsec": s * 2.3548 * 6.15}) if meta_fwhm else (lambda s: {})
    a = grid_frame(grid, stars, var=0.01, rng=rng, psf_sigma=sigma_a, label="A", meta=fwhm(sigma_a))
    b = grid_frame(grid, stars, var=0.01, rng=rng, psf_sigma=sigma_b, label="B", meta=fwhm(sigma_b))
    return a, b


def test_psf_matching_removes_width_residuals_and_picks_the_sharper_frame() -> None:
    a, b = _psf_pair(0.8, 1.3)
    k = gaussian_matching_sigma(0.8, 1.3)
    raw = difference(a, b)
    matched = difference(a, b, psf_match_sigma_px=k)
    swapped = difference(b, a, psf_match_sigma_px=k)
    assert matched.meta["psf_matched"] == "a" and swapped.meta["psf_matched"] == "b"
    assert matched.meta["psf_match_sigma_px"] == pytest.approx(k)
    rms = lambda f: float(np.sqrt(np.nanmean(f.data[f.weight > 0] ** 2)))
    assert rms(matched) < 0.25 * rms(raw)
    assert rms(swapped) == pytest.approx(rms(matched), rel=1e-6)
    # convolving the wrong (broader) frame makes it worse
    wrong = difference(a, b, psf_match_sigma_px=k, psf_match_target="b")
    assert rms(wrong) > rms(raw)


def test_psf_matching_uses_meta_fwhm_when_present() -> None:
    a, b = _psf_pair(1.3, 0.8, meta_fwhm=True)
    d = difference(a, b, psf_match_sigma_px=gaussian_matching_sigma(1.3, 0.8))
    assert d.meta["psf_matched"] == "b"


def test_convolve_gaussian_conserves_flux_and_propagates_variance() -> None:
    rng = np.random.default_rng(2)
    shape = (200, 200)
    star = 1000.0 * gaussian_image(shape, 100.3, 99.6, 0.7)
    data = star + rng.normal(0.0, 0.5, shape)
    out, _w = convolve_gaussian(data, np.full(shape, 4.0), 1.2)
    assert np.nansum(out) == pytest.approx(np.sum(data), rel=1e-3)
    noise_only, w_noise = convolve_gaussian(rng.normal(0.0, 0.5, shape), np.full(shape, 4.0), 1.2)
    predicted_var = 1.0 / np.median(w_noise)
    assert float(np.var(noise_only[20:-20, 20:-20])) == pytest.approx(predicted_var, rel=0.1)
    assert predicted_var < 0.25 / 5  # smoothing lowers the per-pixel variance
    # a masked hole does not spread its values, only its footprint
    w_hole = np.full(shape, 4.0)
    w_hole[50:53, 50:53] = 0.0
    filled = np.where(w_hole > 0, 1.0, 1e9)
    out_h, w_h = convolve_gaussian(filled, w_hole, 1.0)
    assert np.all(w_h[51, 51] == 0) and np.nanmax(out_h) == pytest.approx(1.0)


# --- labels, units, validation ---------------------------------------------------------------------------


def test_labels() -> None:
    grid = make_grid(RA, DEC, 2.0)
    e3 = grid_frame(grid, label="D6 E3", epoch_index=3)
    e1 = grid_frame(grid, label="D6 E1", epoch_index=1)
    assert default_label(e3, e1) == "D6 E3 - E1"
    d5 = grid_frame(grid, label="x", epoch_index=1, detector=5)
    assert default_label(e3, d5) == "D6/D5 E3 - E1"
    no_epoch = grid_frame(grid, label="2026-05 burst", detector=None)
    assert default_label(no_epoch, e1) == "2026-05 burst - D6 E1"
    assert difference(e3, e1, label="custom").label == "custom"


def test_unnormalised_difference_and_masking() -> None:
    grid = make_grid(RA, DEC, 3.0)
    a = grid_frame(grid, sky=5.0, var=0.5)
    b = grid_frame(grid, sky=2.0, var=2.0)
    a.weight[3:6, 3:6] = 0.0  # masked in a only
    d = difference(a, b, normalize=False, subtract_background=False)
    ok = d.weight > 0
    np.testing.assert_allclose(d.data[ok], 3.0, rtol=1e-6)
    np.testing.assert_allclose(d.weight[ok], 1.0 / (2.0 + 0.5), rtol=1e-6)
    assert not ok[3:6, 3:6].any() and np.all(np.isnan(d.data[3:6, 3:6]))
    assert d.meta["units"] == "MJy/sr" and d.meta["background_offset"] == 0.0
    d_bg = difference(a, b, normalize=False)
    assert np.allclose(d_bg.data[ok], 0.0, atol=1e-6) and d_bg.meta["background_offset"] == pytest.approx(3.0)


def test_rejects_frames_on_different_grids() -> None:
    a = grid_frame(make_grid(RA, DEC, 3.0))
    with pytest.raises(ValueError, match="same grid"):
        difference(a, grid_frame(make_grid(RA + 0.01, DEC, 3.0)))
    with pytest.raises(ValueError):
        difference(a, grid_frame(make_grid(RA, DEC, 4.0)))
    with pytest.raises(ValueError):
        difference(a, a, psf_match_sigma_px=-1.0)
