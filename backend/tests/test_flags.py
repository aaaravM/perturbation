"""Tests for pxh.spherex.flags against real FLAGS headers (DR1 Level-2 D6 file and the DR1 cube tile 7945).

Fixtures: l2_flags_header_dr1_D6.txt (FLAGS extension header of level2_2025W33_2C_0321_1D6, saved
2026-11-14) and cube_flags_header_7945.txt (FLAGS header of the DR1 cube tile Npix7945).
"""

from __future__ import annotations

import logging
from pathlib import Path

import numpy as np
import pytest
from astropy.io import fits

from pxh import config
from pxh.spherex import flags

FIXTURES = Path(__file__).parent / "fixtures"

# Every flag of a DR1 Level-2 file: (bit, name, description), from the MSKN/MSKM/MSKD keywords.
DR1_FLAGS = [
    (0, "TRANSIENT", "Transient detected during SUR"),
    (1, "OVERFLOW", "Overflow detected during SUR"),
    (2, "SUR_ERROR", "Error in onboard processing"),
    (6, "NONFUNC", "Permanently unusable"),
    (7, "DICHROIC", "Low efficiency due to dichroic"),
    (9, "MISSING_DATA", "Onboard data lost"),
    (10, "HOT", "Hot pixel"),
    (11, "COLD", "Anomalously low signal"),
    (12, "FULLSAMPLE", "Pixel full sample history is available"),
    (14, "PHANMISS", "Phantom correction was not applied"),
    (15, "NONLINEAR", "Nonlinearity correction cannot be applied reliably"),
    (17, "PERSIST", "Persistent charge above threshold"),
    (19, "OUTLIER", "Pixel flagged by Detect Outliers"),
    (20, "CROSSTALK", "Pixel affected by crosstalk."),
    (21, "SOURCE", "Pixel mapped to a known source"),
    (22, "GHOST", "Affected by a bright source inside the exposure"),
    (23, "GHOST_FPA", "Affected by a bright source on another detector"),
    (24, "GHOST_EXT", "Pixel affected by a bright source outside FOV"),
    (25, "STREAK", "Pixel affected by a streak"),
    (26, "BLOOM", "Pixel part of a bloom artifact"),
    (27, "SNOWBALL", "Pixel part of a snowball artifact"),
    (28, "HALO", "Pixel part of a transient halo"),
]


def _header(name: str) -> fits.Header:
    return fits.Header.fromstring((FIXTURES / name).read_text(), sep="\n")


@pytest.fixture(scope="module")
def dr1_header() -> fits.Header:
    return _header("l2_flags_header_dr1_D6.txt")


@pytest.fixture(scope="module")
def bits(dr1_header: fits.Header) -> dict[str, int]:
    return flags.flag_bits(dr1_header)


def test_flag_table_matches_every_dr1_flag(dr1_header: fits.Header) -> None:
    table = flags.flag_table(dr1_header)
    from_header = [(i.bit, i.name, i.description) for i in table if i.from_header]
    assert from_header == DR1_FLAGS
    # SATELLITE_HALO is documented by IRSA but absent from DR1 Level-2 headers: added at the fallback bit
    extra = [i for i in table if not i.from_header]
    assert [(i.bit, i.name) for i in extra] == [(config.SATELLITE_HALO_FALLBACK_BIT, "SATELLITE_HALO")]
    assert all(i.mask == 1 << i.bit for i in table)


def test_flag_bits_and_groups(bits: dict[str, int]) -> None:
    assert len(bits) == 23
    assert bits["OVERFLOW"] == 1 and bits["SOURCE"] == 21 and bits["SATELLITE_HALO"] == 29
    assert flags.group_of("GHOST_FPA") == "artifact"
    assert flags.group_of("NONLINEAR") == "invalid"
    assert flags.group_of("OVERFLOW") == "saturation"
    assert flags.group_of("SOURCE") == "info"
    assert flags.group_of("DICHROIC") == ""


def test_group_mask_uses_prefix_matching(bits: dict[str, int]) -> None:
    assert flags.group_mask(bits, ["GHOST"]) == (1 << 22) | (1 << 23) | (1 << 24)
    assert flags.group_mask(bits, ["HALO"]) == 1 << 28  # prefix match: HALO does not cover SATELLITE_HALO
    assert flags.group_mask(bits, ["NOSUCHFLAG"]) == 0


