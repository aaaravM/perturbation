"""Live mover and variable candidates for one field: ``GET /api/candidates?ra&dec&fov=0.1667&dets=4,5,6``.

1. Per-epoch co-adds of each requested detector (``pxh.api.field.detector_coadds``: the same images, cache and
   IRSA limits as ``/api/field/build``), one detector after the other within a time limit.
2. The finder and classifier (``pxh.ml.finder``): candidates, probabilities, conformal p-values, and
   Benjamini-Hochberg q-values over this field's candidates.
3. Candidates with q <= 0.2 are measured (motion or brightness change), cross-matched with Gaia DR3 (IRSA
   Gator, positions moved to the latest epoch) and returned with a PNG stamp as a data URL.

The whole request stays under ``LIMIT_S`` (240 s). When detectors are left out, images fail or the time runs
out, the answer says so in ``notes``, ``field.complete`` is false and nothing is cached; complete answers get
the one-day CDN cache.
"""

from __future__ import annotations

import logging
import time
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeout
from dataclasses import replace
from typing import Any

from pxh.api import catalogs, field
from pxh.api.caching import TTLCache
from pxh.api.errors import ApiProblem, invalid
from pxh.api.settings import Settings, get_settings
from pxh.ml import finder
from pxh.ml import movers as mv
from pxh.ml.realbogus import available, load_model

log = logging.getLogger(__name__)

LIMIT_S = 240.0
MIN_DETECTOR_BUDGET_S = 15.0
RESERVE_S = 25.0  # finder, classifier, measurements and stamps after the co-adds
CATALOG_WAIT_S = 12.0
FOV_DEFAULT_DEG = 0.1667
FOV_MIN_DEG = 0.05
FOV_MAX_DEG = 0.25
DEFAULT_DETS = (4, 5, 6)
MAX_RETURNED = 60
_RESULTS = TTLCache(maxsize=32, ttl_s=6 * 3600.0)
_CATALOG_POOL = ThreadPoolExecutor(max_workers=2, thread_name_prefix="cand-cat")


def parse_dets(text: str | None) -> tuple[int, ...]:
    if text is None or not text.strip():
        return DEFAULT_DETS
    out = []
    for part in text.split(","):
        part = part.strip().upper().lstrip("D")
        if not part:
            continue
        if not part.isdigit() or not 1 <= int(part) <= 6:
            raise invalid(f"dets must be detector numbers 1-6 (e.g. 4,5,6), got {text!r}")
        out.append(int(part))
    if not out:
        raise invalid("dets must name at least one detector")
    return tuple(sorted(set(out)))


def _gaia_sources(ra: float, dec: float, fov_deg: float, mjd: float) -> list[dict[str, Any]]:
    radius = min(15.0, fov_deg * 60.0 * 0.75 + 0.5)
    rows = catalogs.gaia_sources(ra, dec, radius, mjd)
    return [finder.catalog_source("Gaia DR3", r["source_id"], f"Gaia DR3 {r['source_id']}", r["ra"], r["dec"], mjd,
                                  r.get("pmra"), r.get("pmdec"), r.get("g")) for r in rows]


