"""Sky coordinates typed by users: parsing, formatting, angular separations and tangent-plane offsets.

``parse_coordinates`` accepts ICRS positions as decimal degrees ("269.452 4.693", "269.452, +4.693",
"269.452d -7.2d") or sexagesimal RA (hours) and Dec ("17 57 48.5 +04 41 36", "17:57:48.5 +04:41:36",
"17h57m48.5s +4d41m36s", "08h55m10.831s -7d14m42.53s"), including Unicode minus, degree, prime and
double-prime signs and a negative zero declination ("-00 30 00"). It returns None when the text is not
coordinates (so callers can try name resolution) and raises ValueError when coordinate-like text is
malformed or out of range.

How RA and Dec are told apart: a comma, else the first explicitly signed number after the first, else
unit letters (h/d start a new coordinate), else colon-joined groups, else an even split of 2, 4 or 6 bare
numbers. A lone RA number is in degrees; a sexagesimal RA is in hours unless its first unit is "d".
"""

from __future__ import annotations

import math
import re
from collections.abc import Sequence
from dataclasses import dataclass
from typing import overload

import numpy as np
from numpy.typing import ArrayLike, NDArray

FloatArray = NDArray[np.float64]

_CHAR_MAP = str.maketrans(
    {
        "−": "-",  # minus sign
        "‐": "-",
        "‑": "-",
        "‒": "-",
        "–": "-",
        "—": "-",
        "―": "-",
        "﹣": "-",
        "－": "-",
        "＋": "+",
        "°": "d",  # degree sign
        "º": "d",  # masculine ordinal, often typed for a degree sign
        "˚": "d",  # ring above
        "′": "m",  # prime
        "'": "m",
        "’": "m",
        "´": "m",
        "″": "s",  # double prime
        '"': "s",
        "”": "s",
        " ": " ",
        " ": " ",
        " ": " ",
        " ": " ",
        "　": " ",
    }
)
_NUMBER = r"(?:\d+(?:\.\d*)?|\.\d+)"
_TOKEN_RE = re.compile(
    rf"(?P<ws>\s+)|(?P<num>[+-]?{_NUMBER})|(?P<unit>[hdms])|(?P<colon>:)|(?P<comma>[,;])|(?P<other>.)",
    re.DOTALL,
)
_DEG_WORD_RE = re.compile(r"deg(?:rees?|s)?")
_UNIT_RANK = {"h": 0, "d": 0, "m": 1, "s": 2}


@dataclass
class _Component:
    """One number of a coordinate string, with its unit letter and the separator that follows it."""

    digits: str  # unsigned numeric text, e.g. "04" or "48.5"
    sign: str  # "", "+" or "-"
    unit: str | None = None  # "h", "d", "m", "s" or None
    sep_after: str = ""  # "" (adjacent or end), " ", ":" or ","


def _normalize(text: str) -> str:
    s = text.strip().lower().replace("''", '"').replace("′′", '"')
    s = s.translate(_CHAR_MAP)
    return _DEG_WORD_RE.sub("d", s).strip()


def _tokenize(text: str) -> list[_Component] | None:
    """Split normalised text into components; None if it is not shaped like coordinates."""
    comps: list[_Component] = []
    seps: list[str] = []  # separators seen since the last component
    for match in _TOKEN_RE.finditer(text):
        kind, tok = match.lastgroup, match.group()
        if kind == "other":
            return None
        if kind == "ws":
            seps.append(" ")
        elif kind in ("colon", "comma"):
            if not comps:
                return None
            seps.append(":" if kind == "colon" else ",")
        elif kind == "unit":
            # A unit letter must directly follow a number that has no unit yet.
            if not comps or comps[-1].unit is not None or any(s != " " for s in seps):
                return None
            comps[-1].unit = tok
            seps = []
        else:  # number
            hard = [s for s in seps if s != " "]
            if len(hard) > 1:
                return None
            if comps:
                comps[-1].sep_after = hard[0] if hard else (" " if seps else "")
            elif hard:
                return None
            sign = tok[0] if tok[0] in "+-" else ""
            comps.append(_Component(digits=tok[len(sign) :], sign=sign))
            seps = []
    if any(s != " " for s in seps):
        return None
    return comps


def _split_by_units(comps: list[_Component]) -> list[list[_Component]]:
    """Group components by unit letters: h/d (or a reset of the h-m-s order) starts a new coordinate."""
    groups: list[list[_Component]] = []
    current: list[_Component] = []
    last = -1
    for comp in comps:
        explicit = _UNIT_RANK.get(comp.unit) if comp.unit else None
        rank = explicit if explicit is not None else (last + 1 if current else 0)
        if current and (rank == 0 or rank <= last or rank > 2):
            groups.append(current)
            current = []
            rank = explicit if explicit is not None else 0
        if not current and rank != 0:
            raise ValueError(f"a coordinate cannot start with a '{comp.unit}' value")
        current.append(comp)
        last = rank
    groups.append(current)
    return groups


