"""Quick-look 102-channel spectrum at any sky position from the SPHEREx DR1 all-sky cube (Year 1).

The cube (IRSA collection ``spherex_dr1_cube``) is a HiPS of order-5 HEALPix tiles, each a FITS file of
PRIMARY, IMAGE (float32 512x512x102, MJy/sr, HPX projection), NHITS (int32), FLAGS (int32), SPECTRAL_CHANNELS
(per plane: DETECTOR, SUBCHAN, WAVELENGTH, WL_MIN, WL_MAX, R, R_STD, BANDWIDTH) and WCS-WAVE (PLANE,
WAVELENGTHS, BANDWIDTHS). The IMAGE header defines its spectral axis as CTYPE3 = 'WAVE-TAB' with PS3_0 =
'WCS-WAVE', PS3_1 = 'WAVELENGTHS', PS3_2 = 'PLANE', so the WCS-WAVE table is the authoritative wavelength
source; the HiPS ``data_cube_crval3_arr`` property is the same list rounded to 1 nm. Planes 50 and 51
(0-based; D3 channel 17 and D4 channel 1, the dichroic channels) are blank (PRIMARY ``BLANKCH``).

`cube_spectrum` finds the tile (IRSA SIA, cached per tile; later tiles reuse the release path learned from
SIA), reads the tile headers and spectral tables once (two multi-range requests, cached), converts the
position to a tile pixel with the tile's WCS, reads only the needed pixel rows of all 102 planes in
parallel multi-range requests, and does aperture photometry with a local background annulus. Tile pixels
are HEALPix cells of order 5 + 9 = 14, so the pixel solid angle is exactly 4 pi / (12 * 16384^2) sr
(165.97 arcsec^2, 12.88 arcsec on a side).

The cube is labelled "for visualization" by IRSA: no aperture correction is applied, and pixels of
saturated or bright stars are often blank (NaN, NHITS = 0). Such channels get ``flux_ujy = NaN`` and a
lower-limit ``flux_partial_ujy`` from the unmasked aperture pixels (``lower_limit`` True). Verified live:
at Barnard's Star (tile 7945) the 2-7 core pixels are blank (FLAGS TRANSIENT|SUR_ERROR|BLOOM) in 91 of the
100 non-blank planes, so 9 channels are complete and 91 are lower limits; 4 arcmin away all 100 are complete.

Wavelengths: verified identical to the SPECTRAL_CHANNELS WAVELENGTH column (to 1e-6 um) and, rounded to 1 nm,
to the HiPS ``data_cube_crval3_arr`` property (tests/test_cube.py).
"""

from __future__ import annotations

import io
import json
import logging
import math
import re
import threading
import time
import warnings
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
from astropy.io import fits
from astropy.stats import sigma_clipped_stats
from astropy.wcs import WCS, FITSFixedWarning

from pxh import config
from pxh.spherex import flags as flagmod
from pxh.spherex import l2, rangeio

log = logging.getLogger(__name__)

CUBE_LABEL = "DR1 quick-look (Year 1, 12.9 arcsec pixels)"
DEFAULT_COLLECTION = config.FALLBACK_CUBE_COLLECTIONS[0]
META_VERSION = 1
CUBE_HEAD_BYTES = 40960
CUBE_TAIL_BYTES = 4 * l2.BLOCK  # SPECTRAL_CHANNELS + WCS-WAVE extensions (2 blocks each)
CUBE_MAX_GAP = 0  # bytes between row segments merged into one range (0: exact rows only)
SIA_RADIUS_DEG = 0.0005
MIN_ANNULUS_PIXELS = 6

_TILE_URL_RE = re.compile(r"^(?P<prefix>.+/Norder(?P<order>\d+)/)Dir(?P<dir>\d+)/Npix(?P<npix>\d+)_cube\.fits$")


class CubeError(RuntimeError):
    """The cube tile could not be found or read."""


@dataclass(frozen=True)
class CubeTile:
    url: str
    order: int
    npix: int


# --- tile lookup ------------------------------------------------------------------------------------------


def _cube_cache() -> Path:
    return Path(config.CACHE_DIR) / "pixels" / "cube"


def healpix_tile(ra_deg: float, dec_deg: float, order: int = 5) -> int:
    """NESTED HEALPix index of the order-`order` HiPS tile containing (ra, dec) (equatorial frame)."""
    import astropy.units as u
    from astropy_healpix import lonlat_to_healpix

    return int(lonlat_to_healpix(ra_deg * u.deg, dec_deg * u.deg, 2**order, order="nested"))


def tile_url_from_prefix(prefix: str, npix: int) -> str:
    """HiPS tile URL: <prefix>Dir<D>/Npix<N>_cube.fits with D = 10000 * (N // 10000)."""
    return f"{prefix}Dir{(npix // 10000) * 10000}/Npix{npix}_cube.fits"


