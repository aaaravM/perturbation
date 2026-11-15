"""Tests for pxh.spherex.cube: DR1 cube tiles (HiPS order 5), spectral axis, aperture photometry, tile lookup.

Fixtures from the DR1 cube tile Npix7945 (hips_20261026), which contains Barnard's Star: its PRIMARY, IMAGE and
FLAGS headers (cube_*_header_7945.txt) and its last 11520 bytes (cube_tail_7945.bin: the SPECTRAL_CHANNELS
and WCS-WAVE extensions). Offline tests build a 64 x 64 x 102 synthetic tile with those headers (ORDER set to
8 so that the HEALPix pixel solid angle stays that of a 512-pixel order-5 tile) and inject known fluxes.
"""

from __future__ import annotations

import io
import json
import math
import time
import warnings
from collections.abc import Callable, Iterator
from pathlib import Path

import httpx
import numpy as np
import pytest
from astropy.io import fits

from pxh import config
from pxh.spherex import cube, l2, rangeio

FIXTURES = Path(__file__).parent / "fixtures"
TAIL = (FIXTURES / "cube_tail_7945.bin").read_bytes()
PREFIX = config.IRSA_IBE_SPHEREX_PREFIX + "dr1/hips5_cube/hips_20261026/Norder5/"
TILE_URL = PREFIX + "Dir0/Npix7945_cube.fits"
BARNARD = (269.4462, 4.7690)
# HiPS properties of IRSA's spherex_allsky_cube (data_cube_crval3_arr, um), saved 2026-11-14
HIPS_CRVAL3 = (
    "0.753 0.771 0.790 0.809 0.828 0.848 0.868 0.889 0.910 0.932 0.955 0.978 1.001 1.025 1.050 1.075 1.102 "
    "1.113 1.139 1.167 1.195 1.224 1.254 1.284 1.315 1.346 1.378 1.412 1.446 1.481 1.517 1.554 1.592 1.631 "
    "1.656 1.695 1.735 1.775 1.818 1.861 1.905 1.949 1.995 2.041 2.089 2.139 2.189 2.240 2.292 2.345 2.399 "
    "2.445 2.506 2.575 2.646 2.719 2.794 2.871 2.951 3.033 3.118 3.204 3.293 3.383 3.476 3.570 3.667 3.768 "
    "3.833 3.867 3.901 3.935 3.970 4.005 4.040 4.076 4.112 4.148 4.184 4.220 4.257 4.294 4.331 4.368 4.405 "
    "4.435 4.467 4.500 4.533 4.566 4.600 4.635 4.669 4.704 4.739 4.773 4.808 4.843 4.879 4.915 4.951 4.988"
)
N = 64
SRC = (30, 41)  # (x, y) of the injected point source in the synthetic tile


def _header(name: str) -> fits.Header:
    return fits.Header.fromstring((FIXTURES / name).read_text(), sep="\n")


def _tail_tables() -> dict[str, fits.FITS_rec]:
    out = {}
    for off in range(0, len(TAIL), l2.BLOCK):
        if TAIL[off : off + 8] == b"XTENSION":
            h = l2.parse_header(TAIL[off:])
            n = l2.find_header_end(TAIL[off:]) + l2.data_size(h)
            out[str(h["EXTNAME"]).strip()] = l2.table_hdu_from_bytes(TAIL[off : off + n]).data
    return out


PIXEL_SR = cube.healpix_pixel_sr(5, 512)
TO_UJY = PIXEL_SR * 1e12  # uJy per (MJy/sr) of one cube pixel


