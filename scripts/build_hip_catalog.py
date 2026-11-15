"""Build the Sky globe's star catalogue: every Hipparcos star, its true colour, name and constellation.

Run from backend/ (the uv project, for numpy and astropy):

    uv run python -I ../scripts/build_hip_catalog.py             # downloads once into data/cache/hipparcos/
    uv run python -I ../scripts/build_hip_catalog.py --refresh   # download the inputs again

Inputs (cached under data/cache/hipparcos/, never committed):
- I/311/hip2, Hipparcos, the New Reduction (van Leeuwen 2007, A&A 474, 653): HIP, RArad, DErad (ICRS at
  epoch J1991.25, degrees), Plx, e_Plx, pmRA (mu_alpha * cos dec), pmDE, Hpmag, B-V.
- I/239/hip_main, The Hipparcos Main Catalogue (ESA 1997, SP-1200): HIP, Vmag (Johnson V), B-V, SpType.
  Both come from VizieR through its CfA and IDIA mirrors (CDS Strasbourg itself is degraded).
- d3-celestial data/starnames.json (Olaf Frohn, BSD-3-Clause, https://github.com/ofrohn/d3-celestial) at a
  pinned commit: IAU proper names and Bayer, Flamsteed, variable-star and Gliese designations by HIP.

Processing:
1. hip2 joined with hip_main on HIP (hip2 is the base: 117,955 stars with an astrometric solution). V is
   hip_main's Johnson V; the few stars without one use the Hipparcos Hp magnitude instead (counted in the
   manifest notes). B-V is hip_main's, else hip2's.
2. Positions moved from J1991.25 to J2026.0 along a straight line in space with zero radial velocity
   (unit vector plus proper-motion vector times dt, renormalised; Barnard's Star moves 6.0 arcmin).
3. Constellation: IAU boundaries (Roman 1987) through astropy's ``get_constellation``.
4. Effective temperature from B-V with Ballesteros (2012, EPL 97, 34008):
   T = 4600 K (1 / (0.92 (B-V) + 1.7) + 1 / (0.92 (B-V) + 0.62)), B-V clipped to [-0.40, 2.00].
   It is an estimate from one colour (no reddening correction), and labelled so in the manifest.
5. Colour: a Planck spectrum at that temperature integrated over 360-830 nm against the CIE 1931 2-degree
   colour-matching functions (the multi-lobe fit of Wyman, Sloan & Shirley 2013, JCGT 2(2)), XYZ to
   linear sRGB (IEC 61966-2-1, D65 white), negative channels clipped, scaled so the brightest channel is 1,
   then the sRGB transfer curve. ``validate_colours`` checks the chromaticities against the Planckian locus
   of Kang et al. (2002) and the Sun, an M dwarf and a B star against expectations before anything is
   written. Stars without B-V are drawn white (255, 255, 255).

Outputs (frontend/public/data/stars/, docs: manifest.json "notes"):
- manifest.json, collections.json, LICENSE-d3-celestial.txt
- tier1 (V <= 6.5), tier2 (6.5 < V <= 8.0), tier3 (V > 8.0), each brightest first:
  <tier>.bin   little-endian float32, N x 8: ra, dec (deg, ICRS, J2026.0), vmag, bv, plx_mas, pmra, pmdec
               (mas/yr), teff_K. NaN = unknown. plx is NaN when it is not positive or under 5 times its
               error (no reliable distance); the formal error is in meta "e_plx".
  <tier>.rgb   uint8, N x 3 sRGB.
  <tier>.meta.json  {hip, sp, con, e_plx, names: {"<record index>": {name?, bayer?, flamsteed?, variable?,
               gliese?}}}.
"""

from __future__ import annotations

import argparse
import json
import math
import shutil
import sys
import time
import urllib.parse
import urllib.request
from datetime import UTC, datetime
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parents[1]
CACHE = REPO / "data" / "cache" / "hipparcos"
OUT = REPO / "frontend" / "public" / "data" / "stars"

