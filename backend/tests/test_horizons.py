"""JPL Horizons client: parsing a recorded reply, caching, TLIST chunking, retries and the geometry helpers."""

from __future__ import annotations

import json
import math
from urllib.parse import parse_qs, urlparse

import httpx
import numpy as np
import pytest

from pxh import config
from pxh.sky import horizons as h

ARCSEC = 1.0 / 3600.0


@pytest.fixture
def recorded(fixtures_dir) -> dict:
    """A real reply: Pluto, geocentre, 2025-10-01 to 2025-10-03 every 12 h, quantities 1,3,9,19,20,23,24."""
    return json.loads((fixtures_dir / "horizons_pluto_2025-10.json").read_text(encoding="utf-8"))


@pytest.fixture
def cache_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "CACHE_DIR", tmp_path)
    return tmp_path


def _client(handler) -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(handler))


def test_parse_recorded_reply(recorded):
    e = h.parse_result(recorded["response"]["result"])
    assert len(e) == 5
    assert e.target == "Pluto (999)"
    assert e.source == "plu060_merged"
    assert e.mjd_utc[0] == pytest.approx(2460949.5 - 2400000.5)
    assert np.allclose(np.diff(e.mjd_utc), 0.5)
    # First row, read off the reply text.
    assert e.ra_deg[0] == pytest.approx(304.167117073, abs=1e-9)
    assert e.dec_deg[0] == pytest.approx(-23.613595256, abs=1e-9)
    assert e.column("vmag")[0] == pytest.approx(14.521)
    assert e.column("r_au")[0] == pytest.approx(35.35797208489)
    assert e.column("delta_au")[0] == pytest.approx(34.9504934389373)
    assert e.column("elongation_deg")[0] == pytest.approx(113.2745)
    assert e.column("phase_deg")[0] == pytest.approx(1.4876)
    assert e.column("dra_cosdec_arcsec_h")[0] == pytest.approx(-0.89676)
    with pytest.raises(KeyError):
        e.column("airmass")
    rows = e.to_rows()
    assert rows[0]["ra_deg"] == e.ra_deg[0] and "vmag" in rows[0]


def test_rates_agree_with_positions(recorded):
    """The tabulated dRA*cos(Dec) rate matches the finite difference of the positions to 1%."""
    e = h.parse_result(recorded["response"]["result"])
    dra = np.diff(e.ra_deg) * np.cos(np.radians(e.dec_deg[:-1])) * 3600.0 / 12.0  # arcsec per hour
    mid = 0.5 * (e.column("dra_cosdec_arcsec_h")[:-1] + e.column("dra_cosdec_arcsec_h")[1:])
    assert np.allclose(dra, mid, rtol=0.01)


def test_parse_errors():
    with pytest.raises(h.HorizonsError, match="no ephemeris"):
        h.parse_result("No matches found.\n")
    with pytest.raises(h.HorizonsError, match="no column header"):
        h.parse_result("$$SOE\n2460949.5, 1, 2\n$$EOE\n")
    with pytest.raises(h.HorizonsError, match="empty"):
        h.parse_result("Date__JDUT, , , R.A._(ICRF), DEC_(ICRF),\n$$SOE\n$$EOE\n")


def test_build_params():
    p = h.build_params("999", start="2025-04-20", stop="2025-04-21", step="6 h")
    assert p["COMMAND"] == "'999'" and p["CENTER"] == "'500@399'" and p["STEP_SIZE"] == "'6 h'"
    assert p["ANG_FORMAT"] == "'DEG'" and p["TIME_TYPE"] == "'UT'" and "TLIST" not in p
    t = h.build_params("999", tlist_jd=[2460949.5, 2460950.25])
    assert t["TLIST"] == "'2460949.500000000 2460950.250000000'" and t["TLIST_TYPE"] == "'JD'"
    with pytest.raises(ValueError):
        h.build_params("999")
    with pytest.raises(ValueError):
        h.build_params("999", start="2025-04-20", tlist_jd=[2460949.5])
    with pytest.raises(ValueError):
        h.build_params("999", start="2025-04-20")
    with pytest.raises(ValueError):
        h.build_params("999", tlist_jd=[])


