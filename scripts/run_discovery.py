"""Run the mover and variable finder over every finished survey field and write the Discoveries list.

Run from ml/ (the models project, which has pxh and the survey reader):

    cd ml && uv run python ../scripts/run_discovery.py [--workers 12]

1. Every survey field with D4, D5 and D6 on disk (``data/survey``): the finder, the classifier and conformal
   p-values (``pxh.ml.finder``), exactly as the live API.
2. Benjamini-Hochberg q-values within each field (one field is one search, as in the Lab and
   ``/api/candidates``, so a candidate has the same q in both places). One family for the whole survey would need
   far more null scores than the validation fields give: with about 5,000 candidates and 3,200 null scores the
   smallest possible q is above 1. What per-field families leave over the whole list is measured instead: false
   alarms per square degree on the control fields (``docs/validation/movers.md``).
3. Every candidate with q <= 0.2 is measured (motion or brightness change), cross-matched with Gaia DR3,
   CatWISE2020 and SIMBAD from the field's ``catalogs.json`` (known = a catalogued source within 6 arcsec at
   the candidate's epoch, moving consistently for a mover) and drawn as a PNG stamp.
4. A mover candidate whose own position fit shows no significant motion and which sits on a bright star that
   Gaia or CatWISE measured as static is left out of the list as a registration residual of that star
   (``pxh.ml.finder.static_star_residual``); the full table keeps it with the reason.
5. The five challenge targets are also tested at their known positions: the candidates within 30 arcsec of the
   target's predicted position form their own small family (a targeted test), and the best one is written to
   ``targets`` with its targeted q.

Writes ``frontend/public/discoveries/candidates.json`` (schema in the README next to it), the stamps in
``frontend/public/discoveries/stamps/``, and the full candidate table for validation in
``ml/data/discovery/all_candidates.json``.
"""

from __future__ import annotations

import argparse
import json
import shutil
import statistics
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parents[1]
ML = REPO / "ml"
if str(ML) not in sys.path:
    sys.path.insert(0, str(ML))

OUT = REPO / "frontend" / "public" / "discoveries"
STAMPS = OUT / "stamps"
ALL = ML / "data" / "discovery" / "all_candidates.json"
METRICS = REPO / "docs" / "validation" / "movers_metrics.json"
DETS = (4, 5, 6)
STAMP_BUDGET_BYTES = 4_000_000
TARGET_RADIUS_ARCSEC = 30.0
TARGET_EXPECTED = {"barnards-star": "mover", "eps-indi-b": "mover", "wise-0855": "mover", "rw-aur": "variable",
                   "r-dra": "variable"}


def search(field_id: str) -> dict[str, Any]:
    """Finder + classifier on one field; returns everything needed after the survey-wide FDR step."""
    from movers import data as mdata

    from pxh.ml import finder
    from pxh.ml import movers as mv
    from pxh.ml.realbogus import load_model

    stack = mdata.survey_stack(field_id, DETS)
    scored, _ = finder.score_field(stack, load_model())
    rows = []
    for s in scored:
        ra, dec = mv.candidate_world(stack, s.cand)
        rows.append({"p": s.p, "score": s.score, "kind": s.kind, "in_family": s.in_family,
                     "probs": [float(v) for v in s.probs], "cand": s.cand.__dict__, "ra": ra, "dec": dec,
                     "mjd": finder.candidate_epoch_mjd(stack, s.cand)})
    return {
        "field": field_id,
        "meta": stack.meta,
        "n_epochs": len({e for d in stack.dets for e in stack.frames[d]}),
        "mjd_last": max(fr.mjd_mid for d in stack.dets for fr in stack.frames[d].values()),
        "rows": rows,
    }


