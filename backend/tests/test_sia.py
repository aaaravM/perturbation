"""Tests for pxh.spherex.sia: VOTable parsing, row mapping, retries, circuit breaker, caching, discovery.

Offline tests use two real IRSA responses saved on 2026-11-14:
- sia_barnard_trimmed.xml: COLLECTION=spherex_dr1&COLLECTION=spherex_qr3 at Barnard's Star, trimmed to 12 rows.
- sia_nep_closest.xml: FACILITY=SPHEREx&CLOSEST=collection at the north ecliptic pole (one row per collection).
"""

from __future__ import annotations

import gzip
import json
import logging
import threading
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

import httpx
import pytest
from tenacity import wait_none

from pxh import config
from pxh.spherex import sia
from pxh.spherex.epochs import group_epochs, group_exposures, is_valid_pair

BARNARD = (269.4464, 4.7682)
L2_NAMES = ["spherex_dr1", "spherex_dr1_deep", "spherex_qr3", "spherex_qr3_deep"]
ALL_NAMES = ["spherex_dr1", "spherex_dr1_cube", "spherex_dr1_deep", "spherex_qr3", "spherex_qr3_deep"]


# --- Helpers --------------------------------------------------------------------------------------


Reply = tuple[int, bytes] | Callable[[httpx.Request], Any]


class FakeIrsa:
    """Scripted SIA endpoint for httpx.MockTransport: replies from `script` first, then `default`."""

    def __init__(self, default: Reply | None = None, script: list[Reply] | None = None) -> None:
        self.default = default
        self.script = list(script or [])
        self.requests: list[httpx.Request] = []
        self._lock = threading.Lock()

    def __call__(self, request: httpx.Request) -> httpx.Response:
        with self._lock:
            self.requests.append(request)
            reply = self.script.pop(0) if self.script else self.default
        if reply is None:
            raise AssertionError(f"unexpected request {request.url}")
        if callable(reply):
            reply = reply(request)
            if isinstance(reply, httpx.Response):
                return reply
        status, body = reply
        return httpx.Response(status, content=body)

    def params(self, i: int = -1) -> httpx.QueryParams:
        return self.requests[i].url.params


def make_service(fake: FakeIrsa, *, attempts: int = config.RETRY_ATTEMPTS,
                 breaker: sia.CircuitBreaker | None = None) -> sia.SiaService:
    return sia.SiaService(
        client=httpx.Client(transport=httpx.MockTransport(fake)),
        attempts=attempts,
        wait=wait_none(),
        sleep=lambda _seconds: None,
        breaker=breaker or sia.CircuitBreaker(threshold=10_000),
        slots=threading.BoundedSemaphore(4),
    )


def by_collection(responses: dict[str, bytes]) -> Callable[[httpx.Request], httpx.Response]:
    def reply(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=responses[request.url.params["COLLECTION"]])

    return reply


BAD_GATEWAY = (502, b"<html><body><h1>502 Bad Gateway</h1></body></html>")


@pytest.fixture
def barnard_xml(fixtures_dir: Path) -> bytes:
    return (fixtures_dir / "sia_barnard_trimmed.xml").read_bytes()


@pytest.fixture
def closest_xml(fixtures_dir: Path) -> bytes:
    return (fixtures_dir / "sia_nep_closest.xml").read_bytes()


@pytest.fixture
def empty_xml(barnard_xml: bytes) -> bytes:
    """The Barnard response with every row removed (self-description kept)."""
    head, rest = barnard_xml.decode().split("<TABLEDATA>", 1)
    tail = rest.split("</TABLEDATA>", 1)[1]
    return f"{head}<TABLEDATA>\n        </TABLEDATA>{tail}".encode()


@pytest.fixture
def cache_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setattr(config, "CACHE_DIR", tmp_path)
    return tmp_path / "sia"


def with_status(xml: bytes, status: str, message: str = "") -> bytes:
    new = f'<INFO name="QUERY_STATUS" value="{status}">{message}</INFO>' if message else (
        f'<INFO name="QUERY_STATUS" value="{status}"/>')
    return xml.replace(b'<INFO name="QUERY_STATUS" value="OK"/>', new.encode())


# --- Parsing and mapping (offline) ----------------------------------------------------------------


