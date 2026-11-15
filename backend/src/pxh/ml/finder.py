"""The full finder for one field: candidates, classifier scores, p-values, q-values and public records.

Shared by the live API (``pxh.api.candidates``, one field per request) and the survey run
(``scripts/run_discovery.py``, every survey field), so both produce the same per-candidate records:

1. ``pxh.ml.movers.find_candidates`` finds dipoles (movers) and single peaks (variables) in the S/N difference
   images, and cuts a 4 x 21 x 21 stamp of each.
2. The classifier (``pxh.ml.realbogus``) gives P(mover), P(variable), P(artifact), P(nothing); the score is
   P(mover) + P(variable), and the public ``kind`` is whichever of mover and variable is more probable.
3. p-values are conformal (``pxh.ml.fdr.conformal_p_values``) against the scores of real validation-field
   candidates shipped with the model. Candidates flagged ``edge`` (touching the grid border or a coverage gap)
   are left out of the test family (p = q = 1), as they were left out of the null set.
4. q-values are Benjamini-Hochberg (``pxh.ml.fdr.bh_q_values``) over the family of one search: one field, for
   the live API and for each field of the Discoveries list alike (``apply_fdr``).

``catalogue_match`` tells known from unknown: a candidate is known when a catalogued source (moved to the
candidate's epoch with its proper motion) lies within 6 arcsec and, for a mover, moves consistently.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

import numpy as np

from pxh.ml import movers as mv
from pxh.ml.fdr import bh_q_values
from pxh.ml.realbogus import RealBogus, load_model

MATCH_RADIUS_ARCSEC = 6.0
FDR_ALPHA = 0.05
LIST_Q_MAX = 0.2
MJD_ZERO = datetime(1858, 11, 17, tzinfo=UTC)
FAMILY_EXCLUDE_FLAGS = ("edge",)
CATALOG_PRIORITY = ("SIMBAD", "Gaia DR3", "CatWISE2020")


def mjd_to_date(mjd: float) -> str:
    return (MJD_ZERO + timedelta(days=float(mjd))).strftime("%Y-%m-%d")


@dataclass
class Scored:
    cand: mv.Candidate
    probs: np.ndarray
    score: float
    p: float
    kind: str
    in_family: bool
    q: float = 1.0
    extra: dict[str, Any] = field(default_factory=dict)


def score_field(
    stack: mv.FieldStack, model: RealBogus | None = None, threshold: float = mv.SNR_THRESHOLD
) -> tuple[list[Scored], dict]:
    """Candidates of one field with probabilities, scores and p-values (q-values: ``apply_fdr``)."""
    model = model or load_model()
    cands, diffs = mv.find_candidates(stack, threshold)
    if not cands:
        return [], diffs
    stamps = mv.cut_stamps(stack, diffs, cands)
    probs = model.predict_proba(stamps)
    scores = model.score(probs)
    pvals = model.p_values(scores)
    i_mover, i_var = model.classes.index("mover"), model.classes.index("variable")
    out = []
    for c, pr, s, p in zip(cands, probs, scores, pvals, strict=True):
        fam = not any(f in c.flags for f in FAMILY_EXCLUDE_FLAGS)
        out.append(Scored(
            cand=c, probs=pr, score=float(s), p=float(p) if fam else 1.0,
            kind="mover" if pr[i_mover] >= pr[i_var] else "variable", in_family=fam,
        ))
    return out, diffs


def apply_fdr(scored: Sequence[Scored]) -> None:
    """Benjamini-Hochberg q-values (in place) over the family members of ``scored``; others get q = 1."""
    fam = [s for s in scored if s.in_family]
    q = bh_q_values([s.p for s in fam]) if fam else []
    for s, qv in zip(fam, q, strict=True):
        s.q = float(qv)
    for s in scored:
        if not s.in_family:
            s.q = 1.0


# --- catalogue cross-match ---------------------------------------------------------------------------------


def catalog_source(catalog: str, ident: str, name: str, ra: float, dec: float, ref_mjd: float,
                   pmra: float | None, pmdec: float | None, mag: float | None = None) -> dict[str, Any]:
    """A catalogue entry in the form ``catalogue_match`` expects (pm in mas/yr; None when unknown; ``mag``: Gaia G
    or WISE W1, None when unknown)."""
    return {"catalog": catalog, "id": str(ident), "name": name, "ra": float(ra), "dec": float(dec),
            "ref_mjd": float(ref_mjd), "pmra": pmra, "pmdec": pmdec, "mag": mag}


def sources_from_catalogs(cats: dict[str, Any]) -> list[dict[str, Any]]:
    """Gaia DR3, CatWISE2020 and SIMBAD rows of a survey ``catalogs.json`` as catalogue entries."""
    out = []
    for r in cats.get("simbad", []) or []:
        if r.get("ra") is None or r.get("dec") is None:
            continue
        out.append(catalog_source("SIMBAD", r.get("main_id", ""), " ".join(str(r.get("main_id", "")).split()),
                                  r["ra"], r["dec"], 51544.5, r.get("pmra"), r.get("pmdec")))
    for r in cats.get("gaia", []) or []:
        out.append(catalog_source("Gaia DR3", r["source_id"], f"Gaia DR3 {r['source_id']}", r["ra"], r["dec"],
                                  57388.5, r.get("pmra"), r.get("pmdec"), r.get("phot_g_mean_mag")))
    for r in cats.get("catwise", []) or []:
        ra = r.get("ra_pm") if r.get("ra_pm") is not None else r.get("ra")
        dec = r.get("dec_pm") if r.get("dec_pm") is not None else r.get("dec")
        if ra is None or dec is None:
            continue
        pmra = 1000.0 * r["pmra"] if r.get("pmra") is not None else None
        pmdec = 1000.0 * r["pmdec"] if r.get("pmdec") is not None else None
        ref = 57170.0 if r.get("ra_pm") is not None else float(r.get("meanobsmjd") or 57170.0)
        out.append(catalog_source("CatWISE2020", r["source_name"], f"CatWISE2020 {r['source_name']}", ra, dec, ref,
                                  pmra, pmdec, r.get("w1mpro")))
    return out


def _moved(src: dict[str, Any], mjd: float) -> tuple[float, float]:
    dt = (mjd - src["ref_mjd"]) / 365.25
    pmra = src["pmra"] or 0.0
    pmdec = src["pmdec"] or 0.0
    dec = src["dec"] + pmdec * dt / 3.6e6
    ra = src["ra"] + pmra * dt / 3.6e6 / max(math.cos(math.radians(dec)), 1e-6)
    return ra % 360.0, dec


def _pm_total_arcsec(src: dict[str, Any]) -> float | None:
    if src["pmra"] is None or src["pmdec"] is None:
        return None
    return math.hypot(src["pmra"], src["pmdec"]) / 1000.0


def motion_consistent(src: dict[str, Any], motion: dict[str, Any] | None) -> bool:
    """A catalogued source moves consistently with a mover candidate (see the module docstring)."""
    pm_cat = _pm_total_arcsec(src)
    if pm_cat is None:
        return False
    if motion is None or motion.get("pm_arcsec_yr") is None:
        return pm_cat >= 0.1
    pm = float(motion["pm_arcsec_yr"])
    err = float(motion.get("pm_err_arcsec_yr") or 0.0)
    return abs(pm_cat - pm) <= max(3.0 * err, 0.3 * max(pm, pm_cat), 0.3)


STATIC_PM_ARCSEC_YR = 0.1
STATIC_RADIUS_ARCSEC = 9.0  # 1.5 px: a dipole's midpoint sits up to about a pixel from the star
STATIC_BRIGHT = {"Gaia DR3": 16.0, "CatWISE2020": 14.0}  # G, W1: bright enough to leave a residual
MOTION_SIGNIFICANT = 3.0


def static_star_residual(
    ra: float, dec: float, mjd: float, motion: dict[str, Any] | None, sources: Sequence[dict[str, Any]],
) -> dict[str, Any] | None:
    """The bright catalogued star a mover candidate is most likely a residual of, or None.

    Co-adds of different epochs are registered to 0.1-0.25 arcsec, so a bright star that does not move still
    leaves a small dipole in the difference image, and a few of these look like movers to the classifier. A
    mover candidate is called a residual when its own position fit shows no significant motion (none, or below
    3 sigma) and a bright star (G <= 16 or W1 <= 14) that Gaia or CatWISE measured as static (below 0.1"/yr) lies
    within 9 arcsec. Movers with a significant motion are never vetoed.
    """
    if motion is not None and motion.get("pm_arcsec_yr") is not None:
        err = float(motion.get("pm_err_arcsec_yr") or 0.0)
        if err > 0 and float(motion["pm_arcsec_yr"]) >= MOTION_SIGNIFICANT * err:
            return None
    cosd = math.cos(math.radians(dec))
    best: tuple[float, dict[str, Any]] | None = None
    for src in sources:
        lim = STATIC_BRIGHT.get(src["catalog"])
        mag = src.get("mag")
        pm = _pm_total_arcsec(src)
        if lim is None or mag is None or pm is None or mag > lim or pm >= STATIC_PM_ARCSEC_YR:
            continue
        if abs(src["dec"] - dec) > 0.01:
            continue
        sra, sdec = _moved(src, mjd)
        sep = 3600.0 * math.hypot(((sra - ra + 180.0) % 360.0 - 180.0) * cosd, sdec - dec)
        if sep <= STATIC_RADIUS_ARCSEC and (best is None or sep < best[0]):
            best = (sep, src)
    if best is None:
        return None
    sep, src = best
    return {"catalog": src["catalog"], "id": src["id"], "mag": src.get("mag"), "sep_arcsec": round(sep, 2)}


NO_MATCH = {"status": "unknown", "catalog": None, "name": None, "id": None, "sep_arcsec": None,
            "catalog_pm_arcsec_yr": None}


def catalogue_match(
    ra: float, dec: float, mjd: float, kind: str, motion: dict[str, Any] | None, sources: Sequence[dict[str, Any]],
    radius_arcsec: float = MATCH_RADIUS_ARCSEC,
) -> dict[str, Any]:
    """Nearest consistent catalogued source within ``radius_arcsec`` (SIMBAD first, then Gaia, then CatWISE)."""
    best: dict[str, tuple[float, dict[str, Any]]] = {}
    cosd = math.cos(math.radians(dec))
    for src in sources:
        if abs(src["dec"] - dec) > 0.05:
            continue
        sra, sdec = _moved(src, mjd)
        d_ra = ((sra - ra + 180.0) % 360.0 - 180.0) * cosd
        sep = 3600.0 * math.hypot(d_ra, sdec - dec)
        if sep > radius_arcsec:
            continue
        if kind == "mover" and not motion_consistent(src, motion):
            continue
        cat = src["catalog"]
        if cat not in best or sep < best[cat][0]:
            best[cat] = (sep, src)
    for cat in CATALOG_PRIORITY:
        if cat in best:
            sep, src = best[cat]
            pm = _pm_total_arcsec(src)
            return {"status": "known", "catalog": cat, "name": src["name"], "id": src["id"],
                    "sep_arcsec": round(sep, 2), "catalog_pm_arcsec_yr": round(pm, 4) if pm is not None else None}
    return dict(NO_MATCH)


# --- records -----------------------------------------------------------------------------------------------


def candidate_epoch_mjd(stack: mv.FieldStack, c: mv.Candidate) -> float:
    return float(stack.frames[c.det][c.a].mjd_mid)


def best_position(stack: mv.FieldStack, s: Scored, measurement: dict[str, Any]) -> tuple[float, float]:
    """Sky position at the candidate's later epoch: from the proper-motion fit when there is one (a dipole's
    lobes sit up to a pixel outside the source), else the finder's peak (``movers.candidate_world``)."""
    motion = measurement.get("motion") if s.kind == "mover" else None
    if motion and motion.get("ra_ref") is not None and motion.get("pmra_masyr") is not None:
        dt = (candidate_epoch_mjd(stack, s.cand) - motion["ref_mjd"]) / 365.25
        dec = motion["dec_ref"] + motion["pmdec_masyr"] * dt / 3.6e6
        ra = motion["ra_ref"] + motion["pmra_masyr"] * dt / 3.6e6 / max(math.cos(math.radians(dec)), 1e-6)
        return ra % 360.0, dec
    return mv.candidate_world(stack, s.cand)