def parse_tile_url(url: str) -> CubeTile | None:
    m = _TILE_URL_RE.match(url.split("?", 1)[0])
    if not m:
        return None
    return CubeTile(url=url.split("?", 1)[0], order=int(m.group("order")), npix=int(m.group("npix")))


def _template_path(collection: str) -> Path:
    return _cube_cache() / f"{collection}_tile_prefix.json"


def _sia_tiles(ra: float, dec: float, collection: str, radius_deg: float) -> list[CubeTile]:
    """Cube tiles covering a position, from IRSA SIA (with rangeio's retry policy)."""
    from astropy.io.votable import parse_single_table

    params = {
        "COLLECTION": collection,
        "POS": f"CIRCLE {ra:.7f} {dec:.7f} {radius_deg:.6f}",
        "MAXREC": "20",
    }
    body = rangeio.http_get(config.IRSA_SIA_URL, params=params)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        table = parse_single_table(io.BytesIO(body)).to_table(use_names_over_ids=True)
    tiles = []
    for row in table:
        tile = parse_tile_url(str(row["access_url"]))
        if tile is not None:
            tiles.append(tile)
    return tiles


def _read_template(collection: str, order: int) -> dict[str, Any] | None:
    try:
        doc = json.loads(_template_path(collection).read_text(encoding="utf-8"))
        return doc if int(doc["order"]) == order and isinstance(doc["prefix"], str) else None
    except (OSError, ValueError, KeyError, TypeError):
        return None


def find_cube_tile(
    ra_deg: float, dec_deg: float, *, collection: str = DEFAULT_COLLECTION, refresh: bool = False
) -> CubeTile:
    """The cube tile containing a position.

    The tile index comes from HEALPix (order 5, nested, equatorial); its URL from the release path learned
    from an SIA answer at most `config.SIA_CACHE_TTL_S` old (cached on disk), else from a new SIA query whose
    result is checked against HEALPix. If SIA fails, a stale release path is used rather than failing.
    """
    order = 5
    npix = healpix_tile(ra_deg, dec_deg, order)
    doc = _read_template(collection, order)
    if doc is not None and not refresh and time.time() - float(doc.get("fetched_at", 0.0)) < config.SIA_CACHE_TTL_S:
        return CubeTile(tile_url_from_prefix(doc["prefix"], npix), order, npix)
    try:
        tiles = _sia_tiles(ra_deg, dec_deg, collection, SIA_RADIUS_DEG)
    except rangeio.RangeIOError as exc:
        if doc is not None and not refresh:
            log.warning("SIA failed (%s); using the cached %s release path %s", exc, collection, doc["prefix"])
            return CubeTile(tile_url_from_prefix(doc["prefix"], npix), order, npix)
        raise CubeError(f"SIA query for {collection} at ({ra_deg}, {dec_deg}) failed: {exc}") from exc
    if not tiles:
        raise CubeError(f"SIA returned no {collection} tile at ({ra_deg}, {dec_deg})")
    match = [t for t in tiles if t.npix == npix and t.order == order]
    if not match:
        log.warning("SIA tiles %s do not include HEALPix tile %d; using SIA's first", [t.npix for t in tiles], npix)
        return tiles[0]
    tile = match[0]
    m = _TILE_URL_RE.match(tile.url)
    assert m is not None
    doc = {"prefix": m.group("prefix"), "order": order, "from": tile.url, "fetched_at": time.time()}
    rangeio.save_cache_file(_template_path(collection), json.dumps(doc).encode("utf-8"))
    return tile


# --- tile metadata ----------------------------------------------------------------------------------------

_AXIS3_KEY = re.compile(r"^(CTYPE|CRPIX|CRVAL|CDELT|CUNIT|CNAME|CROTA|NAXIS)3$|^(PS|PV)3_\d+$|^PC(3_\d|\d_3)$")


def celestial_header(header: fits.Header) -> fits.Header:
    """Copy of a cube header with the spectral (third) axis keywords removed."""
    h = header.copy()
    for key in list(h.keys()):
        if _AXIS3_KEY.match(key):
            del h[key]
    h["NAXIS"] = 2
    h["WCSAXES"] = 2
    return h


