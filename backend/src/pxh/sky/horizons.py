"""JPL Horizons observer ephemerides of solar-system bodies (e.g. Pluto), cached on disk.

Horizons (https://ssd.jpl.nasa.gov/api/horizons.api, no key) is asked for an OBSERVER table with angles in
decimal degrees, Julian-date (UT) times and comma-separated columns. The quantities parsed here:

- 1: astrometric RA/Dec (ICRF): corrected for light time, without aberration or light deflection, so it can
  be compared directly with positions on images whose WCS was fitted to catalogue (Gaia) stars;
- 3: rates dRA*cos(Dec) and dDec/dt (arcsec per hour);
- 9: visual magnitude (APmag) and surface brightness;
- 19: heliocentric range r (au) and its rate (km/s);
- 20: observer range delta (au) and its rate (km/s);
- 23: solar elongation, the Sun-observer-target angle (deg);
- 24: phase angle, the Sun-target-observer angle (deg).

Times are UTC (Horizons "UT" after 1962), the time scale of the SPHEREx MJD-AVG header keyword. Responses
are cached under CACHE_DIR/horizons, keyed by the request parameters. The ephemeris solution behind a table
(for Pluto ``plu060``) is recorded in ``Ephemeris.source``.

Observer offset: tables are geocentric (CENTER 500@399). ``observer_offset`` moves a geocentric direction to
an observer displaced by a geocentric vector in km on equatorial axes, such as SPHEREx's X_SC/Y_SC/Z_SC
header keywords. At Pluto's 35 au, the 7,000 km low-orbit offset shifts the direction by up to 0.28 arcsec.
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
import re
import time
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx
import numpy as np
from numpy.typing import ArrayLike, NDArray
from scipy.interpolate import CubicSpline

from pxh import config
from pxh.spherex.rangeio import write_atomic

log = logging.getLogger(__name__)

API_URL = "https://ssd.jpl.nasa.gov/api/horizons.api"
GEOCENTRE = "500@399"
DEFAULT_QUANTITIES = "1,3,9,19,20,23,24"
TLIST_CHUNK = 50  # discrete times per request: 100 times (a 2.2 kB URL) got HTTP 502 on 2026-11-15, 50 work
MJD_TO_JD = 2400000.5
AU_KM = 1.495978707e8
TIMEOUT_S = 60.0
ATTEMPTS = 4
_RETRY_STATUS = frozenset({429, 500, 502, 503, 504})
_CACHE_VERSION = 1

FloatArray = NDArray[np.float64]

# Normalised column header (underscores and spaces removed) -> Ephemeris field.
_COLUMNS = {
    "DateJDUT": "jd_utc",
    "R.A.(ICRF)": "ra_deg",
    "DEC(ICRF)": "dec_deg",
    "dRA*cosD": "dra_cosdec_arcsec_h",
    "d(DEC)/dt": "ddec_arcsec_h",
    "APmag": "vmag",
    "S-brt": "surface_brightness",
    "r": "r_au",
    "rdot": "rdot_kms",
    "delta": "delta_au",
    "deldot": "deldot_kms",
    "S-O-T": "elongation_deg",
    "S-T-O": "phase_deg",
}
_REQUIRED = ("jd_utc", "ra_deg", "dec_deg")
_SOURCE_RE = re.compile(r"Target body name:\s*(?P<name>.+?)\s*\{source:\s*(?P<source>[^}]+)\}")


class HorizonsError(RuntimeError):
    """Horizons answered with an error, or with no ephemeris table."""


@dataclass(frozen=True)
class Ephemeris:
    """An observer table: one row per time, angles in degrees, times as MJD (UTC)."""

    target: str  # e.g. "Pluto (999)"
    source: str  # ephemeris solution named by Horizons, e.g. "plu060_merged"
    center: str  # e.g. "500@399"
    mjd_utc: FloatArray
    ra_deg: FloatArray
    dec_deg: FloatArray
    columns: dict[str, FloatArray] = field(default_factory=dict)  # the other parsed quantities

    def __len__(self) -> int:
        return int(self.mjd_utc.size)

    def column(self, name: str) -> FloatArray:
        if name not in self.columns:
            raise KeyError(f"column {name!r} not in this table (have {sorted(self.columns)})")
        return self.columns[name]

    def interp(self, mjd: ArrayLike) -> tuple[FloatArray, FloatArray]:
        """(ra, dec) in degrees at ``mjd`` by cubic splines of the unit vector (no RA wrap problems)."""
        return _interp_radec(self.mjd_utc, self.ra_deg, self.dec_deg, mjd)

    def interp_column(self, name: str, mjd: ArrayLike) -> FloatArray:
        """A scalar column at ``mjd`` by a cubic spline."""
        y = self.column(name)
        ok = np.isfinite(y)
        return np.asarray(CubicSpline(self.mjd_utc[ok], y[ok])(np.asarray(mjd, dtype=float)), dtype=float)

    def to_rows(self) -> list[dict[str, float]]:
        names = ["mjd_utc", "ra_deg", "dec_deg", *sorted(self.columns)]
        arrays = [self.mjd_utc, self.ra_deg, self.dec_deg, *(self.columns[n] for n in sorted(self.columns))]
        return [dict(zip(names, (float(a[i]) for a in arrays), strict=True)) for i in range(len(self))]


# --- requests -------------------------------------------------------------------------------------------


def _quote(value: str) -> str:
    return "'" + str(value).replace("'", "") + "'"


def build_params(
    command: str,
    *,
    start: str | None = None,
    stop: str | None = None,
    step: str | None = None,
    tlist_jd: Sequence[float] | None = None,
    center: str = GEOCENTRE,
    quantities: str = DEFAULT_QUANTITIES,
) -> dict[str, str]:
    """Query parameters for one OBSERVER table: a time range (start, stop, step) or a list of JD (UT)."""
    if (tlist_jd is None) == (start is None):
        raise ValueError("give either start/stop/step or tlist_jd")
    params = {
        "format": "json",
        "COMMAND": _quote(command),
        "OBJ_DATA": _quote("NO"),
        "MAKE_EPHEM": _quote("YES"),
        "EPHEM_TYPE": _quote("OBSERVER"),
        "CENTER": _quote(center),
        "QUANTITIES": _quote(quantities),
        "ANG_FORMAT": _quote("DEG"),
        "CAL_FORMAT": _quote("JD"),
        "CSV_FORMAT": _quote("YES"),
        "EXTRA_PREC": _quote("YES"),
        "TIME_DIGITS": _quote("FRACSEC"),
        "TIME_TYPE": _quote("UT"),
    }
    if tlist_jd is not None:
        if not len(tlist_jd):
            raise ValueError("tlist_jd is empty")
        params["TLIST"] = _quote(" ".join(f"{float(t):.9f}" for t in tlist_jd))
        params["TLIST_TYPE"] = _quote("JD")
    else:
        if not (stop and step):
            raise ValueError("a time range needs start, stop and step")
        params |= {"START_TIME": _quote(start), "STOP_TIME": _quote(stop), "STEP_SIZE": _quote(step)}
    return params


def _cache_dir() -> Path:
    return config.CACHE_DIR / "horizons"


def cache_key(params: Mapping[str, str]) -> str:
    canon = json.dumps({"v": _CACHE_VERSION, **dict(sorted(params.items()))}, sort_keys=True)
    return hashlib.sha256(canon.encode()).hexdigest()[:32]


def _get(client: httpx.Client, params: Mapping[str, str], wait_s: float = 2.0) -> dict[str, Any]:
    """One reply, retrying transport errors and HTTP 429/5xx with exponential back-off."""
    last: Exception | None = None
    for attempt in range(ATTEMPTS):
        try:
            r = client.get(API_URL, params=dict(params))
        except httpx.TransportError as exc:
            last = exc
        else:
            if r.status_code not in _RETRY_STATUS:
                try:
                    payload = r.json()
                except ValueError as exc:
                    raise HorizonsError(f"reply is not JSON (HTTP {r.status_code})") from exc
                if r.status_code != 200 or "error" in payload:
                    raise HorizonsError(str(payload.get("error") or f"HTTP {r.status_code}")[:500])
                return payload
            last = HorizonsError(f"HTTP {r.status_code}")
        if attempt < ATTEMPTS - 1:
            time.sleep(wait_s * 2**attempt)
    raise HorizonsError(f"Horizons request failed after {ATTEMPTS} attempts: {last}") from last


def fetch(
    params: Mapping[str, str], *, use_cache: bool = True, client: httpx.Client | None = None
) -> dict[str, Any]:
    """The JSON reply ({'signature', 'result'}) for ``params``, from the disk cache when present."""
    path = _cache_dir() / f"{cache_key(params)}.json"
    if use_cache and path.exists():
        try:
            entry = json.loads(path.read_text(encoding="utf-8"))
            if entry.get("v") == _CACHE_VERSION and entry.get("params") == dict(params):
                return entry["response"]
        except (OSError, ValueError, KeyError):
            log.warning("ignoring unreadable Horizons cache entry %s", path.name)
    own = client is None
    http = client or httpx.Client(timeout=TIMEOUT_S, headers={"User-Agent": config.USER_AGENT})
    try:
        payload = _get(http, params)
    finally:
        if own:
            http.close()
    entry = {
        "v": _CACHE_VERSION,
        "params": dict(params),
        "fetched_utc": datetime.now(UTC).isoformat(timespec="seconds"),
        "response": payload,
    }
    if use_cache:
        write_atomic(path, json.dumps(entry).encode("utf-8"))
    return payload


# --- parsing --------------------------------------------------------------------------------------------


def _norm(name: str) -> str:
    return name.replace("_", "").replace(" ", "")


def _number(text: str) -> float:
    try:
        return float(text)
    except ValueError:
        return math.nan  # "n.a." and blanks


def parse_result(result: str, center: str = GEOCENTRE) -> Ephemeris:
    """Parse the text of a CSV OBSERVER table (between $$SOE and $$EOE) into an Ephemeris."""
    soe, eoe = result.find("$$SOE"), result.find("$$EOE")
    if soe < 0 or eoe < soe:
        tail = result.strip().splitlines()[-3:] if result.strip() else ["(empty reply)"]
        raise HorizonsError("no ephemeris table in the reply: " + " / ".join(t.strip() for t in tail)[:400])
    head = result[:soe].rstrip().splitlines()
    header_line = next((ln for ln in reversed(head) if "Date" in ln and "," in ln), None)
    if header_line is None:
        raise HorizonsError("no column header before $$SOE")
    names = [_norm(h) for h in header_line.split(",")]
    index = {_COLUMNS[n]: i for i, n in enumerate(names) if n in _COLUMNS}
    missing = [c for c in _REQUIRED if c not in index]
    if missing:
        raise HorizonsError(f"columns {missing} missing from the header {header_line.strip()!r}")
    rows = [ln.split(",") for ln in result[soe + 5 : eoe].strip().splitlines() if ln.strip()]
    if not rows:
        raise HorizonsError("the ephemeris table is empty")
    values = {
        key: np.array([_number(r[i].strip()) if i < len(r) else math.nan for r in rows], dtype=float)
        for key, i in index.items()
    }
    m = _SOURCE_RE.search(result)
    target, source = (m.group("name"), m.group("source").strip()) if m else ("", "")
    jd = values.pop("jd_utc")
    ra, dec = values.pop("ra_deg"), values.pop("dec_deg")
    return Ephemeris(
        target=target, source=source, center=center, mjd_utc=jd - MJD_TO_JD, ra_deg=ra, dec_deg=dec,
        columns=values,
    )


def _concat(tables: Sequence[Ephemeris]) -> Ephemeris:
    first = tables[0]
    mjd = np.concatenate([t.mjd_utc for t in tables])
    order = np.argsort(mjd, kind="stable")
    keys = set(first.columns).intersection(*(t.columns for t in tables[1:])) if len(tables) > 1 else set(
        first.columns
    )
    cols = {k: np.concatenate([t.columns[k] for t in tables])[order] for k in sorted(keys)}
    return Ephemeris(
        target=first.target, source=first.source, center=first.center, mjd_utc=mjd[order],
        ra_deg=np.concatenate([t.ra_deg for t in tables])[order],
        dec_deg=np.concatenate([t.dec_deg for t in tables])[order], columns=cols,
    )


# --- public queries -------------------------------------------------------------------------------------


def ephemeris(
    command: str,
    start: str,
    stop: str,
    step: str,
    *,
    center: str = GEOCENTRE,
    quantities: str = DEFAULT_QUANTITIES,
    use_cache: bool = True,
    client: httpx.Client | None = None,
) -> Ephemeris:
    """A table at regular steps, e.g. ``ephemeris('999', '2025-04-20', '2026-11-16', '6 h')``."""
    params = build_params(command, start=start, stop=stop, step=step, center=center, quantities=quantities)
    payload = fetch(params, use_cache=use_cache, client=client)
    return parse_result(payload.get("result", ""), center=center)


def ephemeris_at(
    command: str,
    mjd_utc: Iterable[float],
    *,
    center: str = GEOCENTRE,
    quantities: str = DEFAULT_QUANTITIES,
    use_cache: bool = True,
    client: httpx.Client | None = None,
) -> Ephemeris:
    """A table at the given times (MJD, UTC), in requests of at most TLIST_CHUNK times, sorted by time."""
    times = sorted({round(float(t), 9) for t in mjd_utc})
    if not times:
        raise ValueError("no times given")
    tables = []
    for i in range(0, len(times), TLIST_CHUNK):
        jd = [t + MJD_TO_JD for t in times[i : i + TLIST_CHUNK]]
        params = build_params(command, tlist_jd=jd, center=center, quantities=quantities)
        payload = fetch(params, use_cache=use_cache, client=client)
        tables.append(parse_result(payload.get("result", ""), center=center))
    return _concat(tables)


# --- geometry -------------------------------------------------------------------------------------------


def unit_vector(ra_deg: ArrayLike, dec_deg: ArrayLike) -> FloatArray:
    ra, dec = np.radians(np.asarray(ra_deg, dtype=float)), np.radians(np.asarray(dec_deg, dtype=float))
    return np.stack([np.cos(dec) * np.cos(ra), np.cos(dec) * np.sin(ra), np.sin(dec)], axis=-1)


def radec_of(vec: ArrayLike) -> tuple[FloatArray, FloatArray]:
    v = np.asarray(vec, dtype=float)
    ra = np.degrees(np.arctan2(v[..., 1], v[..., 0])) % 360.0
    dec = np.degrees(np.arctan2(v[..., 2], np.hypot(v[..., 0], v[..., 1])))
    return ra, dec


def _interp_radec(
    t: FloatArray, ra: FloatArray, dec: FloatArray, at: ArrayLike
) -> tuple[FloatArray, FloatArray]:
    at_arr = np.asarray(at, dtype=float)
    if t.size < 4:
        raise ValueError("interpolation needs at least 4 table rows")
    if np.any(at_arr < t[0]) or np.any(at_arr > t[-1]):
        raise ValueError(f"times outside the table span [{t[0]:.5f}, {t[-1]:.5f}]")
    vec = CubicSpline(t, unit_vector(ra, dec), axis=0)(at_arr)
    vec = vec / np.linalg.norm(vec, axis=-1, keepdims=True)
    return radec_of(vec)


def observer_offset(
    ra_deg: ArrayLike, dec_deg: ArrayLike, delta_au: ArrayLike, offset_km: ArrayLike
) -> tuple[FloatArray, FloatArray]:
    """Direction seen from an observer displaced by ``offset_km`` (geocentric, equatorial axes, [..., 3]).

    The body sits at delta_au along the geocentric direction (ra, dec); the observer at ``offset_km`` sees
    it along (delta * u - offset). Returns (ra, dec) in degrees.
    """
    u = unit_vector(ra_deg, dec_deg)
    d_km = np.asarray(delta_au, dtype=float)[..., None] * AU_KM
    return radec_of(d_km * u - np.asarray(offset_km, dtype=float))


def separation_arcsec(ra1: ArrayLike, dec1: ArrayLike, ra2: ArrayLike, dec2: ArrayLike) -> FloatArray:
    """Great-circle separation in arcsec (Vincenty formula, stable at small angles)."""
    a1, d1 = np.radians(np.asarray(ra1, dtype=float)), np.radians(np.asarray(dec1, dtype=float))
    a2, d2 = np.radians(np.asarray(ra2, dtype=float)), np.radians(np.asarray(dec2, dtype=float))
    da = a2 - a1
    num = np.hypot(np.cos(d2) * np.sin(da), np.cos(d1) * np.sin(d2) - np.sin(d1) * np.cos(d2) * np.cos(da))
    den = np.sin(d1) * np.sin(d2) + np.cos(d1) * np.cos(d2) * np.cos(da)
    return np.degrees(np.arctan2(num, den)) * 3600.0
