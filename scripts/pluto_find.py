"""Find every SPHEREx wide-survey exposure that contains Pluto at its own mid-exposure time.

Run from backend/:  uv run python ../scripts/pluto_find.py

1. Pluto's geocentric astrometric track from JPL Horizons (6-hour steps over the SPHEREx data span).
2. A greedy cover of the track by query circles: every track point lies within COVER_DEG of a circle centre
   and each circle has radius QUERY_DEG > COVER_DEG, so a detector footprint that contains Pluto at any time
   overlaps at least one circle. IRSA's image search (SIA) is asked for every circle in every wide-survey
   Level-2 collection found at run time.
3. Candidates: Pluto's position at the image's SIA mid-time inside its s_region footprint grown by MARGIN_DEG.
4. Exact check with each file's own header: Pluto's direction at MJD-AVG (Horizons TLIST, exact times),
   moved from the geocentre to SPHEREx (X_SC, Y_SC, Z_SC), must land on the 2040 x 2040 detector through
   the file's TAN-SIP WCS. The wavelength at Pluto's pixel comes from the file's WCS-WAVE table.

Writes data/tmp/pluto/exposures.json.
"""

from __future__ import annotations

import argparse
import logging
import math
import time
import warnings
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict
from typing import Any

import numpy as np
from pluto_common import (
    EXPOSURES_JSON,
    PLUTO,
    inside_polygon,
    polygon_vertices,
    save_json,
    spacecraft_km,
    track,
)

from pxh.sky import horizons
from pxh.spherex import l2, rangeio, sia

log = logging.getLogger("pluto_find")

COVER_DEG = 0.20  # every track point is within this of a query centre
QUERY_DEG = 0.25  # SIA circle radius (> COVER_DEG)
MARGIN_DEG = 0.05  # footprint growth for the candidate test (SIA mid-time vs MJD-AVG, polygon rounding)
NPIX = 2040


def cover_centres(ra: np.ndarray, dec: np.ndarray, cover_deg: float) -> list[tuple[float, float]]:
    """Greedy cover: walk the track and start a new centre whenever no centre is within cover_deg."""
    centres: list[tuple[float, float]] = []
    for a, d in zip(ra, dec, strict=True):
        if centres:
            c = np.array(centres)
            if np.min(horizons.separation_arcsec(c[:, 0], c[:, 1], a, d)) <= cover_deg * 3600.0:
                continue
        centres.append((float(a), float(d)))
    return centres


def search(centres: list[tuple[float, float]], collections: list[str]) -> tuple[list, list[dict[str, Any]]]:
    images = []
    log_rows = []
    for i, (ra, dec) in enumerate(centres):
        results = sia.search_position(ra, dec, QUERY_DEG, collections)
        for r in results:
            log_rows.append({
                "centre": i, "ra": ra, "dec": dec, "collection": r.collection, "n": len(r.images),
                "source": r.source, "truncated": r.truncated, "error": r.error,
            })
            if r.source == "failed":
                raise RuntimeError(f"SIA failed at centre {i} for {r.collection}: {r.error}")
            if r.truncated:
                raise RuntimeError(f"SIA result truncated at centre {i} for {r.collection}")
            images.extend(r.images)
        if (i + 1) % 5 == 0 or i + 1 == len(centres):
            log.info("SIA %d/%d centres, %d rows so far", i + 1, len(centres), len(images))
    return sia.dedupe_images(images), log_rows


def exact_check(image, source: str = "ibe") -> dict[str, Any]:
    layout = l2.read_layout(image, source=source)
    hdr = layout.image_header
    mjd = float(hdr["MJD-AVG"])
    return {"image": image, "layout": layout, "header": hdr, "mjd": mjd}


