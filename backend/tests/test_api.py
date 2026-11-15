"""Offline tests of the HTTP API (pxh.api) with FastAPI's TestClient; the network layer is mocked.

Synthetic SIA rows and byte-range stamps (a star moving two pixels between epochs on a flat, noisy sky) run
through the real index, co-add, difference and rendering code, and every response is checked against the
pydantic mirrors of docs/api-contract.md (pxh.api.schemas).
"""

from __future__ import annotations

import base64
import io
import json
import math

import numpy as np
import pytest
from astropy.io.fits import Header
from astropy.wcs import WCS
from fastapi.testclient import TestClient
from PIL import Image

from pxh import config
from pxh.api import catalogs, field, routes
from pxh.api.app import create_app
from pxh.api.schemas import (
    FieldManifest,
    FieldSummary,
    GaiaSource,
    Health,
    QuickSpectrum,
    Resolved,
    TargetSummary,
)
from pxh.api.settings import DEFAULT_ALLOWED_ORIGINS, parse_origins
from pxh.models import DetectorImage, Stamp
from pxh.sky.resolve import NameNotFoundError, ResolverUnavailableError
from pxh.spherex import sia

RA, DEC = 150.0, 2.2
EPOCH_MJDS = (60900.0, 61100.0)  # Aug 2025 and Mar 2026 (both Year 1)
PER_EPOCH = 4
CDN = "public, s-maxage=86400, stale-while-revalidate=604800"


# --- fakes ----------------------------------------------------------------------------------------------


def _image(obs_id: str, det: int, mjd: float, collection: str = "spherex_dr1") -> DetectorImage:
    name = f"level2_{obs_id}D{det}_spx_l2b-v27-2026-228.fits"
    return DetectorImage(
        obs_id=obs_id,
        detector=det,
        collection=collection,
        publisher_did=f"ivo://irsa.ipac/{collection}?{obs_id}/D{det}",
        access_url=f"https://irsa.ipac.caltech.edu/ibe/data/spherex/qr/level2/{name}",
        t_min_mjd=mjd,
        t_max_mjd=mjd + 0.0013,
        em_min_um=config.DETECTOR_BANDS_UM[det][0],
        em_max_um=config.DETECTOR_BANDS_UM[det][1],
        exptime_s=113.6,
        s_region="POLYGON ICRS 151 1 149 1 149 3 151 3",
        release_date="2026-08-20T00:00:00",
        file_tag="l2b-v27-2026-228",
    )


def fake_images() -> list[DetectorImage]:
    out = []
    for e, mjd0 in enumerate(EPOCH_MJDS):
        for k in range(PER_EPOCH):
            mjd = mjd0 + 2.0 * k
            out += [_image(f"E{e}K{k}_36", 3, mjd), _image(f"E{e}K{k}_36", 6, mjd)]
            out.append(_image(f"E{e}K{k}_14", 1, mjd + 0.01))
    return out


def fake_stamp(image: DetectorImage, ra: float, dec: float, grid_n: int, use_cache: bool) -> Stamp:
    n = grid_n + 12
    scale = config.PIXEL_SCALE_ARCSEC / 3600.0
    wcs = WCS(naxis=2)
    wcs.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    wcs.wcs.crval = [ra, dec]
    wcs.wcs.crpix = [(n + 1) / 2.0 + 0.3, (n + 1) / 2.0 - 0.2]
    wcs.wcs.cdelt = [-scale, scale]
    wcs.wcs.set()
    rng = np.random.default_rng(abs(hash(image.publisher_did)) % 2**32)
    yy, xx = np.mgrid[0:n, 0:n]
    later = image.t_min_mjd > 61000.0
    x0, y0 = (n - 1) / 2.0, (n - 1) / 2.0 + (2.0 if later else 0.0)  # moves 2 px north
    star = 50.0 * np.exp(-((xx - x0) ** 2 + (yy - y0) ** 2) / (2 * 0.8**2))
    zodi = np.full((n, n), 0.5, dtype=np.float32)
    data = (zodi + star + rng.normal(0.0, 0.1, (n, n))).astype(np.float32)
    flags = np.zeros((n, n), dtype=np.int32)
    if image.detector == 1 and not later:
        flags[round(y0), round(x0)] = 1 << 1  # OVERFLOW at the core of the early D1 frames
    header = Header()
    header["MJD-AVG"] = image.t_min_mjd + 0.0007
    header["PSF_FWHM"] = 9.0
    return Stamp(
        image=image,
        x0=0,
        y0=0,
        data=data,
        variance=np.full((n, n), 0.01, dtype=np.float32),
        zodi=zodi,
        flags=flags,
        wcs=wcs,
        header=header,
        mjd_avg=image.t_min_mjd + 0.0007,
        wavelength_um=np.full((n, n), float(np.mean(config.DETECTOR_BANDS_UM[image.detector])), dtype=np.float32),
        bandwidth_um=None,
        flag_bits={"TRANSIENT": 0, "OVERFLOW": 1, "SOURCE": 2},
    )


