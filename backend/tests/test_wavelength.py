"""Tests for pxh.spherex.wavelength: WCS-WAVE lookups against two oracles, cutout offsets, remote reads.

Oracles:
- l2_barnard_wavelengths.csv: wavelength and bandwidth at Barnard's Star in 358 DR1/QR3 exposures (all six
  detectors), computed during research with an independent implementation (pixel positions are 1-based).
- astropy's FITS Paper III -TAB evaluation of the alternate WCS 'W' (after removing the celestial SIP keywords,
  which astropy would otherwise apply to the lookup axes too).
Fixtures: l2_wcswave_D{1..6}.bin (complete WCS-WAVE extensions, one per detector), the IMAGE header of
level2_2025W33_2C_0321_1D6 (l2_image_header_dr1_D6.txt) and of an IRSA cutout of that file
(l2_cutout_image_header_D6.txt, whose CRPIXjW keywords are shifted to the cutout origin).
"""

from __future__ import annotations

import csv
import io
import math
import time
import warnings
from collections.abc import Callable, Iterator
from pathlib import Path

import httpx
import numpy as np
import pytest
from astropy.io import fits
from astropy.wcs import WCS

from pxh import config
from pxh.models import DetectorImage
from pxh.spherex import l2, rangeio, wavelength
from pxh.spherex.wavelength import WaveLookup, WaveLookupError

FIXTURES = Path(__file__).parent / "fixtures"
GRIDS = {1: (9, 9), 2: (11, 11), 3: (9, 14), 4: (13, 20), 5: (11, 11), 6: (9, 9)}  # (len X, len Y)
CUTOUT_ORIGIN_D6 = (1606, 246)  # 0-based full-frame pixel of cutout pixel [0, 0] (from CRPIX and CRPIXjA)
# Gaia DR3 4472832130942575872 (Barnard's Star) at J2016.0; mas, mas/yr
BARNARD_GAIA = (269.44850252543, 4.73942005, -801.551, 10362.394)
GAIA_EPOCH_MJD = 57388.5


def _wave_bytes(det: int) -> bytes:
    return (FIXTURES / f"l2_wcswave_D{det}.bin").read_bytes()


def _header(name: str) -> fits.Header:
    return fits.Header.fromstring((FIXTURES / name).read_text(), sep="\n")


def _csv_rows() -> list[dict[str, str]]:
    with open(FIXTURES / "l2_barnard_wavelengths.csv", newline="") as f:
        return list(csv.DictReader(f))


@pytest.fixture(scope="module")
def d6_header() -> fits.Header:
    return _header("l2_image_header_dr1_D6.txt")


@pytest.fixture(scope="module")
def d6_lookup(d6_header: fits.Header) -> WaveLookup:
    return WaveLookup.from_hdu_bytes(_wave_bytes(6), d6_header)


# --- table parsing and the CSV oracle ---------------------------------------------------------------------


@pytest.mark.parametrize("det", sorted(GRIDS))
def test_tables_parse_for_every_detector(det: int) -> None:
    lk = WaveLookup.from_hdu_bytes(_wave_bytes(det))
    assert (lk.x_ctrl.size, lk.y_ctrl.size) == GRIDS[det]
    assert lk.wavelength.shape == lk.bandwidth.shape == (lk.y_ctrl.size, lk.x_ctrl.size)
    assert lk.x_ctrl[0] == lk.y_ctrl[0] == 1 and lk.x_ctrl[-1] == lk.y_ctrl[-1] == 2040
    assert lk.detector == det and lk.source == f"spectral_wcs_{det}_v{'3.0' if det in (5, 6) else '2.2'}.fits"
    lo, hi = config.DETECTOR_BANDS_UM[det]  # approximate (labels only): D4 reaches 3.863 um in a corner
    assert lo - 0.06 < lk.wavelength.min() < lk.wavelength.max() < hi + 0.06
    r = lk.wavelength / lk.bandwidth
    assert 0.7 * config.DETECTOR_R[det] < np.median(r) < 1.4 * config.DETECTOR_R[det]


