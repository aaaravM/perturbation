"""Catalog cone searches for overlays: Gaia DR3 (moved to an epoch) and AllWISE, through IRSA Gator.

Gator answers IPAC tables (``outfmt=1``); answers are cached on disk per (catalog, position, radius) under
``config.CACHE_DIR/catalogs`` and in memory, and the CDN caches the HTTP responses. Gaia positions are moved
from the DR3 epoch (2016.0) to the requested epoch with a linear proper-motion step (good to a few mas over
a decade except within a degree of the poles). ``source_id`` is returned as a string: Gaia ids exceed the
largest integer JavaScript represents exactly.
"""

from __future__ import annotations

import logging
import math
import re
from pathlib import Path
from typing import Any

from pxh import config
from pxh.api.caching import TTLCache
from pxh.api.errors import archive_unavailable, invalid
from pxh.sky.propagate import jyear_from_mjd
from pxh.spherex import rangeio

log = logging.getLogger(__name__)

GAIA_CATALOG = "gaia_dr3_source"
GAIA_EPOCH = 2016.0
GAIA_COLUMNS = "source_id,ra,dec,phot_g_mean_mag,bp_rp,pmra,pmdec,parallax"
WISE_CATALOG = "allwise_p3as_psd"
WISE_COLUMNS = "designation,ra,dec,w1mpro,w2mpro,w1sigmpro,w2sigmpro"
MAX_RADIUS_ARCMIN = 15.0
MAX_ROWS = 5000
_MEMO = TTLCache(maxsize=128, ttl_s=6 * 3600.0)
_INT_RE = re.compile(r"^[-+]?\d+$")


def parse_ipac_table(text: str) -> list[dict[str, Any]]:
    """Rows of an IPAC table as dicts: integers as int (64-bit ids stay exact), other numbers as float,
    'null' as None, other values as str."""
    header: list[str] | None = None
    rows: list[dict[str, Any]] = []
    for line in text.splitlines():
        if line.startswith("\\"):
            continue
        if line.startswith("|"):
            if header is None:
                header = [c.strip() for c in line.strip().strip("|").split("|")]
            continue
        if header is None or not line.strip():
            continue
        values = line.split()
        if len(values) < len(header):
            continue
        row: dict[str, Any] = {}
        for name, raw in zip(header, values, strict=False):
            if raw == "null":
                row[name] = None
                continue
            if _INT_RE.match(raw):
                row[name] = int(raw)
                continue
            try:
                row[name] = float(raw)
            except ValueError:
                row[name] = raw
        rows.append(row)
    return rows


def _cache_path(catalog: str, ra: float, dec: float, radius_arcsec: float) -> Path:
    return Path(config.CACHE_DIR) / "catalogs" / f"{catalog}_{ra:.5f}_{dec:+.5f}_{radius_arcsec:.0f}.tbl"


def gator_cone(catalog: str, columns: str, ra: float, dec: float, radius_arcsec: float) -> list[dict[str, Any]]:
    """Rows of an IRSA Gator cone search (cached on disk and in memory)."""
    key = (catalog, round(ra, 5), round(dec, 5), round(radius_arcsec))
    hit = _MEMO.get(key)
    if hit is not None:
        return hit
    path = _cache_path(catalog, ra, dec, radius_arcsec)
    text: str | None = None
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        pass
    if text is None:
        params = {
            "catalog": catalog,
            "spatial": "cone",
            "radius": f"{radius_arcsec:.1f}",
            "radunits": "arcsec",
            "objstr": f"{ra:.6f} {dec:+.6f}",
            "outfmt": "1",
            "outrows": str(MAX_ROWS),
            "selcols": columns,
        }
        try:
            body = rangeio.http_get(config.IRSA_GATOR_URL, params=params, max_bytes=32 << 20)
        except Exception as exc:
            raise archive_unavailable(f"The IRSA catalog service (Gator) failed: {exc}"[:300]) from exc
        text = body.decode("utf-8", "replace")
        if "|" not in text:
            raise archive_unavailable(f"Unexpected answer from IRSA Gator: {text[:160]!r}")
        rangeio.save_cache_file(path, text.encode("utf-8"))
    rows = parse_ipac_table(text)
    _MEMO.put(key, rows)
    return rows