@dataclass
class CubeMeta:
    """Byte layout, WCS and spectral axis of one cube tile."""

    url: str
    file_size: int
    headers: dict[str, str]  # EXTNAME -> header text
    data_start: dict[str, int]  # EXTNAME -> byte offset of the data
    shape: tuple[int, int, int]  # (nplane, ny, nx)
    wavelength_um: np.ndarray
    bandwidth_um: np.ndarray
    wl_min_um: np.ndarray | None
    wl_max_um: np.ndarray | None
    detector: np.ndarray | None
    channel: np.ndarray | None
    blank_planes: list[int]
    pixel_sr: float
    order: int
    npix: int

    @property
    def image_header(self) -> fits.Header:
        return l2.header_from_text(self.headers["IMAGE"])

    def celestial_wcs(self) -> WCS:
        """The tile's HPX celestial WCS (the -TAB spectral axis is dropped: astropy would need the HDUList)."""
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", FITSFixedWarning)
            return WCS(celestial_header(self.image_header))

    def flag_bits(self) -> dict[str, int]:
        return flagmod.flag_bits(l2.header_from_text(self.headers["FLAGS"])) if "FLAGS" in self.headers else {}

    def to_json(self) -> dict[str, Any]:
        def arr(a: np.ndarray | None) -> list | None:
            return None if a is None else np.asarray(a).tolist()

        return {
            "version": META_VERSION, "url": self.url, "file_size": self.file_size, "headers": self.headers,
            "data_start": self.data_start, "shape": list(self.shape),
            "wavelength_um": arr(self.wavelength_um), "bandwidth_um": arr(self.bandwidth_um),
            "wl_min_um": arr(self.wl_min_um), "wl_max_um": arr(self.wl_max_um),
            "detector": arr(self.detector), "channel": arr(self.channel),
            "blank_planes": self.blank_planes, "pixel_sr": self.pixel_sr, "order": self.order, "npix": self.npix,
        }

    @classmethod
    def from_json(cls, d: dict[str, Any]) -> CubeMeta:
        def arr(v: Any, dtype: Any = float) -> np.ndarray | None:
            return None if v is None else np.asarray(v, dtype=dtype)

        return cls(
            url=d["url"], file_size=int(d["file_size"]), headers=dict(d["headers"]),
            data_start={k: int(v) for k, v in d["data_start"].items()}, shape=tuple(d["shape"]),
            wavelength_um=arr(d["wavelength_um"]), bandwidth_um=arr(d["bandwidth_um"]),
            wl_min_um=arr(d.get("wl_min_um")), wl_max_um=arr(d.get("wl_max_um")),
            detector=arr(d.get("detector"), int), channel=arr(d.get("channel"), int),
            blank_planes=list(d["blank_planes"]), pixel_sr=float(d["pixel_sr"]),
            order=int(d["order"]), npix=int(d["npix"]),
        )


def healpix_pixel_sr(order: int, tile_width: int) -> float:
    """Solid angle of one HiPS tile pixel: a HEALPix cell at nside = 2**order * tile_width."""
    nside = (2**order) * tile_width
    return 4.0 * math.pi / (12.0 * nside * nside)


def parse_blank_channels(value: str, channels_per_detector: int = config.CHANNELS_PER_DETECTOR) -> list[int]:
    """'D3:17,D4:01' -> [50, 51] (0-based planes, plane = 17 * (detector - 1) + channel - 1)."""
    out = []
    for tok in str(value or "").split(","):
        m = re.match(r"\s*D(\d+)\s*:\s*(\d+)\s*$", tok)
        if m:
            out.append(channels_per_detector * (int(m.group(1)) - 1) + int(m.group(2)) - 1)
    return sorted(out)


def spectral_axis(image_header: fits.Header, wcs_wave: Any, nplane: int) -> tuple[np.ndarray, np.ndarray | None]:
    """(wavelength, bandwidth) per plane from the -TAB spectral axis (index vector PS3_2, array PS3_1)."""
    ctype = str(image_header.get("CTYPE3", "")).strip()
    if not ctype.endswith("-TAB"):
        crval = float(image_header["CRVAL3"])
        cdelt = float(image_header.get("CDELT3", 1.0))
        crpix = float(image_header.get("CRPIX3", 1.0))
        return crval + cdelt * (np.arange(nplane) + 1 - crpix), None
    values_col = str(image_header.get("PS3_1", "WAVELENGTHS")).strip()
    index_col = str(image_header.get("PS3_2", "PLANE")).strip()
    row = wcs_wave[0]
    values = np.asarray(row[values_col], dtype=float).ravel()
    index = np.asarray(row[index_col], dtype=float).ravel() if index_col else np.arange(1, values.size + 1.0)
    psi = float(image_header.get("CRVAL3", 1.0)) + float(image_header.get("CDELT3", 1.0)) * (
        np.arange(nplane) + 1.0 - float(image_header.get("CRPIX3", 1.0))
    )
    frac = np.interp(psi, index, np.arange(index.size, dtype=float))
    wl = np.interp(frac, np.arange(values.size, dtype=float), values)
    bw = None
    names = wcs_wave.columns.names if hasattr(wcs_wave, "columns") else []
    if "BANDWIDTHS" in names:
        bvals = np.asarray(row["BANDWIDTHS"], dtype=float).ravel()
        bw = np.interp(frac, np.arange(bvals.size, dtype=float), bvals)
    return wl, bw


def _meta_path(url: str) -> Path:
    tile = parse_tile_url(url)
    name = f"order{tile.order}_npix{tile.npix}" if tile else re.sub(r"[^A-Za-z0-9_.-]+", "_", url)[-120:]
    m = re.search(r"/(hips_[^/]+)/", url)
    release = m.group(1) if m else "unknown"
    return _cube_cache() / "meta" / release / f"{name}.json"


