"""Tests for pxh.sky.coords: parsing, formatting and spherical geometry (offline).
"""

from __future__ import annotations

import numpy as np
import pytest

from pxh.sky.coords import (
    angular_separation_arcsec,
    format_dec_dms,
    format_ra_hms,
    parse_coordinates,
    tangent_plane_offsets_arcsec,
)

BARNARD_SEXA = (269.452083333333, 4.693333333333)  # 17 57 48.5 +04 41 36
WISE0855_CHALLENGE = (133.795129166667, -7.245147222222)  # 08h55m10.831s -7d14m42.53s

TOL_DEG = 1e-9


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("269.452 4.693", (269.452, 4.693)),
        ("269.452, +4.693", (269.452, 4.693)),
        ("269.452d -7.2d", (269.452, -7.2)),
        ("269.452 deg -7.2 deg", (269.452, -7.2)),
        ("269.452+4.693", (269.452, 4.693)),
        ("  10.5 ,  -20.25  ", (10.5, -20.25)),
        ("17 57 48.5 +04 41 36", BARNARD_SEXA),
        ("17:57:48.5 +04:41:36", BARNARD_SEXA),
        ("17:57:48.5+04:41:36", BARNARD_SEXA),
        ("17h57m48.5s +4d41m36s", BARNARD_SEXA),
        ("17h57m48.5s4d41m36s", BARNARD_SEXA),
        ("17H57M48.5S +4D41M36S", BARNARD_SEXA),
        ("17 57 48.5 04 41 36", BARNARD_SEXA),
        ("17:57:48.5 04:41:36", BARNARD_SEXA),
        ("17:57:48.5, 04:41:36", BARNARD_SEXA),
        ("17h57m48.5s, +4°41′36″", BARNARD_SEXA),
        ("17h 57m 48.5s +04° 41' 36''", BARNARD_SEXA),
        ("17h57m48.5s +04d41'36\"", BARNARD_SEXA),
        ("08h55m10.831s -7d14m42.53s", WISE0855_CHALLENGE),
        ("08 55 10.831 −07 14 42.53", WISE0855_CHALLENGE),  # Unicode minus sign
        ("08 55 10.831 –07 14 42.53", WISE0855_CHALLENGE),  # en dash
        ("17 57.8 +4 41.6", (269.45, 4.693333333333)),
        ("17.9635h +4.693d", (269.4525, 4.693)),
        ("0 0", (0.0, 0.0)),
        ("360 0", (0.0, 0.0)),
        ("24 00 00 +00 00 00", (0.0, 0.0)),
        ("0 90", (0.0, 90.0)),
        ("0 -90", (0.0, -90.0)),
    ],
)
def test_parse_valid(text: str, expected: tuple[float, float]) -> None:
    result = parse_coordinates(text)
    assert result is not None
    assert result[0] == pytest.approx(expected[0], abs=TOL_DEG)
    assert result[1] == pytest.approx(expected[1], abs=TOL_DEG)
    assert 0.0 <= result[0] < 360.0


@pytest.mark.parametrize("text", ["12 00 00 -00 30 00", "12 00 00 −00 30 00", "12:00:00 -00:30:00"])
def test_negative_zero_declination(text: str) -> None:
    assert parse_coordinates(text) == pytest.approx((180.0, -0.5))


@pytest.mark.parametrize(
    "text",
    [
        "",
        "   ",
        "42",
        "M 31",
        "m31",
        "Vega",
        "Barnard's Star",
        "WISE 0855-0714",
        "WISE J085510.83-071442.5",
        "W0855",
        "GJ 699",
        "HIP 87937",
        "hd 209100",
        "NGC 1068",
        "3C 273",
        "V2500 Oph",
        "eps Ind B",
        "ε Indi B",
        "RW Aur",
        "R Dra",
        "Gaia DR3 4472832130942575872",
        "17::57 4",
        ", 10 20",
        "10 20,",
        "269.452 - 4.693",
        "1e3 20",
    ],
)
def test_not_coordinates_returns_none(text: str) -> None:
    assert parse_coordinates(text) is None


@pytest.mark.parametrize(
    ("text", "match"),
    [
        ("400 10", "RA"),
        ("-10 20", "RA"),
        ("10 95", "Dec"),
        ("10 -90.5", "Dec"),
        ("25 00 00 +00 00 00", "RA"),
        ("12 60 00 +10 00 00", "minutes"),
        ("12 00 60 +10 00 00", "seconds"),
        ("12 00 00 +10 61 00", "minutes"),
        ("12 00 00 +90 30 00", "Dec"),
        ("17 57 48.5 04 41", "cannot tell RA from Dec"),
        ("1 2 3", "cannot tell RA from Dec"),
        ("1, 2, 3", "comma"),
        ("12.5 30 +10", "fractional"),
        ("12 00 00 +10 -30 00", "sign"),
        ("17h 57m 48.5s", "2 coordinates"),
        ("10 20h", "Dec cannot start"),
        ("1H 0323+342", "minutes"),
    ],
)
def test_coordinate_like_but_invalid_raises(text: str, match: str) -> None:
    with pytest.raises(ValueError, match=match):
        parse_coordinates(text)


