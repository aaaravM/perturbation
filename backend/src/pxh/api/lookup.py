"""What is known at a sky position: ``/api/object`` (one star or spot) and ``/api/patch`` (a patch of sky).

Every answer is built from parts that run in parallel, each with its own source, status and time:

- ``sky`` (local, astropy): constellation (IAU boundaries, Roman 1987), galactic and ecliptic coordinates,
  and plain words on where the position is (Milky Way plane, galactic centre, ecliptic, famous places).
- ``gaia`` (object): the nearest Gaia DR3 source from IRSA Gator (``gaia_dr3_source``). Gaia positions are
  at epoch 2016.0, so the search centre is moved there with the caller's proper motion (``pmra``/``pmdec``)
  and every candidate is moved to the caller's ``epoch`` before the nearest one is chosen. With ``hip``, the
  Gaia DR3 counterpart SIMBAD lists for that Hipparcos star wins over plain nearness.
- ``simbad`` (object): SIMBAD through its TAP mirrors (CfA, IDIA, then CDS): by identifier ``HIP n`` when
  ``hip`` is given, else the nearest object in the cone (SIMBAD positions are ICRS at epoch J2000).
- ``stars_count`` / ``brightest`` (patch): Gaia DR3 sources to G = 18 in the patch, counted exactly when
  there are at most ``EXACT_COUNT_MAX`` of them, else estimated from a 2 arcmin sample at the centre and
  labelled so; and the brightest few, named from SIMBAD's Gaia DR3 cross-identifications.
- ``spherex``: SPHEREx coverage from the cached SIA point search (no file reads): epochs, images, first and
  last dates, deep field or not.
- ``spectrum``: the DR1 cube quick-look spectrum (``pxh.spherex.cube``).

Each part has ``status``: "ok", "none" (the service answered: nothing there), "error" or "timeout".
Parts that miss their time limit keep running in the background, so their caches fill and a retry is
fast. A complete answer (no error or timeout) is cached by the CDN for a day; a partial one is not cached.
"""

from __future__ import annotations

import hashlib
import logging
import math
import threading
import time
from collections import Counter
from collections.abc import Callable
from concurrent.futures import Future, ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeout
from typing import Any
from urllib.parse import quote

import httpx

from pxh import config
from pxh.api import catalogs, field
from pxh.api.caching import TTLCache
from pxh.api.errors import invalid
from pxh.sky.resolve import display_name
from pxh.spherex import cube, rangeio, sia
from pxh.spherex import epochs as ep

log = logging.getLogger(__name__)

PART_TIMEOUT_S = 8.0
CHAIN_TIMEOUT_S = 11.0  # patch parts that make two or three requests in a row
RADIUS_ARCSEC_DEFAULT = 6.0
RADIUS_ARCSEC_MAX = 60.0
PATCH_RADIUS_DEFAULT = 20.0
PATCH_RADIUS_MIN = 1.0
PATCH_RADIUS_MAX = 60.0
GAIA_EPOCH = 2016.0
SIMBAD_EPOCH = 2000.0
DEFAULT_EPOCH = 2026.0  # positions in frontend/public/data/stars are at J2026.0
PM_MAX_MASYR = 20000.0
HIP_MAX = 120500
DISTANCE_MIN_SNR = 5.0
COUNT_G_LIMIT = 18.0
SAMPLE_RADIUS_ARCMIN = 2.0
EXACT_COUNT_MAX = 8000
BRIGHT_G_LIMITS = (12.0, 16.0)
BRIGHT_MIN_ROWS = 5
BRIGHTEST_N = 8
DEEP_MAXREC = 1000  # rows asked of each deep-field collection by the coverage part
LY_PER_PC = 3.261564
FAST_PM_MASYR = 300.0  # slower stars are found by the plain cone (widened by 0.3 arcsec/yr)
FAST_SEARCH_ARCSEC_PER_YR = 11.0  # Barnard's Star, the fastest, moves 10.4 arcsec/yr
FAST_SEARCH_MAX_ARCSEC = 300.0
SIMBAD_FAST_MAX_ARCSEC = 330.0  # J2000 to 2031 at 10.4 arcsec/yr
# astropy's constellation_names.dat misspells three names
CONSTELLATION_NAME_FIXES = {"Cha": "Chamaeleon", "Oph": "Ophiuchus", "PsA": "Piscis Austrinus"}

GAIA_SOURCE = "Gaia DR3 (ESA/Gaia/DPAC) via IRSA Gator, gaia_dr3_source"
SIMBAD_SOURCE = "SIMBAD (CDS, Strasbourg) via its TAP mirrors"
SPHEREX_SOURCE = "SPHEREx DR1 and QR3 image search (NASA/JPL-Caltech, IRSA SIA)"
SPECTRUM_SOURCE = "SPHEREx DR1 spectral cube (IRSA spherex_dr1_cube), quick look"
SKY_SOURCE = "astropy: IAU constellation boundaries (Roman 1987), galactic and ecliptic frames"
GAIA_OBJECT_COLUMNS = (
    "source_id,ra,dec,phot_g_mean_mag,bp_rp,parallax,parallax_error,pmra,pmdec,radial_velocity,"
    "teff_gspphot,logg_gspphot,ruwe,phot_variable_flag"
)
GAIA_BRIGHT_COLUMNS = "source_id,ra,dec,phot_g_mean_mag,bp_rp,parallax,parallax_error,pmra,pmdec"
GAIA_BRIGHT_NOTE = "Gaia DR3 is incomplete for the very brightest stars (brighter than about G = 3)."

_POOL = ThreadPoolExecutor(max_workers=24, thread_name_prefix="lookup")
_SUB_POOL = ThreadPoolExecutor(max_workers=8, thread_name_prefix="lookup-sub")  # queries a part runs in parallel
_GATOR_SLOTS = threading.BoundedSemaphore(4)
_GATOR_MEMO = TTLCache(maxsize=256, ttl_s=6 * 3600.0)
_SIMBAD_MEMO = TTLCache(maxsize=512, ttl_s=6 * 3600.0)
_RESULT_MEMO = TTLCache(maxsize=256, ttl_s=6 * 3600.0)
_client_lock = threading.Lock()
_client: httpx.Client | None = None


class LookupFailed(RuntimeError):
    """A service gave no usable answer (reported as a part with status "error")."""


def clear_caches() -> None:
    for memo in (_GATOR_MEMO, _SIMBAD_MEMO, _RESULT_MEMO):
        memo.clear()


def _http() -> httpx.Client:
    global _client
    with _client_lock:
        if _client is None:
            _client = httpx.Client(
                timeout=httpx.Timeout(PART_TIMEOUT_S, connect=4.0),
                headers={"User-Agent": config.USER_AGENT},
                follow_redirects=True,
            )
        return _client


# --- inputs -------------------------------------------------------------------------------------------


def _finite(name: str, value: float) -> float:
    if not math.isfinite(value):
        raise invalid(f"{name} must be a finite number")
    return float(value)


def check_position(ra: float, dec: float) -> tuple[float, float]:
    ra, dec = _finite("ra", ra), _finite("dec", dec)
    if not 0.0 <= ra <= 360.0:
        raise invalid(f"ra must be within [0, 360] degrees, got {ra}")
    if not -90.0 <= dec <= 90.0:
        raise invalid(f"dec must be within [-90, 90] degrees, got {dec}")
    return round(ra % 360.0, 5) % 360.0, round(dec, 5)