def build_tile(noise: float = 0.0, seed: int = 0) -> tuple[bytes, dict[str, np.ndarray]]:
    rng = np.random.default_rng(seed)
    background = 0.2 + 0.003 * np.arange(102)
    flux = 5000.0 + 100.0 * np.arange(102)  # uJy
    img = np.repeat(background[:, None, None], N, axis=1).repeat(N, axis=2)
    img = img + rng.normal(0.0, noise, img.shape) if noise else img
    img[:, SRC[1], SRC[0]] += flux / TO_UJY
    img = img.astype(np.float32)
    img[50:52] = np.nan  # BLANKCH D3:17, D4:01
    img[10, SRC[1], SRC[0]] = np.nan  # a masked core (as for saturated stars)
    img[70] = np.nan  # a plane without data
    nhits = np.where(np.isfinite(img), 5, 0).astype(np.int32)
    flg = np.where(np.isfinite(img), 0, 1 << 26).astype(np.int32)
    flg[:, SRC[1], SRC[0]] |= 1 << 21
    image_header = _header("cube_image_header_7945.txt")
    image_header["ORDER"] = 8  # 2**8 * 64 = 2**5 * 512: same pixel solid angle as the real tile
    hdus = [
        fits.PrimaryHDU(header=_header("cube_primary_header_7945.txt")),
        fits.ImageHDU(img, header=image_header),
        fits.ImageHDU(nhits, name="NHITS"),
        fits.ImageHDU(flg, header=_header("cube_flags_header_7945.txt")),
    ]
    buf = io.BytesIO()
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        fits.HDUList(hdus).writeto(buf)
    return buf.getvalue() + TAIL, {"flux": flux, "image": img, "nhits": nhits, "flags": flg}


def sia_votable(urls: list[str]) -> bytes:
    rows = "".join(f"<TR><TD>{u}</TD><TD>spherex_dr1_cube</TD></TR>" for u in urls)
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<VOTABLE version="1.4" xmlns="http://www.ivoa.net/xml/VOTable/v1.3"><RESOURCE type="results">'
        '<INFO name="QUERY_STATUS" value="OK"/><TABLE>'
        '<FIELD name="access_url" datatype="char" arraysize="*"/>'
        '<FIELD name="obs_collection" datatype="char" arraysize="*"/>'
        f"<DATA><TABLEDATA>{rows}</TABLEDATA></DATA></TABLE></RESOURCE></VOTABLE>"
    ).encode()


@pytest.fixture(scope="module")
def tile() -> tuple[bytes, dict[str, np.ndarray]]:
    return build_tile()


@pytest.fixture
def isolated(monkeypatch: pytest.MonkeyPatch, tmp_path) -> Iterator[None]:
    monkeypatch.setattr(config, "CACHE_DIR", tmp_path / "cache")
    monkeypatch.setattr(rangeio, "RETRY_POLICY", rangeio.RetryPolicy(wait_initial_s=0, wait_max_s=0, jitter_s=0))
    cube.clear_memory_cache()
    yield
    cube.clear_memory_cache()


@pytest.fixture
def serve(isolated) -> Iterator[Callable[..., rangeio.MockRangeServer]]:
    saved: list[httpx.Client | None] = []

    def _serve(files: dict[str, bytes], **kw) -> rangeio.MockRangeServer:
        server = rangeio.MockRangeServer(files, **kw)
        saved.append(rangeio.set_client(server.client()))
        return server

    yield _serve
    if saved:
        rangeio.set_client(saved[0])


def _synthetic_radec(x: float, y: float) -> tuple[float, float]:
    h = cube.celestial_header(_header("cube_image_header_7945.txt"))
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        from astropy.wcs import WCS

        ra, dec = WCS(h).all_pix2world([[x, y]], 0)[0]
    return float(ra), float(dec)


# --- metadata and spectral axis ---------------------------------------------------------------------------


