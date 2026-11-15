"""SPHEREx Level-2 files read in place with HTTP byte ranges: layout, pixel stamps, FLAGS, ePSFs, wavelengths.

A Level-2 file (65 MB) holds PRIMARY, IMAGE (float32 2040x2040, MJy/sr, TAN-SIP), FLAGS (int32 bitmask,
RICE_1 tile-compressed BINTABLE, one tile per row), VARIANCE, ZODI (float32), EPSF (BINTABLE of 441 or 451
oversampled ePSFs) and WCS-WAVE (wavelength lookup, the last HDU). Offsets after FLAGS depend on its
compressed size, so `read_layout` walks the HDU headers:

1. one multi-range request: bytes 0-40959 (PRIMARY + IMAGE header), a window covering the FLAGS header for
   the usual IMAGE header lengths, and the last 8640 bytes (WCS-WAVE, plus the file size);
2. one multi-range request at the VARIANCE header with speculative windows for the ZODI and EPSF headers.

Any guess that misses falls back to an exact read, so unusual files still parse (just with more requests).
Layouts are cached on disk per `DetectorImage.cache_key` (JSON with header texts and the WCS-WAVE table);
stamps are cached as .npz per pixel box. `read_stamp` reads only the needed row segments of IMAGE, VARIANCE
and ZODI (big-endian float32) and the FLAGS rows (row descriptors, then the compressed heap segments),
decoded with astropy's RICE_1 codec when importable, else with the pure-Python port below. All pixel
values are bit-identical to the archive file (verified against IRSA cutouts in tests/test_l2.py).

Pixel coordinates are 0-based with arrays [y, x] (pxh.models conventions).
"""

from __future__ import annotations

import io
import json
import logging
import math
import re
import threading
import warnings
from collections import OrderedDict
from collections.abc import Sequence
from dataclasses import asdict, dataclass, field
from functools import cached_property
from pathlib import Path
from typing import Any

import numpy as np
from astropy.io import fits
from astropy.io.fits.verify import VerifyWarning
from astropy.wcs import WCS, FITSFixedWarning

from pxh import config
from pxh.models import DetectorImage, EPSFGrid, Stamp
from pxh.spherex import flags as flagmod
from pxh.spherex import rangeio
from pxh.spherex.wavelength import WaveLookup, calibration_source

log = logging.getLogger(__name__)

BLOCK = 2880
LAYOUT_VERSION = 1
HEAD_BYTES = 40960  # PRIMARY + IMAGE header (25,920 or 28,800 bytes in DR1/QR3 files)
TAIL_BYTES = 8640  # the WCS-WAVE extension (2 blocks) + one block of margin
HDR_FETCH = 8 * BLOCK  # bytes fetched for one header on a cache miss (doubled until END is found)
MAX_HEADER_BYTES = 200 * BLOCK
SPEC_HDR_BLOCKS = (1, 6)  # header lengths (blocks) assumed by speculative prefetch windows
IMAGE_HEADER_GUESS = (8 * BLOCK, 9 * BLOCK, 10 * BLOCK)  # IMAGE header lengths seen in DR1/QR3 files
PIXEL_MAX_GAP = 2048  # merge row segments separated by less than this (wide boxes read whole rows)
STAMP_CACHE = True


class L2FormatError(ValueError):
    """The file does not have the expected Level-2 structure."""


class OutsideDetectorError(ValueError):
    """The requested position/box does not overlap the detector."""


# --- small FITS helpers -----------------------------------------------------------------------------------


