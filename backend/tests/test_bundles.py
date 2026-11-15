"""Contract tests for the static target bundles (frontend/public/bundles/<slug>/, built by scripts/build_bundles.py).

Each manifest is checked against docs/api-contract.md and its TypeScript mirror frontend/src/lib/manifest.ts:
required keys and types, no NaN, every frame file present, PNGs 8-bit and exactly grid.width x grid.height,
a north-up east-left TAN grid whose WCS puts the target's catalogue position at the grid centre (within 1 px)
at the field epoch, predicted paths that agree with the catalogue, the bright targets' stars where the WCS
says they are in the images (orientation), the plain-language text equal to frontend/src/lib/targets.ts, and
each bundle under the size budget.
"""

from __future__ import annotations

import json
import math
import re
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from astropy.wcs import WCS
from PIL import Image

from pxh import config
from pxh.models import Astrometry
from pxh.sky import propagate

BUNDLES = config.REPO_ROOT / "frontend" / "public" / "bundles"
TARGETS_TS = config.REPO_ROOT / "frontend" / "src" / "lib" / "targets.ts"
SLUGS = ("barnards-star", "eps-indi-b", "wise-0855", "rw-aur", "r-dra")
DETECTORS = ("D1", "D2", "D3", "D4", "D5", "D6")
KINDS = ("high-pm-star", "brown-dwarf", "young-variable", "mira-variable", "bright-star")
MAX_BUNDLE_BYTES = 3_000_000
# Bright targets whose star is the brightest object in the D6 frames (orientation check on real pixels).
BRIGHT = ("barnards-star", "rw-aur", "r-dra")


# --- helpers -----------------------------------------------------------------------------------------------


def _no_nan(token: str) -> Any:
    raise ValueError(f"non-JSON constant {token} in manifest")


def load(slug: str) -> dict[str, Any]:
    path = BUNDLES / slug / "manifest.json"
    assert path.is_file(), f"missing bundle {path}"
    return json.loads(path.read_text(encoding="utf-8"), parse_constant=_no_nan)


def is_num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def is_int(v: Any) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def has(obj: dict[str, Any], spec: dict[str, Any], where: str) -> None:
    """Every key of spec is in obj with the given type check (a callable, a type, or a tuple of types)."""
    assert isinstance(obj, dict), f"{where}: expected an object, got {type(obj).__name__}"
    for key, check in spec.items():
        assert key in obj, f"{where}: missing key {key!r}"
        v = obj[key]
        ok = check(v) if callable(check) and not isinstance(check, type) else isinstance(v, check)
        assert ok, f"{where}.{key}: unexpected value {v!r}"


def grid_wcs(m: dict[str, Any]) -> WCS:
    c = m["grid"]["wcs"]
    w = WCS(naxis=2)
    w.wcs.ctype = [c["CTYPE1"], c["CTYPE2"]]
    w.wcs.crval = [c["CRVAL1"], c["CRVAL2"]]
    w.wcs.crpix = [c["CRPIX1"], c["CRPIX2"]]
    w.wcs.cd = [[c["CD1_1"], c["CD1_2"]], [c["CD2_1"], c["CD2_2"]]]
    w.wcs.radesys = c.get("RADESYS", "ICRS")
    w.wcs.set()
    return w


def astrometry(m: dict[str, Any]) -> Astrometry:
    a = m["target"]["astrometry"]
    return Astrometry(
        a["ra"], a["dec"], a["ref_epoch"], a["pmra"], a["pmdec"], a.get("parallax"), a.get("rv"), a["source"]
    )


def png_xy(m: dict[str, Any], w: WCS, ra: float, dec: float) -> tuple[float, float]:
    """0-based (column, row) in a bundle PNG (row 0 = north) of a sky position."""
    x, y = w.world_to_pixel_values(ra, dec)
    return float(x), float(m["grid"]["height"] - 1 - y)


def frame_urls(m: dict[str, Any]) -> list[str]:
    f = m["frames"]
    urls = [x["url"] for lst in f["epoch"].values() for x in lst]
    urls += (
        [x["url"] for x in f["then_vs_now"]]
        + [x["url"] for x in f["difference"]]
        + [x["url"] for x in f["flags"]]
    )
    return urls


