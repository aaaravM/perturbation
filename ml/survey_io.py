"""Read (and write) the survey dataset: per-epoch SPHEREx co-adds of about 60 sky fields, plus catalogues.

Layout under ``data/survey/`` (override with the environment variable ``PXH_SURVEY_DIR``):

- ``fields.json``: every field of ``ml/survey_fields.json`` with its build status (queued, building, done or
  failed), epochs, detectors done and timings. Rewritten by ``scripts/build_survey.py`` as it goes.
- ``<id>/D<n>.npz``: the co-adds of detector n (1-6), one plane per epoch that has data for that detector,
  all on one shared north-up TAN grid (10 arcmin, 6.15 arcsec pixels). See ``ARRAY_SPEC`` for the arrays.
- ``<id>/catalogs.json``: Gaia DR3, CatWISE2020 and SIMBAD sources in and around the field.
- ``<id>/status.json``: the per-field status record that ``fields.json`` is merged from.

Usage::

    import survey_io as sio
    for f in sio.list_fields():                  # fields whose core detectors are all built
        d = sio.load_field(f["id"], 6)           # dict of arrays + "wcs", "header", "meta", "field"
        cats = sio.load_catalogs(f["id"])        # {"gaia": [...], "catwise": [...], "simbad": [...], ...}

Only numpy and astropy are needed, so the builder (backend environment) and the models (ml environment)
share this one definition of the format.
"""

from __future__ import annotations

import json
import os
import time
from collections.abc import Iterable, Mapping
from pathlib import Path
from typing import Any

import numpy as np

REPO_ROOT = Path(__file__).resolve().parents[1]
SCHEMA = "pxh-survey-detector/1"
FIELDS_SCHEMA = "pxh-survey-status/1"
STATUSES = ("queued", "building", "done", "failed")

# name -> (dtype, shape description). E = epochs with data for this detector, N = grid side (99 at 10').
ARRAY_SPEC: dict[str, tuple[str, str]] = {
    "data": ("float32", "E,N,N surface brightness minus zodiacal light, MJy/sr; NaN where no valid pixel"),
    "weight": ("float32", "E,N,N inverse variance, (MJy/sr)^-2; 0 where masked, saturated or uncovered"),
    "n_used": ("int16", "E,N,N number of exposures co-added in each pixel"),
    "saturated": ("bool", "E,N,N a saturated (OVERFLOW) input pixel touched this grid pixel"),
    "epoch_index": ("int16", "E index into the field's epoch list (fields.json 'epochs')"),
    "epoch_mjd": ("float64", "E weight-averaged MJD of the co-added exposures"),
    "epoch_start_mjd": ("float64", "E first exposure of the epoch window (all detectors)"),
    "epoch_end_mjd": ("float64", "E last exposure of the epoch window (all detectors)"),
    "epoch_label": ("str", "E month label, e.g. 'Aug 2025'"),
    "survey": ("str", "E S1/S2 (Year 1, PA 0/180) or S3/S4 (Year 2)"),
    "year": ("int8", "E survey year, 1 (DR1) or 2 (QR3)"),
    "pa": ("int16", "E orientation SPS_EPA, 0 or 180 (-1 unknown)"),
    "full": ("bool", "E full epoch (every sampled detector >= 12 images) or partial"),
    "wl_min_um": ("float32", "E lowest central wavelength at the field centre among the co-added exposures"),
    "wl_max_um": ("float32", "E highest central wavelength at the field centre"),
    "wl_center_um": ("float32", "E mean central wavelength at the field centre"),
    "psf_fwhm_arcsec": ("float32", "E median header PSF_FWHM of the co-added exposures; NaN if unknown"),
    "n_images": ("int16", "E exposures co-added"),
    "n_available": ("int16", "E exposures of this detector in the epoch (before the per-epoch cap)"),
    "coverage_fraction": ("float32", "E fraction of grid pixels with weight > 0"),
    "wcs_header": ("str", "scalar: the grid WCS as a FITS header string (cards separated by newlines)"),
    "meta_json": ("str", "scalar: JSON with provenance (obs_ids per epoch, settings, counts, credits)"),
}
REQUIRED = ("data", "weight", "saturated", "epoch_mjd", "epoch_label", "survey", "full", "wl_min_um",
            "wl_max_um", "psf_fwhm_arcsec", "wcs_header")


def survey_dir() -> Path:
    return Path(os.environ.get("PXH_SURVEY_DIR", str(REPO_ROOT / "data" / "survey")))


