"""Find Pluto's SPHEREx exposures from the public S3 copy of the data, without IRSA's image search.

Plan B for pluto_find.py while IRSA's metadata services (SIA, TAP, IBE search) return HTTP 502; the S3 bucket
and IRSA's file server keep working. Run from backend/:  uv run python ../scripts/pluto_scan_s3.py

1. List the Level-2 half-week folders of DR1 and QR3 in the nasa-irsa-spherex bucket and keep those in which
   Pluto's solar elongation lies between ELONG_MIN and ELONG_MAX at some time in the folder's ISO week (SPHEREx
   points at least 91 deg from the Sun, near the zenith of its dawn-dusk orbit).
2. Stage 1: for every observation in a kept folder, read the FITS header of the middle detector (D2) of its
   first exposure (one ~26 KB range read) and keep observations whose D2 centre is within STAGE1_DEG of Pluto.
3. Stage 2: read the same exposure's D1 and D3 headers; a detector is a candidate when its centre is within
   HALF_DIAG_DEG + STEP_MARGIN_DEG of Pluto (the exposures of one observation step by about 0.2 deg).
4. Stage 3: read the header of every exposure of each candidate detector and of its twin behind the dichroic
   (D1-D4, D2-D5 and D3-D6 see the same sky) and keep the images whose own TAN-SIP WCS puts Pluto, at MJD-AVG and
   seen from SPHEREx, within MARGIN_PX of the detector. pluto_find.exact_rows() then checks each exactly, reads the
   wavelength at Pluto's pixel and writes the same data/tmp/pluto/exposures.json as pluto_find.py.

Listings and the parsed stage results are cached in data/tmp/pluto/s3scan/, so a rerun resumes.
"""

from __future__ import annotations

import argparse
import json
import logging
import math
import re
import threading
import time
import warnings
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from typing import Any
from urllib.parse import quote

import httpx
import numpy as np
from astropy.io import fits
from pluto_common import EXPOSURES_JSON, WORK, save_json, spacecraft_km, track
from pluto_find import exact_rows

from pxh import config
from pxh.models import DetectorImage
from pxh.sky import horizons
from pxh.spherex import l2

log = logging.getLogger("pluto_scan_s3")

S3 = config.SPHEREX_S3_PREFIX
RELEASES = {"dr1": "spherex_dr1", "qr3": "spherex_qr3"}
ELONG_MIN, ELONG_MAX = 80.0, 140.0  # deg; generous around SPHEREx's 91-125 deg band
STAGE1_DEG = 12.0  # D2 centre to Pluto (D1/D3 centres sit ~3.95 deg from D2; half-diagonal 2.47 deg; steps)
HALF_DIAG_DEG = 2.47  # half-diagonal of a 2040 x 2040 px detector at 6.15 arcsec/px
STEP_MARGIN_DEG = 1.5  # covers the small steps between the exposures of one observation
MARGIN_PX = 30.0  # stage-3 footprint margin (~3 arcmin)
NPIX = 2040
HEADER_RANGE = (2880, 2880 + 12 * 2880 - 1)  # the IMAGE header follows a one-block primary header
SCAN = WORK / "s3scan"
NAME_RE = re.compile(r"level2_(?P<week>\d{4}W\d{2}_\d[A-Z])_(?P<obs>\d{4})_(?P<exp>\d+)D(?P<det>\d)_spx_(?P<tag>.+)\.fits$")
WEEK_RE = re.compile(r"^(?P<y>\d{4})W(?P<w>\d{2})_")
MJD0 = date(1858, 11, 17)

_local = threading.local()


def client() -> httpx.Client:
    c = getattr(_local, "client", None)
    if c is None:
        c = httpx.Client(timeout=httpx.Timeout(60.0, connect=20.0), follow_redirects=True,
                         headers={"User-Agent": "perturbation-pluto-scan"})
        _local.client = c
    return c


def _get(url: str, headers: dict[str, str] | None = None) -> httpx.Response:
    for attempt in range(6):
        try:
            r = client().get(url, headers=headers or {})
            if r.status_code in (200, 206):
                return r
            if r.status_code == 404 or r.status_code == 416:
                r.raise_for_status()
        except httpx.HTTPStatusError:
            raise
        except httpx.HTTPError as exc:
            log.debug("retry %s after %s", url, exc)
        time.sleep(min(30.0, 1.5 * 2**attempt))
    raise RuntimeError(f"S3 request failed: {url}")


