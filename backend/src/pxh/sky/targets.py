"""Curated targets: the five challenge objects plus two neighbours, with adopted ICRS astrometry.

Gaia DR3 values (epoch 2016.0) were taken from the archive on 2026-11-14 and identified by position and
magnitude against SIMBAD. WISE 0855-0714 is too faint for Gaia; its astrometry is the Spitzer solution of
Kirkpatrick et al. (2021, ApJS 253, 7). ``find_target`` matches names, aliases, slugs and SIMBAD ids
ignoring case, spaces and punctuation (and accepts the Greek letter for "eps").
"""

from __future__ import annotations

import unicodedata

from pxh.models import Astrometry, Target
from pxh.sky.propagate import jyear_from_mjd

GAIA_DR3_EPOCH = 2016.0
PRIMARY_TARGET_KEYS = ("barnards-star", "eps-indi-b", "wise-0855", "rw-aur", "r-dra")
TARGET_KINDS = ("high-pm-star", "brown-dwarf", "young-variable", "mira-variable", "bright-star")


def _gaia_dr3(
    source_id: int,
    ra: float,
    dec: float,
    parallax: float,
    pmra: float,
    pmdec: float,
    rv: float | None,
    note: str = "",
) -> Astrometry:
    source = f"Gaia DR3 {source_id}" + (f" ({note})" if note else "")
    return Astrometry(
        ra_deg=ra,
        dec_deg=dec,
        ref_epoch=GAIA_DR3_EPOCH,
        pmra_masyr=pmra,
        pmdec_masyr=pmdec,
        parallax_mas=parallax,
        rv_kms=rv,
        source=source,
    )


_EPS_IND_A_RV_KMS = -40.4267  # Gaia DR3 6412595290592307840

_TARGET_LIST = (
    Target(
        key="barnards-star",
        name="Barnard's Star",
        aliases=(
            "Barnard's Star",
            "Barnards Star",
            "Barnard Star",
            "GJ 699",
            "Gl 699",
            "HIP 87937",
            "V2500 Oph",
        ),
        astrometry=_gaia_dr3(
            4472832130942575872,
            269.44850252543836,
            4.739420051112412,
            546.975939730948,
            -801.5509783684709,
            10362.394206546573,
            -110.46822,
        ),
        kind="high-pm-star",
        simbad_id="NAME Barnard's star",
        notes=(
            "M4V at 1.83 pc with the largest known proper motion (10.39 arcsec/yr, 1.7 SPHEREx pixels per "
            "year). Perspective acceleration is 1.3 mas/yr^2: SIMBAD's J2000 position (linear propagation "
            "from 2016.0) differs from rigorous space motion by 0.16 arcsec."
        ),
    ),
    Target(
        key="eps-indi-b",
        name="Epsilon Indi B",
        aliases=(
            "Epsilon Indi B",
            "Eps Indi B",
            "eps Ind B",
            "eps Ind Ba",
            "eps Ind Bb",
            "Epsilon Indi Ba",
            "Epsilon Indi Bb",
        ),
        astrometry=_gaia_dr3(
            6412596012146801152,
            331.07645259656397,
            -56.79381206688221,
            270.6580324694526,
            3981.97666296105,
            -2466.8318147663504,
            _EPS_IND_A_RV_KMS,
            note="Ba+Bb photocentre; RV assumed equal to eps Ind A",
        ),
        kind="brown-dwarf",
        simbad_id="* eps Ind B",
        notes=(
            "Unresolved T1+T6 brown-dwarf binary 3.7 pc away; Gaia sees the photocentre (G = 18.0, "
            "RUWE 4.3). The bright primary eps Ind A (K5V, saturated in SPHEREx) lies 6.7 arcmin away: "
            "mask its halo and ghosts (target 'eps-indi-a')."
        ),
    ),
    Target(
        key="wise-0855",
        name="WISE 0855-0714",
        aliases=(
            "WISE 0855-0714",
            "WISE 0855",
            "WISE J085510.83-071442.5",
            "WISE J0855-0714",
            "W0855",
        ),
        astrometry=Astrometry(
            ra_deg=133.780984,
            dec_deg=-7.243932,
            ref_epoch=jyear_from_mjd(57633.39),
            pmra_masyr=-8123.7,
            pmdec_masyr=673.2,
            parallax_mas=439.0,
            rv_kms=None,
            source="Kirkpatrick et al. 2021, ApJS 253, 7 (Spitzer; position at MJD 57633.39)",
        ),
        kind="brown-dwarf",
        simbad_id="WISEA J085510.74-071442.5",
        notes=(
            "Coldest known brown dwarf (Y dwarf, ~285 K) at 2.28 pc; plx 439.0 +/- 2.4 mas. The challenge's "
            "coordinates 08h55m10.831s -07d14m42.53s are its 2010.5 WISE-epoch position, 2.2 arcmin east of "
            "where it is in 2026."
        ),
    ),
    Target(
        key="rw-aur",
        name="RW Aurigae",
        aliases=("RW Aurigae", "RW Aur", "RW Aur A"),
        astrometry=_gaia_dr3(
            156430822114424576,
            76.95608119552952,
            30.401204589097233,
            6.406249329219477,
            2.6406431770317083,
            -27.397582540455325,
            -20.937069,
            note="RW Aur A",
        ),
        kind="young-variable",
        simbad_id="V* RW Aur A",
        notes=(
            "Classical T Tauri binary at ~156 pc with deep, irregular dimming events. Astrometry is "
            "RW Aur A; RW Aur B (target 'rw-aur-b') is 1.5 arcsec away, unresolved in 6.15 arcsec "
            "SPHEREx pixels."
        ),
    ),
    Target(
        key="r-dra",
        name="R Draconis",
        aliases=("R Draconis", "R Dra"),
        astrometry=_gaia_dr3(
            1648328016354496384,
            248.1673783672889,
            66.75500674547219,
            1.2509180143740992,
            -20.642811719160797,
            6.148818852711324,
            None,
        ),
        kind="mira-variable",
        simbad_id="V* R Dra",
        notes=(
            "Mira variable (M4.5-6e, period ~245 d) at ~800 pc. Gaia G = 6.4 and far brighter in the "
            "near-infrared, so expect saturated cores in SPHEREx. No Gaia DR3 radial velocity."
        ),
    ),
    Target(
        key="eps-indi-a",
        name="Epsilon Indi A",
        aliases=(
            "Epsilon Indi A",
            "Eps Indi A",
            "eps Ind A",
            "Epsilon Indi",
            "eps Ind",
            "HD 209100",
            "HIP 108870",
            "GJ 845",
        ),
        astrometry=_gaia_dr3(
            6412595290592307840,
            330.8724078795965,
            -56.79725466122902,
            274.8431415216296,
            3966.6605387484133,
            -2536.1919868044724,
            _EPS_IND_A_RV_KMS,
        ),
        kind="bright-star",
        simbad_id="* eps Ind",
        notes=(
            "K5V primary of eps Ind B (G = 4.3, saturated in SPHEREx); used to mask contamination around "
            "eps Ind B, 6.7 arcmin away."
        ),
    ),
    Target(
        key="rw-aur-b",
        name="RW Aurigae B",
        aliases=("RW Aurigae B", "RW Aur B"),
        astrometry=_gaia_dr3(
            156430817820015232,
            76.9565443110343,
            30.401316149887936,
            5.454096456582266,
            4.90603392110511,
            -24.577534567492915,
            None,
            note="RW Aur B",
        ),
        kind="young-variable",
        simbad_id="V* RW Aur B",
        notes=(
            "Companion of RW Aur A, 1.5 arcsec away. Gaia DR3 astrometry is poor (RUWE 16.4); blended with A "
            "in SPHEREx images."
        ),
    ),
)