_META_LOCK = threading.Lock()
_META_MEM: dict[str, CubeMeta] = {}


def clear_memory_cache() -> None:
    """Forget tile metadata held in memory (the disk cache is kept)."""
    with _META_LOCK:
        _META_MEM.clear()


def read_cube_meta(url: str) -> CubeMeta:
    """Headers, data offsets and spectral tables of a cube tile (cached in memory and on disk)."""
    with _META_LOCK:
        if url in _META_MEM:
            return _META_MEM[url]
    path = _meta_path(url)
    try:
        d = json.loads(path.read_text(encoding="utf-8"))
        if d.get("version") == META_VERSION and d.get("url") == url:
            meta = CubeMeta.from_json(d)
            with _META_LOCK:
                _META_MEM[url] = meta
            return meta
    except (OSError, ValueError, KeyError, TypeError):
        pass
    meta = _build_meta(url)
    rangeio.save_cache_file(path, json.dumps(meta.to_json()).encode("utf-8"))
    with _META_LOCK:
        _META_MEM[url] = meta
    return meta


def _build_meta(url: str) -> CubeMeta:
    rf = l2.RemoteFile(url)
    rf.fetch([(0, CUBE_HEAD_BYTES - 1), (-CUBE_TAIL_BYTES, -1)])
    raw = l2.walk_hdus(rf)
    by = {h.name: h for h in raw}
    for need in ("IMAGE", "WCS-WAVE"):
        if need not in by:
            raise CubeError(f"{url}: no {need} extension (HDUs: {list(by)})")
    img = by["IMAGE"].header
    if int(img.get("NAXIS", 0)) != 3 or int(img.get("BITPIX", 0)) != -32:
        raise CubeError(f"{url}: IMAGE is not a float32 cube")
    nplane, ny, nx = int(img["NAXIS3"]), int(img["NAXIS2"]), int(img["NAXIS1"])

    def table(name: str) -> Any:
        h = by[name]
        n = h.data_start - h.header_start + h.data_length
        blob = rf.prefix(h.header_start, n)
        if len(blob) < n:
            rf.fetch([(h.header_start, h.data_start + h.data_length - 1)])
            blob = rf.prefix(h.header_start, n)
        return l2.table_hdu_from_bytes(blob).data

    wave_tab = table("WCS-WAVE")
    wl, bw = spectral_axis(img, wave_tab, nplane)
    wl_min = wl_max = det = chan = None
    if "SPECTRAL_CHANNELS" in by:
        sc = table("SPECTRAL_CHANNELS")
        names = sc.columns.names
        if len(sc) == nplane:
            det = np.asarray(sc["DETECTOR"], dtype=int) if "DETECTOR" in names else None
            chan = np.asarray(sc["SUBCHAN"], dtype=int) if "SUBCHAN" in names else None
            wl_min = np.asarray(sc["WL_MIN"], dtype=float) if "WL_MIN" in names else None
            wl_max = np.asarray(sc["WL_MAX"], dtype=float) if "WL_MAX" in names else None
            if bw is None and "BANDWIDTH" in names:
                bw = np.asarray(sc["BANDWIDTH"], dtype=float)
            if "WAVELENGTH" in names:
                dmax = float(np.nanmax(np.abs(np.asarray(sc["WAVELENGTH"], dtype=float) - wl)))
                if dmax > 1e-4:
                    log.warning("%s: SPECTRAL_CHANNELS and WCS-WAVE wavelengths differ by %.4g um", url, dmax)
    primary = by["PRIMARY"].header
    blank = parse_blank_channels(str(primary.get("BLANKCH", "")))
    order = int(img.get("ORDER", 5))
    tile = parse_tile_url(url)
    assert rf.size is not None
    return CubeMeta(
        url=url,
        file_size=rf.size,
        headers={h.name: l2.header_to_text(h.header) for h in raw},
        data_start={h.name: h.data_start for h in raw},
        shape=(nplane, ny, nx),
        wavelength_um=wl,
        bandwidth_um=bw if bw is not None else np.full(nplane, np.nan),
        wl_min_um=wl_min,
        wl_max_um=wl_max,
        detector=det,
        channel=chan,
        blank_planes=blank,
        pixel_sr=healpix_pixel_sr(order, nx),
        order=order,
        npix=int(img.get("NPIX", tile.npix if tile else -1)),
    )


# --- pixels and photometry --------------------------------------------------------------------------------


def _plane_ranges(start: int, shape: tuple[int, int, int], xa: int, xb: int, ya: int, yb: int) -> list[tuple[int, int]]:
    nplane, ny, nx = shape
    out = []
    for k in range(nplane):
        base = start + 4 * k * ny * nx
        for y in range(ya, yb + 1):
            out.append((base + 4 * (y * nx + xa), base + 4 * (y * nx + xb) + 3))
    return out