def test_parse_response_reads_rows_status_and_self_description(barnard_xml: bytes) -> None:
    response = sia.parse_response(barnard_xml)
    assert response.query_status == "OK" and not response.truncated
    assert len(response.rows) == 12
    offered = set(response.collections_offered)
    assert set(ALL_NAMES) <= offered
    assert "akari_allskymaps" in offered  # the self-description lists every IRSA collection
    assert {row["obs_collection"] for row in response.rows} == {"spherex_dr1", "spherex_qr3"}


def test_parse_response_rejects_non_votable_and_query_errors(barnard_xml: bytes) -> None:
    with pytest.raises(ValueError):
        sia.parse_response(b"<html>maintenance</html>")
    with pytest.raises(sia.SiaQueryError, match="bad POS"):
        sia.parse_response(with_status(barnard_xml, "ERROR", "bad POS"))
    assert sia.parse_response(with_status(barnard_xml, "OVERFLOW")).truncated


def test_rows_to_images_maps_obscore_fields(barnard_xml: bytes) -> None:
    images = sia.rows_to_images(sia.parse_response(barnard_xml).rows)
    assert len(images) == 12
    im = next(i for i in images if i.obs_id == "2025W33_2C_0321_1" and i.detector == 6)
    assert im.collection == "spherex_dr1"
    assert im.publisher_did == "ivo://irsa.ipac/spherex_dr1?2025W33_2C_0321_1/D6"
    assert im.access_url.endswith("/level2_2025W33_2C_0321_1D6_spx_l2b-v27-2026-228.fits")
    assert im.t_min_mjd == pytest.approx(60902.864715)
    assert im.t_max_mjd == pytest.approx(60902.866047)
    assert (im.em_min_um, im.em_max_um) == (4.4115, 5.0096)
    assert im.exptime_s == pytest.approx(113.5826)
    assert im.s_region.startswith("POLYGON ICRS 266.698")
    assert im.release_date == "2026-10-04T05:45:39"
    assert im.file_tag == "l2b-v27-2026-228"
    assert im.est_size_kb == 64953
    assert im.s3_key == "dr1/level2/2025W33_2C/l2b-v27-2026-228/6/level2_2025W33_2C_0321_1D6_spx_l2b-v27-2026-228.fits"
    assert im.cache_key == "spherex_dr1/level2_2025W33_2C_0321_1D6_spx_l2b-v27-2026-228.fits"
    for image in images:  # every detector's band lies inside the nominal range of that detector
        lo, hi = config.DETECTOR_BANDS_UM[image.detector]
        assert lo - 0.05 < image.em_min_um < image.em_max_um < hi + 0.05


def test_rows_to_images_skips_cube_rows(closest_xml: bytes) -> None:
    response = sia.parse_response(closest_xml)
    assert len(response.rows) == 5
    images = sia.rows_to_images(response.rows)
    assert sorted(i.collection for i in images) == L2_NAMES
    assert sia.row_to_image({"dataproduct_type": "cube", "calib_level": 3, "access_url": "x"}) is None


def test_row_to_image_requires_core_fields() -> None:
    with pytest.raises(ValueError, match="access_url"):
        sia.row_to_image({"dataproduct_type": "image", "calib_level": 2, "energy_bandpassname": "SPHEREx-D1"})
    image = sia.row_to_image({
        "access_url": "https://x/level2_2025W20_2D_0243_1D6_spx_l2b-v27-2026-198.fits",
        "t_min": 61000.0,
    }, collection="spherex_dr1")
    assert image is not None  # obs_id, detector and tag come from the file name
    assert (image.obs_id, image.detector, image.file_tag) == ("2025W20_2D_0243_1", 6, "l2b-v27-2026-198")
    assert image.t_max_mjd == pytest.approx(61000.0 + config.EXPTIME_S / 86400)
    assert image.publisher_did == "ivo://irsa.ipac/spherex_dr1?2025W20_2D_0243_1/D6"
    assert image.s3_key is None


