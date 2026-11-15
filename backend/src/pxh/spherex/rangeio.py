"""HTTP byte-range reads from the IRSA IBE file server (multi-range) and the SPHEREx S3 mirror (single ranges).

`read_ranges(url, [(start, end), ...])` returns the bytes of each inclusive range, in request order. A range
with a negative start is a suffix range: ``(-n, -1)`` means "the last n bytes" (HTTP ``bytes=-n``).

IBE URLs (irsa.ipac.caltech.edu) get multi-range requests: ranges are sorted and merged (adjacent, overlapping
or separated by at most ``max_gap`` bytes), then packed into requests of at most
``config.IBE_MAX_RANGES_PER_REQUEST`` ranges and ``config.IBE_MAX_RANGE_HEADER_BYTES`` header bytes; the
``multipart/byteranges`` replies are parsed by exact part length. Other hosts (the public S3 mirror) only get
single-range requests, so their ranges are merged across gaps of up to ``S3_MAX_GAP`` bytes first.

A server that answers 200 instead of 206 is streaming the whole 65 MB file: the stream is closed unread and
the request is split (if it had several ranges) or a `RangeNotSupportedError` is raised.

Transient failures (transport errors, HTTP 429/5xx) are retried with tenacity using the policy in
`pxh.config` (8 attempts, exponential backoff 2-16 s plus jitter). At most ``config.IRSA_MAX_CONCURRENCY``
requests run against IRSA at once, across all threads. Reads of header-sized ranges can be cached on disk
(``cache=True``) under ``config.CACHE_DIR/pixels/blobs``. Transfer statistics are kept globally and per
`track()` block.
"""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
import re
import threading
import time
from collections.abc import Iterator, Sequence
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from dataclasses import dataclass, field, replace
from pathlib import Path
from urllib.parse import urlparse

import httpx
from tenacity import (
    RetryCallState,
    Retrying,
    retry_if_exception,
    stop_after_attempt,
    wait_exponential_jitter,
)

from pxh import config

log = logging.getLogger(__name__)

IRSA_HOST_SUFFIX = "irsa.ipac.caltech.edu"
S3_MAX_GAP = 1 << 20  # single-range hosts: read through gaps up to 1 MB rather than issue another request
IBE_DEFAULT_MAX_GAP = 0  # merge only adjacent/overlapping ranges on multi-range hosts
BLOB_CACHE_MAX_BYTES = 256 * 1024  # largest range stored by the blob cache
MULTIPART_OVERHEAD_PER_PART = 512  # generous bound on part headers, used to cap the bytes read per reply
S3_MAX_CONCURRENCY = 8


# --- errors -----------------------------------------------------------------------------------------------


class RangeIOError(RuntimeError):
    """A byte-range read failed (bad reply, missing data, or retries exhausted)."""


class RangeNotSupportedError(RangeIOError):
    """The server ignored the Range header (HTTP 200) for a single range."""


class RemoteFileNotFoundError(RangeIOError):
    """HTTP 404 for the requested file."""


class _RetryableHTTPError(RangeIOError):
    """HTTP 429/5xx: retried by tenacity."""

    def __init__(self, status: int, url: str) -> None:
        super().__init__(f"HTTP {status} for {url}")
        self.status = status


class _SplitRequest(RangeIOError):
    """The request must be split into smaller groups (HTTP 200 or 400 on a multi-range request)."""


# --- statistics -------------------------------------------------------------------------------------------


@dataclass
class TransferStats:
    """Counters for HTTP traffic. `bytes` counts response body bytes received (incl. multipart framing)."""

    requests: int = 0
    bytes: int = 0
    retries: int = 0
    cache_hits: int = 0
    seconds: float = 0.0  # summed request durations (not wall time when requests run in parallel)

    def add(self, other: TransferStats) -> None:
        self.requests += other.requests
        self.bytes += other.bytes
        self.retries += other.retries
        self.cache_hits += other.cache_hits
        self.seconds += other.seconds


_STATS_LOCK = threading.Lock()
_GLOBAL_STATS = TransferStats()
_LOCAL = threading.local()


