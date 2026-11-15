"""Tests for pxh.spherex.l2: Level-2 layouts, pixel stamps (IMAGE/VARIANCE/ZODI/FLAGS), RICE_1, ePSFs.

Offline tests build synthetic Level-2 files with astropy: real IMAGE, FLAGS (MSK*), EPSF and WCS-WAVE headers
from level2_2025W33_2C_0321_1D6, synthetic pixels, FLAGS RICE_1-compressed in one tile per row, served by
rangeio.MockRangeServer. They compare every byte offset and pixel with astropy reading the same file. The
full-size (2040 x 2040) file reproduces the real offsets; a small one exercises the slow layout path.
Fixture l2_flags_rows_D6.npz holds six real compressed FLAGS tiles with their decoded rows.

Network tests compare read_stamp with IRSA cutouts of four Barnard's Star exposures (DR1 D6, DR1 D3, QR3 D3,
QR3 D2) for IMAGE, VARIANCE, ZODI and FLAGS, and read the real ePSF tables.
"""

from __future__ import annotations

import io
import time
import warnings
from collections.abc import Callable, Iterator
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path

import httpx
import numpy as np
import pytest
from astropy.io import fits
from astropy.io.fits.hdu.compressed._codecs import Rice1

from pxh import config
from pxh.models import DetectorImage, EPSFGrid, Stamp
from pxh.spherex import flags as flagmod
from pxh.spherex import l2, rangeio
from pxh.spherex.wavelength import WaveLookup

FIXTURES = Path(__file__).parent / "fixtures"
BARNARD_STAMP_POS = (269.4462, 4.7690)
D6_EPSF_CALIB = "calib-019f4f97-b309-70c9-ac48-c9f75b692223"


def _header(name: str) -> fits.Header:
    return fits.Header.fromstring((FIXTURES / name).read_text(), sep="\n")


IMAGE_HEADER = _header("l2_image_header_dr1_D6.txt")
FLAGS_FIXTURE_HEADER = _header("l2_flags_header_dr1_D6.txt")
WCSWAVE_D6 = (FIXTURES / "l2_wcswave_D6.bin").read_bytes()


# --- synthetic Level-2 files ------------------------------------------------------------------------------


@dataclass
class SynthL2:
    key: str
    blob: bytes
    truth: dict[str, np.ndarray]  # image, variance, zodi, flags (astropy's reading of the blob)
    hdus: list[tuple[str, int, int, int]]  # (EXTNAME, header start, data start, padded data span)

    @property
    def image(self) -> DetectorImage:
        return DetectorImage(
            obs_id="2025W33_2C_0321_1", detector=6, collection="spherex_dr1",
            publisher_did="ivo://irsa.ipac/spherex_dr1?2025W33_2C_0321_1/D6",
            access_url=config.IRSA_IBE_SPHEREX_PREFIX + self.key,
            t_min_mjd=60902.864714549, t_max_mjd=60902.866046927, em_min_um=4.40, em_max_um=5.02,
            exptime_s=113.5826, s_region="", release_date="2026-11-01T00:00:00", file_tag="l2b-test",
            s3_key=self.key,
        )


def _flags_image_header() -> fits.Header:
    h = fits.Header()
    for card in FLAGS_FIXTURE_HEADER.cards:
        if card.keyword.startswith("MSK"):
            h.append(card)
    return h


def _epsf_hdu() -> fits.BinTableHDU:
    with fits.open(FIXTURES / "l2_epsf_rows_D6.fits") as hd:
        return fits.BinTableHDU(data=hd["EPSF"].data.copy(), header=hd["EPSF"].header.copy())


