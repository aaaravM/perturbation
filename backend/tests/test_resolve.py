"""Tests for pxh.sky.resolve.

Offline tests drive the resolver through httpx.MockTransport with Sesame and SIMBAD TAP replies recorded
from the live mirrors on 2026-11-14 (fixtures sky_sesame_*.xml, sky_simbad_tap_*.json); any attempt to use
the real network fails them. Tests marked ``network`` query the live mirrors (run with --network).
"""

from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest

from pxh import config
from pxh.sky import resolve as resolve_mod
from pxh.sky.coords import angular_separation_arcsec
from pxh.sky.resolve import (
    NameNotFoundError,
    ResolverUnavailableError,
    display_name,
    query_sesame,
    query_simbad_tap,
    resolve,
    simbad_adql,
)
from pxh.sky.targets import TARGETS

Handler = Callable[[httpx.Request], httpx.Response]

SESAME_HOSTS = [urlsplit(u).hostname for u in config.SESAME_MIRRORS]
SIMBAD_HOSTS = [urlsplit(u).hostname for u in config.SIMBAD_TAP_MIRRORS]
VEGA = (279.23473479, 38.78368896)
M31 = (10.6847083, 41.26875)

BARNARD_SESAME_XML = b"""<?xml version="1.0" encoding="UTF-8"?>
<Sesame><Target option="SNV"><name>BD+04 3561a</name>
<Resolver name="Sc=Simbad (CDS, via client/server)">
<jradeg>269.45207696</jradeg><jdedeg>4.69336497</jdedeg>
<pm><pmRA>-801.551</pmRA><pmDE>10362.394</pmDE></pm>
<plx><v>546.9759</v></plx><oname>NAME Barnard's star</oname>
</Resolver></Target></Sesame>"""


