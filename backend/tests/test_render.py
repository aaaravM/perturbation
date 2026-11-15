"""Tests for pxh.imaging.render: shared limits, PNG orientation vs the Aladin WCS, colour maps, GIFs.
"""

from __future__ import annotations

import io
import json

import numpy as np
import pytest
from astropy.io import fits
from astropy.wcs import WCS
from PIL import Image, ImageSequence
from test_align import full_frame_wcs, gaussian_image, make_stamp, offset_sky, stamp_centred_on

from pxh.imaging.align import make_grid, saturated_mask_on_grid
from pxh.imaging.render import (
    apply_stretch,
    mask_to_png,
    png_pixel_to_world,
    rgb_composite,
    shared_limits,
    to_png,
    wcs_to_aladin,
    world_to_png_pixel,
    write_gif,
)
from pxh.models import Frame

RA, DEC = 83.8, -5.4


def frame_on(grid, data: np.ndarray, weight: np.ndarray | None = None, kind: str = "coadd", label: str = "F") -> Frame:
    wcs, shape = grid
    w = np.ones(shape, dtype=np.float32) if weight is None else weight.astype(np.float32)
    return Frame(data=data.astype(np.float32), weight=w, wcs=wcs, mjd_mid=60900.0, n_inputs=1, label=label,
                 detector=6, meta={"kind": kind})


def star_frame(grid, positions, flux: float = 100.0, sky: float = 0.0) -> Frame:
    wcs, shape = grid
    data = np.full(shape, sky)
    for ra, dec in positions:
        x, y = (float(v) for v in wcs.world_to_pixel_values(ra, dec))
        data += flux * gaussian_image(shape, x, y, 0.8)
    return frame_on(grid, data)


def decode(png: bytes) -> Image.Image:
    im = Image.open(io.BytesIO(png))
    im.load()
    return im


# --- limits ----------------------------------------------------------------------------------------------


def test_shared_limits_use_all_frames_and_ignore_invalid_pixels() -> None:
    grid = make_grid(RA, DEC, 3.0)
    shape = grid[1]
    a = frame_on(grid, np.linspace(0, 10, shape[0] * shape[1]).reshape(shape))
    b_data = np.linspace(10, 30, shape[0] * shape[1]).reshape(shape)
    b_weight = np.ones(shape)
    b_weight[0, :] = 0.0
    b_data[0, :] = 1e9  # garbage under zero weight must not affect limits
    b = frame_on(grid, b_data, b_weight)
    vmin, vmax = shared_limits([a, b], percentiles=(0.0, 100.0))
    assert vmin == pytest.approx(0.0) and vmax == pytest.approx(30.0)
    lo, hi = shared_limits([a, b])
    expected = np.percentile(np.concatenate([a.data.ravel(), b.data[1:].ravel()]), [0.5, 99.7])
    assert (lo, hi) == pytest.approx(tuple(expected), rel=1e-6)
    s_lo, s_hi = shared_limits([frame_on(grid, np.linspace(-2, 5, shape[0] * shape[1]).reshape(shape))],
                               percentiles=(0, 100), symmetric=True)
    assert (s_lo, s_hi) == pytest.approx((-5.0, 5.0))
    assert shared_limits([np.full((3, 3), np.nan)]) == (0.0, 1.0)
    with pytest.raises(ValueError):
        shared_limits([a], percentiles=(50, 10))


def test_png_shared_limits_give_equal_levels_for_equal_values() -> None:
    grid = make_grid(RA, DEC, 3.0)
    shape = grid[1]
    rng = np.random.default_rng(0)
    a_data = rng.uniform(0, 5, shape)
    b_data = rng.uniform(0, 20, shape)
    a_data[10, 10] = b_data[10, 10] = 4.2
    frames = [frame_on(grid, a_data), frame_on(grid, b_data)]
    vmin, vmax = shared_limits(frames)
    pa, pb = (np.asarray(decode(to_png(f, vmin, vmax))) for f in frames)
    row = shape[0] - 1 - 10  # PNG rows are flipped
    assert pa[row, 10] == pb[row, 10]
    # with per-frame limits the same value would render differently (sanity check of the test)
    pa2 = np.asarray(decode(to_png(frames[0], *shared_limits([frames[0]]))))
    assert pa2[row, 10] != pa[row, 10]


@pytest.mark.parametrize("stretch", ["linear", "asinh", "log"])
def test_stretches_are_monotonic_from_0_to_1(stretch: str) -> None:
    t = np.linspace(-0.5, 1.5, 201)
    y = apply_stretch(t, stretch)
    assert y[0] == 0.0 and y[-1] == pytest.approx(1.0)
    assert np.all(np.diff(y) >= 0)
    with pytest.raises(ValueError):
        apply_stretch(t, "cubic")


# --- PNG modes -------------------------------------------------------------------------------------------