def test_fetch_caches_on_disk(recorded, cache_dir):
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.url)
        return httpx.Response(200, json=recorded["response"])

    params = recorded["params"]
    with _client(handler) as c:
        first = h.fetch(params, client=c)
        second = h.fetch(params, client=c)
    assert first == second == recorded["response"]
    assert len(calls) == 1
    assert len(list((cache_dir / "horizons").glob("*.json"))) == 1
    # Different parameters are a different cache entry.
    with _client(handler) as c:
        h.fetch({**params, "STEP_SIZE": "'1 d'"}, client=c)
    assert len(calls) == 2


def test_fetch_retries_server_errors(recorded, cache_dir, monkeypatch):
    monkeypatch.setattr(h.time, "sleep", lambda s: None)
    replies = iter([httpx.Response(503), httpx.Response(502), httpx.Response(200, json=recorded["response"])])
    with _client(lambda request: next(replies)) as c:
        assert h.fetch(recorded["params"], client=c, use_cache=False) == recorded["response"]


def test_fetch_does_not_retry_a_bad_request(cache_dir, monkeypatch):
    monkeypatch.setattr(h.time, "sleep", lambda s: None)
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        return httpx.Response(400, json={"error": "Cannot interpret date"})

    with _client(handler) as c, pytest.raises(h.HorizonsError, match="Cannot interpret"):
        h.fetch(h.build_params("999", tlist_jd=[2460949.5]), client=c)
    assert len(calls) == 1


def test_fetch_gives_up_after_the_attempts(cache_dir, monkeypatch):
    monkeypatch.setattr(h.time, "sleep", lambda s: None)
    with _client(lambda request: httpx.Response(503)) as c, pytest.raises(h.HorizonsError, match="attempts"):
        h.fetch(h.build_params("999", tlist_jd=[2460949.5]), client=c)


def _tlist_reply(request: httpx.Request) -> httpx.Response:
    """A minimal Horizons-style reply with one row per requested JD (RA = JD - 2460000, Dec = -23)."""
    q = parse_qs(urlparse(str(request.url)).query)
    jds = [float(t) for t in q["TLIST"][0].strip("'").split()]
    head = "Target body name: Pluto (999)                   {source: plu060_merged}\n"
    head += "Date_________JDUT, , , R.A.___(ICRF), DEC____(ICRF),    APmag,\n"
    rows = "".join(f"{jd:.9f}, , , {jd - 2460000.0:.9f}, -23.0,   14.5,\n" for jd in jds)
    return httpx.Response(200, json={"result": head + "$$SOE\n" + rows + "$$EOE\n"})


def test_ephemeris_at_chunks_dedupes_and_sorts(cache_dir, monkeypatch):
    monkeypatch.setattr(h, "TLIST_CHUNK", 2)
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return _tlist_reply(request)

    mjds = [60952.25, 60950.5, 60951.0, 60950.5, 60953.75]
    with _client(handler) as c:
        e = h.ephemeris_at("999", mjds, client=c)
    assert len(seen) == 2  # four distinct times in chunks of two
    assert np.allclose(e.mjd_utc, [60950.5, 60951.0, 60952.25, 60953.75])
    assert np.allclose(e.ra_deg, e.mjd_utc + 2400000.5 - 2460000.0)
    assert e.target == "Pluto (999)" and np.allclose(e.column("vmag"), 14.5)
    with pytest.raises(ValueError):
        h.ephemeris_at("999", [])


def test_ephemeris_range_uses_the_parser(recorded, cache_dir):
    with _client(lambda request: httpx.Response(200, json=recorded["response"])) as c:
        e = h.ephemeris("999", "2025-10-01", "2025-10-03", "12 h", client=c)
    assert len(e) == 5 and e.source == "plu060_merged"


