"""Page bundle for "Pluto, the original Planet X": blinks, spectrum, shift-and-stack and every measured number.

Run from backend/ after pluto_scan_s3.py (or pluto_find.py) and pluto_measure.py:
    uv run python ../scripts/pluto_products.py
With --geometry-only it recomputes only the Planet X geometry (pluto_planetx_facts.py) in the existing pluto.json.

Every image is a byte-range stamp reprojected onto a north-up TAN grid of SPHEREx's 6.15 arcsec pixels
(pxh.imaging.align: zodi subtracted, the file's science mask and OVERFLOW masked) and rendered as the Lab
renders frames (pxh.imaging.render.to_png: asinh stretch, one pair of limits from the 0.5 and 99.7 percentiles
shared by all frames of a product, masked pixels transparent). As in pluto_measure.py, the pipeline's OUTLIER
flag is cleared within UNFLAG_PX of Pluto's predicted position, where it marks Pluto itself.

Products (frontend/public/planet-x/), with selection rules fixed here before looking at the images:
- tracked blink: frames centred on Pluto's predicted position, so Pluto stays put and the stars stream past.
  Short-wavelength detectors (D1-D3), clean frames with S/N >= GOOD_SNR, the best frame of each observation;
  the (detector, visit) in which Pluto moved furthest; up to N_TRACKED frames evenly spaced in time.
- sky-fixed blink: one fixed patch of sky, so Pluto moves past fixed stars: from the same kind of frames, the
  pair with the largest shift up to SKY_MAX_SHIFT_ARCSEC (at least SKY_MIN_SHIFT_ARCSEC), and the frame nearest
  the middle of the path.
- spectrum: every clean measurement, and inverse-variance means in N_BINS logarithmic wavelength bins (errors
  scaled up by sqrt(reduced chi-square) where the points scatter more than their errors).
- shift-and-stack: a run of clean frames of one detector in one visit whose Pluto path is STACK_MIN_TRAIL_ARCSEC
  to STACK_MAX_TRAIL_ARCSEC long (long enough for Pluto's positions to separate in the star-aligned stack): the
  run with the most observations (any detector), and a faint case, the run with the most frames in the
  longest-wavelength detectors (D5 and D6, 3.8-5.0 um), where Pluto is faint; the same frames co-added on the stars (Pluto spreads
  into a row of faint dots) and on Pluto's predicted motion (Pluto adds up into one point), with Pluto's S/N in
  each single frame and in the stack from one aperture estimator, noise measured in each image.

Writes frontend/public/planet-x/pluto.json and the PNGs in frontend/public/planet-x/stamps/.
"""

from __future__ import annotations

import argparse
import itertools
import json
import logging
import math
import subprocess
import sys
import warnings
from collections import Counter, defaultdict
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import numpy as np
from pluto_common import BUNDLE, EXPOSURES_JSON, MEASURE_JSON, jsonable, load_json
from pluto_measure import UNFLAG_PX, stamp_xy, unflag_pluto
from scipy import ndimage

from pxh.imaging import align, render
from pxh.imaging import coadd as coadd_mod
from pxh.models import DetectorImage, Stamp
from pxh.spherex import flags as fl
from pxh.spherex import l2

log = logging.getLogger("pluto_products")

FOV_BLINK_ARCMIN = 4.0
GOOD_SNR = 20.0  # frames for the blinks
N_TRACKED = 6
MIN_TRACKED = 4
MIN_VALID_FRACTION = 0.85  # blink frames: at most 15% of the frame masked (typical frames: 4-13%) ...
MAX_GRADIENT = 1.0  # ... and quadrant background medians within this many pixel-noise sigmas of each other
SKY_MIN_SHIFT_ARCSEC = 40.0
SKY_MAX_SHIFT_ARCSEC = 100.0  # Pluto stays inside the 4-arcmin frame
STACK_MIN_N = 8
STACK_MIN_TRAIL_ARCSEC = 60.0  # about 8 PSF widths
STACK_MAX_TRAIL_ARCSEC = 300.0
STACK_MARGIN_ARCMIN = 3.0  # the stack frame is the trail plus this, and at least STACK_MIN_FOV_ARCMIN
STACK_MIN_FOV_ARCMIN = 6.0
APER_PX = 2.0  # aperture radius for the stack S/N (12.3 arcsec)
ANNULUS_PX = (4.0, 7.0)
N_RANDOM_APER = 200
N_BINS = 30
DIFF_MIN_SIGMA = 5.0  # as the Lab's difference frames (pxh.api.field.DIFF_MIN_LIMIT_SIGMA)
SOLAR_TEFF_K = 5772.0  # IAU 2015 nominal solar effective temperature (Resolution B3)
SCRIPT_DIR = Path(__file__).resolve().parent
AB_ZP_UJY = 23.9
WISE_VEGA_TO_AB = {"W1": 2.699, "W2": 3.339}  # WISE All-Sky Explanatory Supplement, section IV.4.h, Table 3