def _pixel_ranges(start: int, shape: tuple[int, int, int], x: int, y: int) -> list[tuple[int, int]]:
    nplane, ny, nx = shape
    return [(start + 4 * (k * ny * nx + y * nx + x), start + 4 * (k * ny * nx + y * nx + x) + 3) for k in range(nplane)]


def _plane_dtype(meta: CubeMeta, extname: str) -> str:
    bitpix = int(l2.header_from_text(meta.headers[extname])["BITPIX"])
    if bitpix not in (-32, 32):
        raise CubeError(f"{meta.url}: {extname} has BITPIX {bitpix} (expected -32 or 32)")
    return ">f4" if bitpix == -32 else ">i4"


def _decode_pixels(raw: bytes, dtype: str) -> np.ndarray:
    return np.frombuffer(raw, dtype=dtype).astype(np.float32 if dtype == ">f4" else np.int64)


def read_cube_box(
    meta: CubeMeta, xa: int, xb: int, ya: int, yb: int, *, max_gap: int = CUBE_MAX_GAP
) -> np.ndarray:
    """IMAGE values [nplane, yb-ya+1, xb-xa+1] (MJy/sr) of an inclusive 0-based pixel box of the tile."""
    ranges = _plane_ranges(meta.data_start["IMAGE"], meta.shape, xa, xb, ya, yb)
    parts = rangeio.read_ranges(meta.url, ranges, max_gap=max_gap)
    raw = b"".join(parts)
    return np.frombuffer(raw, dtype=">f4").reshape(meta.shape[0], yb - ya + 1, xb - xa + 1).astype(np.float32)


def read_cube_pixel(meta: CubeMeta, extname: str, x: int, y: int) -> np.ndarray:
    """Values of one tile pixel in every plane of IMAGE, NHITS or FLAGS."""
    raw = b"".join(rangeio.read_ranges(meta.url, _pixel_ranges(meta.data_start[extname], meta.shape, x, y)))
    return _decode_pixels(raw, _plane_dtype(meta, extname))


def read_cube_values(
    meta: CubeMeta, xa: int, xb: int, ya: int, yb: int, xc: int, yc: int, *, max_gap: int = CUBE_MAX_GAP
) -> tuple[np.ndarray, dict[str, np.ndarray]]:
    """IMAGE box (as `read_cube_box`) plus NHITS and FLAGS of pixel (xc, yc) in every plane, in one batch.

    One `rangeio.read_ranges` call: on IBE that is ceil(n_ranges / 100) multi-range requests run in parallel.
    """
    ranges = _plane_ranges(meta.data_start["IMAGE"], meta.shape, xa, xb, ya, yb)
    n_box = len(ranges)
    extras = [ext for ext in ("NHITS", "FLAGS") if ext in meta.data_start]
    for ext in extras:
        ranges += _pixel_ranges(meta.data_start[ext], meta.shape, xc, yc)
    parts = rangeio.read_ranges(meta.url, ranges, max_gap=max_gap)
    nplane = meta.shape[0]
    box = np.frombuffer(b"".join(parts[:n_box]), dtype=">f4").reshape(nplane, yb - ya + 1, xb - xa + 1)
    centre: dict[str, np.ndarray] = {}
    for i, ext in enumerate(extras):
        a = n_box + i * nplane
        centre[ext] = _decode_pixels(b"".join(parts[a : a + nplane]), _plane_dtype(meta, ext))
    return box.astype(np.float32), centre


def _aperture_weights(shape: tuple[int, int], xc: float, yc: float, r: float) -> np.ndarray:
    from photutils.aperture import CircularAperture

    mask = CircularAperture((xc, yc), r=r).to_mask(method="exact")
    return mask.to_image(shape).astype(float)


def _annulus_mask(shape: tuple[int, int], xc: float, yc: float, r_in: float, r_out: float) -> np.ndarray:
    yy, xx = np.mgrid[0 : shape[0], 0 : shape[1]]
    d = np.hypot(xx - xc, yy - yc)
    return (d >= r_in) & (d <= r_out)


