"""Offline tests of /api/object and /api/patch (pxh.api.lookup): Gator, SIMBAD, SIA and the cube are faked.

The fake Gator answers real IPAC tables for a tiny sky (Barnard's Star at its Gaia DR3 2016.0 position, a
faint neighbour, a faint source near Barnard's Star's 2026 position, a faint star next to Sirius) and
filters them by the cone it is asked for, so the proper-motion handling is tested end to end.
"""

from __future__ import annotations

import math
import re
import time

import httpx
import numpy as np
import pytest
from fastapi.testclient import TestClient

from pxh import config
from pxh.api import catalogs, field, lookup
from pxh.api.app import create_app
from pxh.models import DetectorImage
from pxh.spherex import sia

CDN = "public, s-maxage=86400, stale-while-revalidate=604800"
# Barnard's Star in the Hipparcos-based star files: J2026.0 position and Hipparcos proper motion
BARNARD_2026 = {"ra": 269.44629, "dec": 4.76798, "epoch": 2026.0, "pmra": -798.58, "pmdec": 10328.12, "hip": 87937}
SIRIUS_2026 = {"ra": 101.28304, "dec": -16.72495, "epoch": 2026.0, "pmra": -546.01, "pmdec": -1223.07, "hip": 32349}

GAIA_COLUMNS = lookup.GAIA_OBJECT_COLUMNS.split(",")
#            source_id             ra               dec             G          bp_rp     plx       e_plx   pmra      pmdec      rv       teff    logg   ruwe   var
SKY = [
    ("4472832130942575872", 269.44850252544, 4.73942005111, 8.193974, 2.833697, 546.9759, 0.0401, -801.551, 10362.394,
     -110.47, 3099.6, 4.764, 1.085, "NOT_AVAILABLE"),
    ("4472832818126065408", 269.44988505182, 4.73985735848, 19.879988, 1.316824, 1.1968, 1.4128, 1.306, -0.842,
     None, None, None, 1.42, "NOT_AVAILABLE"),
    ("4472835979229621248", 269.4467439, 4.7674334, 20.8973, 2.0757, 0.5, 0.9, -2.0, -3.0,
     None, None, None, 1.0, "NOT_AVAILABLE"),
    ("2947050466531873999", 101.2885, -16.7151, 12.5, 0.9, 1.0, 0.1, -1.0, -1.0,
     None, None, None, 1.0, "NOT_AVAILABLE"),
]


SIMBAD_SKY = [  # ICRS at J2000, as SIMBAD gives them
    ["NAME Barnard's star", "BY*", "M4V", 269.4520769586187, 4.693364966576667, -801.551, 10362.394, 546.9759, 9.511,
     "Gaia DR3 4472832130942575872"],
    ["* alf CMa", "SB*", "A0mA1Va", 101.28715533333335, -16.71611586111111, -546.01, -1223.07, 379.21, -1.46, None],
]


def _ipac(columns: list[str], rows: list[tuple]) -> str:
    head = "\\fixlen = T\n|" + "|".join(f" {c} " for c in columns) + "|\n|" + "|".join(" x " for _ in columns) + "|\n"
    body = "".join(" " + "  ".join("null" if v is None else str(v) for v in row) + "\n" for row in rows)
    return head + body


def _sep_arcsec(ra1, dec1, ra2, dec2) -> float:
    return lookup.separation_arcsec(ra1, dec1, ra2, dec2)