# Published numbers quoted on the page, each with its source (checked 2026-11-14/15).
PUBLISHED = {
    "tombaugh": {"plates": ["1930-01-23", "1930-01-29"], "found_on_blink_comparator": "1930-02-18",
                 "announced": "1930-03-13", "source": "Lowell Observatory archives; Tombaugh 1946, ASP Leaflet 209"},
    "spherex_depth_ab": {
        "single_visit": {"0.75-3.8 um": [18.5, 19.0], "3.8-5.0 um": [16.6, 18.0], "exposure_s": 112.5,
                         "source": "Crill et al. 2025, ApJS 281, 10"},
        "four_surveys": {"0.75-3.8 um": [19.5, 19.9], "3.8-5.0 um": [17.8, 18.8],
                         "source": "Bock et al. 2026, ApJ 999, 139"},
    },
    "planet_nine": {
        "brown_batygin_2016_v": [22.0, 25.0],
        "brown_holman_batygin_2024": ("with the ZTF, DES and Pan-STARRS searches, 78% of the predicted parameter "
                                      "space is ruled out; much of the rest is at V > 21"),
        "brown_batygin_2022_ztf_ruled_out_fraction": 0.56,
        "linder_mordasini_2016": {"case": "10 Earth masses at 700 au", "V": 21.7, "L_vega": 20.1, "W1_vega": 20.1,
                                  "W2_vega": 20.1, "W1_ab": 20.1 + WISE_VEGA_TO_AB["W1"],
                                  "W2_ab": 20.1 + WISE_VEGA_TO_AB["W2"], "teff_k": 47.0,
                                  "source": "Linder & Mordasini 2016, A&A 589, A134 (arXiv:1602.07465)"},
    },
    "wise_0855": {"proper_motion_arcsec_per_yr": 8.1, "distance_pc": 2.2, "temperature_k": [225, 260],
                  "found_by": "its motion in multi-epoch WISE astrometry", "source": "Luhman 2014, ApJL 786, L18"},
    "pluto_system": {"rotation_period_days": 6.3872, "charon_distance_km": 19596,
                     "source": "NASA NSSDCA Pluto fact sheet"},
}
REFERENCES = [
    "Bock, J. J., et al. 2026, ApJ, 999, 139. doi:10.3847/1538-4357/ae2be2",
    "Brown, M. E. & Batygin, K. 2016, ApJL, 824, L23. doi:10.3847/2041-8205/824/2/L23",
    "Brown, M. E., Holman, M. J. & Batygin, K. 2024, AJ, 167, 146. doi:10.3847/1538-3881/ad24e9",
    "Crill, B. P., et al. 2025, ApJS, 281, 10. doi:10.3847/1538-4365/ae04cc",
    "Cruikshank, D. P., Pilcher, C. B. & Morrison, D. 1976, Science, 194, 835. doi:10.1126/science.194.4267.835",
    "Grundy, W. M., Schmitt, B. & Quirico, E. 2002, Icarus, 155, 486. doi:10.1006/icar.2001.6726",
    "Linder, E. F. & Mordasini, C. 2016, A&A, 589, A134. arXiv:1602.07465",
    "Luhman, K. L. 2014, ApJL, 786, L18. doi:10.1088/2041-8205/786/2/L18",
    "Olkin, C. B., et al. 2007, AJ, 133, 420. doi:10.1086/509616",
    "Protopapa, S., et al. 2017, Icarus, 287, 218. doi:10.1016/j.icarus.2016.11.028",
    "Tombaugh, C. W. 1946, Astronomical Society of the Pacific Leaflet No. 209",
    "WISE All-Sky Data Release Explanatory Supplement, section IV.4.h (Vega to AB offsets)",
    "NASA NSSDCA Pluto fact sheet; JPL Horizons (target 999, ephemeris plu060)",
]


def date_utc(mjd: float) -> str:
    return datetime.fromtimestamp((mjd - 40587.0) * 86400.0, tz=UTC).strftime("%Y-%m-%d %H:%M")


def image_of(rec: dict[str, Any], found: dict[tuple[str, int], dict]) -> DetectorImage:
    return DetectorImage(**found[(rec["obs_id"], rec["detector"])]["image"])


def clean(rec: dict[str, Any]) -> bool:
    """A usable Pluto measurement: measured inside the stamp, unsaturated, no masked core pixel, no known blend."""
    st = rec.get("static") or {}
    return bool(
        rec.get("status") == "ok" and rec.get("inside") and rec.get("flux_ujy") is not None
        and rec.get("flux_err_ujy") and not rec.get("saturated") and not st.get("blended", False)
        and (rec.get("n_masked_core") or 0) == 0
    )


def stamp_for(image: DetectorImage, ra: float, dec: float, fov_arcmin: float) -> Stamp:
    _, (n, _) = align.make_grid(ra, dec, fov_arcmin)
    layout = l2.read_layout(image)
    m = l2.celestial_wcs(layout.image_header).pixel_scale_matrix
    theta = math.atan2(m[0, 1], m[1, 1])
    half = math.ceil((n - 1) / 2.0 * (abs(math.cos(theta)) + abs(math.sin(theta)))) + 2
    return l2.read_stamp(image, ra, dec, half_size_px=half)


def on_grid(stamp: Stamp, grid: tuple[Any, tuple[int, int]], pluto: tuple[float, float]) -> tuple[np.ndarray, np.ndarray]:
    """Reproject onto the grid like the Lab, after clearing OUTLIER on Pluto at its predicted (ra, dec)."""
    x, y = stamp_xy(stamp, *pluto)
    st, _ = unflag_pluto(stamp, x, y)
    mask, sat = fl.science_mask(st.flag_bits), fl.saturation_mask(st.flag_bits)
    data, weight, _ = align.reproject_stamp(st, grid[0], grid[1], mask, True, sat)
    return data, weight


def write_png(name: str, arr: np.ndarray, vmin: float, vmax: float, stretch: str = "asinh") -> str:
    path = BUNDLE / "stamps" / f"{name}.png"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(render.to_png(arr, vmin, vmax, stretch=stretch))
    return f"stamps/{name}.png"


def sigma_units(arr: np.ndarray) -> np.ndarray:
    v = arr[np.isfinite(arr)]
    sigma = 1.4826 * float(np.median(np.abs(v - np.median(v))))
    return (arr - float(np.median(v))) / sigma


