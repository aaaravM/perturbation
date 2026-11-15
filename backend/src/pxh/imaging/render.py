"""PNG, GIF and false-colour rendering of grid frames, plus the matching WCS for Aladin Lite overlays.

Orientation contract (tested):
- Grid arrays follow FITS order: data[0] is the southern row (pixel y = 1 in FITS terms).
- PNGs are flipped vertically, so PNG row 0 (top) is the northern edge and north is up.
- Aladin Lite (3.8.2, `src/core/src/renderable/image/grid.rs`) reads the WCS of a JPEG/PNG overlay in FITS
  convention, mapping PNG row r to FITS pixel y = NAXIS2 - r. So `wcs_to_aladin(frame.wcs, shape)` is the
  grid WCS unchanged, and `world_to_png_pixel` gives where a sky position lands in the PNG.

Stretches map [vmin, vmax] to [0, 1] after clipping:
- linear: t;
- asinh: asinh(10 t) / asinh(10);
- log: log10(1000 t + 1) / log10(1001).

Difference frames (meta['kind'] == 'difference', or cmap='diverging') use a dark-centred diverging map,
blue for negative and orange for positive. The stretch is applied symmetrically about 0, or about the
centre of the limits if they do not straddle 0. Invalid pixels (NaN, or weight 0 for a Frame) are
transparent when nan_transparent is set: the PNG is then RGBA, otherwise L (gray) or RGB.
`mask_to_png` draws a boolean grid mask (e.g. saturated cores) as a transparent overlay in the same orientation.
"""

from __future__ import annotations

import functools
import io
import logging
import math
from collections.abc import Sequence
from pathlib import Path
from typing import Any

import numpy as np
from astropy.wcs import WCS
from PIL import Image, ImageDraw, ImageFont

from pxh.models import Frame

log = logging.getLogger(__name__)

STRETCHES = ("linear", "asinh", "log")
ASINH_SOFTENING = 10.0
LOG_EXPONENT = 1000.0
GIF_MIN_SIDE_PX = 360  # small grids are upscaled (nearest neighbour) to at least this for GIFs
_MAX_LIMIT_SAMPLES = 2_000_000

# Dark-centred diverging colour map: (position in [0, 1], RGB in [0, 1]).
_DIVERGING_ANCHORS = (
    (0.00, (0.80, 0.93, 1.00)),
    (0.15, (0.30, 0.65, 0.98)),
    (0.35, (0.10, 0.25, 0.60)),
    (0.50, (0.04, 0.04, 0.05)),
    (0.65, (0.55, 0.16, 0.08)),
    (0.85, (0.97, 0.50, 0.15)),
    (1.00, (1.00, 0.93, 0.75)),
)

ImageLike = Frame | np.ndarray


# --- limits and stretches -------------------------------------------------------------------------------


def shared_limits(
    frames: Sequence[ImageLike],
    percentiles: tuple[float, float] = (0.5, 99.7),
    symmetric: bool = False,
) -> tuple[float, float]:
    """Display limits from the percentiles of the valid pixels of all frames together.

    Use the same (vmin, vmax) for every frame of a blink so equal values get equal gray levels.
    symmetric: return (-m, m) with m = max(|lo|, |hi|), as used for difference frames.
    """
    lo_p, hi_p = percentiles
    if not 0.0 <= lo_p < hi_p <= 100.0:
        raise ValueError(f"percentiles must satisfy 0 <= lo < hi <= 100, got {percentiles}")
    chunks = [v[np.isfinite(v)] for v in (_valid_array(f).ravel() for f in frames)]
    values = np.concatenate(chunks) if chunks else np.array([])
    if values.size == 0:
        return (-1.0, 1.0) if symmetric else (0.0, 1.0)
    if values.size > _MAX_LIMIT_SAMPLES:
        values = values[:: math.ceil(values.size / _MAX_LIMIT_SAMPLES)]
    lo, hi = (float(x) for x in np.percentile(values, [lo_p, hi_p]))
    if symmetric:
        m = max(abs(lo), abs(hi))
        m = m if m > 0 else 1.0
        return -m, m
    if hi <= lo:
        hi = lo + (abs(lo) * 1e-6 or 1.0)
    return lo, hi


def apply_stretch(t: np.ndarray, stretch: str) -> np.ndarray:
    """Map t in [0, 1] (clipped) through the named stretch to [0, 1]."""
    t = np.clip(t, 0.0, 1.0)
    if stretch == "linear":
        return t
    if stretch == "asinh":
        return np.arcsinh(ASINH_SOFTENING * t) / np.arcsinh(ASINH_SOFTENING)
    if stretch == "log":
        return np.log10(LOG_EXPONENT * t + 1.0) / np.log10(LOG_EXPONENT + 1.0)
    raise ValueError(f"unknown stretch {stretch!r}; expected one of {STRETCHES}")