def check_motion(pmra: float | None, pmdec: float | None) -> tuple[float, float] | None:
    if pmra is None and pmdec is None:
        return None
    if pmra is None or pmdec is None:
        raise invalid("give both pmra and pmdec (mas/yr), or neither")
    pmra, pmdec = _finite("pmra", pmra), _finite("pmdec", pmdec)
    if abs(pmra) > PM_MAX_MASYR or abs(pmdec) > PM_MAX_MASYR:
        raise invalid(f"pmra and pmdec must be within +-{PM_MAX_MASYR:g} mas/yr")
    return round(pmra, 3), round(pmdec, 3)


def check_epoch(epoch: float | None) -> float:
    """The epoch of the caller's position: by default that of the Sky globe's star files (J2026.0)."""
    if epoch is None:
        return DEFAULT_EPOCH
    epoch = _finite("epoch", epoch)
    if not 1900.0 <= epoch <= 2100.0:
        raise invalid(f"epoch must be a Julian year between 1900 and 2100, got {epoch:g}")
    return round(epoch, 3)


# --- small astronomy helpers --------------------------------------------------------------------------


def move(ra: float, dec: float, pm: tuple[float, float] | None, dt_yr: float) -> tuple[float, float]:
    """Position after dt years of straight-line motion (pm = (mu_alpha * cos dec, mu_delta) in mas/yr)."""
    if pm is None or dt_yr == 0.0:
        return ra, dec
    a, d = math.radians(ra), math.radians(dec)
    k = math.radians(1.0 / 3.6e6) * dt_yr
    da, dd = pm[0] * k, pm[1] * k
    x = math.cos(d) * math.cos(a) - math.sin(a) * da - math.sin(d) * math.cos(a) * dd
    y = math.cos(d) * math.sin(a) + math.cos(a) * da - math.sin(d) * math.sin(a) * dd
    z = math.sin(d) + math.cos(d) * dd
    norm = math.sqrt(x * x + y * y + z * z)
    return math.degrees(math.atan2(y, x)) % 360.0, math.degrees(math.asin(max(-1.0, min(1.0, z / norm))))


def separation_arcsec(ra1: float, dec1: float, ra2: float, dec2: float) -> float:
    a1, d1, a2, d2 = (math.radians(v) for v in (ra1, dec1, ra2, dec2))
    h = math.sin((d2 - d1) / 2) ** 2 + math.cos(d1) * math.cos(d2) * math.sin((a2 - a1) / 2) ** 2
    return math.degrees(2 * math.asin(min(1.0, math.sqrt(h)))) * 3600.0


def _num(value: Any) -> float | None:
    if value is None or isinstance(value, (str, bool)):
        return None
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    return out if math.isfinite(out) else None


def _rnd(value: Any, digits: int) -> float | None:
    out = _num(value)
    return None if out is None else round(out, digits)


def distance_from_parallax(plx: float | None, err: float | None) -> dict[str, Any] | None:
    """Distance in parsecs and light-years when the parallax is at least 5 times its error."""
    if plx is None or err is None or plx <= 0 or err <= 0 or plx / err < DISTANCE_MIN_SNR:
        return None
    pc = 1000.0 / plx
    return {
        "pc": round(pc, 2 if pc < 100 else 1),
        "ly": round(pc * LY_PER_PC, 2 if pc < 30 else 1),
        "parallax_over_error": round(plx / err, 1),
    }


# --- sky: constellation, galactic and ecliptic coordinates, plain words -------------------------------

LANDMARKS = (
    # (name, ra, dec, radius deg, sentence)
    ("Large Magellanic Cloud", 80.894, -69.756, 4.5,
     "In the Large Magellanic Cloud, a small galaxy that orbits the Milky Way, about 160,000 light-years away."),
    ("Small Magellanic Cloud", 13.187, -72.829, 2.5,
     "In the Small Magellanic Cloud, a small galaxy that orbits the Milky Way, about 200,000 light-years away."),
    ("Andromeda Galaxy", 10.6847, 41.2690, 1.6,
     "On the Andromeda Galaxy, the nearest large spiral galaxy, about 2.5 million light-years away."),
    ("Orion Nebula", 83.822, -5.391, 0.7,
     "In the Orion Nebula, a cloud of gas where new stars are forming, about 1,300 light-years away."),
    ("Pleiades", 56.75, 24.117, 1.2,
     "In the Pleiades, a young cluster of stars about 440 light-years away."),
    ("Hyades", 66.75, 15.87, 3.0,
     "In the Hyades, the nearest cluster of stars to the Sun, about 150 light-years away."),
    ("M13", 250.4235, 36.4613, 0.3,
     "On M13, a globular cluster of several hundred thousand old stars, about 22,000 light-years away."),
)


def where_words(l_deg: float, b_deg: float, ecl_lat: float, ra: float, dec: float) -> list[str]:
    """Plain sentences on where a position is, from its galactic and ecliptic coordinates."""
    out: list[str] = []
    ab = abs(b_deg)
    if ab < 5:
        out.append("In the plane of the Milky Way, where most of our galaxy's stars, gas and dust lie.")
    elif ab < 15:
        out.append("Close to the plane of the Milky Way.")
    elif ab < 45:
        out.append("Away from the plane of the Milky Way, so there are fewer stars and less dust.")
    elif ab < 80:
        out.append("High above the plane of the Milky Way, looking out of our galaxy towards distant galaxies.")
    else:
        side = "north" if b_deg > 0 else "south"
        out.append(f"Near the {side} galactic pole, looking straight out of the Milky Way's disk.")
    if ab < 30:

        def dl(centre: float) -> float:
            return abs(((l_deg - centre + 180.0) % 360.0) - 180.0)

        if dl(0.0) < 20:
            out.append("Towards the centre of the Milky Way, about 26,000 light-years away.")
        elif dl(180.0) < 20:
            out.append("Towards the galactic anticentre, directly away from the centre of the Milky Way.")
        elif dl(90.0) < 20:
            out.append("Towards where the Sun is heading as it orbits the centre of the Milky Way.")
        elif dl(270.0) < 20:
            out.append("Towards where the Sun has come from on its orbit around the Milky Way.")
    if abs(ecl_lat) < 5:
        out.append("Along the ecliptic, the path of the Sun, Moon and planets, where dust in the solar system "
                   "glows brightest in the infrared.")
    elif abs(ecl_lat) > 86:
        side = "north" if ecl_lat > 0 else "south"
        out.append(f"Near the {side} ecliptic pole, where SPHEREx looks most often (one of its deep fields).")
    for _, lra, ldec, radius, sentence in LANDMARKS:
        if separation_arcsec(ra, dec, lra, ldec) / 3600.0 <= radius:
            out.append(sentence)
    return out