def stats() -> TransferStats:
    """Copy of the process-wide transfer counters."""
    with _STATS_LOCK:
        return replace(_GLOBAL_STATS)


def _current_trackers() -> list[TransferStats]:
    return list(getattr(_LOCAL, "trackers", ()))


@contextmanager
def track() -> Iterator[TransferStats]:
    """Count the traffic of `read_ranges` calls made by this thread inside the block (thread-local)."""
    st = TransferStats()
    previous = _current_trackers()
    _LOCAL.trackers = [*previous, st]
    try:
        yield st
    finally:
        _LOCAL.trackers = previous


def _record(trackers: Sequence[TransferStats], delta: TransferStats) -> None:
    with _STATS_LOCK:
        _GLOBAL_STATS.add(delta)
        for t in trackers:
            t.add(delta)


# --- client and policy ------------------------------------------------------------------------------------


@dataclass(frozen=True)
class RetryPolicy:
    attempts: int = config.RETRY_ATTEMPTS
    wait_initial_s: float = config.RETRY_WAIT_INITIAL_S
    wait_max_s: float = config.RETRY_WAIT_MAX_S
    jitter_s: float = 1.0


RETRY_POLICY = RetryPolicy()  # tests may replace this with zero waits

_CLIENT_LOCK = threading.Lock()
_CLIENT: httpx.Client | None = None
_IRSA_SEMAPHORE: threading.Semaphore | None = None
_OTHER_SEMAPHORE = threading.BoundedSemaphore(S3_MAX_CONCURRENCY)


CONNECT_TIMEOUT_S = 10.0  # IRSA connects in < 1 s; a stuck connection is retried rather than waited on


def _make_client() -> httpx.Client:
    timeout = httpx.Timeout(config.HTTP_TIMEOUT_S, connect=CONNECT_TIMEOUT_S)
    limits = httpx.Limits(max_connections=32, max_keepalive_connections=16)
    return httpx.Client(
        timeout=timeout,
        limits=limits,
        headers={"User-Agent": config.USER_AGENT},
        follow_redirects=True,
    )


def get_client() -> httpx.Client:
    """The module-level httpx client (thread-safe; created on first use)."""
    global _CLIENT
    with _CLIENT_LOCK:
        if _CLIENT is None:
            _CLIENT = _make_client()
        return _CLIENT


def set_client(client: httpx.Client | None) -> httpx.Client | None:
    """Replace the module-level client (e.g. with one using httpx.MockTransport in tests); returns the old one."""
    global _CLIENT
    with _CLIENT_LOCK:
        old, _CLIENT = _CLIENT, client
        return old


def is_multirange_host(url: str) -> bool:
    """True for the IRSA IBE file server, which honours multi-range requests."""
    host = (urlparse(url).hostname or "").lower()
    return host == IRSA_HOST_SUFFIX or host.endswith("." + IRSA_HOST_SUFFIX)


def is_s3_url(url: str) -> bool:
    host = (urlparse(url).hostname or "").lower()
    return host.endswith("amazonaws.com")


def ibe_to_s3_url(access_url: str) -> str:
    """Map an IRSA IBE SPHEREx URL to the same file on the public S3 mirror."""
    prefix = config.IRSA_IBE_SPHEREX_PREFIX
    if not access_url.startswith(prefix):
        raise ValueError(f"not an IRSA IBE SPHEREx URL: {access_url}")
    return config.SPHEREX_S3_PREFIX + access_url[len(prefix):].split("?", 1)[0]


def _irsa_semaphore() -> threading.Semaphore:
    """One limit of config.IRSA_MAX_CONCURRENCY for every IRSA request in the process (shared with sia)."""
    global _IRSA_SEMAPHORE
    with _CLIENT_LOCK:
        if _IRSA_SEMAPHORE is None:
            try:
                from pxh.spherex.sia import IRSA_SLOTS  # the SIA client's slots, if that module provides them
            except Exception:  # noqa: BLE001 - any import problem: use a private limit
                IRSA_SLOTS = threading.BoundedSemaphore(config.IRSA_MAX_CONCURRENCY)
            _IRSA_SEMAPHORE = IRSA_SLOTS
        return _IRSA_SEMAPHORE