def aperture_photometry(
    cube: np.ndarray, xc: float, yc: float, r_ap: float, r_in: float, r_out: float, pixel_sr: float,
    full_weight: float | None = None,
) -> dict[str, np.ndarray]:
    """Background-subtracted aperture fluxes (uJy) for every plane of a [nplane, ny, nx] box (MJy/sr).

    The background is the 3-sigma-clipped median of the annulus pixels; the error is the background
    scatter propagated over the aperture area (sigma * sqrt(A + A^2 / N_annulus)), so it excludes the
    source photon noise. A plane whose aperture contains NaN pixels (or reaches past the box: pass
    `full_weight`, the unclipped aperture area) gets flux NaN and a lower-limit partial flux.
    """
    nplane, ny, nx = cube.shape
    w = _aperture_weights((ny, nx), xc, yc, r_ap)
    ann = _annulus_mask((ny, nx), xc, yc, r_in, r_out)
    area = float(w.sum())
    area_full = area if full_weight is None else float(full_weight)
    to_ujy = pixel_sr * 1e12
    vals = cube[:, ann]
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        _, med, std = sigma_clipped_stats(vals, axis=1, sigma=3.0, maxiters=5)
    n_ann = np.sum(np.isfinite(vals), axis=1)
    med = np.where(n_ann >= MIN_ANNULUS_PIXELS, np.asarray(med, dtype=float), np.nan)
    std = np.where(n_ann >= MIN_ANNULUS_PIXELS, np.asarray(std, dtype=float), np.nan)
    finite = np.isfinite(cube)
    w_valid = np.where(finite, w[None, :, :], 0.0)
    masked_w = area_full - w_valid.sum(axis=(1, 2))
    masked_fraction = np.clip(masked_w / area_full, 0.0, 1.0) if area_full > 0 else np.ones(nplane)
    resid = np.where(finite, cube - med[:, None, None], 0.0)
    partial = (w_valid * resid).sum(axis=(1, 2)) * to_ujy
    complete = masked_fraction < 1e-9
    flux = np.where(complete & np.isfinite(med), partial, np.nan)
    partial = np.where(np.isfinite(med) & (masked_fraction < 1.0), partial, np.nan)
    err = std * np.sqrt(area_full + area_full**2 / np.maximum(n_ann, 1)) * to_ujy
    err = np.where(np.isfinite(flux), err, np.nan)
    return {
        "flux_ujy": flux,
        "flux_err_ujy": err,
        "flux_partial_ujy": partial,
        "background_mjysr": med,
        "background_rms_mjysr": std,
        "masked_fraction": masked_fraction,
        "aperture_area_px": np.full(nplane, area_full),
        "annulus_npix": n_ann.astype(int),
    }


def cube_spectrum(
    ra: float,
    dec: float,
    aperture_radius_px: float = 1.5,
    annulus_px: tuple[float, float] = (3.0, 5.0),
    *,
    collection: str = DEFAULT_COLLECTION,
    max_gap: int = CUBE_MAX_GAP,
) -> dict[str, Any]:
    """102-channel quick-look spectrum at (ra, dec) [deg, ICRS] from the DR1 cube (aperture photometry).

    Returns a dict of numpy arrays (one value per plane, ascending wavelength) and scalars:
    wavelength_um, bandwidth_um, detector, channel, flux_ujy (NaN where the plane is blank or any aperture
    pixel is NaN), flux_err_ujy (background-limited), flux_partial_ujy (sum over the unmasked aperture
    pixels: a lower limit where flux_ujy is NaN), lower_limit (True where only flux_partial_ujy is
    available), background_mjysr, masked_fraction, nhits and flags (at the centre pixel), quality ("ok" |
    "masked" | "blank" | "edge" | "no-data"), plus label, tile_url, x, y (0-based tile pixel), pixel_sr,
    n_finite (complete apertures), n_lower_limit, timing and bytes.

    Saturated stars are blanked in the cube core: at Barnard's Star 91 of the 100 non-blank channels are
    lower limits only. Use Level-2 photometry (pxh.photometry) for such sources.
    """
    r_in, r_out = annulus_px
    if not (0 < aperture_radius_px < r_in < r_out):
        raise ValueError("need 0 < aperture radius < annulus inner < annulus outer")
    t0 = time.perf_counter()
    with rangeio.track() as st:
        tile = find_cube_tile(ra, dec, collection=collection)
        try:
            meta = read_cube_meta(tile.url)
        except rangeio.RemoteFileNotFoundError:
            log.warning("cached release path gave 404 for %s; asking SIA again", tile.url)
            tile = find_cube_tile(ra, dec, collection=collection, refresh=True)
            meta = read_cube_meta(tile.url)
        wcs = meta.celestial_wcs()
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            x, y = (float(v) for v in wcs.all_world2pix([[ra, dec]], 0)[0])
        _, ny, nx = meta.shape
        if not (-0.5 <= x < nx - 0.5 and -0.5 <= y < ny - 0.5):
            raise CubeError(f"({ra}, {dec}) maps to pixel ({x:.2f}, {y:.2f}) outside tile {tile.npix}")
        half = math.ceil(r_out + 1.0)
        xc, yc = math.floor(x + 0.5), math.floor(y + 0.5)
        xa, xb = max(0, xc - half), min(nx - 1, xc + half)
        ya, yb = max(0, yc - half), min(ny - 1, yc + half)
        edge = (xa, xb, ya, yb) != (xc - half, xc + half, yc - half, yc + half)
        box, centre = read_cube_values(meta, xa, xb, ya, yb, xc, yc, max_gap=max_gap)
        nhits = centre.get("NHITS")
        cflags = centre.get("FLAGS")
    out = _box_spectrum(
        meta, tile, collection, ra, dec, x, y, box, xa, ya, edge, nhits, cflags, aperture_radius_px, (r_in, r_out)
    )
    out.update({"seconds": time.perf_counter() - t0, "requests": st.requests, "bytes": st.bytes})
    return out


