"""Measure Pluto in every SPHEREx exposure found by pluto_find.py.

Run from backend/:  uv run python ../scripts/pluto_measure.py

For each detector image (data/tmp/pluto/exposures.json):
1. a byte-range stamp (HALF px each side) centred on Pluto's predicted SPHEREx-centric position at MJD-AVG;
2. forced photometry at the predicted position (pxh.photometry.forced, the file's own ePSF; zodi-free local
   background; the file's science mask; OVERFLOW = saturation), and a fitted position for the offset from
   JPL's prediction (measured minus predicted, east and north, arcsec);
3. the 5-sigma point-source depth of the same forced-photometry estimator, from the robust scatter
   (1.4826 x MAD) of forced fluxes at N_RANDOM random positions in the stamp away from Pluto;
4. the static sky at Pluto's position: forced flux at the same sky position in the other images of the same
   detector whose stamps cover it while Pluto is at least AWAY_ARCSEC away.

The pipeline's OUTLIER flag ("Pixel flagged by Detect Outliers") lands on Pluto itself: in a first run with the
Lab's science mask, 17.8% of pixels within 1.5 px of Pluto carried it against 1.2% beyond 6 px, and keeping
those pixels changed Pluto's flux by a median factor 0.999 (42 images with 1-3 flagged core pixels, S/N > 10).
So step 2 uses a copy of each stamp with OUTLIER cleared within UNFLAG_PX of Pluto's predicted position (all
other flags, and OUTLIER elsewhere, stay masked); the flux with the plain science mask is kept as flux_pipeline_ujy.

Writes data/tmp/pluto/measurements.json. All thresholds are fixed here before looking at the results.
"""

from __future__ import annotations

import argparse
import hashlib
import logging
import math
import time
import warnings
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field, replace
from typing import Any

import numpy as np
from pluto_common import EXPOSURES_JSON, MEASURE_JSON, load_json, save_json

from pxh.models import DetectorImage, EPSFGrid, Stamp
from pxh.photometry import forced
from pxh.photometry.motion import tangent_offsets_mas
from pxh.spherex import epochs as ep
from pxh.spherex import flags as fl
from pxh.spherex import l2, rangeio

log = logging.getLogger("pluto_measure")

HALF = 24  # stamp half size, px (49 x 49 px = 5.0 arcmin)
N_RANDOM = 40  # random positions per stamp for the depth
RANDOM_MIN_SEP_PX = 5.0  # random positions at least this far from Pluto
EDGE_PX = 7.0  # positions (Pluto, random, template) at least this far from the stamp edge (background annulus)
AWAY_ARCSEC = 40.0  # a template image must have Pluto at least this far from the position measured
SNR_POSITION = 10.0  # positions with forced S/N below this are not used for offsets
BLEND_SIGMA = 3.0  # static flux above this many sigma ...
BLEND_FRACTION = 0.03  # ... and above this fraction of Pluto's flux marks a blend
AB_ZP_UJY = 23.9  # m_AB = 23.9 - 2.5 log10(F / uJy)
UNFLAG_PX = 2.5  # OUTLIER is cleared within this radius of Pluto's predicted position (see the docstring)


@dataclass
class Obs:
    row: dict[str, Any]
    image: DetectorImage
    stamp: Stamp | None = None
    epsf: EPSFGrid | None = None
    status: str = "pending"
    error: str = ""
    out: dict[str, Any] = field(default_factory=dict)

    @property
    def ra(self) -> float:
        return float(self.row["ra"])

    @property
    def dec(self) -> float:
        return float(self.row["dec"])


def ab(f_ujy: float) -> float:
    return AB_ZP_UJY - 2.5 * math.log10(f_ujy) if f_ujy > 0 else math.nan


def masks_of(stamp: Stamp) -> tuple[int, int]:
    return fl.science_mask(stamp.flag_bits), fl.saturation_mask(stamp.flag_bits)


