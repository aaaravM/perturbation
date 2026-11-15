"""Group SPHEREx detector images into exposures, survey-window epochs and short visits.

- ``group_exposures``: the 1-2 detector images sharing an obs_id (one short/long-wavelength pair: D1+D4,
  D2+D5 or D3+D6) form one 113.6 s exposure.
- ``group_epochs``: exposures separated by more than ``gap_days`` start a new epoch. Wide-survey positions
  are seen in windows 9-46 d long, ~6 months apart; small clusters 20-25 d after a main window are real and
  become their own (partial) epochs (Barnard's Star: 3 full + 3 partial). Epochs never straddle
  ``config.YEAR2_START_MJD``, so each has one survey year. Deep fields at the ecliptic poles are observed
  continuously: pass ``max_span_days`` to cut them into bins.
- ``full``: every detector of each sampled pair (any pair with at least one image) has at least
  ``config.FULL_EPOCH_MIN_PER_DETECTOR`` images. A full wide-survey epoch has ~17-20 per detector.
- ``group_visits``: bursts of consecutive exposures (gaps <= 15 min) within a list of exposures.
- ``summarize``: JSON-able per-epoch summary (ISO dates, counts per detector, visits, full flag).

Epoch.index is 0-based, in time order.
"""

from __future__ import annotations

import logging
import re
from collections import Counter, defaultdict
from collections.abc import Iterable, Sequence
from datetime import UTC, datetime, timedelta
from typing import Any

from pxh import config
from pxh.models import DetectorImage, Epoch, Exposure

__all__ = [
    "DEFAULT_VISIT_GAP_MINUTES",
    "detector_counts",
    "group_epochs",
    "group_exposures",
    "group_visits",
    "is_full",
    "is_valid_pair",
    "mjd_to_iso",
    "sampled_pairs",
    "summarize",
    "survey_year",
]

log = logging.getLogger(__name__)

DEFAULT_VISIT_GAP_MINUTES = 15.0
DETECTORS = tuple(sorted(config.DETECTOR_PAIRS))
_MJD_ZERO = datetime(1858, 11, 17, tzinfo=UTC)
_TAG_VERSION_RE = re.compile(r"v(\d+)-(\d{4})-(\d{3})$")


# --- Small helpers --------------------------------------------------------------------------------


def mjd_to_iso(mjd: float) -> str:
    """UTC ISO-8601 timestamp (seconds precision) for an MJD, e.g. '2025-08-14T20:45:11Z'."""
    return (_MJD_ZERO + timedelta(days=float(mjd))).strftime("%Y-%m-%dT%H:%M:%SZ")


def survey_year(mjd: float) -> int:
    """1 (Surveys 1+2, DR1) before config.YEAR2_START_MJD, else 2 (Surveys 3+4, QR3)."""
    return 1 if mjd < config.YEAR2_START_MJD else 2


def is_valid_pair(detectors: Sequence[int]) -> bool:
    """True for one detector or a simultaneous pair (D1+D4, D2+D5, D3+D6)."""
    dets = sorted(detectors)
    if len(dets) == 1:
        return dets[0] in config.DETECTOR_PAIRS
    return len(dets) == 2 and config.DETECTOR_PAIRS.get(dets[0]) == dets[1]


def detector_counts(exposures: Iterable[Exposure]) -> dict[int, int]:
    """Number of images per detector, with every detector 1-6 present (0 when absent)."""
    counts = Counter(image.detector for exposure in exposures for image in exposure.images)
    return {det: counts.get(det, 0) for det in DETECTORS}


def sampled_pairs(counts: dict[int, int]) -> list[tuple[int, int]]:
    """Detector pairs with at least one image, e.g. [(1, 4), (3, 6)]."""
    pairs = {
        (min(det, config.DETECTOR_PAIRS[det]), max(det, config.DETECTOR_PAIRS[det]))
        for det, n in counts.items()
        if n > 0 and det in config.DETECTOR_PAIRS
    }
    return sorted(pairs)


