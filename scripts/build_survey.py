"""Build the survey dataset that the mover finder trains and runs on (see ml/README.md, "Survey data").

Run from backend/ (the uv project):

    uv run python ../scripts/build_survey.py                  # every field of ml/survey_fields.json
    uv run python ../scripts/build_survey.py --only rw-aur    # some fields (comma-separated ids)
    uv run python ../scripts/build_survey.py --retry-failed   # also retry fields marked failed

For each field of ml/survey_fields.json, in list order, and at most ``--workers`` (2) fields at once, each in
its own process (so each process keeps to ``config.IRSA_MAX_CONCURRENCY`` IRSA requests in flight):

1. ``pxh.api.field.index_field``: SIA search and epochs, exactly as the live API (/api/field/summary).
2. Catalogues (``catalogs.json``): Gaia DR3 (IRSA Gator ``gaia_dr3_source``, G < 21, positions at 2016.0),
   CatWISE2020 (IRSA Gator ``catwise_2020``) and SIMBAD (TAP, CfA then IDIA mirror), within 9 arcmin of
   the centre, which covers the grid corners (7.1 arcmin) plus 100 arcsec of motion since 2016.
3. Per detector, D6, D5, D4, D3 first (then D2 and D1 for targets and variables): the images are picked,
   read and reprojected exactly as the live build (``pxh.api.field``: at most 48 images per detector, at
   most 12 per epoch, evenly spread in time; zodiacal light subtracted, science mask and OVERFLOW masked;
   inverse-variance co-add per epoch), and written to ``data/survey/<id>/D<n>.npz`` (``survey_io``).
   Images that fail are retried once after a pause. Each image's headers (its "layout", about 180 KB) are
   read first from the public AWS S3 mirror of the same files, which keeps about 40% of the requests off
   IRSA; the pixel stamps come from IRSA's file server, as in the live API.

Resumable: detectors already on disk are skipped, so a stopped run continues where it left off. A field
fails after two failed attempts (index or detector) and is marked failed with the error. Progress goes to
``data/survey/log.txt`` and ``data/survey/fields.json``; the field list is re-read between fields, so fields
added to ml/survey_fields.json while this runs are picked up.
"""

from __future__ import annotations

import argparse
import json
import logging
import math
import os
import sys
import time
import traceback
from collections import defaultdict
from concurrent.futures import FIRST_COMPLETED, Future, ProcessPoolExecutor, ThreadPoolExecutor, wait
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import numpy as np

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "ml"))
import survey_io as sio  # shared format definition, next to the models

FIELDS_FILE = REPO / "ml" / "survey_fields.json"
CORE_DETS = (6, 5, 4, 3)
EXTRA_DETS = (2, 1)
EXTRA_KINDS = ("target", "variable")
MAX_IMAGES = 48  # per detector build, as the live API (PXH_MAX_IMAGES default)
MAX_IMAGES_PER_EPOCH = 12  # as the live API (PXH_MAX_IMAGES_PER_EPOCH default)
IMAGE_WORKERS = 8
LAYOUT_WORKERS = 8  # S3 mirror requests in flight (rangeio caps them at 8 per process)
PER_EPOCH = (
    "epoch_index", "epoch_mjd", "epoch_start_mjd", "epoch_end_mjd", "epoch_label", "survey", "year", "pa", "full",
    "wl_min_um", "wl_max_um", "wl_center_um", "psf_fwhm_arcsec", "n_images", "n_available", "coverage_fraction",
)
DETECTOR_BUDGET_S = 900.0
RETRY_PAUSE_S = 30.0
ATTEMPTS = 2
CATALOG_RADIUS_ARCSEC = 540.0
GAIA_COLUMNS = (
    "source_id,ra,dec,ra_error,dec_error,pmra,pmra_error,pmdec,pmdec_error,parallax,parallax_error,"
    "phot_g_mean_mag,bp_rp,ruwe"
)
CATWISE_COLUMNS = (
    "source_name,ra,dec,sigra,sigdec,meanobsmjd,ra_pm,dec_pm,sigra_pm,sigdec_pm,pmra,pmdec,sigpmra,sigpmdec,"
    "w1mpro,w1sigmpro,w2mpro,w2sigmpro,ab_flags,cc_flags,nb"
)
SIMBAD_COLUMNS = "main_id, otype, sp_type, ra, dec, pmra, pmdec, plx_value"
CREDITS = (
    "SPHEREx data: NASA/JPL-Caltech, from the NASA/IPAC Infrared Science Archive (IRSA): DR1 "
    "(doi:10.26131/IRSA678) and Quick Release 3. Gaia DR3 (ESA/Gaia/DPAC) and CatWISE2020 via IRSA Gator; "
    "SIMBAD (CDS, Strasbourg) via its CfA/IDIA mirrors."
)