def s3_list(prefix: str) -> tuple[list[tuple[str, int]], list[str]]:
    """(keys with sizes, sub-prefixes) directly under ``prefix``; cached as JSON."""
    path = SCAN / "list" / (prefix.strip("/").replace("/", "__") + ".json")
    if path.exists():
        d = json.loads(path.read_text(encoding="utf-8"))
        return [tuple(k) for k in d["keys"]], d["prefixes"]
    keys: list[tuple[str, int]] = []
    prefixes: list[str] = []
    token = None
    ns = "{http://s3.amazonaws.com/doc/2006-03-01/}"
    while True:
        url = f"{S3}?list-type=2&delimiter=/&prefix={quote(prefix, safe='')}"
        if token:
            url += f"&continuation-token={quote(token, safe='')}"
        root = ET.fromstring(_get(url).content)
        for c in root.findall(f"{ns}Contents"):
            keys.append((c.findtext(f"{ns}Key", ""), int(c.findtext(f"{ns}Size", "0"))))
        for p in root.findall(f"{ns}CommonPrefixes"):
            prefixes.append(p.findtext(f"{ns}Prefix", ""))
        if root.findtext(f"{ns}IsTruncated") == "true":
            token = root.findtext(f"{ns}NextContinuationToken")
        else:
            break
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"keys": keys, "prefixes": prefixes}), encoding="utf-8")
    return keys, prefixes


def read_header(key: str) -> str:
    """The IMAGE-extension header of a Level-2 file, as FITS header text (cached on disk)."""
    path = SCAN / "headers" / (key.rsplit("/", 1)[-1] + ".hdr")
    if path.exists():
        return path.read_text(encoding="ascii")
    lo, hi = HEADER_RANGE
    buf = b""
    while True:
        buf += _get(S3 + key, {"Range": f"bytes={lo}-{hi}"}).content
        end = l2.find_header_end(buf)
        if end is not None:
            break
        if len(buf) > 40 * 2880:
            raise RuntimeError(f"no END card in the first {len(buf)} header bytes of {key}")
        lo, hi = hi + 1, hi + 6 * 2880
    text = buf[:end].decode("ascii")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="ascii")
    return text


def header_of(key: str) -> fits.Header:
    return fits.Header.fromstring(read_header(key))


def week_span_mjd(week: str) -> tuple[float, float]:
    m = WEEK_RE.match(week)
    if not m:
        raise ValueError(week)
    monday = date.fromisocalendar(int(m["y"]), int(m["w"]), 1)
    t0 = float((monday - MJD0).days)
    return t0 - 1.0, t0 + 8.0


def pluto_at(eph: horizons.Ephemeris, mjd: float) -> tuple[float, float]:
    ra, dec = eph.interp(mjd)
    return float(ra), float(dec)


def sep_deg(ra1: float, dec1: float, ra2: float, dec2: float) -> float:
    return float(horizons.separation_arcsec(ra1, dec1, ra2, dec2)) / 3600.0


def detector_files(release: str, week: str) -> tuple[str, dict[int, dict[tuple[int, int], tuple[str, int]]]]:
    """Processing tags and {detector: {(obs, exp): (key, size)}} of one half-week folder.

    Some folders hold a main processing run and a small "l2b_retry" run; both are used. Were an exposure in
    both (none has been seen), the retry's file is kept.
    """
    _, tags = s3_list(f"{release}/level2/{week}/")
    tags = sorted(tags, key=lambda t: ("retry" in t, t))
    files: dict[int, dict[tuple[int, int], tuple[str, int]]] = {}
    n_dup = 0
    for det in range(1, 7):
        d: dict[tuple[int, int], tuple[str, int]] = {}
        for tag_prefix in tags:
            keys, _ = s3_list(f"{tag_prefix}{det}/")
            for key, size in keys:
                m = NAME_RE.search(key)
                if m and int(m["det"]) == det:
                    n_dup += (int(m["obs"]), int(m["exp"])) in d
                    d[(int(m["obs"]), int(m["exp"]))] = (key, size)
        files[det] = d
    if n_dup:
        log.warning("%s/%s: %d exposures in more than one processing run; kept the retry", release, week, n_dup)
    return "+".join(t.rstrip("/").rsplit("/", 1)[-1] for t in tags), files


def centre_and_time(key: str) -> tuple[float, float, float]:
    h = header_of(key)
    return float(h["CRVAL1"]), float(h["CRVAL2"]), float(h["MJD-AVG"])


