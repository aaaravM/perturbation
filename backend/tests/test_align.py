"""Tests for pxh.imaging.align: shared grids and stamp reprojection.

Offline tests use synthetic TAN-SIP stamps (incl. the 180-degree survey flip). Tests marked `network` check
the same on two real SPHEREx D5 cutouts from consecutive surveys (run with --network; bytes are cached).
"""

from __future__ import annotations

import io
import math
import random
import time
import warnings
from pathlib import Path

import httpx
import numpy as np
import pytest
from astropy.io import fits
from astropy.io.votable import parse_single_table
from astropy.wcs import WCS, FITSFixedWarning, Sip
from scipy import ndimage
from scipy.special import erf

from pxh import config
from pxh.imaging.align import (
    make_grid,
    pixel_scale_arcsec,
    reproject_stamp,
    same_grid,
    saturated_mask_on_grid,
)
from pxh.imaging.diff import difference
from pxh.models import DetectorImage, Frame, Stamp

PIX = config.PIXEL_SCALE_ARCSEC
PSF_SIGMA_PX = 9.04 / PIX / 2.3548  # header PSF_FWHM 9.04 arcsec -> sigma ~0.62 px (undersampled)
RA0, DEC0 = 150.0, 2.0
BIT_HOT = 1 << 4
BIT_OVERFLOW = 1 << 1


# --- synthetic SPHEREx-like stamps ---------------------------------------------------------------------


def full_frame_wcs(theta_deg: float, sip: bool = True, crval: tuple[float, float] = (RA0, DEC0)) -> WCS:
    """2040x2040 TAN(-SIP) WCS rotated by theta (180 = the SPS_EPA flip), SIP terms like a real L2 header."""
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN-SIP", "DEC--TAN-SIP"] if sip else ["RA---TAN", "DEC--TAN"]
    w.wcs.crval = list(crval)
    w.wcs.crpix = [1020.5, 1020.5]
    t = math.radians(theta_deg)
    s = PIX / 3600.0
    w.wcs.cd = s * np.array([[-math.cos(t), math.sin(t)], [math.sin(t), math.cos(t)]])
    w.wcs.radesys = "ICRS"
    if sip:
        a = np.zeros((4, 4))
        b = np.zeros((4, 4))
        a[2, 0], a[1, 1], a[0, 2] = 1.6e-6, 4.3e-6, 1.4e-6
        a[3, 0], a[2, 1], a[1, 2], a[0, 3] = 5.5e-10, 2.2e-10, 6.8e-10, 3.9e-11
        b[2, 0], b[1, 1], b[0, 2] = 6.7e-6, 7.4e-7, 2.0e-6
        b[3, 0], b[2, 1], b[1, 2], b[0, 3] = 1.2e-10, 6.3e-10, 1.0e-10, 5.2e-10
        w.sip = Sip(a, b, None, None, w.wcs.crpix)
    w.pixel_shape = (2040, 2040)
    return w


def gaussian_image(shape: tuple[int, int], x: float, y: float, sigma: float) -> np.ndarray:
    """Pixel-integrated unit-flux circular Gaussian centred at 0-based (x, y)."""
    ny, nx = shape

    def axis(n: int, c: float) -> np.ndarray:
        edges = (np.arange(n + 1) - 0.5 - c) / (sigma * math.sqrt(2.0))
        return 0.5 * np.diff(erf(edges))

    return np.outer(axis(ny, y), axis(nx, x))