def build_l2(nx: int, ny: int, key: str, seed: int = 0) -> SynthL2:
    rng = np.random.default_rng(seed)
    image = rng.normal(1.0, 0.25, (ny, nx)).astype(np.float32)
    image[3, 4] = np.nan
    variance = rng.uniform(1e-3, 2e-3, (ny, nx)).astype(np.float32)
    zodi = np.broadcast_to(0.5 + 1e-4 * np.arange(nx, dtype=np.float32), (ny, nx)).astype(np.float32)
    flg = np.where(rng.random((ny, nx)) < 0.8, 1 << 21, 0).astype(np.int32)
    flg |= np.where(rng.random((ny, nx)) < 0.02, 1 << 1, 0).astype(np.int32)
    flg[:, ::97] |= 1 << 6
    flg[10] = 0  # constant tile (low-entropy RICE blocks)
    flg[11] = rng.integers(-(2**31), 2**31, nx, dtype=np.int64).astype(np.int32)  # high-entropy blocks
    hdus = [
        fits.PrimaryHDU(),
        fits.ImageHDU(image, header=IMAGE_HEADER.copy()),
        fits.CompImageHDU(flg, header=_flags_image_header(), name="FLAGS", compression_type="RICE_1",
                          tile_shape=(1, nx)),
        fits.ImageHDU(variance, name="VARIANCE"),
        fits.ImageHDU(zodi, name="ZODI"),
        _epsf_hdu(),
    ]
    buf = io.BytesIO()
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        fits.HDUList(hdus).writeto(buf)
    blob = buf.getvalue() + WCSWAVE_D6  # WCS-WAVE is the last HDU of a Level-2 file
    with fits.open(io.BytesIO(blob)) as hd:
        truth = {
            "image": hd["IMAGE"].data.copy(), "variance": hd["VARIANCE"].data.copy(),
            "zodi": hd["ZODI"].data.copy(), "flags": np.asarray(hd["FLAGS"].data).copy(),
        }
    with fits.open(io.BytesIO(blob), disable_image_compression=True) as hd:
        spans = []
        for i, h in enumerate(hd):
            info = h.fileinfo()
            spans.append((h.name if i else "PRIMARY", info["hdrLoc"], info["datLoc"], info["datSpan"]))
    assert np.array_equal(truth["flags"], flg) and np.array_equal(truth["image"], image, equal_nan=True)
    return SynthL2(key=key, blob=blob, truth=truth, hdus=spans)


KEY_FULL = "dr1/level2/2025W33_2C/l2b-test/6/level2_2025W33_2C_0321_1D6_spx_l2b-test.fits"
KEY_SMALL = "dr1/level2/2025W33_2C/l2b-test/6/level2_2025W33_2C_0321_2D6_spx_l2b-test.fits"


@pytest.fixture(scope="module")
def full_file() -> SynthL2:
    return build_l2(config.DETECTOR_NPIX, config.DETECTOR_NPIX, KEY_FULL, seed=1)


@pytest.fixture(scope="module")
def small_file() -> SynthL2:
    return build_l2(150, 120, KEY_SMALL, seed=2)


@pytest.fixture
def isolated(monkeypatch: pytest.MonkeyPatch, tmp_path) -> Iterator[None]:
    monkeypatch.setattr(config, "CACHE_DIR", tmp_path / "cache")
    monkeypatch.setattr(rangeio, "RETRY_POLICY", rangeio.RetryPolicy(wait_initial_s=0, wait_max_s=0, jitter_s=0))
    l2.clear_memory_cache()
    yield
    l2.clear_memory_cache()


@pytest.fixture
def serve(isolated) -> Iterator[Callable[..., rangeio.MockRangeServer]]:
    """Serve synthetic files on IBE and S3 URLs through rangeio's client."""
    saved: list[httpx.Client | None] = []

    def _serve(*files: SynthL2) -> rangeio.MockRangeServer:
        blobs = {}
        for f in files:
            blobs[config.IRSA_IBE_SPHEREX_PREFIX + f.key] = f.blob
            blobs[config.SPHEREX_S3_PREFIX + f.key] = f.blob
        server = rangeio.MockRangeServer(blobs)
        saved.append(rangeio.set_client(server.client()))
        return server

    yield _serve
    if saved:
        rangeio.set_client(saved[0])


def _radec(x: float, y: float) -> tuple[float, float]:
    ra, dec = l2.celestial_wcs(IMAGE_HEADER).all_pix2world([[x, y]], 0)[0]
    return float(ra), float(dec)


def _assert_stamp_matches(stamp: Stamp, f: SynthL2) -> None:
    ny, nx = stamp.data.shape
    sl = (slice(stamp.y0, stamp.y0 + ny), slice(stamp.x0, stamp.x0 + nx))
    assert stamp.data.dtype == np.float32 and stamp.flags is not None and stamp.flags.dtype == np.int32
    assert np.array_equal(stamp.data, f.truth["image"][sl], equal_nan=True)
    assert np.array_equal(stamp.variance, f.truth["variance"][sl])
    assert np.array_equal(stamp.zodi, f.truth["zodi"][sl])
    assert np.array_equal(stamp.flags, f.truth["flags"][sl])


# --- layout -----------------------------------------------------------------------------------------------


