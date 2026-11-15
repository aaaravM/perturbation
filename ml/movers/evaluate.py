"""Validate the finder and classifier on held-out data; write metrics and figures to docs/validation/.

    cd ml && uv run python movers/evaluate.py [--reps 40] [--parts injections,controls,stamps,targets,known]

Everything runs the deployed pipeline: the finder (``pxh.ml.movers``), the NumPy classifier
(``pxh.ml.realbogus``), conformal p-values and Benjamini-Hochberg q-values (``pxh.ml.finder``).

- ``injections``: synthetic movers and variables injected into the TEST fields (never trained on), the field
  then searched exactly like the live API (q-values over that field's candidates). Completeness at q <= 0.05
  against S/N, speed and size of the brightness change.
- ``controls``: the real TEST control fields, no injections: discoveries at q <= 0.05 per square degree.
- ``stamps``: confusion matrix and reliability of the TEST stamps (``ml/data/movers/test.npz``).
- ``targets``: the five challenge targets, searched like the live API.
- ``known``: catalogued stars faster than 0.5"/yr in the survey fields, recovered in the survey run
  (``scripts/run_discovery.py`` output), against magnitude.
"""

from __future__ import annotations

import argparse
import itertools
import json
import math
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path
from typing import Any

import numpy as np

ML = Path(__file__).resolve().parents[1]
REPO = ML.parent
if str(ML) not in sys.path:
    sys.path.insert(0, str(ML))

OUT = REPO / "docs" / "validation"
METRICS = OUT / "movers_metrics.json"
DISCOVERY_ALL = ML / "data" / "discovery" / "all_candidates.json"
SNR_BINS = [3, 5, 7, 10, 15, 20, 30, 50, 100]
SPEED_BINS = [0.3, 0.5, 1, 2, 3, 5, 10, 20]
DMAG_BINS = [0.0, 0.25, 0.5, 0.75, 1.0, 1.5, 2.5]
ALPHA = 0.05
TARGET_RADIUS_ARCSEC = 30.0


# --- injections into test fields ------------------------------------------------------------------------


def injection_trials(field_id: str, seed: int, reps: int) -> list[dict[str, Any]]:
    from pxh.ml import finder
    from pxh.ml.realbogus import load_model

    import survey_io as sio
    from movers import data as mdata
    from movers import inject as inj

    model = load_model()
    stack = mdata.survey_stack(field_id)
    try:
        cats = sio.load_catalogs(field_id)
    except FileNotFoundError:
        cats = {}
    ctx = inj.FieldContext.build(stack, cats)
    rng = np.random.default_rng(seed)
    out = []
    for rep in range(reps):
        st, injections = inj.inject(ctx, rng, n_mover=4, n_variable=4, n_static=2, n_spike=0)
        scored, _ = finder.score_field(st, model)
        finder.apply_fdr(scored)
        best: dict[int, tuple[float, Any]] = {}
        for s in scored:
            k, d = inj.match_injection(st, s.cand, injections)
            if k >= 0 and (k not in best or s.q < best[k][1].q):
                best[k] = (d, s)
        for k, injn in enumerate(injections):
            hit = best.get(k)
            s = hit[1] if hit else None
            shift, dip = expected_dipole(ctx, st, injn)
            out.append({
                "field": field_id, "rep": rep, "kind": injn.kind, "snr": injn.snr, "speed": injn.speed,
                "shift_px": shift, "dipole_snr": dip, "finder_kind": s.cand.kind if s else None,
                "delta_mag": injn.delta_mag, "on_star": injn.on_star,
                "found": s is not None, "q": s.q if s else None, "score": s.score if s else None,
                "pred_kind": s.kind if s else None, "kept": bool(s is not None and s.q <= ALPHA),
                "kept_right_kind": bool(s is not None and s.q <= ALPHA and s.kind == injn.kind),
            })
        # every other kept candidate in an injected field: real sky (or a static injection)
    return out