def sky_part(ra: float, dec: float) -> dict[str, Any]:
    import astropy.units as u
    from astropy.coordinates import BarycentricMeanEcliptic, SkyCoord, get_constellation

    c = SkyCoord(ra=ra * u.deg, dec=dec * u.deg, frame="icrs")
    gal = c.galactic
    ecl = c.transform_to(BarycentricMeanEcliptic())
    l_deg, b_deg, lat = float(gal.l.deg), float(gal.b.deg), float(ecl.lat.deg)
    abbr = str(get_constellation(c, short_name=True)).strip()
    return {
        "status": "ok",
        "constellation": abbr,
        "constellation_name": CONSTELLATION_NAME_FIXES.get(abbr, str(get_constellation(c)).strip()),
        "l": round(l_deg, 4),
        "b": round(b_deg, 4),
        "ecliptic_lon": round(float(ecl.lon.deg), 4),
        "ecliptic_lat": round(lat, 4),
        "where": where_words(l_deg, b_deg, lat, ra, dec),
    }


# --- Gator (Gaia DR3) ---------------------------------------------------------------------------------


def gator(
    columns: str,
    ra: float,
    dec: float,
    radius_arcsec: float,
    *,
    constraints: str | None = None,
    outrows: int = 500,
    timeout_s: float = PART_TIMEOUT_S,
    catalog: str = catalogs.GAIA_CATALOG,
) -> tuple[list[dict[str, Any]], bool]:
    """Rows of an IRSA Gator cone search and whether ``outrows`` cut it short (memoised for 6 h)."""
    key = (catalog, columns, round(ra, 5), round(dec, 5), round(radius_arcsec, 2), constraints, outrows)
    hit = _GATOR_MEMO.get(key)
    if hit is not None:
        return hit
    params = {
        "catalog": catalog,
        "spatial": "cone",
        "radius": f"{radius_arcsec:.2f}",
        "radunits": "arcsec",
        "objstr": f"{ra:.6f} {dec:+.6f}",
        "outfmt": "1",
        "outrows": str(outrows),
        "selcols": columns,
    }
    if constraints:
        params["constraints"] = constraints
    deadline = time.monotonic() + timeout_s
    problem = ""
    for attempt in range(2):
        remaining = deadline - time.monotonic()
        if attempt and remaining < 0.5:
            break
        remaining = max(remaining, 0.3)  # the first attempt always goes out
        try:
            with _GATOR_SLOTS:
                resp = _http().get(
                    config.IRSA_GATOR_URL, params=params, timeout=httpx.Timeout(remaining, connect=min(4.0, remaining))
                )
        except httpx.HTTPError as exc:
            problem = f"{type(exc).__name__}: {exc}"
            continue
        if resp.status_code >= 500 or resp.status_code == 429:
            problem = f"HTTP {resp.status_code}"
            time.sleep(0.3 * (attempt + 1))
            continue
        if resp.status_code != 200:
            raise LookupFailed(f"IRSA Gator answered HTTP {resp.status_code}")
        text = resp.text
        if "|" not in text:
            raise LookupFailed(f"Unexpected answer from IRSA Gator: {text[:160]!r}")
        rows = catalogs.parse_ipac_table(text)
        result = (rows, len(rows) >= outrows)
        _GATOR_MEMO.put(key, result)
        return result
    raise LookupFailed(f"IRSA Gator did not answer ({problem or 'out of time'})")


# --- SIMBAD TAP ---------------------------------------------------------------------------------------