def brightest(path: Path) -> tuple[float, float]:
    """Centre of the brightest object in a grey PNG: the brightest 5x5 box (mean of the pixels with data), or,
    when the object is saturated in the PNG, the centroid of the connected region of saturated (grey >= 250)
    or masked (transparent) pixels containing that box, so a masked core ringed by its wings counts as one."""
    from scipy import ndimage

    with Image.open(path) as im:
        a = np.asarray(im.convert("LA"), float)
    valid = a[..., 1] > 0
    g = np.where(valid, a[..., 0], 0.0)
    shifts = [(dy, dx) for dy in range(-2, 3) for dx in range(-2, 3)]
    total = sum(np.roll(np.roll(g, dy, 0), dx, 1) for dy, dx in shifts)
    count = sum(np.roll(np.roll(valid.astype(float), dy, 0), dx, 1) for dy, dx in shifts)
    with np.errstate(invalid="ignore", divide="ignore"):
        box = np.where(count >= 5, total / count, 0.0)
    box[:2, :] = box[-2:, :] = box[:, :2] = box[:, -2:] = 0
    r, c = np.unravel_index(int(np.argmax(box)), box.shape)
    labels, _ = ndimage.label((g >= 250) | ~valid)
    if labels[r, c] == 0:
        return float(c), float(r)
    cy, cx = ndimage.center_of_mass(labels == labels[r, c])
    return float(cx), float(cy)


def frontend_targets() -> dict[str, dict[str, Any]]:
    text = TARGETS_TS.read_text(encoding="utf-8")
    lit = r'"((?:[^"\\]|\\.)*)"'
    out = {}
    for block in text.split("slug: ")[1:]:
        if not block.startswith('"'):
            continue
        slug = re.match(lit, block).group(1)
        body = block.split("watchFor:")[0]
        out[slug] = {
            "name": re.search(r"name: " + lit, body).group(1),
            "kind": re.search(r"kind: " + lit, body).group(1),
            "summary": re.search(r"summary:\s*" + lit, body).group(1),
            "facts": [
                {"label": a, "value": b}
                for a, b in re.findall(r"\{ label: " + lit + r", value: " + lit + r" \}", body)
            ],
        }
    return out


# --- the contract --------------------------------------------------------------------------------------------


