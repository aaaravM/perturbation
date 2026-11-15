"""Tests for pxh.spherex.rangeio: multi-range reads (IBE), single ranges (S3), retries, limits, blob cache.

Offline tests serve in-memory files with rangeio.MockRangeServer (IBE semantics on irsa.ipac.caltech.edu
URLs: multipart/byteranges replies, HTTP 200 for more than 100 ranges; S3 semantics elsewhere: HTTP 200 for
any multi-range request). Network tests read a real DR1 Level-2 file on IBE and on the S3 mirror.
"""

from __future__ import annotations

import math
import threading
import time
from collections.abc import Callable, Iterator

import httpx
import numpy as np
import pytest

from pxh import config
from pxh.spherex import rangeio

IBE_URL = config.IRSA_IBE_SPHEREX_PREFIX + "dr1/level2/test/1/level2_test_0001_1D1_spx_test.fits"
S3_URL = config.SPHEREX_S3_PREFIX + "dr1/level2/test/1/level2_test_0001_1D1_spx_test.fits"
LIVE_KEY = "dr1/level2/2025W33_2C/l2b-v27-2026-228/6/level2_2025W33_2C_0321_1D6_spx_l2b-v27-2026-228.fits"
LIVE_SIZE = 64_952_640


def _random_bytes(n: int, seed: int = 0) -> bytes:
    return np.random.default_rng(seed).integers(0, 256, n, dtype=np.uint8).tobytes()