def test_png_modes_and_nan_transparency() -> None:
    grid = make_grid(RA, DEC, 2.0)
    shape = grid[1]
    data = np.arange(shape[0] * shape[1], dtype=float).reshape(shape)
    weight = np.ones(shape)
    weight[2, 5] = 0.0  # invalid pixel at FITS row 2
    im_plain = decode(to_png(frame_on(grid, data), 0, data.max()))
    assert im_plain.mode == "L" and im_plain.size == (shape[1], shape[0])
    im = decode(to_png(frame_on(grid, data, weight), 0, data.max()))
    assert im.mode == "RGBA"
    alpha = np.asarray(im)[..., 3]
    assert alpha[shape[0] - 1 - 2, 5] == 0 and (alpha == 0).sum() == 1
    im_opaque = decode(to_png(frame_on(grid, data, weight), 0, data.max(), nan_transparent=False))
    assert im_opaque.mode == "L"
    arr = data.copy()
    arr[0, 0] = np.nan  # plain arrays: NaN marks invalid
    assert decode(to_png(arr, 0, arr[1:].max())).mode == "RGBA"
    with pytest.raises(ValueError):
        to_png(arr, 1.0, 1.0)


def test_difference_frames_use_a_symmetric_diverging_map() -> None:
    grid = make_grid(RA, DEC, 2.0)
    shape = grid[1]
    data = np.zeros(shape)
    data[5, 5], data[10, 10] = 8.0, -8.0
    png = to_png(frame_on(grid, data, kind="difference"), -10.0, 10.0)
    rgb = np.asarray(decode(png).convert("RGB")).astype(int)
    pos, neg, zero = rgb[shape[0] - 1 - 5, 5], rgb[shape[0] - 1 - 10, 10], rgb[0, 0]
    assert pos[0] > pos[2] + 60 and neg[2] > neg[0] + 60  # positive warm, negative cool
    assert zero.max() < 25  # zero is dark (blends with the sky background in Aladin)
    assert abs(pos.sum() - neg.sum()) < 150  # symmetric brightness for +/- equal S/N
    gray = decode(to_png(frame_on(grid, data, kind="difference"), -10, 10, cmap="gray"))
    assert gray.mode == "L"


def test_rgb_composite_puts_each_source_in_its_channel() -> None:
    grid = make_grid(RA, DEC, 3.0)
    p_r, p_g, p_b = (offset_sky(RA, DEC, e, n) for e, n in ((-40, 30), (0, 0), (40, -30)))
    r, g, b = (star_frame(grid, [p]) for p in (p_r, p_g, p_b))
    rgb = np.asarray(decode(rgb_composite(r, g, b)).convert("RGB")).astype(int)
    for pos, ch in ((p_r, 0), (p_g, 1), (p_b, 2)):
        col, row = (round(v) for v in world_to_png_pixel(grid[0], grid[1], *pos))
        px = rgb[row, col]
        assert px[ch] > 200 and all(px[ch] > px[o] + 100 for o in range(3) if o != ch)
    with pytest.raises(ValueError):
        rgb_composite(r, g, np.zeros((3, 3)))


# --- orientation and the Aladin WCS ----------------------------------------------------------------------


def test_png_is_north_up_east_left() -> None:
    grid = make_grid(RA, DEC, 4.0)
    centre = (RA, DEC)
    north = offset_sky(RA, DEC, 0.0, 60.0)
    east = offset_sky(RA, DEC, 60.0, 0.0)
    for pos, check in ((north, lambda c, r, c0, r0: r < r0 - 5 and abs(c - c0) < 1),
                       (east, lambda c, r, c0, r0: c < c0 - 5 and abs(r - r0) < 1)):
        frame = star_frame(grid, [pos])
        png = np.asarray(decode(to_png(frame, 0, float(frame.data.max()), stretch="linear")))
        row, col = np.unravel_index(np.argmax(png), png.shape)
        c0, r0 = world_to_png_pixel(grid[0], grid[1], *centre)
        assert check(col, row, c0, r0)