def _semaphore_for(url: str) -> threading.Semaphore:
    return _irsa_semaphore() if is_multirange_host(url) else _OTHER_SEMAPHORE


def _is_retryable(exc: BaseException) -> bool:
    return isinstance(exc, (_RetryableHTTPError, httpx.TransportError))


def _retrying(trackers: Sequence[TransferStats]) -> Retrying:
    policy = RETRY_POLICY

    def before_sleep(state: RetryCallState) -> None:
        exc = state.outcome.exception() if state.outcome else None
        log.info("retry %d after %r", state.attempt_number, exc)
        _record(trackers, TransferStats(retries=1))

    return Retrying(
        stop=stop_after_attempt(policy.attempts),
        # waits 2, 4, 8, 16, 16, ... s plus up to jitter_s (tenacity caps after adding the jitter)
        wait=wait_exponential_jitter(
            multiplier=policy.wait_initial_s, max=policy.wait_max_s + policy.jitter_s, jitter=policy.jitter_s
        ),
        retry=retry_if_exception(_is_retryable),
        before_sleep=before_sleep,
        reraise=True,
    )


# --- range bookkeeping ------------------------------------------------------------------------------------


@dataclass(frozen=True)
class _Segment:
    start: int
    data: bytes

    @property
    def end(self) -> int:  # inclusive
        return self.start + len(self.data) - 1


@dataclass
class RangeReadResult:
    """Bytes of each requested range (request order) and the file size reported by the server."""

    parts: list[bytes]
    total_size: int | None
    stats: TransferStats = field(default_factory=TransferStats)


def _validate(ranges: Sequence[tuple[int, int]]) -> None:
    for a, b in ranges:
        if a < 0:
            if b != -1:
                raise ValueError(f"suffix range must be (-n, -1), got {(a, b)}")
        elif b < a:
            raise ValueError(f"range end before start: {(a, b)}")


def merge_ranges(ranges: Sequence[tuple[int, int]], max_gap: int = 0) -> list[tuple[int, int]]:
    """Sort and merge inclusive ranges that overlap, touch, or are separated by at most `max_gap` bytes."""
    out: list[tuple[int, int]] = []
    for a, b in sorted(ranges):
        if out and a <= out[-1][1] + 1 + max_gap:
            out[-1] = (out[-1][0], max(out[-1][1], b))
        else:
            out.append((a, b))
    return out


def _range_spec(r: tuple[int, int]) -> str:
    a, b = r
    return f"-{-a}" if a < 0 else f"{a}-{b}"


def _group_ranges(ranges: Sequence[tuple[int, int]], multirange: bool) -> list[list[tuple[int, int]]]:
    """Pack ranges into requests within the IBE limits (or one range per request on single-range hosts)."""
    if not multirange:
        return [[r] for r in ranges]
    groups: list[list[tuple[int, int]]] = []
    cur: list[tuple[int, int]] = []
    cur_len = len("bytes=")
    for r in ranges:
        spec_len = len(_range_spec(r)) + 1
        if cur and (
            len(cur) >= config.IBE_MAX_RANGES_PER_REQUEST
            or cur_len + spec_len > config.IBE_MAX_RANGE_HEADER_BYTES
        ):
            groups.append(cur)
            cur, cur_len = [], len("bytes=")
        cur.append(r)
        cur_len += spec_len
    if cur:
        groups.append(cur)
    return groups


_CONTENT_RANGE_RE = re.compile(r"bytes\s+(\d+)-(\d+)/(\d+|\*)", re.IGNORECASE)


def _parse_content_range(value: str) -> tuple[int, int, int | None]:
    m = _CONTENT_RANGE_RE.search(value or "")
    if not m:
        raise RangeIOError(f"bad Content-Range: {value!r}")
    total = None if m.group(3) == "*" else int(m.group(3))
    return int(m.group(1)), int(m.group(2)), total