@pytest.fixture(autouse=True)
def _isolate(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    monkeypatch.setattr(config, "CACHE_DIR", tmp_path / "cache")
    monkeypatch.setattr(rangeio, "RETRY_POLICY", rangeio.RetryPolicy(wait_initial_s=0, wait_max_s=0, jitter_s=0))


@pytest.fixture
def serve() -> Iterator[Callable[..., rangeio.MockRangeServer]]:
    """Install a MockRangeServer as rangeio's client; restores the previous client afterwards."""
    saved: list[httpx.Client | None] = []

    def _serve(files: dict[str, bytes], server_cls: type = rangeio.MockRangeServer, **kw) -> rangeio.MockRangeServer:
        server = server_cls(files, **kw)
        saved.append(rangeio.set_client(server.client()))
        return server

    yield _serve
    if saved:
        rangeio.set_client(saved[0])


def _install(handler: Callable[[httpx.Request], httpx.Response]) -> httpx.Client | None:
    return rangeio.set_client(httpx.Client(transport=httpx.MockTransport(handler)))


# --- pure helpers -----------------------------------------------------------------------------------------


def test_merge_ranges_adjacent_overlapping_and_gaps() -> None:
    assert rangeio.merge_ranges([(10, 19), (0, 9)]) == [(0, 19)]  # adjacent
    assert rangeio.merge_ranges([(0, 9), (5, 12), (12, 12)]) == [(0, 12)]  # overlapping / contained
    assert rangeio.merge_ranges([(0, 9), (11, 20)]) == [(0, 9), (11, 20)]  # one-byte gap kept
    assert rangeio.merge_ranges([(0, 9), (11, 20)], max_gap=1) == [(0, 20)]
    assert rangeio.merge_ranges([]) == []


def test_group_ranges_respects_count_and_header_limits(monkeypatch: pytest.MonkeyPatch) -> None:
    ranges = [(i * 1000, i * 1000 + 9) for i in range(250)]
    groups = rangeio._group_ranges(ranges, multirange=True)
    assert [len(g) for g in groups] == [100, 100, 50]
    monkeypatch.setattr(config, "IBE_MAX_RANGE_HEADER_BYTES", 120)
    groups = rangeio._group_ranges(ranges, multirange=True)
    assert sum(len(g) for g in groups) == 250
    for g in groups:
        assert len("bytes=" + ",".join(rangeio._range_spec(r) for r in g)) <= 120
    assert rangeio._group_ranges(ranges[:3], multirange=False) == [[r] for r in ranges[:3]]


def test_parse_multipart_takes_part_data_by_exact_length() -> None:
    boundary = b"THIS_STRING_SEPARATES"
    # part data that contains the delimiter and blank lines must not confuse the parser
    data1 = b"\r\n--" + boundary + b"\r\n\r\nxyz"
    data2 = bytes(range(256))
    body = (
        b"\r\n--" + boundary + b"\r\nContent-Type: application/fits\r\nContent-Range: bytes 100-"
        + str(99 + len(data1)).encode() + b"/5000\r\n\r\n" + data1
        + b"\r\n--" + boundary + b"\r\nContent-range: bytes 1000-1255/5000\r\n\r\n" + data2
        + b"\r\n--" + boundary + b"--\r\n"
    )
    parts = rangeio.parse_multipart_byteranges(body, boundary)
    assert [(a, b, t) for a, b, t, _ in parts] == [(100, 99 + len(data1), 5000), (1000, 1255, 5000)]
    assert parts[0][3] == data1 and parts[1][3] == data2
    with pytest.raises(rangeio.RangeIOError):
        rangeio.parse_multipart_byteranges(body[: len(body) // 2], boundary)


def test_url_helpers() -> None:
    assert rangeio.is_multirange_host(IBE_URL)
    assert not rangeio.is_multirange_host(S3_URL)
    assert rangeio.is_s3_url(S3_URL)
    assert rangeio.ibe_to_s3_url(IBE_URL + "?center=1,2&size=0.1") == S3_URL
    with pytest.raises(ValueError):
        rangeio.ibe_to_s3_url("https://example.org/file.fits")


# --- IBE multi-range --------------------------------------------------------------------------------------


def test_ibe_multirange_reads_are_exact_and_within_limits(serve) -> None:
    body = _random_bytes(400_000)
    server = serve({IBE_URL: body})
    rng = np.random.default_rng(1)
    starts = rng.choice(np.arange(0, len(body) - 200, 300), size=230, replace=False)
    ranges = [(int(a), int(a) + int(rng.integers(0, 150))) for a in starts]
    with rangeio.track() as st:
        parts = rangeio.read_ranges(IBE_URL, ranges)
    assert parts == [body[a : b + 1] for a, b in ranges]
    assert st.requests == math.ceil(len(rangeio.merge_ranges(ranges)) / config.IBE_MAX_RANGES_PER_REQUEST)
    for header in server.range_headers:
        assert header is not None and header.startswith("bytes=")
        assert header.count(",") + 1 <= config.IBE_MAX_RANGES_PER_REQUEST
        assert len(header) <= config.IBE_MAX_RANGE_HEADER_BYTES


def test_request_order_duplicates_and_overlaps_are_preserved(serve) -> None:
    body = _random_bytes(10_000, seed=3)
    serve({IBE_URL: body})
    ranges = [(500, 599), (0, 9), (550, 700), (500, 599), (10, 19), (9999, 9999)]
    assert rangeio.read_ranges(IBE_URL, ranges) == [body[a : b + 1] for a, b in ranges]


def test_suffix_range_returns_tail_and_file_size(serve) -> None:
    body = _random_bytes(50_000, seed=4)
    serve({IBE_URL: body})
    res = rangeio.fetch_ranges(IBE_URL, [(0, 99), (-8640, -1)])
    assert res.parts == [body[:100], body[-8640:]]
    assert res.total_size == len(body)
    assert rangeio.read_ranges(IBE_URL, [(-100, -1)]) == [body[-100:]]
    with pytest.raises(ValueError):
        rangeio.read_ranges(IBE_URL, [(-100, 5)])
    with pytest.raises(ValueError):
        rangeio.read_ranges(IBE_URL, [(10, 5)])


def test_ranges_past_end_of_file_are_truncated(serve) -> None:
    body = _random_bytes(1000, seed=5)
    serve({IBE_URL: body})
    assert rangeio.read_ranges(IBE_URL, [(990, 2000)]) == [body[990:]]
    assert rangeio.read_ranges(IBE_URL, [(0, 9), (1500, 1600)]) == [body[:10], b""]


def test_multirange_http_200_is_split_into_smaller_requests(serve) -> None:
    body = _random_bytes(100_000, seed=6)
    server = serve({IBE_URL: body}, max_ranges=10)  # this server ignores Range above 10 ranges
    ranges = [(i * 2000, i * 2000 + 99) for i in range(40)]
    assert rangeio.read_ranges(IBE_URL, ranges) == [body[a : b + 1] for a, b in ranges]
    counts = [h.count(",") + 1 for h in server.range_headers if h]
    assert counts == [40, 20, 10, 10, 20, 10, 10]  # halved until the server honours the request


class _CountingStream(httpx.SyncByteStream):
    """A 65 MB body that records how much of it was consumed."""

    def __init__(self, total: int = 65 << 20) -> None:
        self.total = total
        self.yielded = 0
        self.closed = False

    def __iter__(self) -> Iterator[bytes]:
        chunk = b"\0" * 65536
        for _ in range(self.total // len(chunk)):
            self.yielded += 1
            yield chunk

    def close(self) -> None:
        self.closed = True


def test_http_200_for_single_range_aborts_the_stream() -> None:
    stream = _CountingStream()
    old = _install(lambda req: httpx.Response(200, stream=stream, headers={"content-length": str(stream.total)}))
    try:
        with pytest.raises(rangeio.RangeNotSupportedError):
            rangeio.read_ranges(IBE_URL, [(0, 99)])
    finally:
        rangeio.set_client(old)
    assert stream.yielded == 0 and stream.closed


def test_range_requests_ask_for_identity_encoding() -> None:
    seen: list[str | None] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.headers.get("accept-encoding"))
        return httpx.Response(206, content=b"x" * 10, headers={"content-range": "bytes 0-9/100"})

    old = _install(handler)
    try:
        assert rangeio.read_range(IBE_URL, 0, 9) == b"x" * 10
    finally:
        rangeio.set_client(old)
    assert seen == ["identity"]


# --- S3 single ranges -------------------------------------------------------------------------------------


def test_s3_gets_single_range_requests_only(serve) -> None:
    body = _random_bytes(3_000_000, seed=7)
    server = serve({S3_URL: body})
    near = [(1000, 1099), (5000, 5099), (90_000, 90_100)]  # within S3_MAX_GAP: one request
    far = [(0, 9), (2_500_000, 2_500_009)]  # further apart than S3_MAX_GAP: two requests
    with rangeio.track() as st:
        assert rangeio.read_ranges(S3_URL, near) == [body[a : b + 1] for a, b in near]
    assert st.requests == 1
    with rangeio.track() as st:
        assert rangeio.read_ranges(S3_URL, far) == [body[a : b + 1] for a, b in far]
    assert st.requests == 2
    assert all(h is not None and "," not in h for h in server.range_headers)


# --- retries and errors -----------------------------------------------------------------------------------


def test_http_502_is_retried(serve) -> None:
    body = _random_bytes(1000, seed=8)
    serve({IBE_URL: body}, fail_next=3)
    with rangeio.track() as st:
        assert rangeio.read_ranges(IBE_URL, [(0, 9), (100, 109)]) == [body[:10], body[100:110]]
    assert st.retries == 3 and st.requests == 4


def test_retries_are_bounded(serve) -> None:
    server = serve({IBE_URL: b"x" * 100}, fail_next=10_000)
    with pytest.raises(rangeio.RangeIOError):
        rangeio.read_ranges(IBE_URL, [(0, 9)])
    assert len(server.range_headers) == config.RETRY_ATTEMPTS


def test_default_backoff_is_2_to_16_seconds_plus_jitter(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(rangeio, "RETRY_POLICY", rangeio.RetryPolicy())

    class _State:
        def __init__(self, n: int) -> None:
            self.attempt_number = n

    wait = rangeio._retrying([]).wait
    waits = [wait(_State(n)) for n in range(1, config.RETRY_ATTEMPTS)]
    lows = [2, 4, 8, 16, 16, 16, 16]
    assert all(lo <= w <= lo + 1 for lo, w in zip(lows, waits, strict=True)), waits


def test_404_is_not_retried(serve) -> None:
    server = serve({})
    with pytest.raises(rangeio.RemoteFileNotFoundError):
        rangeio.read_ranges(IBE_URL, [(0, 9)])
    assert len(server.range_headers) == 1


def test_http_get_retries_then_returns_body() -> None:
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] <= 2:
            return httpx.Response(502)
        assert request.url.params["POS"] == "CIRCLE 1 2 0.1"
        return httpx.Response(200, content=b"<VOTABLE/>")

    old = _install(handler)
    try:
        assert rangeio.http_get(config.IRSA_SIA_URL, params={"POS": "CIRCLE 1 2 0.1"}) == b"<VOTABLE/>"
    finally:
        rangeio.set_client(old)
    assert calls["n"] == 3


# --- cache, statistics, concurrency -----------------------------------------------------------------------


def test_blob_cache_serves_repeated_header_reads(serve) -> None:
    body = _random_bytes(20_000, seed=9)
    server = serve({IBE_URL: body})
    assert rangeio.read_ranges(IBE_URL, [(0, 2879), (-5760, -1)], cache=True) == [body[:2880], body[-5760:]]
    n = len(server.range_headers)
    with rangeio.track() as st:
        assert rangeio.read_ranges(IBE_URL, [(0, 2879), (-5760, -1)], cache=True) == [body[:2880], body[-5760:]]
    assert len(server.range_headers) == n and st.cache_hits == 2 and st.requests == 0
    assert rangeio.cached_blob(IBE_URL, (-5760, -1)) == (body[-5760:], len(body))
    assert rangeio.cached_blob(IBE_URL, (0, 99)) is None
    big = (0, rangeio.BLOB_CACHE_MAX_BYTES)  # one byte over the limit: never cached
    rangeio.read_ranges(IBE_URL, [big], cache=True)
    assert rangeio.cached_blob(IBE_URL, big) is None


def test_cache_writes_are_atomic_and_best_effort(tmp_path, caplog: pytest.LogCaptureFixture) -> None:
    target = tmp_path / "a" / "b.json"
    assert rangeio.save_cache_file(target, b"{}") and target.read_bytes() == b"{}"
    blocked = tmp_path / "dir_in_the_way"
    blocked.mkdir()
    with caplog.at_level("WARNING", logger="pxh.spherex.rangeio"):
        assert rangeio.save_cache_file(blocked, b"x") is False
    assert "could not write cache file" in caplog.text
    assert sorted(p.name for p in tmp_path.iterdir()) == ["a", "dir_in_the_way"]  # no temp file left behind


def test_track_counts_bytes_and_requests(serve) -> None:
    body = _random_bytes(10_000, seed=10)
    serve({IBE_URL: body})
    before = rangeio.stats()
    with rangeio.track() as outer:
        rangeio.read_ranges(IBE_URL, [(0, 999)])
        with rangeio.track() as inner:
            rangeio.read_ranges(IBE_URL, [(0, 99), (200, 299)])
    assert inner.requests == 1 and outer.requests == 2
    assert outer.bytes == 1000 + inner.bytes and inner.bytes > 200  # multipart framing included
    assert rangeio.stats().requests - before.requests == 2


class _SlowServer(rangeio.MockRangeServer):
    """MockRangeServer that records the largest number of requests in flight at once."""

    def __init__(self, files: dict[str, bytes], **kw) -> None:
        super().__init__(files, **kw)
        self.inflight = 0
        self.max_inflight = 0
        self.count_lock = threading.Lock()

    def handle(self, request: httpx.Request) -> httpx.Response:
        with self.count_lock:
            self.inflight += 1
            self.max_inflight = max(self.max_inflight, self.inflight)
        try:
            time.sleep(0.02)
            return super().handle(request)
        finally:
            with self.count_lock:
                self.inflight -= 1


@pytest.mark.parametrize(("url", "limit"), [(IBE_URL, config.IRSA_MAX_CONCURRENCY), (S3_URL, rangeio.S3_MAX_CONCURRENCY)])
def test_concurrent_requests_are_limited(serve, url: str, limit: int) -> None:
    body = _random_bytes(6_000_000, seed=11)
    server = serve({url: body}, server_cls=_SlowServer)
    step = 1_100_000 if url == S3_URL else 1000  # S3: ranges further apart than S3_MAX_GAP
    ranges = [(i * step, i * step + 9) for i in range(5 if url == S3_URL else 500)]
    errors: list[BaseException] = []

    def work() -> None:
        try:
            assert rangeio.read_ranges(url, ranges) == [body[a : b + 1] for a, b in ranges]
        except BaseException as exc:  # noqa: BLE001 - reported below
            errors.append(exc)

    threads = [threading.Thread(target=work) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert not errors
    assert 1 < server.max_inflight <= limit


# --- live archive -----------------------------------------------------------------------------------------


@pytest.fixture
def live_client() -> Iterator[None]:
    old = rangeio.set_client(None)  # a fresh real client
    yield
    rangeio.set_client(old)


@pytest.mark.network
def test_live_ibe_multirange_matches_single_range(live_client) -> None:
    url = config.IRSA_IBE_SPHEREX_PREFIX + LIVE_KEY
    whole = rangeio.read_range(url, 0, 40959)
    ranges = [(i * 270, i * 270 + 79) for i in range(150)]  # 150 ranges: two multi-range requests
    with rangeio.track() as st:
        parts = rangeio.read_ranges(url, ranges)
    assert parts == [whole[a : b + 1] for a, b in ranges]
    assert st.requests - st.retries == 2


@pytest.mark.network
def test_live_suffix_range_is_the_wcs_wave_extension(live_client) -> None:
    url = config.IRSA_IBE_SPHEREX_PREFIX + LIVE_KEY
    res = rangeio.fetch_ranges(url, [(-8640, -1)])
    assert res.total_size == LIVE_SIZE
    tail = res.parts[0]
    blocks = [tail[i : i + 2880] for i in range(0, len(tail), 2880)]
    starts = [i for i, b in enumerate(blocks) if b.startswith(b"XTENSION= 'BINTABLE'")]
    assert starts and b"EXTNAME = 'WCS-WAVE'" in blocks[starts[-1]]


@pytest.mark.network
def test_live_s3_mirror_matches_ibe(live_client) -> None:
    ranges = [(25920, 26999), (-8640, -1), (40_000_000, 40_000_099)]
    ibe = rangeio.read_ranges(config.IRSA_IBE_SPHEREX_PREFIX + LIVE_KEY, ranges)
    with rangeio.track() as st:
        s3 = rangeio.read_ranges(config.SPHEREX_S3_PREFIX + LIVE_KEY, ranges)
    assert s3 == ibe
    assert st.requests - st.retries == 3  # single ranges only