def is_full(counts: dict[int, int], min_per_detector: int = config.FULL_EPOCH_MIN_PER_DETECTOR) -> bool:
    """Every detector of each sampled pair has >= min_per_detector images (False when nothing is sampled)."""
    pairs = sampled_pairs(counts)
    return bool(pairs) and all(
        counts.get(a, 0) >= min_per_detector and counts.get(b, 0) >= min_per_detector for a, b in pairs
    )


def _version_key(image: DetectorImage) -> tuple[int, int, int, str, str]:
    """Order duplicate files by processing version and date, e.g. 'l2b_retry-v27-2026-230'."""
    match = _TAG_VERSION_RE.search(image.file_tag)
    version = tuple(int(g) for g in match.groups()) if match else (-1, -1, -1)
    return (*version, image.release_date, image.file_tag)


# --- Exposures ------------------------------------------------------------------------------------


def group_exposures(images: Iterable[DetectorImage]) -> list[Exposure]:
    """Group detector images by obs_id into exposures, sorted by (t_min, obs_id).

    Two files for the same obs_id and detector (a reprocessing) are reduced to the newest processing tag.
    Unexpected detector combinations are kept but logged.
    """
    by_obs: dict[str, dict[int, DetectorImage]] = defaultdict(dict)
    for image in images:
        slot = by_obs[image.obs_id]
        previous = slot.get(image.detector)
        if previous is None:
            slot[image.detector] = image
        elif previous.publisher_did != image.publisher_did:
            keep = max(previous, image, key=_version_key)
            log.warning(
                "obs_id %s has two D%d files (%s, %s); keeping %s",
                image.obs_id, image.detector, previous.basename, image.basename, keep.basename,
            )
            slot[image.detector] = keep
    exposures = [_make_exposure(obs_id, list(dets.values())) for obs_id, dets in by_obs.items()]
    exposures.sort(key=lambda e: (e.t_min_mjd, e.obs_id))
    return exposures


def _make_exposure(obs_id: str, images: list[DetectorImage]) -> Exposure:
    images.sort(key=lambda im: im.detector)
    detectors = [im.detector for im in images]
    if not is_valid_pair(detectors):
        log.warning("obs_id %s has an unexpected detector combination %s", obs_id, detectors)
    return Exposure(
        obs_id=obs_id,
        t_min_mjd=min(im.t_min_mjd for im in images),
        t_max_mjd=max(im.t_max_mjd for im in images),
        images=images,
    )


# --- Epochs ---------------------------------------------------------------------------------------


def group_epochs(
    exposures: Iterable[Exposure],
    gap_days: float = config.EPOCH_GAP_DAYS,
    *,
    max_span_days: float | None = None,
    min_per_detector: int = config.FULL_EPOCH_MIN_PER_DETECTOR,
) -> list[Epoch]:
    """Split time-ordered exposures into epochs.

    A new epoch starts when an exposure begins more than ``gap_days`` after the previous one ended, when it
    falls in a different survey year, or (if ``max_span_days`` is set) when it begins more than
    ``max_span_days`` after the epoch started.
    """
    if gap_days <= 0:
        raise ValueError(f"gap_days must be > 0, got {gap_days}")
    if max_span_days is not None and max_span_days <= 0:
        raise ValueError(f"max_span_days must be > 0, got {max_span_days}")
    groups: list[list[Exposure]] = []
    current: list[Exposure] = []
    start = end = 0.0
    for exposure in sorted(exposures, key=lambda e: (e.t_min_mjd, e.obs_id)):
        t = exposure.t_min_mjd
        if current and (
            t - end > gap_days
            or survey_year(t) != survey_year(start)
            or (max_span_days is not None and t - start > max_span_days)
        ):
            groups.append(current)
            current = []
        if not current:
            start, end = t, exposure.t_max_mjd
        current.append(exposure)
        end = max(end, exposure.t_max_mjd)
    if current:
        groups.append(current)
    return [_make_epoch(index, group, min_per_detector) for index, group in enumerate(groups)]


