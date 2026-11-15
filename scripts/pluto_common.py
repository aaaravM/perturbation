"""Shared helpers for the Pluto scripts (pluto_find.py, pluto_measure.py, pluto_products.py).

Run the scripts from backend/ (the uv project), e.g. ``uv run python ../scripts/pluto_find.py``.
Intermediate results go to data/tmp/pluto/ (not committed); the page bundle goes to frontend/public/planet-x/.
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

import numpy as np

from pxh import config
from pxh.sky import horizons

PLUTO = "999"  # Horizons: Pluto itself (the Pluto-Charon barycentre is "9")
TRACK_START, TRACK_STOP, TRACK_STEP = "2025-04-20", "2026-11-16", "6 h"
WORK = config.REPO_ROOT / "data" / "tmp" / "pluto"
BUNDLE = config.REPO_ROOT / "frontend" / "public" / "planet-x"
EXPOSURES_JSON = WORK / "exposures.json"
MEASURE_JSON = WORK / "measurements.json"


def track() -> horizons.Ephemeris:
    """Geocentric Pluto table over the SPHEREx data span (6-hour steps, cached)."""
    return horizons.ephemeris(PLUTO, TRACK_START, TRACK_STOP, TRACK_STEP)


def spacecraft_km(header: Any) -> np.ndarray | None:
    """SPHEREx position at mid-exposure (km from the geocentre, equatorial axes), or None if absent."""
    try:
        if str(header.get("XYZ_SC_SYSTEM", "GEOCENTER")).strip().upper() != "GEOCENTER":
            return None
        v = np.array([float(header["X_SC"]), float(header["Y_SC"]), float(header["Z_SC"])])
    except (KeyError, TypeError, ValueError):
        return None
    return v if np.all(np.isfinite(v)) else None


def polygon_vertices(s_region: str) -> np.ndarray | None:
    """[n, 2] (ra, dec) vertices of an SIA 'POLYGON ICRS ra dec ...' footprint (closing vertex dropped)."""
    parts = s_region.replace("(", " ").replace(")", " ").split()
    if not parts or parts[0].upper() != "POLYGON":
        return None
    nums = []
    for p in parts[1:]:
        try:
            nums.append(float(p))
        except ValueError:
            continue  # the frame name, e.g. ICRS
    if len(nums) < 6 or len(nums) % 2:
        return None
    v = np.array(nums, dtype=float).reshape(-1, 2)
    if np.allclose(v[0], v[-1]):
        v = v[:-1]
    return v if len(v) >= 3 else None


def _gnomonic(ra: np.ndarray, dec: np.ndarray, ra0: float, dec0: float) -> tuple[np.ndarray, np.ndarray]:
    a, d = np.radians(ra), np.radians(dec)
    a0, d0 = math.radians(ra0), math.radians(dec0)
    cosc = np.sin(d0) * np.sin(d) + np.cos(d0) * np.cos(d) * np.cos(a - a0)
    x = np.cos(d) * np.sin(a - a0) / cosc
    y = (np.cos(d0) * np.sin(d) - np.sin(d0) * np.cos(d) * np.cos(a - a0)) / cosc
    return np.degrees(x), np.degrees(y)


def inside_polygon(vertices: np.ndarray, ra: float, dec: float, margin_deg: float = 0.0) -> bool:
    """Point-in-footprint test in the gnomonic plane at the polygon centre; ``margin_deg`` grows the polygon."""
    v = horizons.unit_vector(vertices[:, 0], vertices[:, 1]).mean(axis=0)
    ra0, dec0 = (float(c) for c in horizons.radec_of(v))
    px, py = _gnomonic(vertices[:, 0], vertices[:, 1], ra0, dec0)
    qx, qy = _gnomonic(np.array([ra]), np.array([dec]), ra0, dec0)
    qx, qy = float(qx[0]), float(qy[0])
    inside = False
    n = len(px)
    for i in range(n):
        x1, y1, x2, y2 = px[i], py[i], px[(i + 1) % n], py[(i + 1) % n]
        if (y1 > qy) != (y2 > qy) and qx < (x2 - x1) * (qy - y1) / (y2 - y1) + x1:
            inside = not inside
    if inside or margin_deg <= 0:
        return inside
    # Outside: within margin of an edge?
    for i in range(n):
        x1, y1, x2, y2 = px[i], py[i], px[(i + 1) % n], py[(i + 1) % n]
        dx, dy = x2 - x1, y2 - y1
        t = max(0.0, min(1.0, ((qx - x1) * dx + (qy - y1) * dy) / (dx * dx + dy * dy)))
        if math.hypot(qx - (x1 + t * dx), qy - (y1 + t * dy)) <= margin_deg:
            return True
    return False


def jsonable(v: Any) -> Any:
    if isinstance(v, dict):
        return {str(k): jsonable(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [jsonable(x) for x in v]
    if isinstance(v, np.ndarray):
        return [jsonable(x) for x in v.tolist()]
    if isinstance(v, (np.floating, float)):
        f = float(v)
        return f if math.isfinite(f) else None
    if isinstance(v, (np.integer,)):
        return int(v)
    if isinstance(v, (np.bool_,)):
        return bool(v)
    return v


def save_json(path: Path, obj: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(jsonable(obj), indent=1), encoding="utf-8")


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))