# --- PNG ------------------------------------------------------------------------------------------------


def to_png(
    img: ImageLike,
    vmin: float,
    vmax: float,
    stretch: str = "asinh",
    cmap: str | np.ndarray | None = None,
    nan_transparent: bool = True,
) -> bytes:
    """Render a frame or array to PNG bytes, north up (rows flipped from FITS order).

    cmap: None (gray, or the diverging map for difference frames), 'gray', 'diverging', or a (256, 3)
    uint8 lookup table.
    """
    if stretch not in STRETCHES:
        raise ValueError(f"unknown stretch {stretch!r}; expected one of {STRETCHES}")
    arr = _valid_array(img)
    if arr.ndim != 2:
        raise ValueError(f"expected a 2-D image, got shape {arr.shape}")
    diverging = (isinstance(cmap, str) and cmap == "diverging") or (cmap is None and _is_difference(img))
    level = _levels_diverging(arr, vmin, vmax, stretch) if diverging else _levels(arr, vmin, vmax, stretch)
    lut = _resolve_cmap("diverging" if diverging and cmap is None else cmap)
    invalid = ~np.isfinite(arr)
    pixels = _colourise(level, lut, invalid if nan_transparent else None)
    return _encode_png(np.flipud(pixels))


def rgb_composite(
    r: ImageLike,
    g: ImageLike,
    b: ImageLike,
    *,
    limits: Sequence[tuple[float, float]] | None = None,
    percentiles: tuple[float, float] = (0.5, 99.7),
    stretch: str = "asinh",
    nan_transparent: bool = True,
) -> bytes:
    """False-colour PNG from three frames on one grid (e.g. D6, D4, D2 co-adds as R, G, B).

    Each channel is scaled by its own limits (default: its own percentiles). A channel's invalid pixels are
    black. With nan_transparent, pixels invalid in all three channels are transparent.
    """
    channels = [_valid_array(x) for x in (r, g, b)]
    if any(c.shape != channels[0].shape or c.ndim != 2 for c in channels):
        raise ValueError(f"channel shapes differ: {[c.shape for c in channels]}")
    if limits is not None and len(limits) != 3:
        raise ValueError("limits must give (vmin, vmax) for each of the 3 channels")
    planes = []
    for i, chan in enumerate(channels):
        vmin, vmax = limits[i] if limits is not None else shared_limits([chan], percentiles)
        planes.append(_levels(chan, vmin, vmax, stretch))
    rgb = np.stack(planes, axis=-1)
    invalid = np.all([~np.isfinite(c) for c in channels], axis=0)
    out = np.round(np.nan_to_num(rgb, nan=0.0) * 255.0).astype(np.uint8)
    if nan_transparent and invalid.any():
        alpha = np.where(invalid, 0, 255).astype(np.uint8)
        out = np.concatenate([out, alpha[..., None]], axis=-1)
    return _encode_png(np.flipud(out))


def mask_to_png(
    mask: np.ndarray,
    color: tuple[int, int, int] = (255, 64, 200),
    alpha: int = 180,
) -> bytes:
    """RGBA overlay PNG of a boolean grid mask, north up like `to_png` (same `wcs_to_aladin` dict).

    For example `align.saturated_mask_on_grid(...)`, drawn over a frame to show saturated cores. True
    pixels get `color` at opacity `alpha` (0-255); all other pixels are fully transparent.
    """
    m = np.asarray(mask)
    if m.ndim != 2:
        raise ValueError(f"expected a 2-D mask, got shape {m.shape}")
    if len(color) != 3 or not all(0 <= int(c) <= 255 for c in color):
        raise ValueError(f"color must be an (r, g, b) tuple of 0-255 values, got {color}")
    if not 0 <= int(alpha) <= 255:
        raise ValueError(f"alpha must be in 0-255, got {alpha}")
    rgba = np.zeros((*m.shape, 4), dtype=np.uint8)
    rgba[m.astype(bool)] = (*(int(c) for c in color), int(alpha))
    return _encode_png(np.flipud(rgba))


# --- WCS for Aladin -------------------------------------------------------------------------------------


