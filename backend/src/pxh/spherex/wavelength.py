"""Per-pixel wavelength and bandwidth of a SPHEREx Level-2 image from its WCS-WAVE lookup table.

The IMAGE header carries an alternate WCS 'W' (FITS Paper III -TAB): CTYPE1W = CTYPE2W = 'WAVE-TAB',
PSi_0W = 'WCS-WAVE' (table extension), PSi_1W = 'VALUES' (coordinate array), PS1_2W = 'X' and PS2_2W = 'Y'
(index vectors: control points in raw 1-based detector pixels), PV1_3W = 1 / PV2_3W = 2 (wavelength and
bandwidth elements of VALUES), and CRPIXjW = CDELTjW = CRVALjW = 1 ("lookup table is in raw FITS
coordinates"; IRSA cutouts shift CRPIXjW). For pixel p (1-based) the raw coordinate is
psi_j = CRVALjW + CDELTjW * (p_j - CRPIXjW); the value is the bilinear interpolation of VALUES at the fractional
indices of psi in the X and Y index vectors. Grids differ per detector (9x9 up to 13x20, with 1-pixel steps
at the dichroic edges of D3/D4).

Verified: the lookup reproduces the wavelengths of 358 Barnard's Star exposures (all six detectors, DR1 and
QR3) to < 2e-4 of a bandwidth, and astropy's -TAB evaluation of key 'W' to 1e-13 (tests/test_wavelength.py).

Pitfall: astropy applies the IMAGE header's celestial SIP polynomials (A_*, B_*) to *any* WCS built from that
header, including key 'W', and evaluates them about CRPIXjW = 1 instead of the celestial CRPIX. That corrupts
the wavelengths by up to ~0.4 bandwidth near the far detector corner (measured on D6). Remove the SIP
keywords before using astropy's -TAB.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

import numpy as np

if TYPE_CHECKING:
    from astropy.io.fits import Header

    from pxh.models import DetectorImage

log = logging.getLogger(__name__)


class WaveLookupError(ValueError):
    """The WCS-WAVE table or the 'W' keywords are missing or malformed."""


@dataclass(frozen=True, eq=False)  # eq=False: identity semantics (fields are numpy arrays)
class WaveLookup:
    """Bilinear (wavelength, bandwidth) lookup over detector pixels; `at` takes 0-based pixel coordinates."""

    x_ctrl: np.ndarray  # index vector for pixel axis 1 (raw 1-based coordinates), strictly increasing
    y_ctrl: np.ndarray  # index vector for pixel axis 2
    wavelength: np.ndarray  # [len(y_ctrl), len(x_ctrl)] um
    bandwidth: np.ndarray  # [len(y_ctrl), len(x_ctrl)] um
    crpix: tuple[float, float] = (1.0, 1.0)
    cdelt: tuple[float, float] = (1.0, 1.0)
    crval: tuple[float, float] = (1.0, 1.0)
    detector: int | None = None
    source: str = ""  # calibration file named in the table header, e.g. "spectral_wcs_6_v3.0.fits"

    def raw_coords(self, x: Any, y: Any) -> tuple[np.ndarray, np.ndarray]:
        """Raw lookup coordinates (psi) of 0-based pixel coordinates of the image whose header was used."""
        x = np.asarray(x, dtype=float)
        y = np.asarray(y, dtype=float)
        r1 = self.crval[0] + self.cdelt[0] * (x + 1.0 - self.crpix[0])
        r2 = self.crval[1] + self.cdelt[1] * (y + 1.0 - self.crpix[1])
        return r1, r2

    def at(self, x: Any, y: Any) -> tuple[np.ndarray | float, np.ndarray | float]:
        """(wavelength_um, bandwidth_um) at 0-based pixel (x, y); vectorised, broadcasting x against y.

        Points outside the control-point range take the edge values (the range covers the whole detector).
        """
        r1, r2 = self.raw_coords(x, y)
        r1, r2 = np.broadcast_arrays(r1, r2)
        fx = _fractional_index(self.x_ctrl, r1)
        fy = _fractional_index(self.y_ctrl, r2)
        lam = _bilinear(self.wavelength, fx, fy)
        bw = _bilinear(self.bandwidth, fx, fy)
        if lam.ndim == 0:
            return float(lam), float(bw)
        return lam, bw

    def grid(self, x0: int, y0: int, nx: int, ny: int) -> tuple[np.ndarray, np.ndarray]:
        """Wavelength and bandwidth maps [ny, nx] for the pixel box starting at 0-based (x0, y0)."""
        xx = np.arange(x0, x0 + nx, dtype=float)[None, :]
        yy = np.arange(y0, y0 + ny, dtype=float)[:, None]
        lam, bw = self.at(xx, yy)
        return np.asarray(lam, dtype=np.float64), np.asarray(bw, dtype=np.float64)

    # --- construction -------------------------------------------------------------------------------------

    @classmethod
    def from_table(
        cls,
        table_header: Header,
        row: Any,
        image_header: Header | None = None,
    ) -> WaveLookup:
        """Build from the WCS-WAVE table header and its single row (astropy FITS_record or mapping).

        Column names and element indices come from the 'W' keywords of `image_header` when given
        (PS1_1W, PS1_2W, PS2_2W, PV1_3W, PV2_3W), else from the SPHEREx defaults.
        """
        ih = image_header if image_header is not None else {}
        values_col = str(ih.get("PS1_1W", "VALUES")).strip()
        bw_values_col = str(ih.get("PS2_1W", values_col)).strip()
        xcol = str(ih.get("PS1_2W", "X")).strip()
        ycol = str(ih.get("PS2_2W", "Y")).strip()
        m_lam = int(ih.get("PV1_3W", 1))
        m_bw = int(ih.get("PV2_3W", 2))
        if bw_values_col != values_col:
            raise WaveLookupError("wavelength and bandwidth in different columns are not supported")
        for key in ("PC1_2W", "PC2_1W"):
            if float(ih.get(key, 0.0)) != 0.0:
                raise WaveLookupError(f"non-diagonal {key} is not supported")
        x_ctrl = np.asarray(row[xcol], dtype=float).ravel()
        y_ctrl = np.asarray(row[ycol], dtype=float).ravel()
        values = np.asarray(row[values_col], dtype=np.float64)
        # astropy applies TDIM (M, K1, K2) -> numpy shape (K2, K1, M): [y index, x index, element]
        expected = (y_ctrl.size, x_ctrl.size, 2)
        if values.shape != expected:
            if values.size == np.prod(expected):
                values = values.reshape(expected)
            else:
                raise WaveLookupError(f"VALUES shape {values.shape} does not match X/Y ({expected})")
        if m_lam == 2 and m_bw == 1:  # coordinate-array axes swapped relative to pixel axes
            raise WaveLookupError("PV1_3W=2/PV2_3W=1 (transposed table) is not supported")
        if (m_lam, m_bw) != (1, 2):
            raise WaveLookupError(f"unexpected PV1_3W/PV2_3W = {m_lam}/{m_bw}")
        for ctrl, name in ((x_ctrl, xcol), (y_ctrl, ycol)):
            if ctrl.size > 1 and np.any(np.diff(ctrl) <= 0):
                raise WaveLookupError(f"index vector {name} is not strictly increasing")
        pc1 = float(ih.get("PC1_1W", 1.0))
        pc2 = float(ih.get("PC2_2W", 1.0))
        det = table_header.get("DETECTOR", ih.get("DETECTOR"))
        try:
            detector = int(str(det).strip()) if det is not None else None
        except ValueError:
            detector = None
        return cls(
            x_ctrl=x_ctrl,
            y_ctrl=y_ctrl,
            wavelength=np.ascontiguousarray(values[:, :, m_lam - 1]),
            bandwidth=np.ascontiguousarray(values[:, :, m_bw - 1]),
            crpix=(float(ih.get("CRPIX1W", 1.0)), float(ih.get("CRPIX2W", 1.0))),
            cdelt=(float(ih.get("CDELT1W", 1.0)) * pc1, float(ih.get("CDELT2W", 1.0)) * pc2),
            crval=(float(ih.get("CRVAL1W", 1.0)), float(ih.get("CRVAL2W", 1.0))),
            detector=detector,
            source=calibration_source(table_header),
        )

    @classmethod
    def from_hdu_bytes(cls, hdu_bytes: bytes, image_header: Header | None = None) -> WaveLookup:
        """Build from the raw bytes of a complete WCS-WAVE extension (header + data)."""
        from pxh.spherex import l2  # local import: l2 imports this module

        hdu = l2.table_hdu_from_bytes(hdu_bytes)
        return cls.from_table(hdu.header, hdu.data[0], image_header)

    def to_json(self) -> dict[str, Any]:
        return {
            "x_ctrl": self.x_ctrl.tolist(),
            "y_ctrl": self.y_ctrl.tolist(),
            "wavelength": self.wavelength.tolist(),
            "bandwidth": self.bandwidth.tolist(),
            "crpix": list(self.crpix),
            "cdelt": list(self.cdelt),
            "crval": list(self.crval),
            "detector": self.detector,
            "source": self.source,
        }

    @classmethod
    def from_json(cls, d: dict[str, Any]) -> WaveLookup:
        return cls(
            x_ctrl=np.asarray(d["x_ctrl"], dtype=float),
            y_ctrl=np.asarray(d["y_ctrl"], dtype=float),
            wavelength=np.asarray(d["wavelength"], dtype=np.float64),
            bandwidth=np.asarray(d["bandwidth"], dtype=np.float64),
            crpix=tuple(d["crpix"]),
            cdelt=tuple(d["cdelt"]),
            crval=tuple(d["crval"]),
            detector=d.get("detector"),
            source=d.get("source", ""),
        )


def calibration_source(header: Any) -> str:
    """File named by a 'HISTORY Calibration source file: <name>' card ('' if none)."""
    hist = header.get("HISTORY", []) if hasattr(header, "get") else []
    for line in hist if not isinstance(hist, str) else [hist]:
        text = str(line)
        if "Calibration source file:" in text:
            return text.split("Calibration source file:", 1)[1].strip()
    return ""


def _fractional_index(ctrl: np.ndarray, v: np.ndarray) -> np.ndarray:
    if ctrl.size == 1:
        return np.zeros_like(v, dtype=float)
    return np.interp(v, ctrl, np.arange(ctrl.size, dtype=float))


def _bilinear(grid: np.ndarray, fx: np.ndarray, fy: np.ndarray) -> np.ndarray:
    ny, nx = grid.shape
    i0 = np.clip(np.floor(fx).astype(int), 0, max(nx - 2, 0))
    j0 = np.clip(np.floor(fy).astype(int), 0, max(ny - 2, 0))
    i1 = np.minimum(i0 + 1, nx - 1)
    j1 = np.minimum(j0 + 1, ny - 1)
    tx = fx - i0 if nx > 1 else np.zeros_like(fx)
    ty = fy - j0 if ny > 1 else np.zeros_like(fy)
    return (
        grid[j0, i0] * (1 - tx) * (1 - ty)
        + grid[j0, i1] * tx * (1 - ty)
        + grid[j1, i0] * (1 - tx) * ty
        + grid[j1, i1] * tx * ty
    )


# --- remote access ----------------------------------------------------------------------------------------


def read_wavelength_lookup(image: DetectorImage, *, source: str = "ibe") -> WaveLookup:
    """WaveLookup of a Level-2 file.

    Uses the cached file layout when present; otherwise one request reads the IMAGE header (bytes 0-40959)
    and the WCS-WAVE extension (suffix range: it is the last HDU) and caches the result on disk.
    """
    from pxh.spherex import l2  # local import: l2 imports this module

    return l2.read_wave_lookup(image, source=source)


def wavelength_at_radec(
    image: DetectorImage, ra_deg: float, dec_deg: float, *, source: str = "ibe"
) -> tuple[float, float, float, float]:
    """(wavelength_um, bandwidth_um, x, y) at a sky position (x, y: 0-based full-frame pixel, TAN-SIP WCS)."""
    from pxh.spherex import l2  # local import: l2 imports this module

    header, lookup = l2.read_header_and_wave(image, source=source)
    x, y = l2.world_to_pixel(header, ra_deg, dec_deg)
    lam, bw = lookup.at(x, y)
    return float(lam), float(bw), float(x), float(y)