@pytest.mark.parametrize("which", ["full", "small"])
def test_layout_offsets_match_astropy(serve, full_file: SynthL2, small_file: SynthL2, which: str) -> None:
    f = full_file if which == "full" else small_file
    serve(f)
    layout = l2.read_layout(f.image)
    assert [(h.name, h.header_start, h.data_start, h.data_length_padded) for h in layout.hdus] == f.hdus
    assert [h.name for h in layout.hdus] == ["PRIMARY", "IMAGE", "FLAGS", "VARIANCE", "ZODI", "EPSF", "WCS-WAVE"]
    assert all(a.end == b.header_start for a, b in zip(layout.hdus, layout.hdus[1:]))
    assert layout.file_size == len(f.blob) == layout.hdus[-1].end
    ny, nx = f.truth["image"].shape
    assert layout.shape == (ny, nx)
    fg = layout.flags
    assert fg is not None
    assert (fg.naxis1, fg.naxis2, fg.znaxis1, fg.znaxis2, fg.ztile1, fg.ztile2) == (8, ny, nx, ny, nx, 1)
    assert (fg.zcmptype, fg.zbitpix, fg.blocksize, fg.bytepix, fg.descriptor) == ("RICE_1", 32, 32, 4, "P")
    assert fg.theap == fg.naxis1 * fg.naxis2 and fg.pcount == layout.hdu("FLAGS").data_length - 8 * ny
    assert layout.image_header["MJD-AVG"] == IMAGE_HEADER["MJD-AVG"]
    assert layout.epsf_calibration == D6_EPSF_CALIB
    assert layout.wave is not None and layout.wave.source == "spectral_wcs_6_v3.0.fits"


def test_full_size_layout_needs_two_requests(serve, full_file: SynthL2) -> None:
    serve(full_file)
    with rangeio.track() as st:
        layout = l2.read_layout(full_file.image)
    assert st.requests == layout.requests == 2
    assert st.bytes < 250_000
    assert layout.hdu("IMAGE").data_start == 25920  # as in real DR1 files


def test_layout_is_cached_in_memory_and_on_disk(serve, small_file: SynthL2) -> None:
    serve(small_file)
    first = l2.read_layout(small_file.image)
    with rangeio.track() as st:
        assert l2.read_layout(small_file.image) is first
    assert st.requests == 0
    l2.clear_memory_cache()
    with rangeio.track() as st:
        disk = l2.read_layout(small_file.image)
    assert st.requests == 0 and disk is not first
    assert disk.to_json() == first.to_json()
    assert disk.flags == first.flags and disk.image_header == first.image_header
    path = Path(config.CACHE_DIR) / "pixels" / "layout" / small_file.image.cache_key
    assert path.with_name(path.name + ".json").is_file()
    with rangeio.track() as st:
        l2.read_layout(small_file.image, refresh=True)
    assert st.requests > 0


def test_layout_survives_a_failing_cache(serve, small_file: SynthL2, monkeypatch: pytest.MonkeyPatch) -> None:
    serve(small_file)

    def broken(path: Path, data: bytes) -> None:
        raise PermissionError("file in use")

    monkeypatch.setattr(rangeio, "write_atomic", broken)
    layout = l2.read_layout(small_file.image)
    assert layout.hdu("WCS-WAVE").data_start == small_file.hdus[-1][2]
    stamp = l2.read_stamp(small_file.image, *_radec(50.0, 50.0), half_size_px=3)
    _assert_stamp_matches(stamp, small_file)


def test_header_and_wave_shortcut_then_layout_reuses_its_bytes(serve, full_file: SynthL2) -> None:
    server = serve(full_file)
    with rangeio.track() as st:
        header, wave = l2.read_header_and_wave(full_file.image)
    assert st.requests == 1 and server.range_headers == ["bytes=0-40959,-8640"]
    assert header["EXTNAME"] == "IMAGE" and wave.source == "spectral_wcs_6_v3.0.fits"
    layout = l2.read_layout(full_file.image)
    assert "-8640" not in server.range_headers[1] and not server.range_headers[1].startswith("bytes=0-")
    assert [h.data_start for h in layout.hdus] == [s[2] for s in full_file.hdus]
    assert np.array_equal(layout.wave.wavelength, wave.wavelength)
    with rangeio.track() as st:  # with a layout cached, the shortcut needs no network
        l2.read_header_and_wave(full_file.image)
    assert st.requests == 0


# --- stamps -----------------------------------------------------------------------------------------------


