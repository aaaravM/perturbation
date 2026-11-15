"""Tests for pxh.sky.targets: the curated table, its provenance and alias lookup (offline).

The fixtures are the Gaia DR3 rows and SIMBAD basic rows fetched during research (2026-11-14).
"""

from __future__ import annotations

import csv
import json
from pathlib import Path

import pytest

from pxh.sky.coords import angular_separation_arcsec, parse_coordinates, tangent_plane_offsets_arcsec
from pxh.sky.propagate import barycentric_position, mjd_from_jyear
from pxh.sky.targets import (
    PRIMARY_TARGET_KEYS,
    TARGET_KINDS,
    TARGETS,
    find_target,
    list_targets,
    normalize_name,
    related_targets,
)

GAIA_IDS = {
    "barnards-star": 4472832130942575872,
    "eps-indi-b": 6412596012146801152,
    "eps-indi-a": 6412595290592307840,
    "rw-aur": 156430822114424576,
    "rw-aur-b": 156430817820015232,
    "r-dra": 1648328016354496384,
}

REQUIRED_ALIASES = {
    "barnards-star": [
        "Barnard's Star",
        "Barnards Star",
        "Barnard Star",
        "GJ 699",
        "Gl 699",
        "HIP 87937",
        "V2500 Oph",
    ],
    "eps-indi-b": [
        "Epsilon Indi B",
        "Eps Indi B",
        "eps Ind B",
        "eps Ind Ba",
        "eps Ind Bb",
        "Epsilon Indi Ba",
        "Epsilon Indi Bb",
    ],
    "wise-0855": ["WISE 0855-0714", "WISE 0855", "WISE J085510.83-071442.5", "WISE J0855-0714", "W0855"],
    "rw-aur": ["RW Aurigae", "RW Aur", "RW Aur A"],
    "r-dra": ["R Draconis", "R Dra"],
}


def test_expected_keys_and_kinds() -> None:
    assert set(TARGETS) == {*PRIMARY_TARGET_KEYS, "eps-indi-a", "rw-aur-b"}
    assert TARGETS["eps-indi-a"].kind == "bright-star"
    for key, target in TARGETS.items():
        assert target.key == key
        assert target.kind in TARGET_KINDS
        assert target.name and target.simbad_id and target.notes
        assert target.astrometry.source


def test_list_targets() -> None:
    assert [t.key for t in list_targets(primary_only=True)] == list(PRIMARY_TARGET_KEYS)
    everything = list_targets()
    assert [t.key for t in everything[:5]] == list(PRIMARY_TARGET_KEYS)
    assert len(everything) == len(TARGETS)


def test_related_targets() -> None:
    assert [t.key for t in related_targets("eps-indi-b")] == ["eps-indi-a"]
    assert [t.key for t in related_targets("rw-aur")] == ["rw-aur-b"]
    assert related_targets("r-dra") == []
    with pytest.raises(KeyError):
        related_targets("proxima")


@pytest.mark.parametrize(
    ("key", "alias"), [(k, a) for k, aliases in REQUIRED_ALIASES.items() for a in aliases]
)
def test_required_aliases_resolve(key: str, alias: str) -> None:
    found = find_target(alias)
    assert found is not None and found.key == key


@pytest.mark.parametrize(
    ("query", "key"),
    [
        ("barnards-star", "barnards-star"),
        ("BARNARD'S   STAR", "barnards-star"),
        ("barnard’s star", "barnards-star"),
        ("gj699", "barnards-star"),
        ("Gl-699", "barnards-star"),
        ("NAME Barnard's star", "barnards-star"),
        ("ε Indi B", "eps-indi-b"),
        ("eps-indi-b", "eps-indi-b"),
        ("* eps Ind B", "eps-indi-b"),
        ("wise0855-0714", "wise-0855"),
        ("wise-0855", "wise-0855"),
        ("WISEA J085510.74-071442.5", "wise-0855"),
        ("rw aurigae", "rw-aur"),
        ("RW Aur B", "rw-aur-b"),
        ("r-dra", "r-dra"),
        ("Epsilon Indi", "eps-indi-a"),
        ("HD 209100", "eps-indi-a"),
    ],
)
def test_lookup_ignores_case_space_and_punctuation(query: str, key: str) -> None:
    found = find_target(query)
    assert found is not None and found.key == key