def _catalog() -> sia.CollectionCatalog:
    infos = (
        sia.CollectionInfo("spherex_dr1", "image", 2),
        sia.CollectionInfo("spherex_dr1_cube", "cube", 3),
        sia.CollectionInfo("spherex_qr3", "image", 2),
    )
    return sia.CollectionCatalog(infos, 1_763_150_000.0, "cache")


@pytest.fixture
def api(monkeypatch: pytest.MonkeyPatch, tmp_path) -> TestClient:
    monkeypatch.setattr(config, "CACHE_DIR", tmp_path / "cache")
    field.clear_caches()
    catalogs._MEMO.clear()
    images = fake_images()

    def search_position(ra, dec, radius_deg=0.0005, collections=None, *args, **kwargs):
        hits = tuple(images) if (round(ra, 3), round(dec, 3)) == (RA, DEC) else ()
        return [sia.CollectionSearch("spherex_dr1", hits, "network", fetched_at=1.0, n_rows=len(hits)),
                sia.CollectionSearch("spherex_qr3", (), "network", fetched_at=1.0)]

    monkeypatch.setattr(sia, "collection_catalog", lambda *a, **k: _catalog())
    monkeypatch.setattr(sia, "discover_l2_collections", lambda *a, **k: ["spherex_dr1", "spherex_qr3"])
    monkeypatch.setattr(sia, "search_position", search_position)
    monkeypatch.setattr(field, "header_pa", lambda im: 180 if im.t_min_mjd < 61000 else 0)
    monkeypatch.setattr(field, "fetch_stamp", fake_stamp)
    with TestClient(create_app()) as client:
        yield client
    field.clear_caches()


def _png(url: str) -> Image.Image:
    assert url.startswith("data:image/png;base64,")
    return Image.open(io.BytesIO(base64.b64decode(url.split(",", 1)[1])))


def _no_schema(doc: dict) -> dict:
    data = dict(doc)
    data["schema_"] = data.pop("schema")
    return data


# --- endpoints ------------------------------------------------------------------------------------------


def test_health(api: TestClient) -> None:
    r = api.get("/api/health")
    assert r.status_code == 200
    assert r.headers["cache-control"] == "no-store"
    doc = Health.model_validate(r.json())
    assert "spherex_dr1" in doc.collections and doc.collections_source == "cache"


def test_targets(api: TestClient) -> None:
    r = api.get("/api/targets")
    assert r.status_code == 200 and r.headers["cache-control"] == CDN
    rows = [TargetSummary.model_validate(t) for t in r.json()]
    assert [t.key for t in rows] == ["barnards-star", "eps-indi-b", "wise-0855", "rw-aur", "r-dra"]
    barnard = rows[0]
    assert barnard.bundle == "/bundles/barnards-star/manifest.json"
    assert barnard.dec == pytest.approx(4.77, abs=0.01)  # moved from 4.739 (2016.0) to today
    assert all(len(t.summary_plain) > 80 for t in rows)


def test_resolve_local_table(api: TestClient) -> None:
    r = api.get("/api/resolve", params={"q": "Barnard's Star"})
    assert r.status_code == 200 and r.headers["cache-control"] == CDN
    doc = Resolved.model_validate(r.json())
    assert doc.resolver == "local-table" and doc.target_key == "barnards-star"
    assert doc.dec_j2000 == pytest.approx(4.6934, abs=1e-3)
    assert doc.dec - doc.dec_j2000 == pytest.approx(10.36 * 26.9 / 3600.0, rel=0.05)


def test_resolve_coordinates(api: TestClient) -> None:
    doc = api.get("/api/resolve", params={"q": "10h00m00s +02d12m00s"}).json()
    assert doc["resolver"] == "coordinates"
    assert doc["ra"] == pytest.approx(150.0) and doc["dec"] == pytest.approx(2.2)