@pytest.mark.parametrize(
    ("name", "tag"),
    [
        (("https://irsa.ipac.caltech.edu/ibe/data/spherex/dr1/level2/2025W33_2C/l2b-v27-2026-228/6/"
          "level2_2025W33_2C_0321_1D6_spx_l2b-v27-2026-228.fits"), "l2b-v27-2026-228"),
        (("https://irsa.ipac.caltech.edu/ibe/data/spherex/dr1/level2/2025W17_4B/l2b_retry-v27-2026-197/5/"
          "level2_2025W17_4B_0359_2D5_spx_l2b_retry-v27-2026-197.fits"), "l2b_retry-v27-2026-197"),
        ("level2_2026W30_1B_0199_3D1_spx_l2b_retry-v27-2026-230.fits", "l2b_retry-v27-2026-230"),
        ("https://x/level2_2025W20_2D_0243_1D6_spx_l2b-v27-2026-198.fits?center=1,2&size=0.1", "l2b-v27-2026-198"),
        ("qr3/level2/2026W33_2A/l2b-v27-2026-241/3/level2_2026W33_2A_0594_4D3_spx_l2b-v27-2026-241.fits.gz",
         "l2b-v27-2026-241"),
        ("something_spx_custom-tag.fits", "custom-tag"),
        ("Npix7945_cube.fits", ""),
    ],
)
def test_parse_file_tag(name: str, tag: str) -> None:
    assert sia.parse_file_tag(name) == tag


def test_parse_level2_basename_handles_d_inside_obs_id() -> None:
    parsed = sia.parse_level2_basename("level2_2025W20_2D_0243_1D6_spx_l2b_retry-v27-2026-230.fits")
    assert parsed == sia.Level2Name("2025W20_2D_0243_1", 6, "l2b_retry-v27-2026-230")
    assert sia.parse_level2_basename("Npix7945_cube.fits") is None


@pytest.mark.parametrize(
    ("value", "det"),
    [("SPHEREx-D1", 1), ("SPHEREx-D6", 6), (" spherex-d3 ", 3), ("SPHEREx", None), ("SPHEREx-D7", None), (None, None)],
)
def test_parse_detector(value: str | None, det: int | None) -> None:
    assert sia.parse_detector(value) == det


def test_parse_s3_key() -> None:
    good = '{"aws": {"bucket_name": "nasa-irsa-spherex", "key":"dr1/level2/a/b.fits", "region": "us-east-1"}}'
    assert sia.parse_s3_key(good) == "dr1/level2/a/b.fits"
    assert sia.parse_s3_key('{"aws": {"key": "/qr3/x.fits"}}') == "qr3/x.fits"
    assert sia.parse_s3_key('{"aws": {"bucket_name": "other-bucket", "key": "x.fits"}}') is None
    for bad in (None, "", "not json", "[]", '{"aws": {}}', '{"gcp": {"key": "x"}}'):
        assert sia.parse_s3_key(bad) is None


def test_dedupe_images_by_publisher_did(barnard_xml: bytes) -> None:
    images = sia.rows_to_images(sia.parse_response(barnard_xml).rows)
    assert sia.dedupe_images(images + images[:5]) == images


def test_build_query_params_never_sends_time() -> None:
    params = dict(sia.build_query_params("spherex_dr1", 269.4464, 4.7682, 0.0005, 20000, (2.0e-6, 2.1e-6)))
    assert params == {
        "COLLECTION": "spherex_dr1",
        "POS": "CIRCLE 269.44640 4.76820 0.0005",
        "MAXREC": "20000",
        "BAND": "2.000000e-06 2.100000e-06",
    }
    with pytest.raises(ValueError, match="TIME"):
        make_service(FakeIrsa()).fetch([("TIME", "61000 61001")])


# --- Retries and circuit breaker (offline) --------------------------------------------------------


def test_fetch_retries_502_until_success(barnard_xml: bytes) -> None:
    fake = FakeIrsa(script=[BAD_GATEWAY, BAD_GATEWAY, (200, barnard_xml)])
    service = make_service(fake)
    response = service.fetch([("MAXREC", "10")], label="test")
    assert len(response.rows) == 12
    stats = service.stats()
    assert (stats["attempts"], stats["retries"], stats["http_502"], stats["http_200"]) == (3, 2, 2, 1)


def test_default_http_client_sends_generic_user_agent() -> None:
    assert sia._http_client().headers["user-agent"] == config.USER_AGENT
    assert sia.default_service() is sia.default_service()