def make_stamp(
    wcs_full: WCS,
    x0: int,
    y0: int,
    shape: tuple[int, int] = (41, 41),
    *,
    stars: tuple[tuple[float, float, float], ...] = (),
    sky: float = 0.0,
    zodi: float = 0.0,
    noise_sigma: float = 0.0,
    rng: np.random.Generator | None = None,
    flags: np.ndarray | None = None,
    obs_id: str = "2025W33_2C_0001_1",
    detector: int = 6,
    mjd: float = 60900.0,
    psf_sigma: float = PSF_SIGMA_PX,
    wavelength: np.ndarray | None = None,
    big_endian: bool = True,
) -> Stamp:
    """A stamp cut at full-frame pixel (x0, y0); stars = ((ra, dec, peak-integrated flux in MJy/sr), ...)."""
    ny, nx = shape
    w = wcs_full[y0:y0 + ny, x0:x0 + nx]
    data = np.full(shape, sky + zodi, dtype=np.float64)
    for ra, dec, flux in stars:
        xs, ys = w.world_to_pixel_values(ra, dec)
        data += flux * gaussian_image(shape, float(xs), float(ys), psf_sigma)
    var = np.full(shape, noise_sigma**2 if noise_sigma > 0 else 1.0)
    if noise_sigma > 0:
        data += (rng or np.random.default_rng(0)).normal(0.0, noise_sigma, shape)
    dtype = ">f4" if big_endian else "<f4"
    image = DetectorImage(
        obs_id=obs_id, detector=detector, collection="spherex_dr1",
        publisher_did=f"ivo://irsa.ipac/spherex_dr1?{obs_id}/D{detector}",
        access_url=f"https://example.invalid/{obs_id}_D{detector}.fits",
        t_min_mjd=mjd - 0.0007, t_max_mjd=mjd + 0.0007, em_min_um=4.4, em_max_um=5.0, exptime_s=113.58,
        s_region="", release_date="2026-01-01", file_tag="test",
    )
    return Stamp(
        image=image, x0=x0, y0=y0, data=data.astype(dtype), variance=var.astype(dtype),
        zodi=np.full(shape, zodi, dtype=dtype),
        flags=flags if flags is not None else np.zeros(shape, dtype=np.int32),
        wcs=w, header=fits.Header({"PSF_FWHM": 9.04, "DETECTOR": detector}), mjd_avg=mjd,
        wavelength_um=wavelength,
    )


def stamp_centred_on(wcs_full: WCS, ra: float, dec: float, shape: tuple[int, int] = (41, 41)) -> tuple[int, int]:
    """Full-frame (x0, y0) of a stamp of `shape` centred on (ra, dec)."""
    x, y = wcs_full.world_to_pixel_values(ra, dec)
    return round(float(x)) - shape[1] // 2, round(float(y)) - shape[0] // 2


def centroid(img: np.ndarray, x: float, y: float, radius: float = 5.0) -> tuple[float, float]:
    yy, xx = np.mgrid[: img.shape[0], : img.shape[1]]
    m = (np.hypot(xx - x, yy - y) <= radius) & np.isfinite(img)
    v = np.where(m, img, 0.0)
    return float((v * xx).sum() / v.sum()), float((v * yy).sum() / v.sum())


def offset_sky(ra: float, dec: float, east_arcsec: float, north_arcsec: float) -> tuple[float, float]:
    return ra + east_arcsec / 3600.0 / math.cos(math.radians(dec)), dec + north_arcsec / 3600.0


# --- make_grid -------------------------------------------------------------------------------------------


def test_make_grid_is_north_up_east_left_and_centred() -> None:
    wcs, shape = make_grid(RA0, DEC0, 6.0)
    assert shape == (59, 59)  # 360" / 6.15" = 58.5 -> 59, odd
    c = (shape[1] - 1) / 2
    ra, dec = wcs.pixel_to_world_values(c, c)
    assert ra == pytest.approx(RA0, abs=1e-10) and dec == pytest.approx(DEC0, abs=1e-10)
    ra_n, dec_n = wcs.pixel_to_world_values(c, c + 1)
    ra_e, dec_e = wcs.pixel_to_world_values(c - 1, c)
    assert dec_n > dec and ra_n == pytest.approx(ra, abs=1e-9)  # +y is north
    assert ra_e > ra and dec_e == pytest.approx(dec, abs=1e-6)  # -x is east (east-left)
    assert pixel_scale_arcsec(wcs) == pytest.approx(PIX, rel=1e-9)
    assert wcs.wcs.radesys == "ICRS" and wcs.pixel_shape == (59, 59)


def test_make_grid_oversample_and_ra_wrap() -> None:
    wcs, shape = make_grid(370.0, -30.0, 6.0, oversample=2)
    assert shape == (117, 117)
    assert pixel_scale_arcsec(wcs) == pytest.approx(PIX / 2, rel=1e-9)
    assert wcs.wcs.crval[0] == pytest.approx(10.0)


@pytest.mark.parametrize(
    "kwargs",
    [{"fov_arcmin": 0.0}, {"fov_arcmin": -1.0}, {"dec": 91.0}, {"oversample": 0}, {"oversample": 1.5},
     {"fov_arcmin": 1e4}, {"ra": float("nan")}],
)
def test_make_grid_rejects_bad_input(kwargs: dict) -> None:
    args = {"ra": RA0, "dec": DEC0, "fov_arcmin": 6.0} | kwargs
    with pytest.raises(ValueError):
        make_grid(**args)