def wcs_to_aladin(wcs: WCS, shape: tuple[int, int]) -> dict[str, Any]:
    """FITS-style WCS dict for Aladin Lite's A.image(pngUrl, {wcs: ...}), matching PNGs from `to_png`.

    Keys: NAXIS, NAXIS1/2, CTYPE1/2, CUNIT1/2, CRPIX1/2 (1-based), CRVAL1/2, CD1_1, CD1_2, CD2_1, CD2_2,
    LONPOLE, LATPOLE, RADESYS, EQUINOX. All values are plain JSON types.
    """
    ny, nx = int(shape[0]), int(shape[1])
    cel = wcs.celestial
    if cel.naxis != 2:
        raise ValueError("wcs must have two celestial axes")
    if cel.sip is not None or cel.has_distortion:
        raise ValueError("Aladin overlays need a plain projection (no SIP/distortion); reproject first")
    w = cel.wcs
    w.set()
    cd = cel.pixel_scale_matrix
    radesys = (w.radesys or "ICRS").strip() or "ICRS"
    return {
        "NAXIS": 2,
        "NAXIS1": nx,
        "NAXIS2": ny,
        "CTYPE1": str(w.ctype[0]),
        "CTYPE2": str(w.ctype[1]),
        "CUNIT1": "deg",
        "CUNIT2": "deg",
        "CRPIX1": float(w.crpix[0]),
        "CRPIX2": float(w.crpix[1]),
        "CRVAL1": float(w.crval[0]),
        "CRVAL2": float(w.crval[1]),
        "CD1_1": float(cd[0, 0]),
        "CD1_2": float(cd[0, 1]),
        "CD2_1": float(cd[1, 0]),
        "CD2_2": float(cd[1, 1]),
        "LONPOLE": float(w.lonpole),
        "LATPOLE": float(w.latpole),
        "RADESYS": radesys,
        "EQUINOX": 2000.0,
    }


def world_to_png_pixel(wcs: WCS, shape: tuple[int, int], ra: float, dec: float) -> tuple[float, float]:
    """(column, row) in a `to_png` image of the sky position, 0-based, row 0 at the top (north)."""
    x, y = wcs.celestial.world_to_pixel_values(ra, dec)
    return float(x), float(shape[0] - 1 - y)


def png_pixel_to_world(wcs: WCS, shape: tuple[int, int], col: float, row: float) -> tuple[float, float]:
    """Inverse of `world_to_png_pixel`: (ra, dec) in degrees of a PNG (column, row)."""
    ra, dec = wcs.celestial.pixel_to_world_values(col, shape[0] - 1 - row)
    return float(ra), float(dec)


# --- GIF ------------------------------------------------------------------------------------------------


def gif_bytes(
    png_bytes_list: Sequence[bytes],
    ms_per_frame: int = 500,
    loop: int | None = 0,
    label_texts: Sequence[str] | None = None,
    *,
    upscale: int | None = None,
    background: tuple[int, int, int] = (0, 0, 0),
) -> bytes:
    """Animated GIF of PNG frames (same size) with an optional label per frame in the top-left corner.

    Transparent pixels are composited onto `background`. upscale=None picks an integer factor (nearest
    neighbour) so the longer side is >= GIF_MIN_SIDE_PX. loop=0 repeats forever; None plays once.
    """
    if not png_bytes_list:
        raise ValueError("need at least one PNG frame")
    if label_texts is not None and len(label_texts) != len(png_bytes_list):
        raise ValueError(f"{len(label_texts)} labels for {len(png_bytes_list)} frames")
    if ms_per_frame <= 0:
        raise ValueError(f"ms_per_frame must be positive, got {ms_per_frame}")
    images = [_decode_rgb(p, background) for p in png_bytes_list]
    size = images[0].size
    if any(im.size != size for im in images):
        raise ValueError(f"frames differ in size: {sorted({im.size for im in images})}")
    factor = upscale if upscale is not None else max(1, math.ceil(GIF_MIN_SIDE_PX / max(size)))
    if factor < 1:
        raise ValueError(f"upscale must be >= 1, got {upscale}")
    if factor > 1:
        images = [im.resize((size[0] * factor, size[1] * factor), Image.Resampling.NEAREST) for im in images]
    if label_texts is not None:
        for im, text in zip(images, label_texts, strict=True):
            _draw_label(im, text)
    frames = [im.convert("P", palette=Image.Palette.ADAPTIVE, colors=256) for im in images]
    buf = io.BytesIO()
    save_kwargs: dict[str, Any] = {"save_all": True, "append_images": frames[1:], "duration": int(ms_per_frame),
                                   "disposal": 1, "optimize": False}
    if loop is not None:
        save_kwargs["loop"] = int(loop)
    frames[0].save(buf, format="GIF", **save_kwargs)
    return buf.getvalue()


def write_gif(
    png_bytes_list: Sequence[bytes],
    path: str | Path,
    ms_per_frame: int = 500,
    loop: int | None = 0,
    label_texts: Sequence[str] | None = None,
    *,
    upscale: int | None = None,
) -> Path:
    """Write `gif_bytes(...)` to path (parent directories are created); return the path."""
    out = Path(path)
    data = gif_bytes(png_bytes_list, ms_per_frame, loop, label_texts, upscale=upscale)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(data)
    return out


# --- helpers -------------------------------------------------------------------------------------------


