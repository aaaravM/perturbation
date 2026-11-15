"""SPHEREx image discovery at IRSA: run-time collection discovery and position search via SIA v2.

Public API
- ``discover_collections()``: current ``spherex_*`` collection names, discovered at run time.
- ``discover_l2_collections()``: the Level-2 image collections (calib_level 2, dataproduct_type image),
  wide and deep; cube and calibration collections are excluded.
- ``query_position()``: every Level-2 detector image covering a sky position, as ``DetectorImage`` rows.
- ``search_position()``: the same search with per-collection provenance (network / cache / stale / failed).
- ``parse_response()``, ``rows_to_images()``, ``parse_file_tag()``, ``parse_s3_key()``: offline helpers.

How discovery works (verified live 2026-11-14)
- Every IRSA SIA response starts with a self-description whose COLLECTION parameter lists all searchable
  collections. A query with ``FACILITY=SPHEREx&CLOSEST=collection`` at the north ecliptic pole (the SPHEREx
  deep field, observed every orbit, so every survey collection covers it) returns that list plus exactly
  one row per SPHEREx collection, carrying ``calib_level`` and ``dataproduct_type``. One ~38 KB request
  therefore gives both the names and their classification. The south pole and a wide-survey position are
  tried next for collections that are still unclassified, and a plain ``MAXREC=0`` self-description query
  is the last network method. The result is cached for 24 h; stale entries are served when IRSA fails,
  and ``config.FALLBACK_*`` are used only when there is nothing else.

Request policy (IRSA SIA answered HTTP 502 on ~50% of attempts today, quickly)
- Up to ``config.RETRY_ATTEMPTS`` attempts with exponential back-off (2, 4, 8, 16 s, capped at 16 s) plus up
  to 1 s of jitter. Retried: HTTP 5xx/408/429, timeouts, connection errors, non-VOTable or unparseable bodies.
  Not retried: other HTTP 4xx and ``QUERY_STATUS=ERROR`` (the query itself is wrong).
- A circuit breaker opens after 12 consecutive failed attempts (across threads) and fails fast for 60 s.
- At most ``config.IRSA_MAX_CONCURRENCY`` requests in flight per process (``IRSA_SLOTS``; other IRSA clients
  may share it). The SIA TIME parameter is never sent (IRSA answers it with 502).
- One SIA request per collection, run concurrently. (IRSA also accepts repeated COLLECTION values in one
  request, verified: 239 + 119 = 358 rows at Barnard's Star, but separate requests keep MAXREC truncation,
  caching and retries per collection.)

Cache layout under ``config.CACHE_DIR / "sia"``
- ``collections.json``: discovered names and their classification.
- ``query/<collection>/<ra>_<dec>_r<radius>_m<maxrec>_b<band>.json``: parsed ``DetectorImage`` rows, and
  ``.xml.gz`` next to it: the raw VOTable, re-parsed without network if the JSON is unreadable or outdated.
"""

from __future__ import annotations

import gzip
import io
import json
import logging
import math
import os
import re
import threading
import time
import zlib
from collections import Counter
from collections.abc import Callable, Iterable, Iterator, Mapping, Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass, field, replace
from pathlib import Path
from typing import Any, NamedTuple
from urllib.parse import urlsplit

import httpx
from astropy.io.votable import parse as _parse_votable
from astropy.io.votable.tree import Group, Param
from tenacity import RetryCallState, Retrying, retry_if_exception_type, stop_after_attempt
from tenacity.wait import wait_base, wait_exponential, wait_random

from pxh import config
from pxh.models import DetectorImage

__all__ = [
    "IRSA_SLOTS",
    "CircuitBreaker",
    "CollectionCatalog",
    "CollectionInfo",
    "CollectionSearch",
    "Level2Name",
    "SiaError",
    "SiaQueryError",
    "SiaResponse",
    "SiaService",
    "SiaTransientError",
    "SiaUnavailable",
    "build_query_params",
    "collection_catalog",
    "dedupe_images",
    "default_service",
    "discover_collections",
    "discover_l2_collections",
    "is_deep_collection",
    "parse_detector",
    "parse_file_tag",
    "parse_level2_basename",
    "parse_response",
    "parse_s3_key",
    "query_position",
    "row_to_image",
    "rows_to_images",
    "search_position",
    "sia_stats",
]

log = logging.getLogger(__name__)

DEFAULT_RADIUS_DEG = 0.0005
DEFAULT_MAXREC = 20000
MAX_RADIUS_DEG = 10.0
COORD_DECIMALS = 5  # queries and cache keys use positions rounded to 1e-5 deg (0.036 arcsec)

# Sentinel positions for discovery: the SPHEREx deep fields at the ecliptic poles (observed every orbit, so
# every survey collection, wide or deep, covers them) and one wide-survey position (Barnard's Star).
SENTINELS: tuple[tuple[str, float, float], ...] = (
    ("NEP", 270.0, 66.560708),
    ("SEP", 90.0, -66.560708),
    ("Barnard", 269.4464, 4.7682),
)
SENTINEL_RADIUS_DEG = 0.0005
DISCOVERY_RETRY_AFTER_S = 300.0  # after a failed refresh, serve stale/fallback for this long without retrying

BREAKER_THRESHOLD = 12  # consecutive failed attempts (P ~ 2e-4 at today's 50% 502 rate)
BREAKER_COOLDOWN_S = 60.0