@pytest.mark.parametrize("slug", SLUGS)
def test_manifest_matches_contract(slug: str) -> None:
    m = load(slug)
    has(
        m,
        {
            "schema": lambda v: v == "pxh-field/1",
            "generated_at": str,
            "source": lambda v: v == "bundle",
            "target": dict,
            "center": dict,
            "fov_arcmin": is_num,
            "release": dict,
            "grid": dict,
            "epochs": list,
            "frames": dict,
            "checks": list,
            "warnings": list,
            "links": list,
            "credits": str,
        },
        slug,
    )
    t = m["target"]
    has(
        t,
        {
            "key": lambda v: v == slug,
            "name": str,
            "kind": lambda v: v in KINDS,
            "aliases": list,
            "summary_plain": str,
            "facts": list,
            "astrometry": dict,
        },
        "target",
    )
    assert all(isinstance(a, str) for a in t["aliases"])
    for f in t["facts"]:
        has(f, {"label": str, "value": str}, "target.facts[]")
    has(
        t["astrometry"],
        {"ra": is_num, "dec": is_num, "ref_epoch": is_num, "pmra": is_num, "pmdec": is_num, "source": str},
        "target.astrometry",
    )
    for k in ("parallax", "rv"):
        assert t["astrometry"].get(k) is None or is_num(t["astrometry"][k])
    has(m["center"], {"ra": is_num, "dec": is_num, "epoch_mjd": is_num}, "center")
    has(m["release"], {"collections": list, "file_tags": list, "latest_obs": str}, "release")
    assert m["release"]["collections"] and all(isinstance(c, str) for c in m["release"]["collections"])
    assert m["release"]["file_tags"] and all(isinstance(c, str) for c in m["release"]["file_tags"])
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}", m["release"]["latest_obs"])

    g = m["grid"]
    has(g, {"width": is_int, "height": is_int, "pixscale_arcsec": is_num, "wcs": dict}, "grid")
    for k in (
        "NAXIS1",
        "NAXIS2",
        "CTYPE1",
        "CTYPE2",
        "CRPIX1",
        "CRPIX2",
        "CRVAL1",
        "CRVAL2",
        "CD1_1",
        "CD1_2",
        "CD2_1",
        "CD2_2",
        "RADESYS",
        "EQUINOX",
    ):
        assert k in g["wcs"], f"grid.wcs: missing {k}"

    indices = set()
    for e in m["epochs"]:
        has(
            e,
            {
                "index": is_int,
                "label": str,
                "survey": lambda v: v in ("S1", "S2", "S3", "S4"),
                "year": lambda v: v in (1, 2),
                "pa": lambda v: is_int(v) and 0 <= v < 360,
                "start": str,
                "end": str,
                "mjd_mid": is_num,
                "n_exposures": is_int,
                "detectors": dict,
                "full": bool,
            },
            f"epochs[{e.get('index')}]",
        )
        assert set(e["detectors"]) <= {"1", "2", "3", "4", "5", "6"}
        assert all(is_int(n) and n >= 0 for n in e["detectors"].values())
        # contract: S1 = PA 0 and S2 = PA 180 in Year 1, S3/S4 in Year 2
        near_180 = abs(e["pa"] % 360 - 180) < abs((e["pa"] + 180) % 360 - 180)  # deep fields: other PAs
        assert e["survey"] == f"S{(1 if e['year'] == 1 else 3) + near_180}"
        indices.add(e["index"])
    assert len(indices) == len(m["epochs"]) >= 2
    assert len({e["label"] for e in m["epochs"]}) == len(m["epochs"]), "epoch labels must be unique"

    fr = m["frames"]
    has(fr, {"epoch": dict, "then_vs_now": list, "difference": list, "flags": list}, "frames")
    assert set(fr["epoch"]) <= {*DETECTORS, "rgb"}
    for key, lst in fr["epoch"].items():
        for f in lst:
            has(f, {"epoch": lambda v: v in indices, "url": str, "mjd": is_num}, f"frames.epoch.{key}[]")
            if key == "rgb":
                assert f["channels"] == "D6/D3/D1"  # red/green/blue, as the Lab legend reads it
            else:
                assert is_int(f["n"]) and f["n"] > 0
                lo, hi = f["wl_um"]
                assert 0.7 < lo <= hi < 5.1
    assert sum(len(v) for v in fr["epoch"].values()) > 0
    assert len(fr["then_vs_now"]) == 2, "Then vs Now needs the WISE and the SPHEREx frame"
    for f in fr["then_vs_now"]:
        has(f, {"label": str, "url": str, "mjd": is_num, "instrument": str}, "frames.then_vs_now[]")
    assert fr["then_vs_now"][0]["mjd"] < 56000 < fr["then_vs_now"][1]["mjd"]
    assert fr["difference"], "at least one difference frame"
    for f in fr["difference"]:
        has(
            f,
            {
                "detector": lambda v: v in DETECTORS,
                "a": lambda v: v in indices,
                "b": lambda v: v in indices,
                "url": str,
                "units": lambda v: v == "sigma",
                "limits": list,
            },
            "frames.difference[]",
        )
        lo, hi = f["limits"]
        assert is_num(lo) and is_num(hi) and lo == -hi < 0
        assert f["a"] != f["b"]
    for f in fr["flags"]:
        has(
            f,
            {
                "detector": lambda v: v in DETECTORS,
                "epoch": lambda v: v in indices,
                "url": str,
                "legend": dict,
            },
            "frames.flags[]",
        )
        assert all(re.fullmatch(r"#[0-9a-f]{6}", c) for c in f["legend"].values())

    mo = m["motion"]
    if mo is not None:
        has(
            mo,
            {
                "method": str,
                "epoch_positions": list,
                "predicted_path": list,
                "verdict": lambda v: v in ("pass", "partial", "fail"),
                "verdict_text": str,
            },
            "motion",
        )
        for p in mo["epoch_positions"]:
            has(
                p,
                {
                    "epoch": lambda v: v in indices,
                    "mjd": is_num,
                    "ra": is_num,
                    "dec": is_num,
                    "err_mas": is_num,
                },
                "motion.epoch_positions[]",
            )
        if mo["fit"] is not None:
            has(
                mo["fit"],
                dict.fromkeys(
                    ("pmra", "pmdec", "pmra_err", "pmdec_err", "total_arcsec_yr", "total_err", "pa_deg"),
                    is_num,
                ),
                "motion.fit",
            )
        if mo["catalog"] is not None:
            has(
                mo["catalog"],
                {**dict.fromkeys(("pmra", "pmdec", "total_arcsec_yr", "pa_deg"), is_num), "source": str},
                "motion.catalog",
            )
        assert all(len(p) == 2 and is_num(p[0]) and is_num(p[1]) for p in mo["predicted_path"])
        assert len(mo["predicted_path"]) == len(m["epochs"])

    sp = m["spectrum"]
    if sp is not None:
        has(sp, {"points": list, "notes": list}, "spectrum")
        assert sp["points"]
        for p in sp["points"]:
            has(
                p,
                {
                    "wl_um": is_num,
                    "bw_um": is_num,
                    "flux_ujy": is_num,
                    "err_ujy": is_num,
                    "epoch": lambda v: v in indices,
                    "detector": lambda v: v in range(1, 7),
                    "saturated": bool,
                },
                "spectrum.points[]",
            )
        q = sp.get("quicklook")
        if q is not None:
            has(q, {"wl_um": list, "flux_ujy": list, "label": str}, "spectrum.quicklook")
            assert len(q["wl_um"]) == len(q["flux_ujy"]) == 102
            assert all(v is None or is_num(v) for v in q["flux_ujy"])

    lc = m["lightcurve"]
    if lc is not None:
        has(lc, {"epoch_photometry": list, "same_channel": list}, "lightcurve")
        for p in lc["epoch_photometry"]:
            has(
                p,
                {
                    "epoch": lambda v: v in indices,
                    "detector": lambda v: v in range(1, 7),
                    **dict.fromkeys(
                        ("mjd", "flux_ujy", "err_ujy", "mag_ab", "wl_um", "saturated_frac"), is_num
                    ),
                },
                "lightcurve.epoch_photometry[]",
            )
        for p in lc["same_channel"]:
            has(
                p, dict.fromkeys(("mjd", "flux_ujy", "err_ujy", "wl_um"), is_num), "lightcurve.same_channel[]"
            )
        v = lc.get("variability")
        if v is not None:
            has(
                v,
                {"chi2_dof": is_num, "max_delta_mag": is_num, "significant": bool},
                "lightcurve.variability",
            )

    for c in m["checks"]:
        has(c, {"name": str, "value": str, "pass": bool}, "checks[]")
    assert all(isinstance(w, str) and w for w in m["warnings"])
    for link in m["links"]:
        has(link, {"label": str, "url": lambda v: isinstance(v, str) and v.startswith("https://")}, "links[]")
    assert any("simbad.cfa.harvard.edu" in link["url"] for link in m["links"])
    assert "IRSA678" in m["credits"] and "AllWISE" in m["credits"]