def field_dir(field_id: str, root: Path | None = None) -> Path:
    return (root or survey_dir()) / field_id


def detector_path(field_id: str, det: int, root: Path | None = None) -> Path:
    return field_dir(field_id, root) / f"D{int(det)}.npz"


# --- writing (used by scripts/build_survey.py) ------------------------------------------------------------


def _replace(tmp: Path, path: Path) -> None:
    for attempt in range(20):  # Windows: a reader holding the old file open blocks os.replace briefly
        try:
            os.replace(tmp, path)
            return
        except PermissionError:
            if attempt == 19:
                raise
            time.sleep(0.25)


def write_json(path: Path, doc: Any) -> None:
    """Atomic JSON write (temp file in the same directory, then rename)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(doc, indent=1, allow_nan=False, default=_json_default), encoding="utf-8")
    _replace(tmp, path)


def _json_default(value: Any) -> Any:
    if isinstance(value, np.integer):
        return int(value)
    if isinstance(value, np.floating):
        return None if not np.isfinite(value) else float(value)
    if isinstance(value, np.bool_):
        return bool(value)
    if isinstance(value, np.ndarray):
        return value.tolist()
    raise TypeError(f"not JSON serialisable: {type(value).__name__}")


def save_detector(path: Path, arrays: Mapping[str, Any]) -> None:
    """Write one detector file atomically, checking names, dtypes and shapes against ``ARRAY_SPEC``."""
    missing = [k for k in REQUIRED if k not in arrays]
    if missing:
        raise ValueError(f"missing arrays: {', '.join(missing)}")
    out: dict[str, np.ndarray] = {}
    n_epochs: int | None = None
    for name, value in arrays.items():
        if name not in ARRAY_SPEC:
            raise ValueError(f"unknown array {name!r}")
        dtype = ARRAY_SPEC[name][0]
        arr = np.asarray(value, dtype=str) if dtype == "str" else np.asarray(value, dtype=dtype)
        if name in ("wcs_header", "meta_json"):
            if arr.ndim != 0:
                raise ValueError(f"{name} must be a scalar string")
        else:
            if n_epochs is None:
                n_epochs = int(arr.shape[0])
            if arr.shape[0] != n_epochs:
                raise ValueError(f"{name} has {arr.shape[0]} epochs, expected {n_epochs}")
        out[name] = arr
    cube = out["data"].shape
    for name in ("weight", "n_used", "saturated"):
        if name in out and out[name].shape != cube:
            raise ValueError(f"{name} shape {out[name].shape} differs from data {cube}")
    if "meta_json" not in out:
        out["meta_json"] = np.asarray(json.dumps({"schema": SCHEMA}))
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.stem}.{os.getpid()}.tmp.npz")
    np.savez_compressed(tmp, **out)
    _replace(tmp, path)


# --- reading ------------------------------------------------------------------------------------------------


def load_status(root: Path | None = None) -> dict[str, Any]:
    """The whole ``fields.json`` document (``{"schema", "updated_at", "fields": [...]}``)."""
    path = (root or survey_dir()) / "fields.json"
    for attempt in range(10):
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return {"schema": FIELDS_SCHEMA, "fields": []}
        except (json.JSONDecodeError, PermissionError):
            if attempt == 9:
                raise
            time.sleep(0.2)
    raise AssertionError("unreachable")


def list_fields(
    status: str | None = "done",
    *,
    kind: str | Iterable[str] | None = None,
    det: int | None = None,
    root: Path | None = None,
) -> list[dict[str, Any]]:
    """Field records from ``fields.json``, in survey order.

    ``status``: "done" (default: every core detector built), "building", "queued", "failed", or None for all.
    ``kind``: one kind or several (target, known-mover, brown-dwarf, variable, control).
    ``det``: keep only fields where detector ``det`` is built (works for fields still building).
    """
    kinds = {kind} if isinstance(kind, str) else (set(kind) if kind is not None else None)
    out = []
    for rec in load_status(root).get("fields", []):
        if status is not None and rec.get("status") != status:
            continue
        if kinds is not None and rec.get("kind") not in kinds:
            continue
        if det is not None and f"D{int(det)}" not in rec.get("detectors_done", []):
            continue
        out.append(rec)
    return out


def _decode(z: Any, name: str) -> Any:
    arr = z[name]
    if arr.dtype.kind == "U":
        return str(arr) if arr.ndim == 0 else arr.astype(str)
    return arr


def load_field(field_id: str, det: int, *, root: Path | None = None) -> dict[str, Any]:
    """Arrays of one detector of one field, plus ``wcs`` (astropy WCS of the grid), ``header`` (its FITS
    header), ``meta`` (provenance dict), ``field`` (the fields.json record, if any), ``det`` and ``shape``.

    Missing optional arrays come back as None (``n_used`` is always written by the builder).
    """
    from astropy.io import fits
    from astropy.wcs import WCS

    path = detector_path(field_id, det, root)
    with np.load(path, allow_pickle=False) as z:
        out: dict[str, Any] = {name: _decode(z, name) for name in z.files}
    for name in ARRAY_SPEC:
        out.setdefault(name, None)
    header = fits.Header.fromstring(out["wcs_header"], sep="\n")
    out["header"] = header
    out["wcs"] = WCS(header)
    out["meta"] = json.loads(out.pop("meta_json") or "{}")
    out["det"] = int(det)
    out["field_id"] = field_id
    out["shape"] = tuple(out["data"].shape)
    rec = next((r for r in load_status(root).get("fields", []) if r.get("id") == field_id), None)
    out["field"] = rec
    return out


def load_catalogs(field_id: str, *, root: Path | None = None) -> dict[str, Any]:
    """``catalogs.json`` of a field: {"gaia": [...], "catwise": [...], "simbad": [...], "meta": {...}}.

    Gaia rows: source_id (str), ra/dec at 2016.0 [deg], ra_error/dec_error [mas], pmra/pmdec [mas/yr] and
    errors, parallax [mas] and error, phot_g_mean_mag, bp_rp, ruwe. CatWISE2020 rows: source_name, ra/dec
    (stationary fit, at meanobsmjd), ra_pm/dec_pm (motion fit, at MJD 57170 = 2015.405), pmra/pmdec
    [arcsec/yr, as in the catalogue] and errors, w1mpro/w2mpro [Vega mag] and errors, ab_flags, cc_flags.
    SIMBAD rows: main_id, otype, sp_type, ra/dec [deg, J2000 epoch], pmra/pmdec [mas/yr], plx_value [mas].
    """
    path = field_dir(field_id, root) / "catalogs.json"
    return json.loads(path.read_text(encoding="utf-8"))


def jyear_from_mjd(mjd: float) -> float:
    return 2000.0 + (float(mjd) - 51544.5) / 365.25


def gaia_at(cats: Mapping[str, Any], mjd: float, *, min_pm_masyr: float | None = None) -> dict[str, np.ndarray]:
    """Gaia DR3 rows of a field moved linearly from 2016.0 to ``mjd`` (proper motion only).

    Parallax is ignored (at most 0.55 arcsec, 0.09 pixel, for Barnard's Star; under 0.1 arcsec for most
    stars). Rows without a proper motion stay at their 2016.0 position (``has_pm`` False). Returns arrays
    source_id (str), ra, dec [deg], pmra, pmdec, pm [mas/yr], parallax [mas], g, bp_rp [mag], has_pm.
    """
    rows = list(cats.get("gaia", []))

    def col(name: str) -> np.ndarray:
        return np.array([np.nan if r.get(name) is None else float(r[name]) for r in rows], dtype=np.float64)

    ra0, dec0, pmra, pmdec = col("ra"), col("dec"), col("pmra"), col("pmdec")
    has_pm = np.isfinite(pmra) & np.isfinite(pmdec)
    pmra, pmdec = np.where(has_pm, pmra, 0.0), np.where(has_pm, pmdec, 0.0)
    dt = jyear_from_mjd(mjd) - 2016.0
    dec = dec0 + pmdec * dt / 3.6e6
    ra = (ra0 + pmra * dt / 3.6e6 / np.maximum(np.cos(np.radians(dec0)), 1e-6)) % 360.0
    out = {
        "source_id": np.array([str(r.get("source_id")) for r in rows], dtype=str),
        "ra": ra, "dec": dec, "pmra": pmra, "pmdec": pmdec, "pm": np.hypot(pmra, pmdec),
        "parallax": col("parallax"), "g": col("phot_g_mean_mag"), "bp_rp": col("bp_rp"), "has_pm": has_pm,
    }
    if min_pm_masyr is not None:
        keep = out["pm"] >= float(min_pm_masyr)
        out = {k: v[keep] for k, v in out.items()}
    return out


def detector_keys(field_id: str, *, root: Path | None = None) -> list[int]:
    """Detectors with a file on disk for this field (whatever fields.json says)."""
    d = field_dir(field_id, root)
    return sorted(int(p.stem[1:]) for p in d.glob("D[1-6].npz"))