def exact_rows(cands: list, eph: horizons.Ephemeris, workers: int = 6,
               source: str = "ibe") -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Exact check of candidate detector images with their own headers; one row per image that holds Pluto.

    Pluto's geocentric direction at MJD-AVG (Horizons TLIST at the exact times) is moved from the geocentre to
    SPHEREx (X_SC, Y_SC, Z_SC) and must land on the 2040 x 2040 detector through the file's TAN-SIP WCS; the
    wavelength at Pluto's pixel comes from the file's WCS-WAVE table.
    """
    with ThreadPoolExecutor(max_workers=workers) as pool:
        checked = list(pool.map(lambda im: exact_check(im, source), cands))
    mjds = [c["mjd"] for c in checked]
    exact = horizons.ephemeris_at(PLUTO, mjds) if mjds else None
    by_t = {round(float(t), 9): i for i, t in enumerate(exact.mjd_utc)} if exact is not None else {}

    rows = []
    n_off = 0
    dt_sia = []
    interp_err = []
    for c in checked:
        im, hdr, layout, mjd = c["image"], c["header"], c["layout"], c["mjd"]
        k = by_t[round(mjd, 9)]
        ra_g, dec_g = float(exact.ra_deg[k]), float(exact.dec_deg[k])
        ra_i, dec_i = eph.interp(mjd)
        interp_err.append(float(horizons.separation_arcsec(ra_g, dec_g, ra_i, dec_i)))
        delta = float(exact.column("delta_au")[k])
        sc = spacecraft_km(hdr)
        if sc is not None:
            ra_s, dec_s = (float(v) for v in horizons.observer_offset(ra_g, dec_g, delta, sc))
        else:
            ra_s, dec_s = ra_g, dec_g
        x, y = l2.world_to_pixel(hdr, ra_s, dec_s)
        on = -0.5 <= x <= NPIX - 0.5 and -0.5 <= y <= NPIX - 0.5
        dt_sia.append((mjd - 0.5 * (im.t_min_mjd + im.t_max_mjd)) * 86400.0)
        if not on:
            n_off += 1
            continue
        lam = bw = math.nan
        if layout.wave is not None:
            lam, bw = (float(v) for v in layout.wave.at(x, y))
        rows.append({
            "image": asdict(im),
            "obs_id": im.obs_id, "detector": im.detector, "collection": im.collection, "file_tag": im.file_tag,
            "access_url": im.access_url, "publisher_did": im.publisher_did, "release_date": im.release_date,
            "mjd_avg": mjd, "date_avg": str(hdr.get("DATE-AVG", "")), "exptime_s": float(hdr.get("XPOSURE", math.nan)),
            "sps_epa": float(hdr.get("SPS_EPA", math.nan)), "psf_fwhm_arcsec": float(hdr.get("PSF_FWHM", math.nan)),
            "x": float(x), "y": float(y), "edge_px": float(min(x, y, NPIX - 1 - x, NPIX - 1 - y)),
            "wavelength_um": lam, "bandwidth_um": bw,
            "ra_geo": ra_g, "dec_geo": dec_g, "ra": ra_s, "dec": dec_s,
            "parallax_shift_arcsec": float(horizons.separation_arcsec(ra_g, dec_g, ra_s, dec_s)),
            "spacecraft_km": None if sc is None else [float(v) for v in sc],
            "delta_au": delta, "r_au": float(exact.column("r_au")[k]), "vmag": float(exact.column("vmag")[k]),
            "elongation_deg": float(exact.column("elongation_deg")[k]),
            "phase_deg": float(exact.column("phase_deg")[k]),
            "rate_ra_arcsec_h": float(exact.column("dra_cosdec_arcsec_h")[k]),
            "rate_dec_arcsec_h": float(exact.column("ddec_arcsec_h")[k]),
        })
    rows.sort(key=lambda r: (r["mjd_avg"], r["detector"]))
    lo, hi = eph.mjd_utc[0], eph.mjd_utc[-1]
    path_deg = float(np.sum(horizons.separation_arcsec(eph.ra_deg[:-1], eph.dec_deg[:-1], eph.ra_deg[1:],
                                                       eph.dec_deg[1:]))) / 3600.0
    st = rangeio.stats()
    stats = {
        "ephemeris": {
            "service": horizons.API_URL, "target": eph.target, "source": eph.source, "center": eph.center,
            "command": PLUTO, "table_step": "6 h", "mjd_span": [float(lo), float(hi)], "n_rows": len(eph),
            "track_length_deg": path_deg,
            "interp_vs_exact_max_arcsec": max(interp_err) if interp_err else None,
        },
        "n_off_detector_after_exact_check": n_off, "n_on_detector": len(rows),
        "listed_minus_header_mid_time_s": [float(np.min(dt_sia)), float(np.median(dt_sia)), float(np.max(dt_sia))]
        if dt_sia else None,
        "transfer": {"requests": st.requests, "bytes": st.bytes},
    }
    return rows, stats


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--workers", type=int, default=6)
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s",
                        datefmt="%H:%M:%S")
    for noisy in ("httpx", "httpcore", "pxh.spherex.sia", "pxh.spherex.l2"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
    warnings.filterwarnings("ignore", module="astropy")
    t0 = time.perf_counter()

    eph = track()
    log.info("Horizons: %s, %s, %d rows, MJD %.2f-%.2f", eph.target, eph.source, len(eph), eph.mjd_utc[0],
             eph.mjd_utc[-1])
    path_deg = float(np.sum(horizons.separation_arcsec(eph.ra_deg[:-1], eph.dec_deg[:-1], eph.ra_deg[1:],
                                                       eph.dec_deg[1:]))) / 3600.0
    centres = cover_centres(eph.ra_deg, eph.dec_deg, COVER_DEG)
    all_cols = sia.discover_l2_collections()
    wide = [c for c in all_cols if not sia.is_deep_collection(c)]
    log.info("track %.2f deg long, %d query centres; collections %s (wide: %s)", path_deg, len(centres),
             all_cols, wide)
    images, sia_log = search(centres, wide)
    log.info("%d unique detector images overlap the query circles", len(images))

    # Candidates by footprint at the SIA mid-time.
    lo, hi = eph.mjd_utc[0], eph.mjd_utc[-1]
    cands = []
    n_bad_poly = n_outside_span = 0
    for im in images:
        tm = 0.5 * (im.t_min_mjd + im.t_max_mjd)
        if not lo <= tm <= hi:
            n_outside_span += 1
            continue
        poly = polygon_vertices(im.s_region)
        if poly is None:
            n_bad_poly += 1
            cands.append(im)  # cannot test cheaply: check exactly
            continue
        ra, dec = eph.interp(tm)
        if inside_polygon(poly, float(ra), float(dec), MARGIN_DEG):
            cands.append(im)
    log.info("%d candidates (%d without a usable polygon, %d outside the table span)", len(cands), n_bad_poly,
             n_outside_span)

    rows, stats = exact_rows(cands, eph, workers=args.workers)
    summary = {
        "ephemeris": stats.pop("ephemeris"),
        "search": {
            "method": "IRSA SIA", "cover_deg": COVER_DEG, "query_radius_deg": QUERY_DEG, "n_centres": len(centres),
            "collections_discovered": all_cols, "collections_searched": wide,
            "n_queries": len(sia_log), "n_images_overlapping": len(images), "n_candidates": len(cands),
            **stats, "per_query": sia_log,
        },
        "seconds": time.perf_counter() - t0,
        "exposures": rows,
    }
    save_json(EXPOSURES_JSON, summary)
    dets = {d: sum(r["detector"] == d for r in rows) for d in range(1, 7)}
    log.info("%d detector images contain Pluto (%s); %d candidates fell off the detector; %.0f s",
             len(rows), dets, stats["n_off_detector_after_exact_check"], summary["seconds"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