def finish(field_id: str, rows: list[dict[str, Any]], first_index: int, prefix: str = "",
           veto: bool = True) -> list[dict[str, Any]]:
    """Measurements, catalogue matches, stamps and public records of one field's listed candidates."""
    import numpy as np
    import survey_io as sio
    from movers import data as mdata

    from pxh.ml import finder
    from pxh.ml import movers as mv
    from pxh.ml.realbogus import load_model

    model = load_model()
    stack = mdata.survey_stack(field_id, DETS)
    diffs = mv.difference_maps(stack)
    scored = []
    for r in rows:
        c = mv.Candidate(**{**r["cand"], "pairs": [tuple(p) for p in r["cand"]["pairs"]]})
        s = finder.Scored(cand=c, probs=np.array(r["probs"]), score=r["score"], p=r["p"], kind=r["kind"],
                          in_family=r["in_family"], q=r["q"])
        scored.append(s)
    meas = finder.measure(stack, diffs, scored)
    try:
        sources = finder.sources_from_catalogs(sio.load_catalogs(field_id))
    except FileNotFoundError:
        sources = []
    out = []
    n = 0
    for s, m in zip(scored, meas, strict=True):
        ra, dec = finder.best_position(stack, s, m)
        motion = m.get("motion") if s.kind == "mover" else None
        mjd = finder.candidate_epoch_mjd(stack, s.cand)
        residual = finder.static_star_residual(ra, dec, mjd, motion, sources) if veto and s.kind == "mover" else None
        if residual is not None:
            out.append({"record": None, "vetoed": {"field": field_id, "ra": ra, "dec": dec, "q": s.q,
                                                   "score": s.score, "snr": float(s.cand.snr), "motion": motion,
                                                   "static_star": residual}})
            continue
        cid = f"{field_id}-{prefix}{first_index + n:03d}"
        n += 1
        match = finder.catalogue_match(ra, dec, mjd, s.kind, motion, sources)
        (STAMPS / f"{cid}.png").write_bytes(mv.stamp_png(stack, diffs, s.cand))
        rec = finder.candidate_record(stack, s, cid, field_id, m, match, f"/discoveries/stamps/{cid}.png",
                                      model.classes)
        out.append({"record": rec, "flags": s.cand.flags, "mjd": finder.candidate_epoch_mjd(stack, s.cand),
                    "chi2_red": (motion or {}).get("chi2_red"), "motion_full": motion})
    return out


def targeted(res: dict[str, Any]) -> dict[str, Any] | None:
    """The targeted test of one challenge target: BH over the in-family candidates within 30 arcsec of its
    predicted position at the field's latest epoch; the best candidate (the expected kind at q <= 0.05 if any)."""
    import math

    from pxh.ml.fdr import bh_q_values
    from pxh.sky import propagate
    from pxh.sky.targets import list_targets

    t = next((t for t in list_targets(primary_only=True) if t.key == res["field"]), None)
    if t is None:
        return None
    ra_t, dec_t = (float(v) for v in propagate.barycentric_position(t.astrometry, res["mjd_last"]))
    cosd = math.cos(math.radians(dec_t))
    near = []
    for r in res["rows"]:
        sep = 3600.0 * math.hypot(((r["ra"] - ra_t + 180.0) % 360.0 - 180.0) * cosd, r["dec"] - dec_t)
        if r["in_family"] and sep <= TARGET_RADIUS_ARCSEC:
            near.append((r, sep))
    want = TARGET_EXPECTED.get(res["field"])
    out = {"field": res["field"], "name": t.name, "expected": want, "radius_arcsec": TARGET_RADIUS_ARCSEC,
           "family": len(near),
           "catalog_pm_arcsec_yr": round(math.hypot(t.astrometry.pmra_masyr, t.astrometry.pmdec_masyr) / 1000.0, 3),
           "best": None, "q_target": None, "sep_arcsec": None}
    if not near:
        return out
    q = bh_q_values([r["p"] for r, _ in near])
    for (r, _), qv in zip(near, q, strict=True):
        r["q_target"] = float(qv)
    right = [(r, sep) for r, sep in near if r["kind"] == want and r["q_target"] <= 0.05]
    best, sep = min(right or near, key=lambda rs: (rs[0]["q_target"], -rs[0]["score"]))
    return out | {"best": best, "q_target": best["q_target"], "sep_arcsec": round(sep, 2)}