def test_same_grid() -> None:
    a, sa = make_grid(RA0, DEC0, 6.0)
    b, sb = make_grid(RA0, DEC0, 6.0)
    c, sc = make_grid(RA0 + 1e-4, DEC0, 6.0)
    assert same_grid(a, b, sa, sb)
    assert not same_grid(a, c, sa, sc)
    assert not same_grid(a, b, sa, (59, 61))


# --- reprojection geometry -------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("theta", "sip", "oversample"),
    [(5.2, True, 1), (37.0, True, 1), (185.2, True, 1), (180.0, False, 1), (217.0, True, 2)],
)
def test_star_reprojects_to_expected_grid_pixel(theta: float, sip: bool, oversample: int) -> None:
    """A Gaussian star at a known RA/Dec in a rotated TAN-SIP stamp lands within 0.05 px of its grid pixel."""
    full = full_frame_wcs(theta, sip=sip)
    centre_ra, centre_dec = full.pixel_to_world_values(1640.0, 260.0)  # far from CRPIX: SIP is ~1-3 px here
    star_ra, star_dec = offset_sky(float(centre_ra), float(centre_dec), 20.0, -33.0)
    x0, y0 = stamp_centred_on(full, float(centre_ra), float(centre_dec))
    stamp = make_stamp(full, x0, y0, stars=((star_ra, star_dec, 1000.0),))
    grid_wcs, shape = make_grid(float(centre_ra), float(centre_dec), 3.0, oversample=oversample)

    data, weight, footprint = reproject_stamp(stamp, grid_wcs, shape, mask_bits=0)

    ex, ey = (float(v) for v in grid_wcs.world_to_pixel_values(star_ra, star_dec))
    cx, cy = centroid(np.nan_to_num(data), ex, ey, radius=5.0 * oversample)
    assert math.hypot(cx - ex, cy - ey) < 0.05
    assert data.dtype == np.float32 and weight.dtype == np.float32 and footprint.dtype == np.float32
    assert np.all(weight[np.isfinite(data)] > 0)


def _star_sum_on_grid(theta: float, oversample: int, psf_sigma: float, rng: np.random.Generator) -> float:
    """Reproject a 500-unit star (grid at a random sub-pixel phase); return its grid sum in native-pixel units."""
    full = full_frame_wcs(theta, sip=False)
    fx, fy = rng.uniform(0.0, 1.0, 2)
    ra, dec = (float(v) for v in full.pixel_to_world_values(1000.0 + fx, 1000.0 + fy))
    sra, sdec = (float(v) for v in full.pixel_to_world_values(*(1000.0 + rng.uniform(-3.0, 3.0, 2))))
    x0, y0 = stamp_centred_on(full, ra, dec)
    stamp = make_stamp(full, x0, y0, stars=((sra, sdec, 500.0),), sky=2.0, psf_sigma=psf_sigma)
    grid_wcs, shape = make_grid(ra, dec, 2.0, oversample=oversample)
    data, weight, _ = reproject_stamp(stamp, grid_wcs, shape, mask_bits=0)
    sky = np.percentile(data[weight > 0], 5)  # pixels away from the star
    assert sky == pytest.approx(2.0, abs=1e-5)  # MJy/sr is intensive: the sky level is unchanged
    return float(np.nansum(data - 2.0)) / oversample**2


@pytest.mark.parametrize("oversample", [1, 2])
def test_surface_brightness_and_flux_are_conserved(oversample: int) -> None:
    rng = np.random.default_rng(11)
    # Well-sampled star: the sum is conserved to < 1% in a single reprojection.
    assert _star_sum_on_grid(30.0, oversample, 1.5, rng) == pytest.approx(500.0, rel=0.01)
    # The real PSF (sigma 0.62 px) is undersampled: bilinear resampling onto a rotated grid changes one
    # exposure's sum by a few % depending on the sub-pixel phase, but it averages out over phases (co-adds).
    sums = [_star_sum_on_grid(45.0, oversample, PSF_SIGMA_PX, rng) for _ in range(30)]
    assert np.mean(sums) == pytest.approx(500.0, rel=0.01)
    assert np.max(np.abs(np.array(sums) / 500.0 - 1.0)) < 0.08


