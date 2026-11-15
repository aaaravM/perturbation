"""Tests for pxh.photometry.forced.

Offline: synthetic stamps (TAN WCS, VARIANCE, FLAGS, wavelength maps) with an undersampled SPHEREx-like
PSF, plus one real saturated star (Barnard's Star, D6, 2025-08-15; a trimmed IRSA cutout saved as
tests/fixtures/phot_barnard_d6_2025W33_2C_0321_1.fits with the research measurements in PXH_* keys).
Network: one live IRSA cutout of an unsaturated star (eps Ind B) as an oracle for ePSF vs aperture.

``stamp_from_hdul`` / ``fetch_cutout`` build Stamps from IRSA cutouts; test_motion.py reuses them.
"""

from __future__ import annotations

import logging
import math
import time
import warnings
from pathlib import Path

import numpy as np
import pytest
from astropy.io import fits
from astropy.wcs import WCS
from scipy.interpolate import RegularGridInterpolator
from scipy.special import erf

from pxh import config
from pxh.models import DetectorImage, EPSFGrid, Stamp
from pxh.photometry.forced import (
    PhotometryError,
    forced_photometry,
    gaussian_epsf,
    measure_position,
    measure_source,
    motion_inputs,
    ramp_pixels,
    ujy_per_pixel,
)
from pxh.photometry.lightcurve import ab_mag

FIXTURE = Path(__file__).parent / "fixtures" / "phot_barnard_d6_2025W33_2C_0321_1.fits"
CUTOUT_CACHE = config.CACHE_DIR / "photometry" / "cutouts"

# --- synthetic data -------------------------------------------------------------------------------

BITS = {"TRANSIENT": 0, "OVERFLOW": 1, "SUR_ERROR": 2, "NONFUNC": 6, "HOT": 10, "SOURCE": 21, "BLOOM": 26}
MASK_BITS = sum(1 << BITS[n] for n in ("TRANSIENT", "SUR_ERROR", "NONFUNC", "HOT", "BLOOM"))
SAT_BITS = 1 << BITS["OVERFLOW"]
OMEGA_ARCSEC2 = 37.94
UJY_PER_UNIT = 1e12 * OMEGA_ARCSEC2 * (math.pi / 648000.0) ** 2
COMPONENTS = ((0.85, 0.53), (0.15, 1.1))  # same SPHEREx-like PSF as test_centroid.py
SHAPE = (25, 25)
X0, Y0 = 1000, 500


def _pix_gauss(off: np.ndarray, sigma: float) -> np.ndarray:
    s2 = sigma * math.sqrt(2.0)
    return 0.5 * (erf((off + 0.5) / s2) - erf((off - 0.5) / s2))


def true_psf(dx: np.ndarray, dy: np.ndarray) -> np.ndarray:
    return sum(w * _pix_gauss(dx, s) * _pix_gauss(dy, s) for w, s in COMPONENTS)


def synthetic_epsf_grid() -> EPSFGrid:
    off = (np.arange(33) - 16) / 5.0
    dx, dy = np.meshgrid(off, off)
    tab = true_psf(dx, dy)
    tab /= tab.sum()
    xc, yc = np.meshgrid([48.0, 1000.0, 1990.0], [48.0, 512.0, 1990.0])
    psfs = np.repeat(tab[None], xc.size, axis=0)
    psfs[[0, 2, 6, 8]] = gaussian_epsf(3.0)  # wrong PSFs far away: the nearest zone must be used
    return EPSFGrid(xcenter=xc.ravel(), ycenter=yc.ravel(), psfs=psfs, oversampling=5)