def _make_epoch(index: int, exposures: list[Exposure], min_per_detector: int) -> Epoch:
    counts = detector_counts(exposures)
    t_start = min(e.t_min_mjd for e in exposures)
    return Epoch(
        index=index,
        t_start_mjd=t_start,
        t_end_mjd=max(e.t_max_mjd for e in exposures),
        exposures=exposures,
        detector_counts=counts,
        full=is_full(counts, min_per_detector),
        survey_year=survey_year(t_start),
    )


# --- Visits ---------------------------------------------------------------------------------------


def group_visits(
    exposures: Iterable[Exposure], gap_minutes: float = DEFAULT_VISIT_GAP_MINUTES
) -> list[list[Exposure]]:
    """Bursts of consecutive exposures: a new visit starts after a gap of more than ``gap_minutes``."""
    if gap_minutes <= 0:
        raise ValueError(f"gap_minutes must be > 0, got {gap_minutes}")
    gap_days = gap_minutes / 1440.0
    visits: list[list[Exposure]] = []
    end = 0.0
    for exposure in sorted(exposures, key=lambda e: (e.t_min_mjd, e.obs_id)):
        if not visits or exposure.t_min_mjd - end > gap_days:
            visits.append([])
            end = exposure.t_max_mjd
        visits[-1].append(exposure)
        end = max(end, exposure.t_max_mjd)
    return visits


# --- Summary --------------------------------------------------------------------------------------


def _epoch_summary(epoch: Epoch, visit_gap_minutes: float) -> dict[str, Any]:
    images = [image for exposure in epoch.exposures for image in exposure.images]
    return {
        "index": epoch.index,
        "start": mjd_to_iso(epoch.t_start_mjd),
        "end": mjd_to_iso(epoch.t_end_mjd),
        "mid": mjd_to_iso(epoch.t_mid_mjd),
        "start_mjd": round(epoch.t_start_mjd, 6),
        "end_mjd": round(epoch.t_end_mjd, 6),
        "span_days": round(epoch.t_end_mjd - epoch.t_start_mjd, 3),
        "survey_year": epoch.survey_year,
        "full": epoch.full,
        "n_exposures": len(epoch.exposures),
        "n_images": len(images),
        "n_visits": len(group_visits(epoch.exposures, visit_gap_minutes)),
        "detector_counts": {str(det): n for det, n in sorted(epoch.detector_counts.items())},
        "pairs": [f"D{a}+D{b}" for a, b in sampled_pairs(epoch.detector_counts)],
        "collections": dict(sorted(Counter(image.collection for image in images).items())),
    }


def summarize(epochs: Sequence[Epoch], *, visit_gap_minutes: float = DEFAULT_VISIT_GAP_MINUTES) -> dict[str, Any]:
    """JSON-able summary of epochs: overall counts and baseline, plus one entry per epoch."""
    per_epoch = [_epoch_summary(epoch, visit_gap_minutes) for epoch in epochs]
    if not epochs:
        return {"n_epochs": 0, "n_full": 0, "n_exposures": 0, "n_images": 0, "first": None, "last": None,
                "baseline_days": 0.0, "epochs": []}
    first = min(epoch.t_start_mjd for epoch in epochs)
    last = max(epoch.t_end_mjd for epoch in epochs)
    return {
        "n_epochs": len(epochs),
        "n_full": sum(1 for epoch in epochs if epoch.full),
        "n_exposures": sum(item["n_exposures"] for item in per_epoch),
        "n_images": sum(item["n_images"] for item in per_epoch),
        "first": mjd_to_iso(first),
        "last": mjd_to_iso(last),
        "baseline_days": round(last - first, 3),
        "epochs": per_epoch,
    }