_CACHE_VERSION = 1
_RETRY_STATUS = frozenset({408, 429, 500, 502, 503, 504})
_STATUS_RANK = {"OK": 0, "OVERFLOW": 1, "ERROR": 2}
_COLLECTION_NAME_RE = re.compile(r"^[A-Za-z0-9_.\-]+$")
_L2_NAME_RE = re.compile(r"^spherex_(?:dr|qr)\d+(?:_deep)?$")  # degraded-mode guess only
_DETECTOR_RE = re.compile(r"^SPHEREx-D([1-6])$", re.IGNORECASE)
_L2_BASENAME_RE = re.compile(r"^level2_(?P<obs_id>.+)D(?P<det>[1-6])_spx_(?P<tag>.+?)\.fits(?:\.gz)?$")
_SPX_TAG_RE = re.compile(r"_spx_(?P<tag>.+?)(?:\.fits)?(?:\.gz)?$")

# ObsCore columns kept from each SIA row (the response has 51).
_COLUMNS = (
    "obs_id",
    "obs_collection",
    "obs_publisher_did",
    "energy_bandpassname",
    "access_url",
    "access_estsize",
    "t_min",
    "t_max",
    "em_min",
    "em_max",
    "t_exptime",
    "s_region",
    "obs_release_date",
    "cloud_access",
    "calib_level",
    "dataproduct_type",
    "dataproduct_subtype",
    "target_name",
)


# --- Errors ---------------------------------------------------------------------------------------


class SiaError(RuntimeError):
    """Base class for IRSA SIA failures."""


class SiaTransientError(SiaError):
    """One attempt failed in a way worth retrying (5xx, timeout, connection error, non-VOTable body)."""


class SiaUnavailable(SiaError):
    """IRSA SIA could not be reached: retries exhausted or the circuit breaker is open."""


class SiaQueryError(SiaError):
    """IRSA rejected the query (HTTP 4xx or QUERY_STATUS=ERROR); retrying will not help."""


# --- Circuit breaker ------------------------------------------------------------------------------