def test_spectral_axis_comes_from_the_wcs_wave_table(serve, tile) -> None:
    serve({TILE_URL: tile[0]})
    with rangeio.track() as st:
        meta = cube.read_cube_meta(TILE_URL)
    assert st.requests == 2
    tables = _tail_tables()
    wl = np.asarray(meta.wavelength_um)
    assert meta.shape == (102, N, N) and wl.shape == (102,)
    wave_row = tables["WCS-WAVE"][0]  # -TAB coordinate array: WAVELENGTHS has TDIM (1, 102)
    assert np.asarray(wave_row["WAVELENGTHS"]).shape == (102, 1)
    assert np.array_equal(wl, np.asarray(wave_row["WAVELENGTHS"], dtype=float).ravel())
    assert np.array_equal(meta.bandwidth_um, np.asarray(wave_row["BANDWIDTHS"], dtype=float).ravel())
    assert np.array_equal(np.asarray(wave_row["PLANE"]).ravel(), np.arange(1, 103))
    assert np.allclose(wl, np.asarray(tables["SPECTRAL_CHANNELS"]["WAVELENGTH"], dtype=float), atol=1e-6)
    assert np.all(np.diff(wl) > 0) and wl[0] == pytest.approx(0.753) and wl[-1] == pytest.approx(4.988)
    assert np.array_equal(np.round(wl, 3), np.array(HIPS_CRVAL3.split(), dtype=float))
    planes = np.arange(102)
    assert np.array_equal(meta.detector, planes // 17 + 1) and np.array_equal(meta.channel, planes % 17 + 1)
    assert meta.blank_planes == [50, 51]
    assert meta.flag_bits()["SATELLITE_HALO"] == 29
    assert meta.data_start["IMAGE"] == 8640  # PRIMARY (1 block) + IMAGE header (2 blocks), as in the real tile


def test_meta_is_cached(serve, tile) -> None:
    serve({TILE_URL: tile[0]})
    first = cube.read_cube_meta(TILE_URL)
    with rangeio.track() as st:
        assert cube.read_cube_meta(TILE_URL) is first
    cube.clear_memory_cache()
    with rangeio.track() as st2:
        again = cube.read_cube_meta(TILE_URL)
    assert st.requests == st2.requests == 0
    assert again.to_json() == first.to_json()


def test_blank_channel_keyword() -> None:
    assert cube.parse_blank_channels("D3:17,D4:01") == [50, 51]
    assert cube.parse_blank_channels("") == [] and cube.parse_blank_channels("D1:01") == [0]


def test_pixel_solid_angle_is_a_healpix_cell() -> None:
    assert PIXEL_SR == pytest.approx(4 * math.pi / (12 * 16384**2), rel=1e-15)
    assert PIXEL_SR * (180 / math.pi * 3600) ** 2 == pytest.approx(165.97, abs=0.01)
    assert math.degrees(math.sqrt(PIXEL_SR)) * 3600 == pytest.approx(12.88, abs=0.01)  # "12.9 arcsec pixels"
    # the HPX projection (H=4, K=3) maps the sphere to 3 pi / 8 times its area: same cell area from the WCS
    h = _header("cube_image_header_7945.txt")
    det = abs(h["PC1_1"] * h["PC2_2"] - h["PC1_2"] * h["PC2_1"]) * h["CDELT1"] * h["CDELT2"]
    assert det / (3 * math.pi / 8) * (math.pi / 180) ** 2 == pytest.approx(PIXEL_SR, rel=1e-12)


def test_barnards_star_tile_and_pixel() -> None:
    assert cube.healpix_tile(*BARNARD) == 7945
    h = cube.celestial_header(_header("cube_image_header_7945.txt"))
    assert "CTYPE3" not in h and h["NAXIS"] == 2 and "PS3_0" not in h
    from astropy.wcs import WCS

    x, y = WCS(h).all_world2pix([list(BARNARD)], 0)[0]
    # pure-Python HPX equatorial-zone projection (as in the research prototype) gives the same pixel
    phi, theta = ((BARNARD[0] + 180) % 360) - 180, 67.5 * math.sin(math.radians(BARNARD[1]))
    a, b, c, d = h["PC1_1"], h["PC1_2"], h["PC2_1"], h["PC2_2"]
    det = a * d - b * c
    px = h["CRPIX1"] - 1 + (d * phi - b * theta) / det
    py = h["CRPIX2"] - 1 + (-c * phi + a * theta) / det
    assert (x, y) == pytest.approx((px, py), abs=1e-9)
    assert (x, y) == pytest.approx((97.924, 102.708), abs=1e-3)


def test_tile_url_helpers() -> None:
    assert cube.tile_url_from_prefix(PREFIX, 7945) == TILE_URL
    assert cube.tile_url_from_prefix(PREFIX, 12345).endswith("Norder5/Dir10000/Npix12345_cube.fits")
    t = cube.parse_tile_url(TILE_URL + "?foo=1")
    assert t == cube.CubeTile(TILE_URL, 5, 7945)
    assert cube.parse_tile_url("https://example.org/x.fits") is None


# --- photometry -------------------------------------------------------------------------------------------


def test_cube_spectrum_recovers_injected_fluxes(serve, tile) -> None:
    blob, truth = tile
    server = serve({TILE_URL: blob, config.IRSA_SIA_URL: sia_votable([TILE_URL])})
    ra, dec = _synthetic_radec(*SRC)
    sp = cube.cube_spectrum(ra, dec)
    assert sp["label"] == cube.CUBE_LABEL == "DR1 quick-look (Year 1, 12.9 arcsec pixels)"
    assert sp["tile_url"] == TILE_URL and (sp["x"], sp["y"]) == pytest.approx(SRC, abs=1e-6)
    flux, err, q = sp["flux_ujy"], sp["flux_err_ujy"], sp["quality"]
    assert flux.shape == err.shape == q.shape == sp["wavelength_um"].shape == (102,)
    ok = np.ones(102, dtype=bool)
    ok[[10, 50, 51, 70]] = False
    assert np.allclose(flux[ok], truth["flux"][ok], rtol=1e-5)  # float32 storage
    assert np.all(err[ok] >= 0) and np.all(np.isfinite(err[ok]))
    assert list(q[[10, 50, 51, 70]]) == ["masked", "blank", "blank", "no-data"] and set(q[ok]) == {"ok"}
    assert np.isnan(flux[[10, 50, 51, 70]]).all()
    assert sp["lower_limit"].tolist() == [k == 10 for k in range(102)]
    assert sp["flux_partial_ujy"][10] == pytest.approx(0.0, abs=1.0)  # the masked pixel held the source
    assert sp["n_finite"] == 98 and sp["n_lower_limit"] == 1
    assert np.array_equal(sp["nhits"], truth["nhits"][:, SRC[1], SRC[0]])
    assert np.array_equal(sp["flags"], truth["flags"][:, SRC[1], SRC[0]])
    assert sp["edge"] is False and sp["pixel_sr"] == PIXEL_SR
    # 1 SIA query + 2 metadata reads + ceil((13 rows x 102 planes + 2 x 102 pixels) / 100) pixel requests
    assert sp["requests"] == 1 + 2 + math.ceil((13 * 102 + 204) / 100)
    assert sum(1 for h in server.range_headers if h is None) == 1  # the SIA query


def test_background_noise_is_reflected_in_the_errors(serve) -> None:
    blob, truth = build_tile(noise=0.002, seed=5)
    serve({TILE_URL: blob, config.IRSA_SIA_URL: sia_votable([TILE_URL])})
    sp = cube.cube_spectrum(*_synthetic_radec(*SRC))
    ok = np.isfinite(sp["flux_ujy"])
    assert ok.sum() == 98
    z = (sp["flux_ujy"][ok] - truth["flux"][ok]) / sp["flux_err_ujy"][ok]
    assert np.all(np.abs(z) < 5) and 0.3 < np.std(z) < 2.0
    expected = 0.002 * math.sqrt(math.pi * 1.5**2) * TO_UJY  # sigma * sqrt(aperture area), roughly
    assert np.median(sp["flux_err_ujy"][ok]) == pytest.approx(expected, rel=0.3)


def test_apertures_at_the_tile_edge(serve, tile) -> None:
    serve({TILE_URL: tile[0], config.IRSA_SIA_URL: sia_votable([TILE_URL])})
    near = cube.cube_spectrum(*_synthetic_radec(1.0, 20.0))  # box clipped, aperture complete
    assert near["edge"] is True and near["n_finite"] == 99  # all but the blank and no-data planes
    assert np.allclose(near["flux_ujy"][np.isfinite(near["flux_ujy"])], 0.0, atol=1e-3)  # background only
    at = cube.cube_spectrum(*_synthetic_radec(0.0, 20.0))  # aperture crosses the tile edge
    assert at["n_finite"] == 0 and "edge" in set(at["quality"])


def test_aperture_photometry_unit() -> None:
    box = np.full((2, 13, 13), 1.0, dtype=np.float32)
    box[:, 6, 6] += 3.0
    box[1, 6, 7] = np.nan
    res = cube.aperture_photometry(box, 6.0, 6.0, 1.5, 3.0, 5.0, pixel_sr=1e-12)  # 1 MJy/sr*px = 1 uJy
    assert res["flux_ujy"][0] == pytest.approx(3.0) and res["flux_err_ujy"][0] == 0.0
    assert np.isnan(res["flux_ujy"][1]) and 0 < res["masked_fraction"][1] < 1
    assert res["flux_partial_ujy"][1] == pytest.approx(3.0)
    assert res["aperture_area_px"][0] == pytest.approx(math.pi * 1.5**2)
    assert res["background_mjysr"][0] == 1.0 and res["annulus_npix"][0] > 40
    with pytest.raises(ValueError):
        cube.cube_spectrum(0.0, 0.0, aperture_radius_px=3.0, annulus_px=(3.0, 5.0))


# --- tile lookup ------------------------------------------------------------------------------------------


def test_find_cube_tile_caches_the_release_path(serve, tile) -> None:
    other = PREFIX + "Dir0/Npix4010_cube.fits"
    server = serve({TILE_URL: tile[0], config.IRSA_SIA_URL: sia_votable([other, TILE_URL])})
    t = cube.find_cube_tile(*BARNARD)
    assert t == cube.CubeTile(TILE_URL, 5, 7945)  # the SIA row that matches the HEALPix tile
    doc = json.loads((Path(config.CACHE_DIR) / "pixels" / "cube" / "spherex_dr1_cube_tile_prefix.json").read_text())
    assert doc["prefix"] == PREFIX and doc["order"] == 5 and doc["fetched_at"] > time.time() - 60
    n = len(server.range_headers)
    t2 = cube.find_cube_tile(10.0, 10.0)  # another tile: derived from the cached release path, no SIA
    assert len(server.range_headers) == n
    npix = cube.healpix_tile(10.0, 10.0)
    assert t2 == cube.CubeTile(cube.tile_url_from_prefix(PREFIX, npix), 5, npix)


def test_find_cube_tile_falls_back_to_a_stale_release_path(serve) -> None:
    server = serve({}, fail_next=10_000)  # SIA down
    path = Path(config.CACHE_DIR) / "pixels" / "cube" / "spherex_dr1_cube_tile_prefix.json"
    with pytest.raises(cube.CubeError):
        cube.find_cube_tile(*BARNARD)
    assert len(server.range_headers) == config.RETRY_ATTEMPTS
    rangeio.write_atomic(path, json.dumps({"prefix": PREFIX, "order": 5, "fetched_at": 0.0}).encode())
    assert cube.find_cube_tile(*BARNARD).url == TILE_URL  # stale, but better than nothing
    with pytest.raises(cube.CubeError):
        cube.find_cube_tile(*BARNARD, refresh=True)


def test_find_cube_tile_trusts_sia_when_healpix_disagrees(serve) -> None:
    other = PREFIX + "Dir0/Npix4010_cube.fits"
    serve({config.IRSA_SIA_URL: sia_votable([other])})
    assert cube.find_cube_tile(*BARNARD).npix == 4010
    assert not (Path(config.CACHE_DIR) / "pixels" / "cube" / "spherex_dr1_cube_tile_prefix.json").exists()


# --- live archive -----------------------------------------------------------------------------------------


@pytest.fixture
def live(isolated) -> Iterator[None]:
    old = rangeio.set_client(None)
    yield
    rangeio.set_client(old)


@pytest.mark.network
def test_live_cube_spectrum_at_barnards_star(live) -> None:
    t0 = time.perf_counter()
    sp = cube.cube_spectrum(*BARNARD)
    print(f"Barnard's Star cube spectrum: {time.perf_counter() - t0:.2f} s, {sp['requests']} requests, "
          f"{sp['bytes']} B; complete {sp['n_finite']}, lower limits {sp['n_lower_limit']}")
    assert sp["tile_npix"] == 7945 and sp["tile_url"].endswith("/Norder5/Dir0/Npix7945_cube.fits")
    wl = sp["wavelength_um"]
    assert wl.shape == (102,) and np.all(np.diff(wl) > 0)
    assert np.array_equal(np.round(wl, 3), np.array(HIPS_CRVAL3.split(), dtype=float))
    assert np.isfinite(sp["bandwidth_um"]).all()
    assert sp["blank_planes"] == [50, 51] and np.isnan(sp["flux_ujy"][[50, 51]]).all()
    best = np.where(np.isfinite(sp["flux_ujy"]), sp["flux_ujy"], sp["flux_partial_ujy"])
    # 100 finite channels; the saturated core is blank in most planes, which then hold lower limits only
    assert int(np.isfinite(best).sum()) == 100
    assert sp["n_finite"] + sp["n_lower_limit"] == 100
    assert np.all(best[np.isfinite(best)] > 0)
    t0 = time.perf_counter()
    field = cube.cube_spectrum(BARNARD[0] + 0.05, BARNARD[1] + 0.05)  # unsaturated field 4 arcmin away
    print(f"offset field: {time.perf_counter() - t0:.2f} s, {field['requests']} requests, {field['bytes']} B; "
          f"complete {field['n_finite']}")
    assert field["n_finite"] == 100 and field["n_lower_limit"] == 0