def stamp_xy(stamp: Stamp, ra: float, dec: float) -> tuple[float, float]:
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        x, y = stamp.wcs.world_to_pixel_values(ra, dec)
    return float(x), float(y)


def inside(stamp: Stamp, x: float, y: float, edge: float = EDGE_PX) -> bool:
    ny, nx = stamp.data.shape
    return edge <= x <= nx - 1 - edge and edge <= y <= ny - 1 - edge


def fetch(o: Obs) -> Obs:
    try:
        o.stamp = l2.read_stamp(o.image, o.ra, o.dec, half_size_px=HALF)
        o.status = "ok"
    except l2.OutsideDetectorError as exc:
        o.status, o.error = "outside", str(exc)[:200]
    except Exception as exc:  # noqa: BLE001 - recorded per image
        o.status, o.error = "error", repr(exc)[:300]
    return o


def unflag_pluto(st: Stamp, x_p: float, y_p: float) -> tuple[Stamp, int]:
    """A copy of the stamp with the OUTLIER bit cleared within UNFLAG_PX of (x_p, y_p); and how many were cleared."""
    if st.flags is None or "OUTLIER" not in st.flag_bits:
        return st, 0
    bit = np.int64(1) << np.int64(st.flag_bits["OUTLIER"])
    f = np.asarray(st.flags).astype(np.int64)
    yy, xx = np.mgrid[0 : f.shape[0], 0 : f.shape[1]]
    near = (np.hypot(xx - x_p, yy - y_p) <= UNFLAG_PX) & ((f & bit) != 0)
    if not near.any():
        return st, 0
    f = f.copy()
    f[near] &= ~bit
    return replace(st, flags=f.astype(np.asarray(st.flags).dtype)), int(near.sum())


def depth(o: Obs, mask: int, sat: int, x_p: float, y_p: float) -> dict[str, Any]:
    st = o.stamp
    ny, nx = st.data.shape
    seed = int(hashlib.sha256(o.image.cache_key.encode()).hexdigest()[:8], 16)
    rng = np.random.default_rng(seed)
    fluxes = []
    tries = 0
    while len(fluxes) < N_RANDOM and tries < 4 * N_RANDOM:
        tries += 1
        x = rng.uniform(EDGE_PX, nx - 1 - EDGE_PX)
        y = rng.uniform(EDGE_PX, ny - 1 - EDGE_PX)
        if math.hypot(x - x_p, y - y_p) < RANDOM_MIN_SEP_PX:
            continue
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            ra, dec = st.wcs.pixel_to_world_values(x, y)
        try:
            r = forced.measure_source(st, float(ra), float(dec), o.epsf, mask, sat)
        except forced.PhotometryError:
            continue
        if math.isfinite(r.point.flux_ujy):
            fluxes.append(r.point.flux_ujy)
    if len(fluxes) < 10:
        return {"n": len(fluxes)}
    f = np.array(fluxes)
    sigma = 1.4826 * float(np.median(np.abs(f - np.median(f))))
    return {
        "n": len(f), "sigma_ujy": sigma, "median_ujy": float(np.median(f)),
        "depth5_ab": ab(5.0 * sigma) if sigma > 0 else None,
    }


