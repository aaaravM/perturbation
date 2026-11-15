"""Build the labelled set of SPHEREx quick-look spectra for the spectral classifier.

Every spectrum is measured exactly as the API measures one (``pxh.spherex.cube``: DR1 cube, 1.5-pixel
aperture, 3-5 pixel background annulus), but many at a time: a job reads whole rows of one cube tile and
measures every catalogued source in them.

Jobs, interleaved so that a run stopped early is still balanced:

- ``random``: a 48-row band of a tile drawn at random over the sky (seeded): mostly ordinary stars, plus
  galaxies at high galactic latitude.
- ``bd`` and ``qso``: SIMBAD brown dwarfs (spectral types L/T/Y or type BD*) and quasars bright enough for
  SPHEREx; each target gets a 15-row band centred on it (other sources in those rows are measured too).
- ``yso``: the tiles richest in SIMBAD young stellar objects (YSO, T Tauri, Herbig Ae/Be, Orion variables);
  up to two 48-row bands per tile, placed where the young stars are.

Labels come from SIMBAD (object and spectral types, CfA TAP mirror) and Gaia DR3 (IRSA Gator: GSP-Phot
temperature, DSC-Combmod quasar and galaxy probabilities); see ``common.label_from_catalogues``.

    uv run python spectra/build_dataset.py plan
    uv run python spectra/build_dataset.py run --until 21:30      # Pacific time; jobs already done are skipped
    uv run python spectra/build_dataset.py merge
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import logging
import math
import sys
import threading
import time
import traceback
import warnings
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import httpx
import numpy as np
from scipy.spatial import cKDTree

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import (  # noqa: E402
    DATA,
    EPOCH_SPHEREX,
    ISOLATION_ARCSEC,
    ISOLATION_DMAG,
    JOBS,
    SEED,
    SNR_MIN,
    YSO_OTYPES,
    label_from_catalogues,
)

from pxh import config  # noqa: E402
from pxh.api.catalogs import parse_ipac_table  # noqa: E402
from pxh.spherex import cube, rangeio  # noqa: E402

log = logging.getLogger("build_dataset")
PT = ZoneInfo("America/Los_Angeles")

N_RANDOM = 260
RANDOM_ROWS = 48
TARGET_HALF_ROWS = 7
YSO_TILES = 30
YSO_BAND_ROWS = 48
G_MAX_CANDIDATE = 18.5
MAX_CANDIDATES = 1200
G_MAX_NEIGHBOUR = 20.5
KEEP_MIN_SNR5 = 10  # spectra with fewer channels at S/N >= 5 are not stored
GAIA_COLUMNS = (
    "source_id,ra,dec,phot_g_mean_mag,bp_rp,teff_gspphot,classprob_dsc_combmod_quasar,"
    "classprob_dsc_combmod_galaxy,pmra,pmdec,parallax"
)
_SIMBAD_LOCK = threading.BoundedSemaphore(2)


# --- archive queries ----------------------------------------------------------------------------------------


def simbad_tap(adql: str, timeout: float = 120.0) -> list[dict[str, str]]:
    """Rows of a SIMBAD TAP query (CSV), trying the CfA then the IDIA mirror, with retries."""
    last: Exception | None = None
    for attempt in range(4):
        for mirror in config.SIMBAD_TAP_MIRRORS[:2]:
            try:
                with _SIMBAD_LOCK:
                    r = httpx.post(
                        mirror,
                        data={"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "csv", "QUERY": adql},
                        headers={"User-Agent": config.USER_AGENT},
                        timeout=timeout,
                    )
                if r.status_code == 200 and not r.text.lstrip().startswith("<"):
                    return list(csv.DictReader(io.StringIO(r.text)))
                last = RuntimeError(f"SIMBAD {mirror}: HTTP {r.status_code} {r.text[:200]!r}")
            except httpx.HTTPError as exc:
                last = exc
        time.sleep(2.0 * (attempt + 1))
    raise RuntimeError(f"SIMBAD TAP failed: {last}")


def gator_polygon(poly: list[tuple[float, float]], gmax: float) -> list[dict]:
    """Gaia DR3 sources (G < gmax) inside a sky polygon, from IRSA Gator (cached on disk)."""
    key = ";".join(f"{a:.6f},{b:.6f}" for a, b in poly) + f";{gmax:.1f}"
    path = DATA / "gaia" / f"{hashlib.sha1(key.encode()).hexdigest()[:20]}.tbl"
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        text = None
    if text is None:
        params = {
            "catalog": "gaia_dr3_source",
            "spatial": "Polygon",
            "polygon": ", ".join(f"{a:.6f} {b:+.6f}" for a, b in poly),
            "outfmt": "1",
            "outrows": "200000",
            "selcols": GAIA_COLUMNS,
            "constraints": f"phot_g_mean_mag<{gmax:.1f}",
        }
        body = rangeio.http_get(config.IRSA_GATOR_URL, params=params, max_bytes=256 << 20)
        text = body.decode("utf-8", "replace")
        if "|" not in text:
            raise RuntimeError(f"unexpected Gator answer: {text[:200]!r}")
        rangeio.save_cache_file(path, text.encode("utf-8"))
    return parse_ipac_table(text)


def simbad_polygon(poly: list[tuple[float, float]]) -> list[dict[str, str]]:
    verts = ", ".join(f"{a:.6f}, {b:.6f}" for a, b in poly)
    adql = (
        "SELECT TOP 50000 b.main_id, b.ra, b.dec, b.otype, b.sp_type, b.pmra, b.pmdec, f.J, f.K, f.G "
        "FROM basic AS b LEFT OUTER JOIN allfluxes AS f ON f.oidref = b.oid "
        f"WHERE CONTAINS(POINT('ICRS', b.ra, b.dec), POLYGON('ICRS', {verts})) = 1 "
        "AND (f.K < 15.5 OR f.J < 16.5 OR f.G < 19.5 OR f.V < 19.5) "
        "AND (b.otype <> '*' OR b.sp_type IS NOT NULL)"
    )
    return simbad_tap(adql)


# --- geometry ---------------------------------------------------------------------------------------------------


def unit(ra: np.ndarray, dec: np.ndarray) -> np.ndarray:
    r, d = np.radians(ra), np.radians(dec)
    return np.stack([np.cos(d) * np.cos(r), np.cos(d) * np.sin(r), np.sin(d)], axis=-1)


def chord(arcsec: float) -> float:
    return 2.0 * math.sin(math.radians(arcsec / 3600.0) / 2.0)


def propagate(ra, dec, pmra, pmdec, years: float) -> tuple[np.ndarray, np.ndarray]:
    """Linear proper-motion step (mas/yr; pmra includes cos dec). Missing motions count as zero."""
    ra = np.asarray(ra, dtype=float)
    dec = np.asarray(dec, dtype=float)
    pmra = np.nan_to_num(np.asarray(pmra, dtype=float))
    pmdec = np.nan_to_num(np.asarray(pmdec, dtype=float))
    dec2 = dec + pmdec * years / 3.6e6
    ra2 = ra + pmra * years / 3.6e6 / np.maximum(np.cos(np.radians(dec)), 1e-6)
    return np.mod(ra2, 360.0), dec2


def band_polygon(meta: cube.CubeMeta, ya: int, yb: int, pad: float = 3.0) -> list[tuple[float, float]]:
    """Sky quadrilateral (deg) around tile rows ya..yb, padded by `pad` pixels on every side.

    Gator refuses polygons of more than a few vertices, so only the four corners are used; the padding
    covers the difference between the great-circle edges and the curved pixel rows (candidates are at least
    six pixels inside the band, and their 20-arcsec neighbourhoods stay inside the padded polygon).
    """
    nx = meta.shape[2]
    wcs = meta.celestial_wcs()
    corners = []
    for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
        for p in (pad, pad / 2, 0.0):  # outside the tile the HPX projection can be undefined (NaN)
            x = -0.5 - p if sx < 0 else nx - 0.5 + p
            y = ya - 0.5 - p if sy < 0 else yb + 0.5 + p
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                a, b = wcs.all_pix2world([[x, y]], 0)[0]
            if np.isfinite(a) and np.isfinite(b):
                corners.append((float(a) % 360.0, float(b)))
                break
        else:
            raise RuntimeError(f"band corner outside the projection: tile {meta.npix} rows {ya}-{yb}")
    return corners


def to_pixels(meta: cube.CubeMeta, ra: np.ndarray, dec: np.ndarray) -> np.ndarray:
    wcs = meta.celestial_wcs()
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        return wcs.all_world2pix(np.stack([ra, dec], axis=1), 0) if len(ra) else np.zeros((0, 2))


def tile_url(npix: int) -> str:
    doc = cube._read_template(cube.DEFAULT_COLLECTION, 5)
    return cube.tile_url_from_prefix(doc["prefix"] if doc else _prefix(), npix)


def _prefix() -> str:
    t = cube.find_cube_tile(10.0, 10.0)
    m = cube._TILE_URL_RE.match(t.url)
    assert m is not None
    return m.group("prefix")


# --- planning -----------------------------------------------------------------------------------------------


def rare_lists() -> dict[str, list[dict]]:
    """SIMBAD brown dwarfs, quasars and young stars bright enough for SPHEREx (cached as JSON)."""
    path = DATA / "rare_targets.json"
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    cols = "b.main_id, b.ra, b.dec, b.otype, b.sp_type, b.pmra, b.pmdec, f.J, f.K, f.G"
    join = "FROM basic AS b JOIN allfluxes AS f ON f.oidref = b.oid"
    out = {
        "bd": simbad_tap(
            f"SELECT {cols} {join} WHERE (b.otype = 'BD*' OR b.sp_type LIKE 'L%' OR b.sp_type LIKE 'T%' "
            "OR b.sp_type LIKE 'Y%') AND (f.K < 14.5 OR f.J < 15.5)"
        ),
        "qso": simbad_tap(f"SELECT {cols} {join} WHERE b.otype = 'QSO' AND (f.K < 14.5 OR f.G < 17.5)"),
        "yso": simbad_tap(
            f"SELECT {cols} {join} WHERE b.otype IN ({', '.join(repr(t) for t in sorted(YSO_OTYPES))}) "
            "AND f.K < 12.5"
        ),
    }
    rangeio.write_atomic(path, json.dumps(out).encode("utf-8"))
    return out


def _f(v) -> float:
    try:
        x = float(v)
    except (TypeError, ValueError):
        return float("nan")
    return x


def plan(seed: int = SEED) -> list[dict]:
    path = DATA / "plan.json"
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    rng = np.random.default_rng(seed)
    lists = rare_lists()
    jobs: dict[str, list[dict]] = {"random": [], "bd": [], "qso": [], "yso": []}
    for npix in rng.choice(12 * 4**5, size=N_RANDOM, replace=False):
        y0 = int(rng.integers(0, 512 - RANDOM_ROWS + 1))
        jobs["random"].append({"kind": "random", "npix": int(npix), "bands": [[y0, y0 + RANDOM_ROWS - 1]]})
    for kind in ("bd", "qso", "yso"):
        rows = lists[kind]
        ra = np.array([_f(r["ra"]) for r in rows])
        dec = np.array([_f(r["dec"]) for r in rows])
        ra, dec = propagate(ra, dec, [_f(r["pmra"]) for r in rows], [_f(r["pmdec"]) for r in rows],
                            EPOCH_SPHEREX - 2000.0)
        by_tile: dict[int, list[dict]] = {}
        for r, a, d in zip(rows, ra, dec, strict=True):
            if not (np.isfinite(a) and np.isfinite(d)):
                continue
            t = dict(r, ra_now=float(a), dec_now=float(d), kind=kind)
            by_tile.setdefault(cube.healpix_tile(float(a), float(d)), []).append(t)
        if kind == "yso":
            best = sorted(by_tile.items(), key=lambda kv: -len(kv[1]))[:YSO_TILES]
            for npix, targets in best:
                jobs["yso"].append({"kind": "yso", "npix": int(npix), "targets": targets})
        else:
            items = list(by_tile.items())
            order = rng.permutation(len(items))
            for i in order:
                npix, targets = items[i]
                jobs[kind].append({"kind": kind, "npix": int(npix), "targets": targets})
    # interleave: bd, qso, random, yso (while it lasts), random, ...
    seq: list[dict] = []
    queues = {k: list(v) for k, v in jobs.items()}
    pattern = ["bd", "qso", "random", "bd", "yso", "random", "qso", "bd", "random"]
    while any(queues.values()):
        for k in pattern:
            if queues[k]:
                seq.append(queues[k].pop(0))
    for i, job in enumerate(seq):
        job["id"] = f"{i:04d}_{job['kind']}_{job['npix']}"
    rangeio.write_atomic(path, json.dumps(seq).encode("utf-8"))
    counts = {k: len(v) for k, v in jobs.items()}
    print(f"plan: {len(seq)} jobs {counts}; rare targets " + str({k: len(v) for k, v in lists.items()}))
    return seq


# --- one job ------------------------------------------------------------------------------------------------


def _bands_for_targets(meta: cube.CubeMeta, job: dict) -> list[tuple[int, int]]:
    ny = meta.shape[1]
    t = job.get("targets") or []
    if not t:
        return [tuple(b) for b in job["bands"]]
    pix = to_pixels(meta, np.array([x["ra_now"] for x in t]), np.array([x["dec_now"] for x in t]))
    ys = [int(math.floor(y + 0.5)) for _, y in pix if np.isfinite(y) and -0.5 <= y < ny - 0.5]
    if not ys:
        return []
    if job["kind"] == "yso":
        bands: list[tuple[int, int]] = []
        left = sorted(ys)
        for _ in range(2):
            if not left:
                break
            best = max(range(0, ny - YSO_BAND_ROWS + 1, 4),
                       key=lambda y0: sum(y0 + 6 <= y <= y0 + YSO_BAND_ROWS - 7 for y in left))
            bands.append((best, best + YSO_BAND_ROWS - 1))
            left = [y for y in left if not (best + 6 <= y <= best + YSO_BAND_ROWS - 7)]
        return cube._merge_intervals(bands)
    return cube._merge_intervals(
        [(max(0, y - TARGET_HALF_ROWS), min(ny - 1, y + TARGET_HALF_ROWS)) for y in ys]
    )


def run_job(job: dict) -> dict:
    out_npz = JOBS / f"{job['id']}.npz"
    if out_npz.exists():
        return {"id": job["id"], "skipped": True}
    t0 = time.perf_counter()
    url = tile_url(job["npix"])
    with rangeio.track() as st:
        meta = cube.read_cube_meta(url)
        _, ny, nx = meta.shape
        bands = _bands_for_targets(meta, job)
        gaia: list[dict] = []
        simbad: list[dict] = []
        for ya, yb in bands:
            poly = band_polygon(meta, ya, yb)
            gaia += gator_polygon(poly, G_MAX_NEIGHBOUR)
            simbad += simbad_polygon(poly)
    t_cat = time.perf_counter() - t0
    # de-duplicate (bands of one job may touch)
    gaia = list({str(g["source_id"]): g for g in gaia}.values())
    simbad = list({s["main_id"]: s for s in simbad}.values())
    g_ra, g_dec = propagate([g["ra"] for g in gaia], [g["dec"] for g in gaia], [g.get("pmra") for g in gaia],
                            [g.get("pmdec") for g in gaia], EPOCH_SPHEREX - 2016.0)
    g_mag = np.array([_f(g.get("phot_g_mean_mag")) for g in gaia])
    s_ra, s_dec = propagate([_f(s["ra"]) for s in simbad], [_f(s["dec"]) for s in simbad],
                            [_f(s["pmra"]) for s in simbad], [_f(s["pmdec"]) for s in simbad],
                            EPOCH_SPHEREX - 2000.0)
    # SIMBAD <-> Gaia by position at the SPHEREx epoch (1.5 arcsec)
    g_tree = cKDTree(unit(g_ra, g_dec)) if len(gaia) else None
    s_match = np.full(len(simbad), -1)
    if g_tree is not None and len(simbad):
        d, idx = g_tree.query(unit(s_ra, s_dec), distance_upper_bound=chord(1.5))
        s_match = np.where(np.isfinite(d), idx, -1)
    g_simbad: dict[int, int] = {}
    for si, gi in enumerate(s_match):
        if gi >= 0 and (gi not in g_simbad or simbad[si]["otype"] != "*"):
            g_simbad[int(gi)] = si
    targets = {t["main_id"] for t in job.get("targets") or []}
    cands: list[dict] = []
    for gi, g in enumerate(gaia):
        si = g_simbad.get(gi)
        s = simbad[si] if si is not None else None
        if not (g_mag[gi] < G_MAX_CANDIDATE or (s is not None and s["main_id"] in targets)):
            continue
        cands.append({"ra": float(g_ra[gi]), "dec": float(g_dec[gi]), "gaia": g, "simbad": s})
    for si, s in enumerate(simbad):
        if s_match[si] >= 0 or not np.isfinite(s_ra[si]):
            continue
        k = _f(s.get("K"))
        j = _f(s.get("J"))
        if s["main_id"] in targets or k < 15.0 or j < 16.0:
            cands.append({"ra": float(s_ra[si]), "dec": float(s_dec[si]), "gaia": None, "simbad": s})
    # keep sources whose whole photometry box lies in the bands read
    pix = to_pixels(meta, np.array([c["ra"] for c in cands]), np.array([c["dec"] for c in cands]))
    keep = []
    for c, (x, y) in zip(cands, pix, strict=True):
        if not (np.isfinite(x) and np.isfinite(y)):
            continue
        xc, yc = math.floor(x + 0.5), math.floor(y + 0.5)
        if not (6 <= xc <= nx - 7):
            continue
        if any(ya + 6 <= yc <= yb - 6 for ya, yb in bands):
            c["x"], c["y"] = float(x), float(y)
            keep.append(c)
    if len(keep) > MAX_CANDIDATES:
        # crowded fields: keep every SIMBAD-typed source and hot star, then a seeded sample of the rest
        def priority(c: dict) -> int:
            s, g = c["simbad"], c["gaia"]
            if s is not None and (s["main_id"] in targets or s.get("otype") not in ("*", "") or s.get("sp_type")):
                return 0
            if g is not None and (_f(g.get("teff_gspphot")) > 7500 or _f(g.get("classprob_dsc_combmod_galaxy")) > 0.5
                                  or _f(g.get("classprob_dsc_combmod_quasar")) > 0.5):
                return 0
            return 1
        first = [c for c in keep if priority(c) == 0]
        rest = [c for c in keep if priority(c) == 1]
        rng = np.random.default_rng(SEED + job["npix"])
        pick = rng.permutation(len(rest))[: max(0, MAX_CANDIDATES - len(first))]
        keep = first + [rest[i] for i in sorted(pick)]
    t1 = time.perf_counter()
    with rangeio.track() as st2:
        specs = cube.cube_spectra([(c["ra"], c["dec"]) for c in keep], tile_url=url) if keep else []
    t_read = time.perf_counter() - t1
    # isolation: no Gaia source brighter than (reference magnitude + 2) within 20 arcsec
    rows_meta: list[dict] = []
    flux, err, part, lower = [], [], [], []
    for c, sp in zip(keep, specs, strict=True):
        if sp is None:
            continue
        f = np.asarray(sp["flux_ujy"], dtype=float)
        e = np.asarray(sp["flux_err_ujy"], dtype=float)
        with np.errstate(invalid="ignore", divide="ignore"):
            snr = f / e
        n_snr5 = int(np.sum(np.isfinite(snr) & (snr >= SNR_MIN)))
        s = c["simbad"]
        is_target = s is not None and s["main_id"] in targets
        if n_snr5 < KEEP_MIN_SNR5 and not is_target:
            continue
        g = c["gaia"]
        gm = _f(g.get("phot_g_mean_mag")) if g else float("nan")
        kmag = _f(s.get("K")) if s else float("nan")
        m_ref = np.nanmin([gm, kmag + 3.5]) if np.isfinite(gm) or np.isfinite(kmag) else 99.0
        n_nb = 0
        bright_nb = 99.0
        if g_tree is not None:
            for gi in g_tree.query_ball_point(unit(np.array([c["ra"]]), np.array([c["dec"]]))[0],
                                              chord(ISOLATION_ARCSEC)):
                if g is not None and str(gaia[gi]["source_id"]) == str(g["source_id"]):
                    continue
                if np.isfinite(g_mag[gi]):
                    bright_nb = min(bright_nb, float(g_mag[gi]))
                    if g_mag[gi] < m_ref + ISOLATION_DMAG:
                        n_nb += 1
        label, source = label_from_catalogues(
            s.get("otype") if s else None, s.get("sp_type") if s else None,
            g.get("teff_gspphot") if g else None,
            g.get("classprob_dsc_combmod_quasar") if g else None,
            g.get("classprob_dsc_combmod_galaxy") if g else None,
        )
        rows_meta.append({
            "job": job["id"], "kind": job["kind"], "npix": job["npix"], "x": c["x"], "y": c["y"],
            "ra": c["ra"], "dec": c["dec"],
            "source_id": str(g["source_id"]) if g else "",
            "g": gm, "bp_rp": _f(g.get("bp_rp")) if g else float("nan"),
            "teff": _f(g.get("teff_gspphot")) if g else float("nan"),
            "p_qso": _f(g.get("classprob_dsc_combmod_quasar")) if g else float("nan"),
            "p_gal": _f(g.get("classprob_dsc_combmod_galaxy")) if g else float("nan"),
            "parallax": _f(g.get("parallax")) if g else float("nan"),
            "simbad_id": s["main_id"] if s else "", "otype": s.get("otype", "") if s else "",
            "sp_type": s.get("sp_type", "") if s else "", "j": _f(s.get("J")) if s else float("nan"),
            "k": kmag, "label": label or "", "label_source": source, "is_target": bool(is_target),
            "m_ref": float(m_ref), "n_neighbours": n_nb, "brightest_neighbour_g": bright_nb,
            "n_finite": int(sp["n_finite"]), "n_lower": int(sp["n_lower_limit"]), "n_snr5": n_snr5,
            "edge": bool(sp["edge"]),
        })
        flux.append(np.asarray(sp["flux_ujy"], dtype=np.float32))
        err.append(np.asarray(sp["flux_err_ujy"], dtype=np.float32))
        part.append(np.asarray(sp["flux_partial_ujy"], dtype=np.float32))
        lower.append(np.asarray(sp["lower_limit"], dtype=bool))
    n = len(rows_meta)
    arrays = {
        "flux": np.stack(flux) if n else np.zeros((0, 102), np.float32),
        "err": np.stack(err) if n else np.zeros((0, 102), np.float32),
        "partial": np.stack(part) if n else np.zeros((0, 102), np.float32),
        "lower": np.stack(lower) if n else np.zeros((0, 102), bool),
        "wavelength_um": np.asarray(meta.wavelength_um, dtype=np.float64),
    }
    (JOBS / f"{job['id']}.json").write_text(json.dumps(rows_meta), encoding="utf-8")
    buf = io.BytesIO()
    np.savez_compressed(buf, **arrays)
    rangeio.write_atomic(out_npz, buf.getvalue())
    return {
        "id": job["id"], "n_gaia": len(gaia), "n_simbad": len(simbad), "n_cand": len(keep), "n_kept": n,
        "bands": bands, "s_cat": round(t_cat, 1), "s_read": round(t_read, 1),
        "mb": round((st.bytes + st2.bytes) / 1e6, 1), "requests": st.requests + st2.requests,
    }


def run(until: str | None, workers: int, limit: int | None) -> None:
    JOBS.mkdir(parents=True, exist_ok=True)
    jobs = plan()
    if limit:
        jobs = jobs[:limit]
    deadline = None
    if until:
        hh, mm = (int(v) for v in until.split(":"))
        now = datetime.now(PT)
        deadline = now.replace(hour=hh, minute=mm, second=0, microsecond=0).timestamp()
    stats_path = DATA / "run_log.jsonl"
    lock = threading.Lock()
    done = [0]
    t_start = time.time()

    def work(job: dict) -> None:
        if deadline and time.time() > deadline:
            return
        try:
            res = run_job(job)
        except Exception as exc:  # noqa: BLE001 - log and continue with the next job
            res = {"id": job["id"], "error": f"{type(exc).__name__}: {exc}"[:400]}
            log.debug(traceback.format_exc())
        with lock:
            done[0] += 1
            if not res.get("skipped"):
                with stats_path.open("a", encoding="utf-8") as fh:
                    fh.write(json.dumps(res) + "\n")
                print(f"[{done[0]}/{len(jobs)} {time.time() - t_start:.0f}s] {json.dumps(res)}", flush=True)

    with ThreadPoolExecutor(max_workers=workers) as ex:
        list(ex.map(work, jobs))


def merge() -> None:
    metas: list[dict] = []
    arrays: dict[str, list[np.ndarray]] = {"flux": [], "err": [], "partial": [], "lower": []}
    wl = None
    for npz in sorted(JOBS.glob("*.npz")):
        rows = json.loads(npz.with_suffix(".json").read_text(encoding="utf-8"))
        with np.load(npz) as z:
            if len(rows) != len(z["flux"]):
                continue
            for k in arrays:
                arrays[k].append(z[k])
            wl = z["wavelength_um"]
        metas.extend(rows)
    out = {k: np.concatenate(v) if v else np.zeros((0, 102)) for k, v in arrays.items()}
    out["wavelength_um"] = wl
    np.savez_compressed(DATA / "spectra.npz", **out)
    (DATA / "spectra_meta.json").write_text(json.dumps(metas), encoding="utf-8")
    import collections

    labels = collections.Counter(m["label"] or "(none)" for m in metas)
    print(f"merged {len(metas)} spectra from {len(list(JOBS.glob('*.npz')))} jobs: {dict(labels)}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("stage", choices=["plan", "run", "merge"])
    ap.add_argument("--until", default=None, help="HH:MM Pacific time: start no job after this")
    ap.add_argument("--workers", type=int, default=3)
    ap.add_argument("--limit", type=int, default=None)
    args = ap.parse_args()
    logging.basicConfig(level=logging.WARNING, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    DATA.mkdir(parents=True, exist_ok=True)
    if args.stage == "plan":
        plan()
    elif args.stage == "run":
        run(args.until, args.workers, args.limit)
    else:
        merge()


if __name__ == "__main__":
    main()