def expected_dipole(ctx: Any, st: Any, injn: Any) -> tuple[float | None, float | None]:
    """A mover's shift (px) over its best detector's long pair, and the S/N its dipole can have at most.

    For a Gaussian PSF of width sigma shifted by d, the optimally weighted S/N of the difference is
    S/N(source) * sqrt(1 - exp(-d^2 / (4 sigma^2))): the full S/N once the two images separate, but only
    S/N * d / (2 sigma) for a sub-pixel shift. The finder looks for single pixels at 5 sigma in each lobe, which
    needs a little more than this.
    """
    if injn.kind != "mover" or injn.best_det not in ctx.long_pair:
        return None, None
    a, b = ctx.long_pair[injn.best_det]
    fa, fb = st.frames[injn.best_det][a], st.frames[injn.best_det][b]
    shift = math.hypot(injn.vx, injn.vy) * abs(fa.mjd_mid - fb.mjd_mid)
    sig = 0.5 * (ctx.sigma.get((injn.best_det, a), 0.7) + ctx.sigma.get((injn.best_det, b), 0.7))
    return shift, injn.snr * math.sqrt(max(0.0, 1.0 - math.exp(-shift * shift / (4.0 * sig * sig))))


DIPOLE_BINS = [0, 3, 5, 7, 10, 15, 20, 30, 50, 100]
SHIFT_BINS = [0, 0.25, 0.5, 1, 2, 4, 8, 16]


def binned(values: np.ndarray, hits: np.ndarray, edges: list[float]) -> list[dict[str, Any]]:
    rows = []
    for lo, hi in itertools.pairwise(edges):
        sel = (values >= lo) & (values < hi)
        n = int(sel.sum())
        k = int(hits[sel].sum()) if n else 0
        rows.append({"lo": lo, "hi": hi, "n": n, "k": k, "frac": k / n if n else None,
                     "err": math.sqrt(max(k, 1) * max(n - k, 1) / n**3) if n else None})
    return rows