def measure(o: Obs) -> None:
    raw = o.stamp
    mask, sat = masks_of(raw)
    x_p, y_p = stamp_xy(raw, o.ra, o.dec)
    st, n_unflagged = unflag_pluto(raw, x_p, y_p)
    out: dict[str, Any] = {"x_stamp": x_p, "y_stamp": y_p, "inside": inside(raw, x_p, y_p),
                           "n_outlier_unflagged": n_unflagged}
    try:
        r0 = forced.measure_source(raw, o.ra, o.dec, o.epsf, mask, sat)
        out |= {"flux_pipeline_ujy": r0.point.flux_ujy, "flux_pipeline_err_ujy": r0.point.flux_err_ujy,
                "n_masked_core_pipeline": int(r0.n_masked_core)}
    except forced.PhotometryError:
        pass
    try:
        r = forced.measure_source(st, o.ra, o.dec, o.epsf, mask, sat)
        p = r.point
        out |= {
            "flux_ujy": p.flux_ujy, "flux_err_ujy": p.flux_err_ujy, "snr": r.snr, "method": p.method,
            "wavelength_um": p.wavelength_um, "bandwidth_um": p.bandwidth_um, "flags": int(p.flags),
            "flag_names": fl.describe(int(p.flags), st.flag_bits), "saturated": bool(p.saturated),
            "n_masked_core": int(r.n_masked_core), "background": r.background, "chi2_red": r.chi2_red,
            "ab": ab(p.flux_ujy), "ab_err": 1.0857 * p.flux_err_ujy / p.flux_ujy if p.flux_ujy > 0 else None,
        }
    except forced.PhotometryError as exc:
        out["phot_error"] = str(exc)[:200]
    try:
        q = forced.measure_position(st, o.ra, o.dec, o.epsf, mask, sat)
        if forced.usable_for_motion(q):
            xi, eta = tangent_offsets_mas(np.array([q.ra_deg]), np.array([q.dec_deg]), o.ra, o.dec)
            out |= {
                "fit_ra": q.ra_deg, "fit_dec": q.dec_deg, "fit_snr": q.snr,
                "off_east_arcsec": float(xi[0]) / 1000.0, "off_north_arcsec": float(eta[0]) / 1000.0,
                "off_east_err_arcsec": q.ra_err_mas / 1000.0, "off_north_err_arcsec": q.dec_err_mas / 1000.0,
                "fit_chi2_red": q.chi2_red,
            }
            xg, eg = tangent_offsets_mas(np.array([q.ra_deg]), np.array([q.dec_deg]), o.row["ra_geo"],
                                         o.row["dec_geo"])
            out |= {"off_geo_east_arcsec": float(xg[0]) / 1000.0, "off_geo_north_arcsec": float(eg[0]) / 1000.0}
    except forced.PhotometryError as exc:
        out["pos_error"] = str(exc)[:200]
    o.stamp = raw  # depth and the static-sky templates use the pipeline's flags unchanged
    out["depth"] = depth(o, mask, sat, x_p, y_p)
    o.out = out


def templates(obs: list[Obs]) -> None:
    """Forced flux at each image's Pluto position in other images of the same detector (Pluto elsewhere)."""
    by_det: dict[int, list[Obs]] = defaultdict(list)
    for o in obs:
        by_det[o.image.detector].append(o)
    for group in by_det.values():
        for o in group:
            vals = []
            for t in group:
                if t is o:
                    continue
                away = 3600.0 * math.degrees(_sep(o.ra, o.dec, t.ra, t.dec))
                if away < AWAY_ARCSEC:
                    continue
                x, y = stamp_xy(t.stamp, o.ra, o.dec)
                if not inside(t.stamp, x, y):
                    continue
                mask, sat = masks_of(t.stamp)
                try:
                    r = forced.measure_source(t.stamp, o.ra, o.dec, t.epsf, mask, sat)
                except forced.PhotometryError:
                    continue
                p = r.point
                if math.isfinite(p.flux_ujy) and p.flux_err_ujy > 0:
                    vals.append({
                        "obs_id": t.image.obs_id, "dt_days": t.row["mjd_avg"] - o.row["mjd_avg"],
                        "away_arcsec": away, "wavelength_um": p.wavelength_um, "flux_ujy": p.flux_ujy,
                        "flux_err_ujy": p.flux_err_ujy,
                    })
            summary: dict[str, Any] = {"n": len(vals), "list": vals}
            if vals:
                f = np.array([v["flux_ujy"] for v in vals])
                e = np.array([v["flux_err_ujy"] for v in vals])
                w = 1.0 / e**2
                mean = float(np.sum(w * f) / np.sum(w))
                err = float(1.0 / math.sqrt(np.sum(w)))
                chi2 = float(np.sum(w * (f - mean) ** 2) / max(len(f) - 1, 1))
                err *= math.sqrt(max(chi2, 1.0))
                summary |= {"mean_ujy": mean, "err_ujy": err, "median_ujy": float(np.median(f)), "chi2_red": chi2}
                fp = o.out.get("flux_ujy")
                if fp and fp > 0:
                    summary["fraction_of_pluto"] = mean / fp
                    summary["blended"] = bool(mean > BLEND_SIGMA * err and mean > BLEND_FRACTION * fp)
            o.out["static"] = summary


