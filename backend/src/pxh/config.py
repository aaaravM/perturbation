"""Static configuration: service endpoints, mirrors, instrument constants, flag groups, cache location.

Values marked "verified" were checked against live archives on 2026-11-14 during planning.
"""

from __future__ import annotations

import os
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
CACHE_DIR = Path(os.environ.get("PXH_CACHE_DIR", str(REPO_ROOT / "data" / "cache")))

# Generic client name: no personal details in requests to outside services.
USER_AGENT = "Perturbation/0.1 (NASA Space Apps 2026 project)"

# --- IRSA (verified) ----------------------------------------------------------------------------
IRSA_SIA_URL = "https://irsa.ipac.caltech.edu/SIA"
IRSA_IBE_SPHEREX_PREFIX = "https://irsa.ipac.caltech.edu/ibe/data/spherex/"
# Public AWS Open Data mirror; accepts single byte ranges only (multi-range returns the whole file).
SPHEREX_S3_PREFIX = "https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/"
IRSA_GATOR_URL = "https://irsa.ipac.caltech.edu/cgi-bin/Gator/nph-query"

SPHEREX_COLLECTION_PREFIX = "spherex_"
# Collections are discovered at run time (pxh.spherex.sia); these are fallbacks only, never the source of truth.
FALLBACK_L2_COLLECTIONS = ("spherex_dr1", "spherex_qr3", "spherex_dr1_deep", "spherex_qr3_deep")
FALLBACK_CUBE_COLLECTIONS = ("spherex_dr1_cube",)

# Request policy. SIA returned HTTP 502 on ~half of attempts during research but always recovered within
# 8 tries; IBE file serving never failed. The SIA TIME parameter always returned 502: never use it.
IRSA_MAX_CONCURRENCY = 4
RETRY_ATTEMPTS = 8
RETRY_WAIT_INITIAL_S = 2.0
RETRY_WAIT_MAX_S = 16.0
HTTP_TIMEOUT_S = 90.0
SIA_CACHE_TTL_S = 24 * 3600
IBE_MAX_RANGES_PER_REQUEST = 100  # >100 ranges: the server ignores Range and sends the whole file
IBE_MAX_RANGE_HEADER_BYTES = 7800  # Range header over ~8 KB returns HTTP 400

# --- Name resolution and catalogs (CDS Strasbourg degraded since ~2026-11-09: mirrors first) ------
SESAME_MIRRORS = (
    "https://vizier.cfa.harvard.edu/viz-bin/nph-sesame/-oxp/SNV?",
    "https://vizier.idia.ac.za/viz-bin/nph-sesame/-oxp/SNV?",
    "https://cds.unistra.fr/cgi-bin/nph-sesame/-oxp/SNV?",
)
SIMBAD_TAP_MIRRORS = (
    "https://simbad.cfa.harvard.edu/simbad/sim-tap/sync",
    "https://simbad.idia.ac.za/simbad/sim-tap/sync",
    "https://simbad.cds.unistra.fr/simbad/sim-tap/sync",
)
VIZIER_MIRRORS = ("https://vizier.cfa.harvard.edu", "https://vizier.idia.ac.za")

# --- Instrument (verified) ----------------------------------------------------------------------
PIXEL_SCALE_ARCSEC = 6.15
DETECTOR_NPIX = 2040
EXPTIME_S = 113.5826
# Each exposure images a position on one short- and one long-wavelength detector at the same time.
DETECTOR_PAIRS = {1: 4, 2: 5, 3: 6, 4: 1, 5: 2, 6: 3}
# Approximate ranges (um) and resolving power, for labels and sanity checks only. Authoritative values come
# from SIA em_min/em_max (per detector) and the per-pixel WCS-WAVE lookup (per position).
DETECTOR_BANDS_UM = {
    1: (0.75, 1.11),
    2: (1.11, 1.64),
    3: (1.63, 2.43),
    4: (2.42, 3.82),
    5: (3.82, 4.42),
    6: (4.41, 5.01),
}
DETECTOR_R = {1: 39, 2: 41, 3: 41, 4: 35, 5: 112, 6: 128}
CHANNELS_PER_DETECTOR = 17
# Year 2 (Surveys 3+4, QR3) begins 2026-05-14 ~12:30 UTC and is offset from Year 1 by half a channel.
# Measured boundary: the last DR1 exposure ends at MJD 61174.5017 (2026W20_1A_1247_1, spherex_dr1_deep) and the
# first QR3 exposure starts at 61174.5327. (61174.0 put DR1 exposures of 14 May into Year 2: WISE 0855 got a
# spurious one-exposure epoch.)
YEAR2_START_MJD = 61174.52
# Nonlinearity/saturation onset (AB mag) per Explanatory Supplement v2.1: brighter sources are saturated.
SATURATION_AB = {1: 11.5, 2: 11.5, 3: 11.5, 4: 11.3, 5: 10.2, 6: 9.75}

# --- Epoch grouping -----------------------------------------------------------------------------
EPOCH_GAP_DAYS = 20.0  # wide-survey epochs are 9-46 d long and ~6 months apart
FULL_EPOCH_MIN_PER_DETECTOR = 12

# --- FLAGS groups -------------------------------------------------------------------------------
# Names expected in each file's MSKN/MSKM/MSKD header keywords. pxh.spherex.flags resolves them to bit
# numbers per file (prefix match, so "GHOST" covers every GHOST* flag) and logs unknown names.
# Bit 29 SATELLITE_HALO is documented by IRSA but missing from DR1 MSKN keywords: keep a fallback.
FLAGS_INVALID = ("TRANSIENT", "SUR_ERROR", "NONFUNC", "MISSING_DATA", "HOT", "COLD", "PHANMISS", "NONLINEAR")
FLAGS_ARTIFACT = (
    "PERSIST", "CROSSTALK", "GHOST", "STREAK", "BLOOM", "SNOWBALL", "HALO", "SATELLITE_HALO", "OUTLIER",
)
FLAGS_SATURATION = ("OVERFLOW",)
# Informational: SOURCE marks known stars/asteroids and covers 76-95% of pixels in crowded fields.
FLAGS_INFO = ("SOURCE", "FULLSAMPLE")
SATELLITE_HALO_FALLBACK_BIT = 29