def _boundary(content_type: str) -> bytes | None:
    m = re.search(r'boundary=("?)([^";]+)\1', content_type, re.IGNORECASE)
    return m.group(2).strip().encode("latin-1") if m else None


def parse_multipart_byteranges(body: bytes, boundary: bytes) -> list[tuple[int, int, int | None, bytes]]:
    """Parse a multipart/byteranges body into (start, end, total, data); data is taken by exact length."""
    delim = b"--" + boundary
    parts: list[tuple[int, int, int | None, bytes]] = []
    pos = body.find(delim)
    while pos >= 0:
        pos += len(delim)
        if body[pos : pos + 2] == b"--":
            break  # closing delimiter
        head_end = body.find(b"\r\n\r\n", pos)
        if head_end < 0:
            raise RangeIOError("truncated multipart part headers")
        head = body[pos:head_end].decode("latin-1")
        cr = next(
            (ln.split(":", 1)[1] for ln in head.splitlines() if ln.lower().startswith("content-range:")),
            None,
        )
        if cr is None:
            raise RangeIOError("multipart part without Content-Range")
        a, b, total = _parse_content_range(cr)
        data_start = head_end + 4
        data = body[data_start : data_start + (b - a + 1)]
        if len(data) != b - a + 1:
            raise RangeIOError(f"truncated multipart part {a}-{b}: got {len(data)} bytes")
        parts.append((a, b, total, data))
        pos = body.find(delim, data_start + len(data))
    if not parts:
        raise RangeIOError("multipart reply without parts")
    return parts


def _expected_bytes(group: Sequence[tuple[int, int]]) -> int:
    return sum((-a if a < 0 else b - a + 1) for a, b in group)


def _request_group(
    url: str, group: Sequence[tuple[int, int]], trackers: Sequence[TransferStats]
) -> tuple[list[_Segment], int | None]:
    """One HTTP request for a group of ranges (no retries here); returns the received segments."""
    header = "bytes=" + ",".join(_range_spec(r) for r in group)
    cap = _expected_bytes(group) + MULTIPART_OVERHEAD_PER_PART * (len(group) + 1)
    client = get_client()
    t0 = time.perf_counter()
    nbytes = 0
    # identity encoding: byte offsets must refer to the file itself, never to a compressed representation
    headers = {"Range": header, "Accept-Encoding": "identity"}
    with _semaphore_for(url):
        try:
            with client.stream("GET", url, headers=headers) as resp:
                status = resp.status_code
                if status == 206:
                    chunks: list[bytes] = []
                    for chunk in resp.iter_bytes():
                        chunks.append(chunk)
                        nbytes += len(chunk)
                        if nbytes > cap:
                            raise RangeIOError(f"reply larger than requested ({nbytes} > {cap} bytes): {url}")
                    body = b"".join(chunks)
                    ctype = resp.headers.get("content-type", "")
                    content_range = resp.headers.get("content-range", "")
                # Every other status: leave the body unread; closing the stream aborts the transfer.
        finally:
            _record(trackers, TransferStats(requests=1, bytes=nbytes, seconds=time.perf_counter() - t0))
    if status == 206:
        return _segments_from_reply(body, ctype, content_range)
    if status == 200:
        if len(group) > 1:
            raise _SplitRequest(f"HTTP 200 (Range ignored) for {len(group)} ranges")
        raise RangeNotSupportedError(f"server ignored Range (HTTP 200) for {url}")
    if status == 400 and len(group) > 1:
        raise _SplitRequest(f"HTTP 400 for {len(group)} ranges")
    if status == 404:
        raise RemoteFileNotFoundError(f"HTTP 404 for {url}")
    if status == 429 or status >= 500:
        raise _RetryableHTTPError(status, url)
    raise RangeIOError(f"HTTP {status} for {url} (Range: {header[:200]})")