@pytest.mark.parametrize("query", ["Proxima Centauri", "M 31", "Vega", "", "   ", "RW", "R", "eps", "wise"])
def test_unknown_names(query: str) -> None:
    assert find_target(query) is None


def test_normalize_name() -> None:
    assert normalize_name("  Barnard's  Star ") == "barnardsstar"
    assert normalize_name("Ε Ind B") == normalize_name("eps Ind B") == "epsindb"  # capital Greek epsilon
    assert normalize_name("WISE J0855−0714") == "wisej08550714"


def test_aliases_are_unambiguous() -> None:
    owners: dict[str, str] = {}
    for target in TARGETS.values():
        for label in (target.key, target.name, target.simbad_id, *target.aliases):
            assert owners.setdefault(normalize_name(label), target.key) == target.key, label


def test_gaia_astrometry_transcribed_exactly(fixtures_dir: Path) -> None:
    with (fixtures_dir / "sky_gaia_dr3_targets.csv").open(newline="") as fh:
        rows = {int(r["source_id"]): r for r in csv.DictReader(fh)}
    for key, source_id in GAIA_IDS.items():
        a = TARGETS[key].astrometry
        row = rows[source_id]
        assert a.source.startswith(f"Gaia DR3 {source_id}")
        assert a.ref_epoch == float(row["ref_epoch"]) == 2016.0
        assert a.ra_deg == float(row["ra"]) and a.dec_deg == float(row["dec"])
        assert a.parallax_mas == float(row["parallax"])
        assert a.pmra_masyr == float(row["pmra"]) and a.pmdec_masyr == float(row["pmdec"])
        if row["radial_velocity"]:
            assert a.rv_kms == float(row["radial_velocity"])
    # eps Ind B has no Gaia RV: it adopts eps Ind A's.
    assert TARGETS["eps-indi-b"].astrometry.rv_kms == TARGETS["eps-indi-a"].astrometry.rv_kms
    assert TARGETS["r-dra"].astrometry.rv_kms is None and TARGETS["rw-aur-b"].astrometry.rv_kms is None
    # Identity check by magnitude: eps Ind A is the G = 4.3 star, B the G = 18 photocentre.
    assert float(rows[GAIA_IDS["eps-indi-a"]]["phot_g_mean_mag"]) < 5.0
    assert float(rows[GAIA_IDS["eps-indi-b"]]["phot_g_mean_mag"]) > 17.0


def test_identities_match_simbad_positions(fixtures_dir: Path) -> None:
    """Each target, propagated to J2000, lands on its SIMBAD object (which identifies A vs B correctly)."""
    doc = json.loads((fixtures_dir / "sky_simbad_basic_targets.json").read_text())
    names = [m["name"] for m in doc["metadata"]]
    simbad = {row[names.index("main_id")]: dict(zip(names, row, strict=True)) for row in doc["data"]}
    j2000 = mjd_from_jyear(2000.0)
    for target in TARGETS.values():
        row = simbad[target.simbad_id]
        ra, dec = barycentric_position(target.astrometry, j2000)
        sep = angular_separation_arcsec(ra, dec, row["ra"], row["dec"])
        # SIMBAD propagates linearly from 2016 to 2000, which misses Barnard's perspective acceleration.
        limit = 0.25 if target.key == "barnards-star" else 0.05
        assert sep < limit, (target.key, sep)


def test_wise0855_challenge_position_is_its_2010_position() -> None:
    challenge = parse_coordinates("08h55m10.831s -7d14m42.53s")
    assert challenge is not None
    wise = TARGETS["wise-0855"].astrometry
    assert wise.ref_epoch == pytest.approx(2016.67047, abs=1e-5)
    ra10, dec10 = barycentric_position(wise, mjd_from_jyear(2010.5))
    assert angular_separation_arcsec(*challenge, ra10, dec10) < 1.0
    ra26, dec26 = barycentric_position(wise, 61358.0)
    east, north = tangent_plane_offsets_arcsec(*challenge, ra26, dec26)
    assert 2.1 * 60 < angular_separation_arcsec(*challenge, ra26, dec26) < 2.3 * 60
    assert east > 120.0 and abs(north) < 20.0