def _check_cone(ra: float, dec: float, radius_arcmin: float) -> None:
    if not (math.isfinite(ra) and 0.0 <= ra <= 360.0):
        raise invalid(f"ra must be within [0, 360] degrees, got {ra}")
    if not (math.isfinite(dec) and -90.0 <= dec <= 90.0):
        raise invalid(f"dec must be within [-90, 90] degrees, got {dec}")
    if not (math.isfinite(radius_arcmin) and 0.0 < radius_arcmin <= MAX_RADIUS_ARCMIN):
        raise invalid(f"radius_arcmin must be within (0, {MAX_RADIUS_ARCMIN:g}], got {radius_arcmin}")


def _is_num(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _num(value: Any, digits: int) -> float | None:
    if value is None or isinstance(value, str) or not math.isfinite(value):
        return None
    return round(float(value), digits)


def gaia_sources(ra: float, dec: float, radius_arcmin: float, epoch_mjd: float) -> list[dict[str, Any]]:
    """Gaia DR3 sources within the cone, positions moved to ``epoch_mjd`` (MJD)."""
    _check_cone(ra, dec, radius_arcmin)
    if not (math.isfinite(epoch_mjd) and 40000.0 <= epoch_mjd <= 80000.0):
        raise invalid(f"epoch_mjd must be an MJD between 40000 and 80000, got {epoch_mjd}")
    ra, dec = round(ra % 360.0, 5), round(dec, 5)
    rows = gator_cone(GAIA_CATALOG, GAIA_COLUMNS, ra, dec, radius_arcmin * 60.0)
    dt = float(jyear_from_mjd(epoch_mjd)) - GAIA_EPOCH
    out = []
    for row in rows:
        r0, d0 = row.get("ra"), row.get("dec")
        if not _is_num(r0) or not _is_num(d0):
            continue
        pmra, pmdec = row.get("pmra"), row.get("pmdec")
        r1, d1 = r0, d0
        if _is_num(pmra) and _is_num(pmdec):
            d1 = d0 + pmdec * dt / 3.6e6
            cosd = math.cos(math.radians(0.5 * (d0 + d1)))
            r1 = (r0 + pmra * dt / 3.6e6 / max(cosd, 1e-6)) % 360.0
        sid = row.get("source_id")
        out.append({
            "source_id": str(sid),
            "ra": round(r1, 7),
            "dec": round(d1, 7),
            "g": _num(row.get("phot_g_mean_mag"), 4),
            "bp_rp": _num(row.get("bp_rp"), 4),
            "pmra": _num(pmra, 3),
            "pmdec": _num(pmdec, 3),
            "parallax": _num(row.get("parallax"), 4),
        })
    return out


def wise_sources(ra: float, dec: float, radius_arcmin: float) -> list[dict[str, Any]]:
    """AllWISE sources within the cone (positions at the AllWISE epoch, about 2010.5)."""
    _check_cone(ra, dec, radius_arcmin)
    ra, dec = round(ra % 360.0, 5), round(dec, 5)
    out = []
    for row in gator_cone(WISE_CATALOG, WISE_COLUMNS, ra, dec, radius_arcmin * 60.0):
        r0, d0 = row.get("ra"), row.get("dec")
        if not _is_num(r0) or not _is_num(d0):
            continue
        out.append({
            "designation": str(row.get("designation") or ""),
            "ra": round(r0, 7),
            "dec": round(d0, 7),
            "w1": _num(row.get("w1mpro"), 3),
            "w2": _num(row.get("w2mpro"), 3),
            "w1_err": _num(row.get("w1sigmpro"), 3),
            "w2_err": _num(row.get("w2sigmpro"), 3),
        })
    return out