def _segments_from_reply(body: bytes, ctype: str, content_range: str) -> tuple[list[_Segment], int | None]:
    if "multipart/byteranges" in ctype.lower():
        boundary = _boundary(ctype)
        if boundary is None:
            raise RangeIOError(f"multipart reply without boundary: {ctype!r}")
        parts = parse_multipart_byteranges(body, boundary)
        totals = {t for _, _, t, _ in parts if t is not None}
        return [_Segment(a, d) for a, _, _, d in parts], (totals.pop() if len(totals) == 1 else None)
    a, b, total = _parse_content_range(content_range)
    if len(body) != b - a + 1:
        raise RangeIOError(f"reply length {len(body)} != Content-Range {a}-{b}")
    return [_Segment(a, body)], total


def _fetch_group(
    url: str, group: list[tuple[int, int]], trackers: Sequence[TransferStats]
) -> tuple[list[_Segment], int | None]:
    """Request a group with retries; split it in halves if the server refuses it as a whole."""
    try:
        for attempt in _retrying(trackers):
            with attempt:
                return _request_group(url, group, trackers)
    except _SplitRequest as exc:
        log.warning("%s: splitting %d ranges in two (%s)", url, len(group), exc)
        mid = len(group) // 2
        seg1, tot1 = _fetch_group(url, group[:mid], trackers)
        seg2, tot2 = _fetch_group(url, group[mid:], trackers)
        return seg1 + seg2, tot1 if tot1 is not None else tot2
    raise AssertionError("unreachable")  # pragma: no cover


def _slice(segments: Sequence[_Segment], a: int, b: int, total: int | None) -> bytes:
    """Bytes [a, b] from the received segments; a range running past EOF is truncated at EOF."""
    if total is not None:
        if a >= total:
            return b""  # entirely past EOF (servers skip such ranges): like a file read at EOF
        b = min(b, total - 1)
    out = bytearray()
    pos = a
    for seg in sorted(segments, key=lambda s: s.start):
        if seg.end < pos or seg.start > pos:
            continue
        take_end = min(seg.end, b)
        out += seg.data[pos - seg.start : take_end - seg.start + 1]
        pos = take_end + 1
        if pos > b:
            return bytes(out)
    if total is None and out:
        return bytes(out)  # server stopped at EOF without telling the size
    raise RangeIOError(f"reply does not cover bytes {a}-{b}")


# --- blob cache -------------------------------------------------------------------------------------------


def _blob_dir() -> Path:
    return Path(config.CACHE_DIR) / "pixels" / "blobs"


def _blob_path(url: str, r: tuple[int, int]) -> Path:
    key = hashlib.sha1(f"{url}|{r[0]}|{r[1]}".encode()).hexdigest()
    return _blob_dir() / key[:2] / f"{key}.json"


def _blob_get(url: str, r: tuple[int, int]) -> tuple[bytes, int | None] | None:
    path = _blob_path(url, r)
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
        return base64.b64decode(doc["data"]), doc.get("total")
    except (OSError, ValueError, KeyError):
        return None


def cached_blob(url: str, r: tuple[int, int]) -> tuple[bytes, int | None] | None:
    """(bytes, file size) of a range stored by an earlier ``cache=True`` read, or None (no network access)."""
    return _blob_get(url, r) if _cacheable(r) else None


def _blob_put(url: str, r: tuple[int, int], data: bytes, total: int | None) -> None:
    path = _blob_path(url, r)
    doc = {"url": url, "range": list(r), "total": total, "data": base64.b64encode(data).decode("ascii")}
    save_cache_file(path, json.dumps(doc).encode("utf-8"))