@pytest.mark.parametrize("half", [0, 10, 30])
def test_read_stamp_matches_astropy_full_size(serve, full_file: SynthL2, half: int) -> None:
    serve(full_file)
    ra, dec = _radec(1626.3, 267.8)
    l2.read_layout(full_file.image)
    with rangeio.track() as st:
        stamp = l2.read_stamp(full_file.image, ra, dec, half_size_px=half)
    assert (stamp.x0, stamp.y0) == (1626 - half, 268 - half)
    assert stamp.data.shape == (2 * half + 1, 2 * half + 1)
    _assert_stamp_matches(stamp, full_file)
    assert st.requests == (3 if half == 30 else 2)  # float rows + FLAGS descriptors, then the FLAGS heap


def test_read_stamp_covers_nan_and_every_rice_branch(serve, small_file: SynthL2) -> None:
    serve(small_file)
    ra, dec = _radec(8.0, 9.0)
    stamp = l2.read_stamp(small_file.image, ra, dec, half_size_px=6)  # rows 3..15: NaN, constant, noise rows
    assert (stamp.x0, stamp.y0) == (2, 3)
    assert np.isnan(stamp.data[0, 2])
    _assert_stamp_matches(stamp, small_file)


def test_read_stamp_from_s3_uses_single_ranges(serve, full_file: SynthL2) -> None:
    server = serve(full_file)
    l2.read_layout(full_file.image)  # the layout (IBE) is shared with the S3 source
    n = len(server.range_headers)
    ra, dec = _radec(700.2, 1500.6)
    stamp = l2.read_stamp(full_file.image, ra, dec, half_size_px=12, source="s3", use_cache=False)
    _assert_stamp_matches(stamp, full_file)
    assert all("," not in h for h in server.range_headers[n:])
    # rows of one plane merge into one range: IMAGE, VARIANCE, ZODI, FLAGS descriptors, then the FLAGS heap
    assert len(server.range_headers) - n == 5


def test_stamp_wcs_is_the_full_wcs_shifted(serve, full_file: SynthL2) -> None:
    serve(full_file)
    ra, dec = _radec(1500.0, 300.0)
    stamp = l2.read_stamp(full_file.image, ra, dec, half_size_px=20, with_flags=False)
    assert stamp.wcs.sip is not None
    full = l2.celestial_wcs(IMAGE_HEADER)
    i, j = np.meshgrid(np.arange(0, 41, 4.0), np.arange(0, 41, 4.0))
    a = np.array(full.all_pix2world(i.ravel() + stamp.x0, j.ravel() + stamp.y0, 0))
    b = np.array(stamp.wcs.all_pix2world(i.ravel(), j.ravel(), 0))
    assert np.max(np.abs(a - b)) * 3600 < 1e-6
    x, y = l2.world_to_pixel(stamp.wcs, ra, dec)
    assert abs(x - (1500.0 - stamp.x0)) < 1e-6 and abs(y - (300.0 - stamp.y0)) < 1e-6


def test_stamp_metadata(serve, full_file: SynthL2) -> None:
    serve(full_file)
    ra, dec = _radec(100.0, 1900.0)
    stamp = l2.read_stamp(full_file.image, ra, dec, half_size_px=5)
    assert stamp.image == full_file.image
    assert stamp.mjd_avg == IMAGE_HEADER["MJD-AVG"]
    assert stamp.header["OBSID"] == "2025W33_2C_0321_1"
    assert stamp.flag_bits == flagmod.flag_bits(FLAGS_FIXTURE_HEADER) and len(stamp.flag_bits) == 23
    lookup = WaveLookup.from_hdu_bytes(WCSWAVE_D6, IMAGE_HEADER)
    lam, bw = lookup.grid(stamp.x0, stamp.y0, 11, 11)
    assert np.array_equal(stamp.wavelength_um, lam) and np.array_equal(stamp.bandwidth_um, bw)
    assert stamp.wavelength_um.shape == stamp.data.shape


def test_optional_planes_are_skipped(serve, full_file: SynthL2) -> None:
    serve(full_file)
    ra, dec = _radec(1000.0, 1000.0)
    l2.read_layout(full_file.image)
    with rangeio.track() as full_st:
        l2.read_stamp(full_file.image, ra, dec, half_size_px=8, use_cache=False)
    with rangeio.track() as st:
        stamp = l2.read_stamp(full_file.image, ra, dec, half_size_px=8, with_flags=False, with_variance=False,
                              with_zodi=False, with_wavelength=False, use_cache=False)
    assert stamp.flags is None and stamp.variance is None and stamp.zodi is None
    assert stamp.wavelength_um is None and stamp.bandwidth_um is None
    assert np.array_equal(stamp.data, full_file.truth["image"][stamp.y0 : stamp.y0 + 17, stamp.x0 : stamp.x0 + 17])
    assert st.requests == 1 and st.bytes < full_st.bytes / 3


