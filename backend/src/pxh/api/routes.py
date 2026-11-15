"""HTTP endpoints of docs/api-contract.md section 2 (all GET, JSON).

Deterministic answers carry ``Cache-Control: public, s-maxage=86400, stale-while-revalidate=604800`` so
Vercel's CDN serves repeats; releases a short TTL; health and every error ``no-store``. Handlers are plain
functions: FastAPI runs them in its thread pool, and the data modules cap IRSA traffic per process.
"""

from __future__ import annotations

import json
import logging
import math
import os
import re
import time
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeout
from typing import Any

from fastapi import APIRouter, Query
from fastapi.responses import Response, StreamingResponse

from pxh import __version__, config
from pxh.api import catalogs, field, lookup
from pxh.api.caching import CDN_DAY, CDN_SHORT, NO_STORE
from pxh.api.errors import ApiProblem, archive_unavailable, invalid
from pxh.sky import propagate
from pxh.sky.resolve import NameNotFoundError, ResolverUnavailableError, resolve
from pxh.sky.targets import list_targets
from pxh.spherex import cube, sia

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api")

STARTED = time.monotonic()
MJD_J2000 = 51544.5
STREAM_ABOVE_BYTES = 4_000_000  # Vercel caps buffered function responses at 4.5 MB; streams are exempt
HEALTH_WAIT_S = 2.5
_DISCOVERY = ThreadPoolExecutor(max_workers=1, thread_name_prefix="discovery")

TARGET_SUMMARIES = {
    "barnards-star": (
        "Barnard's Star is a small red dwarf six light-years away, one of the Sun's nearest neighbours. "
        "It crosses the sky faster than any other star, the width of the full Moon every 175 years, so "
        "SPHEREx images taken months apart show it creeping north."
    ),
    "eps-indi-b": (
        "Epsilon Indi B is a pair of brown dwarfs, objects too small to shine like stars, 12 light-years "
        "away. They travel with the bright star Epsilon Indi A, almost 5 arcseconds a year, and SPHEREx "
        "sees the methane and water in their atmospheres."
    ),
    "wise-0855": (
        "WISE 0855-0714 is the coldest brown dwarf known: at about 285 K (12 °C) it is no warmer than a "
        "cool spring day. It is 7.4 light-years away and so faint that SPHEREx sees it only at its longest "
        "wavelengths, moving about 8 arcseconds a year."
    ),
    "rw-aur": (
        "RW Aurigae is a young star about 510 light-years away, still wrapped in the disk of gas and dust "
        "it formed from. Clumps in the disk can pass in front of it for months; SPHEREx saw it fade by "
        "almost a magnitude in the infrared."
    ),
    "r-dra": (
        "R Draconis is a pulsating red giant (a Mira variable) about 2,600 light-years away that swells "
        "and brightens every 245 days. It is so bright in the infrared that it saturates SPHEREx, so its "
        "changes are measured from the outer glow of its image."
    ),
}


# --- responses ----------------------------------------------------------------------------------------