def aperture_snr(data: np.ndarray, x: float, y: float, rng: np.random.Generator) -> dict[str, float]:
    """Aperture flux at (x, y) (grid pixels, FITS order) over the robust scatter of random apertures."""
    ny, nx = data.shape
    yy, xx = np.mgrid[0:ny, 0:nx]

    def phot(cx: float, cy: float) -> float:
        r = np.hypot(xx - cx, yy - cy)
        ap = r <= APER_PX
        ann = (r >= ANNULUS_PX[0]) & (r <= ANNULUS_PX[1]) & np.isfinite(data)
        if ann.sum() < 8 or not np.all(np.isfinite(data[ap])):
            return math.nan
        return float(np.sum(data[ap] - np.median(data[ann])))

    f = phot(x, y)
    vals = []
    lo = ANNULUS_PX[1] + 1
    for _ in range(N_RANDOM_APER * 3):
        if len(vals) >= N_RANDOM_APER:
            break
        cx, cy = rng.uniform(lo, nx - 1 - lo), rng.uniform(lo, ny - 1 - lo)
        if math.hypot(cx - x, cy - y) < 2 * ANNULUS_PX[1]:
            continue
        v = phot(cx, cy)
        if math.isfinite(v):
            vals.append(v)
    v = np.array(vals)
    noise = 1.4826 * float(np.median(np.abs(v - np.median(v)))) if v.size >= 20 else math.nan
    return {"flux": f, "noise": noise, "snr": f / noise if noise and math.isfinite(noise) else math.nan,
            "n_random": int(v.size)}


def pick_even(items: list[dict[str, Any]], n: int) -> list[dict[str, Any]]:
    """Up to n items evenly spaced in time (items sorted by time)."""
    if len(items) <= n:
        return items
    t = np.array([r["mjd_avg"] for r in items])
    picks: list[int] = []
    for target in np.linspace(t[0], t[-1], n):
        order = np.argsort(np.abs(t - target))
        for i in order:
            if int(i) not in picks:
                picks.append(int(i))
                break
    return [items[i] for i in sorted(picks)]


def sep_arcsec(a: dict[str, Any], b: dict[str, Any]) -> float:
    ra1, d1, ra2, d2 = (math.radians(v) for v in (a["ra"], a["dec"], b["ra"], b["dec"]))
    c = math.sin(d1) * math.sin(d2) + math.cos(d1) * math.cos(d2) * math.cos(ra1 - ra2)
    return math.degrees(math.acos(max(-1.0, min(1.0, c)))) * 3600.0


def frame_record(rec: dict[str, Any], png: str, grid: tuple[Any, tuple[int, int]]) -> dict[str, Any]:
    col, row = render.world_to_png_pixel(grid[0], grid[1], rec["ra"], rec["dec"])
    return {
        "png": png, "obs_id": rec["obs_id"], "detector": rec["detector"], "collection": rec["collection"],
        "mjd": round(rec["mjd_avg"], 5), "date_utc": date_utc(rec["mjd_avg"]),
        "wavelength_um": round(rec["wavelength_um"], 4), "pluto_px": [round(col, 2), round(row, 2)],
        "pluto_ra": round(rec["ra"], 6), "pluto_dec": round(rec["dec"], 6),
        "flux_ujy": round(rec["flux_ujy"], 1), "snr": round(rec["snr"], 1),
    }


def frame_quality(arr: np.ndarray) -> dict[str, float]:
    """Valid (unmasked) fraction of a display frame, and the spread of its quadrant medians over the pixel noise."""
    valid = np.isfinite(arr)
    v = arr[valid]
    noise = 1.4826 * float(np.median(np.abs(v - np.median(v)))) if v.size else math.nan
    h = arr.shape[0] // 2
    meds = [float(np.nanmedian(q)) for q in (arr[:h, :h], arr[:h, h:], arr[h:, :h], arr[h:, h:])]
    return {"valid_fraction": float(valid.mean()), "gradient_over_noise": (max(meds) - min(meds)) / noise}


def display_ok(q: dict[str, float]) -> bool:
    return q["valid_fraction"] >= MIN_VALID_FRACTION and q["gradient_over_noise"] <= MAX_GRADIENT