@pytest.mark.parametrize("oversample", [1, 2])
def test_source_lands_on_the_png_pixel_given_by_the_aladin_wcs(oversample: int) -> None:
    """Round trip: Frame -> PNG + WCS dict -> JSON -> astropy WCS; the star's PNG pixel matches its RA/Dec."""
    grid = make_grid(RA, DEC, 4.0, oversample=oversample)
    star = offset_sky(RA, DEC, -47.0, 71.0)
    frame = star_frame(grid, [star], flux=500.0)
    png = np.asarray(decode(to_png(frame, 0, float(frame.data.max()), stretch="linear")))  # no clipped ties
    row, col = np.unravel_index(np.argmax(png), png.shape)

    header_dict = json.loads(json.dumps(wcs_to_aladin(grid[0], grid[1])))
    assert header_dict["NAXIS1"] == grid[1][1] and header_dict["NAXIS2"] == grid[1][0]
    assert {"CTYPE1", "CTYPE2", "CRPIX1", "CRPIX2", "CRVAL1", "CRVAL2", "CD1_1", "CD1_2", "CD2_1", "CD2_2",
            "RADESYS", "EQUINOX"} <= set(header_dict)
    w = WCS(fits.Header(header_dict))

    # Aladin Lite 3.8.2 grid.rs: texture row y maps to FITS pixel ImgXY(x + 0.5, (NAXIS2 - y) + 0.5),
    # so the centre of PNG pixel (col, row) is FITS (1-based) (col + 1, NAXIS2 - row).
    naxis2 = header_dict["NAXIS2"]
    ra, dec = w.all_pix2world([[col + 1.0, naxis2 - row]], 1)[0]
    sep_arcsec = np.hypot((ra - star[0]) * np.cos(np.radians(DEC)), dec - star[1]) * 3600.0
    assert sep_arcsec < 0.75 * 6.15 / oversample  # within the pixel the star falls in

    c_pred, r_pred = world_to_png_pixel(w, grid[1], *star)
    assert (round(c_pred), round(r_pred)) == (col, row)
    back = png_pixel_to_world(w, grid[1], c_pred, r_pred)
    assert back == pytest.approx(star, abs=1e-9)
    # the JSON WCS is the grid WCS itself
    np.testing.assert_allclose(w.wcs.crpix, grid[0].wcs.crpix)
    np.testing.assert_allclose(w.pixel_scale_matrix, grid[0].pixel_scale_matrix, rtol=1e-12)


def test_wcs_to_aladin_rejects_sip() -> None:
    with pytest.raises(ValueError, match="SIP"):
        wcs_to_aladin(full_frame_wcs(10.0, sip=True), (2040, 2040))


def test_saturation_overlay_lands_on_the_saturated_star() -> None:
    """saturated_mask_on_grid -> mask_to_png: the overlay sits on the star's PNG pixel, rest transparent."""
    full = full_frame_wcs(185.0)  # flipped survey orientation
    ra, dec = (float(v) for v in full.pixel_to_world_values(1300.0, 800.0))
    x0, y0 = stamp_centred_on(full, ra, dec)
    flags = np.zeros((41, 41), dtype=np.int32)
    sx, sy = (round(float(v)) for v in full[y0:y0 + 41, x0:x0 + 41].world_to_pixel_values(ra, dec))
    flags[sy - 1:sy + 2, sx - 1:sx + 2] = 2  # OVERFLOW core
    stamp = make_stamp(full, x0, y0, sky=1.0, flags=flags)
    grid = make_grid(ra, dec, 3.0)
    sat = saturated_mask_on_grid(stamp, *grid, 2)
    im = decode(mask_to_png(sat, color=(255, 0, 255), alpha=200))
    assert im.mode == "RGBA" and im.size == (grid[1][1], grid[1][0])
    rgba = np.asarray(im)
    col, row = (round(v) for v in world_to_png_pixel(grid[0], grid[1], ra, dec))
    assert tuple(rgba[row, col]) == (255, 0, 255, 200)
    assert (rgba[..., 3] > 0).sum() == sat.sum()
    np.testing.assert_array_equal(rgba[..., 3] > 0, np.flipud(sat))  # same north-up flip as to_png
    with pytest.raises(ValueError):
        mask_to_png(np.zeros((2, 2, 2), dtype=bool))
    with pytest.raises(ValueError):
        mask_to_png(sat, alpha=300)


# --- GIF -------------------------------------------------------------------------------------------------


def test_write_gif_frames_timing_loop_and_labels(tmp_path) -> None:
    grid = make_grid(RA, DEC, 6.0)
    frames = [star_frame(grid, [offset_sky(RA, DEC, 6.0 * k, 0.0)]) for k in range(3)]
    vmin, vmax = shared_limits(frames)
    pngs = [to_png(f, vmin, vmax) for f in frames]
    path = write_gif(pngs, tmp_path / "out" / "blink.gif", ms_per_frame=400,
                     label_texts=["D6 E1 2025-08-18", "D6 E2 2026-02-14", "D6 E3 2026-08-20"])
    with Image.open(path) as gif:
        assert gif.format == "GIF" and gif.n_frames == 3
        assert gif.info.get("loop") == 0 and gif.info.get("duration") == 400
        assert min(gif.size) >= 360  # 59 px grid upscaled for viewing
        first = next(np.asarray(fr.convert("RGB")) for fr in ImageSequence.Iterator(gif))
    corner = first[:20, :60].reshape(-1, 3)
    assert (corner.max(axis=1) > 200).any()  # white label text drawn in the top-left corner
    with pytest.raises(ValueError):
        write_gif(pngs, tmp_path / "x.gif", label_texts=["only one"])
    with pytest.raises(ValueError):
        write_gif([], tmp_path / "x.gif")