USER_AGENT = "Perturbation/0.1 (catalogue builder)"
VIZIER_MIRRORS = ("https://vizier.cfa.harvard.edu", "https://vizier.idia.ac.za")
HIP2_COLUMNS = "HIP,RArad,DErad,Plx,e_Plx,pmRA,pmDE,Hpmag,B-V"
HIPMAIN_COLUMNS = "HIP,Vmag,B-V,SpType"
D3_COMMIT = "7e720a3de062059d4c5400a379146a601d9010e0"
D3_RAW = f"https://raw.githubusercontent.com/ofrohn/d3-celestial/{D3_COMMIT}"

HIP2_EPOCH = 1991.25
EPOCH = 2026.0
PLX_MIN_SNR = 5.0
TIERS = (("tier1", 6.5), ("tier2", 8.0), ("tier3", 99.0))
FIELDS = ("ra", "dec", "vmag", "bv", "plx", "pmra", "pmdec", "teff")
COLLECTION_SIZE = 30
BV_RANGE = (-0.40, 2.00)
MAS_TO_RAD = math.radians(1.0 / 3.6e6)
SUPERSCRIPT = str.maketrans("0123456789", "⁰¹²³⁴⁵⁶⁷⁸⁹")

CREDITS = (
    "Stars: ESA Hipparcos (I/311, I/239 via VizieR). The Hipparcos Catalogue (ESA 1997, SP-1200) and "
    "Hipparcos, the New Reduction (van Leeuwen 2007, A&A 474, 653), through the VizieR catalogue access "
    "tool, CDS, Strasbourg (CfA and IDIA mirrors). Names and designations: d3-celestial by Olaf Frohn "
    "(BSD-3-Clause, see LICENSE-d3-celestial.txt), which collects the IAU WGSN star names. Constellations: "
    "IAU boundaries (Roman 1987) via astropy. Temperatures: estimated from B-V (Ballesteros 2012)."
)


# --- inputs -------------------------------------------------------------------------------------------


def _download(url: str, dest: Path, timeout: float = 600.0) -> None:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    t0 = time.monotonic()
    with urllib.request.urlopen(request, timeout=timeout) as response:
        body = response.read()
    if len(body) < 200:
        raise RuntimeError(f"short answer from {url}: {body[:200]!r}")
    tmp = dest.with_suffix(dest.suffix + ".part")
    tmp.write_bytes(body)
    tmp.replace(dest)
    print(f"  {dest.name}: {len(body) / 1e6:.2f} MB in {time.monotonic() - t0:.1f} s from {url[:80]}")


def _vizier(source: str, columns: str, dest: Path, refresh: bool) -> Path:
    if dest.exists() and not refresh:
        return dest
    query = urllib.parse.urlencode({"-source": source, "-out": columns, "-out.max": "unlimited"})
    errors = []
    for mirror in VIZIER_MIRRORS:
        try:
            _download(f"{mirror}/viz-bin/asu-tsv?{query}", dest)
            return dest
        except Exception as exc:  # noqa: BLE001 - try the next mirror
            errors.append(f"{mirror}: {exc}")
            print(f"  {mirror} failed: {exc}")
    raise RuntimeError(f"no VizieR mirror served {source}: {'; '.join(errors)}")


def fetch_inputs(refresh: bool) -> dict[str, Path]:
    CACHE.mkdir(parents=True, exist_ok=True)
    paths = {
        "hip2": _vizier("I/311/hip2", HIP2_COLUMNS, CACHE / "hip2.tsv", refresh),
        "hip_main": _vizier("I/239/hip_main", HIPMAIN_COLUMNS, CACHE / "hip_main.tsv", refresh),
        "names": CACHE / "starnames.json",
        "licence": CACHE / "LICENSE-d3-celestial",
    }
    if refresh or not paths["names"].exists():
        _download(f"{D3_RAW}/data/starnames.json", paths["names"])
    if refresh or not paths["licence"].exists():
        _download(f"{D3_RAW}/LICENSE", paths["licence"])
    licence = paths["licence"].read_text(encoding="utf-8")
    if "Olaf Frohn" not in licence or "Redistributions in binary form" not in licence:
        raise RuntimeError("d3-celestial LICENSE is not the expected BSD-3-Clause text")
    return paths