def completeness(trials: list[dict[str, Any]]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for kind in ("mover", "variable", "static"):
        t = [r for r in trials if r["kind"] == kind]
        if not t:
            continue
        snr = np.array([r["snr"] for r in t])
        kept = np.array([r["kept"] for r in t])
        right = np.array([r["kept_right_kind"] for r in t])
        found = np.array([r["found"] for r in t])
        d: dict[str, Any] = {
            "n": len(t),
            "found_by_finder": float(found.mean()),
            "kept_q05": float(kept.mean()),
            "kept_q05_right_kind": float(right.mean()),
            "vs_snr_kept": binned(snr, kept, SNR_BINS),
            "vs_snr_right_kind": binned(snr, right, SNR_BINS),
        }
        hi = snr >= 10
        d["snr_ge_10"] = {"n": int(hi.sum()), "kept_q05": float(kept[hi].mean()) if hi.any() else None,
                          "kept_q05_right_kind": float(right[hi].mean()) if hi.any() else None}
        if kind == "mover":
            speed = np.array([r["speed"] for r in t])
            d["vs_speed_kept_snr_ge_10"] = binned(speed[hi], kept[hi], SPEED_BINS)
            d["vs_speed_right_kind_snr_ge_10"] = binned(speed[hi], right[hi], SPEED_BINS)
            dip = np.array([r["dipole_snr"] if r.get("dipole_snr") is not None else np.nan for r in t])
            shift = np.array([r["shift_px"] if r.get("shift_px") is not None else np.nan for r in t])
            ok = np.isfinite(dip)
            d["vs_dipole_snr_found"] = binned(dip[ok], found[ok], DIPOLE_BINS)
            d["vs_dipole_snr_kept"] = binned(dip[ok], kept[ok], DIPOLE_BINS)
            d["vs_shift_px_found_snr_ge_10"] = binned(shift[ok & hi], found[ok & hi], SHIFT_BINS)
            d["vs_shift_px_kept_snr_ge_10"] = binned(shift[ok & hi], kept[ok & hi], SHIFT_BINS)
            sel = ok & (dip >= 10)
            d["dipole_snr_ge_10"] = {"n": int(sel.sum()),
                                     "found": float(found[sel].mean()) if sel.any() else None,
                                     "kept_q05": float(kept[sel].mean()) if sel.any() else None,
                                     "kept_q05_right_kind": float(right[sel].mean()) if sel.any() else None}
            fk = np.array([r.get("finder_kind") == "mover" for r in t])
            d["finder_called_mover_when_found"] = float(fk[found].mean()) if found.any() else None
            fast = hi & (speed >= 1.0)
            d["snr_ge_10_speed_ge_1"] = {"n": int(fast.sum()), "kept_q05": float(kept[fast].mean()) if fast.any() else None,
                                         "kept_q05_right_kind": float(right[fast].mean()) if fast.any() else None}
        if kind == "variable":
            dm = np.abs(np.array([r["delta_mag"] for r in t]))
            d["vs_abs_delta_mag_kept_snr_ge_10"] = binned(dm[hi], kept[hi], DMAG_BINS)
        out[kind] = d
    return out


# --- real fields (controls, targets) -----------------------------------------------------------------------


def search_field(field_id: str) -> dict[str, Any]:
    """The live-API search of one survey field: every candidate with its q (this field's family)."""
    from pxh.ml import finder
    from pxh.ml.realbogus import load_model

    import survey_io as sio
    from movers import data as mdata

    model = load_model()
    stack = mdata.survey_stack(field_id)
    scored, diffs = finder.score_field(stack, model)
    finder.apply_fdr(scored)
    cy, cx = (stack.shape[0] - 1) / 2.0, (stack.shape[1] - 1) / 2.0
    centre = [s for s in scored if math.hypot(s.cand.x - cx, s.cand.y - cy) <= 6.0]
    kept = [s for s in scored if s.q <= ALPHA or s in centre]
    meas = finder.measure(stack, diffs, kept)
    try:
        sources = finder.sources_from_catalogs(sio.load_catalogs(field_id))
    except FileNotFoundError:
        sources = []
    rows = []
    for s, m in zip(kept, meas, strict=True):
        ra, dec = finder.best_position(stack, s, m)
        motion = m.get("motion") if s.kind == "mover" else None
        match = finder.catalogue_match(ra, dec, finder.candidate_epoch_mjd(stack, s.cand), s.kind, motion, sources)
        rows.append({"ra": ra, "dec": dec, "kind": s.kind, "q": s.q, "p": s.p, "score": s.score,
                     "snr": float(s.cand.snr), "flags": s.cand.flags, "dets": s.cand.dets, "motion": motion,
                     "variability": m.get("variability"), "match": match, "x": s.cand.x, "y": s.cand.y,
                     "probs": [round(float(v), 4) for v in s.probs], "finder_kind": s.cand.kind,
                     "in_family": s.in_family, "kept": s.q <= ALPHA})
    fov = float(stack.meta.get("fov_deg") or 0.1667)
    return {"field": field_id, "kind": stack.meta.get("kind"), "n_candidates": len(scored),
            "n_family": sum(1 for s in scored if s.in_family), "n_kept": sum(1 for r in rows if r["kept"]),
            "kept": [r for r in rows if r["kept"]], "centre": [r for r in rows if not r["kept"]],
            "area_deg2": fov * fov, "mjd_last": max(fr.mjd_mid for d in stack.dets for fr in stack.frames[d].values()),
            "cxy": [cx, cy]}


TARGET_TRUTH = {
    "barnards-star": ("mover", "Gaia DR3 4472832130942575872"),
    "eps-indi-b": ("mover", "Gaia DR3 6412596012146801152"),
    "wise-0855": ("mover", "Kirkpatrick et al. 2021 / CatWISE"),
    "rw-aur": ("variable", "SIMBAD RW Aur"),
    "r-dra": ("variable", "SIMBAD R Dra (Mira)"),
}


def target_report(res: dict[str, Any]) -> dict[str, Any]:
    """Is the target itself among the candidates (within 30 arcsec of its catalogue position at the latest epoch:
    the peaks around a saturated core sit up to a few pixels from the star)?"""
    from pxh.sky import propagate
    from pxh.sky.targets import list_targets

    t = next(t for t in list_targets(primary_only=True) if t.key == res["field"])
    ra_t, dec_t = propagate.barycentric_position(t.astrometry, res["mjd_last"])
    pm_cat = math.hypot(t.astrometry.pmra_masyr, t.astrometry.pmdec_masyr) / 1000.0
    pa_cat = math.degrees(math.atan2(t.astrometry.pmra_masyr, t.astrometry.pmdec_masyr)) % 360.0
    near = []
    for r in res["kept"] + res["centre"]:
        sep = 3600.0 * math.hypot((r["ra"] - float(ra_t)) * math.cos(math.radians(dec_t)), r["dec"] - float(dec_t))
        if sep <= TARGET_RADIUS_ARCSEC:
            near.append(r | {"sep_arcsec": sep})
    near.sort(key=lambda r: (r["q"], -r["score"]))
    want = TARGET_TRUTH[res["field"]][0]
    best = near[0] if near else None
    # targeted test: the target's position is known in advance, so the family is only the candidates within
    # TARGET_RADIUS_ARCSEC of it, not the whole field
    from pxh.ml.fdr import bh_q_values

    fam = [r for r in near if r.get("in_family", True)]
    q_t = bh_q_values([r["p"] for r in fam]) if fam else []
    for r, qv in zip(fam, q_t, strict=True):
        r["q_target"] = float(qv)
    for r in near:
        r.setdefault("q_target", 1.0)
    right = [r for r in near if r["kind"] == want and r["q_target"] <= ALPHA]
    tb = min(right or near, key=lambda r: (r["q_target"], -r["score"])) if near else None
    targeted = None if tb is None else {
        "family": len(fam), "q": tb["q_target"], "p": tb["p"], "kind": tb["kind"], "score": tb["score"],
        "probs": tb["probs"], "snr": tb["snr"], "finder_kind": tb["finder_kind"], "flags": tb["flags"],
        "sep_arcsec": tb["sep_arcsec"], "found": tb["q_target"] <= ALPHA,
        "right_kind": bool(tb["q_target"] <= ALPHA and tb["kind"] == want),
        "motion": tb["motion"], "variability": tb["variability"],
    }
    return {
        "targeted": targeted,
        "target": t.name, "expected": want, "catalog_pm_arcsec_yr": pm_cat, "catalog_pa_deg": pa_cat,
        "found": bool(best and best["kept"]), "candidate": best is not None, "p": best["p"] if best else None,
        "probs": best["probs"] if best else None, "snr": best["snr"] if best else None,
        "finder_kind": best["finder_kind"] if best else None,
        "found_kind": best["kind"] if best else None,
        "right_kind": bool(best and best["kept"] and best["kind"] == want), "q": best["q"] if best else None,
        "score": best["score"] if best else None, "sep_arcsec": best["sep_arcsec"] if best else None,
        "flags": best["flags"] if best else None, "motion": best["motion"] if best else None,
        "variability": best["variability"] if best else None, "n_kept_field": res["n_kept"],
        "n_candidates_field": res["n_candidates"],
    }


# --- stamps: confusion and reliability ----------------------------------------------------------------------


def stamp_metrics() -> dict[str, Any]:
    from pxh.ml.realbogus import load_model

    model = load_model()
    with np.load(ML / "data" / "movers" / "test.npz", allow_pickle=False) as z:
        x, y = z["stamps"].astype(np.float32), z["labels"].astype(int)
    p = model.predict_proba(x)
    pred = p.argmax(1)
    conf = np.zeros((4, 4), int)
    for t, q in zip(y, pred, strict=True):
        conf[t, q] += 1
    real = np.isin(y, [0, 1])
    score = p[:, 0] + p[:, 1]
    edges = np.linspace(0, 1, 11)
    rel = []
    for lo, hi in itertools.pairwise(edges):
        sel = (score >= lo) & (score < hi if hi < 1 else score <= hi)
        rel.append({"lo": float(lo), "hi": float(hi), "n": int(sel.sum()),
                    "mean_score": float(score[sel].mean()) if sel.any() else None,
                    "frac_real": float(real[sel].mean()) if sel.any() else None})
    conf_max = p.max(1)
    rel_max = []
    for lo, hi in itertools.pairwise(edges):
        sel = (conf_max >= lo) & (conf_max < hi if hi < 1 else conf_max <= hi)
        rel_max.append({"lo": float(lo), "hi": float(hi), "n": int(sel.sum()),
                        "mean_conf": float(conf_max[sel].mean()) if sel.any() else None,
                        "accuracy": float((pred[sel] == y[sel]).mean()) if sel.any() else None})
    ece = sum(r["n"] * abs(r["accuracy"] - r["mean_conf"]) for r in rel_max if r["n"]) / len(y)
    return {"n": len(y), "counts": np.bincount(y, minlength=4).tolist(), "accuracy": float((pred == y).mean()),
            "confusion": conf.tolist(), "reliability_score": rel, "reliability_maxprob": rel_max, "ece": float(ece),
            "real_vs_bogus_auc": float(_auc(score, real))}


def _auc(score: np.ndarray, pos: np.ndarray) -> float:
    order = np.argsort(score)
    ranks = np.empty(len(score))
    ranks[order] = np.arange(1, len(score) + 1)
    n_pos, n_neg = int(pos.sum()), int((~pos).sum())
    if not n_pos or not n_neg:
        return math.nan
    return (ranks[pos].sum() - n_pos * (n_pos + 1) / 2) / (n_pos * n_neg)


# --- known fast stars --------------------------------------------------------------------------------------


def known_recovery(split: dict[str, Any]) -> dict[str, Any]:
    from pxh.ml.fdr import bh_q_values

    import survey_io as sio
    from movers import data as mdata

    doc = json.loads(DISCOVERY_ALL.read_text(encoding="utf-8"))
    by_field: dict[str, list[dict]] = {}
    for c in doc["candidates"]:
        by_field.setdefault(c["field"], []).append(c)
    rows = []
    for f in doc["fields"]:
        fid = f["id"]
        try:
            cats = sio.load_catalogs(fid)
        except FileNotFoundError:
            continue
        stars = mdata.fast_movers(cats, 500.0)
        seen = set()
        for m in stars:
            row = m["row"]
            (round(row.get("ra", 0), 3), round(row.get("dec", 0), 3))
            # Gaia and CatWISE often list the same star: keep the first (Gaia)
            mjd = f["mjd_last"]
            ra, dec = mdata.mover_positions(m, mjd)
            if any(3600 * math.hypot((ra - a) * math.cos(math.radians(dec)), dec - b) < 6 for a, b in seen):
                continue
            seen.add((ra, dec))
            half = f["fov_deg"] / 2 - 4 * 6.15 / 3600
            if abs((ra - f["ra"] + 180) % 360 - 180) * math.cos(math.radians(dec)) > half or abs(dec - f["dec"]) > half:
                continue  # outside the grid (or within 4 px of its edge) at the latest epoch
            best = None
            near = []
            for c in by_field.get(fid, []):
                cra, cdec = c["ra"], c["dec"]
                ra_c, dec_c = mdata.mover_positions(m, c["mjd"])
                sep = 3600 * math.hypot((cra - ra_c) * math.cos(math.radians(dec_c)), cdec - dec_c)
                if sep <= 12.0:
                    near.append(c | {"sep": sep})
                    if best is None or c["q"] < best["q"]:
                        best = c | {"sep": sep}
            # targeted: the star's position is known in advance, so the family is the candidates within 12"
            fam = [c for c in near if c["in_family"]]
            q_t = bh_q_values([c["p"] for c in fam]) if fam else []
            tq = min(q_t) if fam else None
            t_mover = any(qv <= ALPHA and c["kind"] == "mover" for c, qv in zip(fam, q_t, strict=True))
            rows.append({
                "field": fid, "split": mdata.assign(fid, f["kind"], split), "catalog": m["catalog"], "id": m["id"],
                "pm": m["pm_masyr"] / 1000.0, "mag": m["mag"], "band": m["band"],
                "detected": best is not None, "q": best["q"] if best else None,
                "kept": bool(best and best["q"] <= ALPHA), "kept_mover": bool(best and best["q"] <= ALPHA
                                                                                and best["kind"] == "mover"),
                "q_targeted": tq, "targeted": bool(tq is not None and tq <= ALPHA), "targeted_mover": t_mover,
            })
    def summary(sel: list[dict]) -> dict[str, Any]:
        out = {"n": len(sel), "kept": sum(r["kept"] for r in sel), "kept_mover": sum(r["kept_mover"] for r in sel),
               "detected_any_q": sum(r["detected"] for r in sel),
               "targeted": sum(r["targeted"] for r in sel), "targeted_mover": sum(r["targeted_mover"] for r in sel)}
        g = [r for r in sel if r["band"] == "G" and r["mag"] is not None]
        edges = [6, 10, 12, 14, 16, 18, 21]
        out["vs_G"] = binned(np.array([r["mag"] for r in g]), np.array([r["kept"] for r in g]), edges) if g else []
        return out
    return {"rows": rows, "all": summary(rows),
            "not_trained_on": summary([r for r in rows if r["split"] != "train"]),
            "test": summary([r for r in rows if r["split"] == "test"]),
            "train": summary([r for r in rows if r["split"] == "train"])}


# --- figures ----------------------------------------------------------------------------------------------


def figures(metrics: dict[str, Any]) -> None:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    plt.rcParams.update({"font.size": 9, "axes.spines.top": False, "axes.spines.right": False})
    ink, accent, grey = "#2b2b2b", "#f0885a", "#8a8a85"
    comp = metrics.get("completeness")
    if comp:
        fig, axes = plt.subplots(1, 3, figsize=(10.5, 3.2))
        for kind, colour in (("mover", accent), ("variable", ink)):
            d = comp.get(kind)
            if not d:
                continue
            xs = [math.sqrt(r["lo"] * r["hi"]) for r in d["vs_snr_kept"] if r["n"]]
            ys = [r["frac"] for r in d["vs_snr_kept"] if r["n"]]
            es = [r["err"] for r in d["vs_snr_kept"] if r["n"]]
            axes[0].errorbar(xs, ys, yerr=es, marker="o", ms=3, color=colour, label=kind, capsize=2)
        axes[0].set_xscale("log")
        axes[0].set_xlabel("injected S/N in one epoch (mover) or of the change (variable)")
        axes[0].set_ylabel("found at q <= 0.05")
        axes[0].set_ylim(-0.02, 1.02)
        axes[0].legend(frameon=False)
        d = comp.get("mover")
        if d:
            rows = [r for r in d["vs_speed_kept_snr_ge_10"] if r["n"]]
            axes[1].errorbar([math.sqrt(r["lo"] * r["hi"]) for r in rows], [r["frac"] for r in rows],
                             yerr=[r["err"] for r in rows], marker="o", ms=3, color=accent, capsize=2)
            axes[1].set_xscale("log")
            axes[1].set_xlabel("injected speed (arcsec/yr), movers with S/N >= 10")
            axes[1].set_ylim(-0.02, 1.02)
        d = comp.get("variable")
        if d:
            rows = [r for r in d["vs_abs_delta_mag_kept_snr_ge_10"] if r["n"]]
            axes[2].errorbar([0.5 * (r["lo"] + r["hi"]) for r in rows], [r["frac"] for r in rows],
                             yerr=[r["err"] for r in rows], marker="o", ms=3, color=ink, capsize=2)
            axes[2].set_xlabel("|change| (mag), variables with S/N >= 10")
            axes[2].set_ylim(-0.02, 1.02)
        fig.tight_layout()
        fig.savefig(OUT / "movers_completeness.png", dpi=130)
        plt.close(fig)
        d = comp.get("mover")
        if d and d.get("vs_dipole_snr_found"):
            # why slow movers are missed: what the difference image can show, not the source's brightness
            from matplotlib.ticker import NullFormatter

            fig, axes = plt.subplots(1, 2, figsize=(8.0, 3.2))
            panels = (("vs_dipole_snr_found", "vs_dipole_snr_kept", "largest S/N the dipole can have",
                       [3, 5, 10, 20, 50, 100]),
                      ("vs_shift_px_found_snr_ge_10", "vs_shift_px_kept_snr_ge_10",
                       "shift over the long pair (px), S/N >= 10", [0.25, 0.5, 1, 2, 4]))
            for ax, (k_found, k_kept, label, ticks) in zip(axes, panels, strict=True):
                for key, colour, name in ((k_found, grey, "found by the finder"), (k_kept, accent, "kept, q <= 0.05")):
                    rows = [r for r in d[key] if r["n"] and r["hi"] > 0]
                    xs = [math.sqrt(max(r["lo"], 0.5 * r["hi"]) * r["hi"]) for r in rows]
                    ax.errorbar(xs, [r["frac"] for r in rows], yerr=[r["err"] for r in rows], marker="o", ms=3,
                                color=colour, label=name, capsize=2)
                ax.set_xscale("log")
                ax.set_xticks(ticks, [f"{t:g}" for t in ticks])
                ax.xaxis.set_minor_formatter(NullFormatter())
                ax.set_xlabel(label)
                ax.set_ylim(-0.02, 1.02)
            axes[0].set_ylabel("fraction of injected movers")
            axes[0].legend(frameon=False)
            fig.tight_layout()
            fig.savefig(OUT / "movers_dipole.png", dpi=130)
            plt.close(fig)
    st = metrics.get("stamps")
    if st:
        fig, axes = plt.subplots(1, 2, figsize=(8.0, 3.4))
        conf = np.array(st["confusion"], float)
        norm = conf / np.maximum(conf.sum(1, keepdims=True), 1)
        axes[0].imshow(norm, cmap="Greys", vmin=0, vmax=1)
        names = ["mover", "variable", "artifact", "nothing"]
        axes[0].set_xticks(range(4), names, rotation=30)
        axes[0].set_yticks(range(4), names)
        axes[0].set_xlabel("predicted")
        axes[0].set_ylabel("true")
        for i in range(4):
            for j in range(4):
                axes[0].text(j, i, f"{int(conf[i, j])}", ha="center", va="center",
                             color="white" if norm[i, j] > 0.5 else ink, fontsize=8)
        rel = [r for r in st["reliability_score"] if r["n"]]
        axes[1].plot([0, 1], [0, 1], color=grey, lw=1, ls="--")
        axes[1].plot([r["mean_score"] for r in rel], [r["frac_real"] for r in rel], marker="o", ms=3, color=accent,
                     label="score = P(mover) + P(variable)")
        relm = [r for r in st["reliability_maxprob"] if r["n"]]
        axes[1].plot([r["mean_conf"] for r in relm], [r["accuracy"] for r in relm], marker="s", ms=3, color=ink,
                     label="top-class probability")
        axes[1].set_xlabel("predicted probability")
        axes[1].set_ylabel("observed fraction")
        axes[1].legend(frameon=False, fontsize=7)
        fig.tight_layout()
        fig.savefig(OUT / "movers_confusion_reliability.png", dpi=130)
        plt.close(fig)
    kn = metrics.get("known")
    if kn and kn["all"]["vs_G"]:
        fig, ax = plt.subplots(figsize=(4.6, 3.2))
        for key, colour, label in (("all", accent, "all survey fields"), ("not_trained_on", ink, "fields not trained on")):
            rows = [r for r in kn[key]["vs_G"] if r["n"]]
            ax.errorbar([0.5 * (r["lo"] + r["hi"]) for r in rows], [r["frac"] for r in rows],
                        yerr=[r["err"] for r in rows], marker="o", ms=3, color=colour, capsize=2, label=label)
        ax.set_xlabel("Gaia G (mag)")
        ax.set_ylabel("recovered at q <= 0.05")
        ax.set_ylim(-0.02, 1.02)
        ax.legend(frameon=False, fontsize=7)
        fig.tight_layout()
        fig.savefig(OUT / "movers_known_recovery.png", dpi=130)
        plt.close(fig)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--reps", type=int, default=40)
    ap.add_argument("--workers", type=int, default=12)
    ap.add_argument("--parts", default="injections,controls,stamps,targets")
    args = ap.parse_args()
    from movers import data as mdata

    parts = set(args.parts.split(","))
    split = mdata.load_split()
    done = {r["id"] for r in mdata.done_fields()}
    test = [f for f in split["test"] if f in done]
    OUT.mkdir(parents=True, exist_ok=True)
    metrics = json.loads(METRICS.read_text(encoding="utf-8")) if METRICS.exists() else {}
    t0 = time.time()
    with ProcessPoolExecutor(max_workers=args.workers) as pool:
        if "injections" in parts:
            futs = [pool.submit(injection_trials, f, 5000 + 31 * i, args.reps) for i, f in enumerate(test)]
            trials = [r for fut in futs for r in fut.result()]
            metrics["completeness"] = completeness(trials)
            metrics["completeness"]["fields"] = test
            metrics["completeness"]["reps_per_field"] = args.reps
            print(json.dumps({k: {kk: v[kk] for kk in ("n", "kept_q05", "kept_q05_right_kind", "snr_ge_10")}
                              for k, v in metrics["completeness"].items() if isinstance(v, dict) and "n" in v}),
                  flush=True)
        if "controls" in parts:
            controls = [f for f in test if f.startswith("ctrl-")]
            res = list(pool.map(search_field, controls))
            n_kept = sum(r["n_kept"] for r in res)
            area = sum(r["area_deg2"] for r in res)
            metrics["controls"] = {
                "fields": controls, "area_deg2": area, "n_kept_q05": n_kept,
                "false_alarms_per_deg2_q05": n_kept / area if area else None,
                "n_kept_known": sum(1 for r in res for k in r["kept"] if k["match"]["status"] == "known"),
                "per_field": [{k: r[k] for k in ("field", "n_candidates", "n_family", "n_kept")} for r in res],
                "kept": [{"field": r["field"]} | k for r in res for k in r["kept"]],
            }
            print(f"controls: {n_kept} kept in {area:.4f} deg2", flush=True)
            # a larger area for an upper limit: every other test field, leaving out the circle of 45 arcsec around
            # the field centre where its known mover, brown dwarf or variable sits; whatever else is kept counts as
            # a false alarm, although some of it may be real
            others = [f for f in test if not f.startswith("ctrl-")]
            res_o = list(pool.map(search_field, others))
            r_px = 45.0 / 6.15
            extra = [{"field": r["field"]} | k for r in res_o for k in r["kept"]
                     if math.hypot(k["x"] - r["cxy"][0], k["y"] - r["cxy"][1]) > r_px]
            area_o = sum(r["area_deg2"] for r in res_o) - len(res_o) * math.pi * (45.0 / 3600.0) ** 2
            n_all, a_all = n_kept + len(extra), area + area_o
            metrics["controls"]["all_test_fields"] = {
                "fields": controls + others, "area_deg2": a_all, "n_kept_q05": n_all,
                "false_alarms_per_deg2_q05_upper": n_all / a_all if a_all else None,
                "n_kept_known": sum(1 for k in extra if k["match"]["status"] == "known")
                                + metrics["controls"]["n_kept_known"],
                "kept": [{kk: k[kk] for kk in ("field", "kind", "q", "score", "snr", "flags", "match")} for k in extra],
            }
            print(f"all test fields: {n_all} kept in {a_all:.4f} deg2", flush=True)
        if "targets" in parts:
            res = list(pool.map(search_field, [f for f in split["targets"] if f in done]))
            metrics["targets"] = {r["field"]: target_report(r) for r in res}
            for k, v in metrics["targets"].items():
                print(k, {kk: v[kk] for kk in ("found", "found_kind", "q", "motion")}, flush=True)
    if "stamps" in parts:
        metrics["stamps"] = stamp_metrics()
        print(f"stamps: accuracy {metrics['stamps']['accuracy']:.4f} on {metrics['stamps']['n']}", flush=True)
    if "known" in parts:
        metrics["known"] = known_recovery(split)
        print(json.dumps({k: {kk: v[kk] for kk in ("n", "kept", "kept_mover", "detected_any_q")}
                          for k, v in metrics["known"].items() if k != "rows"}), flush=True)
    from pxh.ml.realbogus import load_model

    model = load_model()
    metrics["model"] = {"name": model.name, "created": model.meta.get("created"), "temperature": model.temperature,
                        "n_null": int(model.null_scores.size)}
    metrics["generated"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    METRICS.write_text(json.dumps(metrics, indent=1, default=float) + "\n", encoding="utf-8")
    figures(metrics)
    print(f"done in {time.time() - t0:.0f} s -> {METRICS}", flush=True)


if __name__ == "__main__":
    main()