def pluto_seen(h: fits.Header, eph: horizons.Ephemeris) -> tuple[float, float, float, float]:
    """(x, y, ra, dec): Pluto at the header's MJD-AVG, seen from SPHEREx, on the header's WCS (0-based px)."""
    mjd = float(h["MJD-AVG"])
    ra, dec = pluto_at(eph, mjd)
    delta = float(eph.interp_column("delta_au", mjd))
    sc = spacecraft_km(h)
    if sc is not None:
        ra, dec = (float(v) for v in horizons.observer_offset(ra, dec, delta, sc))
    x, y = l2.world_to_pixel(h, ra, dec)
    return x, y, ra, dec


def image_from_header(release: str, key: str, size: int, h: fits.Header) -> DetectorImage:
    col = RELEASES[release]
    obsid = str(h["OBSID"]).strip()
    det = int(h["DETECTOR"])
    mjd = float(h["MJD-AVG"])
    half = float(h.get("XPOSURE", 113.6)) / 2.0 / 86400.0
    t0 = float(h.get("MJD-BEG", mjd - half))
    t1 = float(h.get("MJD-END", mjd + half))
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        corners = l2.celestial_wcs(h).all_pix2world(
            np.array([[-0.5, -0.5], [NPIX - 0.5, -0.5], [NPIX - 0.5, NPIX - 0.5], [-0.5, NPIX - 0.5]]), 0)
    poly = "POLYGON ICRS " + " ".join(f"{a:.6f} {d:.6f}" for a, d in corners)
    m = NAME_RE.search(key)
    return DetectorImage(
        obs_id=obsid, detector=det, collection=col, publisher_did=f"ivo://irsa.ipac/{col}?{obsid}/D{det}",
        access_url=config.IRSA_IBE_SPHEREX_PREFIX + key, t_min_mjd=t0, t_max_mjd=t1,
        em_min_um=math.nan, em_max_um=math.nan, exptime_s=float(h.get("XPOSURE", math.nan)), s_region=poly,
        release_date="", file_tag=m["tag"] if m else "", est_size_kb=size // 1024, s3_key=key,
    )