def clean(value: Any) -> Any:
    """JSON-safe copy: non-finite floats become null, tuples lists, numpy scalars plain numbers."""
    if isinstance(value, dict):
        return {str(k): clean(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [clean(v) for v in value]
    if isinstance(value, bool) or value is None or isinstance(value, str):
        return value
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if hasattr(value, "item"):  # numpy scalar
        return clean(value.item())
    return value


def respond(doc: Any, cache: str = CDN_DAY, status: int = 200) -> Response:
    body = json.dumps(clean(doc), separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode("utf-8")
    headers = {"Cache-Control": cache}
    if len(body) > STREAM_ABOVE_BYTES:

        def chunks() -> Iterator[bytes]:
            for i in range(0, len(body), 1 << 20):
                yield body[i : i + (1 << 20)]

        return StreamingResponse(chunks(), status_code=status, media_type="application/json", headers=headers)
    return Response(body, status_code=status, media_type="application/json", headers=headers)


# --- endpoints ----------------------------------------------------------------------------------------


@router.get("/health")
def health() -> Response:
    """Liveness plus the discovered collections (waits at most a few seconds for discovery)."""
    future = _DISCOVERY.submit(sia.collection_catalog)
    try:
        catalog = future.result(timeout=HEALTH_WAIT_S)
        names, source = catalog.names, catalog.source
    except FutureTimeout:
        names = list(config.FALLBACK_L2_COLLECTIONS + config.FALLBACK_CUBE_COLLECTIONS)
        source = "pending"
    doc = {
        "status": "ok",
        "version": __version__,
        "collections": names,
        "collections_source": source,
        "uptime_s": round(time.monotonic() - STARTED, 1),
    }
    region = os.environ.get("VERCEL_REGION")
    if region:
        doc["region"] = region
    return respond(doc, NO_STORE)


@router.get("/targets")
def targets() -> Response:
    """The five challenge targets: position today (barycentric, proper motion applied) and bundle path."""
    now = round(field.mjd_now(), 1)
    out = []
    for t in list_targets(primary_only=True):
        ra, dec = propagate.barycentric_position(t.astrometry, now)
        out.append({
            "key": t.key,
            "name": t.name,
            "kind": t.kind,
            "ra": round(float(ra), 6),
            "dec": round(float(dec), 6),
            "summary_plain": TARGET_SUMMARIES.get(t.key, t.notes),
            "bundle": f"/bundles/{t.key}/manifest.json",
        })
    return respond(out)


@router.get("/resolve")
def resolve_name(q: str = Query(..., min_length=1, max_length=200, description="name or coordinates")) -> Response:
    """Name or coordinates -> position today and at J2000 (404 unknown name, 503 resolvers down)."""
    try:
        rn = resolve(q)
    except ResolverUnavailableError as exc:
        raise ApiProblem(
            503, "resolver_unavailable", f"No name service could be reached: {exc}"[:300], retryable=True
        ) from exc
    except NameNotFoundError as exc:
        raise ApiProblem(404, "not_found", f"No object called {q.strip()!r} was found.") from exc
    except ValueError as exc:
        raise invalid(str(exc)) from exc
    ast = rn.astrometry
    now = round(field.mjd_now(), 2)
    ra, dec = propagate.barycentric_position(ast, now)
    ra0, dec0 = propagate.barycentric_position(ast, MJD_J2000)
    return respond({
        "query": rn.query,
        "name": rn.name,
        "ra": round(float(ra), 7),
        "dec": round(float(dec), 7),
        "epoch_mjd": now,
        "ra_j2000": round(float(ra0), 7),
        "dec_j2000": round(float(dec0), 7),
        "pmra": round(ast.pmra_masyr, 3),
        "pmdec": round(ast.pmdec_masyr, 3),
        "parallax": None if ast.parallax_mas is None else round(ast.parallax_mas, 4),
        "resolver": rn.resolver,
        "target_key": rn.target_key,
        "source": ast.source,
    })


def _collection_kind(info: sia.CollectionInfo) -> str:
    if info.is_level2_image:
        return "l2-deep" if info.is_deep else "l2"
    if (info.dataproduct_type or "").lower() == "cube" or info.name.endswith("_cube"):
        return "cube"
    return "other"


def _release_label(name: str) -> str | None:
    m = re.match(r"^spherex_([a-z]+\d+)", name)
    return m.group(1).upper() if m else None


@router.get("/releases")
def releases() -> Response:
    """SPHEREx collections discovered at run time (re-discovered every 24 h)."""
    catalog = sia.collection_catalog()
    doc = {
        "collections": [
            {
                "name": c.name,
                "kind": _collection_kind(c),
                "latest_release": _release_label(c.name),
                "n_rows_hint": None,
                "dataproduct_type": c.dataproduct_type,
                "calib_level": c.calib_level,
            }
            for c in catalog.collections
        ],
        "checked_at": field.utc_iso(catalog.fetched_at) if catalog.fetched_at else None,
        "source": catalog.source,
    }
    return respond(doc, CDN_SHORT)


@router.get("/field/summary")
def field_summary(
    ra: float = Query(..., description="deg, ICRS"),
    dec: float = Query(..., description="deg, ICRS"),
    fov: float = Query(field.FOV_DEFAULT_ARCMIN, description="arcmin, 2-30"),
) -> Response:
    """Epochs and coverage from the SIA search alone (no pixels)."""
    return respond(field.field_summary(ra, dec, fov))


@router.get("/field/build")
def field_build(
    ra: float = Query(..., description="deg, ICRS"),
    dec: float = Query(..., description="deg, ICRS"),
    fov: float = Query(field.FOV_DEFAULT_ARCMIN, description="arcmin, 2-30"),
    det: str = Query("D6", description="D1..D6, or rgb (D1/D3/D6 false colour)"),
    modes: str = Query("epoch,difference", description="comma list of epoch, difference, flags"),
) -> Response:
    """A FieldManifest for one detector, frames as PNG data URLs (call once per detector)."""
    det_key = field.parse_det(det)
    mode_list = field.parse_modes(modes)
    return respond(field.build_field(ra, dec, fov, det_key, mode_list))


@router.get("/spectrum/quick")
def spectrum_quick(ra: float = Query(...), dec: float = Query(...)) -> Response:
    """102-channel quick-look spectrum from the DR1 cube (aperture photometry, Year 1)."""
    ra, dec, _ = field.normalise_field(ra, dec, field.FOV_DEFAULT_ARCMIN)
    try:
        res = cube.cube_spectrum(ra, dec)
    except cube.CubeError as exc:
        raise ApiProblem(404, "no_coverage", f"No DR1 cube data at this position: {exc}"[:300]) from exc
    except sia.SiaError as exc:
        raise archive_unavailable(f"The IRSA cube search failed: {exc}"[:300]) from exc
    return respond(lookup.spectrum_doc(res, ra, dec))


@router.get("/object")
def object_info(
    ra: float = Query(..., description="deg, ICRS, at `epoch`"),
    dec: float = Query(..., description="deg, ICRS, at `epoch`"),
    radius_arcsec: float = Query(lookup.RADIUS_ARCSEC_DEFAULT, description="arcsec, at most 60"),
    epoch: float | None = Query(None, description="Julian year of ra/dec (default 2026.0, the star files)"),
    pmra: float | None = Query(None, description="proper motion mu_alpha* in mas/yr, if known"),
    pmdec: float | None = Query(None, description="proper motion mu_delta in mas/yr, if known"),
    hip: int | None = Query(None, description="Hipparcos number, if the spot is a Hipparcos star"),
) -> Response:
    """Everything known at one spot: Gaia DR3, SIMBAD, SPHEREx coverage, quick-look spectrum, sky facts."""
    doc = lookup.object_lookup(ra, dec, radius_arcsec, epoch, pmra, pmdec, hip)
    return respond(doc, CDN_DAY if doc["complete"] else NO_STORE)


@router.get("/patch")
def patch_info(
    ra: float = Query(..., description="deg, ICRS"),
    dec: float = Query(..., description="deg, ICRS"),
    radius_arcmin: float = Query(lookup.PATCH_RADIUS_DEFAULT, description="arcmin, 1-60"),
) -> Response:
    """What is in a patch of sky: where it is, its brightest stars, star count, SPHEREx coverage, spectrum."""
    doc = lookup.patch_lookup(ra, dec, radius_arcmin)
    return respond(doc, CDN_DAY if doc["complete"] else NO_STORE)


@router.get("/catalog/gaia")
def catalog_gaia(
    ra: float = Query(...),
    dec: float = Query(...),
    radius_arcmin: float = Query(5.0, description="arcmin, at most 15"),
    epoch_mjd: float | None = Query(None, description="MJD to move positions to (default: today)"),
) -> Response:
    """Gaia DR3 sources in a cone, propagated to epoch_mjd (IRSA Gator gaia_dr3_source)."""
    when = round(field.mjd_now(), 0) if epoch_mjd is None else float(epoch_mjd)
    return respond(catalogs.gaia_sources(ra, dec, radius_arcmin, when))


@router.get("/catalog/wise")
def catalog_wise(
    ra: float = Query(...), dec: float = Query(...), radius_arcmin: float = Query(5.0, description="arcmin, at most 15")
) -> Response:
    """AllWISE sources in a cone (IRSA Gator allwise_p3as_psd), positions at the AllWISE epoch."""
    return respond(catalogs.wise_sources(ra, dec, radius_arcmin))