def simbad_rows(adql: str, *, timeout_s: float = PART_TIMEOUT_S) -> list[dict[str, Any]]:
    """Rows of a SIMBAD TAP query (JSON), trying the mirrors in order (memoised for 6 h)."""
    key = hashlib.sha256(adql.encode("utf-8")).hexdigest()
    hit = _SIMBAD_MEMO.get(key)
    if hit is not None:
        return hit
    deadline = time.monotonic() + timeout_s
    form = {"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "json", "QUERY": adql}
    problems: list[str] = []
    for mirror in config.SIMBAD_TAP_MIRRORS:
        remaining = deadline - time.monotonic()
        if problems and remaining < 0.5:
            break
        remaining = max(remaining, 0.3)  # the first mirror is always asked
        host = mirror.split("/")[2]
        try:
            resp = _http().post(mirror, data=form, timeout=httpx.Timeout(min(6.0, remaining), connect=min(3.0, remaining)))
        except httpx.HTTPError as exc:
            problems.append(f"{host}: {type(exc).__name__}")
            continue
        if resp.status_code == 400:
            raise LookupFailed(f"SIMBAD rejected the query: {resp.text[:200]!r}")
        if resp.status_code != 200:
            problems.append(f"{host}: HTTP {resp.status_code}")
            continue
        try:
            doc = resp.json()
            names = [col["name"] for col in doc["metadata"]]
            rows = [dict(zip(names, row, strict=False)) for row in doc["data"]]
        except (ValueError, KeyError, TypeError) as exc:
            problems.append(f"{host}: unexpected reply ({exc})")
            continue
        _SIMBAD_MEMO.put(key, rows)
        return rows
    raise LookupFailed("No SIMBAD mirror answered: " + ("; ".join(problems) or "out of time"))


def _adql_literal(text: str) -> str:
    return "'" + text.replace("'", "''") + "'"


SIMBAD_SELECT = (
    "SELECT TOP 10 b.main_id, b.otype, b.sp_type, b.ra, b.dec, b.pmra, b.pmdec, b.plx_value, f.V AS vmag, "
    "g.id AS gaia_id"
)
SIMBAD_JOINS = (
    "LEFT JOIN allfluxes AS f ON f.oidref = b.oid "
    "LEFT JOIN ident AS g ON g.oidref = b.oid AND g.id LIKE 'Gaia DR3 %'"
)


def simbad_by_ident(ident: str) -> str:
    return f"{SIMBAD_SELECT} FROM ident AS i JOIN basic AS b ON b.oid = i.oidref {SIMBAD_JOINS} WHERE i.id = {_adql_literal(ident)}"


def simbad_cone(ra: float, dec: float, radius_deg: float, min_pm_masyr: float | None = None) -> str:
    fast = "" if min_pm_masyr is None else f"AND b.pmra*b.pmra + b.pmdec*b.pmdec > {min_pm_masyr**2:.0f} "
    return (
        f"{SIMBAD_SELECT}, DISTANCE(POINT('ICRS', b.ra, b.dec), POINT('ICRS', {ra:.6f}, {dec:+.6f})) AS dist "
        f"FROM basic AS b {SIMBAD_JOINS} "
        f"WHERE CONTAINS(POINT('ICRS', b.ra, b.dec), CIRCLE('ICRS', {ra:.6f}, {dec:+.6f}, {radius_deg:.6f})) = 1 "
        f"{fast}ORDER BY dist"
    )


def simbad_gaia_names(source_ids: list[str]) -> str:
    ids = ", ".join(_adql_literal(f"Gaia DR3 {s}") for s in source_ids)
    return f"SELECT i.id, b.main_id, b.otype FROM ident AS i JOIN basic AS b ON b.oid = i.oidref WHERE i.id IN ({ids})"


# Plain-English labels for SIMBAD object types (basic.otype). Unknown types fall back to a generic label.
OTYPE_LABELS = {
    "*": "Star",
    "**": "Double or multiple star",
    "MS*": "Main-sequence star",
    "Ev*": "Evolved star",
    "PM*": "Star with a large proper motion",
    "HV*": "Very fast-moving star",
    "LM*": "Low-mass star",
    "BD*": "Brown dwarf: too small to shine by fusion like a star",
    "WD*": "White dwarf: the hot, Earth-sized core left by a dead star",
    "N*": "Neutron star",
    "Psr": "Pulsar: a spinning neutron star",
    "RG*": "Red giant",
    "AB*": "Asymptotic giant branch star: a swollen red giant near the end of its life",
    "HB*": "Horizontal branch star",
    "sg*": "Supergiant",
    "s*r": "Red supergiant",
    "s*y": "Yellow supergiant",
    "s*b": "Blue supergiant",
    "WR*": "Wolf-Rayet star: a very hot, massive star losing its outer layers",
    "C*": "Carbon star",
    "S*": "S-type star (a cool giant rich in heavy elements)",
    "Be*": "Be star: a fast-spinning hot star with a disk of gas",
    "BS*": "Blue straggler star",
    "Pe*": "Chemically peculiar star",
    "Em*": "Emission-line star",
    "Y*O": "Young stellar object: a star still forming",
    "TT*": "T Tauri star: a young star still forming",
    "Or*": "Orion variable: a young, variable star",
    "Ae*": "Herbig Ae/Be star: a young, massive star",
    "V*": "Variable star",
    "Ir*": "Irregular variable star",
    "Er*": "Eruptive variable star",
    "Fl*": "Flare star: a red dwarf with sudden outbursts",
    "BY*": "BY Draconis variable: a spotted, rotating star",
    "RS*": "RS Canum Venaticorum variable: an active close binary star",
    "Ro*": "Rotating variable star",
    "a2*": "Alpha2 Canum Venaticorum variable (a magnetic star)",
    "El*": "Ellipsoidal variable: a binary of egg-shaped stars",
    "Pu*": "Pulsating variable star",
    "LP*": "Long-period variable star",
    "Mi*": "Mira variable: a pulsating red giant",
    "sr*": "Semi-regular variable star",
    "Ce*": "Cepheid variable: a pulsating star used to measure distances",
    "cC*": "Classical Cepheid variable",
    "RR*": "RR Lyrae variable: an old pulsating star",
    "dS*": "Delta Scuti variable: a pulsating star",
    "gD*": "Gamma Doradus variable",
    "bC*": "Beta Cephei variable: a pulsating hot star",
    "SX*": "SX Phoenicis variable",
    "EB*": "Eclipsing binary: two stars that pass in front of each other",
    "SB*": "Spectroscopic binary",
    "CV*": "Cataclysmic variable: a white dwarf pulling gas from a companion",
    "No*": "Nova",
    "SN*": "Supernova",
    "XB*": "X-ray binary",
    "LXB": "Low-mass X-ray binary",
    "HXB": "High-mass X-ray binary",
    "Pl": "Exoplanet",
    "Cl*": "Star cluster",
    "GlC": "Globular cluster: a ball of hundreds of thousands of old stars",
    "OpC": "Open cluster: a group of young stars born together",
    "As*": "Stellar association",
    "MGr": "Moving group of stars",
    "PN": "Planetary nebula: gas thrown off by a dying star",
    "SNR": "Supernova remnant",
    "HII": "H II region: gas lit up by hot young stars",
    "RNe": "Reflection nebula",
    "DNe": "Dark cloud",
    "MoC": "Molecular cloud: cold gas where stars form",
    "Cld": "Interstellar cloud",
    "ISM": "Interstellar matter",
    "G": "Galaxy",
    "GiG": "Galaxy in a group",
    "GiC": "Galaxy in a cluster",
    "BiC": "Brightest galaxy in a cluster",
    "IG": "Interacting galaxies",
    "PaG": "Pair of galaxies",
    "GrG": "Group of galaxies",
    "ClG": "Cluster of galaxies",
    "SBG": "Starburst galaxy: forming stars very fast",
    "EmG": "Emission-line galaxy",
    "LSB": "Low surface brightness galaxy",
    "AGN": "Active galactic nucleus: a feeding black hole",
    "SyG": "Seyfert galaxy (an active galaxy)",
    "Sy1": "Seyfert galaxy (an active galaxy)",
    "Sy2": "Seyfert galaxy (an active galaxy)",
    "LIN": "LINER galaxy (a mildly active galaxy)",
    "QSO": "Quasar: a very distant, very bright active galaxy",
    "Bla": "Blazar: an active galaxy pointing a jet at us",
    "BLL": "BL Lacertae object (a blazar)",
    "rG": "Radio galaxy",
    "IR": "Infrared source",
    "Rad": "Radio source",
    "X": "X-ray source",
    "UV": "Ultraviolet source",
    "gam": "Gamma-ray source",
    "EmO": "Emission object",
    "?": "Object of unknown nature",
    "err": "Not a real object (a catalogue error)",
}


def otype_label(otype: str | None) -> str | None:
    if not otype:
        return None
    code = otype.strip()
    if code in OTYPE_LABELS:
        return OTYPE_LABELS[code]
    if "?" in code:  # SIMBAD candidates: "WD?", "s?r", "Pl?", "Y*?"
        for guess in (code.replace("?", "*"), code.replace("?", ""), code.replace("?", "") + "*", code[:-1] + "O"):
            if guess in OTYPE_LABELS:
                label = OTYPE_LABELS[guess]
                return "Candidate " + label[0].lower() + label[1:]
    return f"Catalogued object (SIMBAD type {code})"


GREEK = {
    "alf": "α", "bet": "β", "gam": "γ", "del": "δ", "eps": "ε", "zet": "ζ", "eta": "η", "tet": "θ", "iot": "ι",
    "kap": "κ", "lam": "λ", "mu.": "μ", "nu.": "ν", "ksi": "ξ", "omi": "ο", "pi.": "π", "rho": "ρ", "sig": "σ",
    "tau": "τ", "ups": "υ", "phi": "φ", "chi": "χ", "psi": "ψ", "ome": "ω",
}
_SUPERSCRIPT = str.maketrans("0123456789", "⁰¹²³⁴⁵⁶⁷⁸⁹")


def pretty_name(main_id: str) -> str:
    """SIMBAD's main identifier for people: "* alf CMa B" -> "α CMa B", "NAME Barnard's star" -> "Barnard's star"."""
    name = display_name(main_id)
    head, _, rest = name.partition(" ")
    if rest and len(head) >= 3 and head[:3] in GREEK:
        digits = head[3:].lstrip("0")
        if head[3:].isdigit() or not head[3:]:
            return GREEK[head[:3]] + digits.translate(_SUPERSCRIPT) + " " + rest
    return name


def _simbad_doc(row: dict[str, Any], sep: float | None, n_within: int) -> dict[str, Any]:
    main_id = " ".join(str(row.get("main_id") or "").split())
    gaia_id = str(row.get("gaia_id") or "").replace("Gaia DR3", "").strip() or None
    return {
        "status": "ok",
        "main_id": main_id,
        "name": pretty_name(main_id) if main_id else None,
        "otype": (row.get("otype") or "").strip() or None,
        "otype_label": otype_label(row.get("otype")),
        "sp_type": (row.get("sp_type") or "").strip() or None,
        "vmag": _rnd(row.get("vmag"), 3),
        "parallax": _rnd(row.get("plx_value"), 4),
        "gaia_dr3_id": gaia_id,
        "separation_arcsec": None if sep is None else round(sep, 2),
        "n_within": n_within,
        "url": "https://simbad.cfa.harvard.edu/simbad/sim-id?Ident=" + quote(main_id, safe=""),
    }


def _simbad_rows_dedupe(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: dict[str, dict[str, Any]] = {}
    for row in rows:
        key = str(row.get("main_id") or "")
        if key not in seen or (not seen[key].get("gaia_id") and row.get("gaia_id")):
            seen[key] = row
    return list(seen.values())


def simbad_object(
    ra: float, dec: float, radius_arcsec: float, epoch: float, pm: tuple[float, float] | None, hip: int | None
) -> dict[str, Any]:
    if hip is not None:
        rows = _simbad_rows_dedupe(simbad_rows(simbad_by_ident(f"HIP {hip}")))
        if not rows:
            return {"status": "none", "message": f"SIMBAD has no entry for HIP {hip}."}
        row = rows[0]
        sep = None
        r0, d0 = _num(row.get("ra")), _num(row.get("dec"))
        if r0 is not None and d0 is not None:
            spm = (_num(row.get("pmra")) or 0.0, _num(row.get("pmdec")) or 0.0)
            sep = separation_arcsec(ra, dec, *move(r0, d0, spm, epoch - SIMBAD_EPOCH))
        doc = _simbad_doc(row, sep, 1)
        doc["matched_by"] = f"identifier HIP {hip}"
        doc["_j2000"] = (r0, d0, _num(row.get("pmra")), _num(row.get("pmdec")))
        return doc
    # SIMBAD positions are at J2000: without the caller's motion, widen the cone for slow movers and add
    # one for fast movers (as for Gaia), then compare every candidate where it is at `epoch`.
    centre = move(ra, dec, pm, SIMBAD_EPOCH - epoch)
    dt = abs(epoch - SIMBAD_EPOCH)
    queries = [simbad_cone(*centre, (radius_arcsec + (FAST_PM_MASYR / 1000.0 * dt if pm is None else 0.0)) / 3600.0)]
    if pm is None and dt > 0.5:
        wide = min(radius_arcsec + FAST_SEARCH_ARCSEC_PER_YR * dt, SIMBAD_FAST_MAX_ARCSEC)
        queries.append(simbad_cone(*centre, wide / 3600.0, min_pm_masyr=FAST_PM_MASYR))
    jobs = [_SUB_POOL.submit(simbad_rows, q) for q in queries]
    rows = _simbad_rows_dedupe([row for job in jobs for row in job.result(timeout=PART_TIMEOUT_S)])
    near: list[tuple[float, dict[str, Any]]] = []
    for row in rows:
        r0, d0 = _num(row.get("ra")), _num(row.get("dec"))
        if r0 is None or d0 is None:
            continue
        spm = (_num(row.get("pmra")) or 0.0, _num(row.get("pmdec")) or 0.0)
        sep = separation_arcsec(ra, dec, *move(r0, d0, spm, epoch - SIMBAD_EPOCH))
        if sep <= radius_arcsec:
            near.append((sep, row))
    if not near:
        return {"status": "none", "message": f"SIMBAD lists no object within {radius_arcsec:g} arcsec."}
    # A planet shares its star's position in SIMBAD ("Proxima Centauri c"): name the star.
    sep, row = min(near, key=lambda item: (str(item[1].get("otype") or "").startswith("Pl"), item[0]))
    doc = _simbad_doc(row, sep, len(near))
    doc["matched_by"] = "nearest in the cone"
    return doc


# --- Gaia DR3: one source -----------------------------------------------------------------------------


def _absolute_g(g: float | None, plx: float | None, err: float | None) -> float | None:
    if g is None or distance_from_parallax(plx, err) is None:
        return None
    return g + 5.0 * math.log10(plx / 100.0)  # plx in mas: M = m + 5 log10(plx / 100)


def gaia_hint(row: dict[str, Any]) -> str | None:
    """A cautious plain-language reading of Gaia's colour and brightness (None when it is not clear)."""
    g, bp_rp = _num(row.get("phot_g_mean_mag")), _num(row.get("bp_rp"))
    plx, err = _num(row.get("parallax")), _num(row.get("parallax_error"))
    mg = _absolute_g(g, plx, err)
    parts: list[str] = []
    if mg is not None and bp_rp is not None:
        if bp_rp < 0.8 and mg > 9.5:
            parts.append("Its colour and brightness look like a white dwarf: the hot, Earth-sized core left "
                         "behind by a star like the Sun.")
        elif bp_rp > 3.5 and mg > 14.0:
            parts.append("Its colour and brightness look like an ultracool dwarf: a tiny, cold star or a brown dwarf.")
        elif bp_rp > 1.8 and mg > 8.0:
            parts.append("Its colour and brightness look like a red dwarf: a small, cool star, the most common "
                         "kind of star in the Milky Way.")
        elif bp_rp > 1.0 and mg < 2.0:
            parts.append("Its colour and brightness look like a giant: an old star that has swollen to many "
                         "times the Sun's size.")
        elif 0.65 <= bp_rp <= 1.0 and 3.5 <= mg <= 6.0:
            parts.append("Its colour and brightness look like the Sun's: a yellow main-sequence star.")
        elif bp_rp < 0.3 and mg < 2.5:
            parts.append("Its colour and brightness look like a hot, massive star, much brighter than the Sun.")
    dist = distance_from_parallax(plx, err)
    if dist is not None and dist["ly"] < 50:
        parts.append(f"It is one of the Sun's neighbours, {dist['ly']:.1f} light-years away.")
    if str(row.get("phot_variable_flag") or "").upper() == "VARIABLE":
        parts.append("Gaia saw its brightness change.")
    ruwe = _num(row.get("ruwe"))
    if ruwe is not None and ruwe > 1.4:
        parts.append(f"Gaia's position fit is poor (RUWE {ruwe:.1f}), often a sign of an unseen companion, so "
                     "treat its distance with care.")
    return " ".join(parts) or None


def _plausible(g: float | None, vmag: float | None) -> bool:
    """Could a Gaia source of magnitude G be the star SIMBAD lists with magnitude V?"""
    if g is None or vmag is None:
        return True
    return -3.5 <= g - vmag <= 0.6


def _gaia_doc(row: dict[str, Any], sep: float, epoch_pos: tuple[float, float], n_within: int) -> dict[str, Any]:
    plx, err = _num(row.get("parallax")), _num(row.get("parallax_error"))
    pmra, pmdec = _num(row.get("pmra")), _num(row.get("pmdec"))
    dist = distance_from_parallax(plx, err)
    return {
        "status": "ok",
        "source_id": str(row.get("source_id")),
        "ra": _rnd(row.get("ra"), 7),
        "dec": _rnd(row.get("dec"), 7),
        "ref_epoch": GAIA_EPOCH,
        "ra_epoch": round(epoch_pos[0], 7),
        "dec_epoch": round(epoch_pos[1], 7),
        "separation_arcsec": round(sep, 2),
        "n_within": n_within,
        "g": _rnd(row.get("phot_g_mean_mag"), 4),
        "bp_rp": _rnd(row.get("bp_rp"), 4),
        "parallax": _rnd(plx, 4),
        "parallax_error": _rnd(err, 4),
        "distance_pc": dist["pc"] if dist else None,
        "distance_ly": dist["ly"] if dist else None,
        "pmra": _rnd(pmra, 3),
        "pmdec": _rnd(pmdec, 3),
        "pm_total": round(math.hypot(pmra, pmdec), 3) if pmra is not None and pmdec is not None else None,
        "radial_velocity": _rnd(row.get("radial_velocity"), 3),
        "teff_gspphot": _rnd(row.get("teff_gspphot"), 1),
        "logg_gspphot": _rnd(row.get("logg_gspphot"), 3),
        "ruwe": _rnd(row.get("ruwe"), 3),
        "phot_variable_flag": (str(row.get("phot_variable_flag") or "").strip() or None),
        "hint": gaia_hint(row),
        "url": "https://vizier.cfa.harvard.edu/viz-bin/VizieR-5?-source=I/355/gaiadr3&Source="
        + str(row.get("source_id")),
    }


def gaia_object(
    ra: float,
    dec: float,
    radius_arcsec: float,
    epoch: float,
    pm: tuple[float, float] | None,
    simbad: Future | None,
    deadline: float,
) -> dict[str, Any]:
    """The Gaia DR3 source at (ra, dec) seen at ``epoch``.

    Without the caller's proper motion, a second cone looks for fast movers (over 300 mas/yr) whose 2016
    position is up to 11 arcsec/yr away, so Barnard's Star is found from where it is today.
    """
    want_id: str | None = None
    vmag: float | None = None
    centre = move(ra, dec, pm, GAIA_EPOCH - epoch)
    dt = abs(epoch - GAIA_EPOCH)
    cones: list[tuple[tuple[float, float], float, str | None]] = []
    if simbad is not None:
        try:
            sim = simbad.result(timeout=max(0.1, deadline - time.monotonic() - 2.5))
        except Exception:  # noqa: BLE001 - fall back to the position alone
            sim = None
        if sim and sim.get("status") == "ok":
            want_id = sim.get("gaia_dr3_id")
            vmag = sim.get("vmag")
            r0, d0, spmra, spmdec = sim.get("_j2000") or (None, None, None, None)
            if want_id and r0 is not None and d0 is not None:
                spm = (spmra or 0.0, spmdec or 0.0)
                cones.append((move(r0, d0, spm, GAIA_EPOCH - SIMBAD_EPOCH), max(radius_arcsec, 3.0), None))
    if not cones:
        slow = radius_arcsec + (FAST_PM_MASYR / 1000.0 * dt if pm is None else 0.0)
        cones.append((centre, round(slow, 2), None))
        if pm is None and dt > 0.5:
            fast = min(radius_arcsec + FAST_SEARCH_ARCSEC_PER_YR * dt, FAST_SEARCH_MAX_ARCSEC)
            cones.append((centre, round(fast, 2), f"pmra*pmra+pmdec*pmdec>{FAST_PM_MASYR**2:.0f}"))
    timeout = max(0.5, deadline - time.monotonic())
    jobs = [
        _SUB_POOL.submit(gator, GAIA_OBJECT_COLUMNS, c[0], c[1], r, constraints=k, outrows=200, timeout_s=timeout)
        for c, r, k in cones
    ]
    rows: dict[str, dict[str, Any]] = {}
    for job in jobs:
        for row in job.result(timeout=timeout + 1.0)[0]:
            rows.setdefault(str(row.get("source_id")), row)
    near: list[tuple[float, dict[str, Any], tuple[float, float]]] = []
    for sid, row in rows.items():
        r0, d0 = _num(row.get("ra")), _num(row.get("dec"))
        if r0 is None or d0 is None:
            continue
        gpm = (_num(row.get("pmra")) or 0.0, _num(row.get("pmdec")) or 0.0)
        pos = move(r0, d0, gpm, epoch - GAIA_EPOCH)
        sep = separation_arcsec(ra, dec, *pos)
        if want_id and sid == want_id:
            doc = _gaia_doc(row, sep, pos, len(rows))
            doc["matched_by"] = "SIMBAD cross-identification"
            return doc
        if sep <= max(radius_arcsec, 3.0 if want_id else 0.0) and _plausible(_num(row.get("phot_g_mean_mag")), vmag):
            near.append((sep, row, pos))
    if not near:
        message = f"No Gaia DR3 source within {radius_arcsec:g} arcsec."
        if vmag is not None and vmag < 4:
            message += " " + GAIA_BRIGHT_NOTE
        return {"status": "none", "message": message, "n_within": 0}
    sep, row, pos = min(near, key=lambda item: item[0])
    doc = _gaia_doc(row, sep, pos, len(near))
    doc["matched_by"] = "nearest source"
    return doc


# --- Gaia DR3: a patch ------------------------------------------------------------------------------


def stars_count(ra: float, dec: float, radius_arcmin: float, deadline: float) -> dict[str, Any]:
    """Gaia DR3 sources to G = 18 within the radius: exact when few enough, else a labelled estimate."""
    constraint = f"phot_g_mean_mag<{COUNT_G_LIMIT:g}"
    area = math.pi * (radius_arcmin / 60.0) ** 2
    sample_r = min(SAMPLE_RADIUS_ARCMIN, radius_arcmin)
    rows, cut = gator("phot_g_mean_mag", ra, dec, sample_r * 60.0, constraints=constraint, outrows=20000,
                      timeout_s=max(0.5, deadline - time.monotonic()))
    n_sample = len(rows)
    base = {"status": "ok", "g_limit": COUNT_G_LIMIT, "radius_arcmin": radius_arcmin, "area_deg2": round(area, 4)}
    if sample_r >= radius_arcmin and not cut:
        return {**base, "count": n_sample, "method": "exact", "density_per_deg2": round(n_sample / area, 1)}
    expected = n_sample * (radius_arcmin / sample_r) ** 2
    if expected <= EXACT_COUNT_MAX and not cut and deadline - time.monotonic() > 1.5:
        try:
            full, cut_full = gator("phot_g_mean_mag", ra, dec, radius_arcmin * 60.0, constraints=constraint,
                                   outrows=EXACT_COUNT_MAX + 2000, timeout_s=max(0.5, deadline - time.monotonic()))
        except LookupFailed:
            full, cut_full = [], True
        if not cut_full and (full or n_sample == 0):
            return {**base, "count": len(full), "method": "exact", "density_per_deg2": round(len(full) / area, 1)}
    if cut:
        return {**base, "status": "none", "message": "Too many sources to count here quickly."}
    sample_area = math.pi * (sample_r / 60.0) ** 2
    density = n_sample / sample_area
    count = density * area
    rel = 1.0 / math.sqrt(n_sample) if n_sample else None
    return {
        **base,
        "count": int(round(count, -2 if count > 1000 else -1)),
        "method": "estimate",
        "sample_radius_arcmin": sample_r,
        "sample_count": n_sample,
        "relative_error": None if rel is None else round(rel, 3),
        "density_per_deg2": round(density, 1),
        "message": f"Estimated from the {n_sample} sources within {sample_r:g} arcmin of the centre.",
    }


def brightest(ra: float, dec: float, radius_arcmin: float, deadline: float) -> dict[str, Any]:
    """The brightest few Gaia DR3 sources in the patch, with SIMBAD names where SIMBAD knows them."""
    rows: list[dict[str, Any]] = []
    g_limit = BRIGHT_G_LIMITS[0]
    for g_limit in BRIGHT_G_LIMITS:
        rows, _ = gator(GAIA_BRIGHT_COLUMNS, ra, dec, radius_arcmin * 60.0, constraints=f"phot_g_mean_mag<{g_limit:g}",
                        outrows=5000, timeout_s=max(0.5, deadline - time.monotonic() - 1.0))
        if len(rows) >= BRIGHT_MIN_ROWS or deadline - time.monotonic() < 2.5:
            break
    rows = [r for r in rows if _num(r.get("phot_g_mean_mag")) is not None]
    rows.sort(key=lambda r: float(r["phot_g_mean_mag"]))
    top = rows[:BRIGHTEST_N]
    names: dict[str, dict[str, Any]] = {}
    naming = "ok"
    if top:
        try:
            for row in simbad_rows(simbad_gaia_names([str(r["source_id"]) for r in top]),
                                   timeout_s=max(0.5, min(5.0, deadline - time.monotonic()))):
                sid = str(row.get("id") or "").replace("Gaia DR3", "").strip()
                names[sid] = row
        except LookupFailed as exc:
            log.info("SIMBAD names for the brightest sources failed: %s", exc)
            naming = "unavailable"
    stars = []
    for r in top:
        sid = str(r["source_id"])
        sim = names.get(sid)
        main_id = " ".join(str(sim.get("main_id") or "").split()) if sim else ""
        plx, err = _num(r.get("parallax")), _num(r.get("parallax_error"))
        dist = distance_from_parallax(plx, err)
        stars.append({
            "source_id": sid,
            "ra": _rnd(r.get("ra"), 7),
            "dec": _rnd(r.get("dec"), 7),
            "separation_arcmin": round(separation_arcsec(ra, dec, float(r["ra"]), float(r["dec"])) / 60.0, 2),
            "g": _rnd(r.get("phot_g_mean_mag"), 3),
            "bp_rp": _rnd(r.get("bp_rp"), 3),
            "parallax": _rnd(plx, 4),
            "distance_ly": dist["ly"] if dist else None,
            "simbad_id": main_id or None,
            "name": pretty_name(main_id) if main_id else None,
            "otype_label": otype_label(sim.get("otype")) if sim else None,
        })
    return {
        "status": "ok" if stars else "none",
        "g_limit": g_limit,
        "n_brighter": len(rows),
        "stars": stars,
        "names": naming,
        "message": None if stars else f"No Gaia DR3 source brighter than G = {g_limit:g} in this patch.",
        "notes": [GAIA_BRIGHT_NOTE, "Names from SIMBAD's Gaia DR3 cross-identifications."],
    }


# --- SPHEREx coverage and spectrum ------------------------------------------------------------------


def spherex_coverage(ra: float, dec: float) -> dict[str, Any]:
    """Coverage from the SIA point search alone (cached on disk for a day; no file reads).

    The deep-field collections hold tens of thousands of images at the ecliptic poles (a full search takes
    20 s), so they are searched for at most ``DEEP_MAXREC`` rows here and the answer says when it was capped.
    """
    try:
        names = sia.discover_l2_collections()
        wide = [n for n in names if not sia.is_deep_collection(n)]
        deep = [n for n in names if sia.is_deep_collection(n)]
        deep_job = (
            _SUB_POOL.submit(sia.search_position, ra, dec, field.SEARCH_RADIUS_DEG, deep, DEEP_MAXREC) if deep else None
        )
        results = list(sia.search_position(ra, dec, field.SEARCH_RADIUS_DEG, wide)) if wide else []
        if deep_job is not None:
            results += deep_job.result()
    except (sia.SiaError, httpx.HTTPError) as exc:
        raise LookupFailed(f"The SPHEREx image search at IRSA failed: {exc}"[:300]) from exc
    failed = [r for r in results if r.source == "failed"]
    if failed and len(failed) == len(results):
        raise LookupFailed("The SPHEREx image search at IRSA failed: " + "; ".join(str(r.error) for r in failed)[:300])
    images = sia.dedupe_images(im for r in results for im in r.images)
    warnings = []
    if failed:
        warnings.append("Some SPHEREx collections could not be searched: " + ", ".join(r.collection for r in failed))
    capped = [r.collection for r in results if r.truncated]
    if capped:
        warnings.append(
            f"Deep field: only the first {DEEP_MAXREC:,} images of {', '.join(capped)} were counted here; "
            "there are more (open the field in the Lab for all of them)."
        )
    if not images:
        return {
            "status": "none",
            "n_images": 0,
            "n_epochs": 0,
            "collections_searched": names,
            "message": "SPHEREx has no images of this spot in the releases searched yet.",
            "warnings": warnings,
        }
    exposures = ep.group_exposures(images)
    deep = any(sia.is_deep_collection(im.collection) for im in images)
    epochs = ep.group_epochs(exposures, max_span_days=field.DEEP_MAX_SPAN_DAYS if deep else None)
    per_det = Counter(im.detector for im in images)
    return {
        "status": "ok",
        "n_images": len(images),
        "n_exposures": len(exposures),
        "n_epochs": len(epochs),
        "first_obs": field.mjd_to_date(min(im.t_min_mjd for im in images)),
        "last_obs": field.mjd_to_date(max(im.t_max_mjd for im in images)),
        "deep_field": deep,
        "counts_complete": not capped and not failed,
        "collections": sorted({im.collection for im in images}),
        "detectors": {f"D{d}": int(per_det.get(d, 0)) for d in range(1, 7)},
        "epochs": [
            {
                "label": field.mjd_to_label(e.t_mid_mjd),
                "start": field.mjd_to_date(e.t_start_mjd),
                "end": field.mjd_to_date(e.t_end_mjd),
                "year": int(e.survey_year or ep.survey_year(e.t_start_mjd)),
                "n_exposures": len(e.exposures),
                "full": bool(e.full),
            }
            for e in epochs
        ],
        "epoch_note": "Deep-field epochs are 30-day bins of continuous coverage." if deep else None,
        "warnings": warnings,
    }


def _round_list(values: Any, digits: int) -> list[float | None]:
    return [_rnd(v, digits) for v in values]


def spectrum_doc(res: dict[str, Any], ra: float, dec: float) -> dict[str, Any]:
    """The /api/spectrum/quick answer from a ``cube.cube_spectrum`` result (sorted by wavelength)."""
    order = sorted(range(len(res["wavelength_um"])), key=lambda i: float(res["wavelength_um"][i]))

    def col(key: str, digits: int) -> list[float | None]:
        return [_rnd(res[key][i], digits) for i in order]

    return {
        "wl_um": [round(float(res["wavelength_um"][i]), 5) for i in order],
        "bw_um": col("bandwidth_um", 5),
        "flux_ujy": col("flux_ujy", 3),
        "err_ujy": col("flux_err_ujy", 3),
        "flux_partial_ujy": col("flux_partial_ujy", 3),
        "lower_limit": [bool(res["lower_limit"][i]) for i in order],
        "label": res["label"],
        "ra": ra,
        "dec": dec,
        "n_finite": int(res["n_finite"]),
        "pixel_arcsec": round(float(res["pixel_arcsec"]), 3),
        "notes": res["notes"],
    }


def spectrum_part(ra: float, dec: float) -> dict[str, Any]:
    try:
        res = cube.cube_spectrum(ra, dec)
    except cube.CubeError as exc:
        return {"status": "none", "message": f"No DR1 cube data at this position: {exc}"[:300]}
    except sia.SiaError as exc:
        raise LookupFailed(f"The IRSA cube search failed: {exc}"[:300]) from exc
    except (rangeio.RangeIOError, httpx.HTTPError) as exc:
        raise LookupFailed(f"Reading the IRSA cube failed: {exc}"[:300]) from exc
    return {"status": "ok", **spectrum_doc(res, ra, dec)}


# --- running the parts ------------------------------------------------------------------------------


def _timed(fn: Callable[[], dict[str, Any]]) -> Callable[[], dict[str, Any]]:
    def run() -> dict[str, Any]:
        t0 = time.monotonic()
        doc = fn()
        doc["seconds"] = round(time.monotonic() - t0, 3)
        return doc

    return run


def run_parts(
    parts: dict[str, tuple[Callable[[], dict[str, Any]], float]], sources: dict[str, str], t0: float
) -> dict[str, dict[str, Any]]:
    """Start every part at once; collect each by its own deadline (t0 + its timeout)."""
    futures = {name: _POOL.submit(_timed(fn)) for name, (fn, _) in parts.items()}
    return collect(futures, {name: t for name, (_, t) in parts.items()}, sources, t0)


def collect(
    futures: dict[str, Future], timeouts: dict[str, float], sources: dict[str, str], t0: float
) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for name, fut in futures.items():
        remaining = t0 + timeouts[name] - time.monotonic()
        try:
            doc = dict(fut.result(timeout=max(0.0, remaining)))
        except FutureTimeout:
            doc = {
                "status": "timeout",
                "message": f"No answer within {timeouts[name]:g} s. Try again in a moment: the answer is "
                           "still being fetched and will be cached.",
            }
        except LookupFailed as exc:
            doc = {"status": "error", "message": str(exc)[:300]}
        except Exception as exc:  # one failed part must not sink the others
            log.exception("lookup part %s failed", name)
            doc = {"status": "error", "message": f"Internal error: {type(exc).__name__}"}
        doc.pop("_j2000", None)
        doc["source"] = sources[name]
        out[name] = doc
    return out


def is_complete(parts: dict[str, dict[str, Any]]) -> bool:
    return all(p.get("status") in ("ok", "none") for p in parts.values())


def object_lookup(
    ra: float,
    dec: float,
    radius_arcsec: float = RADIUS_ARCSEC_DEFAULT,
    epoch: float | None = None,
    pmra: float | None = None,
    pmdec: float | None = None,
    hip: int | None = None,
) -> dict[str, Any]:
    """Everything known at one spot (see the module docstring); never raises for a service failure."""
    ra, dec = check_position(ra, dec)
    radius = _finite("radius_arcsec", radius_arcsec)
    if not 0.0 < radius <= RADIUS_ARCSEC_MAX:
        raise invalid(f"radius_arcsec must be within (0, {RADIUS_ARCSEC_MAX:g}], got {radius:g}")
    radius = round(radius, 2)
    pm = check_motion(pmra, pmdec)
    when = check_epoch(epoch)
    if hip is not None and not 1 <= hip <= HIP_MAX:
        raise invalid(f"hip must be a Hipparcos number between 1 and {HIP_MAX}, got {hip}")
    query = {"ra": ra, "dec": dec, "radius_arcsec": radius, "epoch": when,
             "pmra": pm[0] if pm else None, "pmdec": pm[1] if pm else None, "hip": hip}
    key = ("object", tuple(query.values()))
    hit = _RESULT_MEMO.get(key)
    if hit is not None:
        return hit
    t0 = time.monotonic()
    deadline = t0 + PART_TIMEOUT_S
    futures: dict[str, Future] = {
        "simbad": _POOL.submit(_timed(lambda: simbad_object(ra, dec, radius, when, pm, hip))),
    }
    futures["gaia"] = _POOL.submit(_timed(
        lambda: gaia_object(ra, dec, radius, when, pm, futures["simbad"] if hip is not None else None, deadline)
    ))
    futures["spherex"] = _POOL.submit(_timed(lambda: spherex_coverage(ra, dec)))
    futures["spectrum"] = _POOL.submit(_timed(lambda: spectrum_part(ra, dec)))
    futures["sky"] = _POOL.submit(_timed(lambda: sky_part(ra, dec)))
    sources = {"sky": SKY_SOURCE, "gaia": GAIA_SOURCE, "simbad": SIMBAD_SOURCE, "spherex": SPHEREX_SOURCE,
               "spectrum": SPECTRUM_SOURCE}
    order = ("sky", "gaia", "simbad", "spherex", "spectrum")
    parts = collect({k: futures[k] for k in order}, dict.fromkeys(order, PART_TIMEOUT_S), sources, t0)
    doc = {
        "schema": "pxh-object/1",
        "generated_at": field.utc_iso(),
        "query": query,
        **parts,
        "complete": is_complete(parts),
        "seconds": round(time.monotonic() - t0, 3),
    }
    if doc["complete"]:
        _RESULT_MEMO.put(key, doc)
    return doc


def patch_lookup(ra: float, dec: float, radius_arcmin: float = PATCH_RADIUS_DEFAULT) -> dict[str, Any]:
    """What is in a patch of sky (see the module docstring); never raises for a service failure."""
    ra, dec = check_position(ra, dec)
    radius = _finite("radius_arcmin", radius_arcmin)
    if not PATCH_RADIUS_MIN <= radius <= PATCH_RADIUS_MAX:
        raise invalid(f"radius_arcmin must be within [{PATCH_RADIUS_MIN:g}, {PATCH_RADIUS_MAX:g}], got {radius:g}")
    radius = round(radius, 2)
    query = {"ra": ra, "dec": dec, "radius_arcmin": radius}
    key = ("patch", ra, dec, radius)
    hit = _RESULT_MEMO.get(key)
    if hit is not None:
        return hit
    t0 = time.monotonic()
    chain_deadline = t0 + CHAIN_TIMEOUT_S
    parts = run_parts(
        {
            "sky": (lambda: sky_part(ra, dec), PART_TIMEOUT_S),
            "stars_count": (lambda: stars_count(ra, dec, radius, chain_deadline), CHAIN_TIMEOUT_S),
            "brightest": (lambda: brightest(ra, dec, radius, chain_deadline), CHAIN_TIMEOUT_S),
            "spherex": (lambda: spherex_coverage(ra, dec), PART_TIMEOUT_S),
            "spectrum": (lambda: spectrum_part(ra, dec), PART_TIMEOUT_S),
        },
        {"sky": SKY_SOURCE, "stars_count": GAIA_SOURCE, "brightest": GAIA_SOURCE + "; names from " + SIMBAD_SOURCE,
         "spherex": SPHEREX_SOURCE, "spectrum": SPECTRUM_SOURCE},
        t0,
    )
    doc = {
        "schema": "pxh-patch/1",
        "generated_at": field.utc_iso(),
        "query": query,
        **parts,
        "complete": is_complete(parts),
        "seconds": round(time.monotonic() - t0, 3),
    }
    if doc["complete"]:
        _RESULT_MEMO.put(key, doc)
    return doc