def scan_folder(release: str, week: str, eph: horizons.Ephemeris, pool: ThreadPoolExecutor) -> dict[str, Any]:
    out_path = SCAN / "folders" / f"{release}_{week}.json"
    if out_path.exists():
        return json.loads(out_path.read_text(encoding="utf-8"))
    tag, files = detector_files(release, week)
    first: dict[int, int] = {}
    for obs, exp in files.get(2, {}):
        first[obs] = min(exp, first.get(obs, exp))
    keys1 = [files[2][(o, e)][0] for o, e in sorted(first.items())]
    st1 = list(pool.map(centre_and_time, keys1))
    near = []
    seps = []
    for (obs, exp), (ra, dec, mjd) in zip(sorted(first.items()), st1, strict=True):
        pr, pd = pluto_at(eph, mjd)
        s = sep_deg(ra, dec, pr, pd)
        seps.append(s)
        if s < STAGE1_DEG:
            near.append((obs, exp, mjd, s))
    # Stage 2: which detectors of the near observations could hold Pluto.
    cand: list[tuple[int, int]] = []
    jobs = []
    for obs, exp, _mjd, s2 in near:
        for det in (1, 3):
            if (obs, exp) in files.get(det, {}):
                jobs.append((obs, det, files[det][(obs, exp)][0]))
        if s2 < HALF_DIAG_DEG + STEP_MARGIN_DEG:
            cand.append((obs, 2))
    for (obs, det, _key), (ra, dec, mjd) in zip(jobs, pool.map(lambda j: centre_and_time(j[2]), jobs),
                                                strict=True):
        pr, pd = pluto_at(eph, mjd)
        if sep_deg(ra, dec, pr, pd) < HALF_DIAG_DEG + STEP_MARGIN_DEG:
            cand.append((obs, det))
    # Stage 3: every exposure of each candidate detector and its twin.
    stage3 = []
    for obs, det in sorted(set(cand)):
        for d in (det, det + 3):
            for (o, e), (key, size) in sorted(files.get(d, {}).items()):
                if o == obs:
                    stage3.append((key, size))

    def check(ks: tuple[str, int]) -> dict[str, Any] | None:
        key, size = ks
        h = header_of(key)
        x, y, _ra, _dec = pluto_seen(h, eph)
        if -MARGIN_PX <= x <= NPIX - 1 + MARGIN_PX and -MARGIN_PX <= y <= NPIX - 1 + MARGIN_PX:
            return {"key": key, "size": size, "x": x, "y": y, "mjd": float(h["MJD-AVG"])}
        return None

    hits = [r for r in pool.map(check, stage3) if r is not None]
    res = {
        "release": release, "week": week, "tag": tag, "n_obs": len(first),
        "n_files": {str(d): len(v) for d, v in files.items()},
        "min_sep_deg": float(min(seps)) if seps else None, "n_near": len(near), "n_stage3": len(stage3),
        "hits": hits,
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(res, indent=1), encoding="utf-8")
    return res


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--workers", type=int, default=24)
    ap.add_argument("--weeks", nargs="*", help="only these folders, e.g. dr1:2025W18_1B")
    ap.add_argument("--no-exact", action="store_true", help="stop after the scan (no layouts, no exposures.json)")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s",
                        datefmt="%H:%M:%S")
    for noisy in ("httpx", "httpcore", "pxh.spherex.l2"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
    warnings.filterwarnings("ignore", module="astropy")
    t0 = time.perf_counter()
    eph = track()
    lo, hi = float(eph.mjd_utc[0]), float(eph.mjd_utc[-1])
    el = eph.column("elongation_deg")

    folders = []
    skipped = []
    for release in RELEASES:
        _, weeks = s3_list(f"{release}/level2/")
        for p in weeks:
            week = p.rstrip("/").rsplit("/", 1)[-1]
            if args.weeks and f"{release}:{week}" not in args.weeks:
                continue
            a, b = week_span_mjd(week)
            sel = (eph.mjd_utc >= max(a, lo)) & (eph.mjd_utc <= min(b, hi))
            if not np.any(sel):
                skipped.append((release, week, None))
                continue
            e_lo, e_hi = float(np.min(el[sel])), float(np.max(el[sel]))
            if e_hi < ELONG_MIN or e_lo > ELONG_MAX:
                skipped.append((release, week, [e_lo, e_hi]))
                continue
            folders.append((release, week, e_lo, e_hi))
    log.info("%d half-week folders to scan (%d skipped by elongation)", len(folders), len(skipped))

    results = []
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        for release, week, e_lo, e_hi in folders:
            r = scan_folder(release, week, eph, pool)
            r["pluto_elongation_deg"] = [e_lo, e_hi]
            results.append(r)
            log.info("%s %s: %d obs, closest D2 centre %.1f deg, %d near, %d stage-3 files, %d hits",
                     release, week, r["n_obs"], r["min_sep_deg"] or -1, r["n_near"], r["n_stage3"],
                     len(r["hits"]))
    hits = [(r["release"], h) for r in results for h in r["hits"]]
    log.info("scan done: %d candidate detector images in %.0f s", len(hits), time.perf_counter() - t0)
    save_json(SCAN / "scan_summary.json", {"folders": results, "skipped": skipped})
    if args.no_exact:
        return 0

    images = []
    for release, h in hits:
        hdr = header_of(h["key"])
        images.append(image_from_header(release, h["key"], h["size"], hdr))
    rows, stats = exact_rows(images, eph, workers=8, source="s3")
    summary = {
        "ephemeris": stats.pop("ephemeris"),
        "search": {
            "method": "S3 header scan (IRSA SIA, TAP and IBE search returned HTTP 502)",
            "bucket": S3, "releases": RELEASES, "elongation_window_deg": [ELONG_MIN, ELONG_MAX],
            "stage1_deg": STAGE1_DEG, "half_diag_deg": HALF_DIAG_DEG, "step_margin_deg": STEP_MARGIN_DEG,
            "margin_px": MARGIN_PX, "n_folders_scanned": len(folders), "n_folders_skipped": len(skipped),
            "n_observations_scanned": int(sum(r["n_obs"] for r in results)),
            "n_stage3_headers": int(sum(r["n_stage3"] for r in results)),
            "n_candidates": len(images), **stats,
            "folders": [{k: r[k] for k in ("release", "week", "tag", "n_obs", "min_sep_deg", "n_near",
                                           "n_stage3", "pluto_elongation_deg")} | {"n_hits": len(r["hits"])}
                        for r in results],
        },
        "seconds": time.perf_counter() - t0,
        "exposures": rows,
    }
    save_json(EXPOSURES_JSON, summary)
    dets = {d: sum(r["detector"] == d for r in rows) for d in range(1, 7)}
    log.info("%d detector images contain Pluto (%s); %.0f s", len(rows), dets, summary["seconds"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