def padded(n: int) -> int:
    """`n` rounded up to a whole number of 2880-byte FITS blocks."""
    return -(-n // BLOCK) * BLOCK


def find_header_end(buf: bytes) -> int | None:
    """Length in bytes (whole blocks) of the FITS header at the start of `buf`, or None if END is not in it."""
    for i in range(0, len(buf) - 79, 80):
        card = buf[i : i + 80]
        if card[:3] == b"END" and card[3:].strip(b" ") == b"":
            return padded(i + 80)
    return None


def parse_header(buf: bytes) -> fits.Header:
    """astropy Header from raw header bytes (cards up to and including END)."""
    n = find_header_end(buf)
    if n is None:
        raise L2FormatError("FITS header without END card")
    text = buf[:n].decode("ascii", errors="replace")
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", VerifyWarning)
        return fits.Header.fromstring(text)


def header_to_text(header: fits.Header) -> str:
    return header.tostring(sep="", endcard=True, padding=False)


def header_from_text(text: str) -> fits.Header:
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", VerifyWarning)
        return fits.Header.fromstring(text)


def data_size(header: Any) -> int:
    """Unpadded data size in bytes of an HDU (FITS standard: |BITPIX|/8 * GCOUNT * (PCOUNT + prod NAXISi))."""
    naxis = int(header.get("NAXIS", 0))
    if naxis == 0:
        return 0
    n = 1
    for i in range(1, naxis + 1):
        n *= int(header[f"NAXIS{i}"])
    return abs(int(header["BITPIX"])) // 8 * int(header.get("GCOUNT", 1)) * (int(header.get("PCOUNT", 0)) + n)


_MINI_PRIMARY = fits.Header([("SIMPLE", True), ("BITPIX", 8), ("NAXIS", 0), ("EXTEND", True)])
_MINI_PRIMARY_BYTES = _MINI_PRIMARY.tostring(sep="", endcard=True, padding=True).encode("ascii")


@dataclass
class TableHDU:
    """A binary table parsed from raw bytes: its header and astropy FITS_rec data."""

    header: fits.Header
    data: Any  # astropy.io.fits.FITS_rec


def table_hdu_from_bytes(hdu_bytes: bytes) -> TableHDU:
    """Parse one complete BINTABLE extension (header + data, padding optional) with astropy, in memory.

    astropy handles TFORM/TDIM generically (e.g. VALUES 162E with TDIM (2,9,9) becomes shape (9, 9, 2)).
    """
    hlen = find_header_end(hdu_bytes)
    if hlen is None:
        raise L2FormatError("table extension without END card")
    blob = _MINI_PRIMARY_BYTES + hdu_bytes + b"\0" * (padded(len(hdu_bytes)) - len(hdu_bytes))
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", VerifyWarning)
        with fits.open(io.BytesIO(blob), memmap=False, lazy_load_hdus=False) as hdul:
            hdu = hdul[1]
            if not isinstance(hdu, fits.BinTableHDU):
                raise L2FormatError(f"expected a BINTABLE, got {type(hdu).__name__}")
            return TableHDU(header=hdu.header.copy(), data=hdu.data.copy())


# --- sparse remote file -----------------------------------------------------------------------------------


class RemoteFile:
    """Segments fetched from a remote file, with on-demand (multi-)range fetching."""

    def __init__(self, url: str, *, cache: bool = False) -> None:
        self.url = url
        self.cache = cache  # use rangeio's blob cache (off for layouts: their JSON cache holds the result)
        self.segments: list[tuple[int, bytes]] = []
        self.size: int | None = None
        self.requests = 0
        self.bytes = 0

    def add(self, start: int, data: bytes) -> None:
        """Register bytes obtained elsewhere (e.g. rangeio's blob cache) as fetched."""
        self.segments.append((start, data))

    def fetch(self, ranges: Sequence[tuple[int, int]]) -> None:
        if self.size is not None:
            ranges = [(a, min(b, self.size - 1)) for a, b in ranges if a < 0 or a < self.size]
        if not ranges:
            return
        res = rangeio.fetch_ranges(self.url, ranges, cache=self.cache)
        self.requests += res.stats.requests
        self.bytes += res.stats.bytes
        if res.total_size is not None:
            self.size = res.total_size
        for (a, _), data in zip(ranges, res.parts, strict=True):
            if a < 0:
                if self.size is None:
                    raise L2FormatError("suffix range read without file size")
                a = self.size - len(data)
            self.segments.append((a, data))

    def prefix(self, start: int, maxlen: int) -> bytes:
        """Longest run of fetched bytes starting at `start` (at most `maxlen`)."""
        out = bytearray()
        pos = start
        progressed = True
        while progressed and len(out) < maxlen:
            progressed = False
            for a, data in self.segments:
                if a <= pos < a + len(data):
                    take = data[pos - a : pos - a + maxlen - len(out)]
                    out += take
                    pos += len(take)
                    progressed = True
                    break
        return bytes(out)


@dataclass
class RawHDU:
    index: int
    name: str
    header_start: int
    data_start: int
    data_length: int
    header: fits.Header
    header_bytes: bytes


def _speculative_windows(off: int, data_padded: int, size: int | None) -> list[tuple[int, int]]:
    """Header windows for the next two HDUs, assuming image HDUs of `data_padded` bytes after `off`."""
    lo, hi = SPEC_HDR_BLOCKS
    span = hi * BLOCK
    wins = [
        (off + lo * BLOCK + data_padded, off + hi * BLOCK + data_padded + span - 1),
        (off + 2 * (lo * BLOCK + data_padded), off + 2 * (hi * BLOCK + data_padded) + span - 1),
    ]
    if size is not None:
        wins = [(a, min(b, size - 1)) for a, b in wins if a < size]
    return wins


def _read_header_at(rf: RemoteFile, off: int, data_padded: int | None) -> tuple[int, bytes]:
    """(header length, header bytes) of the HDU at `off`, fetching on a miss."""
    have = rf.prefix(off, MAX_HEADER_BYTES)
    n = find_header_end(have)
    if n is not None and n <= len(have):
        return n, have[:n]
    want = HDR_FETCH
    first = True
    while True:
        start = off + len(have)  # continue after the bytes already fetched
        ranges = [(start, start + want - 1)]
        if first and data_padded:
            ranges += _speculative_windows(off, data_padded, rf.size)
        first = False
        rf.fetch(ranges)
        have = rf.prefix(off, MAX_HEADER_BYTES)
        n = find_header_end(have)
        if n is not None and n <= len(have):
            return n, have[:n]
        if rf.size is not None and off + len(have) >= rf.size:
            raise L2FormatError(f"header at {off} runs past end of file")
        if len(have) >= MAX_HEADER_BYTES:
            raise L2FormatError(f"header at {off} longer than {MAX_HEADER_BYTES} bytes")
        want *= 2


def walk_hdus(rf: RemoteFile) -> list[RawHDU]:
    """Walk every HDU header of the remote file (rf.size must be known)."""
    hdus: list[RawHDU] = []
    off = 0
    data_padded: int | None = None
    while rf.size is None or off < rf.size:
        hlen, hbytes = _read_header_at(rf, off, data_padded if len(hdus) >= 2 else None)
        header = parse_header(hbytes)
        name = str(header.get("EXTNAME", "PRIMARY" if not hdus else f"HDU{len(hdus)}")).strip()
        dlen = data_size(header)
        hdus.append(RawHDU(len(hdus), name, off, off + hlen, dlen, header, hbytes[:hlen]))
        if len(hdus) == 2:
            data_padded = padded(dlen)  # the first extension (IMAGE): VARIANCE/ZODI have the same size
        off += hlen + padded(dlen)
        if rf.size is None:
            raise L2FormatError("file size unknown after the first read")
        if len(hdus) > 64:
            raise L2FormatError("more than 64 HDUs")
    if off != rf.size:
        log.warning("%s: HDUs end at %d but the file has %d bytes", rf.url, off, rf.size)
    return hdus


# --- layout -----------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class HDUInfo:
    index: int
    name: str
    header_start: int
    data_start: int
    data_length: int  # bytes, without padding

    @property
    def data_length_padded(self) -> int:
        return padded(self.data_length)

    @property
    def end(self) -> int:
        return self.data_start + self.data_length_padded


@dataclass(frozen=True)
class FlagsGeometry:
    """Geometry of the tile-compressed FLAGS BINTABLE."""

    naxis1: int  # bytes per table row (one row per tile)
    naxis2: int  # number of tiles
    pcount: int  # heap size
    theap: int  # heap offset from the start of the table data
    znaxis1: int
    znaxis2: int
    ztile1: int
    ztile2: int
    zcmptype: str
    zbitpix: int
    blocksize: int
    bytepix: int
    descriptor: str  # "P" (2 x int32) or "Q" (2 x int64)
    descriptor_offset: int  # byte offset of COMPRESSED_DATA's descriptor within a row
    zscale: float | None = None
    zzero: float | None = None
    zblank: int | None = None
    column_offsets: dict[str, tuple[int, str]] = field(default_factory=dict)  # name -> (offset, TFORM)


_TFORM_RE = re.compile(r"^\s*(\d*)([LXBIJKAEDCMPQ])(.*)$")
_TFORM_SIZE = {"L": 1, "B": 1, "I": 2, "J": 4, "K": 8, "A": 1, "E": 4, "D": 8, "C": 8, "M": 16, "P": 8, "Q": 16}


def _column_offsets(header: fits.Header) -> dict[str, tuple[int, str]]:
    out: dict[str, tuple[int, str]] = {}
    off = 0
    for i in range(1, int(header["TFIELDS"]) + 1):
        tform = str(header[f"TFORM{i}"]).strip()
        m = _TFORM_RE.match(tform)
        if not m:
            raise L2FormatError(f"unsupported TFORM{i} = {tform!r}")
        rep = int(m.group(1) or 1)
        code = m.group(2)
        size = (rep + 7) // 8 if code == "X" else rep * _TFORM_SIZE[code]
        out[str(header[f"TTYPE{i}"]).strip()] = (off, tform)
        off += size
    if off != int(header["NAXIS1"]):
        raise L2FormatError(f"columns use {off} bytes but NAXIS1 = {header['NAXIS1']}")
    return out


def _zval(header: fits.Header, name: str, default: int) -> int:
    for i in range(1, 100):
        key = header.get(f"ZNAME{i}")
        if key is None:
            break
        if str(key).strip().upper() == name:
            return int(header[f"ZVAL{i}"])
    return default


def flags_geometry(header: fits.Header) -> FlagsGeometry:
    """FlagsGeometry from a tile-compressed FLAGS header (raises L2FormatError if unsupported)."""
    if not header.get("ZIMAGE", False):
        raise L2FormatError("FLAGS is not a tile-compressed image")
    zcmp = str(header.get("ZCMPTYPE", "")).strip()
    if zcmp != "RICE_1":
        raise L2FormatError(f"unsupported FLAGS compression {zcmp!r}")
    cols = _column_offsets(header)
    if "COMPRESSED_DATA" not in cols:
        raise L2FormatError("FLAGS table without COMPRESSED_DATA column")
    off, tform = cols["COMPRESSED_DATA"]
    m = _TFORM_RE.match(tform)
    assert m is not None
    if m.group(2) not in ("P", "Q"):
        raise L2FormatError(f"COMPRESSED_DATA is not a variable-length column: {tform}")
    nx = int(header["ZNAXIS1"])
    ztile1 = int(header.get("ZTILE1", nx))
    if ztile1 != nx:
        raise L2FormatError(f"tiles narrower than the image (ZTILE1={ztile1}, ZNAXIS1={nx}) are not supported")
    naxis1, naxis2 = int(header["NAXIS1"]), int(header["NAXIS2"])
    zbitpix = int(header["ZBITPIX"])
    return FlagsGeometry(
        naxis1=naxis1,
        naxis2=naxis2,
        pcount=int(header.get("PCOUNT", 0)),
        theap=int(header.get("THEAP", naxis1 * naxis2)),
        znaxis1=nx,
        znaxis2=int(header["ZNAXIS2"]),
        ztile1=ztile1,
        ztile2=int(header.get("ZTILE2", 1)),
        zcmptype=zcmp,
        zbitpix=zbitpix,
        blocksize=_zval(header, "BLOCKSIZE", 32),
        bytepix=_zval(header, "BYTEPIX", abs(zbitpix) // 8),
        descriptor=m.group(2),
        descriptor_offset=off,
        zscale=float(header["ZSCALE"]) if "ZSCALE" in header else None,
        zzero=float(header["ZZERO"]) if "ZZERO" in header else None,
        zblank=int(header["ZBLANK"]) if "ZBLANK" in header else None,
        column_offsets={k: v for k, v in cols.items() if k != "COMPRESSED_DATA"},
    )


@dataclass
class L2Layout:
    """Byte layout and metadata of one Level-2 file."""

    cache_key: str
    url: str  # URL the layout was read from (offsets are identical on IBE and S3)
    file_size: int
    hdus: list[HDUInfo]
    headers: dict[str, str]  # EXTNAME -> header text (80-character cards)
    flags: FlagsGeometry | None
    wave: WaveLookup | None
    epsf_calibration: str  # identifies the ePSF calibration (cache key for read_epsf)
    requests: int = 0  # HTTP requests used to build this layout (0 when loaded from cache)
    bytes_read: int = 0
    version: int = LAYOUT_VERSION

    def hdu(self, name: str) -> HDUInfo:
        for h in self.hdus:
            if h.name == name:
                return h
        raise L2FormatError(f"{self.cache_key}: no {name} extension")

    def has(self, name: str) -> bool:
        return any(h.name == name for h in self.hdus)

    def header(self, name: str) -> fits.Header:
        if name not in self.headers:
            raise L2FormatError(f"{self.cache_key}: no {name} header")
        return header_from_text(self.headers[name])

    @cached_property
    def image_header(self) -> fits.Header:
        return self.header("IMAGE")

    @cached_property
    def flags_header(self) -> fits.Header | None:
        return self.header("FLAGS") if "FLAGS" in self.headers else None

    @cached_property
    def flag_bits(self) -> dict[str, int]:
        src = self.flags_header if self.flags_header is not None else self.image_header
        bits = flagmod.flag_bits(src)
        if not any(k.startswith("MSKN") for k in src):
            bits = flagmod.flag_bits(self.image_header)
        return bits

    @property
    def shape(self) -> tuple[int, int]:
        h = self.image_header
        return int(h["NAXIS2"]), int(h["NAXIS1"])

    def to_json(self) -> dict[str, Any]:
        return {
            "version": self.version,
            "cache_key": self.cache_key,
            "url": self.url,
            "file_size": self.file_size,
            "hdus": [asdict(h) for h in self.hdus],
            "headers": self.headers,
            "flags": None if self.flags is None else asdict(self.flags),
            "wave": None if self.wave is None else self.wave.to_json(),
            "epsf_calibration": self.epsf_calibration,
        }

    @classmethod
    def from_json(cls, d: dict[str, Any]) -> L2Layout:
        fl = d.get("flags")
        if fl is not None:
            fl = dict(fl)
            fl["column_offsets"] = {k: (int(v[0]), str(v[1])) for k, v in fl.get("column_offsets", {}).items()}
            fl = FlagsGeometry(**fl)
        return cls(
            cache_key=d["cache_key"],
            url=d["url"],
            file_size=int(d["file_size"]),
            hdus=[HDUInfo(**h) for h in d["hdus"]],
            headers=dict(d["headers"]),
            flags=fl,
            wave=None if d.get("wave") is None else WaveLookup.from_json(d["wave"]),
            epsf_calibration=d.get("epsf_calibration", ""),
            version=int(d.get("version", 0)),
        )


def _cache_root() -> Path:
    return Path(config.CACHE_DIR) / "pixels"


def _layout_path(cache_key: str) -> Path:
    return _cache_root() / "layout" / f"{cache_key}.json"


def image_url(image: DetectorImage, source: str = "ibe") -> str:
    """URL of the file on IRSA IBE ("ibe", multi-range) or the public S3 mirror ("s3", single ranges)."""
    if source == "ibe":
        return image.access_url.split("?", 1)[0]
    if source == "s3":
        if image.s3_key:
            return config.SPHEREX_S3_PREFIX + image.s3_key.lstrip("/")
        return rangeio.ibe_to_s3_url(image.access_url)
    raise ValueError(f"unknown source {source!r} (use 'ibe' or 's3')")


def epsf_calibration_id(layout_headers: dict[str, str], cache_key: str) -> str:
    """Identifier of the ePSF calibration product used for a file.

    The IMAGE header's 'HISTORY [CALIB] epsf <uuid>' (present in DR1 and QR3 files of every detector), else
    the EPSF extension's 'HISTORY Calibration source file: <name>' (absent for D3), else the file itself.
    Verified live: two D6 exposures with the same calibration have byte-identical EPSF tables.
    """
    if "IMAGE" in layout_headers:
        for line in header_from_text(layout_headers["IMAGE"]).get("HISTORY", []):
            m = re.match(r"\s*\[CALIB\]\s+epsf\s+(\S+)", str(line))
            if m:
                return f"calib-{m.group(1)}"
    if "EPSF" in layout_headers:
        src = calibration_source(header_from_text(layout_headers["EPSF"]))
        if src:
            return src
    return "file-" + cache_key.replace("/", "_")


def _build_layout(image: DetectorImage, url: str) -> L2Layout:
    rf = RemoteFile(url)
    img_bytes = config.DETECTOR_NPIX * config.DETECTOR_NPIX * 4
    flags_lo = BLOCK + IMAGE_HEADER_GUESS[0] + padded(img_bytes)
    flags_hi = BLOCK + IMAGE_HEADER_GUESS[-1] + padded(img_bytes) + HDR_FETCH - 1
    head_blob = rangeio.cached_blob(url, (0, HEAD_BYTES - 1))
    tail_blob = rangeio.cached_blob(url, (-TAIL_BYTES, -1))
    if head_blob is not None and tail_blob is not None and tail_blob[1] is not None:
        # read_header_and_wave already fetched the head and tail of this file: only the FLAGS window is new
        rf.size = tail_blob[1]
        rf.add(0, head_blob[0])
        rf.add(rf.size - len(tail_blob[0]), tail_blob[0])
        rf.fetch([(flags_lo, min(flags_hi, rf.size - 1))])
    else:
        rf.fetch([(0, HEAD_BYTES - 1), (flags_lo, flags_hi), (-TAIL_BYTES, -1)])
    raw = walk_hdus(rf)
    names = [h.name for h in raw]
    for required in ("IMAGE", "FLAGS"):
        if required not in names:
            raise L2FormatError(f"{image.cache_key}: no {required} extension (HDUs: {names})")
    headers = {h.name: header_to_text(h.header) for h in raw}
    by_name = {h.name: h for h in raw}
    flags_geo = flags_geometry(by_name["FLAGS"].header)
    wave = None
    if "WCS-WAVE" in by_name:
        w = by_name["WCS-WAVE"]
        tail = rf.prefix(w.header_start, w.data_start - w.header_start + w.data_length)
        if len(tail) < w.data_start - w.header_start + w.data_length:
            rf.fetch([(w.header_start, w.data_start + w.data_length - 1)])
            tail = rf.prefix(w.header_start, w.data_start - w.header_start + w.data_length)
        wave = WaveLookup.from_hdu_bytes(tail, by_name["IMAGE"].header)
    hdus = [HDUInfo(h.index, h.name, h.header_start, h.data_start, h.data_length) for h in raw]
    assert rf.size is not None
    layout = L2Layout(
        cache_key=image.cache_key,
        url=url,
        file_size=rf.size,
        hdus=hdus,
        headers=headers,
        flags=flags_geo,
        wave=wave,
        epsf_calibration=epsf_calibration_id(headers, image.cache_key),
        requests=rf.requests,
        bytes_read=rf.bytes,
    )
    _validate_layout(layout)
    log.info("%s: layout in %d requests, %d bytes", image.cache_key, rf.requests, rf.bytes)
    return layout


def _validate_layout(layout: L2Layout) -> None:
    h = layout.image_header
    if int(h.get("BITPIX", 0)) != -32 or int(h.get("NAXIS", 0)) != 2:
        raise L2FormatError(f"{layout.cache_key}: IMAGE is not a 2-D float32 image")
    ny, nx = layout.shape
    for name in ("VARIANCE", "ZODI"):
        if layout.has(name):
            hh = layout.header(name)
            if (int(hh["BITPIX"]), int(hh["NAXIS1"]), int(hh["NAXIS2"])) != (-32, nx, ny):
                raise L2FormatError(f"{layout.cache_key}: {name} shape/type differs from IMAGE")
    fg = layout.flags
    if fg is not None and (fg.znaxis1, fg.znaxis2) != (nx, ny):
        raise L2FormatError(f"{layout.cache_key}: FLAGS shape differs from IMAGE")


_LAYOUT_MEM: OrderedDict[str, L2Layout] = OrderedDict()
_LAYOUT_MEM_MAX = 2048
_LAYOUT_LOCK = threading.Lock()
_KEY_LOCKS: dict[str, threading.Lock] = {}


def _key_lock(key: str) -> threading.Lock:
    with _LAYOUT_LOCK:
        return _KEY_LOCKS.setdefault(key, threading.Lock())


def cached_layout(image: DetectorImage) -> L2Layout | None:
    """Layout from the memory or disk cache, without network access."""
    with _LAYOUT_LOCK:
        if image.cache_key in _LAYOUT_MEM:
            _LAYOUT_MEM.move_to_end(image.cache_key)
            return _LAYOUT_MEM[image.cache_key]
    path = _layout_path(image.cache_key)
    try:
        layout = L2Layout.from_json(json.loads(path.read_text(encoding="utf-8")))
    except (OSError, ValueError, KeyError, TypeError):
        return None
    if layout.version != LAYOUT_VERSION:
        return None
    _remember(layout)
    return layout


def _remember(layout: L2Layout) -> None:
    with _LAYOUT_LOCK:
        _LAYOUT_MEM[layout.cache_key] = layout
        _LAYOUT_MEM.move_to_end(layout.cache_key)
        while len(_LAYOUT_MEM) > _LAYOUT_MEM_MAX:
            _LAYOUT_MEM.popitem(last=False)


def clear_memory_cache() -> None:
    with _LAYOUT_LOCK:
        _LAYOUT_MEM.clear()


def read_layout(image: DetectorImage, *, source: str = "ibe", refresh: bool = False) -> L2Layout:
    """Byte offsets and headers of every HDU of a Level-2 file (cached per image.cache_key)."""
    with _key_lock(image.cache_key):
        if not refresh:
            layout = cached_layout(image)
            if layout is not None:
                return layout
        layout = _build_layout(image, image_url(image, source))
        rangeio.save_cache_file(_layout_path(image.cache_key), json.dumps(layout.to_json()).encode("utf-8"))
        _remember(layout)
        return layout


# --- WCS --------------------------------------------------------------------------------------------------


def celestial_wcs(header: fits.Header) -> WCS:
    """The primary (TAN-SIP) celestial WCS of an IMAGE header (a new object: WCS is not thread-safe)."""
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", FITSFixedWarning)
        return WCS(header, naxis=2)


def world_to_pixel(header_or_wcs: fits.Header | WCS, ra_deg: float, dec_deg: float) -> tuple[float, float]:
    """0-based (x, y) of a sky position with the full TAN-SIP WCS (iterative SIP inverse)."""
    wcs = header_or_wcs if isinstance(header_or_wcs, WCS) else celestial_wcs(header_or_wcs)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        xy = wcs.all_world2pix(
            np.array([[ra_deg, dec_deg]], dtype=float), 0, tolerance=1e-8, maxiter=100, quiet=True
        )
    return float(xy[0, 0]), float(xy[0, 1])


def stamp_box(x: float, y: float, half_size_px: int, nx: int, ny: int) -> tuple[int, int, int, int]:
    """Inclusive box (x0, y0, x1, y1) of side 2*half+1 centred on the pixel nearest (x, y), clipped."""
    if not (math.isfinite(x) and math.isfinite(y)):
        raise OutsideDetectorError("position has no pixel coordinates in this image")
    xc, yc = math.floor(x + 0.5), math.floor(y + 0.5)
    x0, x1 = max(0, xc - half_size_px), min(nx - 1, xc + half_size_px)
    y0, y1 = max(0, yc - half_size_px), min(ny - 1, yc + half_size_px)
    if x0 > x1 or y0 > y1:
        raise OutsideDetectorError(f"box around pixel ({x:.1f}, {y:.1f}) does not overlap the {nx}x{ny} detector")
    return x0, y0, x1, y1


# --- RICE_1 -----------------------------------------------------------------------------------------------

try:  # astropy's C codec (internal API; the pure-Python port below is the fallback)
    from astropy.io.fits.hdu.compressed._codecs import Rice1 as _AstropyRice1
except ImportError:  # pragma: no cover
    _AstropyRice1 = None

_NONZERO_COUNT = [0] + [v.bit_length() for v in range(1, 256)]
_RICE_PARAMS = {1: (3, 6, 8), 2: (4, 14, 16), 4: (5, 25, 32)}  # bytepix -> (fsbits, fsmax, bbits)


def rice_decode_py(buf: bytes, nx: int, blocksize: int = 32, bytepix: int = 4) -> np.ndarray:
    """Pure-Python RICE_1 decoder (port of cfitsio fits_rdecomp*); returns signed integers [nx]."""
    if bytepix not in _RICE_PARAMS:
        raise ValueError(f"unsupported BYTEPIX {bytepix}")
    fsbits, fsmax, bbits = _RICE_PARAMS[bytepix]
    mask = (1 << bbits) - 1
    c = buf
    out = np.empty(nx, dtype=np.int64)
    try:
        lastpix = int.from_bytes(c[:bytepix], "big")
        p = bytepix
        b = c[p]
        p += 1
        nbits = 8
        i = 0
        while i < nx:
            nbits -= fsbits
            while nbits < 0:
                b = (b << 8) | c[p]
                p += 1
                nbits += 8
            fs = (b >> nbits) - 1
            b &= (1 << nbits) - 1
            imax = min(i + blocksize, nx)
            if fs < 0:
                while i < imax:
                    out[i] = lastpix
                    i += 1
            elif fs == fsmax:
                while i < imax:
                    k = bbits - nbits
                    diff = (b << k) & mask
                    k -= 8
                    while k >= 0:
                        b = c[p]
                        p += 1
                        diff |= b << k
                        k -= 8
                    if nbits > 0:
                        b = c[p]
                        p += 1
                        diff |= b >> (-k)
                        b &= (1 << nbits) - 1
                    else:
                        b = 0
                    diff = (diff >> 1) if (diff & 1) == 0 else (~(diff >> 1)) & mask
                    lastpix = (diff + lastpix) & mask
                    out[i] = lastpix
                    i += 1
            else:
                while i < imax:
                    while b == 0:
                        nbits += 8
                        b = c[p]
                        p += 1
                    nzero = nbits - _NONZERO_COUNT[b]
                    nbits -= nzero + 1
                    b ^= 1 << nbits
                    nbits -= fs
                    while nbits < 0:
                        b = (b << 8) | c[p]
                        p += 1
                        nbits += 8
                    diff = (nzero << fs) | (b >> nbits)
                    b &= (1 << nbits) - 1
                    diff = (diff >> 1) if (diff & 1) == 0 else (~(diff >> 1)) & mask
                    lastpix = (diff + lastpix) & mask
                    out[i] = lastpix
                    i += 1
    except IndexError as exc:
        raise ValueError("RICE_1 stream ended early (truncated tile)") from exc
    sign = 1 << (bbits - 1)
    return np.where(out >= sign, out - (1 << bbits), out)


def rice_decode(buf: bytes, nx: int, blocksize: int = 32, bytepix: int = 4) -> np.ndarray:
    """Decode one RICE_1 tile of `nx` pixels to signed integers of `bytepix` bytes."""
    dtype = {1: np.uint8, 2: np.int16, 4: np.int32}[bytepix]
    if _AstropyRice1 is not None:
        codec = _AstropyRice1(blocksize=blocksize, bytepix=bytepix, tilesize=nx)
        arr = codec.decode(np.frombuffer(buf, dtype=np.uint8))
        return np.asarray(arr).astype(dtype, copy=False)
    return rice_decode_py(buf, nx, blocksize, bytepix).astype(dtype)


# --- pixel boxes ------------------------------------------------------------------------------------------


def _pixel_gap(url: str) -> int | None:
    """Gap merged between pixel row segments: small on IBE (multi-range), rangeio's default (1 MB) on S3."""
    return PIXEL_MAX_GAP if rangeio.is_multirange_host(url) else None


def _row_ranges(data_start: int, row_len: int, bytepix: int, x0: int, x1: int, y0: int, y1: int) -> list[tuple[int, int]]:
    return [
        (data_start + (y * row_len + x0) * bytepix, data_start + (y * row_len + x1 + 1) * bytepix - 1)
        for y in range(y0, y1 + 1)
    ]


def _descriptors(rows: bytes, fg: FlagsGeometry, ntiles: int) -> list[tuple[int, int]]:
    """(count, heap offset) of each tile from raw table rows."""
    dt = np.dtype(">i4") if fg.descriptor == "P" else np.dtype(">i8")
    out = []
    for t in range(ntiles):
        a = t * fg.naxis1 + fg.descriptor_offset
        cnt, off = np.frombuffer(rows, dtype=dt, count=2, offset=a)
        out.append((int(cnt), int(off)))
    return out


def _tile_scaling(rows: bytes, fg: FlagsGeometry, t: int) -> tuple[float | None, float | None, int | None]:
    """Per-tile ZSCALE/ZZERO/ZBLANK (column values override header values)."""
    zscale, zzero, zblank = fg.zscale, fg.zzero, fg.zblank
    for name in ("ZSCALE", "ZZERO", "ZBLANK"):
        if name in fg.column_offsets:
            off, tform = fg.column_offsets[name]
            code = tform.strip()[-1]
            dt = {"D": ">f8", "E": ">f4", "J": ">i4", "K": ">i8"}[code]
            v = np.frombuffer(rows, dtype=dt, count=1, offset=t * fg.naxis1 + off)[0]
            if name == "ZSCALE":
                zscale = float(v)
            elif name == "ZZERO":
                zzero = float(v)
            else:
                zblank = int(v)
    return zscale, zzero, zblank


def _decode_flags(
    rows: bytes, heap: dict[int, bytes], fg: FlagsGeometry, t0: int, t1: int
) -> np.ndarray:
    """Decode tiles t0..t1 into an array [rows, ZNAXIS1]."""
    blocks = []
    for k, t in enumerate(range(t0, t1 + 1)):
        nrows = min(fg.ztile2, fg.znaxis2 - t * fg.ztile2)
        tile = rice_decode(heap[t], fg.ztile1 * nrows, fg.blocksize, fg.bytepix).reshape(nrows, fg.ztile1)
        zscale, zzero, zblank = _tile_scaling(rows, fg, k)
        if zscale not in (None, 1.0) or zzero not in (None, 0.0):
            scaled = tile.astype(np.float64) * (1.0 if zscale is None else zscale) + (zzero or 0.0)
            if zblank is not None:
                scaled[tile == zblank] = np.nan
            tile = scaled
        blocks.append(tile)
    out = np.concatenate(blocks, axis=0)
    return out.astype(np.int32) if out.dtype.kind in "iu" and fg.zbitpix == 32 else out


def read_box(
    image: DetectorImage,
    x0: int,
    y0: int,
    x1: int,
    y1: int,
    *,
    with_flags: bool = True,
    with_variance: bool = True,
    with_zodi: bool = True,
    source: str = "ibe",
    layout: L2Layout | None = None,
    use_cache: bool = STAMP_CACHE,
) -> dict[str, np.ndarray]:
    """Pixels of the inclusive 0-based box [y0..y1, x0..x1] of IMAGE (+ VARIANCE, ZODI, FLAGS).

    Returns {"image", "variance"?, "zodi"?, "flags"?}; float planes are float32 MJy/sr ((MJy/sr)^2 for
    VARIANCE), FLAGS is int32. One call to rangeio for the float rows and the FLAGS row descriptors, one for
    the FLAGS heap segments.
    """
    layout = layout or read_layout(image, source=source)
    ny_full, nx_full = layout.shape
    if not (0 <= x0 <= x1 < nx_full and 0 <= y0 <= y1 < ny_full):
        raise OutsideDetectorError(f"box x {x0}..{x1}, y {y0}..{y1} is not inside the {nx_full}x{ny_full} image")
    planes = ["image"] + (["variance"] if with_variance else []) + (["zodi"] if with_zodi else [])
    planes += ["flags"] if with_flags else []
    cache_path = _stamp_path(image, x0, y0, x1, y1, planes)
    if use_cache:
        cached = _load_stamp(cache_path, planes)
        if cached is not None:
            return cached
    url = image_url(image, source)
    hdu_of = {"image": "IMAGE", "variance": "VARIANCE", "zodi": "ZODI"}
    float_planes = [p for p in planes if p != "flags"]
    ranges: list[tuple[int, int]] = []
    spans: dict[str, tuple[int, int]] = {}
    for p in float_planes:
        h = layout.hdu(hdu_of[p])
        rr = _row_ranges(h.data_start, nx_full, 4, x0, x1, y0, y1)
        spans[p] = (len(ranges), len(ranges) + len(rr))
        ranges += rr
    fg = layout.flags
    t0 = t1 = 0
    if with_flags:
        if fg is None:
            raise L2FormatError(f"{image.cache_key}: no FLAGS geometry")
        fh = layout.hdu("FLAGS")
        t0, t1 = y0 // fg.ztile2, y1 // fg.ztile2
        ranges.append((fh.data_start + t0 * fg.naxis1, fh.data_start + (t1 + 1) * fg.naxis1 - 1))
    parts = rangeio.read_ranges(url, ranges, max_gap=_pixel_gap(url))
    nx, ny = x1 - x0 + 1, y1 - y0 + 1
    out: dict[str, np.ndarray] = {}
    for p in float_planes:
        a, b = spans[p]
        raw = b"".join(parts[a:b])
        out[p] = np.frombuffer(raw, dtype=">f4").reshape(ny, nx).astype(np.float32)
    if with_flags:
        assert fg is not None
        rows = parts[-1]
        desc = _descriptors(rows, fg, t1 - t0 + 1)
        heap0 = layout.hdu("FLAGS").data_start + fg.theap
        tiles = list(range(t0, t1 + 1))
        for t, (cnt, _off) in zip(tiles, desc, strict=True):
            if cnt <= 0:
                raise L2FormatError(f"{image.cache_key}: FLAGS tile {t} is not RICE-compressed")
        heap_parts = rangeio.read_ranges(
            url, [(heap0 + off, heap0 + off + cnt - 1) for cnt, off in desc], max_gap=_pixel_gap(url)
        )
        tile_rows = _decode_flags(rows, dict(zip(tiles, heap_parts, strict=True)), fg, t0, t1)
        r0 = y0 - t0 * fg.ztile2
        out["flags"] = np.ascontiguousarray(tile_rows[r0 : r0 + ny, x0 : x1 + 1])
    if use_cache:
        _save_stamp(cache_path, out)
    return out


def _stamp_path(image: DetectorImage, x0: int, y0: int, x1: int, y1: int, planes: Sequence[str]) -> Path:
    code = "".join(p[0] for p in planes)
    return _cache_root() / "stamps" / image.cache_key / f"{x0}_{y0}_{x1}_{y1}_{code}.npz"


def _load_stamp(path: Path, planes: Sequence[str]) -> dict[str, np.ndarray] | None:
    try:
        with np.load(path) as z:
            if all(p in z.files for p in planes):
                return {p: z[p] for p in planes}
    except (OSError, ValueError, EOFError):
        return None
    return None


def _save_stamp(path: Path, arrays: dict[str, np.ndarray]) -> None:
    buf = io.BytesIO()
    np.savez_compressed(buf, **arrays)
    rangeio.save_cache_file(path, buf.getvalue())  # best-effort


def read_stamp(
    image: DetectorImage,
    ra: float,
    dec: float,
    half_size_px: int = 30,
    with_flags: bool = True,
    with_variance: bool = True,
    with_zodi: bool = True,
    with_wavelength: bool = True,
    *,
    source: str = "ibe",
    use_cache: bool = STAMP_CACHE,
) -> Stamp:
    """Pixel box of side 2*half_size_px+1 around (ra, dec) [deg, ICRS], clipped to the detector.

    The centre is the pixel nearest the position given by the full TAN-SIP WCS. stamp.wcs is that WCS
    sliced to the box (CRPIX shifted by x0, y0; SIP terms preserved). A box that only partly overlaps the
    detector is clipped (the target itself may then lie outside the stamp); no overlap raises
    OutsideDetectorError.
    """
    if int(half_size_px) != half_size_px or half_size_px < 0:
        raise ValueError(f"half_size_px must be a non-negative integer, got {half_size_px!r}")
    layout = read_layout(image, source=source)
    header = layout.image_header
    wcs = celestial_wcs(header)
    x, y = world_to_pixel(wcs, ra, dec)
    ny_full, nx_full = layout.shape
    x0, y0, x1, y1 = stamp_box(x, y, int(half_size_px), nx_full, ny_full)
    planes = read_box(
        image, x0, y0, x1, y1,
        with_flags=with_flags, with_variance=with_variance, with_zodi=with_zodi,
        source=source, layout=layout, use_cache=use_cache,
    )
    lam = bw = None
    if with_wavelength and layout.wave is not None:
        lam, bw = layout.wave.grid(x0, y0, x1 - x0 + 1, y1 - y0 + 1)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", FITSFixedWarning)
        stamp_wcs = wcs.slice((slice(y0, y1 + 1), slice(x0, x1 + 1)))
    return Stamp(
        image=image,
        x0=x0,
        y0=y0,
        data=planes["image"],
        variance=planes.get("variance"),
        zodi=planes.get("zodi"),
        flags=planes.get("flags"),
        wcs=stamp_wcs,
        header=header.copy(),
        mjd_avg=float(header["MJD-AVG"]),
        wavelength_um=lam,
        bandwidth_um=bw,
        flag_bits=dict(layout.flag_bits),
    )


# --- EPSF -------------------------------------------------------------------------------------------------

EPSF_ROW_BYTES = 8752


def _epsf_path(image: DetectorImage, layout: L2Layout) -> Path:
    calib = re.sub(r"[^A-Za-z0-9_.-]+", "_", layout.epsf_calibration)
    return _cache_root() / "epsf" / f"D{image.detector}_{calib}.npz"


def epsf_from_table(data: Any, header: fits.Header) -> EPSFGrid:
    """EPSFGrid from the EPSF table (XCENTER/YCENTER are 0-based detector pixels; psfs sum to 1)."""
    psfs = np.asarray(data["EPSF"], dtype=np.float64)
    if psfs.ndim != 3:
        raise L2FormatError(f"EPSF column has shape {psfs.shape}")
    over = int(header.get("OVSMPX", 5))
    if int(header.get("OVSMPY", over)) != over:
        raise L2FormatError("different x/y ePSF oversampling is not supported")
    names = data.columns.names if hasattr(data, "columns") else list(data.keys())
    return EPSFGrid(
        xcenter=np.asarray(data["XCENTER"], dtype=np.float64),
        ycenter=np.asarray(data["YCENTER"], dtype=np.float64),
        psfs=psfs,
        oversampling=over,
        cwave_um=np.asarray(data["CWAVE"], dtype=np.float64) if "CWAVE" in names else None,
    )


_EPSF_LOCKS: dict[str, threading.Lock] = {}


def _load_epsf(path: Path) -> EPSFGrid | None:
    try:
        with np.load(path) as z:
            return EPSFGrid(
                xcenter=z["xcenter"], ycenter=z["ycenter"], psfs=z["psfs"], oversampling=int(z["oversampling"]),
                cwave_um=z["cwave_um"] if "cwave_um" in z.files else None,
            )
    except (OSError, ValueError, KeyError):
        return None


def read_epsf(image: DetectorImage, *, source: str = "ibe") -> EPSFGrid:
    """The ePSF grid of a Level-2 file (441 zones, 451 for D3), cached per detector and PSF calibration.

    The calibration is identified by the IMAGE header card 'HISTORY [CALIB] epsf <uuid>' (see
    `epsf_calibration_id`), so files sharing it read the 3.9 MB table once. XCENTER/YCENTER are 0-based
    detector pixels; each 33x33 ePSF is oversampled 5x and sums to 1 (photutils: ImagePSF(data=psf * 25,
    oversampling=5)).
    """
    layout = read_layout(image, source=source)
    path = _epsf_path(image, layout)
    with _LAYOUT_LOCK:
        lock = _EPSF_LOCKS.setdefault(str(path), threading.Lock())
    with lock:  # one download per calibration even when several threads ask at once
        grid = _load_epsf(path)
        if grid is None:
            grid = _download_epsf(image, layout, source, path)
    return grid


def _download_epsf(image: DetectorImage, layout: L2Layout, source: str, path: Path) -> EPSFGrid:
    h = layout.hdu("EPSF")
    header = layout.header("EPSF")
    if int(header["NAXIS1"]) != EPSF_ROW_BYTES:
        log.warning("%s: EPSF rows are %s bytes (expected %d)", image.cache_key, header["NAXIS1"], EPSF_ROW_BYTES)
    data = rangeio.read_range(image_url(image, source), h.data_start, h.data_start + h.data_length - 1)
    hdu_bytes = header.tostring(sep="", endcard=True, padding=True).encode("ascii") + data
    table = table_hdu_from_bytes(hdu_bytes)
    grid = epsf_from_table(table.data, table.header)
    arrays = {"xcenter": grid.xcenter, "ycenter": grid.ycenter, "psfs": grid.psfs,
              "oversampling": np.array(grid.oversampling)}
    if grid.cwave_um is not None:
        arrays["cwave_um"] = grid.cwave_um
    buf = io.BytesIO()
    np.savez_compressed(buf, **arrays)
    rangeio.save_cache_file(path, buf.getvalue())
    return grid


# --- IMAGE header + wavelength lookup without a full layout ------------------------------------------------


def _find_last_hdu(tail: bytes, tail_start: int, file_size: int, extname: str) -> bytes | None:
    """Bytes of the extension `extname` that ends exactly at EOF, located inside `tail`."""
    for off in range(0, len(tail), BLOCK):
        if tail[off : off + 8] != b"XTENSION":
            continue
        n = find_header_end(tail[off:])
        if n is None:
            continue
        h = parse_header(tail[off:])
        if str(h.get("EXTNAME", "")).strip() != extname:
            continue
        if tail_start + off + n + padded(data_size(h)) != file_size:
            continue
        return tail[off : off + n + data_size(h)]
    return None


def read_header_and_wave(image: DetectorImage, *, source: str = "ibe") -> tuple[fits.Header, WaveLookup]:
    """(IMAGE header, WaveLookup) of a file.

    From the cached layout when there is one; otherwise one multi-range request reads bytes 0-40959 (PRIMARY +
    IMAGE header) and the last 8640 bytes (the WCS-WAVE extension is the last HDU: a suffix range finds it
    without knowing the file layout). Both ranges go through rangeio's on-disk blob cache.
    """
    layout = cached_layout(image)
    if layout is not None and layout.wave is not None:
        return layout.image_header, layout.wave
    url = image_url(image, source)
    res = rangeio.fetch_ranges(url, [(0, HEAD_BYTES - 1), (-TAIL_BYTES, -1)], cache=True)
    head, tail = res.parts
    plen = find_header_end(head)
    if plen is None or res.total_size is None:
        raise L2FormatError(f"{image.cache_key}: cannot parse the primary header")
    image_header = None
    if find_header_end(head[plen:]) is not None:
        image_header = parse_header(head[plen:])
    wave_bytes = _find_last_hdu(tail, res.total_size - len(tail), res.total_size, "WCS-WAVE")
    if image_header is None or str(image_header.get("EXTNAME", "")).strip() != "IMAGE" or wave_bytes is None:
        log.info("%s: header/tail shortcut failed; reading the full layout", image.cache_key)
        layout = read_layout(image, source=source)
        if layout.wave is None:
            raise L2FormatError(f"{image.cache_key}: no WCS-WAVE extension")
        return layout.image_header, layout.wave
    return image_header, WaveLookup.from_hdu_bytes(wave_bytes, image_header)


def read_wave_lookup(image: DetectorImage, *, source: str = "ibe") -> WaveLookup:
    return read_header_and_wave(image, source=source)[1]
