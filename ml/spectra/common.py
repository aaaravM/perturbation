"""Shared definitions for the spectral classifier: paths, classes and the labelling rules.

The input preprocessing (normalisation, validity mask) is NOT defined here: it lives in the backend module
``pxh.ml.specclass`` so that training and the deployed API use the very same code.
"""

from __future__ import annotations

import math
import re
from pathlib import Path

ML_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = ML_ROOT.parent
DATA = ML_ROOT / "data" / "spectra"
JOBS = DATA / "jobs"
RUNS = ML_ROOT / "runs" / "spectra"
CHECKPOINTS = ML_ROOT / "checkpoints"
DOCS_FIG = REPO_ROOT / "docs" / "validation"

SEED = 20261114
EPOCH_SPHEREX = 2025.9  # mean epoch of the DR1 cube (Year 1: May 2025 - May 2026)

# --- selection ---------------------------------------------------------------------------------------------
ISOLATION_ARCSEC = 20.0  # no Gaia source brighter than the target + 2 mag within this radius
ISOLATION_DMAG = 2.0
SNR_MIN = 5.0
SNR_MIN_CHANNELS = 20

# --- SIMBAD object types (basic.otype short codes) ------------------------------------------------------------
YSO_OTYPES = {"Y*O", "TT*", "Ae*", "Or*"}
QSO_OTYPES = {"QSO"}
GALAXY_OTYPES = {
    "G", "GiC", "GiG", "GiP", "BiC", "IG", "PaG", "SBG", "H2G", "EmG", "LSB", "bCG", "LIN", "Sy2", "SyG",
    "Sy1", "AGN", "rG", "GrG", "CGG", "ClG", "PCG",
}
# Kinds of object that are none of the seven classes: kept apart (never trained on) as unusual examples.
OTHER_OTYPES = {
    "WD*", "WD?", "C*", "C*?", "S*", "S*?", "PN", "PN?", "LP*", "LP?", "Mi*", "Mi?", "AB*", "AB?", "OH*", "OH?",
    "pA*", "pA?", "WR*", "WR?", "Ce*", "Ce?", "cC*", "RR*", "RR?", "No*", "No?", "SN*", "SN?", "HII", "RNe",
    "Bla", "BLL", "BL?", "CV*", "CV?", "XB*", "LXB", "HXB", "Psr", "As*", "Cl*", "GlC", "OpC", "SNR",
    "sg*", "s*r", "s*y", "s*b", "RSG", "YSG", "BSG", "Pec*", "ULX", "gB", "PoC",
}
# Candidates for one of the classes: neither a label for that class nor (through Gaia) for another one.
CANDIDATE_OTYPES = {"Y*?", "TT?", "Ae?", "BD?", "Q?", "G?", "Gr?", "ClG?", "AG?", "Bz?"}

SPTYPE_BD = re.compile(r"^\s*(sd|esd|usd|d)?\s*[LTY]\s*\d")
SPTYPE_MAIN = re.compile(r"^\s*(sd|esd|usd|d|k|g)?\s*([OBAFGKM])\s*\d?")
SPTYPE_WD = re.compile(r"^\s*D[ABOQZCX]")

CLASSES = ("hot_star", "sunlike_star", "cool_star", "brown_dwarf", "young_dusty", "galaxy", "quasar")
PLAIN = {
    "hot_star": "hot star",
    "sunlike_star": "Sun-like star",
    "cool_star": "cool star",
    "brown_dwarf": "brown dwarf",
    "young_dusty": "young or dusty star",
    "galaxy": "galaxy",
    "quasar": "quasar",
}
PLAIN_LONG = {
    "hot_star": "Hot star (types O, B and A, hotter than 7,500 K)",
    "sunlike_star": "Sun-like star (types F, G and K, 3,900 to 7,500 K)",
    "cool_star": "Cool star (type M, cooler than 3,900 K)",
    "brown_dwarf": "Brown dwarf (types L, T and Y)",
    "young_dusty": "Young or dusty star (young stellar objects, T Tauri and Herbig Ae/Be stars)",
    "galaxy": "Galaxy",
    "quasar": "Quasar",
}


def _num(v: object) -> float | None:
    try:
        f = float(v)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def label_from_catalogues(
    otype: str | None,
    sp_type: str | None,
    teff: float | None,
    p_qso: float | None,
    p_gal: float | None,
) -> tuple[str | None, str]:
    """(class or 'other' or None, where the label came from).

    Order: SIMBAD object types that are none of the classes ('other'), candidates for a class (no label),
    brown dwarfs (spectral type L/T/Y),
    young stars (YSO, T Tauri, Herbig Ae/Be, Orion variables), quasars and galaxies (SIMBAD type), the SIMBAD
    spectral type (O/B/A, F/G/K, M), then Gaia DR3: DSC-Combmod quasar or galaxy probability > 0.9, and
    finally the GSP-Phot temperature. None: no usable label.
    """
    ot = (otype or "").strip()
    sp = (sp_type or "").strip()
    teff = _num(teff)
    p_qso = _num(p_qso)
    p_gal = _num(p_gal)
    if ot in OTHER_OTYPES or (sp and SPTYPE_WD.match(sp)):
        return "other", f"SIMBAD type {ot or sp}"
    if ot in CANDIDATE_OTYPES:
        return None, f"SIMBAD candidate type {ot}"
    if sp and SPTYPE_BD.match(sp):
        return "brown_dwarf", f"SIMBAD spectral type {sp}"
    if ot in ("BD*",):
        if sp and SPTYPE_MAIN.match(sp):
            return "other", f"SIMBAD brown dwarf of spectral type {sp}"  # young M-type brown dwarfs: ambiguous
        return "brown_dwarf", "SIMBAD type BD*"
    if ot in YSO_OTYPES:
        return "young_dusty", f"SIMBAD type {ot}"
    if ot in QSO_OTYPES:
        return "quasar", "SIMBAD type QSO"
    if ot in GALAXY_OTYPES:
        return "galaxy", f"SIMBAD type {ot}"
    if sp:
        m = SPTYPE_MAIN.match(sp)
        if m:
            letter = m.group(2)
            cls = "hot_star" if letter in "OBA" else ("sunlike_star" if letter in "FGK" else "cool_star")
            return cls, f"SIMBAD spectral type {sp}"
    stellar = bool(ot) and ot.endswith("*")
    if p_qso is not None and p_qso > 0.9 and not stellar:
        return "quasar", f"Gaia DR3 DSC quasar probability {p_qso:.2f}"
    if p_gal is not None and p_gal > 0.9 and not stellar:
        return "galaxy", f"Gaia DR3 DSC galaxy probability {p_gal:.2f}"
    if teff is not None:
        cls = "hot_star" if teff > 7500 else ("sunlike_star" if teff >= 3900 else "cool_star")
        return cls, f"Gaia DR3 GSP-Phot Teff {teff:.0f} K"
    return None, "no label"