def _valid_array(img: ImageLike) -> np.ndarray:
    """Float64 copy of the image with NaN wherever it is invalid (weight 0 for a Frame)."""
    if isinstance(img, Frame):
        data = np.asarray(img.data, dtype=np.float64)
        weight = np.asarray(img.weight)
        if weight.shape != data.shape:
            raise ValueError(f"frame weight shape {weight.shape} != data shape {data.shape}")
        return np.where(weight > 0, data, np.nan)
    return np.array(img, dtype=np.float64)


def _is_difference(img: ImageLike) -> bool:
    return isinstance(img, Frame) and img.meta.get("kind") == "difference"


def _levels(arr: np.ndarray, vmin: float, vmax: float, stretch: str) -> np.ndarray:
    span = vmax - vmin
    if not (math.isfinite(span) and span > 0):
        raise ValueError(f"need finite vmin < vmax, got ({vmin}, {vmax})")
    with np.errstate(invalid="ignore"):
        return apply_stretch((arr - vmin) / span, stretch)


def _levels_diverging(arr: np.ndarray, vmin: float, vmax: float, stretch: str) -> np.ndarray:
    if not (math.isfinite(vmin) and math.isfinite(vmax) and vmax > vmin):
        raise ValueError(f"need finite vmin < vmax, got ({vmin}, {vmax})")
    centre = 0.0 if vmin < 0.0 < vmax else 0.5 * (vmin + vmax)
    with np.errstate(invalid="ignore", divide="ignore"):
        pos = apply_stretch((arr - centre) / (vmax - centre), stretch)
        neg = apply_stretch((centre - arr) / (centre - vmin), stretch)
        return np.where(arr >= centre, 0.5 + 0.5 * pos, 0.5 - 0.5 * neg)


@functools.lru_cache(maxsize=4)
def _named_lut(name: str) -> np.ndarray | None:
    if name in ("gray", "grey"):
        return None
    if name == "diverging":
        pos = np.array([p for p, _ in _DIVERGING_ANCHORS])
        rgb = np.array([c for _, c in _DIVERGING_ANCHORS])
        x = np.linspace(0.0, 1.0, 256)
        lut = np.stack([np.interp(x, pos, rgb[:, i]) for i in range(3)], axis=-1)
        lut = np.round(lut * 255.0).astype(np.uint8)
        lut.setflags(write=False)
        return lut
    raise ValueError(f"unknown colour map {name!r}; expected 'gray', 'diverging' or a (256, 3) uint8 array")


def _resolve_cmap(cmap: str | np.ndarray | None) -> np.ndarray | None:
    if cmap is None:
        return None
    if isinstance(cmap, str):
        return _named_lut(cmap)
    lut = np.asarray(cmap)
    if lut.shape != (256, 3):
        raise ValueError(f"a colour lookup table must have shape (256, 3), got {lut.shape}")
    return lut.astype(np.uint8)


def _colourise(level: np.ndarray, lut: np.ndarray | None, transparent: np.ndarray | None) -> np.ndarray:
    """uint8 pixels: (H, W) gray, (H, W, 3) RGB, or with an alpha plane where `transparent` has any True."""
    idx = np.round(np.nan_to_num(level, nan=0.0) * 255.0).astype(np.uint8)
    use_alpha = transparent is not None and bool(transparent.any())
    if lut is None and not use_alpha:
        return idx
    rgb = np.repeat(idx[..., None], 3, axis=-1) if lut is None else lut[idx]
    if not use_alpha:
        return rgb
    alpha = np.where(transparent, 0, 255).astype(np.uint8)
    return np.concatenate([rgb, alpha[..., None]], axis=-1)


def _encode_png(pixels: np.ndarray) -> bytes:
    buf = io.BytesIO()
    Image.fromarray(np.ascontiguousarray(pixels)).save(buf, format="PNG", compress_level=6)
    return buf.getvalue()


def _decode_rgb(png: bytes, background: tuple[int, int, int]) -> Image.Image:
    with Image.open(io.BytesIO(png)) as im:
        im.load()
        rgba = im.convert("RGBA")
    base = Image.new("RGBA", rgba.size, (*background, 255))
    return Image.alpha_composite(base, rgba).convert("RGB")


@functools.lru_cache(maxsize=16)
def _font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    return ImageFont.load_default(size=size)


def _draw_label(im: Image.Image, text: str) -> None:
    if not text:
        return
    size = max(10, im.size[1] // 24)
    font = _font(size)
    draw = ImageDraw.Draw(im)
    pad = max(2, size // 4)
    x0, y0, x1, y1 = draw.multiline_textbbox((pad, pad), text, font=font)
    draw.rectangle((x0 - pad, y0 - pad, x1 + pad, y1 + pad), fill=(0, 0, 0))
    draw.multiline_text((pad, pad), text, fill=(255, 255, 255), font=font)