def _split_by_colons(comps: list[_Component]) -> list[list[_Component]]:
    groups: list[list[_Component]] = []
    current: list[_Component] = []
    for comp in comps:
        current.append(comp)
        if comp.sep_after != ":":
            groups.append(current)
            current = []
    if current:
        groups.append(current)
    return groups


def _split_ra_dec(comps: list[_Component]) -> tuple[list[_Component], list[_Component]]:
    commas = [i for i, c in enumerate(comps) if c.sep_after == ","]
    if len(commas) > 1:
        raise ValueError("expected at most one comma, between RA and Dec")
    if commas:
        cut = commas[0] + 1
        return comps[:cut], comps[cut:]
    signed = [i for i, c in enumerate(comps) if i > 0 and c.sign]
    if signed:
        return comps[: signed[0]], comps[signed[0] :]
    if any(c.unit for c in comps):
        groups = _split_by_units(comps)
    elif any(c.sep_after == ":" for c in comps):
        groups = _split_by_colons(comps)
    elif len(comps) in (2, 4, 6):
        half = len(comps) // 2
        groups = [comps[:half], comps[half:]]
    else:
        raise ValueError(
            f"cannot tell RA from Dec in {len(comps)} numbers: sign the declination (e.g. +04 41 36) "
            "or separate RA and Dec with a comma"
        )
    if len(groups) != 2:
        raise ValueError(f"expected 2 coordinates (RA and Dec), found {len(groups)}")
    return groups[0], groups[1]


def _check_units(group: list[_Component], is_ra: bool) -> None:
    first_allowed = ("h", "d", None) if is_ra else ("d", None)
    what = "RA" if is_ra else "Dec"
    if group[0].unit not in first_allowed:
        raise ValueError(f"{what} cannot start with a '{group[0].unit}' value")
    for comp, expected in zip(group[1:], ("m", "s"), strict=False):
        if comp.unit not in (None, expected):
            raise ValueError(f"unexpected unit '{comp.unit}' in {what}")


def _group_to_degrees(group: list[_Component], is_ra: bool) -> float:
    what = "RA" if is_ra else "Dec"
    if not 1 <= len(group) <= 3:
        raise ValueError(f"{what} must have 1 to 3 components, got {len(group)}")
    if any(c.sign for c in group[1:]):
        raise ValueError(f"only the first {what} component may carry a sign")
    if any("." in c.digits for c in group[:-1]):
        raise ValueError(f"only the last {what} component may have a fractional part")
    _check_units(group, is_ra)
    values = [float(c.digits) for c in group]
    for value, label in zip(values[1:], ("minutes", "seconds"), strict=False):
        if value >= 60.0:
            raise ValueError(f"{what} {label} must be < 60, got {value:g}")
    magnitude = sum(v / 60.0**k for k, v in enumerate(values))
    sign = -1.0 if group[0].sign == "-" else 1.0
    if not is_ra:
        dec = sign * magnitude
        if abs(dec) > 90.0:
            raise ValueError(f"Dec {dec:g} deg is outside [-90, +90]")
        return dec
    in_hours = group[0].unit == "h" or (group[0].unit is None and len(group) > 1)
    ra = sign * magnitude * (15.0 if in_hours else 1.0)
    if not 0.0 <= ra <= 360.0:
        raise ValueError(f"RA {ra:g} deg is outside [0, 360)")
    return ra % 360.0


def parse_coordinates(text: str) -> tuple[float, float] | None:
    """Parse ICRS coordinates typed by a user into (ra_deg, dec_deg), with ra in [0, 360).

    Returns None if the text is not coordinates (e.g. an object name such as "M 31" or "GJ 699").
    Raises ValueError if it looks like coordinates but is ambiguous, malformed or out of range.
    """
    normalized = _normalize(text)
    if not normalized:
        return None
    comps = _tokenize(normalized)
    if comps is None or len(comps) < 2:
        return None
    ra_group, dec_group = _split_ra_dec(comps)
    return _group_to_degrees(ra_group, is_ra=True), _group_to_degrees(dec_group, is_ra=False)


# --- formatting ---------------------------------------------------------------------------------


def _sexagesimal(total_units: int, precision: int) -> tuple[int, int, str]:
    """Split a count of 10**-precision seconds into (whole units, minutes, seconds text)."""
    scale = 10**precision
    whole, rem = divmod(total_units, 3600 * scale)
    minutes, sec_scaled = divmod(rem, 60 * scale)
    sec_int, sec_frac = divmod(sec_scaled, scale)
    seconds = f"{sec_int:02d}" + (f".{sec_frac:0{precision}d}" if precision > 0 else "")
    return whole, minutes, seconds