class FakeServices:
    """httpx.Client stand-in: IRSA Gator (GET) and SIMBAD TAP (POST)."""

    def __init__(self) -> None:
        self.gator_calls: list[dict] = []
        self.simbad_calls: list[str] = []
        self.gator_error: Exception | None = None
        self.count_density = 30  # sources to G = 18 within 2 arcmin
        self.bright_rows = 3

    # Gator -------------------------------------------------------------------------------------
    def get(self, url, params=None, timeout=None):
        assert url == config.IRSA_GATOR_URL
        self.gator_calls.append(dict(params))
        if self.gator_error is not None:
            raise self.gator_error
        ra, dec = (float(v) for v in params["objstr"].split())
        radius = float(params["radius"])
        c = params.get("constraints") or ""
        if "phot_g_mean_mag<18" in c:
            n = round(self.count_density * (radius / 120.0) ** 2)
            text = _ipac(["phot_g_mean_mag"], [(15.0,)] * n)
        elif c.startswith("phot_g_mean_mag<"):
            limit = float(c.split("<")[1])
            n = self.bright_rows if limit <= 12 else self.bright_rows + 4
            cols = lookup.GAIA_BRIGHT_COLUMNS.split(",")
            rows = [(f"10000{k}", ra + 0.01 * k, dec, 9.0 + k, 1.0, 10.0, 0.1, 1.0, 1.0) for k in range(n)]
            text = _ipac(cols, rows)
        else:
            fast_only = "pmra*pmra" in c
            hits = [r for r in SKY if _sep_arcsec(ra, dec, r[1], r[2]) <= radius
                    and (not fast_only or math.hypot(r[7], r[8]) > 300)]
            text = _ipac(GAIA_COLUMNS, hits)
        return httpx.Response(200, text=text, request=httpx.Request("GET", url))

    # SIMBAD ------------------------------------------------------------------------------------
    def post(self, url, data=None, timeout=None):
        query = data["QUERY"]
        self.simbad_calls.append(query)
        cols = ["main_id", "otype", "sp_type", "ra", "dec", "pmra", "pmdec", "plx_value", "vmag", "gaia_id"]
        rows: list[list] = []
        if "i.id = 'HIP 87937'" in query:
            rows = [SIMBAD_SKY[0]]
        elif "i.id = 'HIP 32349'" in query:
            rows = [SIMBAD_SKY[1]]
        elif "i.id IN (" in query:
            cols = ["id", "main_id", "otype"]
            rows = [["Gaia DR3 100000", "* alf Tst", "PM*"], ["Gaia DR3 100002", "NAME Test Nebula", "HII"]]
        elif "CONTAINS(" in query:
            cols = [*cols, "dist"]
            ra, dec, r = (float(v) for v in re.search(r"CIRCLE\('ICRS', ([^,]+), ([^,]+), ([^)]+)\)", query).groups())
            fast = "b.pmra*b.pmra" in query
            for row in SIMBAD_SKY:
                d = _sep_arcsec(ra, dec, row[3], row[4]) / 3600.0
                if d <= r and (not fast or math.hypot(row[5], row[6]) > 300):
                    rows.append([*row, d])
        doc = {"metadata": [{"name": c} for c in cols], "data": rows}
        return httpx.Response(200, json=doc, request=httpx.Request("POST", url))


def _image(obs_id: str, det: int, mjd: float, collection: str = "spherex_dr1") -> DetectorImage:
    name = f"level2_{obs_id}D{det}_spx_l2b-v27-2026-228.fits"
    return DetectorImage(
        obs_id=obs_id, detector=det, collection=collection,
        publisher_did=f"ivo://irsa.ipac/{collection}?{obs_id}/D{det}",
        access_url=f"https://irsa.ipac.caltech.edu/ibe/data/spherex/qr/level2/{name}",
        t_min_mjd=mjd, t_max_mjd=mjd + 0.0013, em_min_um=config.DETECTOR_BANDS_UM[det][0],
        em_max_um=config.DETECTOR_BANDS_UM[det][1], exptime_s=113.6, s_region="", release_date="2026-08-20",
        file_tag="l2b-v27-2026-228",
    )


def fake_images() -> list[DetectorImage]:
    out = []
    for e, mjd0 in enumerate((60900.0, 61100.0, 61300.0)):  # Aug 2025, Mar 2026, Sep 2026
        for k in range(3):
            out += [_image(f"E{e}K{k}_36", 3, mjd0 + k), _image(f"E{e}K{k}_36", 6, mjd0 + k)]
    return out


def fake_spectrum(ra: float, dec: float) -> dict:
    wl = np.linspace(0.75, 5.0, 102)[::-1]
    flux = np.full(102, 12.5)
    flux[[50, 51]] = np.nan
    return {
        "wavelength_um": wl, "bandwidth_um": wl / 40, "flux_ujy": flux, "flux_err_ujy": flux / 10,
        "flux_partial_ujy": flux, "lower_limit": np.zeros(102, dtype=bool), "label": "DR1 quick-look",
        "n_finite": 100, "pixel_arcsec": 12.88, "notes": "quick look",
    }