def epsf_fwhm_px(tab: np.ndarray, oversampling: int = 5) -> float:
    row = tab[tab.shape[0] // 2]
    fine = np.interp(np.linspace(0, row.size - 1, 20001), np.arange(row.size), row)
    above = np.where(fine >= fine.max() / 2)[0]
    return (above[-1] - above[0]) * (row.size - 1) / 20000 / oversampling


def make_wcs(ra0: float, dec0: float, rot_deg: float = 30.0) -> WCS:
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.crval = [ra0, dec0]
    w.wcs.crpix = [SHAPE[1] / 2 + 0.5, SHAPE[0] / 2 + 0.5]  # FITS 1-based centre of the stamp
    s = config.PIXEL_SCALE_ARCSEC / 3600.0
    c, n = math.cos(math.radians(rot_deg)), math.sin(math.radians(rot_deg))
    w.wcs.cd = np.array([[-s * c, s * n], [s * n, s * c]])
    return w


def make_image(detector: int = 6) -> DetectorImage:
    return DetectorImage(
        obs_id="2026W01_1A_0001_1", detector=detector, collection="spherex_test",
        publisher_did="ivo://irsa.ipac/spherex_test?2026W01_1A_0001_1/D6",
        access_url="https://irsa.invalid/level2_2026W01_1A_0001_1D6_spx_l2b-test.fits",
        t_min_mjd=61000.0, t_max_mjd=61000.0013, em_min_um=4.41, em_max_um=5.01, exptime_s=113.58,
        s_region="", release_date="2026-01-01", file_tag="l2b-test",
    )


def wavelength_maps(shape: tuple[int, int] = SHAPE) -> tuple[np.ndarray, np.ndarray]:
    yy, xx = np.mgrid[0 : shape[0], 0 : shape[1]]
    wl = 4.6 + 0.0007 * (yy + Y0 - 500) + 0.00002 * (xx + X0)
    return wl, wl / 128.0


def _flag(*names: str) -> int:
    return sum(1 << BITS[n] for n in names)


def omega_header(omega_arcsec2: float) -> fits.Header:
    """Header with OMEGA_MEDIAN stored as in real files (a HIERARCH card: the name has > 8 characters)."""
    hdr = fits.Header()
    hdr["HIERARCH OMEGA_MEDIAN"] = omega_arcsec2
    return hdr


def make_stamp(
    flux_ujy: float,
    snr: float | None = 300.0,
    offset: tuple[float, float] = (0.3, -0.2),
    bkg: float = 0.8,
    seed: int = 0,
    saturate: str | None = None,
    variance: bool = True,
    header: dict | None = None,
) -> tuple[Stamp, float, float, float, float]:
    """Stamp with one star; returns (stamp, ra, dec, x_true, y_true) with x, y 0-based in the stamp.

    ``saturate`` flags the 3x3 core like a saturated SPHEREx star (peak pixel OVERFLOW|BLOOM, one early
    transient TRANSIENT|SUR_ERROR, the rest TRANSIENT|BLOOM) and sets the noise for S/N 100 on the
    unflagged pixels within 3.5 px. Core values: 'ramp' valid early-ramp slopes with 1% errors (what
    SPHEREx records), 'nan' lost, 'clipped' finite garbage (0.2 x the peak).
    """
    rng = np.random.default_rng(seed)
    wcs = make_wcs(150.0, 20.0)
    xt, yt = 12.0 + offset[0], 12.0 + offset[1]
    ra, dec = (float(v) for v in wcs.pixel_to_world_values(xt, yt))
    yy, xx = np.mgrid[0 : SHAPE[0], 0 : SHAPE[1]]
    f_img = flux_ujy / UJY_PER_UNIT
    g = true_psf(xx - xt, yy - yt)
    sig = 0.0 if snr is None else f_img * math.sqrt(float(np.sum(g**2))) / snr
    flags = np.zeros(SHAPE, np.int32)
    flags[np.hypot(xx - xt, yy - yt) < 5] |= 1 << BITS["SOURCE"]  # SOURCE is informational: never masked
    core = (np.abs(xx - round(xt)) <= 1) & (np.abs(yy - round(yt)) <= 1)
    if saturate:
        if saturate not in ("ramp", "nan", "clipped"):
            raise ValueError(saturate)
        sig = f_img * math.sqrt(float(np.sum(g[~core & (np.hypot(xx - xt, yy - yt) <= 3.5)] ** 2))) / 100.0
    var = np.full(SHAPE, max(sig, 1e-3) ** 2)
    if saturate:
        var[core] += (0.01 * f_img * g[core]) ** 2  # slopes from the early reads only: 1% errors
        flags[core] |= _flag("TRANSIENT", "BLOOM")
        peak = np.unravel_index(np.argmax(np.where(core, g, -1.0)), SHAPE)
        flags[peak] = (flags[peak] & ~_flag("TRANSIENT")) | _flag("OVERFLOW")
        flags[round(yt), round(xt) - 1] = (flags[round(yt), round(xt) - 1] & ~_flag("BLOOM")) | _flag("SUR_ERROR")
    data = bkg + f_img * g + (rng.normal(0.0, 1.0, SHAPE) * np.sqrt(var) if sig > 0 else 0.0)
    if saturate == "nan":
        data[core] = np.nan
    elif saturate == "clipped":
        data[core] = np.minimum(data[core], 0.2 * f_img * g.max())
    hdr = omega_header(OMEGA_ARCSEC2)
    hdr["PSF_FWHM"] = 1.4 * config.PIXEL_SCALE_ARCSEC
    for k, v in (header or {}).items():
        if v is None:
            del hdr[k]
        else:
            hdr[k] = v
    wl, bw = wavelength_maps()
    stamp = Stamp(
        image=make_image(), x0=X0, y0=Y0, data=data.astype(np.float32),
        variance=var.astype(np.float32) if variance else None, zodi=np.full(SHAPE, bkg),
        flags=flags, wcs=wcs, header=hdr, mjd_avg=61000.0007, wavelength_um=wl, bandwidth_um=bw,
        flag_bits=dict(BITS),
    )
    return stamp, ra, dec, xt, yt


EPSF_GRID = synthetic_epsf_grid()


# --- helpers for real cutouts (also used by test_motion.py) ----------------------------------------


def flag_bits_from_header(header: fits.Header) -> dict[str, int]:
    return {str(header[k]).strip(): int(k[4:]) for k in header if k.startswith("MSKN")}


def group_mask(flag_bits: dict[str, int], groups: tuple[str, ...]) -> int:
    mask = 0
    for name, bit in flag_bits.items():
        if any(name.startswith(g) for g in groups):
            mask |= 1 << bit
    return mask


def default_masks(flag_bits: dict[str, int]) -> tuple[int, int]:
    """(mask_bits, saturation_bits) from the config flag groups."""
    mask = group_mask(flag_bits, config.FLAGS_INVALID + config.FLAGS_ARTIFACT)
    if "SATELLITE_HALO" not in flag_bits:
        mask |= 1 << config.SATELLITE_HALO_FALLBACK_BIT
    return mask, group_mask(flag_bits, config.FLAGS_SATURATION)


def stamp_from_hdul(hdul: fits.HDUList, collection: str = "spherex_dr1", access_url: str = "") -> tuple[Stamp, EPSFGrid]:
    """Stamp + EPSFGrid from an IRSA Level-2 cutout (HDUs IMAGE, FLAGS, VARIANCE, ZODI, EPSF, WCS-WAVE)."""
    h = hdul["IMAGE"].header
    x0, y0 = round(1 - h.get("CRPIX1A", 1)), round(1 - h.get("CRPIX2A", 1))
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        wcs = WCS(h).celestial
    data = np.asarray(hdul["IMAGE"].data, dtype=np.float32)
    ny, nx = data.shape
    fb = flag_bits_from_header(hdul["FLAGS"].header)
    wl = bw = None
    if "WCS-WAVE" in hdul:
        row = hdul["WCS-WAVE"].data[0]
        gx, gy, vals = np.asarray(row["X"], float), np.asarray(row["Y"], float), np.asarray(row["VALUES"], float)
        jj, ii = np.mgrid[0:ny, 0:nx]
        rx = h.get("CRVAL1W", 1) + (ii + 1 - h.get("CRPIX1W", 1)) * h.get("CDELT1W", 1)
        ry = h.get("CRVAL2W", 1) + (jj + 1 - h.get("CRPIX2W", 1)) * h.get("CDELT2W", 1)
        pts = np.column_stack([ry.ravel(), rx.ravel()])
        maps = [RegularGridInterpolator((gy, gx), vals[..., k], bounds_error=False, fill_value=None)(pts) for k in (0, 1)]
        wl, bw = (m.reshape(ny, nx) for m in maps)
    ep = hdul["EPSF"]
    grid = EPSFGrid(
        xcenter=np.asarray(ep.data["XCENTER"], float), ycenter=np.asarray(ep.data["YCENTER"], float),
        psfs=np.asarray(ep.data["EPSF"], float), oversampling=int(ep.header.get("OVSMPX", 5)),
        cwave_um=np.asarray(ep.data["CWAVE"], float),
    )
    det = int(h["DETECTOR"])
    lo, hi = config.DETECTOR_BANDS_UM[det]
    image = DetectorImage(
        obs_id=str(h["OBSID"]), detector=det, collection=collection,
        publisher_did=f"ivo://irsa.ipac/{collection}?{h['OBSID']}/D{det}", access_url=access_url,
        t_min_mjd=float(h["MJD-BEG"]), t_max_mjd=float(h["MJD-END"]), em_min_um=lo, em_max_um=hi,
        exptime_s=float(h.get("XPOSURE", config.EXPTIME_S)), s_region="", release_date="", file_tag="",
    )
    stamp = Stamp(
        image=image, x0=x0, y0=y0, data=data, variance=np.asarray(hdul["VARIANCE"].data, np.float32),
        zodi=np.asarray(hdul["ZODI"].data, np.float32) if "ZODI" in hdul else None,
        flags=np.asarray(hdul["FLAGS"].data, np.int32), wcs=wcs, header=h, mjd_avg=float(h["MJD-AVG"]),
        wavelength_um=wl, bandwidth_um=bw, flag_bits=fb,
    )
    return stamp, grid


def fetch_cutout(access_url: str, ra: float, dec: float, size_deg: float = 0.05) -> Path:
    """IRSA cutout (test oracle only; >= 4 MB each), cached under CACHE_DIR/photometry/cutouts."""
    import httpx

    CUTOUT_CACHE.mkdir(parents=True, exist_ok=True)
    stem = access_url.rsplit("/", 1)[-1].removesuffix(".fits")
    path = CUTOUT_CACHE / f"{stem}_{ra:.4f}_{dec:+.4f}_{size_deg:.3f}.fits"
    if path.exists() and path.stat().st_size > 0:
        return path
    params = {"center": f"{ra:.6f},{dec:.6f}", "size": f"{size_deg}"}
    last: Exception | None = None
    for attempt in range(5):
        try:
            with httpx.Client(timeout=config.HTTP_TIMEOUT_S, headers={"User-Agent": config.USER_AGENT}) as client:
                r = client.get(access_url, params=params, follow_redirects=True)
                r.raise_for_status()
            if not r.content.startswith(b"SIMPLE"):
                raise ValueError(f"not a FITS file: {r.content[:80]!r}")
            tmp = path.with_suffix(".part")
            tmp.write_bytes(r.content)
            tmp.replace(path)
            return path
        except (httpx.HTTPError, ValueError) as exc:
            last = exc
            time.sleep(2.0 * 2**attempt)
    raise RuntimeError(f"cutout failed for {access_url}: {last}")


def load_fixture() -> tuple[Stamp, EPSFGrid, fits.Header]:
    with fits.open(FIXTURE) as hdul:
        stamp, grid = stamp_from_hdul(hdul)
        return stamp, grid, hdul["IMAGE"].header.copy()


# --- units and basics -----------------------------------------------------------------------------


def test_unit_conversion_from_omega_median(caplog: pytest.LogCaptureFixture) -> None:
    hdr = omega_header(37.94)
    assert ujy_per_pixel(hdr) == pytest.approx(1e12 * 37.94 * (math.pi / 648000) ** 2)
    assert ujy_per_pixel(hdr) == pytest.approx(891.7, abs=0.1)
    with caplog.at_level(logging.WARNING):
        nominal = ujy_per_pixel(fits.Header())
    assert nominal == pytest.approx(1e12 * 6.15**2 * (math.pi / 648000) ** 2)
    assert "OMEGA_MEDIAN" in caplog.text


def test_gaussian_epsf_table() -> None:
    tab = gaussian_epsf(1.47)
    assert tab.shape == (33, 33) and tab.sum() == pytest.approx(1.0)
    assert epsf_fwhm_px(tab) == pytest.approx(1.47, abs=0.08)
    with pytest.raises(ValueError):
        gaussian_epsf(0.0)


# --- ePSF photometry ------------------------------------------------------------------------------


def test_forced_epsf_unsaturated_point() -> None:
    flux = 10_000.0  # 10 mJy, AB 13.9
    stamp, ra, dec, xt, yt = make_stamp(flux, snr=300.0, seed=1)
    yy, xx = np.mgrid[0 : SHAPE[0], 0 : SHAPE[1]]
    hot_in = (round(yt) + 1, round(xt) - 1)  # inside r=2: masked, but its bit is reported
    stamp.flags[hot_in] |= 1 << BITS["HOT"]
    stamp.data[hot_in] = 1e4
    far = (round(yt) - 6, round(xt) + 6)
    stamp.flags[far] |= 1 << BITS["NONFUNC"]
    p = forced_photometry(stamp, ra, dec, EPSF_GRID, MASK_BITS, SAT_BITS, epoch_index=3)
    assert p.method == "epsf" and not p.saturated
    assert p.flux_ujy == pytest.approx(flux, rel=0.015)
    assert p.flux_ujy / p.flux_err_ujy == pytest.approx(300.0, rel=0.3)
    assert p.x == pytest.approx(xt + X0, abs=2e-3) and p.y == pytest.approx(yt + Y0, abs=2e-3)
    exact = 4.6 + 0.0007 * (yt + Y0 - 500) + 0.00002 * (xt + X0)  # wavelength_maps() at the star
    assert p.wavelength_um == pytest.approx(exact, abs=1e-6)
    assert p.bandwidth_um == pytest.approx(exact / 128.0, abs=1e-6)
    assert p.flags & (1 << BITS["HOT"]) and p.flags & (1 << BITS["SOURCE"])
    assert not p.flags & (1 << BITS["NONFUNC"])
    assert (p.obs_id, p.detector, p.collection, p.epoch_index) == ("2026W01_1A_0001_1", 6, "spherex_test", 3)
    assert p.mjd == pytest.approx(61000.0007)
    assert np.hypot(xx - xt, yy - yt).shape == SHAPE


def test_ramp_pixel_selection() -> None:
    """Only pixels whose masked flags all mean "ramp cut short" qualify (SPHEREx Table 16 semantics)."""
    t, o, s, b, h, src = (_flag(n) for n in ("TRANSIENT", "OVERFLOW", "SUR_ERROR", "BLOOM", "HOT", "SOURCE"))
    flags = np.array([[0, t, o | b, t | s, t | b, o | s, t | h, s, b, src, o]], dtype=np.int32)
    ones = np.ones(flags.shape)
    got = ramp_pixels(flags, ones, ones, MASK_BITS, SAT_BITS, BITS)
    # early overflow (o|s), hard flags (HOT), SUR_ERROR or BLOOM alone, and unflagged pixels are excluded
    assert got.tolist() == [[False, True, True, True, True, False, False, False, False, False, True]]
    data, var = ones.copy(), ones.copy()
    data[0, 1], var[0, 2], var[0, 3] = np.nan, 0.0, np.nan
    assert not ramp_pixels(flags, data, var, MASK_BITS, SAT_BITS, BITS)[0, 1:4].any()
    no_names = ramp_pixels(flags, ones, ones, MASK_BITS, SAT_BITS, {})  # only saturation_bits are known
    assert no_names.tolist() == [[False] * 10 + [True]]
    assert not ramp_pixels(None, ones, ones, MASK_BITS, SAT_BITS, BITS).any()
    assert not ramp_pixels(flags, ones, None, MASK_BITS, SAT_BITS, BITS).any()


def test_saturated_core_uses_early_ramp_slopes() -> None:
    """SPHEREx keeps valid early-ramp slopes in OVERFLOW / TRANSIENT pixels: the whole star is fitted."""
    flux = 3.0e6  # 3 Jy: saturated core
    stamp, ra, dec, xt, yt = make_stamp(flux, saturate="ramp", seed=2)
    res = measure_source(stamp, ra, dec, EPSF_GRID, MASK_BITS, SAT_BITS, fit_position=True)
    p = res.point
    assert p.method == "epsf" and p.saturated
    assert res.n_masked_core == 9 and res.n_ramp_pixels == 9
    assert p.flux_ujy == pytest.approx(flux, rel=0.02)
    assert abs(p.x - (xt + X0)) < 0.05 and abs(p.y - (yt + Y0)) < 0.05
    assert p.flags & SAT_BITS and p.flags & _flag("BLOOM")
    forced = forced_photometry(stamp, ra, dec, EPSF_GRID, MASK_BITS, SAT_BITS)
    assert forced.method == "epsf" and forced.flux_ujy == pytest.approx(flux, rel=0.02)
    ap = measure_source(stamp, ra, dec, EPSF_GRID, MASK_BITS, SAT_BITS, method="aperture")
    assert ap.point.flux_ujy == pytest.approx(flux, rel=0.03) and ap.aperture_correction < 1.2


def test_lost_core_falls_back_to_wing_fit() -> None:
    """Saturated core without usable values (NaN): a wing fit, background held at the annulus value."""
    flux = 3.0e6
    stamp, ra, dec, xt, yt = make_stamp(flux, saturate="nan", seed=2)
    res = measure_source(stamp, ra, dec, EPSF_GRID, MASK_BITS, SAT_BITS, fit_position=True)
    p = res.point
    assert p.method == "wing-fit" and p.saturated and res.n_ramp_pixels == 0
    assert p.flux_ujy == pytest.approx(flux, rel=0.05)
    assert abs(p.x - (xt + X0)) < 0.15 and abs(p.y - (yt + Y0)) < 0.15
    forced = forced_photometry(stamp, ra, dec, EPSF_GRID, MASK_BITS, SAT_BITS)
    assert forced.method == "wing-fit" and forced.flux_ujy == pytest.approx(flux, rel=0.05)


def test_wings_policy_ignores_core_values() -> None:
    flux = 3.0e6
    stamp, ra, dec, _, _ = make_stamp(flux, saturate="clipped", seed=3)
    p = forced_photometry(stamp, ra, dec, EPSF_GRID, MASK_BITS, SAT_BITS, saturated_core="wings")
    assert p.method == "wing-fit" and p.saturated
    assert p.flux_ujy == pytest.approx(flux, rel=0.05)
    with pytest.raises(ValueError):
        forced_photometry(stamp, ra, dec, EPSF_GRID, MASK_BITS, SAT_BITS, saturated_core="core")


def test_early_overflow_and_hard_flags_are_not_rescued() -> None:
    flux = 3.0e6
    stamp, ra, dec, xt, yt = make_stamp(flux, saturate="ramp", seed=5)
    iy, ix = round(yt), round(xt)
    stamp.flags[iy - 1, ix - 1] = _flag("OVERFLOW", "SUR_ERROR")  # early overflow: <= 3 reads
    stamp.data[iy - 1, ix - 1] = 0.0
    stamp.flags[iy + 1, ix + 1] |= _flag("HOT")
    stamp.data[iy + 1, ix + 1] = 1e5
    res = measure_source(stamp, ra, dec, EPSF_GRID, MASK_BITS, SAT_BITS, fit_position=True)
    assert res.n_ramp_pixels == 7
    assert res.point.method == "epsf"  # the peak 2x2 block is intact
    assert res.point.flux_ujy == pytest.approx(flux, rel=0.02)


def test_saturation_bits_alone_define_saturation() -> None:
    stamp, ra, dec, _, _ = make_stamp(3.0e6, saturate="ramp", seed=4)
    p = forced_photometry(stamp, ra, dec, EPSF_GRID, 0, SAT_BITS)
    assert p.saturated and p.method == "epsf"
    assert p.flux_ujy == pytest.approx(3.0e6, rel=0.02)
    lost, ra, dec, _, _ = make_stamp(3.0e6, saturate="nan", seed=4)
    q = forced_photometry(lost, ra, dec, EPSF_GRID, 0, SAT_BITS)
    assert q.saturated and q.method == "wing-fit"
    assert q.flux_ujy == pytest.approx(3.0e6, rel=0.05)


# --- aperture photometry --------------------------------------------------------------------------


def test_aperture_correction_from_epsf_noiseless() -> None:
    flux = 20_000.0
    stamp, ra, dec, _, _ = make_stamp(flux, snr=None, seed=0)
    res = measure_source(stamp, ra, dec, EPSF_GRID, MASK_BITS, SAT_BITS, method="aperture")
    assert res.point.method == "aperture"
    assert res.point.flux_ujy == pytest.approx(flux, rel=0.005)
    assert 1.0 < res.aperture_correction < 1.2


def test_aperture_photometry_within_3_percent() -> None:
    flux = 20_000.0
    for seed in range(5):
        stamp, ra, dec, _, _ = make_stamp(flux, snr=300.0, seed=seed)
        p = forced_photometry(stamp, ra, dec, EPSF_GRID, MASK_BITS, SAT_BITS, method="aperture")
        assert p.flux_ujy == pytest.approx(flux, rel=0.03)
        assert p.flux_err_ujy > 0


def test_aperture_correction_fills_masked_pixels() -> None:
    flux = 20_000.0
    stamp, ra, dec, xt, yt = make_stamp(flux, snr=None)
    stamp.flags[round(yt), round(xt) + 1] |= 1 << BITS["HOT"]
    stamp.data[round(yt), round(xt) + 1] = 1e5
    p = forced_photometry(stamp, ra, dec, EPSF_GRID, MASK_BITS, SAT_BITS, method="aperture")
    assert p.flux_ujy == pytest.approx(flux, rel=0.01)


def test_aperture_without_epsf_uses_header_fwhm() -> None:
    flux = 20_000.0
    stamp, ra, dec, _, _ = make_stamp(flux, snr=None, header={"PSF_FWHM": 1.4 * config.PIXEL_SCALE_ARCSEC})
    res = measure_source(stamp, ra, dec, None, MASK_BITS, SAT_BITS)  # auto -> aperture
    assert res.point.method == "aperture"
    assert res.point.flux_ujy == pytest.approx(flux, rel=0.06)  # Gaussian approximation of the PSF
    bare, ra, dec, _, _ = make_stamp(flux, snr=None, header={"PSF_FWHM": None})
    raw = measure_source(bare, ra, dec, None, MASK_BITS, SAT_BITS)
    assert raw.aperture_correction == 1.0
    assert 0.8 * flux < raw.point.flux_ujy < flux  # uncorrected: encircled energy within 2 px


def test_no_variance_errors_from_background_scatter() -> None:
    flux = 20_000.0
    stamp, ra, dec, _, _ = make_stamp(flux, snr=100.0, variance=False, seed=9)
    p = forced_photometry(stamp, ra, dec, EPSF_GRID, MASK_BITS, SAT_BITS, method="aperture")
    q = forced_photometry(stamp, ra, dec, EPSF_GRID, MASK_BITS, SAT_BITS, method="epsf")
    assert p.flux_ujy == pytest.approx(flux, rel=0.06) and q.flux_ujy == pytest.approx(flux, rel=0.05)
    assert 0.002 * flux < p.flux_err_ujy < 0.05 * flux and 0.002 * flux < q.flux_err_ujy < 0.05 * flux


# --- positions ------------------------------------------------------------------------------------


def test_fit_position_recovers_true_position_and_sky_errors() -> None:
    stamp, ra, dec, xt, yt = make_stamp(10_000.0, snr=200.0, seed=5)
    ra_off, dec_off = (float(v) for v in stamp.wcs.pixel_to_world_values(xt + 0.6, yt - 0.4))
    forced = forced_photometry(stamp, ra_off, dec_off, EPSF_GRID, MASK_BITS, SAT_BITS)
    assert forced.x == pytest.approx(xt + 0.6 + X0, abs=1e-3)  # forced: stays at the requested position
    res = measure_position(stamp, ra_off, dec_off, EPSF_GRID, MASK_BITS, SAT_BITS)
    assert res.position_fitted
    assert res.point.x == pytest.approx(xt + X0, abs=0.05) and res.point.y == pytest.approx(yt + Y0, abs=0.05)
    assert res.ra_deg == pytest.approx(ra, abs=0.05 * 6.15 / 3600) and res.dec_deg == pytest.approx(dec, abs=0.05 * 6.15 / 3600)
    pix_mas = config.PIXEL_SCALE_ARCSEC * 1000.0
    assert math.hypot(res.ra_err_mas, res.dec_err_mas) == pytest.approx(math.hypot(res.x_err, res.y_err) * pix_mas, rel=0.1)
    inputs = motion_inputs([res, forced_result_without_position(stamp, ra, dec)])
    assert inputs["mjd"].size == 1 and set(inputs) == {"mjd", "ra_deg", "dec_deg", "ra_err_mas", "dec_err_mas"}


def forced_result_without_position(stamp: Stamp, ra: float, dec: float):
    return measure_source(stamp, ra, dec, EPSF_GRID, MASK_BITS, SAT_BITS)


def test_aperture_fit_position_without_epsf_uses_centroid() -> None:
    stamp, _, _, xt, yt = make_stamp(10_000.0, snr=300.0, seed=6)
    ra_off, dec_off = (float(v) for v in stamp.wcs.pixel_to_world_values(xt + 0.5, yt + 0.3))
    res = measure_position(stamp, ra_off, dec_off, None, MASK_BITS, SAT_BITS)
    assert res.point.method == "aperture" and res.position_fitted
    assert abs(res.point.x - (xt + X0)) < 0.12 and abs(res.point.y - (yt + Y0)) < 0.12
    assert 0 < res.x_err < 0.05


# --- background and errors ------------------------------------------------------------------------


def test_background_annulus_and_fallbacks() -> None:
    stamp, ra, dec, _, _ = make_stamp(10_000.0, snr=300.0, bkg=1.7, seed=7)
    res = measure_source(stamp, ra, dec, EPSF_GRID, MASK_BITS, SAT_BITS)
    assert res.background_source == "annulus" and res.background == pytest.approx(1.7, abs=0.01)
    yy, xx = np.mgrid[0 : SHAPE[0], 0 : SHAPE[1]]
    r = np.hypot(xx - 12, yy - 12)
    stamp.flags[(r >= 3.5) & (r <= 7.5)] |= 1 << BITS["NONFUNC"]  # annulus unusable
    res2 = measure_source(stamp, ra, dec, EPSF_GRID, MASK_BITS, SAT_BITS)
    assert res2.background_source == "stamp" and res2.background == pytest.approx(1.7, abs=0.01)
    stamp.flags[:, :] |= 1 << BITS["NONFUNC"]  # every pixel bad except a 5x5 core region, no ZODI
    stamp.flags[10:15, 10:15] = 0
    stamp.zodi = None
    with pytest.raises(PhotometryError):
        measure_source(stamp, ra, dec, EPSF_GRID, MASK_BITS, SAT_BITS)


def test_zodi_fallback_and_errors() -> None:
    stamp, ra, dec, _, _ = make_stamp(10_000.0, snr=300.0, bkg=1.2, seed=8)
    yy, xx = np.mgrid[0 : SHAPE[0], 0 : SHAPE[1]]
    stamp.flags[np.hypot(xx - 12, yy - 12) > 3.2] |= 1 << BITS["NONFUNC"]
    res = measure_source(stamp, ra, dec, EPSF_GRID, MASK_BITS, SAT_BITS)
    assert res.background_source == "zodi" and res.background == pytest.approx(1.2)
    assert res.point.flux_ujy == pytest.approx(10_000.0, rel=0.03)


def test_invalid_requests_raise() -> None:
    stamp, ra, dec, _, _ = make_stamp(10_000.0)
    far_ra, far_dec = (float(v) for v in stamp.wcs.pixel_to_world_values(40.0, 12.0))
    with pytest.raises(PhotometryError):
        forced_photometry(stamp, far_ra, far_dec, EPSF_GRID, MASK_BITS, SAT_BITS)
    with pytest.raises(ValueError):
        forced_photometry(stamp, ra, dec, EPSF_GRID, MASK_BITS, SAT_BITS, method="psf")
    with pytest.raises(ValueError):
        forced_photometry(stamp, ra, dec, None, MASK_BITS, SAT_BITS, method="epsf")


def test_faint_source_forced_flux_can_be_negative() -> None:
    stamp, ra, dec, _, _ = make_stamp(10.0, snr=0.2, seed=10)  # S/N 0.2: essentially noise
    p = forced_photometry(stamp, ra, dec, EPSF_GRID, MASK_BITS, SAT_BITS)
    assert p.method == "epsf" and math.isfinite(p.flux_ujy) and p.flux_err_ujy > 0
    assert abs(p.flux_ujy - 10.0) < 5 * p.flux_err_ujy


# --- real data: Barnard's Star, D6, saturated core -------------------------------------------------


def test_real_barnard_d6_saturated_core() -> None:
    """Real SPHEREx pixels and ePSF of a saturated star (OVERFLOW / BLOOM / TRANSIENT core).

    The 12 flagged pixels hold 93% of the light. Measured with their early-ramp slopes, the ePSF fit
    and the ePSF-corrected aperture agree, and match the research r=3 px sum (3.64 Jy, saturated pixels
    included; AB 7.3-7.5 in 8 D6 exposures) and the ~3-4 Jy expected from 2MASS K / AllWISE W3. Wing-only
    estimates are biased high by undetected spill-over into the unflagged pixels next to the core: the
    wing fit by ~25%, the wing-based aperture correction (x21) by 51%.
    """
    stamp, grid, hdr = load_fixture()
    mask_bits, sat_bits = default_masks(stamp.flag_bits)
    assert sat_bits == 1 << stamp.flag_bits["OVERFLOW"]
    ra, dec = hdr["PXH_PRA"], hdr["PXH_PDEC"]
    res = measure_position(stamp, ra, dec, grid, mask_bits, sat_bits)
    p = res.point
    assert p.method == "epsf" and p.saturated and res.n_masked_core >= 5 and res.n_ramp_pixels >= 8
    # research windowed centroid and Gaia-predicted position agree with the fit
    assert math.hypot(p.x - hdr["PXH_CENX"], p.y - hdr["PXH_CENY"]) < 0.3
    pred = forced_photometry(stamp, ra, dec, grid, mask_bits, sat_bits)
    assert math.hypot(p.x - pred.x, p.y - pred.y) < 0.3
    assert pred.flux_ujy == pytest.approx(p.flux_ujy, rel=0.05)
    assert p.wavelength_um == pytest.approx(hdr["PXH_WAVE"], abs=0.003)
    assert p.bandwidth_um == pytest.approx(hdr["PXH_BW"], rel=0.05)
    # ePSF-fit flux vs aperture flux with the ePSF correction over the used pixels
    ap = measure_source(stamp, ra, dec, grid, mask_bits, sat_bits, method="aperture", aperture_radius_px=3.0)
    assert ap.point.flux_ujy == pytest.approx(p.flux_ujy, rel=0.10)
    assert ap.aperture_correction < 1.1
    # research r=3 px aperture (no correction, saturated pixels included): within 15% of the total flux
    assert p.flux_ujy == pytest.approx(hdr["PXH_F3JY"] * 1e6, rel=0.15)
    assert 6.9 < float(ab_mag(p.flux_ujy)) < 7.7
    assert res.ra_err_mas < 300 and res.dec_err_mas < 300
    # the wing fit stays available (and is the fallback), but is biased high here
    wing = measure_position(stamp, ra, dec, grid, mask_bits, sat_bits, saturated_core="wings")
    assert wing.point.method == "wing-fit" and 1.0 < wing.point.flux_ujy / p.flux_ujy < 1.5


# --- live: one unsaturated star, ePSF vs aperture ---------------------------------------------------

EPS_IND_B_D5 = (
    "https://irsa.ipac.caltech.edu/ibe/data/spherex/dr1/level2/2025W40_1A/l2b-v27-2026-239/5/"
    "level2_2025W40_1A_0661_1D5_spx_l2b-v27-2026-239.fits"
)


@pytest.mark.network
def test_live_cutout_epsf_matches_aperture() -> None:
    """eps Ind B (AB ~12, clean) in one live IRSA cutout: ePSF and corrected aperture fluxes agree."""
    path = fetch_cutout(EPS_IND_B_D5, 331.0997, -56.8023, 0.05)
    with fits.open(path) as hdul:
        stamp, grid = stamp_from_hdul(hdul, access_url=EPS_IND_B_D5)
    mask_bits, sat_bits = default_masks(stamp.flag_bits)
    peak = np.unravel_index(np.nanargmax(np.where(np.isfinite(stamp.data), stamp.data, -np.inf)[8:-8, 8:-8]), (stamp.data.shape[0] - 16, stamp.data.shape[1] - 16))
    ra, dec = (float(v) for v in stamp.wcs.pixel_to_world_values(peak[1] + 8, peak[0] + 8))
    res = measure_position(stamp, ra, dec, grid, mask_bits, sat_bits)
    ap = measure_source(stamp, res.ra_deg, res.dec_deg, grid, mask_bits, sat_bits, method="aperture")
    assert res.point.method == "epsf" and not res.point.saturated
    assert res.snr > 50
    assert ap.point.flux_ujy == pytest.approx(res.point.flux_ujy, rel=0.05)
    assert 11.0 < float(ab_mag(res.point.flux_ujy)) < 13.5
    assert res.chi2_red < 10