def read_tsv(path: Path) -> dict[str, list[str]]:
    """Columns of a VizieR ASU-TSV answer (comment lines, header, units and dashes skipped)."""
    lines = [ln.rstrip("\r\n") for ln in path.read_text(encoding="utf-8").splitlines()]
    lines = [ln for ln in lines if ln.strip() and not ln.startswith("#")]
    header = [h.strip() for h in lines[0].split("\t")]
    if not set(lines[2].replace("\t", "")) <= {"-"}:
        raise RuntimeError(f"{path.name}: unexpected TSV layout (third line {lines[2][:40]!r})")
    cols: dict[str, list[str]] = {h: [] for h in header}
    for ln in lines[3:]:
        parts = ln.split("\t")
        for i, h in enumerate(header):
            cols[h].append(parts[i].strip() if i < len(parts) else "")
    return cols


def to_float(values: list[str]) -> np.ndarray:
    return np.array([float(v) if v else np.nan for v in values], dtype=np.float64)


# --- astrometry ---------------------------------------------------------------------------------------


def propagate(ra_deg: np.ndarray, dec_deg: np.ndarray, pmra: np.ndarray, pmdec: np.ndarray, dt_yr: float):
    """Positions after dt years of straight-line motion with zero radial velocity (pm in mas/yr, pmra =
    mu_alpha * cos dec)."""
    ra, dec = np.radians(ra_deg), np.radians(dec_deg)
    p = np.stack([np.cos(dec) * np.cos(ra), np.cos(dec) * np.sin(ra), np.sin(dec)])
    east = np.stack([-np.sin(ra), np.cos(ra), np.zeros_like(ra)])
    north = np.stack([-np.sin(dec) * np.cos(ra), -np.sin(dec) * np.sin(ra), np.cos(dec)])
    mu_a = np.nan_to_num(pmra) * MAS_TO_RAD * dt_yr
    mu_d = np.nan_to_num(pmdec) * MAS_TO_RAD * dt_yr
    r = p + east * mu_a + north * mu_d
    r /= np.linalg.norm(r, axis=0)
    ra1 = np.degrees(np.arctan2(r[1], r[0])) % 360.0
    dec1 = np.degrees(np.arcsin(np.clip(r[2], -1.0, 1.0)))
    return ra1, dec1


def constellations(ra_deg: np.ndarray, dec_deg: np.ndarray) -> list[str]:
    import astropy.units as u
    from astropy.coordinates import SkyCoord, get_constellation

    coords = SkyCoord(ra=ra_deg * u.deg, dec=dec_deg * u.deg, frame="icrs")
    return [str(c) for c in get_constellation(coords, short_name=True)]


# --- temperature and colour ---------------------------------------------------------------------------


def teff_from_bv(bv: np.ndarray) -> np.ndarray:
    """Ballesteros (2012) blackbody temperature from B-V (K); NaN where B-V is unknown."""
    x = 0.92 * np.clip(bv, *BV_RANGE)
    return 4600.0 * (1.0 / (x + 1.7) + 1.0 / (x + 0.62))


def _lobe(lam: np.ndarray, mu: float, s1: float, s2: float) -> np.ndarray:
    s = np.where(lam < mu, s1, s2)
    return np.exp(-0.5 * ((lam - mu) / s) ** 2)