class CircuitBreaker:
    """Fail fast after ``threshold`` consecutive failed attempts; allow trial attempts after ``cooldown_s``.

    States: "closed" (normal), "open" (attempts refused), "half-open" (cool-down elapsed: attempts allowed;
    the next failure re-opens the breaker, the next success closes it). Thread-safe.
    """

    def __init__(
        self,
        threshold: int = BREAKER_THRESHOLD,
        cooldown_s: float = BREAKER_COOLDOWN_S,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if threshold < 1:
            raise ValueError("threshold must be >= 1")
        self.threshold = threshold
        self.cooldown_s = cooldown_s
        self._clock = clock
        self._lock = threading.Lock()
        self._failures = 0
        self._opened_at: float | None = None

    @property
    def state(self) -> str:
        with self._lock:
            return self._state_locked()

    def _state_locked(self) -> str:
        if self._opened_at is None:
            return "closed"
        if self._clock() - self._opened_at >= self.cooldown_s:
            return "half-open"
        return "open"

    def allow(self) -> bool:
        """True unless the breaker is open."""
        with self._lock:
            return self._state_locked() != "open"

    def record_success(self) -> None:
        with self._lock:
            self._failures = 0
            self._opened_at = None

    def record_failure(self) -> bool:
        """Count one failed attempt; return True if this failure opened (or re-opened) the breaker."""
        with self._lock:
            self._failures += 1
            if self._failures >= self.threshold and self._state_locked() != "open":
                self._opened_at = self._clock()
                return True
            return False


# --- HTTP service ---------------------------------------------------------------------------------

# Process-wide cap on concurrent IRSA requests. Other IRSA clients (e.g. the IBE byte-range reader) may
# acquire it too so the whole process stays within config.IRSA_MAX_CONCURRENCY.
IRSA_SLOTS = threading.BoundedSemaphore(config.IRSA_MAX_CONCURRENCY)

_HTTP_LOCK = threading.Lock()
_HTTP_CLIENT: httpx.Client | None = None
_SERVICE_LOCK = threading.Lock()
_DEFAULT_SERVICE: SiaService | None = None


def _http_client() -> httpx.Client:
    global _HTTP_CLIENT
    with _HTTP_LOCK:
        if _HTTP_CLIENT is None:
            _HTTP_CLIENT = httpx.Client(
                timeout=httpx.Timeout(config.HTTP_TIMEOUT_S, connect=20.0),
                headers={"User-Agent": config.USER_AGENT},
                follow_redirects=True,
                limits=httpx.Limits(
                    max_connections=2 * config.IRSA_MAX_CONCURRENCY,
                    max_keepalive_connections=config.IRSA_MAX_CONCURRENCY,
                ),
            )
        return _HTTP_CLIENT


def _default_wait() -> wait_base:
    return wait_exponential(
        multiplier=config.RETRY_WAIT_INITIAL_S, min=config.RETRY_WAIT_INITIAL_S, max=config.RETRY_WAIT_MAX_S
    ) + wait_random(0.0, 1.0)


@dataclass(frozen=True)
class SiaResponse:
    """A parsed SIA VOTable: selected ObsCore columns per row, query status and the self-description."""

    rows: list[dict[str, Any]]
    query_status: str  # "OK" | "OVERFLOW" (MAXREC reached) | "" (absent)
    status_message: str
    collections_offered: tuple[str, ...]  # every COLLECTION option in the self-description (all missions)
    content: bytes = field(repr=False, default=b"")

    @property
    def truncated(self) -> bool:
        return self.query_status == "OVERFLOW"


class SiaService:
    """Thread-safe IRSA SIA v2 client: retries, circuit breaker, concurrency cap and request counters."""

    def __init__(
        self,
        url: str = config.IRSA_SIA_URL,
        *,
        client: httpx.Client | None = None,
        attempts: int = config.RETRY_ATTEMPTS,
        wait: wait_base | None = None,
        breaker: CircuitBreaker | None = None,
        slots: threading.Semaphore | None = None,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self.url = url
        self.attempts = attempts
        self.breaker = breaker if breaker is not None else CircuitBreaker()
        self._client = client
        self._wait = wait if wait is not None else _default_wait()
        self._slots = slots if slots is not None else IRSA_SLOTS
        self._sleep = sleep
        self._lock = threading.Lock()
        self._counts: Counter[str] = Counter()

    def stats(self) -> dict[str, int]:
        """Counters: requests, attempts, retries, failures, http_<status>, timeout, transport, ..."""
        with self._lock:
            return dict(self._counts)

    def reset_stats(self) -> None:
        with self._lock:
            self._counts.clear()

    def fetch(self, params: Sequence[tuple[str, str]], *, label: str = "") -> SiaResponse:
        """GET the SIA endpoint with ``params`` and return the parsed VOTable.

        Raises SiaUnavailable when every attempt failed or the breaker is open, and SiaQueryError when IRSA
        rejects the query.
        """
        if any(key.upper() == "TIME" for key, _ in params):
            raise ValueError("the SIA TIME parameter is not supported by IRSA today (always HTTP 502)")
        self._count("requests")
        retrying = Retrying(
            stop=stop_after_attempt(self.attempts),
            wait=self._wait,
            retry=retry_if_exception_type(SiaTransientError),
            sleep=self._sleep,
            before_sleep=self._before_sleep(label),
            reraise=True,
        )
        try:
            return retrying(self._attempt, list(params), label)
        except SiaTransientError as exc:
            self._count("failures")
            raise SiaUnavailable(f"IRSA SIA failed {self.attempts} times ({label or 'query'}): {exc}") from exc
        except SiaError:
            self._count("failures")
            raise

    def _attempt(self, params: list[tuple[str, str]], label: str) -> SiaResponse:
        if not self.breaker.allow():
            self._count("circuit_rejected")
            raise SiaUnavailable("IRSA SIA circuit breaker is open after repeated failures; try again later")
        self._count("attempts")
        t0 = time.monotonic()
        try:
            with self._slots:
                response = (self._client or _http_client()).get(self.url, params=params)
        except httpx.TimeoutException as exc:
            self._fail("timeout")
            raise SiaTransientError(f"timeout: {exc!r}") from exc
        except httpx.RequestError as exc:
            self._fail("transport")
            raise SiaTransientError(f"transport error: {exc!r}") from exc
        elapsed = time.monotonic() - t0
        status = response.status_code
        self._count(f"http_{status}")
        if status in _RETRY_STATUS or status >= 500:
            self._fail()
            raise SiaTransientError(f"HTTP {status}")
        if status >= 400:
            self.breaker.record_success()  # the service answered; the request is at fault
            raise SiaQueryError(f"HTTP {status}: {response.text[:300]!r}")
        content = response.content
        if not _looks_like_votable(content):
            self._fail("not_votable")
            raise SiaTransientError(f"HTTP {status} body is not a VOTable ({len(content)} B): {content[:120]!r}")
        try:
            parsed = parse_response(content)
        except SiaQueryError:
            self.breaker.record_success()
            raise
        except Exception as exc:  # truncated or malformed XML: retry
            self._fail("bad_votable")
            raise SiaTransientError(f"unparseable VOTable ({len(content)} B): {exc}") from exc
        self.breaker.record_success()
        log.debug(
            "SIA %s: HTTP %d, %d B, %d rows, %s, %.2f s",
            label, status, len(content), len(parsed.rows), parsed.query_status or "-", elapsed,
        )
        return parsed

    def _fail(self, kind: str | None = None) -> None:
        if kind:
            self._count(kind)
        if self.breaker.record_failure():
            self._count("circuit_opened")
            log.warning(
                "IRSA SIA circuit breaker opened after %d consecutive failures; failing fast for %.0f s",
                self.breaker.threshold, self.breaker.cooldown_s,
            )

    def _before_sleep(self, label: str) -> Callable[[RetryCallState], None]:
        def hook(state: RetryCallState) -> None:
            self._count("retries")
            exc = state.outcome.exception() if state.outcome else None
            delay = state.next_action.sleep if state.next_action else 0.0
            log.info("SIA %s: attempt %d failed (%s); retrying in %.1f s", label, state.attempt_number, exc, delay)

        return hook

    def _count(self, key: str, n: int = 1) -> None:
        with self._lock:
            self._counts[key] += n


def default_service() -> SiaService:
    """The process-wide SiaService (shared HTTP client, breaker and counters)."""
    global _DEFAULT_SERVICE
    with _SERVICE_LOCK:
        if _DEFAULT_SERVICE is None:
            _DEFAULT_SERVICE = SiaService()
        return _DEFAULT_SERVICE


def sia_stats() -> dict[str, int]:
    """Request counters of the default service (e.g. http_502, retries, failures)."""
    return default_service().stats()


# --- VOTable parsing ------------------------------------------------------------------------------


def _looks_like_votable(content: bytes) -> bool:
    return b"<votable" in content[:4096].lower()


def parse_response(content: bytes) -> SiaResponse:
    """Parse SIA VOTable bytes. Raises SiaQueryError on QUERY_STATUS=ERROR, ValueError if not a VOTable."""
    if not _looks_like_votable(content):
        raise ValueError(f"not a VOTable ({len(content)} B): {content[:120]!r}")
    votable = _parse_votable(io.BytesIO(content), verify="ignore")
    status, message = _query_status(votable)
    if status == "ERROR":
        raise SiaQueryError(f"SIA QUERY_STATUS=ERROR: {message or 'no message'}")
    return SiaResponse(
        rows=_table_rows(votable),
        query_status=status,
        status_message=message,
        collections_offered=_collection_options(votable),
        content=content,
    )


def _query_status(votable: Any) -> tuple[str, str]:
    status, message = "", ""
    for info in votable.iter_info():
        if (info.name or "").upper() != "QUERY_STATUS":
            continue
        value = str(info.value or "").upper()
        if _STATUS_RANK.get(value, 0) >= _STATUS_RANK.get(status, -1):
            status, message = value, str(info.content or "").strip()
    return status, message


def _iter_params(element: Any) -> Iterator[Param]:
    yield from getattr(element, "params", [])
    for group in getattr(element, "groups", []):
        yield from _iter_group_params(group)


def _iter_group_params(group: Group) -> Iterator[Param]:
    for entry in group.entries:
        if isinstance(entry, Param):
            yield entry
        elif isinstance(entry, Group):
            yield from _iter_group_params(entry)


def _collection_options(votable: Any) -> tuple[str, ...]:
    """COLLECTION option values from the service self-description (RESOURCE type="meta")."""
    for resource in votable.resources:
        if resource.type != "meta":
            continue
        for param in _iter_params(resource):
            if (param.name or "").upper() == "COLLECTION" and param.values is not None:
                return tuple(str(value) for _, value in param.values.options if value)
    return ()


def _results_table(votable: Any) -> Any | None:
    for resource in votable.resources:
        if resource.type == "results" and resource.tables:
            return resource.tables[0]
    try:
        return votable.get_first_table()
    except IndexError:
        return None


def _table_rows(votable: Any) -> list[dict[str, Any]]:
    table = _results_table(votable)
    if table is None:
        return []
    data = table.to_table(use_names_over_ids=True)
    if len(data) == 0:
        return []
    names = [name for name in _COLUMNS if name in data.colnames]
    columns = [[_plain(v) for v in data[name].tolist()] for name in names]
    return [dict(zip(names, values, strict=True)) for values in zip(*columns, strict=True)]


def _plain(value: Any) -> Any:
    if isinstance(value, bytes):
        return value.decode("utf-8", "replace")
    return value


# --- Row mapping ----------------------------------------------------------------------------------


class Level2Name(NamedTuple):
    """Fields encoded in a Level-2 file name: level2_<obs_id>D<detector>_spx_<tag>.fits."""

    obs_id: str
    detector: int
    tag: str


def _basename(url_or_name: str) -> str:
    path = urlsplit(url_or_name).path if "://" in url_or_name else url_or_name.split("?", 1)[0]
    return path.rstrip("/").rsplit("/", 1)[-1]


def parse_level2_basename(url_or_name: str) -> Level2Name | None:
    """Parse e.g. 'level2_2025W20_2D_0243_1D6_spx_l2b_retry-v27-2026-230.fits'; None if not that pattern."""
    match = _L2_BASENAME_RE.match(_basename(url_or_name))
    if match is None:
        return None
    return Level2Name(match["obs_id"], int(match["det"]), match["tag"])


def parse_file_tag(url_or_name: str) -> str:
    """Processing tag of a Level-2 file, e.g. 'l2b-v27-2026-228' or 'l2b_retry-v27-2026-230'; '' if none."""
    parsed = parse_level2_basename(url_or_name)
    if parsed is not None:
        return parsed.tag
    name = _basename(url_or_name)
    match = _SPX_TAG_RE.search(name)
    if match is not None:
        return match["tag"]
    log.warning("unrecognised SPHEREx file name %r: no processing tag", name)
    return ""


def parse_detector(bandpass: str | None) -> int | None:
    """Detector number from an energy_bandpassname such as 'SPHEREx-D6'; None for cubes ('SPHEREx')."""
    match = _DETECTOR_RE.match((bandpass or "").strip())
    return int(match.group(1)) if match else None


def parse_s3_key(cloud_access: str | None) -> str | None:
    """Object key from a cloud_access JSON value {"aws": {"bucket_name", "key", "region"}}, if usable."""
    if not cloud_access:
        return None
    try:
        payload = json.loads(cloud_access)
    except (TypeError, ValueError):
        log.debug("unparseable cloud_access %r", cloud_access[:200])
        return None
    aws = payload.get("aws") if isinstance(payload, dict) else None
    if not isinstance(aws, dict):
        return None
    key, bucket = aws.get("key"), aws.get("bucket_name")
    if not isinstance(key, str) or not key.strip():
        return None
    if bucket and f"//{bucket}." not in config.SPHEREX_S3_PREFIX:
        log.warning("cloud_access names bucket %r, not the configured SPHEREx mirror; ignoring its key", bucket)
        return None
    return key.strip().lstrip("/")


def is_deep_collection(name: str) -> bool:
    """True for the deep-field (ecliptic pole) collections, e.g. 'spherex_dr1_deep'."""
    return name.endswith("_deep")


def _str(value: Any) -> str:
    return "" if value is None else str(value).strip()


def _float(value: Any) -> float | None:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    return out if math.isfinite(out) else None


def _int(value: Any) -> int | None:
    number = _float(value)
    return None if number is None else int(number)


def _iso_timestamp(value: Any) -> str:
    text = _str(value)
    if len(text) >= 19 and text[10] == " ":
        text = f"{text[:10]}T{text[11:]}"
    return text


def row_to_image(row: Mapping[str, Any], collection: str | None = None) -> DetectorImage | None:
    """Map one ObsCore row to a DetectorImage; None for rows that are not Level-2 detector images.

    Raises ValueError when a Level-2 row lacks a required value (access_url, obs_id, t_min).
    """
    dptype = _str(row.get("dataproduct_type")).lower()
    calib = _int(row.get("calib_level"))
    if (dptype and dptype != "image") or (calib is not None and calib != 2):
        return None
    access_url = _str(row.get("access_url"))
    if not access_url:
        raise ValueError("row has no access_url")
    name = parse_level2_basename(access_url)
    detector = parse_detector(_str(row.get("energy_bandpassname")))
    if detector is None:
        if name is None:
            return None
        detector = name.detector
    obs_id = _str(row.get("obs_id")) or (name.obs_id if name else "")
    if not obs_id:
        raise ValueError(f"row has no obs_id ({access_url})")
    if name is not None and (name.obs_id != obs_id or name.detector != detector):
        log.warning("file name %s disagrees with obs_id %s / D%d", _basename(access_url), obs_id, detector)
    coll = _str(row.get("obs_collection")) or (collection or "")
    t_min = _float(row.get("t_min"))
    if t_min is None:
        raise ValueError(f"row has no t_min ({access_url})")
    t_max = _float(row.get("t_max"))
    em_min, em_max = _float(row.get("em_min")), _float(row.get("em_max"))
    if em_min is None or em_max is None:
        log.warning("row %s/D%d has no em_min/em_max; using nominal detector band", obs_id, detector)
        em_min_um, em_max_um = config.DETECTOR_BANDS_UM[detector]
    else:
        em_min_um, em_max_um = round(em_min * 1e6, 7), round(em_max * 1e6, 7)
    exptime = _float(row.get("t_exptime"))
    return DetectorImage(
        obs_id=obs_id,
        detector=detector,
        collection=coll,
        publisher_did=_str(row.get("obs_publisher_did")) or f"ivo://irsa.ipac/{coll}?{obs_id}/D{detector}",
        access_url=access_url,
        t_min_mjd=t_min,
        t_max_mjd=t_max if t_max is not None else t_min + config.EXPTIME_S / 86400.0,
        em_min_um=em_min_um,
        em_max_um=em_max_um,
        exptime_s=exptime if exptime is not None else config.EXPTIME_S,
        s_region=_str(row.get("s_region")),
        release_date=_iso_timestamp(row.get("obs_release_date")),
        file_tag=name.tag if name is not None else parse_file_tag(access_url),
        est_size_kb=_int(row.get("access_estsize")),
        s3_key=parse_s3_key(_str(row.get("cloud_access")) or None),
    )


def rows_to_images(rows: Iterable[Mapping[str, Any]], collection: str | None = None) -> list[DetectorImage]:
    """Map SIA rows to DetectorImages, skipping rows that are not Level-2 detector images."""
    images: list[DetectorImage] = []
    skipped: Counter[str] = Counter()
    for row in rows:
        try:
            image = row_to_image(row, collection)
        except ValueError as exc:
            log.warning("skipping SIA row: %s", exc)
            skipped["incomplete"] += 1
            continue
        if image is None:
            skipped[f"{_str(row.get('obs_collection')) or '?'}:{_str(row.get('dataproduct_type')) or '?'}"] += 1
            continue
        images.append(image)
    if skipped:
        log.debug("skipped non-Level-2 or incomplete SIA rows: %s", dict(skipped))
    return images


def dedupe_images(images: Iterable[DetectorImage]) -> list[DetectorImage]:
    """Drop repeated rows (same publisher_did), keeping the first occurrence."""
    seen: set[str] = set()
    out: list[DetectorImage] = []
    for image in images:
        key = image.publisher_did or image.cache_key
        if key not in seen:
            seen.add(key)
            out.append(image)
    return out


# --- Disk cache helpers ---------------------------------------------------------------------------

_KEY_LOCKS = tuple(threading.Lock() for _ in range(64))


def _key_lock(key: str) -> threading.Lock:
    return _KEY_LOCKS[zlib.crc32(key.encode()) % len(_KEY_LOCKS)]


def _cache_root() -> Path:
    return Path(config.CACHE_DIR) / "sia"


def _is_fresh(fetched_at: float | None) -> bool:
    return fetched_at is not None and time.time() - fetched_at < config.SIA_CACHE_TTL_S


def _atomic_write(path: Path, data: bytes) -> None:
    """Write via a temporary file and os.replace; cache write failures are logged, not raised."""
    tmp = path.with_name(f".{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp.write_bytes(data)
        os.replace(tmp, path)
    except OSError as exc:
        log.warning("could not write cache file %s: %s", path, exc)
        tmp.unlink(missing_ok=True)


def _read_json(path: Path) -> dict[str, Any] | None:
    try:
        payload = json.loads(path.read_bytes())
    except FileNotFoundError:
        return None
    except (OSError, ValueError) as exc:
        log.warning("ignoring unreadable cache file %s: %s", path, exc)
        return None
    return payload if isinstance(payload, dict) else None


# --- Collection discovery -------------------------------------------------------------------------


@dataclass(frozen=True)
class CollectionInfo:
    """A SPHEREx collection and the product type its SIA rows carry (None when no row was seen)."""

    name: str
    dataproduct_type: str | None = None
    calib_level: int | None = None

    @property
    def is_level2_image(self) -> bool:
        return self.dataproduct_type == "image" and self.calib_level == 2

    @property
    def is_deep(self) -> bool:
        return is_deep_collection(self.name)


@dataclass(frozen=True)
class CollectionCatalog:
    """Discovered SPHEREx collections. source: "network" | "cache" | "stale-cache" | "fallback"."""

    collections: tuple[CollectionInfo, ...]
    fetched_at: float | None
    source: str
    methods: tuple[str, ...] = ()

    @property
    def names(self) -> list[str]:
        return [c.name for c in self.collections]


_CATALOG_LOCK = threading.Lock()
_DISCOVERY_FAILED_AT: dict[str, float] = {}  # catalog path -> time.monotonic() of the last failed refresh


def _catalog_path() -> Path:
    return _cache_root() / "collections.json"


def _sentinel_params(ra: float, dec: float) -> list[tuple[str, str]]:
    return [
        ("POS", f"CIRCLE {ra} {dec} {SENTINEL_RADIUS_DEG}"),
        ("FACILITY", "SPHEREx"),
        ("CLOSEST", "collection"),
        ("MAXREC", "200"),  # safety cap in case CLOSEST is ever ignored (the NEP has ~30k rows)
    ]


def _spherex_names(names: Iterable[str]) -> set[str]:
    prefix = config.SPHEREX_COLLECTION_PREFIX
    return {name for name in names if name.startswith(prefix) and _COLLECTION_NAME_RE.match(name)}


def _refresh_catalog(service: SiaService) -> CollectionCatalog:
    names: set[str] = set()
    profiles: dict[str, tuple[str | None, int | None]] = {}
    methods: list[str] = []
    errors: list[str] = []
    for label, ra, dec in SENTINELS:
        try:
            response = service.fetch(_sentinel_params(ra, dec), label=f"discovery@{label}")
        except SiaError as exc:
            errors.append(f"{label}: {exc}")
            continue
        offered = _spherex_names(response.collections_offered)
        if offered:
            names |= offered
            methods.append("self-description")
        for row in response.rows:
            name = _str(row.get("obs_collection"))
            if not _spherex_names([name]):
                continue
            names.add(name)
            profiles.setdefault(name, (_str(row.get("dataproduct_type")).lower() or None, _int(row.get("calib_level"))))
        methods.append(f"closest@{label}")
        if names and names.issubset(profiles):
            break
    if not names:
        try:
            response = service.fetch([("MAXREC", "0")], label="discovery self-description")
            names = _spherex_names(response.collections_offered)
            methods.append("self-description")
        except SiaError as exc:
            errors.append(f"self-description: {exc}")
    if not names:
        raise SiaUnavailable("SPHEREx collection discovery failed: " + ("; ".join(errors) or "no collections"))
    unclassified = sorted(names - profiles.keys())
    if unclassified:
        log.info("SPHEREx collections without SIA rows at the sentinels (not searchable as L2): %s", unclassified)
    infos = tuple(CollectionInfo(name, *profiles.get(name, (None, None))) for name in sorted(names))
    return CollectionCatalog(infos, time.time(), "network", tuple(dict.fromkeys(methods)))


def _load_catalog(path: Path) -> CollectionCatalog | None:
    payload = _read_json(path)
    if not payload or payload.get("version") != _CACHE_VERSION:
        return None
    try:
        infos = tuple(
            CollectionInfo(str(c["name"]), c.get("dataproduct_type"), c.get("calib_level"))
            for c in payload["collections"]
        )
        fetched_at = float(payload["fetched_at"])
    except (KeyError, TypeError, ValueError) as exc:
        log.warning("ignoring malformed collection cache %s: %s", path, exc)
        return None
    return CollectionCatalog(infos, fetched_at, "cache", tuple(payload.get("methods", ())))


def _save_catalog(path: Path, catalog: CollectionCatalog) -> None:
    payload = {
        "version": _CACHE_VERSION,
        "fetched_at": catalog.fetched_at,
        "methods": list(catalog.methods),
        "collections": [asdict(c) for c in catalog.collections],
    }
    _atomic_write(path, json.dumps(payload, indent=1).encode())


def _fallback_catalog() -> CollectionCatalog:
    infos = [CollectionInfo(name, "image", 2) for name in config.FALLBACK_L2_COLLECTIONS]
    infos += [CollectionInfo(name, "cube", 3) for name in config.FALLBACK_CUBE_COLLECTIONS]
    return CollectionCatalog(tuple(infos), None, "fallback", ("config.FALLBACK_*",))


def _degraded_catalog(cached: CollectionCatalog | None, reason: str) -> CollectionCatalog:
    if cached is not None:
        age_h = (time.time() - (cached.fetched_at or 0.0)) / 3600.0
        log.warning("SPHEREx collection discovery failed (%s); serving cached list (%.1f h old)", reason, age_h)
        return replace(cached, source="stale-cache")
    log.warning("SPHEREx collection discovery failed (%s); using config.FALLBACK_* collections", reason)
    return _fallback_catalog()


def collection_catalog(force: bool = False, *, service: SiaService | None = None) -> CollectionCatalog:
    """Discovered SPHEREx collections with their product types (cached 24 h, stale served on failure)."""
    path = _catalog_path()
    with _CATALOG_LOCK:
        cached = _load_catalog(path)
        if cached is not None and not force and _is_fresh(cached.fetched_at):
            return cached
        failed_at = _DISCOVERY_FAILED_AT.get(str(path))
        if not force and failed_at is not None and time.monotonic() - failed_at < DISCOVERY_RETRY_AFTER_S:
            return _degraded_catalog(cached, "recent discovery failure")
        try:
            catalog = _refresh_catalog(service or default_service())
        except SiaError as exc:
            _DISCOVERY_FAILED_AT[str(path)] = time.monotonic()
            return _degraded_catalog(cached, str(exc))
        _DISCOVERY_FAILED_AT.pop(str(path), None)
        _save_catalog(path, catalog)
        log.info("discovered SPHEREx collections via %s: %s", ", ".join(catalog.methods), catalog.names)
        return catalog


def discover_collections(force: bool = False, *, service: SiaService | None = None) -> list[str]:
    """Current spherex_* collection names, discovered at run time (cached 24 h)."""
    return collection_catalog(force, service=service).names


def discover_l2_collections(force: bool = False, *, service: SiaService | None = None) -> list[str]:
    """Level-2 image collections (calib_level 2, dataproduct_type image), wide and deep, sorted by name."""
    catalog = collection_catalog(force, service=service)
    level2 = [c.name for c in catalog.collections if c.is_level2_image]
    if level2:
        return level2
    guessed = [c.name for c in catalog.collections if c.dataproduct_type is None and _L2_NAME_RE.match(c.name)]
    if guessed:
        log.warning("no SPHEREx collection could be classified; guessing Level-2 collections by name: %s", guessed)
        return guessed
    log.warning("no Level-2 SPHEREx collections discovered; using config.FALLBACK_L2_COLLECTIONS")
    return list(config.FALLBACK_L2_COLLECTIONS)


# --- Position search ------------------------------------------------------------------------------


@dataclass(frozen=True)
class CollectionSearch:
    """Result of one collection's position search.

    source: "network" | "cache" | "stale-cache" (IRSA failed; older cached rows served) | "failed".
    """

    collection: str
    images: tuple[DetectorImage, ...]
    source: str
    truncated: bool = False
    fetched_at: float | None = None  # unix time of the IRSA response behind these rows
    n_rows: int = 0  # rows in the SIA response (including any non-Level-2 rows)
    error: str | None = None
    exception: Exception | None = field(default=None, repr=False, compare=False)


class _QueryPaths(NamedTuple):
    json: Path
    raw: Path


def _band_metres(band_um: float | tuple[float, float] | None) -> tuple[float, float] | None:
    if band_um is None:
        return None
    if isinstance(band_um, (int, float)):
        lo = hi = float(band_um)
    else:
        lo, hi = (float(v) for v in band_um)
    if not (math.isfinite(lo) and math.isfinite(hi)) or lo <= 0 or hi < lo:
        raise ValueError(f"band_um must be a positive wavelength or (lo, hi) with lo <= hi, got {band_um!r}")
    return lo * 1e-6, hi * 1e-6


def _normalise_position(ra_deg: float, dec_deg: float, radius_deg: float) -> tuple[float, float, float]:
    ra, dec, radius = float(ra_deg), float(dec_deg), float(radius_deg)
    if not all(math.isfinite(v) for v in (ra, dec, radius)):
        raise ValueError(f"non-finite position or radius: {ra_deg!r}, {dec_deg!r}, {radius_deg!r}")
    if not -90.0 <= dec <= 90.0:
        raise ValueError(f"dec must be within [-90, 90] deg, got {dec}")
    if not 0.0 < radius <= MAX_RADIUS_DEG:
        raise ValueError(f"radius_deg must be within (0, {MAX_RADIUS_DEG}], got {radius}")
    ra = round(ra % 360.0, COORD_DECIMALS) % 360.0
    return ra, round(dec, COORD_DECIMALS), radius


def build_query_params(
    collection: str,
    ra_deg: float,
    dec_deg: float,
    radius_deg: float,
    maxrec: int,
    band_m: tuple[float, float] | None = None,
) -> list[tuple[str, str]]:
    """SIA v2 parameters for one collection (BAND as a DALI interval in metres; never TIME)."""
    params = [
        ("COLLECTION", collection),
        ("POS", f"CIRCLE {ra_deg:.{COORD_DECIMALS}f} {dec_deg:.{COORD_DECIMALS}f} {radius_deg:.7g}"),
        ("MAXREC", str(int(maxrec))),
    ]
    if band_m is not None:
        params.append(("BAND", f"{band_m[0]:.6e} {band_m[1]:.6e}"))
    return params


def _query_paths(
    collection: str, ra: float, dec: float, radius: float, maxrec: int, band_m: tuple[float, float] | None
) -> _QueryPaths:
    band = "all" if band_m is None else f"{band_m[0]:.6e}-{band_m[1]:.6e}"
    stem = f"{ra:09.{COORD_DECIMALS}f}_{dec:+09.{COORD_DECIMALS}f}_r{radius:.7g}_m{maxrec}_b{band}"
    folder = _cache_root() / "query" / collection
    return _QueryPaths(folder / f"{stem}.json", folder / f"{stem}.xml.gz")


def _images_from_payload(payload: dict[str, Any]) -> tuple[DetectorImage, ...] | None:
    try:
        return tuple(DetectorImage(**item) for item in payload["images"])
    except (KeyError, TypeError) as exc:
        log.info("cached SIA entry does not match DetectorImage (%s); re-parsing", exc)
        return None


def _load_query_entry(paths: _QueryPaths, collection: str, maxrec: int) -> CollectionSearch | None:
    payload = _read_json(paths.json)
    if payload and payload.get("version") == _CACHE_VERSION:
        images = _images_from_payload(payload)
        if images is not None:
            return CollectionSearch(
                collection=collection,
                images=images,
                source="cache",
                truncated=bool(payload.get("truncated")),
                fetched_at=_float(payload.get("fetched_at")),
                n_rows=int(payload.get("n_rows", len(images))),
            )
    if not paths.raw.exists():
        return None
    try:  # re-parse the raw VOTable (e.g. after a parser or model change) without touching the network
        response = parse_response(gzip.decompress(paths.raw.read_bytes()))
        fetched_at = paths.raw.stat().st_mtime
    except (OSError, ValueError, EOFError, SiaError) as exc:
        log.warning("ignoring unreadable raw SIA cache %s: %s", paths.raw, exc)
        return None
    result = _result_from_response(collection, response, maxrec, fetched_at, source="cache")
    _save_query_entry(paths, result, raw=None)
    return result


def _save_query_entry(paths: _QueryPaths, result: CollectionSearch, raw: bytes | None) -> None:
    if raw is not None:
        _atomic_write(paths.raw, gzip.compress(raw, compresslevel=6))
    payload = {
        "version": _CACHE_VERSION,
        "collection": result.collection,
        "fetched_at": result.fetched_at,
        "truncated": result.truncated,
        "n_rows": result.n_rows,
        "images": [asdict(image) for image in result.images],
    }
    _atomic_write(paths.json, json.dumps(payload, separators=(",", ":")).encode())


def _time_order(image: DetectorImage) -> tuple[float, str, int]:
    return image.t_min_mjd, image.obs_id, image.detector


def _result_from_response(
    collection: str, response: SiaResponse, maxrec: int, fetched_at: float, source: str
) -> CollectionSearch:
    images = tuple(sorted(dedupe_images(rows_to_images(response.rows, collection)), key=_time_order))
    truncated = response.truncated or len(response.rows) >= maxrec
    return CollectionSearch(collection, images, source, truncated, fetched_at, len(response.rows))


def _search_one(
    service: SiaService,
    collection: str,
    ra: float,
    dec: float,
    radius: float,
    maxrec: int,
    band_m: tuple[float, float] | None,
    force: bool,
) -> CollectionSearch:
    paths = _query_paths(collection, ra, dec, radius, maxrec, band_m)
    label = f"{collection} ({ra:.{COORD_DECIMALS}f}, {dec:+.{COORD_DECIMALS}f}) r={radius:g}"
    with _key_lock(str(paths.json)):
        cached = _load_query_entry(paths, collection, maxrec)
        if cached is not None and not force and _is_fresh(cached.fetched_at):
            result = cached
        else:
            params = build_query_params(collection, ra, dec, radius, maxrec, band_m)
            try:
                response = service.fetch(params, label=label)
            except SiaUnavailable as exc:
                if cached is None:
                    raise
                age_h = (time.time() - (cached.fetched_at or 0.0)) / 3600.0
                log.warning("SIA %s failed (%s); serving cached rows (%.1f h old)", label, exc, age_h)
                return replace(cached, source="stale-cache", error=str(exc))
            result = _result_from_response(collection, response, maxrec, time.time(), source="network")
            _save_query_entry(paths, result, raw=response.content)
    if result.truncated:
        log.warning(
            "SIA %s hit MAXREC=%d (%d rows): results are truncated; narrow the search (radius, band_um)",
            label, maxrec, result.n_rows,
        )
    return result


def search_position(
    ra: float,
    dec: float,
    radius_deg: float = DEFAULT_RADIUS_DEG,
    collections: Sequence[str] | None = None,
    maxrec: int = DEFAULT_MAXREC,
    band_um: float | tuple[float, float] | None = None,
    *,
    force: bool = False,
    service: SiaService | None = None,
) -> list[CollectionSearch]:
    """Search each collection (concurrently) for images covering (ra, dec) in degrees; one result each.

    Failures are returned as results with source="failed" (and ``exception`` set), never raised.
    ``band_um`` (one wavelength, or (lo, hi) in micrometres) keeps images whose detector band overlaps it,
    which selects detectors, not channels; use it to thin the deep fields.
    """
    ra, dec, radius = _normalise_position(ra, dec, radius_deg)
    maxrec = int(maxrec)
    if maxrec < 1:
        raise ValueError(f"maxrec must be >= 1, got {maxrec}")
    band_m = _band_metres(band_um)
    svc = service or default_service()
    if isinstance(collections, str):
        collections = [collections]
    names = list(dict.fromkeys(collections)) if collections is not None else discover_l2_collections(service=svc)
    for name in names:
        if not _COLLECTION_NAME_RE.match(name):
            raise ValueError(f"invalid collection name {name!r}")

    def run(collection: str) -> CollectionSearch:
        try:
            return _search_one(svc, collection, ra, dec, radius, maxrec, band_m, force)
        except SiaError as exc:
            log.warning("SIA search of %s failed: %s", collection, exc)
            return CollectionSearch(collection, (), "failed", error=str(exc), exception=exc)

    if len(names) <= 1:
        return [run(name) for name in names]
    with ThreadPoolExecutor(max_workers=min(len(names), config.IRSA_MAX_CONCURRENCY), thread_name_prefix="sia") as pool:
        return list(pool.map(run, names))


def query_position(
    ra: float,
    dec: float,
    radius_deg: float = DEFAULT_RADIUS_DEG,
    collections: Sequence[str] | None = None,
    maxrec: int = DEFAULT_MAXREC,
    band_um: float | tuple[float, float] | None = None,
    *,
    allow_partial: bool = False,
    force: bool = False,
    service: SiaService | None = None,
) -> list[DetectorImage]:
    """All Level-2 detector images covering (ra, dec) in degrees, across the discovered (or given) collections.

    Rows are deduplicated by publisher_did and sorted by (t_min, obs_id, detector). Raises SiaUnavailable
    (or SiaQueryError) if any collection failed with nothing cached, unless ``allow_partial`` is set.
    ``force`` bypasses fresh cache entries (stale ones are still served if IRSA fails).
    """
    t0 = time.monotonic()
    results = search_position(ra, dec, radius_deg, collections, maxrec, band_um, force=force, service=service)
    failed = [r for r in results if r.source == "failed"]
    if failed and not allow_partial:
        first = failed[0].exception
        summary = "; ".join(f"{r.collection}: {r.error}" for r in failed)
        if isinstance(first, SiaQueryError):
            raise SiaQueryError(summary) from first
        raise SiaUnavailable(f"SIA search failed for {len(failed)} collection(s): {summary}") from first
    images = dedupe_images(image for r in results for image in r.images)
    images.sort(key=_time_order)
    log.info(
        "SIA (%.5f, %+.5f) r=%g: %d images [%s] in %.1f s",
        ra, dec, radius_deg, len(images),
        ", ".join(f"{r.collection}={len(r.images)}/{r.source}" for r in results), time.monotonic() - t0,
    )
    return images