def candidate_record(
    stack: mv.FieldStack, s: Scored, cid: str, field_id: str, measurement: dict[str, Any], match: dict[str, Any],
    stamp: str, classes: Sequence[str] = mv.CLASSES,
) -> dict[str, Any]:
    """One candidate in the public schema (frontend/public/discoveries/README.md)."""
    c = s.cand
    ra, dec = best_position(stack, s, measurement)
    motion = measurement.get("motion") if s.kind == "mover" else None
    var = measurement.get("variability") if s.kind == "variable" else None
    fa, fb = stack.frames[c.det][c.a], stack.frames[c.det][c.b]
    return {
        "id": cid,
        "field": field_id,
        "ra": round(ra, 6),
        "dec": round(dec, 6),
        "kind": s.kind,
        "score": round(s.score, 4),
        "probs": {name: round(float(p), 4) for name, p in zip(classes, s.probs, strict=True)},
        "p_value": float(f"{s.p:.4g}"),
        "q_value": float(f"{s.q:.4g}"),
        "snr": round(abs(float(c.snr)), 1),
        "motion": None if motion is None else {k: motion[k] for k in
                                               ("pm_arcsec_yr", "pm_err_arcsec_yr", "pa_deg", "n_epochs")},
        "variability": None if var is None else {"delta_mag": var["delta_mag"], "sigma": var["sigma"]},
        "detectors": [f"D{d}" for d in c.dets],
        "epochs": [mjd_to_date(fb.mjd_mid), mjd_to_date(fa.mjd_mid)],
        "match": match,
        "stamp": stamp,
        "lab_url": f"/explore?ra={ra:.5f}&dec={dec:.5f}&fov=0.1667",
    }


def measure(stack: mv.FieldStack, diffs: dict, scored: Sequence[Scored]) -> list[dict[str, Any]]:
    """Motion (movers) and variability (variables) of each scored candidate, by its public kind."""
    if not scored:
        return []
    fwhm = {}
    for det in stack.dets:
        last = max(stack.frames[det])
        fwhm[det] = mv.estimate_fwhm(stack.frames[det][last], stack.saturated.get(det, {}).get(last))
    out = []
    for s in scored:
        c = s.cand
        if s.kind == "mover":
            if c.x_pos is None:  # a single peak the classifier calls a mover: fit from a static start
                c = mv.Candidate(**{**c.__dict__, "x_pos": c.x, "y_pos": c.y, "x_neg": c.x, "y_neg": c.y})
            out.append({"motion": mv.measure_motion(stack, c, fwhm), "variability": None})
        else:
            cv = c if c.kind == "variable" else mv.Candidate(**{**c.__dict__, "kind": "variable"})
            out.append({"motion": None, "variability": mv.measure_variability(stack, diffs, cv, fwhm)})
    return out
