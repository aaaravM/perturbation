"""Choose the sky fields of the survey dataset and write ml/survey_fields.json (deterministic, seeded).

Run from backend/ (the uv project):

    uv run python ../scripts/survey_fields.py                  # the full list
    uv run python ../scripts/survey_fields.py --targets-only   # just the five challenge targets (quick start)

Every field is 10 arcmin (0.1667 deg) square, centred on the object's barycentric position at 2026.0
(``pxh.sky.propagate``), and kept only if SPHEREx has seen it in at least 3 epochs (``pxh.api.field.index_field``,
the same index as /api/field/summary). Kinds, in build order:

- target: the five challenge targets (``pxh.sky.targets``).
- known-mover: Gaia DR3 stars with total proper motion above 1 arcsec/yr and 9 < G < 18, at least 15 deg from
  each other and from the targets. Candidates come from SIMBAD (CfA mirror); the astrometry is the Gaia DR3
  row itself (IRSA Gator), matched by position and proper motion.
- brown-dwarf: SIMBAD objects of type BD* or spectral type L/T/Y with parallax above 40 mas and K < 15.
- variable: GCVS variables (SIMBAD 'V* ' names) of types T Tauri, classical Cepheid, RR Lyrae, Mira or Orion
  variable with 8 < K < 11, so they are bright but mostly unsaturated at 2-5 um.
- control: seeded random positions, 11 with |b| > 20 deg and 5 with |b| < 10 deg.

Non-control fields are skipped when Gaia DR3 has a star brighter than G = 7 within 4 arcmin (its glare and
ghosts would dominate the field). Candidates are tried in a seeded random order (``SEED``), greedily, so the
same archive answers give the same list.
"""

from __future__ import annotations

import argparse
import math
import sys
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx
import numpy as np

from pxh import config
from pxh.api import field
from pxh.models import Astrometry
from pxh.sky import propagate
from pxh.sky.targets import PRIMARY_TARGET_KEYS, TARGETS

REPO = Path(__file__).resolve().parents[1]
OUT = REPO / "ml" / "survey_fields.json"
sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_survey as bs  # the Gator helper and its IPAC parser

SEED = 20261114
FOV_DEG = 0.1667
EPOCH_JYEAR = 2026.0
MIN_EPOCHS = 3
N_MOVERS, MOVER_SEP_DEG = 22, 15.0
N_BROWN_DWARFS, N_VARIABLES, OTHER_SEP_DEG = 10, 6, 10.0
N_CONTROL_HIGH, N_CONTROL_LOW, CONTROL_SEP_DEG = 11, 5, 5.0
BRIGHT_G, BRIGHT_RADIUS_ARCSEC = 7.0, 240.0
VARIABLE_TYPES = ("TT*", "TT*", "cC*", "RR*", "Mi*", "Or*")  # one pick per slot, in this order
VARIABLE_TYPE_NAMES = {"TT*": "T Tauri star", "cC*": "classical Cepheid", "Ce*": "Cepheid", "RR*": "RR Lyrae star",
                       "Mi*": "Mira variable", "Or*": "Orion variable"}


def log(msg: str) -> None:
    print(time.strftime("%H:%M:%S"), msg, flush=True)