@pytest.fixture
def services(monkeypatch: pytest.MonkeyPatch, tmp_path) -> FakeServices:
    monkeypatch.setattr(config, "CACHE_DIR", tmp_path / "cache")
    lookup.clear_caches()
    field.clear_caches()
    catalogs._MEMO.clear()
    fake = FakeServices()
    monkeypatch.setattr(lookup, "_http", lambda: fake)
    images = fake_images()

    def search_position(ra, dec, radius_deg=0.0005, collections=None, *args, **kwargs):
        hits = tuple(images) if dec > 0 else ()
        return [sia.CollectionSearch("spherex_dr1", hits, "network", fetched_at=1.0, n_rows=len(hits)),
                sia.CollectionSearch("spherex_qr3", (), "network", fetched_at=1.0)]

    monkeypatch.setattr(sia, "discover_l2_collections", lambda *a, **k: ["spherex_dr1", "spherex_qr3"])
    monkeypatch.setattr(sia, "search_position", search_position)
    monkeypatch.setattr(lookup.cube, "cube_spectrum", fake_spectrum)
    return fake


@pytest.fixture
def api(services: FakeServices) -> TestClient:
    with TestClient(create_app()) as client:
        yield client
    lookup.clear_caches()


# --- helpers ---------------------------------------------------------------------------------------------


def test_move_reproduces_gaia_propagation() -> None:
    ra, dec = lookup.move(269.44850252544, 4.73942005111, (-801.551, 10362.394), 10.0)
    assert dec == pytest.approx(4.73942005111 + 10.362394 * 10 / 3600.0, abs=2e-7)
    assert ra == pytest.approx(269.44850252544 - 0.8015510 * 10 / 3600.0 / math.cos(math.radians(4.754)), abs=2e-6)
    assert lookup.move(10.0, 20.0, None, 50.0) == (10.0, 20.0)
    assert lookup.separation_arcsec(10.0, 0.0, 10.0, 1.0 / 3600.0) == pytest.approx(1.0, rel=1e-9)


def test_distance_needs_a_precise_parallax() -> None:
    d = lookup.distance_from_parallax(546.9759, 0.0401)
    assert d["pc"] == pytest.approx(1.83) and d["ly"] == pytest.approx(5.96)
    assert lookup.distance_from_parallax(1.0, 0.25) is None  # parallax only 4 times its error
    assert lookup.distance_from_parallax(-0.3, 0.2) is None


def test_where_words() -> None:
    centre = lookup.where_words(0.5, -0.5, -5.6, 266.4, -29.0)
    assert any("plane of the Milky Way" in s for s in centre) and any("centre of the Milky Way" in s for s in centre)
    assert "north galactic pole" in lookup.where_words(108.0, 89.99, 29.8, 192.86, 27.13)[0]
    assert any("ecliptic" in s for s in lookup.where_words(170.0, 50.0, 1.0, 150.0, 12.0))
    assert any("Large Magellanic Cloud" in s for s in lookup.where_words(280.5, -32.9, -85.0, 80.9, -69.8))


def test_names_and_types_for_people() -> None:
    assert lookup.pretty_name("* alf CMa B") == "α CMa B"
    assert lookup.pretty_name("NAME Barnard's star") == "Barnard's star"
    assert lookup.pretty_name("* pi.03 Ori") == "π³ Ori"
    assert lookup.pretty_name("HD 163697") == "HD 163697"
    assert lookup.otype_label("BD*").startswith("Brown dwarf")
    assert lookup.otype_label("WD?").startswith("Candidate white dwarf")
    assert lookup.otype_label("s?r") == "Candidate red supergiant"
    assert "SIMBAD type" in lookup.otype_label("zz9")


def test_sky_part_constellation_names() -> None:
    assert lookup.sky_part(101.28304, -16.72495)["constellation_name"] == "Canis Major"
    oph = lookup.sky_part(269.44629, 4.76798)
    assert (oph["constellation"], oph["constellation_name"]) == ("Oph", "Ophiuchus")
    assert lookup.sky_part(330.0, -30.0)["constellation_name"] == "Piscis Austrinus"


def test_gaia_hint_for_barnards_star() -> None:
    row = dict(zip(GAIA_COLUMNS, SKY[0], strict=True))
    hint = lookup.gaia_hint(row)
    assert "red dwarf" in hint and "6.0 light-years" in hint


# --- /api/object -----------------------------------------------------------------------------------------


