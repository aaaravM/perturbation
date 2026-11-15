"""Resolve a user's query (coordinates or an object name) to ICRS astrometry.

Order: (a) coordinates (``pxh.sky.coords.parse_coordinates``) -> resolver "coordinates"; (b) the curated
local table (``pxh.sky.targets``) -> "local-table"; (c) CDS Sesame through ``config.SESAME_MIRRORS`` ->
"sesame:<host>"; (d) SIMBAD TAP through ``config.SIMBAD_TAP_MIRRORS`` -> "simbad:<host>"; else
NameNotFoundError (ResolverUnavailableError when no mirror answered at all). Each request gets ~10 s and
2 retries on network errors and HTTP 5xx/429. A definitive "nothing found" ends a stage, since the
mirrors of a stage serve the same database. Network answers are cached as JSON in CACHE_DIR/resolve/.

Sesame and SIMBAD give ICRS positions at epoch J2000 that SIMBAD derives from the catalogue epoch (e.g.
Gaia DR3, 2016.0) by linear propagation. Resolved astrometry therefore carries no radial velocity, so
that ``pxh.sky.propagate`` reproduces SIMBAD's convention; perspective acceleration is ignored (64 mas
over 2016-2026 for Barnard's Star, under 10 mas for almost every other star). When the answer is one of
the curated targets, its local astrometry (and ``target_key``) is returned instead.
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
import os
import tempfile
import threading
import time
import xml.etree.ElementTree as ET
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlsplit

import httpx

from pxh import config
from pxh.models import Astrometry, ResolvedName
from pxh.sky.coords import format_dec_dms, format_ra_hms, parse_coordinates
from pxh.sky.targets import find_target

logger = logging.getLogger(__name__)

TIMEOUT_S = 10.0  # per request
CONNECT_TIMEOUT_S = 5.0
RETRIES = 2  # extra attempts per mirror after network errors or HTTP 5xx/429
RETRY_BACKOFF_S = (1.0, 2.0)
TOTAL_BUDGET_S = 60.0  # for all mirrors of one resolve() call
MAX_QUERY_LENGTH = 200
CACHE_SUBDIR = "resolve"
J2000 = 2000.0
_CACHE_FORMAT = 1
_SIMBAD_COLUMNS = ("main_id", "ra", "dec", "pmra", "pmdec", "plx_value")

_sleep = time.sleep  # tests replace this to skip back-off waits


class NameNotFoundError(LookupError):
    """No resolver knows the queried name."""


class ResolverUnavailableError(NameNotFoundError):
    """No name-resolver mirror gave a usable answer (network or server failures)."""


class _MirrorError(Exception):
    """One mirror gave no usable answer."""


@dataclass(frozen=True)
class _Hit:
    """Catalogue answer of Sesame or SIMBAD: ICRS position at epoch J2000 plus motion, if known."""

    main_id: str
    ra_deg: float
    dec_deg: float
    pmra_masyr: float | None = None
    pmdec_masyr: float | None = None
    parallax_mas: float | None = None


# --- HTTP ---------------------------------------------------------------------------------------

_client: httpx.Client | None = None
_client_lock = threading.Lock()


def _default_client() -> httpx.Client:
    global _client
    with _client_lock:
        if _client is None:
            _client = httpx.Client(
                timeout=httpx.Timeout(TIMEOUT_S, connect=CONNECT_TIMEOUT_S),
                headers={"User-Agent": config.USER_AGENT},
                follow_redirects=True,
            )
        return _client


def _host(url: str) -> str:
    return urlsplit(url).hostname or url


def _fetch(
    client: httpx.Client, method: str, url: str, *, deadline: float, data: dict[str, str] | None = None
) -> bytes:
    """Body of a 200 response, retrying network errors and HTTP 5xx/429; raises _MirrorError."""
    problem = ""
    for attempt in range(RETRIES + 1):
        if attempt:
            _sleep(RETRY_BACKOFF_S[min(attempt, len(RETRY_BACKOFF_S)) - 1])
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            problem = f"{problem}; time budget exhausted" if problem else "time budget exhausted"
            break
        timeout = httpx.Timeout(min(TIMEOUT_S, remaining), connect=min(CONNECT_TIMEOUT_S, remaining))
        try:
            response = client.request(
                method, url, data=data, timeout=timeout, headers={"User-Agent": config.USER_AGENT}
            )
        except httpx.TransportError as exc:
            problem = f"{type(exc).__name__}: {exc}"
            logger.info("%s %s: attempt %d failed: %s", method, _host(url), attempt + 1, problem)
            continue
        if response.status_code == 200:
            return response.content
        problem = f"HTTP {response.status_code}"
        logger.info("%s %s: attempt %d failed: %s", method, _host(url), attempt + 1, problem)
        if response.status_code < 500 and response.status_code != 429:
            break
    raise _MirrorError(problem)


# --- Sesame and SIMBAD TAP ----------------------------------------------------------------------


def _number(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value.strip() if isinstance(value, str) else value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _parse_sesame(content: bytes) -> _Hit | None:
    """Parse a Sesame '-oxp' XML reply: a hit, None for "nothing found", or _MirrorError."""
    try:
        root = ET.fromstring(content)
    except ET.ParseError as exc:
        raise _MirrorError(f"unparseable Sesame reply: {exc}") from exc
    target = root.find("Target")
    if root.tag != "Sesame" or target is None:
        raise _MirrorError("reply is not a Sesame document")
    for resolver in target.iter("Resolver"):
        ra, dec = _number(resolver.findtext("jradeg")), _number(resolver.findtext("jdedeg"))
        if ra is None or dec is None:
            continue
        main_id = (resolver.findtext("oname") or target.findtext("name") or "").strip()
        return _Hit(
            main_id=main_id,
            ra_deg=ra,
            dec_deg=dec,
            pmra_masyr=_number(resolver.findtext("pm/pmRA")),
            pmdec_masyr=_number(resolver.findtext("pm/pmDE")),
            parallax_mas=_number(resolver.findtext("plx/v")),
        )
    error = target.find(".//ERROR")
    if error is not None:
        raise _MirrorError(f"Sesame error: {(error.text or '').strip()}")
    return None


def simbad_adql(name: str) -> str:
    """ADQL that finds an object by any SIMBAD identifier (matching ignores case and spacing)."""
    literal = name.replace("'", "''")
    columns = ", ".join(f"basic.{c}" for c in _SIMBAD_COLUMNS)
    # No ORDER BY: SIMBAD TAP rejects a table-qualified ORDER BY column (HTTP 400).
    return (
        f"SELECT TOP 2 {columns} FROM basic JOIN ident ON ident.oidref = basic.oid "
        f"WHERE ident.id = '{literal}'"
    )


def _parse_simbad_json(content: bytes) -> _Hit | None:
    """Parse a SIMBAD TAP FORMAT=json reply: a hit, None for no rows, or _MirrorError."""
    try:
        doc = json.loads(content)
        names = [col["name"] for col in doc["metadata"]]
        rows = doc["data"]
    except (ValueError, KeyError, TypeError) as exc:
        raise _MirrorError(f"unexpected SIMBAD TAP reply: {exc}") from exc
    for row in rows:
        record = dict(zip(names, row, strict=False))
        ra, dec = _number(record.get("ra")), _number(record.get("dec"))
        if ra is None or dec is None:
            continue
        return _Hit(
            main_id=str(record.get("main_id") or "").strip(),
            ra_deg=ra,
            dec_deg=dec,
            pmra_masyr=_number(record.get("pmra")),
            pmdec_masyr=_number(record.get("pmdec")),
            parallax_mas=_number(record.get("plx_value")),
        )
    return None


def _ask(stage: str, client: httpx.Client, mirror: str, name: str, deadline: float) -> _Hit | None:
    if stage == "sesame":
        return _parse_sesame(_fetch(client, "GET", mirror + quote(name, safe=""), deadline=deadline))
    form = {"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "json", "QUERY": simbad_adql(name)}
    return _parse_simbad_json(_fetch(client, "POST", mirror, deadline=deadline, data=form))


def display_name(main_id: str) -> str:
    """Readable SIMBAD main identifier: "NAME Barnard's star" -> "Barnard's star", "M  31" -> "M 31"."""
    name = " ".join(main_id.split())
    for prefix in ("NAME ", "V* ", "** ", "* "):
        if name.startswith(prefix):
            return name[len(prefix) :]
    return name


def _to_resolved(query: str, hit: _Hit, resolver: str) -> ResolvedName:
    local = find_target(hit.main_id) if hit.main_id else None
    if local is not None:
        return ResolvedName(
            query=query, name=local.name, astrometry=local.astrometry, resolver=resolver, target_key=local.key
        )
    parallax = hit.parallax_mas if hit.parallax_mas is not None and hit.parallax_mas > 0 else None
    astrometry = Astrometry(
        ra_deg=hit.ra_deg,
        dec_deg=hit.dec_deg,
        ref_epoch=J2000,
        pmra_masyr=hit.pmra_masyr or 0.0,
        pmdec_masyr=hit.pmdec_masyr or 0.0,
        parallax_mas=parallax,
        rv_kms=None,
        source=f"SIMBAD {hit.main_id} via {resolver} (ICRS, epoch J2000, RV not applied)",
    )
    return ResolvedName(
        query=query, name=display_name(hit.main_id) or query, astrometry=astrometry, resolver=resolver
    )


def _query_one(stage: str, name: str, mirror: str, client: httpx.Client | None) -> ResolvedName | None:
    resolver = f"{stage}:{_host(mirror)}"
    try:
        hit = _ask(stage, client or _default_client(), mirror, name, time.monotonic() + TOTAL_BUDGET_S)
    except _MirrorError as exc:
        raise ResolverUnavailableError(f"{resolver}: {exc}") from exc
    return None if hit is None else _to_resolved(name, hit, resolver)


def query_sesame(
    name: str, mirror: str | None = None, *, client: httpx.Client | None = None
) -> ResolvedName | None:
    """Ask one Sesame mirror (default: the first in config). None if nothing is found.

    Raises ResolverUnavailableError if the mirror fails. No caching.
    """
    return _query_one("sesame", name, mirror or config.SESAME_MIRRORS[0], client)


def query_simbad_tap(
    name: str, mirror: str | None = None, *, client: httpx.Client | None = None
) -> ResolvedName | None:
    """Ask one SIMBAD TAP mirror (default: the first in config). None if nothing is found.

    Raises ResolverUnavailableError if the mirror fails. No caching.
    """
    return _query_one("simbad", name, mirror or config.SIMBAD_TAP_MIRRORS[0], client)


# --- cache --------------------------------------------------------------------------------------


def _cache_key(text: str) -> str:
    return " ".join(text.split()).casefold()


def _cache_path(key: str) -> Path:
    digest = hashlib.sha256(key.encode("utf-8")).hexdigest()[:32]
    return config.CACHE_DIR / CACHE_SUBDIR / f"{digest}.json"


def _cache_load(key: str) -> tuple[_Hit, str] | None:
    path = _cache_path(key)
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
        if doc.get("format") != _CACHE_FORMAT or doc.get("key") != key:
            return None
        return _Hit(**doc["hit"]), str(doc["resolver"])
    except FileNotFoundError:
        return None
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as exc:
        logger.warning("ignoring unreadable resolver cache file %s: %s", path, exc)
        return None


def _cache_store(key: str, hit: _Hit, resolver: str) -> None:
    path = _cache_path(key)
    doc = {
        "format": _CACHE_FORMAT,
        "key": key,
        "resolver": resolver,
        "hit": asdict(hit),
        "saved_utc": datetime.now(UTC).isoformat(timespec="seconds"),
    }
    tmp: str | None = None
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".tmp-", suffix=".json")
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(doc, fh, indent=1)
        os.replace(tmp, path)
        tmp = None
    except OSError as exc:
        logger.warning("could not write resolver cache file %s: %s", path, exc)
    finally:
        if tmp is not None:
            Path(tmp).unlink(missing_ok=True)


# --- public entry point -------------------------------------------------------------------------


def _from_coordinates(query: str, ra_deg: float, dec_deg: float) -> ResolvedName:
    astrometry = Astrometry(ra_deg=ra_deg, dec_deg=dec_deg, ref_epoch=J2000, source="coordinates (ICRS)")
    name = f"{format_ra_hms(ra_deg)} {format_dec_dms(dec_deg)}"
    return ResolvedName(query=query, name=name, astrometry=astrometry, resolver="coordinates")


def _resolve_remote(query: str, text: str, client: httpx.Client, use_cache: bool) -> ResolvedName:
    key = _cache_key(text)
    if use_cache and (cached := _cache_load(key)) is not None:
        logger.debug("resolved %r from cache (%s)", text, cached[1])
        return _to_resolved(query, cached[0], cached[1])
    deadline = time.monotonic() + TOTAL_BUDGET_S
    failures: list[str] = []
    answered = False
    for stage, mirrors in (("sesame", config.SESAME_MIRRORS), ("simbad", config.SIMBAD_TAP_MIRRORS)):
        for mirror in mirrors:
            resolver = f"{stage}:{_host(mirror)}"
            try:
                hit = _ask(stage, client, mirror, text, deadline)
            except _MirrorError as exc:
                failures.append(f"{resolver}: {exc}")
                logger.warning("name resolver %s failed for %r: %s", resolver, text, exc)
                continue
            answered = True
            if hit is None:
                break  # definitive "nothing found": this stage's other mirrors share the database
            if use_cache:
                _cache_store(key, hit, resolver)
            return _to_resolved(query, hit, resolver)
    if answered:
        raise NameNotFoundError(f"no object named {text!r} is known to Sesame or SIMBAD")
    raise ResolverUnavailableError(f"no name resolver could be reached for {text!r}: " + "; ".join(failures))


def resolve(query: str, *, client: httpx.Client | None = None, use_cache: bool = True) -> ResolvedName:
    """Resolve coordinates or an object name to ICRS astrometry (see the module docstring for the order).

    Raises ValueError for an empty or over-long query, and for coordinate-like text that is malformed or
    out of range (when it contains letters, name lookups are tried first, e.g. "1H 0323+342").
    Raises NameNotFoundError if no resolver knows the name, ResolverUnavailableError (a subclass) if no
    resolver could be reached.
    """
    text = " ".join(query.split())
    if not text:
        raise ValueError("empty query")
    if len(text) > MAX_QUERY_LENGTH:
        raise ValueError(f"query longer than {MAX_QUERY_LENGTH} characters")
    coord_error: ValueError | None = None
    try:
        coords = parse_coordinates(text)
    except ValueError as exc:
        coords, coord_error = None, exc
    if coords is not None:
        return _from_coordinates(query, *coords)
    target = find_target(text)
    if target is not None:
        return ResolvedName(
            query=query,
            name=target.name,
            astrometry=target.astrometry,
            resolver="local-table",
            target_key=target.key,
        )
    if coord_error is not None and not any(ch.isalpha() for ch in text):
        raise coord_error
    try:
        return _resolve_remote(query, text, client or _default_client(), use_cache)
    except NameNotFoundError:
        if coord_error is not None:
            raise coord_error from None
        raise