def test_no_overlap_returns_empty_arrays() -> None:
    full = full_frame_wcs(0.0)
    stamp = make_stamp(full, 1000, 1000, sky=1.0)
    grid_wcs, shape = make_grid(RA0 + 20.0, DEC0, 6.0)
    data, weight, footprint = reproject_stamp(stamp, grid_wcs, shape, mask_bits=0)
    assert np.all(np.isnan(data)) and not weight.any() and not footprint.any()


# --- masking and weights ---------------------------------------------------------------------------------


def _flat_stamp_and_grid(theta: float = 23.0, **kw):
    full = full_frame_wcs(theta)
    ra, dec = (float(v) for v in full.pixel_to_world_values(1200.0, 900.0))
    x0, y0 = stamp_centred_on(full, ra, dec)
    stamp = make_stamp(full, x0, y0, sky=1.0, **kw)
    grid_wcs, shape = make_grid(ra, dec, 3.0)
    return stamp, grid_wcs, shape


def test_masked_pixels_are_excluded_and_do_not_bleed() -> None:
    flags = np.zeros((41, 41), dtype=np.int32)
    flags[18:23, 15:21] = BIT_HOT
    stamp, grid_wcs, shape = _flat_stamp_and_grid(flags=flags)
    stamp.data[18:23, 15:21] = 1e6  # garbage values under the flag

    data, weight, footprint = reproject_stamp(stamp, grid_wcs, shape, mask_bits=BIT_HOT)
    ok = weight > 0
    assert ok.sum() > 500  # of 29 x 29
    np.testing.assert_allclose(data[ok], 1.0, atol=1e-5)  # nothing of the 1e6 block leaks into kept pixels
    assert np.all(np.isnan(data[~ok]))

    # the hole is where the flagged block lands: its centre maps to an invalid grid pixel
    ra, dec = stamp.wcs.pixel_to_world_values(17.5, 20.0)
    gx, gy = (round(float(v)) for v in grid_wcs.world_to_pixel_values(ra, dec))
    assert weight[gy, gx] == 0 and footprint[gy, gx] == 1

    # control: without masking, the garbage does appear
    data_unmasked, _, _ = reproject_stamp(stamp, grid_wcs, shape, mask_bits=0)
    assert np.nanmax(data_unmasked) > 1e5


def test_nan_data_and_bad_variance_are_invalid() -> None:
    stamp, grid_wcs, shape = _flat_stamp_and_grid(theta=0.0)
    stamp.data[10, 10] = np.nan
    stamp.variance[30, 30] = 0.0
    data, weight, _ = reproject_stamp(stamp, grid_wcs, shape, mask_bits=0)
    for sx, sy in ((10, 10), (30, 30)):
        ra, dec = stamp.wcs.pixel_to_world_values(sx, sy)
        gx, gy = (round(float(v)) for v in grid_wcs.world_to_pixel_values(ra, dec))
        assert weight[gy, gx] == 0
    np.testing.assert_allclose(data[weight > 0], 1.0, atol=1e-5)


def test_flag_bit_31_is_handled() -> None:
    flags = np.zeros((41, 41), dtype=np.int32)
    flags[20, 20] = np.int32(-(2**31))  # bit 31 set
    stamp, grid_wcs, shape = _flat_stamp_and_grid(flags=flags)
    _, weight_masked, _ = reproject_stamp(stamp, grid_wcs, shape, mask_bits=1 << 31)
    _, weight_plain, _ = reproject_stamp(stamp, grid_wcs, shape, mask_bits=BIT_HOT)
    assert (weight_masked > 0).sum() < (weight_plain > 0).sum()


def test_zodi_is_subtracted_by_default() -> None:
    stamp, grid_wcs, shape = _flat_stamp_and_grid(zodi=5.0)
    data, weight, _ = reproject_stamp(stamp, grid_wcs, shape, mask_bits=0)
    raw, _, _ = reproject_stamp(stamp, grid_wcs, shape, mask_bits=0, subtract_zodi=False)
    np.testing.assert_allclose(data[weight > 0], 1.0, atol=1e-5)
    np.testing.assert_allclose(raw[weight > 0], 6.0, atol=1e-5)