@pytest.mark.parametrize("slug", SLUGS)
def test_target_text_matches_frontend(slug: str) -> None:
    m, ft = load(slug), frontend_targets()[slug]
    t = m["target"]
    assert (t["name"], t["kind"], t["summary_plain"], t["facts"]) == (
        ft["name"],
        ft["kind"],
        ft["summary"],
        ft["facts"],
    )


# --- files and pixels ----------------------------------------------------------------------------------------


@pytest.mark.parametrize("slug", SLUGS)
def test_frames_exist_and_have_grid_size(slug: str) -> None:
    m = load(slug)
    root = BUNDLES / slug
    urls = frame_urls(m)
    w, h = m["grid"]["width"], m["grid"]["height"]
    modes = {}
    for url in set(urls):
        assert not url.startswith(("/", "http")), f"bundle URLs are relative: {url}"
        path = root / url
        assert path.is_file(), f"missing frame {url}"
        with Image.open(path) as im:
            assert im.format == "PNG"
            assert im.size == (w, h), f"{url}: {im.size} != grid {(w, h)}"
            assert im.mode in ("L", "LA", "RGB", "RGBA"), f"{url}: mode {im.mode} is not 8-bit"
            modes[url] = im.mode
    f = m["frames"]
    for d in f["difference"]:
        assert modes[d["url"]] == "L", "difference frames are opaque grey (the Lab recolours them)"
    for x in f["flags"]:
        assert modes[x["url"]] == "RGBA"
    for key, lst in f["epoch"].items():
        for x in lst:
            assert modes[x["url"]] in (("RGB", "RGBA") if key == "rgb" else ("L", "LA"))
    # nothing unreferenced is shipped
    shipped = {p.relative_to(root).as_posix() for p in (root / "frames").glob("*")}
    assert shipped == set(urls)
    size = sum(p.stat().st_size for p in root.rglob("*") if p.is_file())
    assert size < MAX_BUNDLE_BYTES, f"{slug}: {size / 1e6:.2f} MB"


# --- geometry -------------------------------------------------------------------------------------------------


