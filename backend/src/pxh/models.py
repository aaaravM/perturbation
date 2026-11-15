"""Shared data types exchanged by every backend module.

Conventions:
- Angles in degrees (ICRS). Proper motions in mas/yr, with pmra = mu_alpha* (already multiplied by cos dec).
- Times are MJD (UTC) floats. Catalog reference epochs are Julian years (e.g. 2016.0).
- Pixel coordinates are 0-based and arrays are numpy [y, x], unless a name says otherwise.
- Wavelengths are in micrometres. Surface brightness is MJy/sr, as in SPHEREx Level-2 IMAGE.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

import numpy as np

if TYPE_CHECKING:
    from astropy.io.fits import Header
    from astropy.wcs import WCS


@dataclass(frozen=True)
class Astrometry:
    """Catalog astrometry at a reference epoch."""

    ra_deg: float
    dec_deg: float
    ref_epoch: float  # Julian year
    pmra_masyr: float = 0.0
    pmdec_masyr: float = 0.0
    parallax_mas: float | None = None
    rv_kms: float | None = None
    source: str = ""  # provenance, e.g. "Gaia DR3 4472832130942575872"


@dataclass(frozen=True)
class Target:
    """A named object the app knows about (the five required test targets and friends)."""

    key: str  # URL slug, e.g. "barnards-star"
    name: str  # display name
    aliases: tuple[str, ...]
    astrometry: Astrometry
    kind: str  # "high-pm-star" | "brown-dwarf" | "young-variable" | "mira-variable" | "bright-star"
    simbad_id: str = ""
    notes: str = ""


@dataclass(frozen=True)
class ResolvedName:
    """Result of resolving a user's query (name or coordinates)."""

    query: str
    name: str
    astrometry: Astrometry
    resolver: str  # "local-table" | "sesame:<mirror>" | "simbad:<mirror>" | "coordinates"
    target_key: str | None = None


@dataclass(frozen=True)
class DetectorImage:
    """One SPHEREx Level-2 detector image: one row of an IRSA SIA result."""

    obs_id: str  # e.g. "2025W33_2C_0321_1"; shared by the 1-2 detector images of one exposure
    detector: int  # 1..6
    collection: str  # e.g. "spherex_dr1"
    publisher_did: str  # e.g. "ivo://irsa.ipac/spherex_dr1?2025W33_2C_0321_1/D6"
    access_url: str  # IRSA IBE https URL of the full 65 MB file
    t_min_mjd: float
    t_max_mjd: float
    em_min_um: float
    em_max_um: float
    exptime_s: float
    s_region: str  # ICRS footprint polygon, as returned by SIA
    release_date: str  # obs_release_date (ISO)
    file_tag: str  # pipeline/processing tag parsed from the file name, e.g. "l2b-v27-2026-228"
    est_size_kb: int | None = None
    s3_key: str | None = None  # key in the public nasa-irsa-spherex bucket, if given by cloud_access

    @property
    def t_mid_mjd(self) -> float:
        return 0.5 * (self.t_min_mjd + self.t_max_mjd)

    @property
    def basename(self) -> str:
        return self.access_url.rsplit("/", 1)[-1]

    @property
    def cache_key(self) -> str:
        """Stable cache key: file name (encodes obs_id, detector and processing tag) + collection."""
        return f"{self.collection}/{self.basename}"


@dataclass
class Exposure:
    """One 113.6 s exposure: the 1-2 detector images (a short/long-wavelength pair) sharing obs_id."""

    obs_id: str
    t_min_mjd: float
    t_max_mjd: float
    images: list[DetectorImage]

    @property
    def detectors(self) -> list[int]:
        return sorted(im.detector for im in self.images)


@dataclass
class Epoch:
    """A survey window: exposures of one position separated from the next window by > EPOCH_GAP_DAYS."""

    index: int
    t_start_mjd: float
    t_end_mjd: float
    exposures: list[Exposure]
    detector_counts: dict[int, int]
    full: bool  # every detector of each sampled pair has >= FULL_EPOCH_MIN_PER_DETECTOR images
    survey_year: int | None = None  # 1 (DR1, Surveys 1+2) or 2 (QR3, Surveys 3+4)

    @property
    def t_mid_mjd(self) -> float:
        return 0.5 * (self.t_start_mjd + self.t_end_mjd)


@dataclass
class EPSFGrid:
    """Effective PSFs from a Level-2 EPSF extension (a grid of zones over the detector)."""

    xcenter: np.ndarray  # [nzone] detector x (0-based) of each zone centre
    ycenter: np.ndarray  # [nzone]
    psfs: np.ndarray  # [nzone, 33, 33] oversampled ePSFs, each summing to 1.0
    oversampling: int = 5
    cwave_um: np.ndarray | None = None  # [nzone] central wavelength per zone, if present

    def nearest(self, x: float, y: float) -> np.ndarray:
        k = int(np.argmin((self.xcenter - x) ** 2 + (self.ycenter - y) ** 2))
        return self.psfs[k]


@dataclass
class Stamp:
    """A pixel box read from one detector image around a sky position."""

    image: DetectorImage
    x0: int  # 0-based column of stamp pixel [0, 0] in the full 2040x2040 frame
    y0: int  # 0-based row
    data: np.ndarray  # IMAGE, MJy/sr, float32 [ny, nx]
    variance: np.ndarray | None
    zodi: np.ndarray | None
    flags: np.ndarray | None  # int32 bitmask
    wcs: WCS  # celestial WCS of the stamp (full-frame TAN-SIP shifted by x0, y0)
    header: Header  # full IMAGE header of the parent file
    mjd_avg: float
    wavelength_um: np.ndarray | None = None  # per-pixel central wavelength over the stamp
    bandwidth_um: np.ndarray | None = None
    flag_bits: dict[str, int] = field(default_factory=dict)  # flag name -> bit number for this file


@dataclass
class Frame:
    """An image on a shared sky grid: a reprojected exposure, an epoch co-add, or a difference."""

    data: np.ndarray  # float32 on the grid (MJy/sr, or S/N for normalised differences)
    weight: np.ndarray  # inverse-variance weight; 0 where masked or uncovered
    wcs: WCS
    mjd_mid: float
    n_inputs: int
    label: str
    detector: int | None = None
    epoch_index: int | None = None
    wavelength_um: float | None = None  # representative wavelength at the grid centre, if meaningful
    meta: dict[str, Any] = field(default_factory=dict)


@dataclass
class PhotPoint:
    """One forced-photometry measurement at a sky position in one detector image."""

    obs_id: str
    detector: int
    mjd: float
    wavelength_um: float
    bandwidth_um: float
    flux_ujy: float
    flux_err_ujy: float
    x: float  # measured or forced position in full-frame pixels (0-based)
    y: float
    flags: int  # OR of flag bits inside the photometry aperture
    saturated: bool
    method: str  # "epsf" | "aperture" | "wing-fit"
    collection: str = ""
    epoch_index: int | None = None