def write_atomic(path: Path, data: bytes) -> None:
    """Write a file atomically (temp file + rename), creating parent directories."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
    try:
        tmp.write_bytes(data)
        os.replace(tmp, path)
    except BaseException:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass
        raise


def save_cache_file(path: Path, data: bytes) -> bool:
    """`write_atomic` for caches: a failure (disk full, or on Windows a reader holding the old file open
    during the rename) is logged and reported as False instead of raised. The caller keeps its result."""
    try:
        write_atomic(path, data)
        return True
    except OSError as exc:
        log.warning("could not write cache file %s: %s", path, exc)
        return False


# --- public API -------------------------------------------------------------------------------------------


def fetch_ranges(
    url: str,
    ranges: Sequence[tuple[int, int]],
    *,
    cache: bool = False,
    max_gap: int | None = None,
    parallel: bool = True,
) -> RangeReadResult:
    """Read inclusive byte ranges of `url`; returns the bytes in request order plus the file size.

    cache: look up / store ranges of at most BLOB_CACHE_MAX_BYTES in the on-disk blob cache (use it for
        headers and tables, not for pixels). max_gap: merge ranges separated by up to this many bytes
        (default 0 on IBE, S3_MAX_GAP elsewhere). parallel: issue the requests of one call concurrently
        (bounded by the per-host semaphore).
    """
    _validate(ranges)
    trackers = _current_trackers()
    local = TransferStats()
    trackers_all = [*trackers, local]
    results: list[bytes | None] = [None] * len(ranges)
    total: int | None = None

    todo: list[int] = []
    for i, r in enumerate(ranges):
        hit = _blob_get(url, r) if cache and _cacheable(r) else None
        if hit is not None:
            results[i], t = hit
            total = total if t is None else t
            _record(trackers_all, TransferStats(cache_hits=1))
        else:
            todo.append(i)
    if todo:
        segments, total_net = _fetch_all(url, [ranges[i] for i in todo], max_gap, parallel, trackers_all)
        total = total_net if total_net is not None else total
        for i in todo:
            a, b = ranges[i]
            if a < 0:
                if total is None:
                    raise RangeIOError(f"suffix range without file size in reply: {url}")
                a, b = max(0, total + a), total - 1
            results[i] = _slice(segments, a, b, total)
            if cache and _cacheable(ranges[i]):
                _blob_put(url, ranges[i], results[i], total)
    return RangeReadResult(parts=[r if r is not None else b"" for r in results], total_size=total, stats=local)


def _cacheable(r: tuple[int, int]) -> bool:
    a, b = r
    return (-a if a < 0 else b - a + 1) <= BLOB_CACHE_MAX_BYTES


def _fetch_all(
    url: str,
    ranges: Sequence[tuple[int, int]],
    max_gap: int | None,
    parallel: bool,
    trackers: Sequence[TransferStats],
) -> tuple[list[_Segment], int | None]:
    multirange = is_multirange_host(url)
    gap = max_gap if max_gap is not None else (IBE_DEFAULT_MAX_GAP if multirange else S3_MAX_GAP)
    suffixes = sorted({r for r in ranges if r[0] < 0})
    merged = merge_ranges([r for r in ranges if r[0] >= 0], gap) + list(suffixes)
    groups = _group_ranges(merged, multirange)
    log.debug("%s: %d ranges -> %d merged -> %d requests", url, len(ranges), len(merged), len(groups))
    if parallel and len(groups) > 1:
        workers = config.IRSA_MAX_CONCURRENCY if multirange else S3_MAX_CONCURRENCY
        with ThreadPoolExecutor(max_workers=min(workers, len(groups))) as ex:
            replies = list(ex.map(lambda g: _fetch_group(url, g, trackers), groups))
    else:
        replies = [_fetch_group(url, g, trackers) for g in groups]
    segments: list[_Segment] = []
    total: int | None = None
    for segs, tot in replies:
        segments.extend(segs)
        total = tot if tot is not None else total
    return segments, total


def read_ranges(
    url: str,
    ranges: Sequence[tuple[int, int]],
    *,
    cache: bool = False,
    max_gap: int | None = None,
) -> list[bytes]:
    """Bytes of each inclusive (start, end) range of `url`, in request order. (-n, -1) is the last n bytes."""
    return fetch_ranges(url, ranges, cache=cache, max_gap=max_gap).parts


def read_range(url: str, start: int, end: int, *, cache: bool = False) -> bytes:
    """Bytes [start, end] (inclusive) of `url`."""
    return read_ranges(url, [(start, end)], cache=cache)[0]


class MockRangeServer:
    """In-memory HTTP file server for offline tests (use with httpx.MockTransport via `client()`).

    Serves `files` ({url: bytes}) with HTTP Range semantics like IBE (multi-range -> multipart/byteranges,
    more than `max_ranges` ranges -> 200 with the whole file) on multi-range hosts, or like S3 (multi-range ->
    200 whole file) elsewhere. `fail_next` makes the next n requests answer 502. Records each Range header.
    """

    def __init__(self, files: dict[str, bytes], *, max_ranges: int | None = None, fail_next: int = 0) -> None:
        self.files = dict(files)
        self.max_ranges = config.IBE_MAX_RANGES_PER_REQUEST if max_ranges is None else max_ranges
        self.fail_next = fail_next
        self.range_headers: list[str | None] = []
        self.lock = threading.Lock()

    def client(self) -> httpx.Client:
        return httpx.Client(transport=httpx.MockTransport(self.handle), headers={"User-Agent": config.USER_AGENT})

    def handle(self, request: httpx.Request) -> httpx.Response:
        url = str(request.url).split("?", 1)[0]
        rng = request.headers.get("range")
        with self.lock:
            self.range_headers.append(rng)
            if self.fail_next > 0:
                self.fail_next -= 1
                return httpx.Response(502, content=b"Bad Gateway")
        if url not in self.files:
            return httpx.Response(404, content=b"not found")
        body = self.files[url]
        if not rng:
            return httpx.Response(200, content=body)
        specs = rng.split("=", 1)[1].split(",")
        size = len(body)
        spans = []
        for s in specs:
            a_s, b_s = s.strip().split("-")
            if a_s == "":
                a, b = max(0, size - int(b_s)), size - 1
            else:
                a, b = int(a_s), min(int(b_s) if b_s else size - 1, size - 1)
            if a < size:
                spans.append((a, b))
        if not spans:
            return httpx.Response(416, headers={"content-range": f"bytes */{size}"})
        multirange = is_multirange_host(url)
        if len(spans) > 1 and (not multirange or len(spans) > self.max_ranges):
            return httpx.Response(200, content=body)
        if len(spans) == 1:
            a, b = spans[0]
            return httpx.Response(
                206, content=body[a : b + 1], headers={"content-range": f"bytes {a}-{b}/{size}"}
            )
        boundary = "mockboundary0123456789"
        out = bytearray()
        for a, b in spans:
            out += (
                f"\r\n--{boundary}\r\nContent-Type: application/fits\r\n"
                f"Content-Range: bytes {a}-{b}/{size}\r\n\r\n"
            ).encode("latin-1")
            out += body[a : b + 1]
        out += f"\r\n--{boundary}--\r\n".encode("latin-1")
        return httpx.Response(
            206, content=bytes(out), headers={"content-type": f"multipart/byteranges; boundary={boundary}"}
        )


def http_get(url: str, params: dict[str, str] | None = None, *, max_bytes: int = 64 << 20) -> bytes:
    """Plain GET with the same retry policy and concurrency limit (for SIA queries and cutout oracles)."""
    trackers = _current_trackers()

    def once() -> bytes:
        t0 = time.perf_counter()
        nbytes = 0
        with _semaphore_for(url):
            try:
                with get_client().stream("GET", url, params=params) as resp:
                    if resp.status_code == 404:
                        raise RemoteFileNotFoundError(f"HTTP 404 for {url}")
                    if resp.status_code == 429 or resp.status_code >= 500:
                        raise _RetryableHTTPError(resp.status_code, url)
                    if resp.status_code != 200:
                        raise RangeIOError(f"HTTP {resp.status_code} for {url}")
                    chunks = []
                    for chunk in resp.iter_bytes():
                        nbytes += len(chunk)
                        if nbytes > max_bytes:
                            raise RangeIOError(f"reply larger than {max_bytes} bytes: {url}")
                        chunks.append(chunk)
                    return b"".join(chunks)
            finally:
                _record(trackers, TransferStats(requests=1, bytes=nbytes, seconds=time.perf_counter() - t0))

    for attempt in _retrying(trackers):
        with attempt:
            return once()
    raise AssertionError("unreachable")  # pragma: no cover