@pytest.mark.parametrize(
    ("exc", "status", "code"),
    [
        (NameNotFoundError("nope"), 404, "not_found"),
        (ResolverUnavailableError("all down"), 503, "resolver_unavailable"),
        (ValueError("bad coordinates"), 422, "invalid_input"),
    ],
)
def test_resolve_errors(api: TestClient, monkeypatch: pytest.MonkeyPatch, exc: Exception, status: int, code: str) -> None:
    def boom(q):
        raise exc

    monkeypatch.setattr(routes, "resolve", boom)
    r = api.get("/api/resolve", params={"q": "Xyzzy"})
    assert r.status_code == status
    assert r.json()["error"] == code
    assert r.json()["retryable"] is (status == 503)
    assert r.headers["cache-control"] == "no-store"


def test_releases(api: TestClient) -> None:
    r = api.get("/api/releases")
    assert r.status_code == 200 and "s-maxage=900" in r.headers["cache-control"]
    kinds = {c["name"]: (c["kind"], c["latest_release"]) for c in r.json()["collections"]}
    assert kinds == {"spherex_dr1": ("l2", "DR1"), "spherex_dr1_cube": ("cube", "DR1"), "spherex_qr3": ("l2", "QR3")}


def test_field_summary(api: TestClient) -> None:
    r = api.get("/api/field/summary", params={"ra": RA, "dec": DEC, "fov": 10})
    assert r.status_code == 200 and r.headers["cache-control"] == CDN
    doc = FieldSummary.model_validate(_no_schema(r.json()))
    assert doc.n_images == 3 * PER_EPOCH * 2 and doc.n_exposures == 2 * PER_EPOCH * 2 and doc.n_epochs == 2
    assert [(e.label, e.survey, e.pa, e.year) for e in doc.epochs] == [("Aug 2025", "S2", 180, 1), ("Mar 2026", "S1", 0, 1)]
    assert doc.epochs[0].detectors == {"1": 4, "3": 4, "6": 4} and doc.epochs[0].full is False
    assert doc.detectors["D6"] == 8 and doc.detectors["D2"] == 0
    assert doc.release.collections == ["spherex_dr1"] and doc.release.latest_obs == "2026-03-07"  # MJD 61106


def test_field_summary_empty_sky(api: TestClient) -> None:
    doc = api.get("/api/field/summary", params={"ra": 10.0, "dec": -40.0}).json()
    assert doc["n_images"] == 0 and doc["epochs"] == []


def test_field_build_detector(api: TestClient) -> None:
    r = api.get("/api/field/build", params={"ra": RA, "dec": DEC, "fov": 6, "det": "D6", "modes": "epoch,difference"},
                headers={"Accept-Encoding": "gzip"})
    assert r.status_code == 200, r.text
    assert r.headers["cache-control"] == CDN and r.headers.get("content-encoding") == "gzip"
    doc = r.json()
    FieldManifest.validate_manifest(doc)
    assert doc["source"] == "live" and doc["target"] is None and doc["schema"] == "pxh-field/1"
    n = doc["grid"]["width"]
    assert n == doc["grid"]["height"] == 59 and doc["grid"]["wcs"]["CRVAL1"] == RA
    frames = doc["frames"]["epoch"]["D6"]
    assert [f["epoch"] for f in frames] == [0, 1] and all(f["n"] == PER_EPOCH for f in frames)
    assert set(doc["frames"]["epoch"]) == {"D6"}
    for f in frames:
        assert _png(f["url"]).size == (n, n)
        assert f["wl_um"] == [4.71, 4.71]
    (d,) = doc["frames"]["difference"]
    assert (d["detector"], d["a"], d["b"], d["units"]) == ("D6", 1, 0, "sigma")
    assert d["limits"][0] == -d["limits"][1] and d["limits"][1] >= 5.0
    assert doc["frames"]["flags"] == [] and doc["frames"]["then_vs_now"] == []
    assert doc["build"]["n_images_used"] == 2 * PER_EPOCH and doc["build"]["n_images_failed"] == 0
    for key in ("motion", "spectrum", "lightcurve"):
        assert key in doc and doc[key] is None
    assert "n" in frames[0] and "channels" not in frames[0]  # optional TS fields omitted, never null


def test_field_build_detectors_share_grid_and_flags(api: TestClient) -> None:
    d3 = api.get("/api/field/build", params={"ra": RA, "dec": DEC, "fov": 6, "det": "D3"}).json()
    d1 = api.get("/api/field/build", params={"ra": RA, "dec": DEC, "fov": 6, "det": "d1", "modes": "epoch,flags"}).json()
    d6 = api.get("/api/field/build", params={"ra": RA, "dec": DEC, "fov": 6, "det": "D6"}).json()
    assert d3["grid"] == d6["grid"] == d1["grid"]
    assert d1["frames"]["difference"] == []  # not requested
    flags = d1["frames"]["flags"]
    assert flags and flags[0]["detector"] == "D1" and flags[0]["epoch"] == 0
    assert flags[0]["legend"] == {"saturated": "#f2895a"} and _png(flags[0]["url"]).mode == "RGBA"