def test_weight_is_inverse_variance_with_interpolation_correction() -> None:
    # Aligned case: grid pixels coincide with stamp pixel centres -> weight is exactly 1/variance.
    full = full_frame_wcs(0.0, sip=False)
    stamp = make_stamp(full, 1000, 1000, sky=1.0, noise_sigma=0.5)
    ra, dec = (float(v) for v in stamp.wcs.pixel_to_world_values(20.0, 20.0))
    grid_wcs, shape = make_grid(ra, dec, 3.0)
    _, weight, _ = reproject_stamp(stamp, grid_wcs, shape, mask_bits=0)
    np.testing.assert_allclose(weight[weight > 0], 4.0, rtol=1e-4)

    # Rotated case: interpolation averages pixels, so the true variance is lower and weight in [1/V, 4/V].
    stamp_r, grid_r, shape_r = _flat_stamp_and_grid(theta=33.0, noise_sigma=0.5)
    _, w_corr, _ = reproject_stamp(stamp_r, grid_r, shape_r, mask_bits=0)
    _, w_raw, _ = reproject_stamp(stamp_r, grid_r, shape_r, mask_bits=0, interp_variance_correction=False)
    ok = w_corr > 0
    assert np.all(w_corr[ok] >= 4.0 * (1 - 1e-4)) and np.all(w_corr[ok] <= 16.0 * (1 + 1e-4))
    assert w_corr[ok].mean() > 1.5 * 4.0
    np.testing.assert_allclose(w_raw[ok], 4.0, rtol=1e-4)


def test_saturated_mask_matches_the_hole() -> None:
    flags = np.zeros((41, 41), dtype=np.int32)
    flags[19:22, 19:22] = BIT_OVERFLOW
    stamp, grid_wcs, shape = _flat_stamp_and_grid(theta=185.0, flags=flags)
    sat = saturated_mask_on_grid(stamp, grid_wcs, shape, BIT_OVERFLOW)
    assert sat.dtype == bool and 9 <= sat.sum() <= 40
    ra, dec = stamp.wcs.pixel_to_world_values(20.0, 20.0)
    gx, gy = (round(float(v)) for v in grid_wcs.world_to_pixel_values(ra, dec))
    assert sat[gy, gx]
    _, weight, footprint = reproject_stamp(stamp, grid_wcs, shape, mask_bits=0, saturation_bits=BIT_OVERFLOW)
    interior_hole = (weight == 0) & (footprint == 1)
    assert np.array_equal(interior_hole, sat)
    assert not saturated_mask_on_grid([stamp], grid_wcs, shape, 0).any()


def test_stamp_without_variance_uses_robust_estimate() -> None:
    stamp, grid_wcs, shape = _flat_stamp_and_grid(noise_sigma=0.5, rng=np.random.default_rng(3))
    stamp.variance = None
    stamp.zodi = None
    _, weight, _ = reproject_stamp(stamp, grid_wcs, shape, mask_bits=0, interp_variance_correction=False)
    assert np.median(weight[weight > 0]) == pytest.approx(4.0, rel=0.15)


def test_shape_mismatch_raises() -> None:
    stamp, grid_wcs, shape = _flat_stamp_and_grid()
    stamp.variance = np.ones((5, 5), dtype=np.float32)
    with pytest.raises(ValueError, match="variance"):
        reproject_stamp(stamp, grid_wcs, shape, mask_bits=0)


# --- live: real SPHEREx Level-2 data (IRSA cutout service used only as a test oracle) -----------------------

LIVE_CENTRE = (269.446, 4.699)  # crowded field 4' south of Barnard's star (kept outside the cutout)
LIVE_SIZE_DEG = 0.25
LIVE_FOV_ARCMIN = 13.0
# D5 in Survey 2 (DR1, SPS_EPA 0) and Survey 3 (QR3, SPS_EPA 180): the 180-degree orientation flip.
LIVE_OBS_IDS = ("2026W12_1A_0311_3", "2026W34_2A_0178_3")
LIVE_DETECTOR = 5
_LIVE_MAX_BYTES = 20_000_000  # a cutout is ~4.3 MB; the full file would be 65 MB


