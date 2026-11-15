"""Tests for pxh.imaging.coadd: IVW / median / sigma-clipped co-adds and stamp co-add frames (offline).
"""

from __future__ import annotations

import math

import numpy as np
import pytest
from test_align import full_frame_wcs, gaussian_image, make_stamp, offset_sky, stamp_centred_on

from pxh.imaging.align import make_grid, reproject_stamp
from pxh.imaging.coadd import MEDIAN_EFFICIENCY, coadd, coadd_stamps

SHAPE = (41, 41)


# --- coadd() on layers -----------------------------------------------------------------------------------


def test_ivw_math_exact() -> None:
    d1 = np.array([[1.0, 2.0], [3.0, np.nan]])
    w1 = np.array([[1.0, 1.0], [0.0, 5.0]])
    d2 = np.array([[3.0, 4.0], [5.0, 7.0]])
    w2 = np.array([[3.0, 0.0], [0.0, 1.0]])
    data, weight, n_used = coadd([(d1, w1), (d2, w2)])
    np.testing.assert_allclose(data[0, 0], (1 * 1 + 3 * 3) / 4)
    assert weight[0, 0] == 4 and n_used[0, 0] == 2
    assert data[0, 1] == 2.0 and weight[0, 1] == 1 and n_used[0, 1] == 1  # zero weight ignored
    assert np.isnan(data[1, 0]) and weight[1, 0] == 0 and n_used[1, 0] == 0  # no valid input -> NaN
    assert data[1, 1] == 7.0 and weight[1, 1] == 1 and n_used[1, 1] == 1  # NaN data ignored despite weight
    assert data.dtype == np.float32 and weight.dtype == np.float32 and n_used.dtype == np.int32


def test_ivw_variance_matches_inverse_weight_sum() -> None:
    rng = np.random.default_rng(1)
    sigmas = [1.0, 2.0, 0.5, 1.0]
    layers = [(5.0 + rng.normal(0, s, (300, 300)), np.full((300, 300), 1 / s**2)) for s in sigmas]
    data, weight, _ = coadd(layers)
    expected_var = 1.0 / sum(1 / s**2 for s in sigmas)
    np.testing.assert_allclose(weight, 1 / expected_var, rtol=1e-6)
    assert np.var(data) == pytest.approx(expected_var, rel=0.05)
    assert np.mean(data) == pytest.approx(5.0, abs=0.01)


def test_median_value_and_weight() -> None:
    layers = [(np.full((2, 2), v), np.full((2, 2), 2.0)) for v in (1.0, 5.0, 2.0)]
    data, weight, n_used = coadd(layers, method="median")
    np.testing.assert_allclose(data, 2.0)
    np.testing.assert_allclose(weight, 6.0 * MEDIAN_EFFICIENCY, rtol=1e-6)
    assert np.all(n_used == 3)
    data2, weight2, _ = coadd(layers[:2], method="median")  # 2 layers: median == mean, full efficiency
    np.testing.assert_allclose(data2, 3.0)
    np.testing.assert_allclose(weight2, 4.0)


def _star_layers(n: int, rng: np.random.Generator, transient_layer: int | None = None):
    """n noisy layers (sigma 1) with sky 10, a star whose brightness changes +-15% between layers (spectral
    stepping), and optionally a bright transient (asteroid / cosmic ray) in one layer."""
    star = 200.0 * gaussian_image(SHAPE, 20.0, 20.0, 1.0)
    transient = 300.0 * gaussian_image(SHAPE, 8.0, 31.0, 1.0)  # ~44 sigma peak
    layers = []
    for i in range(n):
        d = 10.0 + (1.0 + 0.15 * math.sin(i)) * star + rng.normal(0.0, 1.0, SHAPE)
        if i == transient_layer:
            d = d + transient
        layers.append((d, np.ones(SHAPE)))
    return layers, star, transient