def test_lookup_reproduces_barnard_wavelengths_for_358_exposures() -> None:
    rows = _csv_rows()
    assert len(rows) == 358
    worst = 0.0
    for det in GRIDS:
        lk = WaveLookup.from_hdu_bytes(_wave_bytes(det))
        sel = [r for r in rows if int(r["det"]) == det]
        x = np.array([float(r["x1"]) for r in sel]) - 1.0  # CSV pixels are 1-based
        y = np.array([float(r["y1"]) for r in sel]) - 1.0
        lam = np.array([float(r["lam_um"]) for r in sel])
        bw = np.array([float(r["bw_um"]) for r in sel])
        got_lam, got_bw = lk.at(x, y)
        worst = max(worst, float(np.max(np.abs(got_lam - lam) / bw)), float(np.max(np.abs(got_bw - bw) / bw)))
    assert worst < 5e-4  # << 1% of a bandwidth; the CSV is rounded to 1e-5 um


def test_lookup_matches_astropy_tab_without_sip(d6_header: fits.Header, d6_lookup: WaveLookup) -> None:
    table = l2.table_hdu_from_bytes(_wave_bytes(6))
    hdul = fits.HDUList([fits.PrimaryHDU(), fits.BinTableHDU(data=table.data, header=table.header)])
    rng = np.random.default_rng(0)
    xs = np.concatenate([rng.uniform(0, 2039, 300), [0, 0, 2039, 2039]])
    ys = np.concatenate([rng.uniform(0, 2039, 300), [0, 2039, 0, 2039]])
    ours_lam, ours_bw = d6_lookup.at(xs, ys)

    def astropy_w(header: fits.Header) -> tuple[np.ndarray, np.ndarray]:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            w = WCS(header, fobj=hdul, key="W")
        lam, bw = w.all_pix2world(xs, ys, 0)
        return lam, bw

    no_sip = d6_header.copy()
    for key in list(no_sip.keys()):
        if key.split("_")[0] in ("A", "B", "AP", "BP") and "_" in key:
            del no_sip[key]
    lam, bw = astropy_w(no_sip)
    assert np.max(np.abs(lam - ours_lam) / ours_bw) < 1e-9
    assert np.max(np.abs(bw - ours_bw) / ours_bw) < 1e-9
    lam_sip, _ = astropy_w(d6_header)  # the pitfall documented in the module docstring
    assert np.max(np.abs(lam_sip - ours_lam) / ours_bw) > 0.1


def test_cutout_header_offsets_are_honoured(d6_header: fits.Header, d6_lookup: WaveLookup) -> None:
    cut = _header("l2_cutout_image_header_D6.txt")
    assert (cut["CRPIX1W"], cut["CRPIX2W"]) == (-1605.0, -245.0)
    cx0, cy0 = CUTOUT_ORIGIN_D6
    assert (round(d6_header["CRPIX1"] - cut["CRPIX1"]), round(d6_header["CRPIX2"] - cut["CRPIX2"])) == (cx0, cy0)
    assert (cut["CRVAL1A"] + 1 - cut["CRPIX1A"], cut["CRVAL2A"] + 1 - cut["CRPIX2A"]) == (cx0, cy0)
    cut_lookup = WaveLookup.from_hdu_bytes(_wave_bytes(6), cut)
    i, j = np.meshgrid(np.arange(41.0), np.arange(41.0))
    lam_c, bw_c = cut_lookup.at(i, j)
    lam_f, bw_f = d6_lookup.at(i + cx0, j + cy0)
    assert np.allclose(lam_c, lam_f, rtol=0, atol=1e-12) and np.allclose(bw_c, bw_f, rtol=0, atol=1e-12)
    # the celestial WCS of the cutout agrees with the full frame at the same offset (alignment used in tests)
    full, sub = l2.celestial_wcs(d6_header), l2.celestial_wcs(cut)
    a = np.array(full.all_pix2world(i.ravel() + cx0, j.ravel() + cy0, 0))
    b = np.array(sub.all_pix2world(i.ravel(), j.ravel(), 0))
    assert np.max(np.abs(a - b)) * 3600 < 1e-3


# --- API behaviour ----------------------------------------------------------------------------------------


def test_at_is_vectorised_and_grid_matches(d6_lookup: WaveLookup) -> None:
    lam, bw = d6_lookup.at(1019.5, 1019.5)
    assert isinstance(lam, float) and isinstance(bw, float)
    xs = np.arange(5, 15, dtype=float)
    ys = np.arange(100, 107, dtype=float)
    lam2, bw2 = d6_lookup.at(xs[None, :], ys[:, None])
    assert lam2.shape == bw2.shape == (7, 10)
    glam, gbw = d6_lookup.grid(5, 100, 10, 7)
    assert np.array_equal(glam, lam2) and np.array_equal(gbw, bw2)
    assert d6_lookup.at(xs[3], ys[2]) == (lam2[2, 3], bw2[2, 3])