def format_ra_hms(ra_deg: float, precision: int = 2, sep: str | None = None) -> str:
    """Format RA as "17h57m48.50s" (``sep=None``), or joined by ``sep``, e.g. "17:57:48.50"."""
    if not math.isfinite(ra_deg):
        raise ValueError(f"RA must be finite, got {ra_deg}")
    if precision < 0:
        raise ValueError("precision must be >= 0")
    scale = 10**precision
    total = round((ra_deg % 360.0) / 15.0 * 3600.0 * scale) % (24 * 3600 * scale)
    hours, minutes, seconds = _sexagesimal(total, precision)
    if sep is None:
        return f"{hours:02d}h{minutes:02d}m{seconds}s"
    return f"{hours:02d}{sep}{minutes:02d}{sep}{seconds}"


def format_dec_dms(dec_deg: float, precision: int = 1, sep: str | None = None) -> str:
    """Format Dec as "+04d41m36.0s" (``sep=None``), or joined by ``sep``, e.g. "+04:41:36.0"."""
    if not math.isfinite(dec_deg) or abs(dec_deg) > 90.0:
        raise ValueError(f"Dec must be within [-90, +90], got {dec_deg}")
    if precision < 0:
        raise ValueError("precision must be >= 0")
    total = round(abs(dec_deg) * 3600.0 * 10**precision)
    degrees, minutes, seconds = _sexagesimal(total, precision)
    sign = "-" if dec_deg < 0 and total > 0 else "+"
    if sep is None:
        return f"{sign}{degrees:02d}d{minutes:02d}m{seconds}s"
    return f"{sign}{degrees:02d}{sep}{minutes:02d}{sep}{seconds}"


# --- spherical geometry -------------------------------------------------------------------------


@overload
def angular_separation_arcsec(ra1: float, dec1: float, ra2: float, dec2: float) -> float: ...
@overload
def angular_separation_arcsec(
    ra1: ArrayLike, dec1: ArrayLike, ra2: ArrayLike, dec2: ArrayLike
) -> float | FloatArray: ...
def angular_separation_arcsec(
    ra1: ArrayLike, dec1: ArrayLike, ra2: ArrayLike, dec2: ArrayLike
) -> float | FloatArray:
    """Great-circle separation in arcsec (Vincenty formula: accurate from micro-arcsec to 180 deg).

    Inputs in degrees; arrays broadcast. Scalar inputs give a float.
    """
    a1, d1, a2, d2 = (np.radians(np.asarray(v, dtype=np.float64)) for v in (ra1, dec1, ra2, dec2))
    dra = a2 - a1
    s1, c1, s2, c2 = np.sin(d1), np.cos(d1), np.sin(d2), np.cos(d2)
    num1 = c2 * np.sin(dra)
    num2 = c1 * s2 - s1 * c2 * np.cos(dra)
    den = s1 * s2 + c1 * c2 * np.cos(dra)
    sep = np.degrees(np.arctan2(np.hypot(num1, num2), den)) * 3600.0
    return float(sep) if np.ndim(sep) == 0 else sep


@overload
def tangent_plane_offsets_arcsec(
    ra_deg: float, dec_deg: float, ra0_deg: float, dec0_deg: float
) -> tuple[float, float]: ...
@overload
def tangent_plane_offsets_arcsec(
    ra_deg: FloatArray | Sequence[float],
    dec_deg: FloatArray | Sequence[float],
    ra0_deg: float,
    dec0_deg: float,
) -> tuple[FloatArray, FloatArray]: ...
def tangent_plane_offsets_arcsec(
    ra_deg: ArrayLike, dec_deg: ArrayLike, ra0_deg: float, dec0_deg: float
) -> tuple[float, float] | tuple[FloatArray, FloatArray]:
    """Gnomonic offsets (xi east, eta north) in arcsec of positions relative to (ra0, dec0).

    Raises ValueError for positions 90 deg or more from the reference (not on the tangent plane).
    """
    a, d = np.radians(np.asarray(ra_deg, dtype=np.float64)), np.radians(np.asarray(dec_deg, dtype=np.float64))
    a0, d0 = math.radians(ra0_deg), math.radians(dec0_deg)
    cos_c = math.sin(d0) * np.sin(d) + math.cos(d0) * np.cos(d) * np.cos(a - a0)
    if np.any(cos_c <= 0.0):
        raise ValueError("position is 90 deg or more from the tangent point")
    xi = np.cos(d) * np.sin(a - a0) / cos_c
    eta = (math.cos(d0) * np.sin(d) - math.sin(d0) * np.cos(d) * np.cos(a - a0)) / cos_c
    xi_as, eta_as = np.degrees(xi) * 3600.0, np.degrees(eta) * 3600.0
    if np.ndim(xi_as) == 0:
        return float(xi_as), float(eta_as)
    return xi_as, eta_as