def cie1931(lam_nm: np.ndarray) -> np.ndarray:
    """CIE 1931 2-degree colour-matching functions (x, y, z rows): Wyman, Sloan & Shirley (2013) multi-lobe fit."""
    x = 1.056 * _lobe(lam_nm, 599.8, 37.9, 31.0) + 0.362 * _lobe(lam_nm, 442.0, 16.0, 26.7) - 0.065 * _lobe(
        lam_nm, 501.1, 20.4, 26.2
    )
    y = 0.821 * _lobe(lam_nm, 568.8, 46.9, 40.5) + 0.286 * _lobe(lam_nm, 530.9, 16.3, 31.1)
    z = 1.217 * _lobe(lam_nm, 437.0, 11.8, 36.0) + 0.681 * _lobe(lam_nm, 459.0, 26.0, 13.8)
    return np.stack([x, y, z])


LAMBDA_NM = np.arange(360.0, 830.5, 1.0)
CMF = cie1931(LAMBDA_NM)
XYZ_TO_SRGB = np.array([
    [3.2406, -1.5372, -0.4986],
    [-0.9689, 1.8758, 0.0415],
    [0.0557, -0.2040, 1.0570],
])
C2_NM_K = 1.438777e7  # second radiation constant hc/k in nm K


def blackbody_xyz(teff: np.ndarray) -> np.ndarray:
    """CIE XYZ (arbitrary scale, columns) of Planck spectra at the given temperatures."""
    t = np.atleast_1d(np.asarray(teff, dtype=np.float64))
    lam = LAMBDA_NM[:, None]
    planck = lam**-5 / np.expm1(C2_NM_K / (lam * t[None, :]))
    return CMF @ planck


def srgb_gamma(v: np.ndarray) -> np.ndarray:
    return np.where(v <= 0.0031308, 12.92 * v, 1.055 * np.power(np.clip(v, 0.0031308, None), 1 / 2.4) - 0.055)


def blackbody_srgb(teff: np.ndarray) -> np.ndarray:
    """uint8 sRGB (N x 3) of blackbodies, brightest channel 255; NaN temperatures give white."""
    t = np.atleast_1d(np.asarray(teff, dtype=np.float64))
    out = np.full((t.size, 3), 255, dtype=np.uint8)
    ok = np.isfinite(t)
    if ok.any():
        rgb = (XYZ_TO_SRGB @ blackbody_xyz(t[ok])).T
        rgb = np.clip(rgb, 0.0, None)
        rgb /= rgb.max(axis=1, keepdims=True)
        out[ok] = np.round(srgb_gamma(rgb) * 255.0).astype(np.uint8)
    return out


def kang_locus(t: float) -> tuple[float, float]:
    """Planckian locus (x, y) of Kang et al. (2002), valid 1667-25000 K."""
    if t <= 4000:
        x = -0.2661239e9 / t**3 - 0.2343589e6 / t**2 + 0.8776956e3 / t + 0.179910
    else:
        x = -3.0258469e9 / t**3 + 2.1070379e6 / t**2 + 0.2226347e3 / t + 0.240390
    if t <= 2222:
        y = -1.1063814 * x**3 - 1.34811020 * x**2 + 2.18555832 * x - 0.20219683
    elif t <= 4000:
        y = -0.9549476 * x**3 - 1.37418593 * x**2 + 2.09137015 * x - 0.16748867
    else:
        y = 3.0817580 * x**3 - 5.87338670 * x**2 + 3.75112997 * x - 0.37001483
    return x, y