def test_control_points_are_reproduced_exactly(d6_lookup: WaveLookup) -> None:
    # at the control points (1-based raw coordinates) bilinear interpolation returns the table values
    jj, ii = np.meshgrid(np.arange(d6_lookup.y_ctrl.size), np.arange(d6_lookup.x_ctrl.size), indexing="ij")
    lam, bw = d6_lookup.at(d6_lookup.x_ctrl[ii] - 1.0, d6_lookup.y_ctrl[jj] - 1.0)
    assert np.allclose(lam, d6_lookup.wavelength, rtol=0, atol=1e-12)
    assert np.allclose(bw, d6_lookup.bandwidth, rtol=0, atol=1e-12)


def test_points_beyond_the_table_take_edge_values(d6_lookup: WaveLookup) -> None:
    assert d6_lookup.at(-0.5, 500.0) == d6_lookup.at(0.0, 500.0)
    assert d6_lookup.at(2039.5, 500.0) == d6_lookup.at(2039.0, 500.0)


def test_json_round_trip(d6_lookup: WaveLookup) -> None:
    back = WaveLookup.from_json(d6_lookup.to_json())
    assert back.source == d6_lookup.source and back.crpix == d6_lookup.crpix and back.detector == 6
    xs, ys = np.array([3.0, 1500.2]), np.array([2000.0, 17.5])
    assert np.array_equal(np.asarray(back.at(xs, ys)), np.asarray(d6_lookup.at(xs, ys)))


def test_malformed_tables_are_rejected() -> None:
    table = l2.table_hdu_from_bytes(_wave_bytes(6))
    row = {"X": table.data[0]["X"], "Y": table.data[0]["Y"][:5], "VALUES": table.data[0]["VALUES"]}
    with pytest.raises(WaveLookupError):
        WaveLookup.from_table(table.header, row)
    swapped = fits.Header({"PV1_3W": 2, "PV2_3W": 1})
    with pytest.raises(WaveLookupError):
        WaveLookup.from_table(table.header, table.data[0], swapped)
    rotated = fits.Header({"PC1_2W": 0.5})
    with pytest.raises(WaveLookupError):
        WaveLookup.from_table(table.header, table.data[0], rotated)


# --- remote reads (offline, against an in-memory file) ----------------------------------------------------

SYNTH_KEY = "dr1/level2/2025W33_2C/l2b-v27-2026-228/6/level2_2025W33_2C_0321_1D6_spx_l2b-v27-2026-228.fits"


def _minimal_file(image_header: fits.Header) -> bytes:
    """PRIMARY + IMAGE (real D6 header, tiny data) + the real WCS-WAVE extension as the last HDU."""
    buf = io.BytesIO()
    image = fits.ImageHDU(data=np.zeros((4, 4), dtype=np.float32), header=image_header.copy())
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        fits.HDUList([fits.PrimaryHDU(), image]).writeto(buf)
    return buf.getvalue() + _wave_bytes(6)


def _image(key: str = SYNTH_KEY) -> DetectorImage:
    return DetectorImage(
        obs_id="2025W33_2C_0321_1", detector=6, collection="spherex_dr1", publisher_did="",
        access_url=config.IRSA_IBE_SPHEREX_PREFIX + key, t_min_mjd=60902.8647, t_max_mjd=60902.8660,
        em_min_um=4.40, em_max_um=5.02, exptime_s=113.5826, s_region="", release_date="",
        file_tag="l2b-v27-2026-228", s3_key=key,
    )


@pytest.fixture
def isolated(monkeypatch: pytest.MonkeyPatch, tmp_path) -> Iterator[None]:
    monkeypatch.setattr(config, "CACHE_DIR", tmp_path / "cache")
    monkeypatch.setattr(rangeio, "RETRY_POLICY", rangeio.RetryPolicy(wait_initial_s=0, wait_max_s=0, jitter_s=0))
    l2.clear_memory_cache()
    yield
    l2.clear_memory_cache()


@pytest.fixture
def serve(isolated) -> Iterator[Callable[[dict[str, bytes]], rangeio.MockRangeServer]]:
    saved: list[httpx.Client | None] = []

    def _serve(files: dict[str, bytes]) -> rangeio.MockRangeServer:
        server = rangeio.MockRangeServer(files)
        saved.append(rangeio.set_client(server.client()))
        return server

    yield _serve
    if saved:
        rangeio.set_client(saved[0])