def test_standard_masks(bits: dict[str, int]) -> None:
    invalid = sum(1 << b for b in (0, 2, 6, 9, 10, 11, 14, 15))
    artifact = sum(1 << b for b in (17, 20, 22, 23, 24, 25, 26, 27, 28, 29, 19))
    assert flags.invalid_mask(bits) == invalid
    assert flags.artifact_mask(bits) == artifact
    assert flags.science_mask(bits) == invalid | artifact
    assert flags.science_mask(bits, include_saturation=True) == invalid | artifact | 1 << 1
    assert flags.saturation_mask(bits) == 1 << 1
    assert flags.info_mask(bits) == (1 << 21) | (1 << 12)
    assert flags.science_mask(bits) & (flags.info_mask(bits) | 1 << 7) == 0  # SOURCE/DICHROIC kept


def test_describe_and_good_pixels(bits: dict[str, int]) -> None:
    # FLAGS value of the DR1 cube at Barnard's Star (saturated core) and of a pixel with an undocumented bit
    assert flags.describe(67108869, bits) == ["TRANSIENT", "SUR_ERROR", "BLOOM"]
    assert flags.describe((1 << 21) | (1 << 3), bits) == ["BIT3", "SOURCE"]
    assert flags.describe(0, bits) == []
    arr = np.array([[0, 1 << 21, 1 << 1], [1 << 26, (1 << 21) | (1 << 12), 1 << 7]], dtype=np.int32)
    assert flags.good_pixels(arr, bits).tolist() == [[True, True, True], [False, True, True]]
    assert flags.good_pixels(arr, bits, flags.science_mask(bits, include_saturation=True))[0, 2] == np.False_


def test_fraction_by_flag(bits: dict[str, int]) -> None:
    arr = np.array([1 << 21, 1 << 21, (1 << 21) | 1, 0], dtype=np.int32)
    frac = flags.fraction_by_flag(arr, bits)
    assert list(frac)[:2] == ["TRANSIENT", "OVERFLOW"]  # bit order
    assert frac["SOURCE"] == 0.75 and frac["TRANSIENT"] == 0.25 and frac["HALO"] == 0.0
    assert np.isnan(flags.fraction_by_flag(np.array([], dtype=np.int32), bits)["SOURCE"])


def test_cube_header_documents_satellite_halo_without_masks() -> None:
    table = flags.flag_table(_header("cube_flags_header_7945.txt"))  # MSKN only, no MSKM/MSKD
    assert all(i.from_header for i in table)
    assert {i.name: i.bit for i in table}["SATELLITE_HALO"] == 29
    assert len(table) == 22  # FULLSAMPLE is not a cube flag


def test_inconsistent_mask_keywords(caplog: pytest.LogCaptureFixture) -> None:
    h = fits.Header()
    h["MSKN0003"] = "MOVED"
    h["MSKM0003"] = 1 << 5  # single bit that disagrees with the number: the mask wins
    h["MSKN0004"] = "BROKEN"
    h["MSKM0004"] = 3  # not a single bit: ignored
    with caplog.at_level(logging.WARNING, logger="pxh.spherex.flags"):
        bits = flags.flag_bits(h)
    assert bits == {"MOVED": 5, "SATELLITE_HALO": 29}
    assert len(caplog.records) == 2


def test_header_without_flags_gets_only_the_fallback() -> None:
    image_header = _header("l2_image_header_dr1_D6.txt")  # DR1 IMAGE headers carry no MSKN keywords
    assert flags.flag_bits(image_header) == {"SATELLITE_HALO": 29}
    assert flags.flag_bits({"MSKN0001": "OVERFLOW", "MSKM0001": 2}) == {"OVERFLOW": 1, "SATELLITE_HALO": 29}


def test_markdown_table_is_docs_ready(dr1_header: fits.Header) -> None:
    md = flags.markdown_table(dr1_header).splitlines()
    assert md[0] == "| Bit | Name | Group | Description |"
    assert len(md) == 2 + len(DR1_FLAGS) + 1
    assert md[2] == "| 0 | TRANSIENT | invalid | Transient detected during SUR |"
    assert md[-1].startswith("| 29 | SATELLITE_HALO | artifact |") and "IRSA documentation" in md[-1]
