"""SPHEREx Level-2 FLAGS bitmask: bit names from the file header, flag groups, masks and summaries.

Each Level-2 file (and each DR1 cube tile) documents its FLAGS bits with three keyword families in the FLAGS
extension header (the IMAGE header of DR1 files does not carry them):

    MSKNnnnn = '<name>'   name of mask plane n (n = bit number, 4 digits)
    MSKMnnnn = 1 << n     bit mask of plane n
    MSKDnnnn = '<text>'   description

`flag_bits(header)` resolves names to bit numbers per file. DR1 Level-2 headers omit SATELLITE_HALO (bit 29,
documented by IRSA and present in the DR1 cube header), so it is added from `config.SATELLITE_HALO_FALLBACK_BIT`
when the bit is free. Groups (config.FLAGS_INVALID, FLAGS_ARTIFACT, FLAGS_SATURATION, FLAGS_INFO) are matched
by name prefix, so "GHOST" covers GHOST, GHOST_FPA and GHOST_EXT.
"""

from __future__ import annotations

import logging
import re
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from typing import Any

import numpy as np

from pxh import config

log = logging.getLogger(__name__)

_MSKN_RE = re.compile(r"^MSKN(\d{1,4})$")

#: Default science mask groups: bad pixels and artifacts (saturation and informational flags are separate).
SCIENCE_GROUPS: tuple[str, ...] = config.FLAGS_INVALID + config.FLAGS_ARTIFACT
SATURATION_GROUPS: tuple[str, ...] = config.FLAGS_SATURATION
INFO_GROUPS: tuple[str, ...] = config.FLAGS_INFO

GROUPS: dict[str, tuple[str, ...]] = {
    "invalid": config.FLAGS_INVALID,
    "artifact": config.FLAGS_ARTIFACT,
    "saturation": config.FLAGS_SATURATION,
    "info": config.FLAGS_INFO,
}


@dataclass(frozen=True)
class FlagInfo:
    """One documented flag bit."""

    bit: int
    name: str
    description: str
    group: str  # "invalid" | "artifact" | "saturation" | "info" | "" (ungrouped)
    from_header: bool = True  # False for the SATELLITE_HALO fallback

    @property
    def mask(self) -> int:
        return 1 << self.bit


def _header_items(header: Any) -> Iterable[tuple[str, Any]]:
    """(keyword, value) pairs of an astropy Header or a plain mapping."""
    if hasattr(header, "cards"):
        return ((c.keyword, c.value) for c in header.cards)
    return header.items()


def _str(v: Any) -> str:
    return str(v).strip()


def flag_table(header: Any) -> list[FlagInfo]:
    """Every flag documented by MSKN/MSKM/MSKD keywords (plus the SATELLITE_HALO fallback), sorted by bit."""
    items = dict(_header_items(header))
    infos: dict[int, FlagInfo] = {}
    for key, value in items.items():
        m = _MSKN_RE.match(str(key))
        if not m:
            continue
        digits = m.group(1)
        bit = int(digits)
        name = _str(value)
        mask = items.get(f"MSKM{digits}")
        if mask is not None:
            mask = int(mask)
            if mask != 1 << bit:
                if mask > 0 and mask & (mask - 1) == 0:
                    log.warning("MSKM%s=%d disagrees with bit %d of %s; using the mask", digits, mask, bit, name)
                    bit = mask.bit_length() - 1
                else:
                    log.warning("MSKM%s=%d is not a single bit; ignoring %s", digits, mask, name)
                    continue
        if not name:
            continue
        infos[bit] = FlagInfo(bit, name, _str(items.get(f"MSKD{digits}", "")), group_of(name))
    names = {i.name for i in infos.values()}
    fb = config.SATELLITE_HALO_FALLBACK_BIT
    if "SATELLITE_HALO" not in names and fb not in infos:
        infos[fb] = FlagInfo(
            fb, "SATELLITE_HALO", "Pixel part of a satellite streak halo",
            group_of("SATELLITE_HALO"), from_header=False,
        )
    return [infos[b] for b in sorted(infos)]


def flag_bits(header: Any) -> dict[str, int]:
    """Flag name -> bit number for one file, from its MSKN*/MSKM* keywords (+ SATELLITE_HALO fallback)."""
    return {info.name: info.bit for info in flag_table(header)}


def group_of(name: str) -> str:
    """Name of the first group whose prefixes match `name` ("" if none)."""
    for group, prefixes in GROUPS.items():
        if any(name.startswith(p) for p in prefixes):
            return group
    return ""


def group_mask(bits: Mapping[str, int], names: Iterable[str]) -> int:
    """OR of the masks of every flag whose name starts with one of `names` (prefix match)."""
    mask = 0
    for prefix in names:
        hits = [b for n, b in bits.items() if n.startswith(prefix)]
        if not hits:
            log.debug("flag group name %r matches no flag in this file", prefix)
        for b in hits:
            mask |= 1 << b
    return mask


def science_mask(bits: Mapping[str, int], *, include_saturation: bool = False) -> int:
    """Default mask of pixels to reject: invalid + artifact groups (optionally + saturation)."""
    groups = SCIENCE_GROUPS + (SATURATION_GROUPS if include_saturation else ())
    return group_mask(bits, groups)


def invalid_mask(bits: Mapping[str, int]) -> int:
    return group_mask(bits, config.FLAGS_INVALID)


def artifact_mask(bits: Mapping[str, int]) -> int:
    return group_mask(bits, config.FLAGS_ARTIFACT)


def saturation_mask(bits: Mapping[str, int]) -> int:
    return group_mask(bits, config.FLAGS_SATURATION)


def info_mask(bits: Mapping[str, int]) -> int:
    return group_mask(bits, config.FLAGS_INFO)


def good_pixels(flags: np.ndarray, bits: Mapping[str, int], mask: int | None = None) -> np.ndarray:
    """Boolean array: True where none of the `mask` bits (default: science_mask) is set."""
    m = science_mask(bits) if mask is None else mask
    return (np.asarray(flags).astype(np.int64) & m) == 0


def describe(value: int, bits: Mapping[str, int]) -> list[str]:
    """Names of the bits set in `value`, by increasing bit; undocumented bits appear as 'BIT<n>'."""
    by_bit = {b: n for n, b in bits.items()}
    v = int(value) & 0xFFFFFFFF
    out = []
    for b in range(32):
        if v >> b & 1:
            out.append(by_bit.get(b, f"BIT{b}"))
    return out


def fraction_by_flag(flags: np.ndarray, bits: Mapping[str, int]) -> dict[str, float]:
    """Fraction of pixels with each flag set (every documented flag, in bit order; NaN for empty input)."""
    arr = np.asarray(flags).astype(np.int64).ravel()
    n = arr.size
    out: dict[str, float] = {}
    for name, b in sorted(bits.items(), key=lambda kv: kv[1]):
        out[name] = float(np.count_nonzero(arr >> b & 1)) / n if n else float("nan")
    return out


def markdown_table(header: Any) -> str:
    """Docs-ready Markdown table of the flags documented in a header."""
    lines = ["| Bit | Name | Group | Description |", "|---:|---|---|---|"]
    for i in flag_table(header):
        note = "" if i.from_header else " (not in DR1 Level-2 headers; IRSA documentation)"
        lines.append(f"| {i.bit} | {i.name} | {i.group or '-'} | {i.description}{note} |")
    return "\n".join(lines)