def _sep(ra1: float, dec1: float, ra2: float, dec2: float) -> float:
    a1, d1, a2, d2 = (math.radians(v) for v in (ra1, dec1, ra2, dec2))
    c = math.sin(d1) * math.sin(d2) + math.cos(d1) * math.cos(d2) * math.cos(a1 - a2)
    return math.acos(max(-1.0, min(1.0, c)))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--limit", type=int, default=0, help="measure only the first N images (testing)")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s",
                        datefmt="%H:%M:%S")
    for noisy in ("httpx", "httpcore", "pxh.spherex.sia", "pxh.spherex.l2", "pxh.photometry.forced"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
    warnings.filterwarnings("ignore")
    t0 = time.perf_counter()
    found = load_json(EXPOSURES_JSON)
    rows = found["exposures"][: args.limit or None]
    obs = [Obs(row=r, image=DetectorImage(**r["image"])) for r in rows]
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        list(pool.map(fetch, obs))
    st = rangeio.stats()
    log.info("stamps: %s, %.1f MB in %d requests, %.0f s", dict(Counter(o.status for o in obs)), st.bytes / 1e6,
             st.requests, time.perf_counter() - t0)
    memo: dict[tuple[int, str], EPSFGrid] = {}
    for o in obs:
        if o.status != "ok":
            continue
        k = (o.image.detector, l2.read_layout(o.image).epsf_calibration)
        if k not in memo:
            memo[k] = l2.read_epsf(o.image)
        o.epsf = memo[k]
    ok = [o for o in obs if o.status == "ok"]
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        list(pool.map(measure, ok))
    log.info("photometry done, %.0f s", time.perf_counter() - t0)
    templates(ok)
    log.info("templates done, %.0f s", time.perf_counter() - t0)

    exposures = ep.group_exposures([o.image for o in ok])
    epochs = ep.group_epochs(exposures)
    epoch_of = {x.obs_id: e.index for e in epochs for x in e.exposures}
    results = []
    for o in obs:
        rec = {k: v for k, v in o.row.items() if k != "image"}
        rec |= {"status": o.status, "error": o.error, "epoch": epoch_of.get(o.image.obs_id)}
        if o.stamp is not None:
            rec |= {"stamp_x0": o.stamp.x0, "stamp_y0": o.stamp.y0, "stamp_shape": list(o.stamp.data.shape)}
        rec |= o.out
        results.append(rec)
    st = rangeio.stats()
    save_json(MEASURE_JSON, {
        "constants": {
            "half_px": HALF, "n_random": N_RANDOM, "random_min_sep_px": RANDOM_MIN_SEP_PX, "edge_px": EDGE_PX,
            "away_arcsec": AWAY_ARCSEC, "snr_position": SNR_POSITION, "blend_sigma": BLEND_SIGMA,
            "blend_fraction": BLEND_FRACTION, "unflag_px": UNFLAG_PX,
        },
        "epochs": [
            {"index": e.index, "t_start_mjd": e.t_start_mjd, "t_end_mjd": e.t_end_mjd, "n_exposures": len(e.exposures),
             "detector_counts": e.detector_counts, "survey_year": e.survey_year}
            for e in epochs
        ],
        "epsf_calibrations": sorted(f"D{d}:{c}" for d, c in memo),
        "transfer": {"requests": st.requests, "bytes": st.bytes},
        "seconds": time.perf_counter() - t0,
        "results": results,
    })
    log.info("wrote %s (%d images, %.0f s)", MEASURE_JSON, len(results), time.perf_counter() - t0)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