def _box_spectrum(
    meta: CubeMeta,
    tile: CubeTile,
    collection: str,
    ra: float,
    dec: float,
    x: float,
    y: float,
    box: np.ndarray,
    xa: int,
    ya: int,
    edge: bool,
    nhits: np.ndarray | None,
    cflags: np.ndarray | None,
    aperture_radius_px: float,
    annulus_px: tuple[float, float],
    flag_bits: dict[str, int] | None = None,
) -> dict[str, Any]:
    """The `cube_spectrum` result (without timing) from a pixel box whose corner is tile pixel (xa, ya)."""
    r_in, r_out = annulus_px
    nplane = meta.shape[0]
    full_area = math.pi * aperture_radius_px**2 if edge else None
    phot = aperture_photometry(box, x - xa, y - ya, aperture_radius_px, r_in, r_out, meta.pixel_sr, full_area)
    quality = np.full(nplane, "ok", dtype=object)
    quality[phot["masked_fraction"] > 0] = "masked"
    if edge:
        quality[~np.isfinite(phot["flux_ujy"])] = "edge"
    quality[np.isnan(phot["flux_partial_ujy"]) & (quality == "ok")] = "no-data"
    allnan = ~np.isfinite(box).any(axis=(1, 2))
    quality[allnan] = "no-data"
    blank = np.zeros(nplane, dtype=bool)
    blank[[p for p in meta.blank_planes if 0 <= p < nplane]] = True
    quality[blank] = "blank"
    for key in ("flux_ujy", "flux_err_ujy", "flux_partial_ujy"):
        phot[key] = np.where(blank, np.nan, phot[key])
    n_finite = int(np.isfinite(phot["flux_ujy"]).sum())
    lower_limit = ~np.isfinite(phot["flux_ujy"]) & np.isfinite(phot["flux_partial_ujy"])
    return {
        "label": CUBE_LABEL,
        "ra": ra,
        "dec": dec,
        "collection": collection,
        "tile_url": tile.url,
        "tile_npix": tile.npix,
        "order": tile.order,
        "x": x,
        "y": y,
        "wavelength_um": np.asarray(meta.wavelength_um, dtype=float),
        "bandwidth_um": np.asarray(meta.bandwidth_um, dtype=float),
        "detector": meta.detector,
        "channel": meta.channel,
        **phot,
        "nhits": nhits,
        "flags": cflags,
        "flag_bits": meta.flag_bits() if flag_bits is None else dict(flag_bits),
        "quality": quality.astype(str),
        "lower_limit": lower_limit,
        "blank_planes": list(meta.blank_planes),
        "n_finite": n_finite,
        "n_lower_limit": int(lower_limit.sum()),
        "n_partial": int(np.isfinite(phot["flux_partial_ujy"]).sum()),
        "pixel_sr": meta.pixel_sr,
        "pixel_arcsec": math.degrees(math.sqrt(meta.pixel_sr)) * 3600.0,
        "aperture_radius_px": aperture_radius_px,
        "annulus_px": (r_in, r_out),
        "edge": edge,
        "units": {"wavelength": "um", "flux": "uJy", "background": "MJy/sr"},
        "notes": (
            "Quick look from the IRSA DR1 cube (labelled for visualization): no aperture correction; "
            "errors from background scatter only; saturated/bright-star pixels are often blank (NaN)."
        ),
    }


# --- many positions in one tile ---------------------------------------------------------------------------


def read_cube_rows(
    meta: CubeMeta, intervals: list[tuple[int, int]], *, groups: int = config.IRSA_MAX_CONCURRENCY
) -> dict[tuple[int, int], np.ndarray]:
    """IMAGE values [nplane, yb-ya+1, nx] (MJy/sr) of whole tile rows ya..yb (inclusive) for each interval.

    Whole rows are contiguous in the file, so each (interval, plane) is one byte range. The ranges are split
    into up to `groups` requests of at most ``config.IBE_MAX_RANGES_PER_REQUEST`` ranges, issued in parallel;
    rangeio's process-wide IRSA limit (``config.IRSA_MAX_CONCURRENCY``) still applies.
    """
    nplane, ny, nx = meta.shape
    start = meta.data_start["IMAGE"]
    ranges: list[tuple[int, int]] = []
    for ya, yb in intervals:
        if not (0 <= ya <= yb < ny):
            raise ValueError(f"row interval {(ya, yb)} outside the tile (0-{ny - 1})")
        for k in range(nplane):
            base = start + 4 * k * ny * nx
            ranges.append((base + 4 * ya * nx, base + 4 * (yb + 1) * nx - 1))
    per = max(1, min(config.IBE_MAX_RANGES_PER_REQUEST, math.ceil(len(ranges) / max(1, groups))))
    chunks = [ranges[i : i + per] for i in range(0, len(ranges), per)]
    if len(chunks) > 1:
        from concurrent.futures import ThreadPoolExecutor

        trackers = rangeio._current_trackers()  # count the workers' traffic in the caller's track() blocks

        def read(c: list[tuple[int, int]]) -> list[bytes]:
            rangeio._LOCAL.trackers = trackers
            try:
                return rangeio.read_ranges(meta.url, c)
            finally:
                rangeio._LOCAL.trackers = []

        with ThreadPoolExecutor(max_workers=min(len(chunks), config.IRSA_MAX_CONCURRENCY)) as ex:
            parts = [p for res in ex.map(read, chunks) for p in res]
    else:
        parts = [p for c in chunks for p in rangeio.read_ranges(meta.url, c)]
    out: dict[tuple[int, int], np.ndarray] = {}
    for i, (ya, yb) in enumerate(intervals):
        raw = b"".join(parts[i * nplane : (i + 1) * nplane])
        out[(ya, yb)] = np.frombuffer(raw, dtype=">f4").reshape(nplane, yb - ya + 1, nx).astype(np.float32)
    return out


