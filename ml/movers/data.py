"""Survey fields as finder inputs (FieldStack), catalogue helpers, and the train / validation / test split.

The split is by field id, seeded, and fixed in ``ml/movers/split.json`` once written: the five challenge
targets are never trained on (they are evaluated on their own), and the test set holds at least three
control fields and two known-mover fields.
"""

from __future__ import annotations

import json
import math
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import numpy as np

ML = Path(__file__).resolve().parents[1]
if str(ML) not in sys.path:
    sys.path.insert(0, str(ML))

from pxh.ml.movers import FieldStack
from pxh.models import Frame

import survey_io as sio

DETS = (4, 5, 6)
SPLIT_PATH = ML / "movers" / "split.json"
SPLIT_SEED = 20261114
MJD_ZERO = datetime(1858, 11, 17, tzinfo=UTC)
MJD_2016 = 57388.5  # 2016.0 (Julian year), the Gaia DR3 epoch
MJD_CATWISE = 57170.0  # CatWISE2020 motion-fit epoch
FAST_PM_MASYR = 200.0  # catalogued stars faster than this are real movers, never "artifact" labels


def mjd_to_date(mjd: float) -> str:
    return (MJD_ZERO + timedelta(days=float(mjd))).strftime("%Y-%m-%d")


def field_record(field_id: str) -> dict[str, Any] | None:
    return next((r for r in sio.load_status().get("fields", []) if r.get("id") == field_id), None)


def survey_stack(field_id: str, dets: tuple[int, ...] = DETS) -> FieldStack:
    """FieldStack of a survey field from ``data/survey/<id>/D<n>.npz`` (detectors that exist on disk)."""
    frames: dict[int, dict[int, Frame]] = {}
    saturated: dict[int, dict[int, np.ndarray]] = {}
    full: dict[int, bool] = {}
    dates: dict[int, tuple[str, str]] = {}
    wcs = None
    shape = None
    rec = None
    for det in dets:
        if not sio.detector_path(field_id, det).exists():
            continue
        d = sio.load_field(field_id, det)
        rec = rec or d.get("field")
        wcs, shape = d["wcs"], tuple(d["data"].shape[1:])
        frames[det], saturated[det] = {}, {}
        for i, e in enumerate(np.asarray(d["epoch_index"]).tolist()):
            w = np.asarray(d["weight"][i], dtype=np.float32)
            if not np.any(w > 0):
                continue
            fwhm = d["psf_fwhm_arcsec"][i] if d.get("psf_fwhm_arcsec") is not None else np.nan
            frames[det][int(e)] = Frame(
                data=np.asarray(d["data"][i], dtype=np.float32), weight=w, wcs=wcs,
                mjd_mid=float(d["epoch_mjd"][i]),
                n_inputs=int(d["n_images"][i]) if d.get("n_images") is not None else 0,
                label=f"D{det} E{e}", detector=det, epoch_index=int(e),
                meta={"psf_fwhm_arcsec": float(fwhm)} if np.isfinite(fwhm) else {},
            )
            saturated[det][int(e)] = np.asarray(d["saturated"][i], dtype=bool)
            full[int(e)] = bool(d["full"][i])
            if d.get("epoch_start_mjd") is not None:
                dates[int(e)] = (mjd_to_date(d["epoch_start_mjd"][i]), mjd_to_date(d["epoch_end_mjd"][i]))
    if wcs is None:
        raise FileNotFoundError(f"no detector files for {field_id}")
    rec = rec or field_record(field_id) or {}
    meta = {k: rec.get(k) for k in ("id", "name", "kind", "ra", "dec", "fov_deg")}
    meta["id"] = field_id
    return FieldStack(wcs, shape, frames, saturated, full, dates, meta)


def done_fields(dets: tuple[int, ...] = DETS) -> list[dict[str, Any]]:
    """Survey fields with every detector of ``dets`` on disk."""
    out = []
    for rec in sio.list_fields(status=None):
        if all(sio.detector_path(rec["id"], d).exists() for d in dets):
            out.append(rec)
    return out


# --- split ------------------------------------------------------------------------------------------------


def make_split(records: list[dict[str, Any]], seed: int = SPLIT_SEED) -> dict[str, Any]:
    """Seeded split by field id: per kind, about 20% test and 20% validation (targets: evaluation only)."""
    rng = np.random.default_rng(seed)
    by_kind: dict[str, list[str]] = {}
    for r in records:
        by_kind.setdefault(r["kind"], []).append(r["id"])
    split: dict[str, list[str]] = {"train": [], "val": [], "test": [], "targets": []}
    minimum_test = {"control": 3, "known-mover": 2}
    for kind, ids in sorted(by_kind.items()):
        ids = sorted(ids)
        if kind == "target":
            split["targets"] += ids
            continue
        rng.shuffle(ids)
        n = len(ids)
        n_test = max(minimum_test.get(kind, 1), round(0.2 * n))
        n_val = max(1, round(0.2 * n))
        split["test"] += ids[:n_test]
        split["val"] += ids[n_test : n_test + n_val]
        split["train"] += ids[n_test + n_val :]
    return {k: sorted(v) for k, v in split.items()} | {"seed": seed, "rule": (
        "By field id, seeded; per kind about 20% test and 20% validation (at least 3 control and 2 "
        "known-mover fields in test); the five challenge targets are never trained on.")}


def load_split() -> dict[str, Any]:
    return json.loads(SPLIT_PATH.read_text(encoding="utf-8"))