def validate_colours() -> dict[str, list[int]]:
    """Check the colour pipeline before writing anything; returns a few reference colours."""
    worst = 0.0
    for t in (1700, 2000, 2856, 3500, 4000, 5000, 5778, 6504, 8000, 10000, 15000, 25000):
        xyz = blackbody_xyz(np.array([t]))[:, 0]
        x, y = xyz[0] / xyz.sum(), xyz[1] / xyz.sum()
        kx, ky = kang_locus(t)
        worst = max(worst, abs(x - kx), abs(y - ky))
    if worst > 0.004:
        raise AssertionError(f"blackbody chromaticity differs from the Planckian locus by {worst:.4f}")
    white = XYZ_TO_SRGB @ np.array([0.95047, 1.0, 1.08883])
    if not np.allclose(white, 1.0, atol=2e-3):
        raise AssertionError(f"D65 white is not sRGB white: {white}")
    ref = {
        "Sun, B-V 0.65": blackbody_srgb(teff_from_bv(np.array([0.65])))[0],
        "M dwarf, B-V 1.5": blackbody_srgb(teff_from_bv(np.array([1.5])))[0],
        "B star, B-V -0.2": blackbody_srgb(teff_from_bv(np.array([-0.2])))[0],
        "A0 (Vega), B-V 0.0": blackbody_srgb(teff_from_bv(np.array([0.0])))[0],
    }
    sun, mdw, bst = ref["Sun, B-V 0.65"], ref["M dwarf, B-V 1.5"], ref["B star, B-V -0.2"]
    if not (sun[0] == 255 and 225 <= sun[1] <= 250 and 205 <= sun[2] <= 245):
        raise AssertionError(f"the Sun should be near-white with a faint warm tint, got {sun}")
    if not (mdw[0] == 255 and 140 <= mdw[1] <= 210 and mdw[2] <= 160):
        raise AssertionError(f"an M dwarf should be orange, got {mdw}")
    if not (bst[2] == 255 and bst[0] < 220 and bst[0] < bst[1]):
        raise AssertionError(f"a B star should be pale blue, got {bst}")
    print(f"  colours: chromaticity within {worst:.4f} of Kang et al. 2002")
    for label, rgb in ref.items():
        print(f"    {label}: Teff {teff_from_bv(np.array([float(label.split('B-V ')[1])]))[0]:.0f} K -> {tuple(int(v) for v in rgb)}")
    return {k: [int(v) for v in rgb] for k, rgb in ref.items()}


# --- names --------------------------------------------------------------------------------------------


def star_names(path: Path) -> dict[int, dict[str, str]]:
    """HIP -> {name?, bayer?, flamsteed?, variable?, gliese?} from d3-celestial's starnames.json."""
    raw = json.loads(path.read_text(encoding="utf-8"))
    out: dict[int, dict[str, str]] = {}
    for key, v in raw.items():
        try:
            hip = int(key)
        except ValueError:
            continue
        con = (v.get("c") or "").strip()
        entry: dict[str, str] = {}
        if (v.get("name") or "").strip():
            entry["name"] = v["name"].strip()
        if (v.get("bayer") or "").strip() and con:
            entry["bayer"] = f"{v['bayer'].strip().translate(SUPERSCRIPT)} {con}"
        if (v.get("flam") or "").strip() and con:
            entry["flamsteed"] = f"{v['flam'].strip()} {con}"
        if (v.get("var") or "").strip() and con:
            entry["variable"] = f"{v['var'].strip()} {con}"
        if (v.get("gl") or "").strip():
            entry["gliese"] = " ".join(v["gl"].split())
        if entry:
            out[hip] = entry
    return out


# --- build --------------------------------------------------------------------------------------------


def notes(n_v_from_hp: int) -> list[str]:
    """The manifest's plain description of every field."""
    return [
        "Records are little-endian float32, 8 per star in the order of 'fields'; NaN means unknown.",
        (
            "ra, dec: degrees, ICRS, moved from the Hipparcos epoch J1991.25 to epoch_jyear with the "
            "star's proper motion (zero radial velocity)."
        ),
        f"vmag: Johnson V from I/239; for {n_v_from_hp} stars without V it is the Hipparcos Hp magnitude.",
        "bv: Johnson B-V (I/239, else I/311).",
        (
            f"plx: Hipparcos parallax in mas (I/311); NaN when not positive or less than {PLX_MIN_SNR:g} "
            "times its formal error (no reliable distance); meta 'e_plx' holds the error for every star."
        ),
        "pmra (mu_alpha * cos dec), pmdec: proper motion in mas/yr (I/311).",
        (
            "teff: estimated from B-V with Ballesteros (2012), B-V clipped to [-0.4, 2.0]; not a "
            "spectroscopic temperature, no correction for interstellar reddening."
        ),
        (
            "rgb: sRGB colour of a blackbody at teff (CIE 1931 2-degree colour matching, D65 white), "
            "brightest channel 255; white where B-V is unknown."
        ),
        "Each tier holds the stars with the previous tier's vmax < vmag <= vmax, brightest first.",
        (
            "meta: hip (Hipparcos number), sp (spectral type, I/239), con (IAU constellation), e_plx "
            "(mas), names keyed by record index (d3-celestial: proper name, Bayer, Flamsteed, "
            "variable-star and Gliese designations)."
        ),
        "collections.json: {tier, index} references; nearest uses reliable parallaxes only.",
    ]