log = logging.getLogger("survey")


def utc_now() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def setup_logging(root: Path) -> None:
    root.mkdir(parents=True, exist_ok=True)
    handler = logging.FileHandler(root / "log.txt", mode="a", encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(asctime)s %(processName)s %(levelname)s %(name)s: %(message)s"))
    top = logging.getLogger()
    if not any(isinstance(h, logging.FileHandler) for h in top.handlers):
        top.addHandler(handler)
    top.setLevel(logging.WARNING)
    for name in ("survey", "pxh.api.field"):
        logging.getLogger(name).setLevel(logging.INFO)


def load_field_list() -> dict[str, Any]:
    for attempt in range(20):  # scripts/survey_fields.py may be replacing the file right now
        try:
            return json.loads(FIELDS_FILE.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, PermissionError, FileNotFoundError):
            if attempt == 19:
                raise
            time.sleep(0.5)
    raise AssertionError("unreachable")


def read_status(root: Path, field_id: str) -> dict[str, Any] | None:
    try:
        return json.loads((root / field_id / "status.json").read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def planned_dets(entry: dict[str, Any], with_extra: bool) -> list[int]:
    dets = list(CORE_DETS)
    if with_extra and entry["kind"] in EXTRA_KINDS:
        dets += list(EXTRA_DETS)
    return dets


# --- catalogues (run in the worker) -----------------------------------------------------------------------


def parse_ipac(text: str) -> list[dict[str, Any]]:
    """IPAC table rows; columns typed 'char' stay strings, others become int/float, 'null' None."""
    names: list[str] | None = None
    types: list[str] | None = None
    rows: list[dict[str, Any]] = []
    for line in text.splitlines():
        if line.startswith("\\"):
            continue
        if line.startswith("|"):
            cells = [c.strip() for c in line.strip().strip("|").split("|")]
            if names is None:
                names = cells
            elif types is None:
                types = cells
            continue
        if names is None or not line.strip():
            continue
        values = line.split()
        if len(values) < len(names):
            continue
        row: dict[str, Any] = {}
        for i, (name, raw) in enumerate(zip(names, values, strict=False)):
            if raw == "null":
                row[name] = None
            elif types is not None and types[i] in ("char", "c"):
                row[name] = raw
            else:
                try:
                    row[name] = int(raw)
                except ValueError:
                    try:
                        value = float(raw)
                        row[name] = value if math.isfinite(value) else None
                    except ValueError:
                        row[name] = raw
        rows.append(row)
    return rows


def gator(catalog: str, columns: str, ra: float, dec: float, radius_arcsec: float, constraints: str | None) -> list[dict]:
    from pxh import config
    from pxh.spherex import rangeio

    params = {
        "catalog": catalog,
        "spatial": "cone",
        "radius": f"{radius_arcsec:.1f}",
        "radunits": "arcsec",
        "objstr": f"{ra:.6f} {dec:+.6f}",
        "outfmt": "1",
        "outrows": "200000",
        "selcols": columns,
    }
    if constraints:
        params["constraints"] = constraints
    text = rangeio.http_get(config.IRSA_GATOR_URL, params=params, max_bytes=256 << 20).decode("utf-8", "replace")
    if "|" not in text:
        raise RuntimeError(f"unexpected answer from IRSA Gator ({catalog}): {text[:200]!r}")
    return parse_ipac(text)


def simbad_cone(ra: float, dec: float, radius_deg: float) -> tuple[list[dict], str]:
    import httpx

    from pxh import config

    adql = (
        f"SELECT TOP 20000 {SIMBAD_COLUMNS} FROM basic WHERE CONTAINS(POINT('ICRS', ra, dec), "
        f"CIRCLE('ICRS', {ra:.6f}, {dec:+.6f}, {radius_deg:.6f})) = 1"
    )
    form = {"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "json", "QUERY": adql}
    problems = []
    for mirror in config.SIMBAD_TAP_MIRRORS[:2]:  # CfA, IDIA (CDS Strasbourg is degraded)
        for attempt in range(2):
            try:
                resp = httpx.post(mirror, data=form, headers={"User-Agent": config.USER_AGENT}, timeout=90.0)
                if resp.status_code != 200:
                    raise RuntimeError(f"HTTP {resp.status_code}")
                doc = resp.json()
                names = [c["name"] for c in doc["metadata"]]
                return [dict(zip(names, row, strict=False)) for row in doc["data"]], mirror
            except Exception as exc:  # noqa: BLE001 - try again, then the next mirror
                problems.append(f"{mirror.split('/')[2]}: {exc!r}"[:200])
                time.sleep(3.0 * (attempt + 1))
    raise RuntimeError("no SIMBAD mirror answered: " + "; ".join(problems))


def fetch_catalogs(entry: dict[str, Any]) -> dict[str, Any]:
    ra, dec = float(entry["ra"]), float(entry["dec"])
    r = CATALOG_RADIUS_ARCSEC
    doc: dict[str, Any] = {
        "schema": "pxh-survey-catalogs/1",
        "field_id": entry["id"],
        "center": {"ra": ra, "dec": dec},
        "radius_arcsec": r,
        "retrieved_at": utc_now(),
        "meta": {},
    }
    gaia = gator("gaia_dr3_source", GAIA_COLUMNS, ra, dec, r, "phot_g_mean_mag<21")
    for row in gaia:
        row["source_id"] = str(row.get("source_id"))
    doc["gaia"] = gaia
    doc["meta"]["gaia"] = {
        "source": "Gaia DR3 via IRSA Gator (gaia_dr3_source)", "epoch": 2016.0, "constraint": "phot_g_mean_mag < 21",
        "units": "ra/dec deg; ra_error/dec_error mas; pm mas/yr; parallax mas", "n": len(gaia),
    }
    cw = gator("catwise_2020", CATWISE_COLUMNS, ra, dec, r, None)
    doc["catwise"] = cw
    doc["meta"]["catwise"] = {
        "source": "CatWISE2020 via IRSA Gator (catwise_2020)",
        "epoch": "ra/dec at meanobsmjd (stationary fit); ra_pm/dec_pm at MJD 57170.0 (2015.405, motion fit)",
        "units": "ra/dec deg; sig* arcsec; pmra/pmdec arcsec/yr; w1mpro/w2mpro Vega mag", "n": len(cw),
    }
    simbad, mirror = simbad_cone(ra, dec, r / 3600.0)
    doc["simbad"] = simbad
    doc["meta"]["simbad"] = {
        "source": f"SIMBAD TAP basic table via {mirror.split('/')[2]}", "epoch": "ra/dec J2000 epoch (ICRS)",
        "units": "ra/dec deg; pm mas/yr; plx_value mas", "n": len(simbad),
    }
    return doc


# --- one detector (run in the worker) ---------------------------------------------------------------------


def _psf_fwhm(image: Any) -> float:
    from pxh.spherex import l2

    try:
        value = float(l2.read_layout(image).image_header.get("PSF_FWHM", float("nan")))
    except Exception:  # noqa: BLE001 - unknown PSF width is recorded as NaN
        return float("nan")
    return value if math.isfinite(value) and value > 0 else float("nan")


def _layout_from_s3(image: Any) -> int:
    from pxh.spherex import l2

    try:
        l2.read_layout(image, source="s3")
        return 1
    except Exception as exc:  # noqa: BLE001 - the IRSA read in the build tries again
        log.info("S3 layout of %s failed: %r", image.basename, exc)
        return 0


def prefetch_layouts(images: list[Any]) -> int:
    """Read the headers of uncached images from the public S3 mirror (the same files; no IRSA request).

    The pixel stamps still come from IRSA's file server, which takes up to 100 ranges per request; S3 takes
    one range per request, which suits the three header ranges of a layout but not the row-by-row stamps.
    """
    from pxh.spherex import l2

    todo = [im for im in images if l2.cached_layout(im) is None]
    if not todo:
        return 0
    with ThreadPoolExecutor(max_workers=LAYOUT_WORKERS, thread_name_prefix="layout") as pool:
        return sum(pool.map(_layout_from_s3, todo))


def _run_layers(jobs: list[tuple[int, Any]], index: Any, grid: Any, budget_s: float) -> tuple[list, list, int]:
    """(layers, failed jobs, n_outside) for (epoch, image) jobs, read and reprojected in a thread pool."""
    from pxh.api import field
    from pxh.spherex import l2

    layers: list = []
    failed: list = []
    outside = 0
    if not jobs:
        return layers, failed, outside
    pool = ThreadPoolExecutor(max_workers=min(IMAGE_WORKERS, len(jobs)), thread_name_prefix="img")
    try:
        futures = {pool.submit(field._make_layer, e, im, index.ra, index.dec, grid, False): (e, im) for e, im in jobs}
        done, pending = wait(futures, timeout=budget_s)
        for fut in pending:
            fut.cancel()
            failed.append((futures[fut], "time budget"))
        for fut in done:
            e, im = futures[fut]
            try:
                layer = fut.result()
            except l2.OutsideDetectorError:
                outside += 1
                continue
            except Exception as exc:  # noqa: BLE001 - one bad image is retried, then left out
                failed.append(((e, im), repr(exc)[:200]))
                continue
            if layer is None:
                outside += 1
            else:
                layers.append(layer)
    finally:
        pool.shutdown(wait=False, cancel_futures=True)
    return layers, failed, outside


def build_detector(index: Any, entry: dict[str, Any], det: int, root: Path) -> dict[str, Any]:
    """Co-add one detector per epoch on the field grid and write D<det>.npz; returns its summary."""
    from pxh.api import field
    from pxh.api.settings import get_settings
    from pxh.imaging import align
    from pxh.spherex import rangeio

    t0 = time.perf_counter()
    s0 = rangeio.stats()
    fov_arcmin = float(entry["fov_deg"]) * 60.0
    settings = replace(get_settings(), max_images=MAX_IMAGES, max_images_per_epoch=MAX_IMAGES_PER_EPOCH)
    grid = align.make_grid(index.ra, index.dec, fov_arcmin)
    gw, shape = grid
    chosen, available, cap = field.select_images(index, det, field.image_budget(fov_arcmin, settings),
                                                 settings.max_images_per_epoch)
    jobs = [(e, im) for e, ims in sorted(chosen.items()) for im in ims]
    n_layouts_s3 = prefetch_layouts([im for _, im in jobs])
    layers, failed, n_outside = _run_layers(jobs, index, grid, DETECTOR_BUDGET_S)
    n_retried = len(failed)
    if failed:
        log.warning("%s D%d: %d image(s) failed (%s); retrying after %.0f s", entry["id"], det, len(failed),
                    failed[0][1], RETRY_PAUSE_S)
        time.sleep(RETRY_PAUSE_S)
        more, failed, more_outside = _run_layers([job for job, _ in failed], index, grid, DETECTOR_BUDGET_S)
        layers += more
        n_outside += more_outside
    if jobs and len(failed) > max(2, 0.25 * len(jobs)):
        raise RuntimeError(f"D{det}: {len(failed)} of {len(jobs)} images could not be read ({failed[0][1]})")
    by_epoch: dict[int, list] = defaultdict(list)
    for lay in layers:
        by_epoch[lay.epoch].append(lay)
    entries = {e["index"]: e for e in index.epoch_entries}
    epochs = {e.index: e for e in index.epochs}
    avail_per_epoch = {
        e.index: sum(1 for x in e.exposures for im in x.images if im.detector == det) for e in index.epochs
    }
    keys = sorted(by_epoch)
    n_ep, (ny, nx) = len(keys), shape
    data = np.full((n_ep, ny, nx), np.nan, dtype=np.float32)
    weight = np.zeros((n_ep, ny, nx), dtype=np.float32)
    n_used = np.zeros((n_ep, ny, nx), dtype=np.int16)
    saturated = np.zeros((n_ep, ny, nx), dtype=bool)
    per: dict[str, list] = {name: [] for name in PER_EPOCH}
    provenance: dict[str, Any] = {}
    for i, e in enumerate(keys):
        group = sorted(by_epoch[e], key=lambda lay: (lay.mjd, lay.image.obs_id))
        frame = field._coadd_epoch(group, grid, det, e)
        data[i], weight[i] = frame.data, frame.weight
        n_used[i] = np.sum([(lay.weight > 0) & np.isfinite(lay.data) for lay in group], axis=0)
        saturated[i] = np.logical_or.reduce([lay.saturated for lay in group])
        ent, ep = entries[e], epochs[e]
        wls = [lay.wavelength_um for lay in group if lay.wavelength_um is not None]
        fwhm = [v for v in (_psf_fwhm(lay.image) for lay in group) if math.isfinite(v)]
        per["epoch_index"].append(e)
        per["epoch_mjd"].append(frame.mjd_mid)
        per["epoch_start_mjd"].append(ep.t_start_mjd)
        per["epoch_end_mjd"].append(ep.t_end_mjd)
        per["epoch_label"].append(ent["label"])
        per["survey"].append(ent["survey"])
        per["year"].append(ent["year"])
        per["pa"].append(ent["pa"])
        per["full"].append(bool(ent["full"]))
        per["wl_min_um"].append(min(wls) if wls else np.nan)
        per["wl_max_um"].append(max(wls) if wls else np.nan)
        per["wl_center_um"].append(float(np.mean(wls)) if wls else np.nan)
        per["psf_fwhm_arcsec"].append(float(np.median(fwhm)) if fwhm else np.nan)
        per["n_images"].append(len(group))
        per["n_available"].append(avail_per_epoch.get(e, 0))
        per["coverage_fraction"].append(float(np.mean(frame.weight > 0)))
        provenance[str(e)] = {
            "obs_ids": [lay.image.obs_id for lay in group],
            "collections": [lay.image.collection for lay in group],
            "mjd": [round(lay.mjd, 6) for lay in group],
            "wl_um": [None if lay.wavelength_um is None else round(lay.wavelength_um, 5) for lay in group],
        }
    s1 = rangeio.stats()
    seconds = time.perf_counter() - t0
    meta = {
        "schema": sio.SCHEMA,
        "field_id": entry["id"],
        "field_name": entry["name"],
        "kind": entry["kind"],
        "det": det,
        "center": {"ra": index.ra, "dec": index.dec},
        "fov_arcmin": fov_arcmin,
        "grid": {"ny": ny, "nx": nx, "pixscale_arcsec": round(align.pixel_scale_arcsec(gw), 4)},
        "units": {"data": "MJy/sr (zodiacal light subtracted)", "weight": "(MJy/sr)^-2"},
        "processing": (
            "pxh.api.field (same as the live API): byte-range stamps per image, reprojected bilinearly onto the "
            "north-up grid; zodi subtracted; pixels with the science mask (invalid + artifact flags) or OVERFLOW "
            "rejected; inverse-variance mean per epoch"
        ),
        "settings": {"max_images": MAX_IMAGES, "max_images_per_epoch": MAX_IMAGES_PER_EPOCH, "per_epoch_cap": cap},
        "n_available": available,
        "n_selected": len(jobs),
        "n_used": len(layers),
        "n_failed": len(failed),
        "n_retried": n_retried,
        "n_outside": n_outside,
        "n_layouts_from_s3": n_layouts_s3,
        "epochs": provenance,
        "built_at": utc_now(),
        "seconds": round(seconds, 1),
        "requests": s1.requests - s0.requests,  # IRSA IBE and the S3 mirror together
        "bytes": s1.bytes - s0.bytes,
        "credits": CREDITS,
    }
    arrays: dict[str, Any] = {"data": data, "weight": weight, "n_used": n_used, "saturated": saturated}
    for name, values in per.items():  # zero-length arrays when the detector has no image of this field
        dtype = sio.ARRAY_SPEC[name][0]
        arrays[name] = np.asarray(values, dtype=str if dtype == "str" else dtype)
    arrays["wcs_header"] = gw.to_header().tostring(sep="\n")
    arrays["meta_json"] = json.dumps(meta)
    path = sio.detector_path(entry["id"], det, root)
    sio.save_detector(path, arrays)
    summary = {
        "n_epochs": n_ep,
        "n_images": len(layers),
        "n_available": available,
        "n_failed": len(failed),
        "n_outside": n_outside,
        "seconds": round(seconds, 1),
        "requests": meta["requests"],
        "mb_downloaded": round(meta["bytes"] / 1e6, 2),
        "kb_on_disk": round(path.stat().st_size / 1024, 1),
    }
    log.info("%s D%d: %d epochs, %d/%d images, %.1f s, %d requests, %.1f MB", entry["id"], det, n_ep,
             len(layers), available, seconds, summary["requests"], summary["mb_downloaded"])
    return summary


# --- one field (run in a worker process) ------------------------------------------------------------------


def _write_status(root: Path, status: dict[str, Any]) -> None:
    status["updated_at"] = utc_now()
    sio.write_json(root / status["id"] / "status.json", status)


def build_field_task(entry: dict[str, Any], dets: list[int], root_text: str) -> dict[str, Any]:
    """Build the missing detectors (and catalogues) of one field; returns its final status record."""
    root = Path(root_text)
    setup_logging(root)
    from pxh.api import field

    status = read_status(root, entry["id"]) or {}
    status.update({k: entry[k] for k in ("id", "name", "kind", "ra", "dec", "fov_deg")})
    status.setdefault("detectors_done", [])
    status.setdefault("detectors", {})
    status["detectors_planned"] = sorted(set(status.get("detectors_planned", [])) | {f"D{d}" for d in dets},
                                         key=lambda k: -int(k[1]))
    core_done = (root / entry["id"] / "catalogs.json").exists() and all(
        f"D{d}" in status["detectors_done"] and sio.detector_path(entry["id"], d, root).exists() for d in CORE_DETS)
    # a field whose core detectors are built stays "done" (and listed) while its extra detectors build
    status["status"] = "done" if core_done else "building"
    if core_done:
        status["building_extra"] = True
    status["error"] = None
    status["pid"] = os.getpid()
    status.setdefault("started_at", utc_now())
    _write_status(root, status)
    t0 = time.perf_counter()
    last_error = ""
    for attempt in range(1, ATTEMPTS + 1):
        try:
            index = field.index_field(float(entry["ra"]), float(entry["dec"]))
            status["n_epochs"] = len(index.epochs)
            status["n_full"] = sum(1 for e in index.epoch_entries if e["full"])
            status["epochs"] = index.epoch_entries
            status["deep_field"] = index.deep
            status["warnings"] = list(index.warnings)
            _write_status(root, status)
            cat_path = root / entry["id"] / "catalogs.json"
            if not cat_path.exists():
                try:
                    cats = fetch_catalogs(entry)
                    sio.write_json(cat_path, cats)
                    status["catalogs"] = {k: len(cats[k]) for k in ("gaia", "catwise", "simbad")}
                except Exception as exc:  # noqa: BLE001 - catalogues are retried on the next attempt or run
                    status["catalogs"] = {"error": repr(exc)[:300]}
                    log.warning("%s: catalogues failed: %r", entry["id"], exc)
                _write_status(root, status)
            for det in dets:
                key = f"D{det}"
                if key in status["detectors_done"] and sio.detector_path(entry["id"], det, root).exists():
                    continue
                try:
                    summary = build_detector(index, entry, det, root)
                except Exception as exc:
                    if det in CORE_DETS:
                        raise
                    # an extra detector (D2/D1) never fails a field whose core detectors are built
                    status.setdefault("detector_errors", {})[key] = f"{type(exc).__name__}: {exc}"[:300]
                    log.warning("%s %s failed (extra detector, field kept): %r", entry["id"], key, exc)
                    _write_status(root, status)
                    continue
                status.get("detector_errors", {}).pop(key, None)
                status["detectors"][key] = summary
                if key not in status["detectors_done"]:
                    status["detectors_done"].append(key)
                status["detectors_done"].sort(key=lambda k: -int(k[1]))
                _write_status(root, status)
            if not cat_path.exists():
                raise RuntimeError(f"catalogues missing: {status.get('catalogs')}")
            status["status"] = "done"
            break
        except Exception as exc:  # noqa: BLE001 - recorded; the field is retried once, then marked failed
            last_error = f"{type(exc).__name__}: {exc}"[:400]
            log.warning("%s attempt %d failed: %s\n%s", entry["id"], attempt, last_error, traceback.format_exc(limit=4))
            status["attempts"] = status.get("attempts", 0) + 1
            if attempt < ATTEMPTS:
                time.sleep(RETRY_PAUSE_S * attempt)
    else:
        if core_done:
            status["status"] = "done"
            status["extra_error"] = last_error
        else:
            status["status"] = "failed"
            status["error"] = last_error
    status.pop("building_extra", None)
    status["seconds"] = round(float(status.get("seconds") or 0.0) + time.perf_counter() - t0, 1)  # all runs
    status["finished_at"] = utc_now()
    status.pop("pid", None)
    _write_status(root, status)
    log.info("%s: %s in %.0f s (%s)", entry["id"], status["status"], time.perf_counter() - t0,
             ", ".join(status["detectors_done"]))
    return status


# --- coordinator --------------------------------------------------------------------------------------------


def disk_mb(path: Path) -> float:
    return sum(p.stat().st_size for p in path.rglob("*") if p.is_file()) / 1e6 if path.exists() else 0.0


def aggregate(root: Path, flist: dict[str, Any]) -> dict[str, Any]:
    """Write fields.json: every listed field merged with its status.json (queued if none)."""
    records = []
    for entry in flist["fields"]:
        rec = dict(entry)
        st = read_status(root, entry["id"])
        if st:
            rec.update({k: v for k, v in st.items() if k not in ("why",)})
        else:
            rec.update({"status": "queued", "detectors_done": []})
        records.append(rec)
    counts = {s: sum(1 for r in records if r.get("status") == s) for s in sio.STATUSES}
    doc = {
        "schema": sio.FIELDS_SCHEMA,
        "updated_at": utc_now(),
        "field_list": str(FIELDS_FILE.relative_to(REPO)).replace("\\", "/"),
        "field_list_complete": bool(flist.get("complete", True)),
        "counts": counts,
        "fields": records,
    }
    sio.write_json(root / "fields.json", doc)
    return doc


def pending_tasks(root: Path, flist: dict[str, Any], args: argparse.Namespace, busy: set[str],
                  extra_phase: bool) -> list[tuple[dict[str, Any], list[int]]]:
    only = set(args.only.split(",")) if args.only else None
    tasks = []
    for entry in flist["fields"]:
        if entry["id"] in busy or (only and entry["id"] not in only):
            continue
        st = read_status(root, entry["id"]) or {}
        if st.get("status") == "failed" and not args.retry_failed:
            continue
        if args.retry_failed and st.get("status") == "failed" and entry["id"] in args._retried:
            continue
        done = set(st.get("detectors_done", []))
        dets = list(CORE_DETS) if not extra_phase else planned_dets(entry, True)
        missing = [d for d in dets if f"D{d}" not in done or not sio.detector_path(entry["id"], d, root).exists()]
        cats = (root / entry["id"] / "catalogs.json").exists()
        if missing or not cats:
            tasks.append((entry, dets))
    return tasks


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--workers", type=int, default=2, help="fields built at once, one process each (max 2)")
    ap.add_argument("--only", default="", help="comma-separated field ids")
    ap.add_argument("--retry-failed", action="store_true")
    ap.add_argument("--no-extra", action="store_true", help="skip D2/D1 for targets and variables")
    ap.add_argument("--wait-for-list", type=float, default=1800.0,
                    help="seconds to keep polling an incomplete field list for new fields")
    ap.add_argument("--root", default=str(sio.survey_dir()))
    args = ap.parse_args()
    args._retried = set()
    workers = max(1, min(2, args.workers))
    root = Path(args.root)
    setup_logging(root)
    log.info("build_survey start: workers=%d root=%s", workers, root)
    t_start = time.perf_counter()
    in_flight: dict[Future, str] = {}
    last_agg = 0.0
    extra_phase = False
    idle_since: float | None = None
    with ProcessPoolExecutor(max_workers=workers) as pool:
        while True:
            flist = load_field_list()
            busy = set(in_flight.values())
            tasks = pending_tasks(root, flist, args, busy, extra_phase)
            while tasks and len(in_flight) < workers:
                entry, dets = tasks.pop(0)
                if args.retry_failed and (read_status(root, entry["id"]) or {}).get("status") == "failed":
                    args._retried.add(entry["id"])
                log.info("queue %s (%s) %s", entry["id"], entry["kind"], ",".join(f"D{d}" for d in dets))
                in_flight[pool.submit(build_field_task, entry, dets, str(root))] = entry["id"]
            if time.perf_counter() - last_agg > 10.0:
                aggregate(root, flist)
                last_agg = time.perf_counter()
            if not in_flight:
                if tasks:
                    continue
                if not flist.get("complete", True) and idle_since is None:
                    idle_since = time.perf_counter()
                if not flist.get("complete", True) and time.perf_counter() - idle_since < args.wait_for_list:
                    time.sleep(15.0)
                    continue
                if not extra_phase and not args.no_extra:
                    extra_phase = True
                    log.info("core detectors done for every field; starting D2/D1 of targets and variables")
                    continue
                break
            idle_since = None
            done, _ = wait(list(in_flight), timeout=10.0, return_when=FIRST_COMPLETED)
            for fut in done:
                fid = in_flight.pop(fut)
                try:
                    st = fut.result()
                    log.info("finished %s: %s", fid, st.get("status"))
                except Exception as exc:  # noqa: BLE001 - a crashed worker marks the field failed
                    log.error("worker crashed on %s: %r", fid, exc)
                    st = read_status(root, fid) or {"id": fid}
                    st.update({"status": "failed", "error": f"worker crashed: {exc!r}"[:300]})
                    _write_status(root, st)
    doc = aggregate(root, load_field_list())
    log.info("build_survey end: %s in %.0f s, %.1f MB on disk", doc["counts"], time.perf_counter() - t_start,
             disk_mb(root))
    print(json.dumps(doc["counts"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