TARGETS: dict[str, Target] = {t.key: t for t in _TARGET_LIST}

# Which other curated objects matter when analysing a target (neighbours to mask, unresolved companions).
RELATED_TARGETS: dict[str, tuple[str, ...]] = {
    "eps-indi-b": ("eps-indi-a",),
    "eps-indi-a": ("eps-indi-b",),
    "rw-aur": ("rw-aur-b",),
    "rw-aur-b": ("rw-aur",),
}


def normalize_name(text: str) -> str:
    """Lookup key for a name: case-folded, Greek epsilon spelled "eps", spaces and punctuation removed."""
    folded = unicodedata.normalize("NFKC", text).casefold()
    folded = folded.replace("ε", "eps").replace("ϵ", "eps")
    return "".join(ch for ch in folded if ch.isalnum())


def _build_index(targets: dict[str, Target]) -> dict[str, str]:
    index: dict[str, str] = {}
    for target in targets.values():
        for label in (target.key, target.name, target.simbad_id, *target.aliases):
            norm = normalize_name(label)
            if not norm:
                continue
            owner = index.setdefault(norm, target.key)
            if owner != target.key:
                raise RuntimeError(f"name {label!r} is claimed by both {owner!r} and {target.key!r}")
    return index


_NAME_INDEX = _build_index(TARGETS)


def find_target(query: str) -> Target | None:
    """The curated target whose slug, name, alias or SIMBAD id matches ``query``, else None."""
    key = _NAME_INDEX.get(normalize_name(query))
    return TARGETS[key] if key is not None else None


def list_targets(primary_only: bool = False) -> list[Target]:
    """All curated targets (challenge targets first); only the five challenge targets if ``primary_only``."""
    if primary_only:
        return [TARGETS[key] for key in PRIMARY_TARGET_KEYS]
    return list(TARGETS.values())


def related_targets(key: str) -> list[Target]:
    """Curated neighbours or companions of a target (e.g. eps Ind A for eps Ind B); [] if none."""
    if key not in TARGETS:
        raise KeyError(f"unknown target {key!r}")
    return [TARGETS[k] for k in RELATED_TARGETS.get(key, ())]