def _merge_intervals(intervals: list[tuple[int, int]]) -> list[tuple[int, int]]:
    merged: list[tuple[int, int]] = []
    for a, b in sorted(intervals):
        if merged and a <= merged[-1][1] + 1:
            merged[-1] = (merged[-1][0], max(merged[-1][1], b))
        else:
            merged.append((a, b))
    return merged


def cube_spectra(
    positions: list[tuple[float, float]],
    aperture_radius_px: float = 1.5,
    annulus_px: tuple[float, float] = (3.0, 5.0),
    *,
    tile_url: str | None = None,
    collection: str = DEFAULT_COLLECTION,
) -> list[dict[str, Any] | None]:
    """Quick-look spectra at many positions in ONE cube tile, from whole-row reads.

    For catalogues of sources (training sets, surveys): the boxes of all positions are covered by whole tile
    rows, read once (each run of rows is one byte range per plane), so a few requests serve every source in
    a band of rows. The photometry and the result keys are those of `cube_spectrum`, except that ``nhits``
    and ``flags`` are None (not read) and the timing keys are shared by the whole call. Positions that fall
    outside the tile (the tile is that of the first position unless `tile_url` is given) give None.
    """
    r_in, r_out = annulus_px
    if not (0 < aperture_radius_px < r_in < r_out):
        raise ValueError("need 0 < aperture radius < annulus inner < annulus outer")
    if not positions:
        return []
    t0 = time.perf_counter()
    with rangeio.track() as st:
        if tile_url is None:
            tile = find_cube_tile(*positions[0], collection=collection)
        else:
            parsed = parse_tile_url(tile_url)
            if parsed is None:
                raise CubeError(f"not a cube tile URL: {tile_url}")
            tile = parsed
        meta = read_cube_meta(tile.url)
        wcs = meta.celestial_wcs()
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            pix = wcs.all_world2pix(np.asarray(positions, dtype=float).reshape(-1, 2), 0)
        _, ny, nx = meta.shape
        half = math.ceil(r_out + 1.0)
        boxes: list[tuple[int, int, int, int, bool] | None] = []
        for x, y in pix:
            if not (np.isfinite(x) and np.isfinite(y) and -0.5 <= x < nx - 0.5 and -0.5 <= y < ny - 0.5):
                boxes.append(None)
                continue
            xc, yc = math.floor(x + 0.5), math.floor(y + 0.5)
            xa, xb = max(0, xc - half), min(nx - 1, xc + half)
            ya, yb = max(0, yc - half), min(ny - 1, yc + half)
            boxes.append((xa, xb, ya, yb, (xa, xb, ya, yb) != (xc - half, xc + half, yc - half, yc + half)))
        intervals = _merge_intervals([(b[2], b[3]) for b in boxes if b is not None])
        rows = read_cube_rows(meta, intervals) if intervals else {}
    shared = {"seconds": time.perf_counter() - t0, "requests": st.requests, "bytes": st.bytes}
    bits = meta.flag_bits()  # parsed once: it costs ~10 ms per call
    out: list[dict[str, Any] | None] = []
    for (ra, dec), (x, y), b in zip(positions, pix, boxes, strict=True):
        if b is None:
            out.append(None)
            continue
        xa, xb, ya, yb, edge = b
        (y0, _), block = next((iv, blk) for iv, blk in rows.items() if iv[0] <= ya and yb <= iv[1])
        box = block[:, ya - y0 : yb - y0 + 1, xa : xb + 1]
        res = _box_spectrum(
            meta, tile, collection, float(ra), float(dec), float(x), float(y), box, xa, ya, edge, None, None,
            aperture_radius_px, (r_in, r_out), bits,
        )
        res.update(shared)
        out.append(res)
    return out