def tap(adql: str, timeout: float = 150.0) -> list[dict[str, Any]]:
    """Rows of a SIMBAD TAP query (CfA mirror, then IDIA)."""
    problems = []
    form = {"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "json", "QUERY": adql}
    for mirror in config.SIMBAD_TAP_MIRRORS[:2]:
        for attempt in range(2):
            try:
                resp = httpx.post(mirror, data=form, headers={"User-Agent": config.USER_AGENT}, timeout=timeout)
                if resp.status_code != 200:
                    raise RuntimeError(f"HTTP {resp.status_code}: {resp.text[:200]}")
                doc = resp.json()
                names = [c["name"] for c in doc["metadata"]]
                return [dict(zip(names, row, strict=False)) for row in doc["data"]]
            except Exception as exc:  # noqa: BLE001 - retry, then the next mirror
                problems.append(f"{mirror.split('/')[2]}: {exc!r}"[:200])
                time.sleep(5.0 * (attempt + 1))
    raise RuntimeError("SIMBAD failed: " + "; ".join(problems))


def sep_deg(ra1: float, dec1: float, ra2: float, dec2: float) -> float:
    r1, d1, r2, d2 = map(math.radians, (ra1, dec1, ra2, dec2))
    c = math.sin(d1) * math.sin(d2) + math.cos(d1) * math.cos(d2) * math.cos(r1 - r2)
    return math.degrees(math.acos(max(-1.0, min(1.0, c))))


def galactic_b(ra: float, dec: float) -> float:
    # ICRS -> Galactic latitude (north Galactic pole at RA 192.85948, Dec 27.12825)
    rp, dp = math.radians(192.85948), math.radians(27.12825)
    r, d = math.radians(ra), math.radians(dec)
    return math.degrees(math.asin(math.sin(d) * math.sin(dp) + math.cos(d) * math.cos(dp) * math.cos(r - rp)))


def at_2026(astrometry: Astrometry) -> tuple[float, float]:
    ra, dec = propagate.barycentric_position(astrometry, float(propagate.mjd_from_jyear(EPOCH_JYEAR)))
    return round(float(ra) % 360.0, 5), round(float(dec), 5)


def coverage(ra: float, dec: float) -> dict[str, Any]:
    idx = field.index_field(ra, dec)
    dets = {f"D{d}": sum(1 for im in idx.images if im.detector == d) for d in range(1, 7)}
    return {
        "n_epochs": len(idx.epochs),
        "n_full": sum(1 for e in idx.epoch_entries if e["full"]),
        "n_images": len(idx.images),
        "images_per_detector": dets,
        "surveys": [e["survey"] for e in idx.epoch_entries],
        "deep_field": idx.deep,
    }


def bright_neighbour(ra: float, dec: float, exclude_id: str | None = None) -> dict[str, Any] | None:
    rows = bs.gator("gaia_dr3_source", "source_id,ra,dec,phot_g_mean_mag", ra, dec, BRIGHT_RADIUS_ARCSEC,
                    f"phot_g_mean_mag<{BRIGHT_G}")
    rows = [r for r in rows if str(r.get("source_id")) != str(exclude_id)]
    return min(rows, key=lambda r: r.get("phot_g_mean_mag") or 99.0) if rows else None


def far_enough(ra: float, dec: float, chosen: list[dict[str, Any]], min_sep: float) -> bool:
    return all(sep_deg(ra, dec, c["ra"], c["dec"]) >= min_sep for c in chosen)


def entry(fid: str, name: str, ra: float, dec: float, kind: str, why: str, **extra: Any) -> dict[str, Any]:
    return {"id": fid, "name": name, "ra": ra, "dec": dec, "fov_deg": FOV_DEG, "kind": kind, "why": why,
            "b_deg": round(galactic_b(ra, dec), 2), **extra}


def slug(text: str) -> str:
    """URL-safe id from a name; '+' becomes 'p' so that J2126+7617 and BD+66 keep their sign."""
    text = text.replace("V* ", "").replace("NAME ", "").replace("+", "p")
    out = "".join(ch.lower() if ch.isalnum() else "-" for ch in text)
    while "--" in out:
        out = out.replace("--", "-")
    return out.strip("-")[:40]


# --- kinds --------------------------------------------------------------------------------------------------


def targets() -> list[dict[str, Any]]:
    out = []
    for key in PRIMARY_TARGET_KEYS:
        t = TARGETS[key]
        ra, dec = at_2026(t.astrometry)
        cov = coverage(ra, dec)
        out.append(entry(
            key, t.name, ra, dec, "target",
            f"Challenge target ({t.kind}); astrometry {t.astrometry.source}",
            astrometry_source=t.astrometry.source, simbad_id=t.simbad_id, coverage=cov,
        ))
        log(f"target {key}: {cov['n_epochs']} epochs")
    return out


def gaia_match(row: dict[str, Any]) -> dict[str, Any] | None:
    """The Gaia DR3 row of a SIMBAD fast mover: SIMBAD's J2000 position moved to 2016.0, matched by pm."""
    pmra, pmdec = float(row["pmra"]), float(row["pmdec"])
    dec16 = row["dec"] + pmdec * 16.0 / 3.6e6
    ra16 = row["ra"] + pmra * 16.0 / 3.6e6 / max(math.cos(math.radians(row["dec"])), 1e-6)
    cols = "source_id,ra,dec,pmra,pmdec,parallax,phot_g_mean_mag,ruwe"
    rows = bs.gator("gaia_dr3_source", cols, ra16 % 360.0, dec16, 20.0, None)
    best, best_d = None, 1e9
    for g in rows:
        if g.get("pmra") is None or g.get("pmdec") is None:
            continue
        d = math.hypot(g["pmra"] - pmra, g["pmdec"] - pmdec)
        if d < best_d:
            best, best_d = g, d
    return best if best is not None and best_d < 100.0 else None


def known_movers(chosen: list[dict[str, Any]], rng: np.random.Generator) -> list[dict[str, Any]]:
    rows = tap(
        "SELECT b.main_id, b.otype, b.sp_type, b.ra, b.dec, b.pmra, b.pmdec, b.plx_value, f.G "
        "FROM basic AS b JOIN allfluxes AS f ON f.oidref = b.oid "
        "WHERE b.pmra*b.pmra + b.pmdec*b.pmdec > 1000000 AND f.G > 9 AND f.G < 18"
    )
    rows = sorted((r for r in rows if r["ra"] is not None and r["pmra"] is not None), key=lambda r: r["main_id"])
    log(f"known movers: {len(rows)} SIMBAD candidates")
    out: list[dict[str, Any]] = []
    for i in rng.permutation(len(rows)):
        if len(out) >= N_MOVERS:
            break
        r = rows[int(i)]
        if not far_enough(r["ra"], r["dec"], chosen + out, MOVER_SEP_DEG):
            continue
        g = gaia_match(r)
        if g is None:
            log(f"  skip {r['main_id']}: no Gaia DR3 match")
            continue
        pm = math.hypot(g["pmra"], g["pmdec"])
        gmag = g.get("phot_g_mean_mag")
        if pm <= 1000.0 or gmag is None or not 9.0 < gmag < 18.0:
            log(f"  skip {r['main_id']}: Gaia pm {pm:.0f} mas/yr, G {gmag}")
            continue
        ast = Astrometry(g["ra"], g["dec"], 2016.0, g["pmra"], g["pmdec"], g.get("parallax"),
                         source=f"Gaia DR3 {g['source_id']}")
        ra, dec = at_2026(ast)
        if not far_enough(ra, dec, chosen + out, MOVER_SEP_DEG):
            continue
        bright = bright_neighbour(ra, dec, exclude_id=g["source_id"])
        if bright:
            log(f"  skip {r['main_id']}: G={bright['phot_g_mean_mag']:.1f} star within 4'")
            continue
        cov = coverage(ra, dec)
        if cov["n_epochs"] < MIN_EPOCHS:
            log(f"  skip {r['main_id']}: {cov['n_epochs']} epochs")
            continue
        name = r["main_id"].replace("  ", " ").strip()
        out.append(entry(
            f"pm-{slug(name)}", name, ra, dec, "known-mover",
            f"Gaia DR3 {g['source_id']}: proper motion {pm / 1000:.2f} arcsec/yr, G = {gmag:.2f} "
            f"(SIMBAD type {r['otype']})",
            gaia_source_id=str(g["source_id"]), pm_masyr=round(pm, 1), pmra_masyr=round(g["pmra"], 2),
            pmdec_masyr=round(g["pmdec"], 2), parallax_mas=g.get("parallax"), g_mag=round(gmag, 3),
            astrometry_source=f"Gaia DR3 {g['source_id']} (IRSA Gator)", simbad_id=r["main_id"], coverage=cov,
        ))
        log(f"  mover {len(out)}: {name} pm {pm:.0f} G {gmag:.1f}, {cov['n_epochs']} epochs")
    return out


def brown_dwarfs(chosen: list[dict[str, Any]], rng: np.random.Generator) -> list[dict[str, Any]]:
    rows = tap(
        "SELECT b.main_id, b.otype, b.sp_type, b.ra, b.dec, b.pmra, b.pmdec, b.plx_value, f.K "
        "FROM basic AS b JOIN allfluxes AS f ON f.oidref = b.oid "
        "WHERE b.plx_value > 40 AND f.K < 15 AND (b.otype = 'BD*' OR b.sp_type LIKE 'L%' OR "
        "b.sp_type LIKE 'T%' OR b.sp_type LIKE 'Y%')"
    )
    rows = sorted((r for r in rows if r["ra"] is not None), key=lambda r: r["main_id"])
    log(f"brown dwarfs: {len(rows)} SIMBAD candidates")
    out: list[dict[str, Any]] = []
    for i in rng.permutation(len(rows)):
        if len(out) >= N_BROWN_DWARFS:
            break
        r = rows[int(i)]
        ast = Astrometry(r["ra"], r["dec"], 2000.0, r["pmra"] or 0.0, r["pmdec"] or 0.0, r["plx_value"],
                         source=f"SIMBAD {r['main_id']}")
        ra, dec = at_2026(ast)
        if not far_enough(ra, dec, chosen + out, OTHER_SEP_DEG):
            continue
        bright = bright_neighbour(ra, dec)
        if bright:
            log(f"  skip {r['main_id']}: G={bright['phot_g_mean_mag']:.1f} star within 4'")
            continue
        cov = coverage(ra, dec)
        if cov["n_epochs"] < MIN_EPOCHS:
            log(f"  skip {r['main_id']}: {cov['n_epochs']} epochs")
            continue
        pm = math.hypot(r["pmra"] or 0.0, r["pmdec"] or 0.0)
        name = r["main_id"].replace("  ", " ").strip()
        out.append(entry(
            f"bd-{slug(name)}", name, ra, dec, "brown-dwarf",
            f"SIMBAD {r['otype']}, spectral type {r['sp_type'] or '?'}, parallax {r['plx_value']:.1f} mas, "
            f"K = {r['K']:.2f}, proper motion {pm / 1000:.2f} arcsec/yr",
            sp_type=r["sp_type"], parallax_mas=r["plx_value"], k_mag=r["K"], pm_masyr=round(pm, 1),
            pmra_masyr=r["pmra"], pmdec_masyr=r["pmdec"],
            astrometry_source=f"SIMBAD {r['main_id']} (J2000 position, SIMBAD proper motion)",
            simbad_id=r["main_id"], coverage=cov,
        ))
        log(f"  brown dwarf {len(out)}: {name} {r['sp_type']} K {r['K']:.1f}, {cov['n_epochs']} epochs")
    return out


def variables(chosen: list[dict[str, Any]], rng: np.random.Generator) -> list[dict[str, Any]]:
    types = sorted(set(VARIABLE_TYPES))
    rows = tap(
        "SELECT b.main_id, b.otype, b.sp_type, b.ra, b.dec, b.pmra, b.pmdec, b.plx_value, f.K "
        "FROM basic AS b JOIN allfluxes AS f ON f.oidref = b.oid "
        f"WHERE b.otype IN ({', '.join(repr(t) for t in types)}) AND f.K > 8 AND f.K < 11 "
        "AND b.main_id LIKE 'V* %'"
    )
    by_type: dict[str, list[dict[str, Any]]] = {t: [] for t in types}
    for r in sorted((r for r in rows if r["ra"] is not None), key=lambda r: r["main_id"]):
        by_type[r["otype"]].append(r)
    log("variables: " + ", ".join(f"{t} {len(v)}" for t, v in by_type.items()))
    order = {t: [v[int(i)] for i in rng.permutation(len(v))] for t, v in by_type.items()}
    out: list[dict[str, Any]] = []
    for otype in VARIABLE_TYPES:
        for r in order[otype]:
            if any(o.get("simbad_id") == r["main_id"] for o in out):
                continue
            ast = Astrometry(r["ra"], r["dec"], 2000.0, r["pmra"] or 0.0, r["pmdec"] or 0.0, r["plx_value"],
                             source=f"SIMBAD {r['main_id']}")
            ra, dec = at_2026(ast)
            if not far_enough(ra, dec, chosen + out, OTHER_SEP_DEG):
                continue
            if bright_neighbour(ra, dec):
                continue
            cov = coverage(ra, dec)
            if cov["n_epochs"] < MIN_EPOCHS:
                continue
            name = r["main_id"].replace("  ", " ").strip()
            out.append(entry(
                f"var-{slug(name)}", name, ra, dec, "variable",
                f"SIMBAD {VARIABLE_TYPE_NAMES.get(otype, otype)} ({otype}), K = {r['K']:.2f}, "
                f"spectral type {r['sp_type'] or '?'}",
                otype=otype, sp_type=r["sp_type"], k_mag=r["K"],
                astrometry_source=f"SIMBAD {r['main_id']} (J2000 position, SIMBAD proper motion)",
                simbad_id=r["main_id"], coverage=cov,
            ))
            log(f"  variable {len(out)}: {name} {otype} K {r['K']:.1f}, {cov['n_epochs']} epochs")
            break
    return out


def controls(chosen: list[dict[str, Any]], rng: np.random.Generator) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    want = {"high": N_CONTROL_HIGH, "low": N_CONTROL_LOW}
    got = {"high": 0, "low": 0}
    tries = 0
    while (got["high"] < want["high"] or got["low"] < want["low"]) and tries < 400:
        tries += 1
        ra = float(rng.uniform(0.0, 360.0))
        dec = math.degrees(math.asin(float(rng.uniform(-1.0, 1.0))))
        ra, dec = round(ra, 5), round(dec, 5)
        b = galactic_b(ra, dec)
        band = "high" if abs(b) > 20.0 else ("low" if abs(b) < 10.0 else None)
        if band is None or got[band] >= want[band]:
            continue
        if not far_enough(ra, dec, chosen + out, CONTROL_SEP_DEG):
            continue
        cov = coverage(ra, dec)
        if cov["n_epochs"] < MIN_EPOCHS:
            continue
        got[band] += 1
        n = got["high"] + got["low"]
        out.append(entry(
            f"ctrl-{n:02d}", f"Control {n:02d} ({'|b| > 20' if band == 'high' else '|b| < 10'})", ra, dec, "control",
            f"Seeded random position (seed {SEED}), Galactic latitude {b:+.1f} deg; no known object targeted",
            control_band=band, coverage=cov,
        ))
        log(f"  control {n}: ({ra}, {dec}) b {b:+.1f}, {cov['n_epochs']} epochs")
    return out


def write(fields: list[dict[str, Any]], complete: bool) -> None:
    ids = [f["id"] for f in fields]
    if len(ids) != len(set(ids)):
        raise RuntimeError("duplicate field ids")
    doc = {
        "schema": "pxh-survey-fields/1",
        "generated_at": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "generator": "scripts/survey_fields.py",
        "seed": SEED,
        "fov_deg": FOV_DEG,
        "centre_epoch_jyear": EPOCH_JYEAR,
        "min_epochs": MIN_EPOCHS,
        "complete": complete,
        "counts": {k: sum(1 for f in fields if f["kind"] == k)
                   for k in ("target", "known-mover", "brown-dwarf", "variable", "control")},
        "fields": fields,
    }
    bs.sio.write_json(OUT, doc)  # atomic: scripts/build_survey.py re-reads this file while it runs
    log(f"wrote {OUT} ({len(fields)} fields, complete={complete})")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--targets-only", action="store_true")
    args = ap.parse_args()
    fields = targets()
    if args.targets_only:
        write(fields, complete=False)
        return 0
    write(fields, complete=False)
    rng_m, rng_b, rng_v, rng_c = (np.random.default_rng([SEED, k]) for k in range(4))
    fields += known_movers(fields, rng_m)
    write(fields, complete=False)
    fields += brown_dwarfs(fields, rng_b)
    write(fields, complete=False)
    fields += variables(fields, rng_v)
    write(fields, complete=False)
    fields += controls(fields, rng_c)
    write(fields, complete=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
