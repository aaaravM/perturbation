"""Build the Discover-mode globe textures from the SPHEREx DR1 all-sky HiPS cube.

Run from the backend uv environment (downloads are cached in data/cache/hips/):

    cd backend
    uv run python ../scripts/make_sky_texture.py --preview-dir <dir>

Outputs (frontend/public/textures/):
    spherex-sky-rgb-4k.webp   4096x2048 false-colour composite: B 0.81-0.98 um, G 1.70-2.19 um, R 4.0-4.9 um
    spherex-sky-rgb-2k.webp   2048x1024 copy
    spherex-sky-mono-4k.webp  4096x2048 single band at 1.25 um (3 adjacent SPHEREx channels, 1.224-1.284 um)
    spherex-sky.json          mapping, frames, wavelengths, stretch and credit

With --size 8k (implies --order 1: Norder1 tiles, nside 1024, twice the detail of the 4k set):
    spherex-sky-rgb-8k.webp   8192x4096 false-colour composite, same frames, mapping and stretch as the 4k;
                              recorded as files.rgb_8k in the existing spherex-sky.json (nothing else changes)
        uv run python ../scripts/make_sky_texture.py --size 8k

Texture convention (plate carree, equatorial ICRS), for every output:
    column x = 0..W-1, row y = 0..H-1, pixel centres at
        RA  = (x + 0.5) * 360 / W        RA = 0 at the LEFT edge, increasing to the RIGHT
        Dec = 90 - (y + 0.5) * 180 / H   Dec = +90 on the TOP row
    i.e. u = RA / 360 and (from the top) v = (90 - Dec) / 180: the layout of a terrestrial map, which is what
    a globe seen from OUTSIDE needs. On a three.js SphereGeometry with default UVs (texture.flipY = true, no
    mesh rotation) a marker at (RA, Dec) goes at r * (-cos(Dec) cos(RA), sin(Dec), cos(Dec) sin(RA)).

How the HiPS is decoded (determined empirically; check_convention re-verifies it on every run):
  * Tiles are 8-bit PNG. HipsGen quantised the data linearly over hips_pixel_cut (0..40) into q = 0..255 and
    then applied an asinh look-up table, so only ~116 grey levels occur (0, 35, 58, 73, ...). gray_to_q()
    inverts the table (exact for q <= 36 where it is one-to-one, a fitted asinh model above it). Verified:
    Norder0 pixels equal 8x8 means of the inverted Norder3 tile pixels to 0.1 % from q = 2 to 150.
  * Full tiles (Norder<N>/Dir0/Npix<k>/Npix<k>_<f>.png; frame 0 has no suffix) are palette PNGs:
    index 0 = blank (transparent), grey = index - 1.
  * Tile pixel (column x, row y counted from the top of the PNG) is HEALPix NESTED sub-pixel
    spread_bits(y) | spread_bits(x) << 1 (row -> even "ix" bits, column -> odd "iy" bits); the global index
    at order N + 9 is k * 512**2 + sub. Of the 8 possible orientations only this one puts 20 bright stars on
    their catalogue positions (median offset 0.05 deg = 0.4 px at nside 512; the others are >= 0.29 deg).
  * The Norder3/Allsky_<f>.png atlases (27 x 29 cells of 64x64, cell k = order-3 pixel k, row-major, same
    in-cell convention) are POINT SAMPLES: atlas cell pixel (x, y) equals tile pixel (8x, 8y) exactly. The
    Norder0 tiles (12 per frame, also nside 512) are true 8x8 averages, so they are the default source
    (--source tiles); --source allsky keeps the atlas path for comparison.
  * The SPHEREx deep fields at the ecliptic poles are blank in every D1, D3, D4 and D6 frame of the cube.
    Those gaps (~13 deg^2 each) are filled from the partner detector that shares the field of view through the
    dichroic (D2 for D1/D3, D5 for D6), scaled by a robust linear fit on a ring around each gap.
  * A few degree-long streak artefacts sit at fixed sky positions in every D1 frame (and in D2): they are
    clamped against the 2 um map (ARTIFACT_CLAMP), which no real source exceeds.
  * The faint sky is quantised in steps of 0.157 MJy/sr and neighbouring frames are nearly identical there, so
    averaging does not dither it; the stretch keeps a one-step background difference close to black.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
from PIL import Image

REPO = Path(__file__).resolve().parents[1]
HIPS_URL = "https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube"
CACHE_DIR = REPO / "data" / "cache" / "hips"
OUT_DIR = REPO / "frontend" / "public" / "textures"
USER_AGENT = "planet-x-hunter-texture-builder/1.0"
CREDIT = "SPHEREx DR1 all-sky cube, Caltech/IPAC/NASA; IRSA"

TILE_WIDTH = 512
CUT_MIN, CUT_MAX = 0.0, 40.0  # hips_pixel_cut, the same for every frame of the cube
BLANK_FRAMES = {50, 51}  # dichroic channels (D3 ch17, D4 ch1): no tiles on the server
SIZE_4K = (4096, 2048)
SIZE_2K = (2048, 1024)
SIZE_8K = (8192, 4096)
WEBP_QUALITY = 85

# Frame f = 17 * (detector - 1) + (channel - 1); wavelengths come from data_cube_crval3_arr.
CHANNELS = {
    "blue": list(range(3, 12)),  # D1 ch 4-12, 0.809-0.978 um
    "green": list(range(35, 47)),  # D3 ch 2-13, 1.695-2.189 um
    "red": list(range(73, 100)),  # D5 ch 6-17 + D6 ch 1-15, 4.005-4.915 um
    "mono": [21, 22, 23],  # D2 ch 5-7, 1.224-1.284 um (centre 1.254 um; fewer streaks than ch 1-4)
}
# Gap filling: detector -> partner detector with the same field of view, and the partner frames to use.
FILL_FROM = {1: 2, 3: 2, 4: 5, 6: 5}
REFERENCE_FRAMES = {2: list(range(17, 34)), 5: list(range(73, 85))}
# Detector-specific streak artefacts (arcs of a few degrees, present in every D1 frame and in the D2 frames at
# the same sky positions, absent at 2 um) are clamped against the green map: channel <= k * green + c (q units).
# Real sources stay below the clamp: even hot stars have F(0.9 um)/F(2 um) < 5 and F(1.25 um)/F(2 um) < 3.
ARTIFACT_CLAMP = {"blue": (5.0, 0.35), "mono": (3.5, 0.35)}

# Colour stretch, in linear q units (1 q = 40/255 ~ 0.157 MJy/sr). Each channel: subtract black, multiply by
# gain (white balance: inner-disk light warm neutral, bulge cream-gold), then asinh(x / soft) / asinh(white / soft).
# Colour is then scaled about a luma by `saturation` and laid over a near-black floor. The black points sit near
# the high-latitude sky level so the 1-step (0.157 MJy/sr) quantisation of the faint background stays dark.
RGB_STRETCH = {
    "black_q": {"red": 0.22, "green": 0.25, "blue": 0.35},
    "gain": {"red": 2.4, "green": 1.0, "blue": 1.15},
    "soft_q": 2.2,
    "white_q": 400.0,
    "saturation": 0.95,
    "luma_weights_rgb": [0.3, 0.5, 0.2],
    "floor_srgb": [6, 7, 10],
}
MONO_STRETCH = {"black_q": 0.8, "soft_q": 1.2, "white_q": 300.0, "floor_srgb": 6}

# Reference positions (deg, ICRS) used by the self-checks and the previews.
REFERENCE = {
    "Galactic centre": (266.40, -28.94),
    "LMC": (80.89, -69.76),
    "SMC": (13.19, -72.83),
    "Betelgeuse": (88.79, 7.41),
    "Antares": (247.35, -26.43),
}
TARGETS = {
    "Barnard's Star": (269.4461, 4.7707),
    "eps Indi B": (331.0984, -56.8013),
    "WISE 0855-0714": (133.7578, -7.2420),
    "RW Aur": (76.9561, 30.4011),
    "R Dra": (248.1672, 66.7550),
}
# Bright near-IR stars (J2000) for the pixel-convention check.
CHECK_STARS = {
    "Betelgeuse": (88.7929, 7.4071),
    "Antares": (247.3519, -26.4320),
    "Aldebaran": (68.9802, 16.5093),
    "Arcturus": (213.9153, 19.1824),
    "Sirius": (101.2872, -16.7161),
    "Canopus": (95.9880, -52.6957),
    "Rigel": (78.6345, -8.2016),
    "Vega": (279.2347, 38.7837),
    "Capella": (79.1723, 45.9980),
    "Pollux": (116.3290, 28.0262),
    "Procyon": (114.8255, 5.2250),
    "Gacrux": (187.7915, -57.1132),
    "R Dor": (69.1900, -62.0775),
    "Mira": (34.8366, -2.9776),
    "beta Gru": (340.6669, -46.8846),
    "Scheat": (345.9436, 28.0828),
    "Mirach": (17.4330, 35.6206),
    "Kochab": (222.6764, 74.1555),
    "Dubhe": (165.9320, 61.7510),
    "Alphard": (141.8968, -8.6586),
}


def log(msg: str) -> None:
    print(msg, flush=True)


def detector(frame: int) -> int:
    return frame // 17 + 1


# --------------------------------------------------------------------------------------------- download


def fetch(url: str, dest: Path, retries: int = 4) -> Path | None:
    """Download url to dest unless it is cached. Returns None on HTTP 404."""
    if dest.exists() and dest.stat().st_size > 0:
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    err: Exception | None = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=120) as resp:
                data = resp.read()
            tmp = dest.with_suffix(dest.suffix + ".part")
            tmp.write_bytes(data)
            tmp.replace(dest)
            return dest
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                return None
            err = exc
        except (urllib.error.URLError, TimeoutError, ConnectionError) as exc:
            err = exc
        time.sleep(2**attempt)
    raise RuntimeError(f"failed to download {url}: {err}")


def read_properties(cache: Path) -> dict[str, str]:
    path = fetch(f"{HIPS_URL}/properties", cache / "properties")
    props = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            key, _, value = line.partition("=")
            props[key.strip()] = value.strip()
    assert props["hips_frame"] == "equatorial", props["hips_frame"]
    assert int(props["hips_tile_width"]) == TILE_WIDTH
    assert props["hips_pixel_cut"].split() == ["0", "40"], props["hips_pixel_cut"]
    return props


def wavelengths(props: dict[str, str]) -> list[float]:
    wl = [float(v) for v in props["data_cube_crval3_arr"].split()]
    assert len(wl) == int(props["hips_cube_depth"]) == 102
    return wl


def tile_path(order: int, npix: int, frame: int) -> str:
    suffix = "" if frame == 0 else f"_{frame}"
    return f"Norder{order}/Dir{(npix // 10000) * 10000}/Npix{npix}/Npix{npix}{suffix}.png"


def allsky_path(frame: int) -> str:
    return "Norder3/Allsky.png" if frame == 0 else f"Norder3/Allsky_{frame}.png"


def download_frames(frames: list[int], source: str, order: int, cache: Path, workers: int) -> None:
    jobs = []
    for f in frames:
        if source == "allsky":
            jobs.append(allsky_path(f))
        else:
            jobs.extend(tile_path(order, k, f) for k in range(12 * 4**order))
    todo = [p for p in jobs if not (cache / p).exists()]
    log(f"  {len(jobs)} files needed, {len(todo)} to download")
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=workers) as pool:
        results = list(pool.map(lambda p: fetch(f"{HIPS_URL}/{p}", cache / p), todo))
    missing = [p for p, r in zip(todo, results) if r is None]
    if missing:
        raise RuntimeError(f"{len(missing)} files missing on the server, e.g. {missing[:3]}")
    if todo:
        log(f"  downloaded in {time.time() - t0:.0f} s")


# --------------------------------------------------------------------------------------------- decoding

# Observed grey levels of HipsGen's asinh LUT for q = 0..36 (strictly increasing, so exactly invertible).
LUT_LEVELS = (
    0,
    35,
    58,
    73,
    84,
    93,
    100,
    107,
    112,
    117,
    121,
    125,
    129,
    132,
    135,
    138,
    140,
    143,
    145,
    147,
    150,
    151,
    153,
    155,
    157,
    159,
    160,
    162,
    163,
    165,
    166,
    167,
    169,
    170,
    171,
    172,
    174,
)
LUT_TOP = 253  # brightest grey level that occurs (saturated pixels)


def _lut_model_b() -> float:
    """B of grey = LUT_TOP * asinh(B q) / asinh(B LUT_TOP), anchored so that q = 36 -> grey 174."""
    target = LUT_LEVELS[-1] / LUT_TOP
    lo, hi = 1e-3, 50.0
    for _ in range(200):
        mid = math.sqrt(lo * hi)
        val = math.asinh(mid * (len(LUT_LEVELS) - 1)) / math.asinh(mid * LUT_TOP)
        lo, hi = (mid, hi) if val < target else (lo, mid)
    return math.sqrt(lo * hi)


def gray_to_q_table() -> np.ndarray:
    """PNG grey level (0..255) -> linear quantisation level q (float)."""
    table = np.interp(np.arange(256), LUT_LEVELS, np.arange(len(LUT_LEVELS))).astype(np.float64)
    b = _lut_model_b()
    hi = np.arange(LUT_LEVELS[-1] + 1, 256)
    table[hi] = np.sinh(np.minimum(hi, LUT_TOP) / LUT_TOP * math.asinh(b * LUT_TOP)) / b
    return table


GRAY_TO_Q = gray_to_q_table()
Q_TO_MJY_SR = (CUT_MAX - CUT_MIN) / 255.0  # approximate surface brightness of one q step


def decode_png(path: Path) -> tuple[np.ndarray, np.ndarray]:
    """Return (q, valid) for a HiPS PNG tile or atlas; q is the linear level (float32)."""
    im = Image.open(path)
    if im.mode == "P":
        idx = np.asarray(im).astype(np.int16)
        pal = np.asarray(im.getpalette()[: 3 * 256]).reshape(-1, 3)[:, 0]
        assert pal[1] == 0 and pal[36] == 35, f"unexpected palette in {path}"
        gray, valid = np.clip(idx - 1, 0, 255), idx > 0
    else:
        a = np.asarray(im.convert("LA"))
        gray, valid = a[..., 0], a[..., 1] > 0
    return GRAY_TO_Q[gray].astype(np.float32), valid


def spread_bits(v: np.ndarray, nbits: int) -> np.ndarray:
    v = v.astype(np.int64)
    out = np.zeros_like(v)
    for b in range(nbits):
        out |= ((v >> b) & 1) << (2 * b)
    return out


def tile_subindex(width: int) -> np.ndarray:
    """NESTED sub-pixel index of each pixel of a HiPS tile or atlas cell (array [row, col], row 0 = top)."""
    nbits = width.bit_length() - 1
    row, col = np.mgrid[0:width, 0:width]
    return spread_bits(row, nbits) | (spread_bits(col, nbits) << 1)


def frame_map(frame: int, source: str, order: int, cache: Path) -> np.ndarray:
    """Full-sky HEALPix NESTED map (float32, NaN = blank) of one cube frame, in q units."""
    if source == "allsky":  # order-3 atlas, 64x64 cells -> nside 512 (point samples, see module doc)
        q, valid = decode_png(cache / allsky_path(frame))
        sub = tile_subindex(64)
        m = np.full(12 * 512 * 512, np.nan, np.float32)
        for k in range(768):
            r, c = divmod(k, 27)
            win = (slice(r * 64, (r + 1) * 64), slice(c * 64, (c + 1) * 64))
            m[k * 4096 + sub] = np.where(valid[win], q[win], np.nan)
        return m
    sub = tile_subindex(TILE_WIDTH)
    ntile = 12 * 4**order
    m = np.full(ntile * TILE_WIDTH**2, np.nan, np.float32)
    for k in range(ntile):
        q, valid = decode_png(cache / tile_path(order, k, frame))
        m[k * TILE_WIDTH**2 + sub] = np.where(valid, q, np.nan)
    return m


def mean_map(frames: list[int], source: str, order: int, cache: Path) -> np.ndarray:
    """NaN-aware mean of several frames (NaN where every frame is blank)."""
    acc = cnt = None
    for f in frames:
        m = frame_map(f, source, order, cache)
        ok = np.isfinite(m)
        if acc is None:
            acc, cnt = np.zeros(m.shape), np.zeros(m.shape, np.int32)
        acc[ok] += m[ok]
        cnt[ok] += 1
    out = np.full(acc.shape, np.nan, np.float32)
    out[cnt > 0] = acc[cnt > 0] / cnt[cnt > 0]
    return out


def _ring(hole: np.ndarray, nside: int, steps: int) -> np.ndarray:
    from astropy_healpix import neighbours

    grown = hole.copy()
    frontier = np.nonzero(hole)[0]
    for _ in range(steps):
        nb = neighbours(frontier, nside, order="nested").ravel()
        nb = np.unique(nb[nb >= 0])
        frontier = nb[~grown[nb]]
        grown[frontier] = True
    return grown & ~hole


def _robust_line(x: np.ndarray, y: np.ndarray) -> tuple[float, float]:
    keep = np.ones(x.size, bool)
    a, b = 1.0, 0.0
    for _ in range(6):
        a, b = np.polyfit(x[keep], y[keep], 1)
        r = y - (a * x + b)
        mad = 1.4826 * np.median(np.abs(r[keep] - np.median(r[keep])))
        keep = np.abs(r) < 3.0 * max(mad, 0.05)
    return float(a), float(b)


def fill_gaps(m: np.ndarray, ref: np.ndarray, nside: int) -> tuple[np.ndarray, list[dict]]:
    """Fill all-blank regions of m with a*ref + b, fitted on a ~1.2 deg ring around the gaps.

    Fitted separately per hemisphere (in practice: the north and south ecliptic pole deep fields).
    """
    import astropy.units as u
    from astropy_healpix import HEALPix

    hole = ~np.isfinite(m)
    if not hole.any():
        return m, []
    hp = HEALPix(nside=nside, order="nested")
    ring = _ring(hole, nside, steps=max(4, nside // 50)) & np.isfinite(ref)
    out = m.copy()
    fits = []
    for sign, name in ((1, "north"), (-1, "south")):
        idx_h = np.nonzero(hole)[0]
        idx_h = idx_h[sign * hp.healpix_to_lonlat(idx_h)[1].to_value(u.deg) > 0]
        if idx_h.size == 0:
            continue
        idx_r = np.nonzero(ring)[0]
        idx_r = idx_r[sign * hp.healpix_to_lonlat(idx_r)[1].to_value(u.deg) > 0]
        a, b = _robust_line(ref[idx_r].astype(np.float64), m[idx_r].astype(np.float64))
        out[idx_h] = np.maximum(a * ref[idx_h] + b, 0.0)
        lon, lat = hp.healpix_to_lonlat(idx_h)
        fits.append(
            {
                "hemisphere": name,
                "pixels": int(idx_h.size),
                "area_deg2": round(float(idx_h.size * hp.pixel_area.to_value(u.deg**2)), 1),
                "centre_ra_dec": [
                    round(float(np.degrees(np.angle(np.exp(1j * lon.to_value(u.rad)).mean())) % 360), 2),
                    round(float(lat.to_value(u.deg).mean()), 2),
                ],
                "scale": round(a, 4),
                "offset_q": round(b, 4),
            }
        )
    return out, fits


def channel_map(
    frames: list[int], source: str, order: int, cache: Path, refs: dict[int, np.ndarray], nside: int
) -> tuple[np.ndarray, list[dict]]:
    """Frame-weighted mean of per-detector means, with all-blank gaps filled from the partner detector."""
    groups: dict[int, list[int]] = {}
    for f in frames:
        groups.setdefault(detector(f), []).append(f)
    acc = np.zeros(12 * nside**2)
    notes = []
    for det, fs in groups.items():
        g = mean_map(fs, source, order, cache)
        if not np.isfinite(g).all():
            partner = FILL_FROM[det]
            g, fits = fill_gaps(g, refs[partner], nside)
            for fit in fits:
                notes.append({"detector": det, "filled_from_detector": partner, **fit})
        acc += np.nan_to_num(g, nan=0.0) * len(fs)
    return (acc / len(frames)).astype(np.float32), notes


# --------------------------------------------------------------------------------------------- geometry


def plate_carree_wcs(width: int, height: int):
    """WCS of the textures: RA = 0 at the left edge increasing to the right, Dec +90 on the top row."""
    from astropy.wcs import WCS

    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---CAR", "DEC--CAR"]
    w.wcs.crval = [180.0, 0.0]
    w.wcs.crpix = [width / 2 + 0.5, height / 2 + 0.5]
    w.wcs.cdelt = [360.0 / width, -180.0 / height]
    w.wcs.cunit = ["deg", "deg"]
    return w


def pixel_to_radec(x, y, width: int, height: int):
    """Documented mapping: pixel centre (x, y) (0-based, y from the top) -> (RA, Dec) in deg."""
    return (np.asarray(x) + 0.5) * 360.0 / width, 90.0 - (np.asarray(y) + 0.5) * 180.0 / height


def radec_to_pixel(ra, dec, width: int, height: int):
    """Inverse of pixel_to_radec (continuous pixel coordinates)."""
    return np.mod(ra, 360.0) / 360.0 * width - 0.5, (90.0 - np.asarray(dec)) / 180.0 * height - 0.5


def threejs_position(ra, dec, radius: float = 1.0):
    """Marker position on a three.js SphereGeometry (default UVs, flipY = true, no mesh rotation)."""
    a, d = np.radians(ra), np.radians(dec)
    return radius * np.stack([-np.cos(d) * np.cos(a), np.sin(d), np.cos(d) * np.sin(a)], axis=-1)


def to_plate_carree(m: np.ndarray, width: int, height: int) -> np.ndarray:
    from reproject import reproject_from_healpix

    arr, foot = reproject_from_healpix(
        (m, "icrs"), plate_carree_wcs(width, height), shape_out=(height, width), nested=True
    )
    assert np.all(foot > 0), "reprojection left holes"
    return arr.astype(np.float32)


def angular_sep(lon1, lat1, lon2, lat2):
    l1, b1, l2, b2 = map(np.radians, (lon1, lat1, lon2, lat2))
    c = np.sin(b1) * np.sin(b2) + np.cos(b1) * np.cos(b2) * np.cos(l1 - l2)
    return np.degrees(np.arccos(np.clip(c, -1, 1)))


# --------------------------------------------------------------------------------------------- rendering


def stretch_rgb(pc: dict[str, np.ndarray], s: dict = RGB_STRETCH) -> np.ndarray:
    """Float RGB in 0..1 (display / sRGB-encoded values) from the plate-carree channel maps."""
    norm = np.arcsinh(s["white_q"] / s["soft_q"])
    y = []
    for c in ("red", "green", "blue"):
        x = s["gain"][c] * np.maximum(pc[c] - s["black_q"][c], 0.0)
        y.append(np.arcsinh(x / s["soft_q"]) / norm)
    luma = sum(w * v for w, v in zip(s["luma_weights_rgb"], y))
    rgb = np.clip(np.stack([luma + s["saturation"] * (v - luma) for v in y], -1), 0.0, 1.0)
    floor = np.asarray(s["floor_srgb"], np.float32) / 255.0
    return (floor + (1.0 - floor) * rgb).astype(np.float32)


def stretch_mono(m: np.ndarray, s: dict = MONO_STRETCH) -> np.ndarray:
    """Single-channel float image in 0..1 (display values)."""
    y = np.arcsinh(np.maximum(m - s["black_q"], 0.0) / s["soft_q"]) / np.arcsinh(s["white_q"] / s["soft_q"])
    floor = s["floor_srgb"] / 255.0
    return (floor + (1.0 - floor) * np.clip(y, 0.0, 1.0)).astype(np.float32)


def downsample2(img: np.ndarray) -> np.ndarray:
    h, w = img.shape[:2]
    return img.reshape(h // 2, 2, w // 2, 2, *img.shape[2:]).mean(axis=(1, 3))


def to_uint8(img: np.ndarray, seed: int = 1) -> np.ndarray:
    """Quantise with a +-0.5 LSB random dither (avoids contour banding in dark gradients)."""
    rng = np.random.default_rng(seed)
    return np.clip(np.floor(img * 255.0 + rng.random(img.shape, dtype=np.float32)), 0, 255).astype(np.uint8)


def save_webp(arr: np.ndarray, path: Path) -> int:
    """Lossy WebP (an L image is stored as grey RGB, which WebP encodes with neutral chroma)."""
    Image.fromarray(arr, "RGB" if arr.ndim == 3 else "L").save(path, "WEBP", quality=WEBP_QUALITY, method=6)
    return path.stat().st_size


# --------------------------------------------------------------------------------------------- checks


def check_convention(source: str, order: int, cache: Path, frame: int = 20) -> dict:
    """Empirical check of the in-tile pixel order: bright stars must peak where they should.

    Re-indexes the frame-20 map with all 8 dihedral variants of (row, col) -> (ix, iy) and measures the
    distance between each bright star and the brightest pixel within 0.6 deg of it. Only the adopted
    convention (row -> even bits, col -> odd bits) puts them on top of each other.
    """
    import astropy.units as u
    from astropy_healpix import HEALPix

    nside = 512 if source == "allsky" else 2 ** (9 + order)
    width = 64 if source == "allsky" else TILE_WIDTH
    nbits = width.bit_length() - 1
    hp = HEALPix(nside=nside, order="nested")
    adopted = frame_map(frame, source, order, cache)
    tiles = adopted.reshape(-1, width * width)[:, tile_subindex(width)]  # [tile, row, col]
    row, col = np.mgrid[0:width, 0:width]
    mx = width - 1
    variants = {
        "row->ix, col->iy (adopted)": (row, col),
        "col->ix, row->iy": (col, row),
        "flip rows": (mx - row, col),
        "flip cols": (row, mx - col),
        "flip both": (mx - row, mx - col),
        "transpose + flip rows": (mx - col, row),
        "transpose + flip cols": (col, mx - row),
        "transpose + flip both": (mx - col, mx - row),
    }
    px = hp.pixel_resolution.to_value(u.deg)
    results = {}
    for name, (a, b) in variants.items():
        m = np.empty_like(adopted)
        m.reshape(-1, width * width)[:, spread_bits(a, nbits) | (spread_bits(b, nbits) << 1)] = tiles
        offs = []
        for ra, dec in CHECK_STARS.values():
            disc = hp.cone_search_lonlat(ra * u.deg, dec * u.deg, radius=0.6 * u.deg)
            plon, plat = hp.healpix_to_lonlat(disc[np.nanargmax(m[disc])])
            offs.append(angular_sep(ra, dec, plon.to_value(u.deg), plat.to_value(u.deg)))
        offs = np.array(offs)
        results[name] = {
            "median_offset_deg": round(float(np.median(offs)), 4),
            "within_2px": int(np.sum(offs < 2 * px)),
            "n": len(offs),
        }
        log(
            f"    {name:28s} median star-peak offset {results[name]['median_offset_deg']:.3f} deg, "
            f"{results[name]['within_2px']:2d}/{len(offs)} within 2 px"
        )
    best = min(results, key=lambda k: results[k]["median_offset_deg"])
    assert best.endswith("(adopted)"), f"pixel convention check failed: best is {best}"
    return results


def check_mapping(maps: dict[str, np.ndarray], pc: dict[str, np.ndarray], nside: int) -> dict:
    """The reprojection must follow the documented formula exactly; no seam at RA 0/360."""
    import astropy.units as u
    from astropy_healpix import HEALPix

    h, w = pc["green"].shape
    wcs = plate_carree_wcs(w, h)
    rng = np.random.default_rng(0)
    xs, ys = rng.integers(0, w, 4000), rng.integers(0, h, 4000)
    xs[:4], ys[:4] = [0, w - 1, 0, w - 1], [0, 0, h - 1, h - 1]
    ra_f, dec_f = pixel_to_radec(xs, ys, w, h)
    world = wcs.pixel_to_world_values(xs, ys)
    d_ra = np.abs(((world[0] - ra_f) + 180) % 360 - 180).max()
    d_dec = np.abs(world[1] - dec_f).max()
    assert d_ra < 1e-8 and d_dec < 1e-8, (d_ra, d_dec)
    hp = HEALPix(nside=nside, order="nested")
    direct = hp.interpolate_bilinear_lonlat(ra_f * u.deg, dec_f * u.deg, maps["green"])
    d_val = np.abs(direct - pc["green"][ys, xs]).max()
    assert d_val < 1e-3, d_val
    g = pc["green"]
    seam = np.abs(g[:, 0] - g[:, -1]).mean()
    inner = np.abs(np.diff(g, axis=1)).mean()
    assert seam < 1.5 * inner, (seam, inner)
    out = {
        "wcs_vs_formula_max_deg": float(max(d_ra, d_dec)),
        "reproject_vs_direct_bilinear_max_q": float(d_val),
        "seam_mean_abs_diff_q": float(seam),
        "adjacent_column_mean_abs_diff_q": float(inner),
    }
    log(
        f"    WCS == formula to {max(d_ra, d_dec):.1e} deg; reprojection == direct HEALPix bilinear to "
        f"{d_val:.1e} q; RA 0/360 seam step {seam:.3f} q vs {inner:.3f} q between any adjacent columns"
    )
    return out


SAMPLE_RADII = {"Galactic centre": (1.0, 20.0, 30.0), "LMC": (2.5, 10.0, 16.0), "SMC": (1.2, 5.0, 9.0)}


def sample_positions(rgb: np.ndarray) -> list[dict]:
    """Sample the RGB texture at the reference objects and the challenge targets via the documented mapping."""
    h, w = rgb.shape[:2]
    lum = rgb.astype(np.float32) @ np.array([0.2126, 0.7152, 0.0722], np.float32)
    ra_all, dec_all = pixel_to_radec(np.arange(w), np.arange(h), w, h)
    rows = []
    for kind, table in (("reference", REFERENCE), ("target", TARGETS)):
        for name, (ra, dec) in table.items():
            x, y = radec_to_pixel(ra, dec, w, h)
            xi, yi = round(float(x)), round(float(y))
            core_r, bg_in, bg_out = SAMPLE_RADII.get(name, (0.25, 1.0, 2.0))
            # band of rows that holds the background annulus, then exact angular distances
            dy = math.ceil((bg_out + 1) / 180 * h) + 2
            y0, y1 = max(0, yi - dy), min(h, yi + dy + 1)
            sep = angular_sep(ra, dec, ra_all[None, :], dec_all[y0:y1, None])
            core = sep < core_r
            bg = (sep > bg_in) & (sep < bg_out)
            win = lum[y0:y1]
            rows.append(
                {
                    "kind": kind,
                    "name": name,
                    "ra": ra,
                    "dec": dec,
                    "pixel_4k": [round(float(x), 1), round(float(y), 1)],
                    "rgb_at_position": rgb[yi, xi].tolist(),
                    "core_radius_deg": core_r,
                    "background_annulus_deg": [bg_in, bg_out],
                    "core_peak_luma": round(float(win[core].max()), 1),
                    "core_mean_luma": round(float(win[core].mean()), 1),
                    "background_median_luma": round(float(np.median(win[bg])), 1),
                    "luma_percentile_of_core_peak": round(float((lum < win[core].max()).mean() * 100), 2),
                }
            )
    return rows


# --------------------------------------------------------------------------------------------- previews


def _ring_path(ra0: float, dec0: float, r: float, n: int = 120):
    """Small circle of angular radius r around (ra0, dec0) as (ra, dec) arrays."""
    t = np.linspace(0, 2 * np.pi, n)
    d0, a0, rr = np.radians(dec0), np.radians(ra0), np.radians(r)
    dec = np.arcsin(np.sin(d0) * np.cos(rr) + np.cos(d0) * np.sin(rr) * np.cos(t))
    ra = a0 + np.arctan2(np.sin(t) * np.sin(rr) * np.cos(d0), np.cos(rr) - np.sin(d0) * np.sin(dec))
    return np.degrees(ra), np.degrees(dec)


def _draw_markers(ax, radius: dict[str, float], fontsize: int = 9):
    for table, color in ((REFERENCE, "#7CFC9A"), (TARGETS, "#5AD7FF")):
        for name, (ra, dec) in table.items():
            r = radius.get(name, 1.2)
            pra, pdec = _ring_path(ra, dec, r)
            pra = np.unwrap(np.radians(pra))
            pra = np.degrees(pra)
            for shift in (-360, 0, 360):
                ax.plot(pra + shift, pdec, color=color, lw=1.0)
            ax.annotate(
                name,
                (ra, dec),
                xytext=(6, 6 + r * 2),
                textcoords="offset points",
                color=color,
                fontsize=fontsize,
                clip_on=True,
            )


def _grid(ax, step_ra=30, step_dec=30):
    for ra in range(0, 361, step_ra):
        ax.axvline(ra, color="w", lw=0.4, alpha=0.35)
    for dec in range(-90, 91, step_dec):
        ax.axhline(dec, color="w", lw=0.4, alpha=0.35)


def render_globe(
    tex: np.ndarray, ra0: float, dec0: float, size: int = 900, bg=(5, 5, 5)
) -> tuple[np.ndarray, callable]:
    """Orthographic view of the textured three.js sphere from outside, centred on (ra0, dec0), north up.

    Uses three.js SphereGeometry's own parametrisation (phi = 2 pi u, theta = pi (1 - v_uv), flipY texture)
    to look the texture up, so markers placed with threejs_position() must land on the right features.
    Returns the image and a function mapping (ra, dec) -> screen (x, y) (None if on the far side).
    """
    h, w = tex.shape[:2]
    d = threejs_position(ra0, dec0)
    up = np.array([0.0, 1.0, 0.0])
    fwd = -d
    right = np.cross(fwd, up)
    right /= np.linalg.norm(right)
    upv = np.cross(right, fwd)
    s = (np.arange(size) + 0.5) / size * 2 - 1
    sx, sy = np.meshgrid(s, -s)
    rr = sx**2 + sy**2
    vis = rr < 1
    zz = np.sqrt(np.clip(1 - rr, 0, None))
    p = sx[..., None] * right + sy[..., None] * upv + zz[..., None] * d
    theta = np.arccos(np.clip(p[..., 1], -1, 1))  # 0 at +Y
    phi = np.mod(np.arctan2(p[..., 2], -p[..., 0]), 2 * np.pi)
    u = phi / (2 * np.pi)
    v_uv = 1 - theta / np.pi
    col = np.clip((u * w).astype(int), 0, w - 1)
    row = np.clip(((1 - v_uv) * h).astype(int), 0, h - 1)  # flipY: v_uv = 1 is the image's top row
    img = np.empty((size, size, 3), np.uint8)
    img[:] = bg
    img[vis] = tex[row[vis], col[vis]]

    def project(ra, dec):
        q = threejs_position(ra, dec)
        if q @ d <= 0:
            return None
        return ((q @ right + 1) / 2 * size, (1 - q @ upv) / 2 * size)

    return img, project


def write_previews(rgb8: np.ndarray, mono8: np.ndarray, outdir: Path) -> list[Path]:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    outdir.mkdir(parents=True, exist_ok=True)
    paths = []
    radius = {"Galactic centre": 2.5, "LMC": 5.0, "SMC": 2.5}

    def save(fig, name):
        p = outdir / name
        fig.savefig(p, dpi=100, facecolor="#050505")
        plt.close(fig)
        paths.append(p)

    for img, name, title in (
        (rgb8, "full_rgb_grid.png", "SPHEREx false colour (B 0.8-1.0, G 1.7-2.2, R 4.0-4.9 um)"),
        (mono8, "full_mono_grid.png", "SPHEREx 1.25 um (mono)"),
    ):
        fig = plt.figure(figsize=(24, 12.6))
        ax = fig.add_axes([0.03, 0.05, 0.95, 0.9])
        ax.imshow(img[::2, ::2], extent=(0, 360, -90, 90), origin="upper", interpolation="lanczos")
        _grid(ax)
        _draw_markers(ax, radius)
        ax.set_xlim(0, 360)
        ax.set_ylim(-90, 90)
        ax.set_xticks(range(0, 361, 30))
        ax.set_yticks(range(-90, 91, 30))
        ax.tick_params(colors="w")
        ax.set_xlabel("RA (deg), increasing to the right", color="w")
        ax.set_ylabel("Dec (deg)", color="w")
        ax.set_title(f"{title}: texture as stored (RA 0 left, Dec +90 top)", color="w")
        save(fig, name)

    zooms = (
        ("zoom_galactic_centre.png", (232, 300, -60, 2)),
        ("zoom_magellanic_clouds.png", (-5, 115, -84, -56)),
    )
    w = rgb8.shape[1]
    tiled = np.concatenate([rgb8[:, -w // 8 :], rgb8, rgb8[:, : w // 8]], axis=1)  # allow RA < 0 and > 360
    for name, (ra0, ra1, d0, d1) in zooms:
        fig = plt.figure(figsize=(14, 9))
        ax = fig.add_axes([0.06, 0.07, 0.9, 0.86])
        ax.imshow(tiled, extent=(-45, 405, -90, 90), origin="upper", interpolation="nearest")
        _grid(ax, 10, 10)
        _draw_markers(ax, radius, fontsize=11)
        ax.set_xlim(ra0, ra1)
        ax.set_ylim(d0, d1)
        ax.set_aspect(1 / math.cos(math.radians((d0 + d1) / 2)))
        ax.tick_params(colors="w")
        ax.set_xlabel("RA (deg), increasing to the right", color="w")
        ax.set_ylabel("Dec (deg)", color="w")
        ax.set_title(name[:-4].replace("_", " ") + " (4k texture pixels)", color="w")
        save(fig, name)

    views = (
        ("globe_default_camera_+z.png", 90.0, 0.0),
        ("globe_galactic_centre.png", 266.4, -28.94),
        ("globe_magellanic_clouds.png", 45.0, -65.0),
        ("globe_orion.png", 85.0, 5.0),
        ("globe_seam_ra0.png", 0.0, 0.0),
        ("globe_north_pole.png", 0.0, 88.0),
        ("globe_south_pole.png", 0.0, -88.0),
    )
    for name, ra0, dec0 in views:
        img, project = render_globe(rgb8, ra0, dec0)
        fig = plt.figure(figsize=(9, 9))
        ax = fig.add_axes([0, 0, 1, 1])
        ax.imshow(img, interpolation="lanczos")
        for table, color in ((REFERENCE, "#7CFC9A"), (TARGETS, "#5AD7FF")):
            for nm, (ra, dec) in table.items():
                pt = project(ra, dec)
                if pt is not None:
                    ax.add_patch(plt.Circle(pt, 14, fill=False, color=color, lw=1.2))
                    ax.annotate(nm, pt, xytext=(10, 10), textcoords="offset points", color=color, fontsize=10)
        ax.set_axis_off()
        ax.text(
            10,
            25,
            f"three.js view from outside, centre RA {ra0:g} Dec {dec0:g}; rings from "
            "x=-cos(d)cos(a), y=sin(d), z=cos(d)sin(a)",
            color="w",
            fontsize=9,
        )
        save(fig, name)
    return paths


# --------------------------------------------------------------------------------------------- main


def parse_args(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("--cache", type=Path, default=CACHE_DIR)
    p.add_argument("--out", type=Path, default=OUT_DIR)
    p.add_argument("--preview-dir", type=Path, default=None, help="write annotated preview PNGs here")
    p.add_argument(
        "--source",
        choices=["tiles", "allsky"],
        default="tiles",
        help="tiles = Norder<order> tiles (8x8 averages, default); allsky = Norder3 atlases (point samples)",
    )
    p.add_argument(
        "--order",
        type=int,
        default=0,
        choices=[0, 1],
        help="tile order for --source tiles: 0 -> nside 512 (12 tiles/frame), 1 -> nside 1024 (48)",
    )
    p.add_argument(
        "--size",
        choices=["4k", "8k"],
        default="4k",
        help="4k = the standard set (rgb 4k + 2k, mono 4k, JSON); 8k = only spherex-sky-rgb-8k.webp from "
        "Norder1 tiles, added to the existing JSON as files.rgb_8k",
    )
    p.add_argument("--workers", type=int, default=8)
    p.add_argument(
        "--reuse-maps",
        action="store_true",
        help="reuse the channel maps saved in <cache>/derived by a previous run (for stretch tuning)",
    )
    return p.parse_args(argv)


def main(argv=None) -> int:
    args = parse_args(argv)
    t_start = time.time()
    cache, out = args.cache, args.out
    out.mkdir(parents=True, exist_ok=True)
    props = read_properties(cache)
    wl = wavelengths(props)
    big = args.size == "8k"
    if big and (args.source != "tiles" or args.order == 0):
        log("--size 8k: using Norder1 tiles (nside 1024); nside 512 data would only be upsampled")
        args.source, args.order = "tiles", 1
    size_px, tag = (SIZE_8K, "8k") if big else (SIZE_4K, "4k")
    # The 8k file is the false-colour map only.
    channels = {k: v for k, v in CHANNELS.items() if not (big and k == "mono")}
    nside = 512 if args.source == "allsky" else 2 ** (9 + args.order)
    frames = sorted(
        {f for fs in channels.values() for f in fs} | {f for fs in REFERENCE_FRAMES.values() for f in fs}
    )
    assert not BLANK_FRAMES & set(frames) and 0 not in frames
    log(
        f"Downloading {len(frames)} frames ({args.source}, order {args.order if args.source == 'tiles' else 3})"
    )
    download_frames(frames, args.source, args.order, cache, args.workers)

    derived = cache / "derived" / f"{args.source}_order{args.order}"
    saved = derived / "state.json"
    if args.reuse_maps and saved.exists():
        log(f"Reusing channel maps from {derived}")
        state = json.loads(saved.read_text())
        convention, mapping_check, gap_notes = state["convention"], state["mapping"], state["gaps"]
        pc = {name: np.load(derived / f"pc{tag}_{name}.npy") for name in channels}
    else:
        log("Checking the HiPS tile pixel convention against 20 bright stars")
        convention = check_convention(args.source, args.order, cache)

        refs = {det: mean_map(fs, args.source, args.order, cache) for det, fs in REFERENCE_FRAMES.items()}
        for det, r in refs.items():
            assert np.isfinite(r).all(), f"reference detector D{det} has gaps"
        maps, gap_notes = {}, []
        for name, fs in channels.items():
            log(f"Building {name} map from {len(fs)} frames ({wl[fs[0]]:.3f}-{wl[fs[-1]]:.3f} um)")
            maps[name], notes = channel_map(fs, args.source, args.order, cache, refs, nside)
            for n in notes:
                log(
                    f"    filled {n['area_deg2']} deg^2 gap at RA/Dec {n['centre_ra_dec']} in D{n['detector']} from "
                    f"D{n['filled_from_detector']} (x{n['scale']:.3f} {n['offset_q']:+.3f} q)"
                )
                gap_notes.append({"channel": name, **n})
        for name, (k, c) in ARTIFACT_CLAMP.items():
            if name not in maps:
                continue
            limit = k * maps["green"] + c
            log(f"Clamping {name} <= {k} * green + {c} q: {np.mean(maps[name] > limit) * 100:.2f}% of pixels")
            maps[name] = np.minimum(maps[name], limit)
        pc = {}
        for name, m in maps.items():
            log(f"Reprojecting {name} to {size_px[0]}x{size_px[1]} plate carree")
            pc[name] = to_plate_carree(m, *size_px)

        log("Checking the texture mapping")
        mapping_check = check_mapping(maps, pc, nside)
        derived.mkdir(parents=True, exist_ok=True)
        for name, a in pc.items():
            np.save(derived / f"pc{tag}_{name}.npy", a)
        saved.write_text(json.dumps({"convention": convention, "mapping": mapping_check, "gaps": gap_notes}))

    log("Stretching and encoding")
    rgb = stretch_rgb(pc)
    if big:
        return finish_8k(rgb, out, nside, mapping_check, t_start)
    mono = stretch_mono(pc["mono"])
    rgb8_4k, rgb8_2k, mono8_4k = to_uint8(rgb), to_uint8(downsample2(rgb), seed=2), to_uint8(mono, seed=3)
    files = {}
    for key, arr, fname in (
        ("rgb_4k", rgb8_4k, "spherex-sky-rgb-4k.webp"),
        ("rgb_2k", rgb8_2k, "spherex-sky-rgb-2k.webp"),
        ("mono_4k", mono8_4k, "spherex-sky-mono-4k.webp"),
    ):
        size = save_webp(arr, out / fname)
        files[key] = {"path": fname, "width": arr.shape[1], "height": arr.shape[0], "bytes": size}
        log(f"    {fname}: {arr.shape[1]}x{arr.shape[0]}, {size / 1e6:.2f} MB")
        assert size < 2.6e6, f"{fname} is too large"
    # what the browser will see: decode the 4k WebP again for the self-checks
    rgb8_dec = np.asarray(Image.open(out / files["rgb_4k"]["path"]).convert("RGB"))
    samples = check_samples(rgb8_dec, "4k")

    meta = build_metadata(props, wl, files, gap_notes, convention, mapping_check, samples, args, nside)
    (out / "spherex-sky.json").write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    log("    spherex-sky.json written")

    if args.preview_dir:
        log(f"Writing previews to {args.preview_dir}")
        for p in write_previews(
            rgb8_dec, np.asarray(Image.open(out / files["mono_4k"]["path"]).convert("RGB")), args.preview_dir
        ):
            log(f"    {p}")
        (args.preview_dir / "selfcheck.json").write_text(
            json.dumps(
                {"convention": convention, "mapping": mapping_check, "samples": samples, "gaps": gap_notes},
                indent=2,
            )
        )
    log(f"Done in {time.time() - t_start:.0f} s")
    return 0


def check_samples(rgb8: np.ndarray, tag: str) -> list[dict]:
    """Reference objects must land where the documented mapping puts them on the decoded texture."""
    samples = sample_positions(rgb8)
    log(
        f"Samples of the RGB {tag} texture (luma 0-255; percentile = share of the texture darker than the core peak)"
    )
    for r in samples:
        log(
            f"    {r['kind']:9s} {r['name']:16s} px {r['pixel_4k']!s:16s} rgb {r['rgb_at_position']!s:16s} "
            f"core peak {r['core_peak_luma']:5.1f} mean {r['core_mean_luma']:5.1f} vs bg {r['background_median_luma']:5.1f}"
            f"  (p{r['luma_percentile_of_core_peak']:.1f})"
        )
    gc = next(r for r in samples if r["name"] == "Galactic centre")
    assert gc["core_mean_luma"] > 3 * gc["background_median_luma"] > 0, "Galactic centre not where expected"
    for nm in ("LMC", "SMC"):
        r = next(r for r in samples if r["name"] == nm)
        assert r["core_mean_luma"] > 1.5 * r["background_median_luma"], f"{nm} not where expected"
    for nm in ("Betelgeuse", "Antares"):
        r = next(r for r in samples if r["name"] == nm)
        assert r["luma_percentile_of_core_peak"] > 99.9, f"{nm} not where expected"
    return samples


def finish_8k(rgb: np.ndarray, out: Path, nside: int, mapping_check: dict, t_start: float) -> int:
    """Write spherex-sky-rgb-8k.webp and record it in the existing spherex-sky.json (nothing else changes)."""
    fname = "spherex-sky-rgb-8k.webp"
    arr = to_uint8(rgb, seed=4)
    size = save_webp(arr, out / fname)
    log(f"    {fname}: {arr.shape[1]}x{arr.shape[0]}, {size / 1e6:.2f} MB")
    assert size < 8.5e6, f"{fname} is too large"
    check_samples(np.asarray(Image.open(out / fname).convert("RGB")), "8k")
    meta_path = out / "spherex-sky.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    meta["files"]["rgb_8k"] = {
        "path": fname,
        "width": arr.shape[1],
        "height": arr.shape[0],
        "bytes": size,
        "tiles_used": f"Norder1 PNG tiles (HEALPix NESTED nside {nside}, means of the deeper orders)",
        "note": "same frames, gap fill, artefact clamp, mapping and stretch as rgb_4k; twice the angular "
        "detail, a little more pixel noise",
        "mapping_check": mapping_check,
    }
    meta_path.write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    log("    spherex-sky.json: files.rgb_8k recorded")
    log(f"Done in {time.time() - t_start:.0f} s")
    return 0


def build_metadata(props, wl, files, gap_notes, convention, mapping_check, samples, args, nside) -> dict:
    def frames_info(fs):
        return [
            {"frame": f, "detector": detector(f), "channel": f % 17 + 1, "wavelength_um": wl[f]} for f in fs
        ]

    return {
        "title": "SPHEREx all-sky globe textures",
        "credit": CREDIT,
        "files": files,
        "projection": "plate carree (equirectangular), equatorial ICRS",
        "mapping": {
            "summary": "RA = 0 deg at the LEFT edge, increasing to the RIGHT; Dec = +90 at the TOP row, -90 at the "
            "bottom row. Like longitude/latitude on a terrestrial map: correct for a globe seen from OUTSIDE.",
            "uv": "u = RA_deg / 360; v_from_top = (90 - Dec_deg) / 180 (three.js uv.y = 1 - v_from_top = (Dec + 90) / 180)",
            "pixel_centre": "RA = (x + 0.5) * 360 / W, Dec = 90 - (y + 0.5) * 180 / H, x and y 0-based, y from the top",
            "threejs": {
                "geometry": "new THREE.SphereGeometry(r, 128, 64) with default UVs; side: THREE.FrontSide; no mesh rotation",
                "texture": "TextureLoader (flipY = true, the default); colorSpace = THREE.SRGBColorSpace; "
                "anisotropy = renderer.capabilities.getMaxAnisotropy(); "
                "material MeshBasicMaterial({ map, toneMapped: false })",
                "marker_position": "a = RA in radians, d = Dec in radians: "
                "x = -r cos(d) cos(a), y = r sin(d), z = r cos(d) sin(a)",
                "orientation": "north celestial pole at +Y; RA 0 faces -X, RA 90 faces +Z, RA 180 faces +X, "
                "RA 270 faces -Z; seen from a camera on +Z, RA increases to the right",
                "rotation": "put markers in the same group as the sphere; group.rotation.y = PI/2 - a0 turns RA a0 "
                "to face a camera on +Z",
            },
            "seen_from_outside": "a celestial globe seen from outside is the mirror image of the sky seen from Earth "
            "(east is to the right here, to the left on a star chart)",
        },
        "source": {
            "hips": HIPS_URL,
            "obs_title": props.get("obs_title"),
            "hips_release_date": props.get("hips_release_date"),
            "tiles_used": (
                f"Norder{args.order} PNG tiles (HEALPix NESTED nside {nside}, 8x8 means of the deeper orders)"
            )
            if args.source == "tiles"
            else "Norder3 Allsky atlases (point samples, nside 512)",
            "pixel_cut": props.get("hips_pixel_cut"),
            "pixel_function": props.get("hips_pixel_function"),
            "linearisation": "PNG grey -> linear level q via the inverse of HipsGen's asinh LUT; "
            f"1 q ~ {Q_TO_MJY_SR:.4f} MJy/sr",
            "reprojection": "reproject.reproject_from_healpix (bilinear, nested=True) onto RA---CAR/DEC--CAR, "
            "CRVAL 180/0, CDELT +360/W, -180/H",
        },
        "channels": {
            "rgb": {
                "red": {
                    "frames": frames_info(CHANNELS["red"]),
                    "range_um": [wl[CHANNELS["red"][0]], wl[CHANNELS["red"][-1]]],
                },
                "green": {
                    "frames": frames_info(CHANNELS["green"]),
                    "range_um": [wl[CHANNELS["green"][0]], wl[CHANNELS["green"][-1]]],
                },
                "blue": {
                    "frames": frames_info(CHANNELS["blue"]),
                    "range_um": [wl[CHANNELS["blue"][0]], wl[CHANNELS["blue"][-1]]],
                },
                "combination": "mean of the linear frames per detector, frame-weighted mean across detectors",
            },
            "mono": {
                "frames": frames_info(CHANNELS["mono"]),
                "centre_um": wl[CHANNELS["mono"][1]],
                "range_um": [wl[CHANNELS["mono"][0]], wl[CHANNELS["mono"][-1]]],
                "label": f"{wl[CHANNELS['mono'][1]]:.2f} um",
                "combination": "mean of 3 adjacent spectral channels (lower noise, fewer single-channel streaks)",
            },
            "skipped_frames": {"0": "edge channel", "50": "blank (dichroic)", "51": "blank (dichroic)"},
        },
        "artifact_clamp": {
            "rule": "channel = min(channel, k * green + c) on the HEALPix maps, q units",
            "params": {k: {"k": v[0], "c": v[1]} for k, v in ARTIFACT_CLAMP.items()},
            "why": "degree-long streaks at fixed sky positions in every D1 frame and in D2; no real "
            "source is 5x (0.9 um) or 3.5x (1.25 um) brighter than at 2 um",
        },
        "stretch": {
            "rgb": {
                **RGB_STRETCH,
                "formula": "y_c = asinh(gain_c * max(q_c - black_c, 0) / soft) / asinh(white / soft); "
                "out = floor + (1 - floor) * clip(luma + saturation * (y - luma), 0, 1)",
            },
            "mono": {
                **MONO_STRETCH,
                "formula": "y = asinh(max(q - black, 0) / soft) / asinh(white / soft); "
                "out = floor + (1 - floor) * y",
            },
            "encoding": f"sRGB 8 bit with +-0.5 LSB dither, WebP quality {WEBP_QUALITY}",
        },
        "gap_fill": {
            "note": "SPHEREx deep fields at the ecliptic poles are blank in D1/D3/D4/D6 frames of the "
            "DR1 cube; filled from the partner detector (shared field of view) scaled to match",
            "fills": gap_notes,
        },
        "checks": {
            "pixel_convention": convention,
            "mapping": mapping_check,
            "samples": [
                {k: r[k] for k in ("kind", "name", "ra", "dec", "pixel_4k", "rgb_at_position")}
                for r in samples
            ],
        },
        "generator": "scripts/make_sky_texture.py",
    }


if __name__ == "__main__":
    sys.exit(main())