def test_field_build_rgb(api: TestClient) -> None:
    doc = api.get("/api/field/build", params={"ra": RA, "dec": DEC, "fov": 4, "det": "rgb"}).json()
    FieldManifest.validate_manifest(doc)
    rgb = doc["frames"]["epoch"]["rgb"]
    assert [f["epoch"] for f in rgb] == [0, 1] and all(f["channels"] == "D1/D3/D6" for f in rgb)
    assert _png(rgb[0]["url"]).mode in ("RGB", "RGBA") and doc["frames"]["difference"] == []


def test_field_build_no_coverage(api: TestClient) -> None:
    r = api.get("/api/field/build", params={"ra": 10.0, "dec": -40.0})
    assert r.status_code == 404 and r.json()["error"] == "no_coverage"
    assert r.headers["cache-control"] == "no-store"


def test_field_build_archive_down(api: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    failed = [sia.CollectionSearch("spherex_dr1", (), "failed", error="HTTP 502")]
    monkeypatch.setattr(sia, "search_position", lambda *a, **k: failed)
    r = api.get("/api/field/build", params={"ra": 20.0, "dec": 5.0})
    assert r.status_code == 503
    assert r.json()["error"] == "archive_unavailable" and r.json()["retryable"] is True


def test_field_build_tolerates_bad_images(api: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    def flaky(image, ra, dec, grid_n, use_cache):
        if image.obs_id.startswith("E0K0"):
            raise OSError("connection reset")
        return fake_stamp(image, ra, dec, grid_n, use_cache)

    monkeypatch.setattr(field, "fetch_stamp", flaky)
    doc = api.get("/api/field/build", params={"ra": RA, "dec": DEC, "fov": 6, "det": "D6"}).json()
    assert doc["build"]["n_images_failed"] == 1 and doc["frames"]["epoch"]["D6"][0]["n"] == PER_EPOCH - 1
    assert any("could not be read" in w for w in doc["warnings"])


@pytest.mark.parametrize(
    ("path", "params", "status", "needle"),
    [
        ("/api/field/summary", {"ra": 150, "dec": 95}, 422, "dec"),
        ("/api/field/summary", {"ra": 400, "dec": 0}, 422, "ra"),
        ("/api/field/build", {"ra": 150, "dec": 2.2, "fov": 45}, 422, "fov"),
        ("/api/field/build", {"ra": 150, "dec": 2.2, "fov": 1}, 422, "fov"),
        ("/api/field/build", {"ra": "abc", "dec": 2.2}, 422, "ra"),
        ("/api/field/build", {"dec": 2.2}, 422, "ra"),
        ("/api/field/build", {"ra": 150, "dec": 2.2, "det": "D7"}, 422, "det"),
        ("/api/field/build", {"ra": 150, "dec": 2.2, "modes": "epoch,movie"}, 422, "movie"),
        ("/api/field/build", {"ra": 150, "dec": 2.2, "det": "then_vs_now"}, 501, "then_vs_now"),
        ("/api/catalog/gaia", {"ra": 150, "dec": 2.2, "radius_arcmin": 60}, 422, "radius"),
        ("/api/nowhere", {}, 404, "Not Found"),
    ],
)
def test_input_errors(api: TestClient, path: str, params: dict, status: int, needle: str) -> None:
    r = api.get(path, params=params)
    assert r.status_code == status
    body = r.json()
    assert set(body) >= {"error", "message", "retryable"} and needle in body["message"]
    assert r.headers["cache-control"] == "no-store"


def test_unexpected_error_is_json_with_cors(api: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    def boom(*a, **k):
        raise RuntimeError("kaput")

    monkeypatch.setattr(field, "field_summary", boom)
    r = api.get("/api/field/summary", params={"ra": RA, "dec": DEC}, headers={"Origin": "http://localhost:3000"})
    assert r.status_code == 500 and r.json()["error"] == "internal"
    assert r.headers["access-control-allow-origin"] == "http://localhost:3000"


def test_cors(api: TestClient) -> None:
    ok = api.get("/api/health", headers={"Origin": "https://perturbation-git-main-team.vercel.app"})
    assert ok.headers["access-control-allow-origin"] == "https://perturbation-git-main-team.vercel.app"
    assert "access-control-allow-origin" not in api.get("/api/health", headers={"Origin": "https://evil.example"}).headers
    pre = api.options(
        "/api/field/build",
        headers={"Origin": "http://localhost:3000", "Access-Control-Request-Method": "GET"},
    )
    assert pre.status_code == 200 and pre.headers["access-control-allow-origin"] == "http://localhost:3000"


def test_parse_origins() -> None:
    exact, regex = parse_origins("http://localhost:3000, https://*.vercel.app ,https://example.org/")
    assert exact == ("http://localhost:3000", "https://example.org")
    import re

    assert re.fullmatch(regex, "https://a-b-c.vercel.app")
    assert not re.fullmatch(regex, "https://evil.com/x.vercel.app")
    assert not re.fullmatch(regex, "http://a.vercel.app")


def test_default_origins_match_production() -> None:
    # The same list as ALLOWED_ORIGINS on Vercel: the site's domain, its deployments and local development.
    exact, regex = parse_origins(DEFAULT_ALLOWED_ORIGINS)
    assert exact == ("http://localhost:3000", "https://perturbation.earth", "https://www.perturbation.earth")
    import re

    assert re.fullmatch(regex, "https://perturbation-git-main-team.vercel.app")
    assert not re.fullmatch(regex, "https://perturbation.earth.evil.example")


def test_cors_custom_domain(api: TestClient) -> None:
    for origin in ("https://perturbation.earth", "https://www.perturbation.earth"):
        r = api.get("/api/health", headers={"Origin": origin})
        assert r.headers["access-control-allow-origin"] == origin


def test_quick_spectrum(api: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    wl = np.linspace(0.75, 5.0, 102)[::-1]
    flux = np.full(102, 12.5)
    flux[[50, 51]] = np.nan
    fake = {
        "wavelength_um": wl, "bandwidth_um": wl / 40, "flux_ujy": flux, "flux_err_ujy": flux / 10,
        "flux_partial_ujy": flux, "lower_limit": np.zeros(102, dtype=bool), "label": "DR1 quick-look",
        "n_finite": 100, "pixel_arcsec": 12.88, "notes": "quick look",
    }
    monkeypatch.setattr(routes.cube, "cube_spectrum", lambda ra, dec: fake)
    r = api.get("/api/spectrum/quick", params={"ra": RA, "dec": DEC})
    assert r.status_code == 200
    doc = QuickSpectrum.model_validate(r.json())
    assert len(doc.wl_um) == 102 and doc.wl_um == sorted(doc.wl_um)
    assert doc.flux_ujy.count(None) == 2 and doc.label == "DR1 quick-look"


IPAC = """\\fixlen = T
|   source_id         |   ra        |   dec      | phot_g_mean_mag | bp_rp  |   pmra     |   pmdec    | parallax |
|   long              |   double    |   double   | double          | double |   double   |   double   | double   |
 4472832130942575872    269.4485025   4.7394201    8.1940           2.8336   -801.551     10362.394   546.9759
 4472832130942575999    269.4500000   4.7500000    null             null     null         null        null
"""


def test_gaia_catalog(api: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    calls = []

    def http_get(url, params=None, **kwargs):
        calls.append(params)
        return IPAC.encode()

    monkeypatch.setattr(catalogs.rangeio, "http_get", http_get)
    params = {"ra": 269.45, "dec": 4.75, "radius_arcmin": 3, "epoch_mjd": 61300}
    rows = [GaiaSource.model_validate(s) for s in api.get("/api/catalog/gaia", params=params).json()]
    assert calls[0]["catalog"] == "gaia_dr3_source" and calls[0]["radius"] == "180.0"
    assert rows[0].source_id == "4472832130942575872"
    years = (61300 - 51544.5) / 365.25 - 16.0
    assert rows[0].dec == pytest.approx(4.7394201 + 10.362394 * years / 3600.0, abs=1e-6)
    assert rows[1].g is None and rows[1].ra == pytest.approx(269.45)
    api.get("/api/catalog/gaia", params=params)
    assert len(calls) == 1  # answered from the cache the second time


def test_respond_streams_large_bodies() -> None:
    resp = routes.respond({"blob": "x" * (routes.STREAM_ABOVE_BYTES + 10)})
    assert type(resp).__name__ == "StreamingResponse"
    assert routes.clean({"a": math.nan, "b": (1, np.float32(2.5))}) == {"a": None, "b": [1, 2.5]}
    assert json.loads(routes.respond({"a": float("inf")}).body) == {"a": None}