def _great_circle(t: np.ndarray, ra0: float, rate_deg_per_day: float) -> tuple[np.ndarray, np.ndarray]:
    """Points along the equator crossing RA = 0, rotated to Dec ~ -23 deg about the x axis."""
    lon = np.radians(ra0 + rate_deg_per_day * t)
    v = np.stack([np.cos(lon), np.sin(lon), np.zeros_like(lon)], axis=-1)
    tilt = math.radians(23.0)
    rot = np.array([[1, 0, 0], [0, math.cos(tilt), -math.sin(tilt)], [0, math.sin(tilt), math.cos(tilt)]])
    return h.radec_of(v @ rot.T)


def test_interpolation_across_ra_zero():
    t = np.arange(0.0, 10.0, 0.25)
    ra, dec = _great_circle(t, -1.0, 0.2)  # crosses RA = 0 near t = 5
    e = h.Ephemeris("test", "", h.GEOCENTRE, t, ra, dec)
    at = np.array([4.9, 5.0125, 5.3])
    ra_i, dec_i = e.interp(at)
    ra_t, dec_t = _great_circle(at, -1.0, 0.2)
    assert np.all(h.separation_arcsec(ra_i, dec_i, ra_t, dec_t) < 1e-3)
    with pytest.raises(ValueError, match="outside"):
        e.interp([10.5])


def test_interp_column():
    t = np.arange(0.0, 5.0, 0.5)
    e = h.Ephemeris("test", "", h.GEOCENTRE, t, t, t * 0, {"delta_au": 34.0 + 0.01 * t})
    assert e.interp_column("delta_au", 1.25) == pytest.approx(34.0125)


def test_observer_offset_parallax():
    """An observer 1000 km off the line of sight sees a body at 1 au displaced by atan(1000 km / 1 au)."""
    ra, dec = h.observer_offset(0.0, 0.0, 1.0, [0.0, 1000.0, 0.0])
    expected = math.degrees(math.atan2(1000.0, h.AU_KM)) * 3600.0  # 1.379 arcsec
    assert expected == pytest.approx(1.3787, abs=1e-3)
    assert h.separation_arcsec(0.0, 0.0, ra, dec) == pytest.approx(expected, rel=1e-6)
    assert float(ra) > 359.0 and float(dec) == pytest.approx(0.0, abs=1e-12)  # moved west, away from +y
    # An offset along the line of sight changes nothing.
    ra2, dec2 = h.observer_offset(0.0, 0.0, 1.0, [5000.0, 0.0, 0.0])
    assert h.separation_arcsec(0.0, 0.0, ra2, dec2) < 1e-9
    # Pluto at 35 au and Dec -23, SPHEREx 7,026 km north of the geocentre: the offset across the line of
    # sight is 7,026 km x cos(23 deg), a shift of 0.255 arcsec (0.277 arcsec at right angles).
    ra3, dec3 = h.observer_offset(304.0, -23.0, 35.0, [0.0, 0.0, 7026.0])
    shift = float(h.separation_arcsec(304.0, -23.0, ra3, dec3))
    full = 7026.0 / (35.0 * h.AU_KM) * 206264.806
    assert full == pytest.approx(0.2768, abs=1e-3)
    assert shift == pytest.approx(full * math.cos(math.radians(23.0)), rel=1e-3)
    assert float(dec3) < -23.0  # an observer further north sees the body further south


def test_separation_and_vectors():
    assert h.separation_arcsec(10.0, 20.0, 10.0, 20.0 + ARCSEC) == pytest.approx(1.0, rel=1e-9)
    assert h.separation_arcsec(0.0, 0.0, 180.0, 0.0) == pytest.approx(180.0 * 3600.0)
    ra, dec = h.radec_of(h.unit_vector([359.5, 12.0], [-89.0, 45.0]))
    assert np.allclose(ra, [359.5, 12.0]) and np.allclose(dec, [-89.0, 45.0])