@pytest.fixture(autouse=True)
def _isolate(request: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """Private cache for every test; offline tests also get no back-off waits and no real network."""
    monkeypatch.setattr(config, "CACHE_DIR", tmp_path / "cache")
    if request.node.get_closest_marker("network") is None:

        def forbidden() -> httpx.Client:
            raise AssertionError("offline test tried to use the real network")

        monkeypatch.setattr(resolve_mod, "_sleep", lambda _seconds: None)
        monkeypatch.setattr(resolve_mod, "_default_client", forbidden)


def mock_client(handler: Handler) -> tuple[httpx.Client, list[httpx.Request]]:
    seen: list[httpx.Request] = []

    def record(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return handler(request)

    return httpx.Client(transport=httpx.MockTransport(record)), seen


def refusing_client() -> httpx.Client:
    def refuse(request: httpx.Request) -> httpx.Response:
        raise AssertionError(f"unexpected request to {request.url}")

    return httpx.Client(transport=httpx.MockTransport(refuse))


def hosts(requests: list[httpx.Request]) -> list[str]:
    return [r.url.host for r in requests]


@pytest.fixture
def sesame_vega(fixtures_dir: Path) -> bytes:
    return (fixtures_dir / "sky_sesame_vega.xml").read_bytes()


@pytest.fixture
def sesame_notfound(fixtures_dir: Path) -> bytes:
    return (fixtures_dir / "sky_sesame_notfound.xml").read_bytes()


@pytest.fixture
def simbad_vega(fixtures_dir: Path) -> bytes:
    return (fixtures_dir / "sky_simbad_tap_vega.json").read_bytes()


@pytest.fixture
def simbad_empty(fixtures_dir: Path) -> bytes:
    return (fixtures_dir / "sky_simbad_tap_empty.json").read_bytes()


# --- (a) coordinates and (b) local table: never touch the network -------------------------------


def test_coordinates_query() -> None:
    result = resolve("17 57 48.5 +04 41 36", client=refusing_client())
    assert result.resolver == "coordinates"
    assert result.target_key is None
    assert result.name == "17h57m48.50s +04d41m36.0s"
    a = result.astrometry
    assert (a.ra_deg, a.dec_deg) == pytest.approx((269.4520833333, 4.6933333333))
    assert a.ref_epoch == 2000.0 and a.pmra_masyr == 0.0 and a.pmdec_masyr == 0.0
    assert a.parallax_mas is None and a.rv_kms is None
    assert resolve("08h55m10.831s -7d14m42.53s", client=refusing_client()).resolver == "coordinates"


@pytest.mark.parametrize(
    ("query", "key"),
    [
        ("Barnard's Star", "barnards-star"),
        ("  w0855 ", "wise-0855"),
        ("eps Ind B", "eps-indi-b"),
        ("R Dra", "r-dra"),
    ],
)
def test_local_table_query(query: str, key: str) -> None:
    result = resolve(query, client=refusing_client())
    assert result.resolver == "local-table"
    assert result.target_key == key
    assert result.name == TARGETS[key].name
    assert result.astrometry == TARGETS[key].astrometry
    assert result.query == query


@pytest.mark.parametrize("query", ["", "   ", "x" * 201])
def test_rejects_empty_or_long_query(query: str) -> None:
    with pytest.raises(ValueError):
        resolve(query, client=refusing_client())


@pytest.mark.parametrize("query", ["400 10", "10 95", "17 57 48.5 04 41"])
def test_numeric_invalid_coordinates_raise_without_network(query: str) -> None:
    with pytest.raises(ValueError):
        resolve(query, client=refusing_client())


# --- (c) Sesame and (d) SIMBAD TAP replies ------------------------------------------------------


def test_sesame_reply_parsing(sesame_vega: bytes) -> None:
    client, seen = mock_client(lambda request: httpx.Response(200, content=sesame_vega))
    result = query_sesame("Vega", client=client)
    assert result is not None
    assert result.resolver == f"sesame:{SESAME_HOSTS[0]}"
    assert result.name == "alf Lyr"
    a = result.astrometry
    assert (a.ra_deg, a.dec_deg) == VEGA
    assert (a.pmra_masyr, a.pmdec_masyr, a.parallax_mas) == (200.94, 286.23, 130.23)
    assert a.ref_epoch == 2000.0 and a.rv_kms is None
    assert "SIMBAD * alf Lyr" in a.source
    assert str(seen[0].url) == config.SESAME_MIRRORS[0] + "Vega"
    assert seen[0].headers["user-agent"] == config.USER_AGENT


def test_sesame_url_encodes_name(sesame_vega: bytes) -> None:
    client, seen = mock_client(lambda request: httpx.Response(200, content=sesame_vega))
    query_sesame("Barnard's star", client=client)
    assert str(seen[0].url).endswith("SNV?Barnard%27s%20star")


def test_sesame_reply_without_motion(fixtures_dir: Path) -> None:
    content = (fixtures_dir / "sky_sesame_m31.xml").read_bytes()
    client, _ = mock_client(lambda request: httpx.Response(200, content=content))
    result = query_sesame("M 31", config.SESAME_MIRRORS[1], client=client)
    assert result is not None and result.resolver == f"sesame:{SESAME_HOSTS[1]}"
    assert result.name == "M 31"
    a = result.astrometry
    assert (a.ra_deg, a.dec_deg) == M31
    assert (a.pmra_masyr, a.pmdec_masyr, a.parallax_mas, a.rv_kms) == (0.0, 0.0, None, None)


def test_sesame_nothing_found(sesame_notfound: bytes) -> None:
    client, _ = mock_client(lambda request: httpx.Response(200, content=sesame_notfound))
    assert query_sesame("xyzzy notanobject 42", client=client) is None


@pytest.mark.parametrize("body", [b"<html><body>Service unavailable</body></html>", b"not xml at all", b""])
def test_sesame_garbage_is_a_mirror_failure(body: bytes) -> None:
    client, _ = mock_client(lambda request: httpx.Response(200, content=body))
    with pytest.raises(ResolverUnavailableError):
        query_sesame("Vega", client=client)


def test_simbad_tap_request_and_parsing(simbad_vega: bytes, simbad_empty: bytes) -> None:
    client, seen = mock_client(lambda request: httpx.Response(200, content=simbad_vega))
    result = query_simbad_tap("Vega", client=client)
    assert result is not None and result.resolver == f"simbad:{SIMBAD_HOSTS[0]}"
    assert result.name == "alf Lyr"
    a = result.astrometry
    assert (a.ra_deg, a.dec_deg) == pytest.approx(VEGA, abs=1e-8)
    assert (a.pmra_masyr, a.pmdec_masyr, a.parallax_mas) == (200.94, 286.23, 130.23)
    form = parse_qs(seen[0].content.decode())
    assert seen[0].method == "POST" and str(seen[0].url) == config.SIMBAD_TAP_MIRRORS[0]
    assert form["REQUEST"] == ["doQuery"] and form["LANG"] == ["ADQL"] and form["FORMAT"] == ["json"]
    assert "ident.id = 'Vega'" in form["QUERY"][0]
    client, _ = mock_client(lambda request: httpx.Response(200, content=simbad_empty))
    assert query_simbad_tap("xyzzy notanobject 42", client=client) is None


def test_simbad_tap_error_reply_is_a_mirror_failure() -> None:
    client, _ = mock_client(
        lambda request: httpx.Response(400, content=b"<VOTABLE>Incorrect ADQL query</VOTABLE>")
    )
    with pytest.raises(ResolverUnavailableError, match="HTTP 400"):
        query_simbad_tap("Vega", client=client)


def test_adql_quotes_are_escaped() -> None:
    adql = simbad_adql("Barnard's star")
    assert "ident.id = 'Barnard''s star'" in adql
    assert "ORDER BY" not in adql.upper()
    assert simbad_adql("x' OR '1'='1").count("'") % 2 == 0


def test_display_name() -> None:
    assert display_name("NAME Barnard's star") == "Barnard's star"
    assert display_name("M  31") == "M 31"
    assert display_name("V* R Dra") == "R Dra"
    assert display_name("* alf Lyr") == "alf Lyr"
    assert display_name("WISEA J085510.74-071442.5") == "WISEA J085510.74-071442.5"


# --- full resolve(): mirror order, retries, caching ---------------------------------------------


def test_falls_through_failing_mirror_then_caches(sesame_vega: bytes) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == SESAME_HOSTS[0]:
            return httpx.Response(502)
        return httpx.Response(200, content=sesame_vega)

    client, seen = mock_client(handler)
    result = resolve("Vega", client=client)
    assert result.resolver == f"sesame:{SESAME_HOSTS[1]}"
    assert (result.astrometry.ra_deg, result.astrometry.dec_deg) == VEGA
    assert hosts(seen) == [SESAME_HOSTS[0]] * (1 + resolve_mod.RETRIES) + [SESAME_HOSTS[1]]
    assert len(list((config.CACHE_DIR / "resolve").glob("*.json"))) == 1

    again = resolve("  VEGA ", client=refusing_client())  # case and spacing do not matter for the cache
    assert again.resolver == result.resolver
    assert again.astrometry == result.astrometry
    assert again.query == "  VEGA "


def test_transient_errors_are_retried(sesame_vega: bytes) -> None:
    replies = iter([httpx.Response(503), httpx.Response(429), httpx.Response(200, content=sesame_vega)])
    client, seen = mock_client(lambda request: next(replies))
    assert resolve("Vega", client=client).resolver == f"sesame:{SESAME_HOSTS[0]}"
    assert len(seen) == 3


def test_client_errors_are_not_retried(sesame_vega: bytes) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == SESAME_HOSTS[0]:
            return httpx.Response(404)
        return httpx.Response(200, content=sesame_vega)

    client, seen = mock_client(handler)
    assert resolve("Vega", client=client).resolver == f"sesame:{SESAME_HOSTS[1]}"
    assert hosts(seen) == [SESAME_HOSTS[0], SESAME_HOSTS[1]]


def test_simbad_tap_used_when_sesame_is_down(simbad_vega: bytes) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host in SESAME_HOSTS:
            raise httpx.ConnectError("connection refused", request=request)
        return httpx.Response(200, content=simbad_vega)

    client, seen = mock_client(handler)
    result = resolve("Vega", client=client)
    assert result.resolver == f"simbad:{SIMBAD_HOSTS[0]}"
    assert hosts(seen)[-1] == SIMBAD_HOSTS[0]
    assert len(seen) == len(SESAME_HOSTS) * (1 + resolve_mod.RETRIES) + 1


def test_definitive_not_found(sesame_notfound: bytes, simbad_empty: bytes) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, content=sesame_notfound if request.url.host in SESAME_HOSTS else simbad_empty
        )

    client, seen = mock_client(handler)
    with pytest.raises(NameNotFoundError) as excinfo:
        resolve("xyzzy notanobject 42", client=client)
    assert not isinstance(excinfo.value, ResolverUnavailableError)
    assert hosts(seen) == [SESAME_HOSTS[0], SIMBAD_HOSTS[0]]  # one definitive answer per stage
    assert not (config.CACHE_DIR / "resolve").exists()  # failures are not cached


def test_all_mirrors_down() -> None:
    client, seen = mock_client(lambda request: httpx.Response(503))
    with pytest.raises(ResolverUnavailableError) as excinfo:
        resolve("Vega", client=client)
    assert len(seen) == (len(SESAME_HOSTS) + len(SIMBAD_HOSTS)) * (1 + resolve_mod.RETRIES)
    for host in SESAME_HOSTS + SIMBAD_HOSTS:
        assert host in str(excinfo.value)


def test_time_budget_stops_retrying(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(resolve_mod, "TOTAL_BUDGET_S", 0.0)
    client, seen = mock_client(lambda request: httpx.Response(503))
    with pytest.raises(ResolverUnavailableError, match="time budget"):
        resolve("Vega", client=client)
    assert seen == []


def test_network_answer_for_curated_target_uses_local_astrometry() -> None:
    client, _ = mock_client(lambda request: httpx.Response(200, content=BARNARD_SESAME_XML))
    result = resolve("BD+04 3561a", client=client)
    assert result.resolver == f"sesame:{SESAME_HOSTS[0]}"
    assert result.target_key == "barnards-star"
    assert result.astrometry == TARGETS["barnards-star"].astrometry


def test_letters_with_bad_coordinates_try_names_first(fixtures_dir: Path, sesame_notfound: bytes) -> None:
    m31 = (fixtures_dir / "sky_sesame_m31.xml").read_bytes()
    client, _ = mock_client(lambda request: httpx.Response(200, content=m31))
    assert resolve("1H 0323+342", client=client).resolver.startswith("sesame:")

    client, _ = mock_client(
        lambda request: httpx.Response(
            200, content=sesame_notfound if request.url.host in SESAME_HOSTS else b'{"metadata":[],"data":[]}'
        )
    )
    with pytest.raises(ValueError, match="minutes"):
        resolve("17h 61m 00s +04d00m00s", client=client)


def test_cache_disabled_and_corrupt_cache(sesame_vega: bytes) -> None:
    client, seen = mock_client(lambda request: httpx.Response(200, content=sesame_vega))
    resolve("Vega", client=client, use_cache=False)
    assert not (config.CACHE_DIR / "resolve").exists()
    resolve("Vega", client=client)
    (cache_file,) = (config.CACHE_DIR / "resolve").glob("*.json")
    cache_file.write_text("{not json", encoding="utf-8")
    assert resolve("Vega", client=client).resolver == f"sesame:{SESAME_HOSTS[0]}"
    assert len(seen) == 3
    assert json.loads(cache_file.read_text(encoding="utf-8"))["hit"]["main_id"] == "* alf Lyr"


# --- live mirrors (run with --network) ----------------------------------------------------------


@pytest.mark.network
def test_network_resolve_vega() -> None:
    result = resolve("Vega", use_cache=False)
    assert result.resolver.split(":")[0] in ("sesame", "simbad")
    a = result.astrometry
    assert angular_separation_arcsec(a.ra_deg, a.dec_deg, *VEGA) < 0.5
    assert a.pmra_masyr == pytest.approx(200.94, abs=1.0) and a.pmdec_masyr == pytest.approx(286.23, abs=1.0)
    assert a.parallax_mas == pytest.approx(130.23, abs=1.0)


@pytest.mark.network
def test_network_resolve_m31() -> None:
    result = resolve("M 31", use_cache=False)
    assert result.resolver.split(":")[0] in ("sesame", "simbad")
    assert angular_separation_arcsec(result.astrometry.ra_deg, result.astrometry.dec_deg, *M31) < 2.0


@pytest.mark.network
def test_network_unknown_name() -> None:
    with pytest.raises(NameNotFoundError) as excinfo:
        resolve("xyzzy notanobject 42", use_cache=False)
    assert not isinstance(excinfo.value, ResolverUnavailableError)


@pytest.mark.network
@pytest.mark.parametrize("mirror", config.SESAME_MIRRORS, ids=SESAME_HOSTS)
def test_network_each_sesame_mirror(mirror: str) -> None:
    try:
        result = query_sesame("Vega", mirror)
    except ResolverUnavailableError as exc:
        pytest.skip(f"mirror unavailable: {exc}")
    assert result is not None
    assert angular_separation_arcsec(result.astrometry.ra_deg, result.astrometry.dec_deg, *VEGA) < 0.5


@pytest.mark.network
@pytest.mark.parametrize("mirror", config.SIMBAD_TAP_MIRRORS, ids=SIMBAD_HOSTS)
def test_network_each_simbad_tap_mirror(mirror: str) -> None:
    try:
        result = query_simbad_tap("Vega", mirror)
    except ResolverUnavailableError as exc:
        pytest.skip(f"mirror unavailable: {exc}")
    assert result is not None
    assert angular_separation_arcsec(result.astrometry.ra_deg, result.astrometry.dec_deg, *VEGA) < 0.5