def _live_images() -> list[DetectorImage]:
    path = Path(__file__).parent / "fixtures" / "sia_barnard_trimmed.xml"
    table = parse_single_table(str(path)).to_table(use_names_over_ids=True)
    images = []
    for row in table:
        det = int(str(row["energy_bandpassname"]).rsplit("D", 1)[-1])
        if str(row["obs_id"]) not in LIVE_OBS_IDS or det != LIVE_DETECTOR:
            continue
        url = str(row["access_url"])
        images.append(DetectorImage(
            obs_id=str(row["obs_id"]), detector=det, collection=str(row["obs_collection"]),
            publisher_did=str(row["obs_publisher_did"]), access_url=url,
            t_min_mjd=float(row["t_min"]), t_max_mjd=float(row["t_max"]),
            em_min_um=float(row["em_min"]) * 1e6, em_max_um=float(row["em_max"]) * 1e6,
            exptime_s=float(row["t_exptime"]), s_region=str(row["s_region"]),
            release_date=str(row["obs_release_date"]), file_tag=url.rsplit("_spx_", 1)[-1].removesuffix(".fits"),
        ))
    return sorted(images, key=lambda im: im.t_min_mjd)


def _fetch_cutout(image: DetectorImage) -> bytes:
    """Cutout bytes, cached under CACHE_DIR/imaging/oracle; retried like every IRSA call (8x, 2-16 s)."""
    stem = image.basename.removesuffix(".fits")
    cache = config.CACHE_DIR / "imaging" / "oracle" / f"{stem}_{LIVE_CENTRE[0]}_{LIVE_CENTRE[1]}_{LIVE_SIZE_DEG}.fits"
    if cache.exists():
        return cache.read_bytes()
    url = f"{image.access_url}?center={LIVE_CENTRE[0]},{LIVE_CENTRE[1]}&size={LIVE_SIZE_DEG}"
    headers = {"User-Agent": config.USER_AGENT}
    with httpx.Client(headers=headers, timeout=config.HTTP_TIMEOUT_S, follow_redirects=True) as client:
        for attempt in range(config.RETRY_ATTEMPTS):
            try:
                response = client.get(url)
                if response.status_code < 500:
                    response.raise_for_status()
                    break
            except httpx.TransportError:
                pass
            wait = min(config.RETRY_WAIT_MAX_S, config.RETRY_WAIT_INITIAL_S * 2**attempt)
            time.sleep(wait * random.uniform(0.5, 1.0))
        else:
            pytest.fail(f"IRSA cutout failed {config.RETRY_ATTEMPTS} times: {url}")
    assert len(response.content) < _LIVE_MAX_BYTES, "cutout service returned the whole file"
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_bytes(response.content)
    return response.content


def _stamp_from_cutout(image: DetectorImage, raw: bytes) -> Stamp:
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", FITSFixedWarning)
        with fits.open(io.BytesIO(raw)) as hdul:
            header = hdul["IMAGE"].header.copy()
            flags_header = hdul["FLAGS"].header
            bits = {str(flags_header[k]).strip(): int(k[4:]) for k in flags_header if k.startswith("MSKN")}
            planes = {name: np.array(hdul[name].data) for name in ("IMAGE", "FLAGS", "VARIANCE", "ZODI")}
        wcs = WCS(header)
    return Stamp(image=image, x0=0, y0=0, data=planes["IMAGE"], variance=planes["VARIANCE"],
                 zodi=planes["ZODI"], flags=planes["FLAGS"], wcs=wcs, header=header,
                 mjd_avg=float(header["MJD-AVG"]), flag_bits=bits)  # x0/y0: cutout origin, unused here


def _bits_mask(flag_bits: dict[str, int], groups: tuple[str, ...]) -> int:
    return sum(1 << bit for name, bit in flag_bits.items() if name.startswith(groups))


@pytest.fixture(scope="module")
def live_stamps() -> list[Stamp]:
    images = _live_images()
    assert [im.obs_id for im in images] == list(LIVE_OBS_IDS)
    return [_stamp_from_cutout(im, _fetch_cutout(im)) for im in images]


def _live_masks(stamp: Stamp) -> tuple[int, int, int]:
    """(invalid | artifact, saturation, SOURCE) FLAGS masks of a live stamp."""
    bits = stamp.flag_bits
    return (_bits_mask(bits, config.FLAGS_INVALID + config.FLAGS_ARTIFACT),
            _bits_mask(bits, config.FLAGS_SATURATION), _bits_mask(bits, ("SOURCE",)))