def best_per_observation(recs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The highest-S/N frame of each observation (the exposures of one observation are minutes apart)."""
    best: dict[str, dict[str, Any]] = {}
    for r in recs:
        key = r["obs_id"].rsplit("_", 1)[0]
        if key not in best or r["snr"] > best[key]["snr"]:
            best[key] = r
    return sorted(best.values(), key=lambda r: r["mjd_avg"])


QUALITY: dict[tuple[str, int], dict[str, float]] = {}


def good_groups(groups: dict[tuple[int, int], list[dict]], detectors: tuple[int, ...],
                found: dict) -> dict[tuple[int, int], list]:
    """Blink candidates: S/N >= GOOD_SNR, a display frame that passes display_ok(), best frame per observation."""
    out = {}
    for k, v in groups.items():
        if k[0] not in detectors:
            continue
        keep = []
        for r in v:
            if r["snr"] < GOOD_SNR:
                continue
            key = (r["obs_id"], r["detector"])
            if key not in QUALITY:
                grid = align.make_grid(r["ra"], r["dec"], FOV_BLINK_ARCMIN)
                arr, _ = on_grid(stamp_for(image_of(r, found), r["ra"], r["dec"], FOV_BLINK_ARCMIN), grid,
                                 (r["ra"], r["dec"]))
                QUALITY[key] = frame_quality(arr)
            if display_ok(QUALITY[key]):
                keep.append(r)
        out[k] = best_per_observation(keep)
    return out


def tracked_blink(groups: dict[tuple[int, int], list[dict]], found: dict) -> dict[str, Any]:
    cands = {k: v for k, v in good_groups(groups, (1, 2, 3), found).items() if len(v) >= MIN_TRACKED}
    if not cands:
        return {"error": f"no D1-D3 visit with {MIN_TRACKED} observations at S/N >= {GOOD_SNR:g}"}
    (det, epoch), recs = max(cands.items(), key=lambda kv: (sep_arcsec(kv[1][0], kv[1][-1]), len(kv[1])))
    picks = pick_even(recs, N_TRACKED)
    arrays, grids = [], []
    for r in picks:
        grid = align.make_grid(r["ra"], r["dec"], FOV_BLINK_ARCMIN)
        data, _ = on_grid(stamp_for(image_of(r, found), r["ra"], r["dec"], FOV_BLINK_ARCMIN), grid,
                          (r["ra"], r["dec"]))
        arrays.append(data)
        grids.append(grid)
    vmin, vmax = render.shared_limits(arrays, percentiles=(0.5, 99.7))
    frames = [
        frame_record(r, write_png(f"tracked-{i}", a, vmin, vmax), g)
        for i, (r, a, g) in enumerate(zip(picks, arrays, grids, strict=True))
    ]
    return {
        "detector": det, "visit": epoch, "fov_arcmin": FOV_BLINK_ARCMIN, "grid_px": grids[0][1][0],
        "pixel_arcsec": 6.15, "limits": [vmin, vmax], "span_days": picks[-1]["mjd_avg"] - picks[0]["mjd_avg"],
        "pluto_moved_arcsec": sep_arcsec(picks[0], picks[-1]), "n_candidates": len(recs), "frames": frames,
    }


def skyfixed_blink(groups: dict[tuple[int, int], list[dict]], found: dict) -> dict[str, Any]:
    best = None
    for (det, epoch), recs in good_groups(groups, (1, 2, 3), found).items():
        for i, a in enumerate(recs):
            for b in recs[i + 1 :]:
                s = sep_arcsec(a, b)
                if SKY_MIN_SHIFT_ARCSEC <= s <= SKY_MAX_SHIFT_ARCSEC:
                    score = (s, min(a["snr"], b["snr"]))
                    if best is None or score > best[0]:
                        best = (score, det, epoch, a, b, recs)
    if best is None:
        return {"error": f"no pair of D1-D3 frames with Pluto {SKY_MIN_SHIFT_ARCSEC:g}-{SKY_MAX_SHIFT_ARCSEC:g} "
                         "arcsec apart"}
    _, det, epoch, a, b, recs = best
    mids = [r for r in recs if a["mjd_avg"] < r["mjd_avg"] < b["mjd_avg"]]
    picks = [a]
    if mids:
        half = 0.5 * sep_arcsec(a, b)
        picks.append(min(mids, key=lambda r: abs(sep_arcsec(a, r) - half)))
    picks.append(b)
    ra_c = float(np.mean([r["ra"] for r in (a, b)]))
    dec_c = float(np.mean([r["dec"] for r in (a, b)]))
    grid = align.make_grid(ra_c, dec_c, FOV_BLINK_ARCMIN)
    arrays = [on_grid(stamp_for(image_of(r, found), ra_c, dec_c, FOV_BLINK_ARCMIN), grid, (r["ra"], r["dec"]))[0]
              for r in picks]
    vmin, vmax = render.shared_limits(arrays, percentiles=(0.5, 99.7))
    frames = [frame_record(r, write_png(f"skyfixed-{i}", arr, vmin, vmax), grid) for i, (r, arr) in
              enumerate(zip(picks, arrays, strict=True))]
    return {
        "detector": det, "visit": epoch, "fov_arcmin": FOV_BLINK_ARCMIN, "grid_px": grid[1][0], "pixel_arcsec": 6.15,
        "centre": [ra_c, dec_c], "limits": [vmin, vmax], "span_days": picks[-1]["mjd_avg"] - picks[0]["mjd_avg"],
        "pluto_moved_arcsec": sep_arcsec(picks[0], picks[-1]), "frames": frames,
    }


def n_obs(recs: list[dict[str, Any]]) -> int:
    return len({r["obs_id"].rsplit("_", 1)[0] for r in recs})


def shift_and_stack(groups: dict[tuple[int, int], list[dict]], found: dict, detectors: tuple[int, ...],
                    faint: bool, prefix: str) -> dict[str, Any]:
    """Stacks of one run of clean frames (one detector, one visit, path STACK_MIN_TRAIL-STACK_MAX_TRAIL arcsec).

    faint=False: the run with the most observations (each becomes one dot of Pluto in the star-aligned stack),
    then the most frames. faint=True: the run with the most frames, then the longest path.
    """
    best: list[dict] = []
    best_key: tuple = ()
    for (det, _epoch), recs in groups.items():
        if det not in detectors:
            continue
        for i in range(len(recs)):
            run = [r for r in recs[i:] if sep_arcsec(recs[i], r) <= STACK_MAX_TRAIL_ARCSEC]
            trail = max(sep_arcsec(a, b) for a in run for b in run)
            key = (len(run), trail) if faint else (n_obs(run), len(run), trail)
            if trail >= STACK_MIN_TRAIL_ARCSEC and len(run) >= STACK_MIN_N and key > best_key:
                best, best_key = run, key
    if not best:
        return {"error": f"no run of {STACK_MIN_N} clean frames of D{detectors} with a {STACK_MIN_TRAIL_ARCSEC:g}-"
                         f"{STACK_MAX_TRAIL_ARCSEC:g} arcsec path"}
    recs = best
    trail = max(sep_arcsec(a, b) for a in recs for b in recs)
    fov = max(STACK_MIN_FOV_ARCMIN, trail / 60.0 + STACK_MARGIN_ARCMIN)
    ra_c = float(np.mean([r["ra"] for r in recs]))
    dec_c = float(np.mean([r["dec"] for r in recs]))
    sky_grid = align.make_grid(ra_c, dec_c, fov)
    sky_layers, pluto_layers = [], []
    for r in recs:
        st = stamp_for(image_of(r, found), ra_c, dec_c, 2.0 * fov)
        sky_layers.append(on_grid(st, sky_grid, (r["ra"], r["dec"])))
        pluto_layers.append(on_grid(st, align.make_grid(r["ra"], r["dec"], fov), (r["ra"], r["dec"])))
    sky_d, _, _ = coadd_mod.coadd(sky_layers)
    plu_d, _, _ = coadd_mod.coadd(pluto_layers)
    n = sky_grid[1][0]
    c = (n - 1) / 2.0

    # S/N on difference images, as a search for faint movers does: the static sky (the per-pixel median of the
    # star-aligned frames, which rejects Pluto because it sits on any one pixel in only a few of them) is
    # subtracted from every frame; each difference frame is then measured at Pluto's position (single frames),
    # co-added on the stars (Pluto's dots) and shifted so that Pluto lands on the centre and co-added (the stack).
    cube = np.array([np.where(w > 0, d, np.nan) for d, w in sky_layers])
    template = np.nanmedian(cube, axis=0)
    rng = np.random.default_rng(12345)
    singles, diff_sky, diff_plu, pluto_xy = [], [], [], []
    for r, (d, w) in zip(recs, sky_layers, strict=True):
        x, y = (float(v) for v in sky_grid[0].world_to_pixel_values(r["ra"], r["dec"]))
        pluto_xy.append((x, y))
        diff = np.where(w > 0, d - template, np.nan)
        diff_sky.append((np.nan_to_num(diff), np.where(np.isfinite(diff), w, 0.0)))
        singles.append(aperture_snr(diff, x, y, rng) | {"obs_id": r["obs_id"], "wavelength_um": r["wavelength_um"],
                                                          "forced_snr": r["snr"]})
        shift = (c - y, c - x)
        dd = ndimage.shift(np.nan_to_num(diff), shift, order=1, mode="constant", cval=0.0)
        ww = ndimage.shift(np.where(np.isfinite(diff), w, 0.0), shift, order=1, mode="constant", cval=0.0)
        diff_plu.append((dd, np.where(ww > 0.999 * ndimage.shift(np.ones_like(ww), shift, order=1), ww, 0.0)))
    dsky, _, _ = coadd_mod.coadd(diff_sky)
    dplu, _, _ = coadd_mod.coadd(diff_plu)
    stack = aperture_snr(dplu, c, c, rng)
    dots = []
    for r in best_per_observation(recs):
        x, y = sky_grid[0].world_to_pixel_values(r["ra"], r["dec"])
        dots.append({"obs": r["obs_id"].rsplit("_", 1)[0], "snr": aperture_snr(dsky, float(x), float(y), rng)["snr"],
                     "px": list(render.world_to_png_pixel(sky_grid[0], sky_grid[1], r["ra"], r["dec"]))})
    vmin, vmax = render.shared_limits([sky_d, plu_d], percentiles=(0.5, 99.7))
    snr_single = [s["snr"] for s in singles if math.isfinite(s["snr"])]
    med = float(np.median(snr_single)) if snr_single else None
    # Difference images in units of their own pixel noise (like the Lab's difference frames: linear stretch,
    # symmetric limits from the 0.5/99.5 percentiles, at least DIFF_MIN_SIGMA): the single frame with the median
    # S/N, the star-aligned difference stack and the Pluto-aligned difference stack.
    ok = [i for i, x in enumerate(singles) if math.isfinite(x["snr"])]
    i_med = min(ok, key=lambda i: abs(singles[i]["snr"] - med)) if ok else 0
    single_diff = np.where(sky_layers[i_med][1] > 0, sky_layers[i_med][0] - template, np.nan)
    sx, sy = pluto_xy[i_med]
    single_diff = ndimage.shift(np.nan_to_num(single_diff, nan=np.nan), (c - sy, c - sx), order=1, mode="constant",
                                cval=np.nan)
    sig = [sigma_units(a) for a in (single_diff, dsky, dplu)]
    _, lim = render.shared_limits(sig, percentiles=(0.5, 99.5), symmetric=True)
    lim = max(DIFF_MIN_SIGMA, float(lim))
    diff_pngs = {
        "single": write_png(f"{prefix}-diff-single", sig[0], -lim, lim, "linear"),
        "star_aligned": write_png(f"{prefix}-diff-stars", sig[1], -lim, lim, "linear"),
        "pluto_aligned": write_png(f"{prefix}-diff-pluto", sig[2], -lim, lim, "linear"),
        "single_obs_id": singles[i_med]["obs_id"], "limits_sigma": [-lim, lim],
        "note": "pixel values divided by each image's robust pixel noise; the single frame is shifted so Pluto sits "
                "at the centre, like the Pluto-aligned stack",
    }
    return {
        "detector": recs[0]["detector"], "visit": recs[0]["epoch"], "n": len(recs),
        "n_observations": n_obs(recs), "fov_arcmin": fov,
        "grid_px": sky_grid[1][0], "pixel_arcsec": 6.15,
        "span_days": recs[-1]["mjd_avg"] - recs[0]["mjd_avg"], "trail_arcsec": trail,
        "wavelength_range_um": [min(r["wavelength_um"] for r in recs), max(r["wavelength_um"] for r in recs)],
        "obs_ids": [r["obs_id"] for r in recs], "mjd": [r["mjd_avg"] for r in recs],
        "star_aligned_png": write_png(f"{prefix}-stars", sky_d, vmin, vmax),
        "pluto_aligned_png": write_png(f"{prefix}-pluto", plu_d, vmin, vmax),
        "pluto_px_pluto_aligned": [c, c], "limits": [vmin, vmax], "difference_pngs": diff_pngs,
        "singles": singles, "snr_single_median": med, "n_single_measured": len(snr_single),
        "stack": stack, "snr_stack": stack["snr"],
        "snr_expected_sqrt_n": med * math.sqrt(len(snr_single)) if med else None,
        "forced_snr_single_median": float(np.median([r["snr"] for r in recs])),
        "forced_snr_combined": float(math.sqrt(sum(r["snr"] ** 2 for r in recs))),
        "dots": dots, "snr_star_aligned_dots_median": float(np.nanmedian([d["snr"] for d in dots])),
        "method": "S/N on difference images (each frame minus the per-pixel median of all the star-aligned frames): "
                  f"aperture radius {APER_PX:g} px, background annulus {ANNULUS_PX[0]:g}-{ANNULUS_PX[1]:g} px, noise "
                  f"= 1.4826 x MAD of up to {N_RANDOM_APER} random apertures in the same image; inverse-variance "
                  "weighted co-adds (pxh.imaging.coadd); the PNGs are the plain co-adds, before subtraction",
    }


def bb_nu(lam_um: np.ndarray | float, t_k: float = SOLAR_TEFF_K) -> np.ndarray:
    h, c, k = 6.62607015e-34, 2.99792458e8, 1.380649e-23
    nu = c / (np.asarray(lam_um, dtype=float) * 1e-6)
    return nu**3 / np.expm1(h * nu / (k * t_k))


def spectrum(recs: list[dict[str, Any]]) -> dict[str, Any]:
    lam = np.array([r["wavelength_um"] for r in recs])
    f = np.array([r["flux_ujy"] for r in recs])
    e = np.array([r["flux_err_ujy"] for r in recs])
    edges = np.exp(np.linspace(math.log(0.74), math.log(5.02), N_BINS + 1))
    bins = []
    for a, b in itertools.pairwise(edges):
        s = (lam >= a) & (lam < b)
        if not s.any():
            continue
        w = 1.0 / e[s] ** 2
        m = float(np.sum(w * f[s]) / np.sum(w))
        err = 1.0 / math.sqrt(float(np.sum(w)))
        chi2 = float(np.sum(w * (f[s] - m) ** 2)) / max(int(s.sum()) - 1, 1)
        err *= math.sqrt(max(chi2, 1.0))
        bins.append({"lo_um": a, "hi_um": b, "um": math.sqrt(a * b), "n": int(s.sum()), "flux_ujy": m,
                     "err_ujy": err, "chi2_red": chi2})
    short = [x for x in bins if x["um"] < 1.0]
    scale = float(np.median([x["flux_ujy"] / bb_nu(x["um"]) for x in short]))
    for x in bins:
        sun = scale * float(bb_nu(x["um"]))
        x["sunlight_shape_ujy"] = sun
        x["relative_reflectance"] = x["flux_ujy"] / sun
        x["relative_reflectance_err"] = x["err_ujy"] / sun

    def rel(lo: float, hi: float) -> tuple[float, float]:
        s = [x for x in bins if lo <= x["um"] < hi]
        w = np.array([1.0 / x["relative_reflectance_err"] ** 2 for x in s])
        v = np.array([x["relative_reflectance"] for x in s])
        return float(np.sum(w * v) / np.sum(w)), float(1.0 / math.sqrt(np.sum(w)))

    # Bands: where the cited references put methane-ice absorption AND the data dip clearly below the
    # neighbouring continuum. The windows are fixed here; the depths are measured.
    band_defs = [
        ("Methane ice", 1.60, 1.80, (1.45, 1.60), ("Cruikshank, Pilcher & Morrison 1976 found methane on Pluto by "
         "comparing its brightness at 1.55 and 1.73 um; Grundy, Schmitt & Quirico 2002 (lab spectrum of methane "
         "ice, 0.7-5 um)")),
        ("Methane ice", 2.15, 2.45, (1.80, 2.05), ("Protopapa et al. 2017 (methane bands at 2.2 and 2.3 um in New "
         "Horizons spectra); Grundy, Schmitt & Quirico 2002")),
        ("Methane ice", 3.05, 3.65, (2.60, 2.85), ("Grundy, Schmitt & Quirico 2002 (lab spectrum of methane ice, "
         "0.7-5 um); Olkin et al. 2007 (Pluto's spectrum from 1.0 to 4.2 um)")),
    ]
    bands = []
    for name, lo, hi, cont, ref in band_defs:
        r_in, e_in = rel(lo, hi)
        r_out, e_out = rel(*cont)
        depth = 1.0 - r_in / r_out
        derr = (r_in / r_out) * math.hypot(e_in / r_in, e_out / r_out)
        bands.append({"name": name, "lo_um": lo, "hi_um": hi, "continuum_um": list(cont),
                      "relative_reflectance_in": r_in, "relative_reflectance_continuum": r_out,
                      "depth": depth, "depth_err": derr, "significance_sigma": depth / derr if derr > 0 else None,
                      "references": ref})
    return {
        "points": [{"um": round(r["wavelength_um"], 4), "dum": round(r["bandwidth_um"], 4),
                    "flux_ujy": round(r["flux_ujy"], 1), "err_ujy": round(r["flux_err_ujy"], 1),
                    "detector": r["detector"], "visit": r["epoch"], "template_checked": bool((r.get("static") or {}).get("n"))}
                   for r in recs],
        "bins": bins,
        "sunlight_shape": f"a {SOLAR_TEFF_K:g} K blackbody (a rough stand-in for sunlight), scaled to Pluto's median "
                          "below 1 um; relative reflectance = Pluto / that curve",
        "bands": bands,
    }


def robust(v: list[float]) -> dict[str, float]:
    a = np.asarray(v, dtype=float)
    return {"n": int(a.size), "median": float(np.median(a)), "p10": float(np.percentile(a, 10)),
            "p90": float(np.percentile(a, 90)), "min": float(a.min()), "max": float(a.max())}


def astrometry(recs: list[dict[str, Any]], min_snr: float) -> dict[str, Any]:
    use = [r for r in recs if "off_east_arcsec" in r and (r.get("fit_snr") or 0) >= min_snr]
    e = np.array([r["off_east_arcsec"] for r in use])
    n = np.array([r["off_north_arcsec"] for r in use])
    ee = np.array([r["off_east_err_arcsec"] for r in use])
    ne = np.array([r["off_north_err_arcsec"] for r in use])
    tot = np.hypot(e, n)
    we, wn = 1.0 / ee**2, 1.0 / ne**2
    return {
        "selection": f"clean measurements with a fitted position at S/N >= {min_snr:g}", "n": len(use),
        "median_east_arcsec": float(np.median(e)), "median_north_arcsec": float(np.median(n)),
        "wmean_east_arcsec": float(np.sum(we * e) / np.sum(we)), "wmean_east_err_arcsec": float(1 / math.sqrt(np.sum(we))),
        "wmean_north_arcsec": float(np.sum(wn * n) / np.sum(wn)), "wmean_north_err_arcsec": float(1 / math.sqrt(np.sum(wn))),
        "rms_east_arcsec": float(np.sqrt(np.mean(e**2))), "rms_north_arcsec": float(np.sqrt(np.mean(n**2))),
        "median_formal_err_arcsec": float(np.median(np.concatenate([ee, ne]))),
        "chi2_red_east": float(np.mean((e / ee) ** 2)), "chi2_red_north": float(np.mean((n / ne) ** 2)),
        "total_offset_arcsec": robust(list(tot)),
    }


def planetx_facts(elongation_deg: list[float]) -> dict:
    """pluto_planetx_facts.py's geometry, for visits seen at the Pluto images' solar elongations."""
    cmd = [sys.executable, str(SCRIPT_DIR / "pluto_planetx_facts.py"), "--elongation",
           repr(min(elongation_deg)), repr(max(elongation_deg))]
    return json.loads(subprocess.run(cmd, capture_output=True, text=True, check=True).stdout)


def refresh_geometry() -> int:
    """Recompute planet_x_geometry in the existing bundle, leaving every measured product as it is."""
    path = BUNDLE / "pluto.json"
    out = json.loads(path.read_text(encoding="utf-8"))
    out["planet_x_geometry"] = planetx_facts([e for v in out["summary"]["visits"] for e in v["solar_elongation_deg"]])
    path.write_text(json.dumps(jsonable(out), separators=(",", ":")), encoding="utf-8")
    log.info("planet_x_geometry recomputed in %s", path)
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--geometry-only", action="store_true",
                    help="recompute only planet_x_geometry in the existing pluto.json (no images, no network)")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s",
                        datefmt="%H:%M:%S")
    for noisy in ("httpx", "httpcore", "pxh.spherex.l2"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
    warnings.filterwarnings("ignore")
    if args.geometry_only:
        return refresh_geometry()
    meas = load_json(MEASURE_JSON)
    finder = load_json(EXPOSURES_JSON)
    found = {(r["obs_id"], r["detector"]): r for r in finder["exposures"]}
    allr = sorted(meas["results"], key=lambda r: (r["mjd_avg"], r["detector"]))
    recs = [r for r in allr if clean(r)]
    groups: dict[tuple[int, int], list[dict]] = defaultdict(list)
    for r in recs:
        groups[(r["detector"], r["epoch"])].append(r)
    for old in (BUNDLE / "stamps").glob("*.png"):
        old.unlink()
    tracked = tracked_blink(groups, found)
    sky = skyfixed_blink(groups, found)
    n_ok = sum(display_ok(q) for q in QUALITY.values())
    log.info("blink candidates: %d frames checked, %d pass the display checks (valid >= %.2f, gradient <= %.1f)",
             len(QUALITY), n_ok, MIN_VALID_FRACTION, MAX_GRADIENT)
    for name in ("tracked", "sky"):
        (tracked if name == "tracked" else sky)["display_checks"] = {
            "n_checked": len(QUALITY), "n_passed": n_ok, "min_valid_fraction": MIN_VALID_FRACTION,
            "max_gradient_over_noise": MAX_GRADIENT}
    stack = shift_and_stack(groups, found, (1, 2, 3, 4, 5, 6), False, "stack")
    stack_faint = shift_and_stack(groups, found, (5, 6), True, "stack-faint")
    spec = spectrum(recs)
    facts = planetx_facts([r["elongation_deg"] for r in allr])

    visits = []
    for e in meas["epochs"]:
        v = [r for r in allr if r["epoch"] == e["index"]]
        moved = max(sep_arcsec(a, b) for a in v for b in v)
        visits.append({
            "visit": e["index"], "start_utc": date_utc(min(r["mjd_avg"] for r in v)),
            "end_utc": date_utc(max(r["mjd_avg"] for r in v)), "n_images": len(v),
            "n_exposures": len({r["obs_id"] for r in v}), "n_clean": sum(clean(r) for r in v),
            "collections": sorted({r["collection"] for r in v}),
            "wavelength_um": [min(r["wavelength_um"] for r in v), max(r["wavelength_um"] for r in v)],
            "solar_elongation_deg": [min(r["elongation_deg"] for r in v), max(r["elongation_deg"] for r in v)],
            "distance_au": [min(r["delta_au"] for r in v), max(r["delta_au"] for r in v)],
            "vmag": [min(r["vmag"] for r in v), max(r["vmag"] for r in v)],
            "rate_arcsec_per_h": [min(math.hypot(r["rate_ra_arcsec_h"], r["rate_dec_arcsec_h"]) for r in v),
                                  max(math.hypot(r["rate_ra_arcsec_h"], r["rate_dec_arcsec_h"]) for r in v)],
            "pluto_moved_arcsec": moved,
        })

    depths = [r["depth"]["depth5_ab"] for r in allr if (r.get("depth") or {}).get("depth5_ab")]
    depth_bands = {}
    for name, lo, hi in (("0.75-3.8 um", 0.0, 3.8), ("3.8-5.0 um", 3.8, 9.0)):
        d = [r["depth"]["depth5_ab"] for r in allr if lo <= r["wavelength_um"] < hi
             and (r.get("depth") or {}).get("depth5_ab")]
        depth_bands[name] = robust(d)
    templ = [r for r in allr if (r.get("static") or {}).get("n")]
    fr = [r["static"]["fraction_of_pluto"] for r in templ if r["static"].get("fraction_of_pluto") is not None]
    pipe_ratio = [r["flux_ujy"] / r["flux_pipeline_ujy"] for r in recs
                  if r.get("flux_pipeline_ujy") and r.get("n_outlier_unflagged") and r.get("n_masked_core_pipeline", 9) <= 3
                  and r["snr"] > 10 and r["flux_pipeline_ujy"] > 0]
    files = finder["exposures"]
    out = {
        "generated_utc": datetime.now(tz=UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "provenance": {
            "data": "NASA SPHEREx Level-2 spectral images, releases DR1 (spherex_dr1) and QR3 (spherex_qr3), read by "
                    "HTTP byte ranges from the public copy at " + finder["search"]["bucket"],
            "file_tags": sorted({r["file_tag"] for r in files}),
            "finder": finder["search"]["method"],
            "n_observations_scanned": finder["search"].get("n_observations_scanned"),
            "ephemeris": finder["ephemeris"],
            "scripts": ["scripts/pluto_scan_s3.py", "scripts/pluto_find.py", "scripts/pluto_measure.py",
                        "scripts/pluto_products.py", "scripts/pluto_planetx_facts.py"],
            "measurement": "forced photometry and a fitted position at JPL's predicted position (pxh.photometry."
                           "forced, each file's own ePSF), moved from the geocentre to SPHEREx with the header's "
                           "spacecraft position; see docs/validation/pluto.md",
            "outlier_flag": f"the pipeline's OUTLIER flag is cleared within {UNFLAG_PX:g} px of Pluto (it marks "
                            "Pluto itself)",
        },
        "summary": {
            "n_images": len(allr), "n_exposures": len({r["obs_id"] for r in allr}), "n_clean": len(recs),
            "detectors": dict(sorted(Counter(f"D{r['detector']}" for r in allr).items())),
            "wavelength_um": [min(r["wavelength_um"] for r in allr), max(r["wavelength_um"] for r in allr)],
            "exposure_s": float(np.median([r["exptime_s"] for r in allr])),
            "psf_fwhm_arcsec": robust([r["psf_fwhm_arcsec"] for r in allr]),
            "snr": robust([r["snr"] for r in recs]),
            "visits": visits,
        },
        "astrometry": astrometry(recs, 20.0),
        "astrometry_snr10": astrometry(recs, 10.0),
        "depth5_ab": {"all": robust(depths), **depth_bands,
                      "method": "5 x 1.4826 x MAD of forced fluxes at up to 40 random positions in each stamp, "
                                "at least 5 px from Pluto (the same estimator as Pluto's flux)"},
        "static_sky": {
            "n_images_with_template": len(templ), "n_blended": sum(bool(r["static"].get("blended")) for r in templ),
            "fraction_of_pluto": robust(fr) if fr else None,
            "method": "forced flux at Pluto's position in other images of the same detector taken while Pluto was "
                      "at least 40 arcsec away",
        },
        "outlier_check": {"n": len(pipe_ratio), "flux_ratio_kept_over_masked": robust(pipe_ratio) if pipe_ratio else None,
                          "n_images_with_outlier_on_pluto": sum(1 for r in allr if r.get("n_outlier_unflagged"))},
        "spectrum": spec,
        "tracked_blink": tracked,
        "skyfixed_blink": sky,
        "shift_and_stack": stack,
        "shift_and_stack_faint": stack_faint,
        "planet_x_geometry": facts,
        "published": PUBLISHED,
        "references": REFERENCES,
        "exposures": [
            {"obs_id": r["obs_id"], "detector": r["detector"], "collection": r["collection"], "visit": r["epoch"],
             "mjd": round(r["mjd_avg"], 6), "date_utc": date_utc(r["mjd_avg"]), "um": round(r["wavelength_um"], 4),
             "ra": round(r["ra"], 6), "dec": round(r["dec"], 6), "x": round(r["x"], 1), "y": round(r["y"], 1),
             "flux_ujy": None if r.get("flux_ujy") is None else round(r["flux_ujy"], 1),
             "err_ujy": None if r.get("flux_err_ujy") is None else round(r["flux_err_ujy"], 1),
             "snr": None if r.get("snr") is None else round(r["snr"], 1),
             "ab": None if not r.get("ab") or not math.isfinite(r["ab"]) else round(r["ab"], 3),
             "off_e": None if "off_east_arcsec" not in r else round(r["off_east_arcsec"], 3),
             "off_n": None if "off_north_arcsec" not in r else round(r["off_north_arcsec"], 3),
             "off_err": None if "off_east_err_arcsec" not in r else round(
                 0.5 * (r["off_east_err_arcsec"] + r["off_north_err_arcsec"]), 3),
             "depth5_ab": None if not (r.get("depth") or {}).get("depth5_ab") else round(r["depth"]["depth5_ab"], 2),
             "flags": r.get("flag_names") or [], "clean": clean(r)}
            for r in allr
        ],
    }
    BUNDLE.mkdir(parents=True, exist_ok=True)
    (BUNDLE / "products.tmp.json").unlink(missing_ok=True)
    (BUNDLE / "pluto.json").write_text(json.dumps(jsonable(out), separators=(",", ":")), encoding="utf-8")
    log.info("tracked D%s v%s (%d frames, %.1f d, %.0f arcsec); sky D%s (%.0f arcsec); stack D%s n=%s S/N single "
             "%.1f -> stack %.1f; %d clean of %d", tracked.get("detector"), tracked.get("visit"),
             len(tracked.get("frames", [])), tracked.get("span_days", -1), tracked.get("pluto_moved_arcsec", -1),
             sky.get("detector"), sky.get("pluto_moved_arcsec", -1), stack.get("detector"), stack.get("n"),
             stack.get("snr_single_median") or -1, stack.get("snr_stack") or -1, len(recs), len(allr))
    log.info("faint stack D%s n=%s S/N single %.1f -> stack %.1f", stack_faint.get("detector"), stack_faint.get("n"),
             stack_faint.get("snr_single_median") or -1, stack_faint.get("snr_stack") or -1)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