@pytest.mark.parametrize("slug", SLUGS)
def test_grid_is_north_up_and_centred_on_the_target(slug: str) -> None:
    m = load(slug)
    g, c = m["grid"], m["grid"]["wcs"]
    assert c["NAXIS1"] == g["width"] and c["NAXIS2"] == g["height"]
    assert c["CTYPE1"] == "RA---TAN" and c["CTYPE2"] == "DEC--TAN"
    assert c["CD1_2"] == 0 and c["CD2_1"] == 0
    assert c["CD1_1"] < 0 < c["CD2_2"], "north up, east left"
    assert c["CD2_2"] * 3600 == pytest.approx(g["pixscale_arcsec"], rel=1e-6)
    assert -c["CD1_1"] == pytest.approx(c["CD2_2"], rel=1e-9)
    assert g["width"] * g["pixscale_arcsec"] / 60 == pytest.approx(m["fov_arcmin"], abs=0.01)
    assert 9.5 <= m["fov_arcmin"] <= 10.5
    w = grid_wcs(m)
    # The WCS round trip is exact, and the catalogue position at the field epoch is the grid centre.
    x, y = w.world_to_pixel_values(m["center"]["ra"], m["center"]["dec"])
    assert (x + 1, y + 1) == pytest.approx((c["CRPIX1"], c["CRPIX2"]), abs=1e-3)
    ra, dec = propagate.barycentric_position(astrometry(m), m["center"]["epoch_mjd"])
    x, y = w.world_to_pixel_values(float(ra), float(dec))
    assert math.hypot(x + 1 - c["CRPIX1"], y + 1 - c["CRPIX2"]) < 1.0
    rr, dd = w.pixel_to_world_values(x, y)
    assert (float(rr), float(dd)) == pytest.approx((float(ra), float(dec)), abs=1e-9)


@pytest.mark.parametrize("slug", SLUGS)
def test_predicted_path_and_epoch_positions(slug: str) -> None:
    m = load(slug)
    mo = m["motion"]
    assert mo is not None
    w, ast = grid_wcs(m), astrometry(m)
    scale = m["grid"]["pixscale_arcsec"]
    for e, (ra, dec) in zip(m["epochs"], mo["predicted_path"], strict=True):
        pra, pdec = propagate.apparent_position(ast, e["mjd_mid"])
        x0, y0 = w.world_to_pixel_values(float(pra), float(pdec))
        x1, y1 = w.world_to_pixel_values(ra, dec)
        assert math.hypot(x1 - x0, y1 - y0) < 0.05, "predicted_path = catalogue position at each epoch"
        assert 0 <= x1 < m["grid"]["width"] and 0 <= y1 < m["grid"]["height"]
    for p in mo["epoch_positions"]:
        pra, pdec = propagate.apparent_position(ast, p["mjd"])
        x0, y0 = w.world_to_pixel_values(float(pra), float(pdec))
        x1, y1 = w.world_to_pixel_values(p["ra"], p["dec"])
        # measured positions sit on the target (saturated or blended ones within 2 px)
        assert math.hypot(x1 - x0, y1 - y0) * scale < 12.0


@pytest.mark.parametrize("slug", BRIGHT)
def test_bright_star_lands_where_the_wcs_says(slug: str) -> None:
    """Orientation on real pixels: the star is the brightest thing at its predicted spot in D6 and in WISE."""
    m = load(slug)
    w, ast = grid_wcs(m), astrometry(m)
    root = BUNDLES / slug
    checked = 0
    for f in m["frames"]["epoch"]["D6"]:
        ra, dec = propagate.apparent_position(ast, f["mjd"])
        px = png_xy(m, w, float(ra), float(dec))
        got = brightest(root / f["url"])
        assert math.hypot(got[0] - px[0], got[1] - px[1]) <= 1.0, f"{f['url']}: star at {got}, WCS says {px}"
        checked += 1
    wise = m["frames"]["then_vs_now"][0]
    ra, dec = propagate.apparent_position(ast, wise["mjd"])
    px = png_xy(m, w, float(ra), float(dec))
    got = brightest(root / wise["url"])
    assert math.hypot(got[0] - px[0], got[1] - px[1]) <= 1.0, f"WISE: star at {got}, WCS says {px}"
    assert checked >= 2


def test_movers_move_between_then_and_now() -> None:
    """Barnard's Star moves about 2.8 arcmin and WISE 0855 about 2.2 arcmin between AllWISE and SPHEREx."""
    for slug, expect_arcmin in (("barnards-star", 2.8), ("wise-0855", 2.2)):
        m = load(slug)
        ast = astrometry(m)
        then, now = m["frames"]["then_vs_now"]
        a = propagate.apparent_position(ast, then["mjd"])
        b = propagate.apparent_position(ast, now["mjd"])
        dra = (float(b[0]) - float(a[0])) * math.cos(math.radians(float(a[1])))
        sep = math.hypot(dra, float(b[1]) - float(a[1])) * 60
        assert sep == pytest.approx(expect_arcmin, abs=0.25)