def _local_centroid(d: np.ndarray, w: np.ndarray, r: np.ndarray, xx: np.ndarray, yy: np.ndarray):
    bkg = np.median(d[(r >= 4) & (r <= 6) & (w > 0)])
    m = r <= 2.5
    v = np.clip(d[m] - bkg, 0.0, None)
    return (v * xx[m]).sum() / v.sum(), (v * yy[m]).sum() / v.sum()


def _star_offsets(layer_a, layer_b, min_snr: float = 25.0) -> np.ndarray:
    """Grid-pixel centroid offsets (a - b) of isolated stars above min_snr, valid around the peak in both."""
    (da, wa, _), (db, wb, _) = layer_a, layer_b
    snr = np.nan_to_num(da * np.sqrt(wa))
    peaks = (snr == ndimage.maximum_filter(snr, size=7)) & (snr > min_snr)
    ny, nx = snr.shape
    yy, xx = np.mgrid[:ny, :nx]
    offsets = []
    for y, x in zip(*np.nonzero(peaks), strict=True):
        if not (6 <= y < ny - 6 and 6 <= x < nx - 6):
            continue
        r = np.hypot(xx - x, yy - y)
        if not ((wa[r <= 3] > 0).all() and (wb[r <= 3] > 0).all()):
            continue
        if (peaks & (r > 0) & (r <= 5) & (snr > 0.2 * snr[y, x])).any():
            continue  # not isolated
        (xa, ya), (xb, yb) = _local_centroid(da, wa, r, xx, yy), _local_centroid(db, wb, r, xx, yy)
        offsets.append((xa - xb, ya - yb))
    return np.array(offsets)


@pytest.mark.network
def test_live_real_stars_align_across_the_survey_flip(live_stamps: list[Stamp]) -> None:
    """Real TAN-SIP headers, real FLAGS: static stars land on the same grid pixels in both orientations."""
    a, b = live_stamps
    assert {float(a.header["SPS_EPA"]), float(b.header["SPS_EPA"])} == {0.0, 180.0}
    bad, sat, _ = _live_masks(a)
    grid_wcs, shape = make_grid(*LIVE_CENTRE, LIVE_FOV_ARCMIN)
    layers = [reproject_stamp(s, grid_wcs, shape, bad, saturation_bits=sat) for s in (a, b)]
    assert all(np.mean(w > 0) > 0.9 for _, w, _ in layers)
    offsets = _star_offsets(*layers)
    assert len(offsets) >= 5  # 13 isolated stars at S/N > 25 on 2026-11-14
    median = np.median(offsets, axis=0)
    scatter = 1.4826 * np.median(np.abs(offsets - median), axis=0)
    assert math.hypot(*median) < 0.25  # px; measured 0.09 px (0.6") on 2026-11-14
    assert np.all(scatter < 0.15)  # measured 0.03-0.04 px


@pytest.mark.network
def test_live_difference_snr_is_calibrated_on_source_free_sky(live_stamps: list[Stamp]) -> None:
    """VARIANCE + the bilinear variance correction give unit-variance S/N on real sky; without it ~0.6."""
    a, b = live_stamps
    bad, sat, source = _live_masks(a)
    grid_wcs, shape = make_grid(*LIVE_CENTRE, LIVE_FOV_ARCMIN)
    frames = []
    for k, s in enumerate((a, b)):
        data, weight, _ = reproject_stamp(s, grid_wcs, shape, bad, saturation_bits=sat)
        frames.append(Frame(data=data, weight=weight, wcs=grid_wcs, mjd_mid=s.mjd_avg, n_inputs=1,
                            label=s.image.obs_id, detector=LIVE_DETECTOR, epoch_index=k + 1))
    d = difference(frames[1], frames[0])
    sky = ~saturated_mask_on_grid([a, b], grid_wcs, shape, source) & (d.weight > 0)
    assert sky.sum() >= 50  # SOURCE covers ~96% of this crowded field; 78 sky pixels on 2026-11-14
    v = d.data[sky]
    robust_std = 1.4826 * float(np.median(np.abs(v - np.median(v))))
    assert 0.8 < robust_std < 1.25  # measured 0.97 (0.60 with interp_variance_correction=False)
    # All pixels, including stars seen at different wavelengths by the two exposures: measured 1.15.
    assert 0.9 < d.meta["snr_robust_std"] < 1.5
    assert d.label == "D5 E2 - E1"