def find_field_candidates(
    ra: float, dec: float, fov_deg: float = FOV_DEFAULT_DEG, dets: tuple[int, ...] = DEFAULT_DETS,
    *, settings: Settings | None = None, limit_s: float = LIMIT_S,
) -> dict[str, Any]:
    """The /api/candidates answer (see the module docstring)."""
    if not (FOV_MIN_DEG <= fov_deg <= FOV_MAX_DEG):
        raise invalid(f"fov must be within {FOV_MIN_DEG}-{FOV_MAX_DEG} degrees, got {fov_deg:g}")
    ra, dec, fov_arcmin = field.normalise_field(ra, dec, fov_deg * 60.0)
    key = (ra, dec, fov_arcmin, dets)
    cached = _RESULTS.get(key)
    if cached is not None:
        return cached
    if not available():
        raise ApiProblem(503, "model_unavailable", "The candidate classifier is not installed on this server.",
                         retryable=False)
    t0 = time.perf_counter()
    settings = settings or get_settings()
    timing: dict[str, float] = {}
    notes: list[str] = []
    index = field.index_field(ra, dec)
    if not index.exposures:
        raise ApiProblem(404, "no_coverage", "SPHEREx has not released any images of this position yet.")
    last_mjd = max(e["mjd_mid"] for e in index.epoch_entries)
    gaia_future = _CATALOG_POOL.submit(_gaia_sources, ra, dec, fov_arcmin / 60.0, last_mjd)

    coadds = []
    complete = True
    for det in dets:
        remaining = limit_s - RESERVE_S - (time.perf_counter() - t0)
        if remaining < MIN_DETECTOR_BUDGET_S:
            notes.append(f"D{det} was left out: the {limit_s:.0f} s limit was reached.")
            complete = False
            continue
        det_settings = replace(settings, build_budget_s=min(settings.build_budget_s, remaining))
        t1 = time.perf_counter()
        co = field.detector_coadds(index, fov_arcmin, det, settings=det_settings)
        timing[f"coadd_D{det}_s"] = round(time.perf_counter() - t1, 2)
        if co.n_failed or co.n_skipped:
            complete = False
            notes.append(f"D{det}: {co.n_failed} image(s) failed and {co.n_skipped} were skipped (time limit); "
                         "the co-adds use the rest.")
        if len(co.frames) < 2:
            notes.append(f"D{det} has fewer than two epochs here, so it cannot show changes.")
        coadds.append(co)
    usable = [co for co in coadds if co.frames]
    if not usable:
        raise ApiProblem(404, "no_coverage", "None of the requested detectors has co-adds of this position.")
    meta = {"id": f"live-{ra:.5f}{dec:+.5f}", "name": None, "kind": "live", "ra": ra, "dec": dec,
            "fov_deg": round(fov_arcmin / 60.0, 4)}
    stack = mv.stack_from_coadds(index, usable, meta)

    t1 = time.perf_counter()
    model = load_model()
    scored, diffs = finder.score_field(stack, model)
    finder.apply_fdr(scored)
    timing["finder_s"] = round(time.perf_counter() - t1, 2)

    listed = sorted((s for s in scored if s.q <= finder.LIST_Q_MAX), key=lambda s: (s.q, -s.score))[:MAX_RETURNED]
    t1 = time.perf_counter()
    measurements = finder.measure(stack, diffs, listed)
    timing["measure_s"] = round(time.perf_counter() - t1, 2)

    t1 = time.perf_counter()
    try:
        sources = gaia_future.result(timeout=max(1.0, min(CATALOG_WAIT_S, limit_s - (time.perf_counter() - t0))))
        catalog_ok = True
    except FutureTimeout:
        sources, catalog_ok = [], False
        notes.append("Gaia DR3 did not answer in time: matches are not checked (status 'unknown').")
    except Exception as exc:  # noqa: BLE001 - the candidates are still useful without the cross-match
        sources, catalog_ok = [], False
        log.warning("Gaia cross-match failed: %r", exc)
        notes.append("Gaia DR3 could not be reached: matches are not checked (status 'unknown').")
    timing["catalog_s"] = round(time.perf_counter() - t1, 2)
    if not catalog_ok:
        complete = False

    records = []
    residuals: list[finder.Scored] = []
    for s, m in zip(listed, measurements, strict=True):
        ra_c, dec_c = finder.best_position(stack, s, m)
        motion = m.get("motion") if s.kind == "mover" else None
        mjd_c = finder.candidate_epoch_mjd(stack, s.cand)
        # a mover with no significant motion of its own on a bright static star: a registration residual
        if s.kind == "mover" and finder.static_star_residual(ra_c, dec_c, mjd_c, motion, sources) is not None:
            residuals.append(s)
            continue
        match = finder.catalogue_match(ra_c, dec_c, mjd_c, s.kind, motion, sources)
        stamp = field.data_url(mv.stamp_png(stack, diffs, s.cand))
        records.append(finder.candidate_record(stack, s, f"{meta['id']}-{len(records):03d}", meta["id"], m, match,
                                               stamp, model.classes))
    n_kept = sum(1 for s in scored if s.q <= finder.FDR_ALPHA) - sum(1 for s in residuals if s.q <= finder.FDR_ALPHA)
    if residuals:
        notes.append(f"{len(residuals)} mover candidate(s) left out: no significant motion of their own, on a bright "
                     "star that Gaia measured as static (the residual a star leaves when epochs are registered to "
                     "0.1-0.25 arcsec).")
    notes += [
        f"{len(scored)} candidates in this field; {n_kept} at q <= {finder.FDR_ALPHA} (Benjamini-Hochberg over "
        f"this field's candidates); every candidate with q <= {finder.LIST_Q_MAX} is listed"
        + (f" (the first {MAX_RETURNED})" if len(listed) == MAX_RETURNED else "") + ".",
        "Candidates are automatic and unconfirmed: check each one in the Lab before believing it.",
    ]
    if any("saturated" in s.cand.flags for s in listed):
        notes.append("Some candidates touch saturated pixels: their positions and brightness changes are less "
                     "reliable.")
    timing["total_s"] = round(time.perf_counter() - t0, 2)
    doc = {
        "schema": "pxh-candidates/1",
        "generated_at": field.utc_iso(),
        "field": meta | {
            "n_epochs": len(index.epochs), "n_candidates": len(scored), "n_kept": n_kept,
            "detectors": [f"D{co.det}" for co in usable], "complete": complete,
            "epochs": index.epoch_entries,
        },
        "model": {"name": model.name, "classes": model.classes, "temperature": model.temperature,
                  "metrics": {k: model.meta.get("metrics", {}).get(k) for k in ("test_accuracy",)}},
        "fdr": {"method": "conformal p-values against real validation-field candidates, then Benjamini-Hochberg "
                          "over this field's candidates", "alpha": finder.FDR_ALPHA, "list_q_max": finder.LIST_Q_MAX},
        "candidates": records,
        "timing": timing,
        "notes": notes,
    }
    if complete:
        _RESULTS.put(key, doc)
    return doc