def model_metrics() -> dict[str, Any]:
    keys = {"test_accuracy": None, "mover_completeness_snr10": None, "variable_completeness_snr10": None,
            "false_alarms_per_deg2_q05": None}
    if not METRICS.exists():
        return keys
    m = json.loads(METRICS.read_text(encoding="utf-8"))
    comp = m.get("completeness", {})
    keys["test_accuracy"] = round(m["stamps"]["accuracy"], 4) if "stamps" in m else None
    for kind, key in (("mover", "mover_completeness_snr10"), ("variable", "variable_completeness_snr10")):
        v = comp.get(kind, {}).get("snr_ge_10", {}).get("kept_q05")
        keys[key] = round(v, 4) if v is not None else None
    fa = m.get("controls", {}).get("false_alarms_per_deg2_q05")
    keys["false_alarms_per_deg2_q05"] = round(fa, 2) if fa is not None else None
    # movers that shift by at least one pixel over the long pair (S/N >= 10): what SPHEREx's pixels allow
    rows = [r for r in comp.get("mover", {}).get("vs_shift_px_kept_snr_ge_10", []) if r["lo"] >= 1]
    n, k = sum(r["n"] for r in rows), sum(r["k"] for r in rows)
    keys["mover_completeness_shift_ge_1px_snr10"] = round(k / n, 4) if n else None
    # false alarms over every test field (outside the known object at each centre): the area and, when none were
    # seen, the 95% upper limit (3 / area)
    allf = m.get("controls", {}).get("all_test_fields") or {}
    area = allf.get("area_deg2")
    if area:
        n_fa = allf.get("n_kept_q05", 0)
        keys["false_alarms_area_deg2"] = round(area, 4)
        keys["false_alarms_per_deg2_q05_upper95"] = round((3.0 if n_fa == 0 else n_fa + 2.0 * n_fa**0.5) / area, 1)
    return keys


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--workers", type=int, default=12)
    ap.add_argument("--q-max", type=float, default=0.2)
    args = ap.parse_args()
    from movers import data as mdata

    from pxh.ml.fdr import bh_q_values
    from pxh.ml.realbogus import load_model

    t0 = time.time()
    model = load_model()
    fields = mdata.done_fields(DETS)
    print(f"{len(fields)} fields", flush=True)
    with ProcessPoolExecutor(max_workers=args.workers) as pool:
        results = list(pool.map(search, [f["id"] for f in fields]))
    # Benjamini-Hochberg within each field, exactly as the live API does for one field
    n_family = 0
    for res in results:
        fam = [r for r in res["rows"] if r["in_family"]]
        q = bh_q_values([r["p"] for r in fam]) if fam else []
        for r in res["rows"]:
            r["q"] = 1.0
        for r, qv in zip(fam, q, strict=True):
            r["q"] = float(qv)
        n_family += len(fam)
    n_all = sum(len(r["rows"]) for r in results)
    print(f"{n_all} candidates, {n_family} in the per-field FDR families; {time.time() - t0:.0f} s", flush=True)

    if STAMPS.exists():
        shutil.rmtree(STAMPS)
    STAMPS.mkdir(parents=True, exist_ok=True)
    jobs = []
    for res in results:
        listed = sorted((r for r in res["rows"] if r["q"] <= args.q_max), key=lambda r: (r["q"], -r["score"]))
        if listed:
            jobs.append((res["field"], listed, 0))
    with ProcessPoolExecutor(max_workers=args.workers) as pool:
        finished = list(pool.map(finish, *zip(*jobs, strict=True))) if jobs else []
    vetoed = [item["vetoed"] for chunk in finished for item in chunk if item["record"] is None]
    records = [item for chunk in finished for item in chunk if item["record"] is not None]
    print(f"{len(vetoed)} movers left out as residuals of static stars: "
          + ", ".join(f"{v['field']} q={v['q']:.3f}" for v in vetoed), flush=True)
    records.sort(key=lambda it: (it["record"]["q_value"], -it["record"]["score"]))
    stamp_bytes = sum((STAMPS / f"{it['record']['id']}.png").stat().st_size for it in records)
    print(f"{len(records)} listed (q <= {args.q_max}); stamps {stamp_bytes / 1e6:.2f} MB", flush=True)
    if stamp_bytes > STAMP_BUDGET_BYTES:
        raise SystemExit(f"stamps take {stamp_bytes} bytes, over the {STAMP_BUDGET_BYTES} budget")

    # the challenge targets as targeted tests
    target_jobs = []
    for res in results:
        if res["meta"].get("kind") != "target":
            continue
        t = targeted(res)
        if t is not None:
            target_jobs.append(t)
    with ProcessPoolExecutor(max_workers=args.workers) as pool:
        futs = [pool.submit(finish, t["field"], [t["best"]], 0, "target-", False) if t["best"] else None
                for t in target_jobs]
        target_items = [f.result() if f is not None else [] for f in futs]
    targets_out = []
    for t, items in zip(target_jobs, target_items, strict=True):
        rec = items[0]["record"] if items else None
        found = bool(rec and t["q_target"] is not None and t["q_target"] <= 0.05 and rec["kind"] == t["expected"])
        motion = items[0].get("motion_full") if items else None
        targets_out.append({
            "field": t["field"], "name": t["name"], "expected": t["expected"],
            "catalog_pm_arcsec_yr": t["catalog_pm_arcsec_yr"], "radius_arcsec": t["radius_arcsec"],
            "family": t["family"], "q_target": None if t["q_target"] is None else float(f"{t['q_target']:.4g}"),
            "sep_arcsec": t["sep_arcsec"], "found": found,
            "candidate": rec,
            "motion_fit_epochs": (motion or {}).get("n_epochs"),
        })
        print(f"target {t['field']}: family {t['family']}, q_target {t['q_target']}, found {found}", flush=True)
    stamp_bytes += sum((STAMPS / f"{t['candidate']['id']}.png").stat().st_size for t in targets_out if t["candidate"])

    rec_by_field: dict[str, list[dict]] = {}
    for it in records:
        rec_by_field.setdefault(it["record"]["field"], []).append(it["record"])
    fields_out = []
    for res in results:
        meta = res["meta"]
        fields_out.append({
            "id": res["field"], "name": meta.get("name"), "kind": meta.get("kind"), "ra": meta.get("ra"),
            "dec": meta.get("dec"), "fov_deg": meta.get("fov_deg"), "n_epochs": res["n_epochs"],
            "n_candidates": len(res["rows"]),
            "n_kept": sum(1 for r in rec_by_field.get(res["field"], []) if r["q_value"] <= 0.05),
        })
    area = sum((f["fov_deg"] or 0.1667) ** 2 for f in fields_out)
    split = mdata.load_split()
    n_train = sum(1 for f in fields_out if mdata.assign(f["id"], f["kind"], split) == "train")
    doc = {
        "version": 1,
        "generated": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "model": {
            "name": model.name,
            "classes": model.classes,
            "trained_on": model.meta.get("trained_on"),
            "metrics": model_metrics(),
        },
        "fdr": {"method": "Conformal p-values against real validation-field candidates, then Benjamini-Hochberg "
                          "within each field (one field is one search, as in the Lab)", "alpha": 0.05},
        "survey": {
            "n_fields": len(fields_out),
            "area_deg2": round(area, 4),
            "detectors": [f"D{d}" for d in DETS],
            "epochs_median": statistics.median([f["n_epochs"] for f in fields_out]) if fields_out else 0,
        },
        "fields": fields_out,
        "candidates": [it["record"] for it in records],
        "targets": targets_out,
    }
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "candidates.json").write_text(json.dumps(doc, indent=1, allow_nan=False) + "\n", encoding="utf-8")

    # full table for validation (git-ignored): every candidate with its q and finder position
    ALL.parent.mkdir(parents=True, exist_ok=True)
    table = []
    for res in results:
        for r in res["rows"]:
            c = r["cand"]
            table.append({"field": res["field"], "kind": r["kind"], "q": r["q"], "p": r["p"], "score": r["score"],
                          "in_family": r["in_family"], "ra": r["ra"], "dec": r["dec"], "mjd": r["mjd"],
                          "snr": c["snr"], "flags": c["flags"], "det": c["det"], "finder_kind": c["kind"]})
    ALL.write_text(json.dumps({
        "generated": doc["generated"], "n_train_fields": n_train,
        "fields": [f | {"mjd_last": res["mjd_last"]} for f, res in zip(fields_out, results, strict=True)],
        "candidates": table, "listed": [it["record"] | {"flags": it["flags"]} for it in records],
        "vetoed_static_residuals": vetoed,
    }, allow_nan=False, default=float) + "\n", encoding="utf-8")
    kinds = {}
    for it in records:
        r = it["record"]
        if r["q_value"] <= 0.05:
            key = f"{r['kind']}/{r['match']['status']}"
            kinds[key] = kinds.get(key, 0) + 1
    print(f"at q <= 0.05: {kinds}; total {time.time() - t0:.0f} s", flush=True)
    print(f"wrote {OUT / 'candidates.json'}", flush=True)


if __name__ == "__main__":
    main()