def test_format_ra_hms() -> None:
    assert format_ra_hms(BARNARD_SEXA[0]) == "17h57m48.50s"
    assert format_ra_hms(BARNARD_SEXA[0], precision=1, sep=":") == "17:57:48.5"
    assert format_ra_hms(WISE0855_CHALLENGE[0], precision=3, sep=" ") == "08 55 10.831"
    assert format_ra_hms(0.0) == "00h00m00.00s"
    assert format_ra_hms(-15.0) == "23h00m00.00s"
    assert format_ra_hms(12.5, precision=0) == "00h50m00s"


def test_format_rounding_carries() -> None:
    # 59.999 s rounds up to the next minute/hour/day instead of printing 60.00.
    assert format_ra_hms(359.9999999) == "00h00m00.00s"
    assert format_ra_hms((1 + 59 / 60 + 59.9999 / 3600) * 15) == "02h00m00.00s"
    assert format_dec_dms(4 + 59 / 60 + 59.99 / 3600) == "+05d00m00.0s"


def test_format_dec_dms() -> None:
    assert format_dec_dms(BARNARD_SEXA[1]) == "+04d41m36.0s"
    assert format_dec_dms(WISE0855_CHALLENGE[1], precision=2, sep=":") == "-07:14:42.53"
    assert format_dec_dms(-0.5) == "-00d30m00.0s"
    assert format_dec_dms(-1e-9) == "+00d00m00.0s"  # rounds to zero: no "-00"
    assert format_dec_dms(90.0) == "+90d00m00.0s"
    with pytest.raises(ValueError):
        format_dec_dms(90.5)
    with pytest.raises(ValueError):
        format_ra_hms(float("nan"))


@pytest.mark.parametrize(
    ("ra", "dec"),
    [(269.4460727, 4.7707237), (133.7577876, -7.2420245), (331.0984097, -56.8012581), (0.001, -89.99)],
)
def test_format_parse_roundtrip(ra: float, dec: float) -> None:
    text = f"{format_ra_hms(ra, precision=4)} {format_dec_dms(dec, precision=3)}"
    back = parse_coordinates(text)
    assert back is not None
    assert angular_separation_arcsec(ra, dec, *back) < 0.002


def test_angular_separation_known_values() -> None:
    assert angular_separation_arcsec(0.0, 0.0, 180.0, 0.0) == pytest.approx(648000.0)
    assert angular_separation_arcsec(10.0, 89.0, 190.0, 89.0) == pytest.approx(7200.0)
    assert angular_separation_arcsec(359.9, 0.0, 0.1, 0.0) == pytest.approx(720.0)
    # 1 mas separations stay accurate (Vincenty, not the cosine formula).
    assert angular_separation_arcsec(10.0, 10.0, 10.0, 10.0 + 1 / 3.6e6) == pytest.approx(0.001, rel=1e-6)
    assert isinstance(angular_separation_arcsec(1.0, 2.0, 3.0, 4.0), float)


def test_angular_separation_broadcasts() -> None:
    sep = angular_separation_arcsec(np.array([0.0, 1.0, 2.0]), 0.0, 0.0, 0.0)
    assert sep.shape == (3,)
    np.testing.assert_allclose(sep, [0.0, 3600.0, 7200.0], atol=1e-9)


def test_tangent_plane_offsets() -> None:
    xi, eta = tangent_plane_offsets_arcsec(10.001, 0.0, 10.0, 0.0)
    assert xi == pytest.approx(3.6, rel=1e-6)
    assert eta == pytest.approx(0.0, abs=1e-9)
    xi, eta = tangent_plane_offsets_arcsec(np.array([30.0, 30.0]), np.array([60.0, 60.001]), 30.0, 60.0)
    np.testing.assert_allclose(xi, [0.0, 0.0], atol=1e-9)
    np.testing.assert_allclose(eta, [0.0, 3.6], rtol=1e-6, atol=1e-9)
    # East is +xi: at Dec 60 an RA step of 0.002 deg is 0.002 * cos(60) deg on the sky.
    xi, _ = tangent_plane_offsets_arcsec(30.002, 60.0, 30.0, 60.0)
    assert xi == pytest.approx(3.6, rel=1e-5)
    with pytest.raises(ValueError):
        tangent_plane_offsets_arcsec(190.0, 0.0, 10.0, 0.0)