def test_fetch_retries_timeouts_and_non_votable_bodies(barnard_xml: bytes) -> None:
    def timeout(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("read timed out", request=request)

    def refused(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused", request=request)

    truncated = barnard_xml[: len(barnard_xml) // 2]
    fake = FakeIrsa(script=[timeout, refused, (200, b"<html>busy</html>"), (200, truncated), (200, barnard_xml)])
    service = make_service(fake)
    assert len(service.fetch([("MAXREC", "10")]).rows) == 12
    stats = service.stats()
    assert stats["timeout"] == 1 and stats["transport"] == 1
    assert stats["not_votable"] == 1 and stats["bad_votable"] == 1 and stats["retries"] == 4


def test_fetch_gives_up_after_configured_attempts() -> None:
    fake = FakeIrsa(default=BAD_GATEWAY)
    service = make_service(fake)
    with pytest.raises(sia.SiaUnavailable, match="HTTP 502"):
        service.fetch([("MAXREC", "1")])
    assert len(fake.requests) == config.RETRY_ATTEMPTS
    assert service.stats()["failures"] == 1


def test_fetch_does_not_retry_client_errors(barnard_xml: bytes) -> None:
    fake = FakeIrsa(script=[(400, b"bad request")])
    with pytest.raises(sia.SiaQueryError, match="HTTP 400"):
        make_service(fake).fetch([("POS", "nonsense")])
    assert len(fake.requests) == 1
    fake = FakeIrsa(script=[(200, with_status(barnard_xml, "ERROR", "invalid POS"))])
    with pytest.raises(sia.SiaQueryError, match="invalid POS"):
        make_service(fake).fetch([("POS", "nonsense")])
    assert len(fake.requests) == 1


def test_default_wait_is_exponential_2_to_16_s_with_jitter() -> None:
    wait = sia._default_wait()

    class State:
        def __init__(self, attempt: int) -> None:
            self.attempt_number = attempt

    delays = [wait(State(n)) for n in range(1, 8)]  # type: ignore[arg-type]
    for delay, base in zip(delays, [2, 4, 8, 16, 16, 16, 16], strict=True):
        assert base <= delay <= base + 1.0


def test_circuit_breaker_opens_fails_fast_and_recovers(barnard_xml: bytes) -> None:
    now = [1000.0]
    breaker = sia.CircuitBreaker(threshold=3, cooldown_s=60.0, clock=lambda: now[0])
    fake = FakeIrsa(default=BAD_GATEWAY)
    service = make_service(fake, attempts=3, breaker=breaker)
    with pytest.raises(sia.SiaUnavailable):
        service.fetch([("MAXREC", "1")])
    assert breaker.state == "open" and len(fake.requests) == 3
    with pytest.raises(sia.SiaUnavailable, match="circuit breaker"):
        service.fetch([("MAXREC", "1")])
    assert len(fake.requests) == 3  # failed fast: no request sent
    now[0] += 61.0
    assert breaker.state == "half-open"
    fake.default = (200, barnard_xml)
    assert len(service.fetch([("MAXREC", "1")]).rows) == 12
    assert breaker.state == "closed"
    stats = service.stats()
    assert stats["circuit_opened"] == 1 and stats["circuit_rejected"] == 1


def test_circuit_breaker_reopens_when_half_open_trial_fails() -> None:
    now = [0.0]
    breaker = sia.CircuitBreaker(threshold=2, cooldown_s=10.0, clock=lambda: now[0])
    assert breaker.record_failure() is False
    assert breaker.record_failure() is True and breaker.state == "open"
    assert breaker.record_failure() is False  # already open: the open period is not extended
    now[0] = 10.5
    assert breaker.allow() and breaker.state == "half-open"
    assert breaker.record_failure() is True and breaker.state == "open"
    breaker.record_success()
    assert breaker.state == "closed"


# --- Position search: parameters, caching, stale serving (offline) --------------------------------


def test_query_position_one_request_per_collection(cache_dir: Path, barnard_xml: bytes) -> None:
    fake = FakeIrsa(default=(200, barnard_xml))
    images = sia.query_position(*BARNARD, collections=["spherex_dr1", "spherex_qr3"], service=make_service(fake))
    assert len(fake.requests) == 2
    assert sorted(fake.params(i)["COLLECTION"] for i in range(2)) == ["spherex_dr1", "spherex_qr3"]
    for i in range(2):
        params = fake.params(i)
        assert params["POS"] == "CIRCLE 269.44640 4.76820 0.0005"
        assert params["MAXREC"] == "20000"
        assert "TIME" not in params and "BAND" not in params
    # both responses carry the same 12 rows: deduplicated by publisher_did, sorted by time
    assert len(images) == 12
    assert [im.t_min_mjd for im in images] == sorted(im.t_min_mjd for im in images)


def test_query_position_band_in_metres(cache_dir: Path, barnard_xml: bytes) -> None:
    fake = FakeIrsa(default=(200, barnard_xml))
    service = make_service(fake)
    sia.query_position(*BARNARD, collections=["spherex_dr1_deep"], band_um=(2.0, 2.1), service=service)
    assert fake.params()["BAND"] == "2.000000e-06 2.100000e-06"
    sia.query_position(*BARNARD, collections="spherex_dr1_deep", band_um=2.05, service=service)  # bare str ok
    assert fake.params()["BAND"] == "2.050000e-06 2.050000e-06"
    assert fake.params()["COLLECTION"] == "spherex_dr1_deep" and len(fake.requests) == 2


def test_query_position_rejects_bad_input(cache_dir: Path) -> None:
    service = make_service(FakeIrsa())
    for kwargs in ({"dec": 95.0}, {"ra": float("nan")}, {"radius_deg": 0.0}, {"radius_deg": 20.0}, {"maxrec": 0},
                   {"band_um": (2.1, 2.0)}, {"band_um": -1.0}, {"collections": ["bad name"]}):
        args: dict[str, Any] = {"ra": 10.0, "dec": 0.0, "collections": ["spherex_dr1"], **kwargs}
        with pytest.raises(ValueError):
            sia.query_position(service=service, **args)


def test_query_position_caches_parsed_rows_and_raw_bytes(cache_dir: Path, barnard_xml: bytes) -> None:
    fake = FakeIrsa(default=(200, barnard_xml))
    service = make_service(fake)
    first = sia.query_position(*BARNARD, collections=["spherex_dr1"], service=service)
    again = sia.query_position(269.446404, 4.768204, collections=["spherex_dr1"], service=service)  # rounds equal
    assert again == first and len(fake.requests) == 1
    folder = cache_dir / "query" / "spherex_dr1"
    stem = "269.44640_+04.76820_r0.0005_m20000_ball"
    assert (folder / f"{stem}.json").exists()
    assert gzip.decompress((folder / f"{stem}.xml.gz").read_bytes()) == barnard_xml
    sia.query_position(*BARNARD, collections=["spherex_dr1"], service=service, force=True)
    assert len(fake.requests) == 2


def test_query_position_reparses_raw_cache_when_json_is_outdated(cache_dir: Path, barnard_xml: bytes) -> None:
    service = make_service(FakeIrsa(default=(200, barnard_xml)))
    first = sia.query_position(*BARNARD, collections=["spherex_dr1"], service=service)
    entry = cache_dir / "query" / "spherex_dr1" / "269.44640_+04.76820_r0.0005_m20000_ball.json"
    entry.write_text(json.dumps({"version": -1}))
    offline = make_service(FakeIrsa())  # any request would fail the test
    assert sia.query_position(*BARNARD, collections=["spherex_dr1"], service=offline) == first
    assert json.loads(entry.read_text())["version"] == sia._CACHE_VERSION


def test_query_position_serves_stale_cache_when_irsa_fails(
    cache_dir: Path, barnard_xml: bytes, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    first = sia.query_position(*BARNARD, collections=["spherex_dr1"],
                               service=make_service(FakeIrsa(default=(200, barnard_xml))))
    monkeypatch.setattr(config, "SIA_CACHE_TTL_S", 0)  # everything cached is now stale
    failing = FakeIrsa(default=BAD_GATEWAY)
    with caplog.at_level(logging.WARNING, logger="pxh.spherex.sia"):
        results = sia.search_position(*BARNARD, collections=["spherex_dr1"], service=make_service(failing))
    assert results[0].source == "stale-cache" and "HTTP 502" in (results[0].error or "")
    assert list(results[0].images) == first
    assert len(failing.requests) == config.RETRY_ATTEMPTS
    assert "serving cached rows" in caplog.text


def test_query_position_failure_without_cache(cache_dir: Path, barnard_xml: bytes, empty_xml: bytes) -> None:
    def reply(request: httpx.Request) -> httpx.Response:
        if request.url.params["COLLECTION"] == "spherex_qr3":
            return httpx.Response(502, content=b"bad gateway")
        return httpx.Response(200, content=barnard_xml)

    service = make_service(FakeIrsa(default=reply))
    with pytest.raises(sia.SiaUnavailable, match="spherex_qr3"):
        sia.query_position(*BARNARD, collections=["spherex_dr1", "spherex_qr3"], service=service)
    partial = sia.query_position(*BARNARD, collections=["spherex_dr1", "spherex_qr3"], service=service,
                                 allow_partial=True)
    assert len(partial) == 12
    results = sia.search_position(*BARNARD, collections=["spherex_dr1", "spherex_qr3"], service=service)
    assert [r.source for r in results] == ["cache", "failed"]
    assert isinstance(results[1].exception, sia.SiaUnavailable)
    # an empty (but valid) answer is cached like any other
    service = make_service(FakeIrsa(default=(200, empty_xml)))
    assert sia.query_position(*BARNARD, collections=["spherex_qr3_deep"], service=service) == []


def test_query_position_warns_when_maxrec_truncates(
    cache_dir: Path, barnard_xml: bytes, caplog: pytest.LogCaptureFixture
) -> None:
    service = make_service(FakeIrsa(default=(200, with_status(barnard_xml, "OVERFLOW"))))
    with caplog.at_level(logging.WARNING, logger="pxh.spherex.sia"):
        results = sia.search_position(*BARNARD, collections=["spherex_dr1"], maxrec=12, service=service)
    assert results[0].truncated and results[0].n_rows == 12
    assert "MAXREC=12" in caplog.text
    cached = sia.search_position(*BARNARD, collections=["spherex_dr1"], maxrec=12, service=service)
    assert cached[0].source == "cache" and cached[0].truncated


def test_query_position_is_thread_safe_and_coalesces(cache_dir: Path, barnard_xml: bytes) -> None:
    def slow(request: httpx.Request) -> httpx.Response:
        time.sleep(0.05)
        return httpx.Response(200, content=barnard_xml)

    fake = FakeIrsa(default=slow)
    service = make_service(fake)
    results: list[int] = []

    def worker() -> None:
        results.append(len(sia.query_position(*BARNARD, collections=["spherex_dr1"], service=service)))

    threads = [threading.Thread(target=worker) for _ in range(6)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert results == [12] * 6
    assert len(fake.requests) == 1  # concurrent identical searches share one IRSA request


# --- Collection discovery (offline) ---------------------------------------------------------------


def test_discover_collections_from_self_description_and_closest_rows(cache_dir: Path, closest_xml: bytes) -> None:
    fake = FakeIrsa(default=(200, closest_xml))
    service = make_service(fake)
    assert sia.discover_collections(service=service) == ALL_NAMES
    assert len(fake.requests) == 1  # the NEP sentinel classified every collection
    params = fake.params(0)
    assert params["FACILITY"] == "SPHEREx" and params["CLOSEST"] == "collection"
    assert params["POS"].startswith("CIRCLE 270.0 66.56")
    assert sia.discover_l2_collections(service=service) == L2_NAMES
    catalog = sia.collection_catalog(service=service)
    assert catalog.source == "cache" and len(fake.requests) == 1
    cube = next(c for c in catalog.collections if c.name == "spherex_dr1_cube")
    assert (cube.dataproduct_type, cube.calib_level, cube.is_level2_image) == ("cube", 3, False)
    assert [c.name for c in catalog.collections if c.is_deep] == ["spherex_dr1_deep", "spherex_qr3_deep"]
    sia.discover_collections(force=True, service=service)
    assert len(fake.requests) == 2


def test_discovery_probes_more_sentinels_for_unclassified_names(cache_dir: Path, closest_xml: bytes) -> None:
    # A new collection listed in the self-description but without rows at the NEP: the SEP and the
    # wide-survey sentinel are tried, then it stays unclassified (searchable only if named explicitly).
    xml = closest_xml.replace(b'<OPTION value="spherex_qr3"/>',
                              b'<OPTION value="spherex_qr3"/>\n          <OPTION value="spherex_qr4"/>')
    fake = FakeIrsa(default=(200, xml))
    service = make_service(fake)
    assert "spherex_qr4" in sia.discover_collections(service=service)
    assert len(fake.requests) == len(sia.SENTINELS)
    assert "spherex_qr4" not in sia.discover_l2_collections(service=service)


def test_discovery_serves_stale_cache_then_fallback(
    cache_dir: Path, closest_xml: bytes, caplog: pytest.LogCaptureFixture
) -> None:
    sia.discover_collections(service=make_service(FakeIrsa(default=(200, closest_xml))))
    catalog_file = cache_dir / "collections.json"
    payload = json.loads(catalog_file.read_text())
    payload["fetched_at"] -= 2 * config.SIA_CACHE_TTL_S
    catalog_file.write_text(json.dumps(payload))
    failing = FakeIrsa(default=BAD_GATEWAY)
    with caplog.at_level(logging.WARNING, logger="pxh.spherex.sia"):
        catalog = sia.collection_catalog(service=make_service(failing))
    assert catalog.source == "stale-cache" and catalog.names == ALL_NAMES
    assert "serving cached list" in caplog.text
    tried = len(failing.requests)
    assert tried == config.RETRY_ATTEMPTS * (len(sia.SENTINELS) + 1)  # 3 sentinels + plain self-description
    assert sia.collection_catalog(service=make_service(failing)).source == "stale-cache"
    assert len(failing.requests) == tried  # recent failure: no new attempt for a while
    catalog_file.unlink()
    caplog.clear()
    with caplog.at_level(logging.WARNING, logger="pxh.spherex.sia"):
        names = sia.discover_l2_collections(service=make_service(failing))
    assert names == list(config.FALLBACK_L2_COLLECTIONS)
    assert "FALLBACK" in caplog.text


def test_discovery_guesses_level2_names_when_rows_are_missing(cache_dir: Path, empty_xml: bytes) -> None:
    # Self-description lists the names but no sentinel returns rows: guess Level-2 collections by name.
    names = sia.discover_l2_collections(service=make_service(FakeIrsa(default=(200, empty_xml))))
    assert names == L2_NAMES


def test_query_position_discovers_collections_by_default(cache_dir: Path, closest_xml: bytes,
                                                         barnard_xml: bytes, empty_xml: bytes) -> None:
    def reply(request: httpx.Request) -> httpx.Response:
        params = request.url.params
        if "CLOSEST" in params:
            return httpx.Response(200, content=closest_xml)
        body = barnard_xml if params["COLLECTION"] in ("spherex_dr1", "spherex_qr3") else empty_xml
        return httpx.Response(200, content=body)

    fake = FakeIrsa(default=reply)
    images = sia.query_position(*BARNARD, service=make_service(fake))
    searched = sorted(r.url.params["COLLECTION"] for r in fake.requests if "COLLECTION" in r.url.params)
    assert searched == L2_NAMES  # the cube collection is not searched
    assert len(images) == 12


def test_fixture_rows_group_into_valid_exposures(barnard_xml: bytes) -> None:
    exposures = group_exposures(sia.rows_to_images(sia.parse_response(barnard_xml).rows))
    assert len(exposures) == 7
    assert all(is_valid_pair(e.detectors) for e in exposures)
    assert len(group_epochs(exposures)) == 4


# --- Live archive -----------------------------------------------------------------------------------


@pytest.mark.network
def test_live_discover_collections(cache_dir: Path) -> None:
    names = sia.discover_collections(force=True)
    assert {"spherex_dr1", "spherex_qr3"} <= set(names)
    level2 = sia.discover_l2_collections()
    assert {"spherex_dr1", "spherex_qr3"} <= set(level2)
    assert not any(name.endswith(("_cube", "_cal")) for name in level2)
    assert sia.collection_catalog().source == "cache"


@pytest.mark.network
def test_live_query_barnards_star(cache_dir: Path) -> None:
    images = sia.query_position(*BARNARD)
    assert len(images) >= 300
    exposures = group_exposures(images)
    for exposure in exposures:
        assert 1 <= len(exposure.images) <= 2
        assert is_valid_pair(exposure.detectors), (exposure.obs_id, exposure.detectors)
    epochs = group_epochs(exposures)
    assert len(epochs) >= 3
    assert sum(epoch.full for epoch in epochs) >= 3
    assert all(image.file_tag and image.s3_key for image in images)
    assert {image.collection for image in images} >= {"spherex_dr1", "spherex_qr3"}