def test_stamps_are_clipped_at_the_detector_edge(serve, full_file: SynthL2) -> None:
    serve(full_file)
    ra, dec = _radec(2.2, 2037.6)
    stamp = l2.read_stamp(full_file.image, ra, dec, half_size_px=10)
    assert (stamp.x0, stamp.y0) == (0, 2028) and stamp.data.shape == (12, 13)
    _assert_stamp_matches(stamp, full_file)
    ra, dec = _radec(-5.0, 500.0)  # target just off the detector: the overlapping part is returned
    stamp = l2.read_stamp(full_file.image, ra, dec, half_size_px=10)
    assert stamp.x0 == 0 and stamp.data.shape == (21, 6)
    ra, dec = _radec(-40.0, 500.0)
    with pytest.raises(l2.OutsideDetectorError):
        l2.read_stamp(full_file.image, ra, dec, half_size_px=10)
    with pytest.raises(ValueError):
        l2.read_stamp(full_file.image, ra, dec, half_size_px=-1)


def test_stamps_are_cached_on_disk(serve, full_file: SynthL2) -> None:
    serve(full_file)
    ra, dec = _radec(321.0, 654.0)
    first = l2.read_stamp(full_file.image, ra, dec, half_size_px=7)
    with rangeio.track() as st:
        again = l2.read_stamp(full_file.image, ra, dec, half_size_px=7)
    assert st.requests == 0
    for name in ("data", "variance", "zodi", "flags"):
        assert np.array_equal(getattr(first, name), getattr(again, name), equal_nan=True)
    with rangeio.track() as st:
        l2.read_stamp(full_file.image, ra, dec, half_size_px=7, use_cache=False)
    assert st.requests == 2


def test_concurrent_stamps_share_one_layout(serve, full_file: SynthL2) -> None:
    server = serve(full_file)
    positions = [_radec(200.0 + 150 * k, 300.0 + 100 * k) for k in range(8)]
    with ThreadPoolExecutor(max_workers=8) as ex:
        stamps = list(ex.map(lambda p: l2.read_stamp(full_file.image, p[0], p[1], half_size_px=9), positions))
    for s in stamps:
        _assert_stamp_matches(s, full_file)
    assert sum(1 for h in server.range_headers if h and h.startswith("bytes=0-40959")) == 1


# --- FLAGS geometry and RICE_1 ----------------------------------------------------------------------------


def test_flags_geometry_of_a_real_header() -> None:
    fg = l2.flags_geometry(FLAGS_FIXTURE_HEADER)
    assert (fg.naxis1, fg.naxis2, fg.pcount, fg.theap) == (8, 2040, 11_056_032, 16_320)
    assert (fg.znaxis1, fg.znaxis2, fg.ztile1, fg.ztile2) == (2040, 2040, 2040, 1)
    assert (fg.zcmptype, fg.zbitpix, fg.blocksize, fg.bytepix) == ("RICE_1", 32, 32, 4)
    assert (fg.descriptor, fg.descriptor_offset) == ("P", 0)
    assert fg.zscale is None and fg.zzero is None and fg.zblank is None
    gzip = FLAGS_FIXTURE_HEADER.copy()
    gzip["ZCMPTYPE"] = "GZIP_1"
    with pytest.raises(l2.L2FormatError):
        l2.flags_geometry(gzip)
    tiled = FLAGS_FIXTURE_HEADER.copy()
    tiled["ZTILE1"] = 100
    with pytest.raises(l2.L2FormatError):
        l2.flags_geometry(tiled)


def test_rice_decoders_reproduce_real_flags_tiles() -> None:
    with np.load(FIXTURES / "l2_flags_rows_D6.npz") as z:
        lengths, compressed, decoded = z["lengths"], z["compressed"].tobytes(), z["decoded"]
        nx, blocksize, bytepix = int(z["nx"]), int(z["blocksize"]), int(z["bytepix"])
    offsets = np.concatenate([[0], np.cumsum(lengths)])
    for k in range(len(lengths)):
        tile = compressed[offsets[k] : offsets[k + 1]]
        assert np.array_equal(l2.rice_decode(tile, nx, blocksize, bytepix), decoded[k])
        assert np.array_equal(l2.rice_decode_py(tile, nx, blocksize, bytepix), decoded[k])