@pytest.mark.parametrize("n", [5, 7, 12])
def test_sigclip_rejects_single_exposure_transient(n: int) -> None:
    rng = np.random.default_rng(n)
    layers, star, transient = _star_layers(n, rng, transient_layer=n // 2)
    clipped, _, n_used = coadd(layers, method="sigclip", sigma=3.0)
    ivw, _, _ = coadd(layers, method="ivw")
    sigma_coadd = 1.0 / math.sqrt(n)
    core = transient > 5.0  # transient pixels above 5 sigma in its layer
    assert core.sum() >= 5
    assert np.all(n_used[core] == n - 1)  # exactly the transient sample is rejected
    assert np.all(np.abs(clipped[core] - 10.0) < 4.5 * sigma_coadd)
    # control: a plain mean keeps the transient, diluted by 1/n (still > 10 sigma of the co-add here)
    assert ivw[core].max() - 10.0 > 0.8 * transient.max() / n > 10 * sigma_coadd
    # the star (in every layer, varying +-15%) is not clipped away: flux within 2% of the true mean
    star_box = (slice(14, 27), slice(14, 27))
    mean_scale = np.mean([1.0 + 0.15 * math.sin(i) for i in range(n)])
    assert (clipped[star_box] - 10.0).sum() == pytest.approx(mean_scale * star[star_box].sum(), rel=0.02)


def test_sigclip_does_not_overclip_pure_noise() -> None:
    rng = np.random.default_rng(7)
    layers = [(rng.normal(0.0, 1.0, (200, 200)), np.ones((200, 200))) for _ in range(9)]
    data, weight, n_used = coadd(layers, method="sigclip")
    assert 1.0 - n_used.mean() / 9 < 0.015
    assert np.std(data) == pytest.approx(1 / 3, rel=0.05)
    assert np.all(weight == n_used)


def test_sigclip_skips_pixels_with_too_few_layers() -> None:
    layers = [(np.array([[0.0]]), np.array([[1.0]])), (np.array([[100.0]]), np.array([[1.0]]))]
    data, _, n_used = coadd(layers, method="sigclip")
    assert data[0, 0] == pytest.approx(50.0) and n_used[0, 0] == 2


@pytest.mark.parametrize(
    ("layers", "kwargs"),
    [
        ([], {}),
        ([(np.zeros((2, 2)), np.ones((2, 2))), (np.zeros((3, 2)), np.ones((3, 2)))], {}),
        ([(np.zeros((2, 2)), np.ones((2, 3)))], {}),
        ([(np.zeros((2, 2)), np.ones((2, 2)))], {"method": "mean"}),
        ([(np.zeros((2, 2)), np.ones((2, 2)))], {"sigma": 0.0}),
    ],
)
def test_coadd_rejects_bad_input(layers: list, kwargs: dict) -> None:
    with pytest.raises(ValueError):
        coadd(layers, **kwargs)


# --- coadd_stamps -----------------------------------------------------------------------------------------


def _field(theta: float = 12.0):
    full = full_frame_wcs(theta)
    ra, dec = (float(v) for v in full.pixel_to_world_values(1300.0, 700.0))
    return full, ra, dec


def test_coadd_stamps_frame_and_metadata() -> None:
    full, ra, dec = _field()
    grid = make_grid(ra, dec, 3.0)
    x0, y0 = stamp_centred_on(full, ra, dec)
    yy = np.mgrid[: SHAPE[0], : SHAPE[1]][0]
    stamps = []
    for k, (mjd, noise) in enumerate([(60900.0, 1.0), (60901.0, 1.0), (60905.0, 0.5)]):
        wl = (4.40 + 0.01 * k + 0.0005 * (y0 + yy)).astype(np.float32)  # wavelength varies along the rows
        stamps.append(make_stamp(full, x0 + k, y0 - k, sky=3.0, noise_sigma=noise, rng=np.random.default_rng(k),
                                 obs_id=f"2025W33_2C_000{k}_1", mjd=mjd, wavelength=wl))
    frame = coadd_stamps(stamps, grid, mask_bits=0, label="D6 E1", epoch_index=1)

    totals = [float(reproject_stamp(s, *grid, mask_bits=0)[1].sum(dtype=np.float64)) for s in stamps]
    expected_mjd = sum(t * s.mjd_avg for t, s in zip(totals, stamps, strict=True)) / sum(totals)
    assert frame.mjd_mid == pytest.approx(expected_mjd, abs=1e-9)
    assert 60902.0 < frame.mjd_mid < 60904.5  # pulled toward the low-noise third stamp
    assert frame.n_inputs == 3 and frame.detector == 6 and frame.epoch_index == 1 and frame.label == "D6 E1"
    assert frame.data.shape == grid[1] and frame.data.dtype == np.float32 and frame.wcs is grid[0]
    assert frame.meta["obs_ids"] == [s.image.obs_id for s in stamps]
    assert frame.meta["kind"] == "coadd" and frame.meta["method"] == "ivw" and frame.meta["n_skipped"] == 0
    assert frame.meta["psf_fwhm_arcsec"] == pytest.approx(9.04)
    assert frame.meta["mjd_min"] == 60900.0 and frame.meta["mjd_max"] == 60905.0
    np.testing.assert_allclose(np.nanmedian(frame.data), 3.0, atol=0.05)

    # wavelength at the grid centre: per-input values, their range, and the weighted mean in between
    wls = frame.meta["wavelengths_um"]
    for k, (s, wl) in enumerate(zip(stamps, wls, strict=True)):
        _sx, sy = (float(v) for v in s.wcs.world_to_pixel_values(ra, dec))
        assert wl == pytest.approx(4.40 + 0.01 * k + 0.0005 * (y0 + sy), abs=1e-5)
    assert frame.meta["wavelength_min_um"] == pytest.approx(min(wls))
    assert frame.meta["wavelength_max_um"] == pytest.approx(max(wls))
    assert min(wls) < frame.wavelength_um < max(wls)


def test_coadd_stamps_sigclip_removes_asteroid_across_orientation_flip() -> None:
    """Six exposures alternating between survey orientations (0/180 deg); one shows an asteroid."""
    rng = np.random.default_rng(21)
    base, ra, dec = _field(theta=5.0)
    grid = make_grid(ra, dec, 3.0)
    star = (*offset_sky(ra, dec, -12.0, 15.0), 300.0)
    asteroid_pos = offset_sky(ra, dec, 30.0, -25.0)
    stamps = []
    for k in range(6):
        full = full_frame_wcs(5.0 if k % 2 == 0 else 185.0, crval=(float(base.wcs.crval[0]), float(base.wcs.crval[1])))
        x0, y0 = stamp_centred_on(full, ra, dec)
        stars = (star, (*asteroid_pos, 400.0)) if k == 2 else (star,)
        stamps.append(make_stamp(full, x0, y0, stars=stars, sky=1.0, noise_sigma=1.0, rng=rng,
                                 obs_id=f"2025W33_2C_010{k}_1", mjd=60900.0 + k * 0.07))
    clipped = coadd_stamps(stamps, grid, mask_bits=0, label="D6 E1 clipped", method="sigclip")
    plain = coadd_stamps(stamps, grid, mask_bits=0, label="D6 E1 plain")
    ax, ay = (round(float(v)) for v in grid[0].world_to_pixel_values(*asteroid_pos))
    sx, sy = (round(float(v)) for v in grid[0].world_to_pixel_values(star[0], star[1]))
    noise = 1.0 / math.sqrt(6)
    assert plain.data[ay, ax] - 1.0 > 15 * noise  # the asteroid shows in the plain mean
    assert abs(clipped.data[ay, ax] - 1.0) < 4 * noise  # and is gone from the clipped co-add
    assert clipped.data[sy, sx] - 1.0 > 30 * noise  # the static star survives
    assert clipped.meta["method"] == "sigclip"


def test_coadd_stamps_saturation_bits_leave_a_hole() -> None:
    full, ra, dec = _field()
    grid = make_grid(ra, dec, 3.0)
    x0, y0 = stamp_centred_on(full, ra, dec)
    flags = np.zeros(SHAPE, dtype=np.int32)
    flags[19:22, 19:22] = 2  # OVERFLOW
    frame = coadd_stamps([make_stamp(full, x0, y0, sky=1.0, flags=flags)], grid, mask_bits=0, label="sat",
                         saturation_bits=2)
    c = grid[1][0] // 2
    assert np.isnan(frame.data[c, c]) and frame.weight[c, c] == 0
    assert frame.meta["saturation_bits"] == 2


def test_coadd_stamps_skips_stamps_off_the_grid() -> None:
    full, ra, dec = _field()
    x0, y0 = stamp_centred_on(full, ra, dec)
    inside = make_stamp(full, x0, y0, sky=1.0, obs_id="in")
    outside = make_stamp(full, 100, 1900, sky=1.0, obs_id="out")  # ~2.5 deg away
    frame = coadd_stamps([inside, outside], make_grid(ra, dec, 3.0), mask_bits=0, label="x")
    assert frame.n_inputs == 1 and frame.meta["obs_ids"] == ["in"] and frame.meta["skipped_obs_ids"] == ["out"]

    empty = coadd_stamps([outside], make_grid(ra, dec, 3.0), mask_bits=0, label="none")
    assert empty.n_inputs == 0 and np.all(np.isnan(empty.data)) and not empty.weight.any()
    assert empty.mjd_mid == outside.mjd_avg
    with pytest.raises(ValueError):
        coadd_stamps([], make_grid(ra, dec, 3.0), mask_bits=0, label="none")