def assign(field_id: str, kind: str, split: dict[str, Any]) -> str:
    """Split of a field; fields that arrived after the split was written are assigned by a stable hash."""
    for name in ("train", "val", "test", "targets"):
        if field_id in split.get(name, []):
            return name
    if kind == "target":
        return "targets"
    h = int.from_bytes(field_id.encode("utf-8"), "little") % 10
    return "test" if h < 2 else "val" if h < 4 else "train"


# --- catalogues ----------------------------------------------------------------------------------------


def _years(mjd: float, ref_mjd: float) -> float:
    return (mjd - ref_mjd) / 365.25


def gaia_at(rows: list[dict[str, Any]], mjd: float) -> np.ndarray:
    """[N, 2] Gaia DR3 positions (deg) moved linearly from 2016.0 to ``mjd`` (no parallax)."""
    if not rows:
        return np.zeros((0, 2))
    ra = np.array([r["ra"] for r in rows], float)
    dec = np.array([r["dec"] for r in rows], float)
    pmra = np.nan_to_num(np.array([r.get("pmra") if r.get("pmra") is not None else 0.0 for r in rows], float))
    pmdec = np.nan_to_num(np.array([r.get("pmdec") if r.get("pmdec") is not None else 0.0 for r in rows], float))
    dt = _years(mjd, MJD_2016)
    dec2 = dec + pmdec * dt / 3.6e6
    ra2 = ra + pmra * dt / 3.6e6 / np.cos(np.radians(dec))
    return np.stack([ra2 % 360.0, dec2], axis=1)


def catwise_at(rows: list[dict[str, Any]], mjd: float) -> np.ndarray:
    """[N, 2] CatWISE2020 positions moved from the motion-fit epoch (MJD 57170) to ``mjd``."""
    if not rows:
        return np.zeros((0, 2))
    ra = np.array([r.get("ra_pm") if r.get("ra_pm") is not None else r["ra"] for r in rows], float)
    dec = np.array([r.get("dec_pm") if r.get("dec_pm") is not None else r["dec"] for r in rows], float)
    pmra = np.nan_to_num(np.array([r.get("pmra") if r.get("pmra") is not None else 0.0 for r in rows], float))
    pmdec = np.nan_to_num(np.array([r.get("pmdec") if r.get("pmdec") is not None else 0.0 for r in rows], float))
    dt = _years(mjd, MJD_CATWISE)
    dec2 = dec + pmdec * dt / 3600.0
    ra2 = ra + pmra * dt / 3600.0 / np.cos(np.radians(dec))
    return np.stack([ra2 % 360.0, dec2], axis=1)


def sep_arcsec(ra1: float, dec1: float, ra2: np.ndarray, dec2: np.ndarray) -> np.ndarray:
    d_ra = (np.asarray(ra2) - ra1 + 180.0) % 360.0 - 180.0
    return 3600.0 * np.hypot(d_ra * math.cos(math.radians(dec1)), np.asarray(dec2) - dec1)


def fast_movers(cats: dict[str, Any], pm_min_masyr: float = FAST_PM_MASYR) -> list[dict[str, Any]]:
    """Catalogued stars faster than ``pm_min_masyr``: Gaia DR3 and significant CatWISE2020 motions."""
    out = []
    for r in cats.get("gaia", []):
        pmra, pmdec = r.get("pmra"), r.get("pmdec")
        if pmra is None or pmdec is None:
            continue
        pm = math.hypot(pmra, pmdec)
        if pm >= pm_min_masyr:
            out.append({"catalog": "Gaia DR3", "id": str(r["source_id"]), "pm_masyr": pm, "row": r,
                        "mag": r.get("phot_g_mean_mag"), "band": "G"})
    for r in cats.get("catwise", []):
        pmra, pmdec = r.get("pmra"), r.get("pmdec")
        spr, spd = r.get("sigpmra"), r.get("sigpmdec")
        if None in (pmra, pmdec, spr, spd):
            continue
        pm = 1000.0 * math.hypot(pmra, pmdec)
        sig = 1000.0 * math.hypot(spr, spd)
        if pm >= pm_min_masyr and pm >= 5.0 * sig:
            out.append({"catalog": "CatWISE2020", "id": r["source_name"], "pm_masyr": pm, "row": r,
                        "mag": r.get("w2mpro"), "band": "W2"})
    return out


def mover_positions(m: dict[str, Any], mjd: float) -> tuple[float, float]:
    pos = gaia_at([m["row"]], mjd) if m["catalog"] == "Gaia DR3" else catwise_at([m["row"]], mjd)
    return float(pos[0, 0]), float(pos[0, 1])


VARIABLE_OTYPES = ("V*", "Mi*", "LP*", "RR*", "Ce*", "EB*", "Or*", "TT*", "Y*O", "YSO", "Ae*", "Er*", "Fl*",
                   "BY*", "RS*", "Ro*", "Pu*", "dS*", "C*", "S*", "WV*", "s*r", "AGB", "No*", "CV*", "Be*",
                   "a2*", "El*", "Ir*", "gD*", "SX*", "RV*", "QSO", "AGN", "Bla", "BLL", "Sy1", "Sy2")


def simbad_variables(cats: dict[str, Any]) -> list[dict[str, Any]]:
    """SIMBAD objects whose type suggests variability (variable stars, young stars, AGN)."""
    out = []
    for r in cats.get("simbad", []):
        ot = (r.get("otype") or "").strip()
        if any(ot.startswith(v) for v in VARIABLE_OTYPES):
            out.append(r)
    return out