def test_read_wavelength_lookup_uses_one_request(serve, d6_header: fits.Header, d6_lookup: WaveLookup) -> None:
    image = _image()
    server = serve({image.access_url: _minimal_file(d6_header)})
    with rangeio.track() as st:
        lk = wavelength.read_wavelength_lookup(image)
    assert st.requests == 1
    assert server.range_headers == ["bytes=0-40959,-8640"]
    xs, ys = np.array([0.0, 1000.3, 2039.0]), np.array([5.0, 999.9, 2039.0])
    assert np.array_equal(np.asarray(lk.at(xs, ys)), np.asarray(d6_lookup.at(xs, ys)))
    with rangeio.track() as st:  # second read: header and tail come from the blob cache
        wavelength.read_wavelength_lookup(image)
    assert st.requests == 0 and st.cache_hits == 2


def test_wavelength_at_radec_uses_the_full_tan_sip_wcs(serve, d6_header: fits.Header) -> None:
    image = _image()
    serve({image.access_url: _minimal_file(d6_header)})
    row = next(r for r in _csv_rows() if r["obs_id"] == "2025W33_2C_0321_1" and r["det"] == "6")
    x1, y1 = float(row["x1"]) - 1.0, float(row["y1"]) - 1.0
    ra, dec = l2.celestial_wcs(d6_header).all_pix2world([[x1, y1]], 0)[0]
    lam, bw, x, y = wavelength.wavelength_at_radec(image, ra, dec)
    assert abs(x - x1) < 1e-6 and abs(y - y1) < 1e-6
    assert abs(lam - float(row["lam_um"])) < 5e-4 * bw and abs(bw - float(row["bw_um"])) < 5e-4 * bw


# --- live archive -----------------------------------------------------------------------------------------

LIVE = [  # (obs_id, detector, file tag, collection): Barnard's Star exposures on four detectors
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


def barnard_at(mjd: float) -> tuple[float, float]:
    """Barnard's Star at an epoch: linear Gaia DR3 proper motion (adequate to ~0.1 arcsec over 10 yr)."""
    ra0, dec0, pmra, pmdec = BARNARD_GAIA
    dt = (mjd - GAIA_EPOCH_MJD) / 365.25
    return ra0 + pmra * dt / 3.6e6 / math.cos(math.radians(dec0)), dec0 + pmdec * dt / 3.6e6


@pytest.fixture
def live(isolated) -> Iterator[None]:
    old = rangeio.set_client(None)
    yield
    rangeio.set_client(old)


@pytest.mark.network
@pytest.mark.parametrize(("obs_id", "det", "tag", "collection"), LIVE)
def test_live_wavelength_at_barnards_star(live, obs_id: str, det: int, tag: str, collection: str) -> None:
    image = live_image(obs_id, det, tag, collection)
    row = next(r for r in _csv_rows() if r["obs_id"] == obs_id and int(r["det"]) == det)
    t0 = time.perf_counter()
    with rangeio.track() as st:
        lk = wavelength.read_wavelength_lookup(image)
    print(f"{obs_id} D{det}: WCS-WAVE + IMAGE header in {st.requests} request(s) ({st.retries} retries), "
          f"{st.bytes} B, {time.perf_counter() - t0:.2f} s")
    assert st.requests - st.retries == 1
    lam_csv, bw_csv = float(row["lam_um"]), float(row["bw_um"])
    lam, bw = lk.at(float(row["x1"]) - 1.0, float(row["y1"]) - 1.0)
    assert abs(lam - lam_csv) < 5e-4 * bw_csv and abs(bw - bw_csv) < 5e-4 * bw_csv
    # end to end: star position at the exposure epoch -> TAN-SIP pixel -> lookup
    header, _ = l2.read_header_and_wave(image)
    ra, dec = barnard_at(float(header["MJD-AVG"]))
    lam2, bw2, x, y = wavelength.wavelength_at_radec(image, ra, dec)
    print(f"   star at pixel ({x:.3f}, {y:.3f}) vs CSV ({float(row['x1']) - 1:.2f}, {float(row['y1']) - 1:.2f}); "
          f"lambda {lam2:.5f} vs {lam_csv:.5f} um ({(lam2 - lam_csv) / bw_csv:+.1e} bandwidths)")
    assert abs(x - (float(row["x1"]) - 1.0)) < 0.2 and abs(y - (float(row["y1"]) - 1.0)) < 0.2
    assert abs(lam2 - lam_csv) < 0.01 * bw_csv and abs(bw2 - bw_csv) < 0.01 * bw_csv