def _round_list(values: np.ndarray, digits: int) -> list[float | None]:
    return [None if not math.isfinite(v) else round(float(v), digits) for v in values]


def build(refresh: bool = False) -> dict:
    t0 = time.monotonic()
    print("inputs")
    paths = fetch_inputs(refresh)
    hip2 = read_tsv(paths["hip2"])
    main = read_tsv(paths["hip_main"])
    hip = np.array([int(v) for v in hip2["HIP"]], dtype=np.int64)
    ra0, dec0 = to_float(hip2["RArad"]), to_float(hip2["DErad"])
    plx_raw, e_plx = to_float(hip2["Plx"]), to_float(hip2["e_Plx"])
    pmra, pmdec = to_float(hip2["pmRA"]), to_float(hip2["pmDE"])
    hpmag, bv2 = to_float(hip2["Hpmag"]), to_float(hip2["B-V"])
    main_idx = {int(h): i for i, h in enumerate(main["HIP"])}
    vmag_main, bv_main = to_float(main["Vmag"]), to_float(main["B-V"])
    j = np.array([main_idx.get(int(h), -1) for h in hip])
    has_main = j >= 0
    vmag = np.where(has_main, vmag_main[np.maximum(j, 0)], np.nan)
    bv1 = np.where(has_main, bv_main[np.maximum(j, 0)], np.nan)
    sp = [main["SpType"][k].strip() if k >= 0 else "" for k in j]
    print(f"  hip2 {hip.size} stars, hip_main {len(main['HIP'])}, joined {int(has_main.sum())}")

    v_from_hp = ~np.isfinite(vmag) & np.isfinite(hpmag)
    vmag = np.where(v_from_hp, hpmag, vmag)
    bv = np.where(np.isfinite(bv1), bv1, bv2)
    keep = np.isfinite(vmag) & np.isfinite(ra0) & np.isfinite(dec0)
    print(f"  V from Hp for {int(v_from_hp.sum())} stars; dropped {int((~keep).sum())} without magnitude or position")

    ra, dec = propagate(ra0, dec0, pmra, pmdec, EPOCH - HIP2_EPOCH)
    snr = np.where(e_plx > 0, plx_raw / np.where(e_plx > 0, e_plx, 1.0), np.inf)
    plx = np.where((plx_raw > 0) & (snr >= PLX_MIN_SNR), plx_raw, np.nan)
    teff = np.where(np.isfinite(bv), teff_from_bv(bv), np.nan)

    print("colours")
    reference = validate_colours()
    rgb = blackbody_srgb(teff)

    print("constellations")
    t1 = time.monotonic()
    con = constellations(ra, dec)
    print(f"  {len(set(con))} constellations in {time.monotonic() - t1:.1f} s")

    names = star_names(paths["names"])

    idx = np.flatnonzero(keep)
    OUT.mkdir(parents=True, exist_ok=True)
    tiers_doc = []
    where: dict[int, tuple[str, int]] = {}  # catalogue row -> (tier, record index)
    vmin = -np.inf
    for name, vmax in TIERS:
        sel = idx[(vmag[idx] > vmin) & (vmag[idx] <= vmax)]
        sel = sel[np.lexsort((hip[sel], vmag[sel]))]  # brightest first, then HIP
        records = np.stack([ra[sel], dec[sel], vmag[sel], bv[sel], plx[sel], pmra[sel], pmdec[sel], teff[sel]], axis=1)
        records = np.where(np.isfinite(records), records, np.nan).astype("<f4")
        (OUT / f"{name}.bin").write_bytes(records.tobytes())
        (OUT / f"{name}.rgb").write_bytes(np.ascontiguousarray(rgb[sel], dtype=np.uint8).tobytes())
        tier_names = {}
        for k, row in enumerate(sel):
            where[int(row)] = (name, k)
            entry = names.get(int(hip[row]))
            if entry:
                tier_names[str(k)] = entry
        meta = {
            "hip": [int(h) for h in hip[sel]],
            "sp": [sp[row] for row in sel],
            "con": [con[row] for row in sel],
            "e_plx": _round_list(e_plx[sel], 2),
            "names": tier_names,
        }
        (OUT / f"{name}.meta.json").write_text(
            json.dumps(meta, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
        )
        tiers_doc.append({
            "name": name,
            "vmax": vmax,
            "count": int(sel.size),
            "bin": f"{name}.bin",
            "rgb": f"{name}.rgb",
            "meta": f"{name}.meta.json",
        })
        vmin = vmax

    def ref(rows: np.ndarray) -> list[dict]:
        return [{"tier": where[int(r)][0], "index": where[int(r)][1]} for r in rows]

    near = idx[np.isfinite(plx[idx])]
    near = near[np.argsort(-plx[near], kind="stable")][:COLLECTION_SIZE]
    bright = idx[np.lexsort((hip[idx], vmag[idx]))][:COLLECTION_SIZE]
    pm_total = np.hypot(np.nan_to_num(pmra), np.nan_to_num(pmdec))
    fast = idx[np.argsort(-pm_total[idx], kind="stable")][:COLLECTION_SIZE]
    named_rows = [r for r in idx if "name" in names.get(int(hip[r]), {})]
    collections = {"nearest": ref(near), "brightest": ref(bright), "fastest": ref(fast), "named": len(named_rows)}
    (OUT / "collections.json").write_text(json.dumps(collections, separators=(",", ":")), encoding="utf-8")
    shutil.copyfile(paths["licence"], OUT / "LICENSE-d3-celestial.txt")

    manifest = {
        "version": 1,
        "epoch_jyear": EPOCH,
        "tiers": tiers_doc,
        "fields": list(FIELDS),
        "collections": "collections.json",
        "credits": CREDITS,
        "generated": datetime.now(UTC).strftime("%Y-%m-%d"),
        "notes": notes(int((v_from_hp & keep).sum())),
        "colour_reference": reference,
    }
    (OUT / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")

    print("outputs")
    for t in tiers_doc:
        sizes = [((OUT / t[k]).stat().st_size) for k in ("bin", "rgb", "meta")]
        print(
            f"  {t['name']}: {t['count']} stars, bin {sizes[0] / 1e6:.2f} MB, rgb {sizes[1] / 1e6:.2f} MB, "
            f"meta {sizes[2] / 1e6:.2f} MB, named {sum(1 for _ in json.loads((OUT / t['meta']).read_text(encoding='utf-8'))['names'])}"
        )
    print(
        f"  total {int(keep.sum())} stars; parallax kept for {int(np.isfinite(plx[keep]).sum())}; "
        f"B-V known for {int(np.isfinite(bv[keep]).sum())}; proper names {len(named_rows)}; "
        f"{time.monotonic() - t0:.1f} s"
    )
    return {"tiers": tiers_doc, "collections": collections}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--refresh", action="store_true", help="download the inputs again")
    args = parser.parse_args(argv)
    build(refresh=args.refresh)
    return 0


if __name__ == "__main__":
    sys.exit(main())