def test_object_barnards_star_from_the_star_files(api: TestClient, services: FakeServices) -> None:
    r = api.get("/api/object", params=BARNARD_2026)
    assert r.status_code == 200 and r.headers["cache-control"] == CDN
    doc = r.json()
    assert doc["schema"] == "pxh-object/1" and doc["complete"] is True
    assert doc["query"]["hip"] == 87937 and doc["query"]["epoch"] == 2026.0
    gaia, simbad = doc["gaia"], doc["simbad"]
    assert gaia["status"] == "ok" and gaia["source_id"] == "4472832130942575872"
    assert gaia["matched_by"] == "SIMBAD cross-identification"
    assert gaia["separation_arcsec"] < 1.5 and gaia["distance_ly"] == pytest.approx(5.96)
    assert gaia["radial_velocity"] == -110.47 and gaia["teff_gspphot"] == 3099.6 and gaia["ruwe"] == 1.085
    assert "red dwarf" in gaia["hint"] and gaia["source"].startswith("Gaia DR3")
    assert simbad["name"] == "Barnard's star" and simbad["otype"] == "BY*" and simbad["vmag"] == 9.511
    assert simbad["gaia_dr3_id"] == "4472832130942575872" and simbad["url"].startswith("https://simbad.cfa")
    assert "_j2000" not in simbad
    sphx = doc["spherex"]
    assert sphx["status"] == "ok" and sphx["n_epochs"] == 3 and sphx["n_images"] == 18
    assert sphx["first_obs"] == "2025-08-13" and sphx["deep_field"] is False and sphx["detectors"]["D6"] == 9
    assert doc["spectrum"]["status"] == "ok" and len(doc["spectrum"]["wl_um"]) == 102
    assert doc["spectrum"]["wl_um"] == sorted(doc["spectrum"]["wl_um"])
    assert doc["sky"]["constellation"] == "Oph" and doc["sky"]["status"] == "ok"
    assert all(doc[p]["source"] for p in ("sky", "gaia", "simbad", "spherex", "spectrum"))
    # Gaia was searched around SIMBAD's position moved to 2016.0, not around today's position
    first = services.gator_calls[0]
    ra16, dec16 = (float(v) for v in first["objstr"].split())
    assert _sep_arcsec(ra16, dec16, 269.44850252544, 4.73942005111) < 0.5
    calls = len(services.gator_calls)
    assert api.get("/api/object", params=BARNARD_2026).json()["gaia"]["source_id"] == "4472832130942575872"
    assert len(services.gator_calls) == calls  # the second answer came from memory


def test_object_fast_mover_found_without_proper_motion(api: TestClient, services: FakeServices) -> None:
    params = {"ra": BARNARD_2026["ra"], "dec": BARNARD_2026["dec"], "epoch": 2026.0}
    doc = api.get("/api/object", params=params).json()
    assert doc["gaia"]["source_id"] == "4472832130942575872" and doc["gaia"]["matched_by"] == "nearest source"
    assert any("pmra*pmra" in (c.get("constraints") or "") for c in services.gator_calls)
    # SIMBAD's J2000 position is 4.6 arcmin away; the fast-mover cone still finds it
    assert doc["simbad"]["name"] == "Barnard's star" and doc["simbad"]["separation_arcsec"] < 2.0
    assert any("b.pmra*b.pmra" in q for q in services.simbad_calls)


def test_object_slow_neighbour_is_not_matched_far_away(api: TestClient, services: FakeServices) -> None:
    # 20 arcsec from Sirius today: SIMBAD's fast-mover cone sees Sirius, but it is outside the radius
    doc = api.get("/api/object", params={"ra": 101.28304, "dec": -16.72495 + 20 / 3600, "epoch": 2026.0}).json()
    assert doc["simbad"]["status"] == "none" and doc["gaia"]["status"] == "none"


def test_object_bright_star_missing_from_gaia(api: TestClient, services: FakeServices) -> None:
    doc = api.get("/api/object", params=SIRIUS_2026).json()
    assert doc["simbad"]["name"] == "α CMa" and doc["simbad"]["gaia_dr3_id"] is None
    gaia = doc["gaia"]
    assert gaia["status"] == "none" and "brightest stars" in gaia["message"]  # the faint neighbour is not Sirius
    assert doc["spherex"]["status"] == "none" and doc["complete"] is True


def test_object_part_failure_is_reported_and_not_cached(api: TestClient, services: FakeServices) -> None:
    services.gator_error = httpx.ConnectError("Gator down")
    r = api.get("/api/object", params=BARNARD_2026)
    doc = r.json()
    assert r.status_code == 200 and r.headers["cache-control"] == "no-store"
    assert doc["gaia"]["status"] == "error" and "Gator" in doc["gaia"]["message"]
    assert doc["simbad"]["status"] == "ok" and doc["complete"] is False
    services.gator_error = None
    assert api.get("/api/object", params=BARNARD_2026).json()["gaia"]["status"] == "ok"