@pytest.mark.parametrize(("bytepix", "dtype"), [(4, np.int32), (2, np.int16), (1, np.uint8)])
def test_python_rice_decoder_matches_astropy_codec(bytepix: int, dtype: type) -> None:
    rng = np.random.default_rng(bytepix)
    info = np.iinfo(dtype)
    n = 1000
    cases = [
        np.zeros(n),  # low-entropy blocks
        np.full(n, info.max),
        rng.integers(info.min, int(info.max) + 1, n, dtype=np.int64),  # high-entropy blocks
        np.cumsum(rng.integers(-3, 4, n)) + 50,  # small differences (normal Rice coding)
        np.r_[np.full(37, info.min), np.full(37, info.max), rng.integers(0, 5, n - 74)],
    ]
    for arr in cases:
        arr = np.clip(arr, info.min, info.max).astype(dtype)
        for nblock in (32, 16):
            buf = Rice1(blocksize=nblock, bytepix=bytepix, tilesize=n).encode(arr)
            got = l2.rice_decode_py(bytes(buf), n, nblock, bytepix)
            assert np.array_equal(got.astype(dtype), arr)
            assert np.array_equal(l2.rice_decode(bytes(buf), n, nblock, bytepix), arr)


def test_truncated_rice_tile_raises() -> None:
    arr = np.random.default_rng(0).integers(-(2**31), 2**31, 500, dtype=np.int64).astype(np.int32)
    buf = bytes(Rice1(blocksize=32, bytepix=4, tilesize=500).encode(arr))
    with pytest.raises(ValueError):
        l2.rice_decode_py(buf[: len(buf) // 2], 500)


def test_decode_flags_honours_zscale_zzero_zblank() -> None:
    nx = 64
    rows = [np.arange(nx, dtype=np.int32), np.full(nx, 7, dtype=np.int32)]
    rows[1][5] = -999
    heap = {t: bytes(Rice1(blocksize=32, bytepix=4, tilesize=nx).encode(r)) for t, r in enumerate(rows)}
    base = l2.flags_geometry(FLAGS_FIXTURE_HEADER)
    fg = l2.FlagsGeometry(**{**base.__dict__, "znaxis1": nx, "ztile1": nx, "znaxis2": 2, "naxis2": 2,
                             "zscale": 2.0, "zzero": 10.0, "zblank": -999})
    out = l2._decode_flags(b"\0" * 16, heap, fg, 0, 1)
    assert out.dtype == np.float64
    assert np.array_equal(out[0], np.arange(nx) * 2.0 + 10.0)
    assert np.isnan(out[1, 5]) and out[1, 4] == 24.0
    plain = l2.FlagsGeometry(**{**fg.__dict__, "zscale": None, "zzero": None, "zblank": None})
    assert l2._decode_flags(b"\0" * 16, heap, plain, 0, 1).dtype == np.int32


# --- ePSF -------------------------------------------------------------------------------------------------


def test_read_epsf_and_its_cache(serve, full_file: SynthL2) -> None:
    serve(full_file)
    l2.read_layout(full_file.image)
    with rangeio.track() as st:
        grid = l2.read_epsf(full_file.image)
    assert st.requests == 1
    assert isinstance(grid, EPSFGrid) and grid.psfs.shape == (3, 33, 33) and grid.oversampling == 5
    assert np.allclose(grid.psfs.sum(axis=(1, 2)), 1.0, atol=1e-9)
    assert np.allclose(grid.xcenter, [48.07143, 1019.5, 1990.9286], atol=1e-4)
    assert grid.cwave_um is not None and np.allclose(grid.cwave_um, [5.0010757, 4.688732, 4.424525], atol=1e-6)
    assert np.array_equal(grid.nearest(1000.0, 1000.0), grid.psfs[1])
    path = Path(config.CACHE_DIR) / "pixels" / "epsf" / f"D6_{D6_EPSF_CALIB}.npz"
    assert path.is_file()
    with rangeio.track() as st:
        again = l2.read_epsf(full_file.image)
    assert st.requests == 0 and np.array_equal(again.psfs, grid.psfs)


def test_epsf_calibration_id_fallbacks() -> None:
    text = {"IMAGE": l2.header_to_text(IMAGE_HEADER)}
    assert l2.epsf_calibration_id(text, "c/f.fits") == D6_EPSF_CALIB
    no_calib = IMAGE_HEADER.copy()
    no_calib.remove("HISTORY", remove_all=True)
    epsf_header = _epsf_hdu().header
    text = {"IMAGE": l2.header_to_text(no_calib), "EPSF": l2.header_to_text(epsf_header)}
    assert l2.epsf_calibration_id(text, "c/f.fits") == "epsf_6_20260507.fits"
    text["EPSF"] = l2.header_to_text(fits.Header({"EXTNAME": "EPSF"}))
    assert l2.epsf_calibration_id(text, "spherex_dr1/f.fits") == "file-spherex_dr1_f.fits"


# --- helpers ----------------------------------------------------------------------------------------------


def test_fits_helpers() -> None:
    assert l2.padded(0) == 0 and l2.padded(1) == 2880 and l2.padded(2880) == 2880
    hdr = fits.Header({"SIMPLE": True, "BITPIX": 8, "NAXIS": 0})
    raw = hdr.tostring(sep="", endcard=True, padding=True).encode()
    assert l2.find_header_end(raw) == 2880 and l2.find_header_end(raw[:160]) is None
    assert l2.data_size(fits.Header({"NAXIS": 2, "NAXIS1": 8, "NAXIS2": 2040, "BITPIX": 8, "PCOUNT": 100})) == 16420
    with pytest.raises(l2.L2FormatError):
        l2.parse_header(b" " * 2880)


def test_stamp_box_and_world_to_pixel() -> None:
    assert l2.stamp_box(10.49, 10.51, 2, 100, 100) == (8, 9, 12, 13)
    assert l2.stamp_box(-0.6, 5.0, 3, 100, 100) == (0, 2, 2, 8)
    with pytest.raises(l2.OutsideDetectorError):
        l2.stamp_box(-10.0, 5.0, 3, 100, 100)
    with pytest.raises(l2.OutsideDetectorError):
        l2.stamp_box(float("nan"), 5.0, 3, 100, 100)
    wcs = l2.celestial_wcs(IMAGE_HEADER)
    rng = np.random.default_rng(3)
    for x, y in rng.uniform(0, 2039, (20, 2)):
        ra, dec = wcs.all_pix2world([[x, y]], 0)[0]
        px, py = l2.world_to_pixel(IMAGE_HEADER, ra, dec)
        assert abs(px - x) < 1e-6 and abs(py - y) < 1e-6


def test_image_url_sources(full_file: SynthL2) -> None:
    image = full_file.image
    assert l2.image_url(image) == config.IRSA_IBE_SPHEREX_PREFIX + KEY_FULL
    assert l2.image_url(image, "s3") == config.SPHEREX_S3_PREFIX + KEY_FULL
    no_key = DetectorImage(**{**image.__dict__, "s3_key": None})
    assert l2.image_url(no_key, "s3") == config.SPHEREX_S3_PREFIX + KEY_FULL
    with pytest.raises(ValueError):
        l2.image_url(image, "ftp")


# --- live archive -----------------------------------------------------------------------------------------

LIVE = [  # Barnard's Star exposures on four detectors, two releases
    ("2025W33_2C_0321_1", 6, "l2b-v27-2026-228", "spherex_dr1"),
    ("2025W33_2C_0321_1", 3, "l2b-v27-2026-228", "spherex_dr1"),
    ("2026W34_1A_0007_1", 3, "l2b-v27-2026-243", "spherex_qr3"),
    ("2026W34_2A_0206_1", 2, "l2b-v27-2026-243", "spherex_qr3"),
]


def live_image(obs_id: str, det: int, tag: str, collection: str) -> DetectorImage:
    release = collection.split("_", 1)[1]
    week = obs_id.rsplit("_", 2)[0]
    key = f"{release}/level2/{week}/{tag}/{det}/level2_{obs_id}D{det}_spx_{tag}.fits"
    return DetectorImage(
        obs_id=obs_id, detector=det, collection=collection,
        publisher_did=f"ivo://irsa.ipac/{collection}?{obs_id}/D{det}",
        access_url=config.IRSA_IBE_SPHEREX_PREFIX + key, t_min_mjd=0.0, t_max_mjd=0.0,
        em_min_um=0.0, em_max_um=0.0, exptime_s=config.EXPTIME_S, s_region="", release_date="",
        file_tag=tag, s3_key=key,
    )


@pytest.fixture
def live(isolated) -> Iterator[None]:
    old = rangeio.set_client(None)  # a real client
    yield
    rangeio.set_client(old)


@pytest.mark.network
@pytest.mark.parametrize(("obs_id", "det", "tag", "collection"), LIVE)
def test_live_stamp_equals_irsa_cutout(live, obs_id: str, det: int, tag: str, collection: str) -> None:
    image = live_image(obs_id, det, tag, collection)
    ra, dec = BARNARD_STAMP_POS
    t0 = time.perf_counter()
    with rangeio.track() as lay_st:
        layout = l2.read_layout(image)
    t1 = time.perf_counter()
    with rangeio.track() as st:
        stamp = l2.read_stamp(image, ra, dec, half_size_px=10)
    t2 = time.perf_counter()
    print(f"{obs_id} D{det} ({collection}): layout {lay_st.requests} req {lay_st.bytes} B {t1 - t0:.2f} s; "
          f"stamp 21x21 x 4 planes {st.requests} req {st.bytes} B {t2 - t1:.2f} s "
          f"(retries {lay_st.retries + st.retries})")
    assert lay_st.requests - lay_st.retries == 2 and st.requests - st.retries == 2
    body = rangeio.http_get(image.access_url + f"?center={ra},{dec}&size=0.07")  # the oracle (4 MB)
    with fits.open(io.BytesIO(body)) as cut:
        ch = cut["IMAGE"].header
        cx0 = round(layout.image_header["CRPIX1"] - ch["CRPIX1"])
        cy0 = round(layout.image_header["CRPIX2"] - ch["CRPIX2"])
        assert (cx0, cy0) == (ch["CRVAL1A"] + 1 - ch["CRPIX1A"], ch["CRVAL2A"] + 1 - ch["CRPIX2A"])
        sy, sx = stamp.y0 - cy0, stamp.x0 - cx0
        assert sy >= 0 and sx >= 0
        for name, arr in (("IMAGE", stamp.data), ("VARIANCE", stamp.variance), ("ZODI", stamp.zodi),
                          ("FLAGS", stamp.flags)):
            ref = cut[name].data[sy : sy + 21, sx : sx + 21]
            assert ref.shape == arr.shape == (21, 21)
            assert np.array_equal(ref, arr, equal_nan=True), name
        assert stamp.flag_bits == flagmod.flag_bits(cut["FLAGS"].header)
    assert np.isfinite(stamp.wavelength_um).all()


@pytest.mark.network
@pytest.mark.parametrize(("det", "nzone"), [(6, 441), (3, 451)])
def test_live_epsf(live, det: int, nzone: int) -> None:
    image = live_image("2025W33_2C_0321_1", det, "l2b-v27-2026-228", "spherex_dr1")
    l2.read_layout(image)
    t0 = time.perf_counter()
    with rangeio.track() as st:
        grid = l2.read_epsf(image)
    print(f"D{det} ePSF: {len(grid.psfs)} zones, {st.requests} req {st.bytes} B {time.perf_counter() - t0:.2f} s")
    assert grid.psfs.shape == (nzone, 33, 33) and grid.oversampling == 5
    assert np.allclose(grid.psfs.sum(axis=(1, 2)), 1.0, atol=1e-6)
    assert 0 < grid.xcenter.min() < 100 and 1940 < grid.xcenter.max() < 2039
    lo, hi = config.DETECTOR_BANDS_UM[det]
    assert grid.cwave_um is not None and lo - 0.06 < grid.cwave_um.min() < grid.cwave_um.max() < hi + 0.06
    with rangeio.track() as st:
        l2.read_epsf(image)
    assert st.requests == 0


@pytest.mark.network
def test_live_s3_stamp_equals_ibe_stamp(live) -> None:
    image = live_image(*LIVE[0])
    ra, dec = BARNARD_STAMP_POS
    ibe = l2.read_stamp(image, ra, dec, half_size_px=10, use_cache=False)
    t0 = time.perf_counter()
    with rangeio.track() as st:
        s3 = l2.read_stamp(image, ra, dec, half_size_px=10, source="s3", use_cache=False)
    print(f"S3 stamp: {st.requests} req {st.bytes} B {time.perf_counter() - t0:.2f} s")
    for name in ("data", "variance", "zodi", "flags"):
        assert np.array_equal(getattr(ibe, name), getattr(s3, name), equal_nan=True)