def test_object_slow_part_times_out(api: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(lookup, "PART_TIMEOUT_S", 0.5)
    monkeypatch.setattr(lookup.cube, "cube_spectrum", lambda ra, dec: time.sleep(1.5) or fake_spectrum(ra, dec))
    t0 = time.monotonic()
    doc = api.get("/api/object", params=BARNARD_2026).json()
    assert time.monotonic() - t0 < 1.4
    assert doc["spectrum"]["status"] == "timeout" and doc["gaia"]["status"] == "ok" and doc["complete"] is False


@pytest.mark.parametrize(
    ("params", "needle"),
    [
        ({"ra": 400, "dec": 0}, "ra must be within"),
        ({"ra": 10, "dec": 0, "radius_arcsec": 0}, "radius_arcsec"),
        ({"ra": 10, "dec": 0, "radius_arcsec": 61}, "radius_arcsec"),
        ({"ra": 10, "dec": 0, "pmra": 5}, "pmra and pmdec"),
        ({"ra": 10, "dec": 0, "pmra": 5, "pmdec": 1e6}, "mas/yr"),
        ({"ra": 10, "dec": 0, "epoch": 1800}, "epoch"),
        ({"ra": 10, "dec": 0, "hip": 0}, "hip"),
        ({"dec": 0}, "ra"),
    ],
)
def test_object_input_errors(api: TestClient, params: dict, needle: str) -> None:
    r = api.get("/api/object", params=params)
    assert r.status_code == 422 and r.json()["error"] == "invalid_input" and needle in r.json()["message"]


# --- /api/patch ------------------------------------------------------------------------------------------


def test_patch_counts_names_and_coverage(api: TestClient, services: FakeServices) -> None:
    r = api.get("/api/patch", params={"ra": 269.44629, "dec": 4.76798})
    assert r.status_code == 200 and r.headers["cache-control"] == CDN
    doc = r.json()
    assert doc["schema"] == "pxh-patch/1" and doc["complete"] is True and doc["query"]["radius_arcmin"] == 20.0
    count = doc["stars_count"]
    assert count["method"] == "exact" and count["count"] == 3000 and count["g_limit"] == 18.0
    assert count["density_per_deg2"] == pytest.approx(3000 / (math.pi * (20 / 60) ** 2), rel=1e-3)
    bright = doc["brightest"]
    assert bright["g_limit"] == 16.0  # only 3 sources brighter than G = 12, so it looked deeper
    assert [s["g"] for s in bright["stars"]] == sorted(s["g"] for s in bright["stars"])
    named = {s["source_id"]: s for s in bright["stars"]}
    assert named["100000"]["name"] == "α Tst" and named["100000"]["otype_label"].startswith("Star with")
    assert named["100001"]["name"] is None and named["100000"]["distance_ly"] == pytest.approx(326.2, abs=0.1)
    assert doc["sky"]["constellation_name"] == "Ophiuchus" and doc["sky"]["where"]
    assert doc["spherex"]["n_epochs"] == 3 and doc["spectrum"]["n_finite"] == 100


def test_patch_estimates_a_crowded_count(api: TestClient, services: FakeServices, monkeypatch) -> None:
    monkeypatch.setattr(lookup, "EXACT_COUNT_MAX", 100)
    doc = api.get("/api/patch", params={"ra": 266.4, "dec": -29.0, "radius_arcmin": 20}).json()
    count = doc["stars_count"]
    assert count["method"] == "estimate" and count["count"] == 3000 and count["sample_radius_arcmin"] == 2.0
    assert count["sample_count"] == 30 and "Estimated" in count["message"]
    assert any("centre of the Milky Way" in s for s in doc["sky"]["where"])


def test_patch_small_radius_is_counted_exactly(api: TestClient, services: FakeServices) -> None:
    doc = api.get("/api/patch", params={"ra": 150.1, "dec": 2.2, "radius_arcmin": 1}).json()
    assert doc["stars_count"]["method"] == "exact" and doc["stars_count"]["count"] == 8


@pytest.mark.parametrize(
    ("params", "needle"),
    [({"ra": 10, "dec": 0, "radius_arcmin": 0.5}, "radius_arcmin"), ({"ra": 10, "dec": 95}, "dec must be within")],
)
def test_patch_input_errors(api: TestClient, params: dict, needle: str) -> None:
    r = api.get("/api/patch", params=params)
    assert r.status_code == 422 and needle in r.json()["message"]
