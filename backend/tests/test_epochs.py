"""Tests for pxh.spherex.epochs on synthetic exposures: obs_id grouping, epoch gaps, full/partial, visits.
"""

from __future__ import annotations

import json
import logging

import pytest

from pxh import config
from pxh.models import DetectorImage, Exposure
from pxh.spherex import epochs as ep

EXP_DAYS = config.EXPTIME_S / 86400.0
PAIRS = ((1, 4), (2, 5), (3, 6))


def image(obs_id: str, det: int, t: float, *, collection: str = "spherex_dr1",
          tag: str = "l2b-v27-2026-228", release: str = "2026-10-04T05:45:39") -> DetectorImage:
    name = f"level2_{obs_id}D{det}_spx_{tag}.fits"
    return DetectorImage(
        obs_id=obs_id, detector=det, collection=collection,
        publisher_did=f"ivo://irsa.ipac/{collection}?{obs_id}/D{det}/{tag}",
        access_url=f"https://irsa.ipac.caltech.edu/ibe/data/spherex/dr1/level2/x/{tag}/{det}/{name}",
        t_min_mjd=t, t_max_mjd=t + EXP_DAYS, em_min_um=config.DETECTOR_BANDS_UM[det][0],
        em_max_um=config.DETECTOR_BANDS_UM[det][1], exptime_s=config.EXPTIME_S, s_region="",
        release_date=release, file_tag=tag, est_size_kb=64953, s3_key=None,
    )


def exposure(obs_id: str, t: float, dets: tuple[int, ...], **kwargs: str) -> Exposure:
    images = [image(obs_id, d, t, **kwargs) for d in dets]
    return Exposure(obs_id, t, t + EXP_DAYS, images)


def window(t0: float, per_pair: dict[tuple[int, int], int], prefix: str, step_days: float = 0.07) -> list[Exposure]:
    """One survey window: `n` exposures of each pair, one exposure every `step_days`."""
    out: list[Exposure] = []
    t = t0
    for pair, n in per_pair.items():
        for k in range(n):
            out.append(exposure(f"{prefix}_{pair[0]}{pair[1]}_{k:04d}_1", t, pair))
            t += step_days
    return out


FULL = {(1, 4): 18, (2, 5): 18, (3, 6): 18}


# --- Exposures ------------------------------------------------------------------------------------


def test_group_exposures_pairs_by_obs_id_sorted_in_time() -> None:
    images = [image("B", 2, 61000.5), image("A", 4, 61000.1), image("B", 5, 61000.5), image("A", 1, 61000.1),
              image("C", 3, 61000.3)]
    exposures = ep.group_exposures(images)
    assert [e.obs_id for e in exposures] == ["A", "C", "B"]
    assert [e.detectors for e in exposures] == [[1, 4], [3], [2, 5]]
    assert [im.detector for im in exposures[0].images] == [1, 4]


def test_group_exposures_uses_extreme_times_of_its_images() -> None:
    a, b = image("A", 1, 60948.585339), image("A", 4, 60948.58534)  # real 1e-6 d mismatch (2025W40_1A_0353_1)
    (exp,) = ep.group_exposures([b, a])
    assert exp.t_min_mjd == 60948.585339
    assert exp.t_max_mjd == pytest.approx(60948.58534 + EXP_DAYS)


def test_group_exposures_keeps_newest_duplicate(caplog: pytest.LogCaptureFixture) -> None:
    old = image("A", 6, 61000.0, tag="l2b-v27-2026-228")
    new = image("A", 6, 61000.0, tag="l2b_retry-v27-2026-230")
    with caplog.at_level(logging.WARNING, logger="pxh.spherex.epochs"):
        (exp,) = ep.group_exposures([new, old, image("A", 3, 61000.0), old])
    assert exp.detectors == [3, 6]
    assert next(im for im in exp.images if im.detector == 6).file_tag == "l2b_retry-v27-2026-230"
    assert "two D6 files" in caplog.text


def test_group_exposures_warns_on_unexpected_detectors(caplog: pytest.LogCaptureFixture) -> None:
    with caplog.at_level(logging.WARNING, logger="pxh.spherex.epochs"):
        (exp,) = ep.group_exposures([image("A", 1, 61000.0), image("A", 2, 61000.0)])
    assert exp.detectors == [1, 2]
    assert "unexpected detector combination" in caplog.text


@pytest.mark.parametrize(
    ("dets", "valid"),
    [([1], True), ([6], True), ([1, 4], True), ([5, 2], True), ([3, 6], True), ([1, 2], False),
     ([1, 4, 2], False), ([], False), ([7], False)],
)
def test_is_valid_pair(dets: list[int], valid: bool) -> None:
    assert ep.is_valid_pair(dets) is valid


# --- Epochs ---------------------------------------------------------------------------------------


def test_group_epochs_splits_on_gaps() -> None:
    gap = config.EPOCH_GAP_DAYS
    first = window(61000.0, FULL, "a")
    end = max(e.t_max_mjd for e in first)
    joined = exposure("near", end + gap - 0.01, (1, 4))  # just inside the gap: same epoch
    later = exposure("far", joined.t_max_mjd + gap + 0.01, (2, 5))  # just outside: new epoch
    epochs = ep.group_epochs(first + [later, joined])
    assert [len(e.exposures) for e in epochs] == [len(first) + 1, 1]
    assert [e.index for e in epochs] == [0, 1]
    assert epochs[0].t_start_mjd == 61000.0
    assert epochs[0].t_end_mjd == pytest.approx(joined.t_max_mjd)
    assert epochs[1].exposures[0].obs_id == "far"
    assert len(ep.group_epochs(first + [later, joined], gap_days=gap + 1.0)) == 1


def test_six_month_cadence_with_trailing_clusters() -> None:
    # Barnard's Star pattern: 3 main windows, each followed ~25 d later by a small single-pair cluster.
    exposures: list[Exposure] = []
    for i, t0 in enumerate((60902.9, 61110.1, 61268.6)):
        main = window(t0, FULL, f"m{i}", step_days=0.3)
        tail_start = max(e.t_max_mjd for e in main) + 25.0
        exposures += main + window(tail_start, {(1, 4): 5}, f"t{i}")
    epochs = ep.group_epochs(exposures)
    assert len(epochs) == 6
    assert [e.full for e in epochs] == [True, False, True, False, True, False]
    assert [e.survey_year for e in epochs] == [1, 1, 1, 1, 2, 2]
    assert epochs[0].detector_counts == {1: 18, 2: 18, 3: 18, 4: 18, 5: 18, 6: 18}
    assert epochs[1].detector_counts == {1: 5, 2: 0, 3: 0, 4: 5, 5: 0, 6: 0}


def test_full_requires_every_detector_of_each_sampled_pair() -> None:
    n = config.FULL_EPOCH_MIN_PER_DETECTOR
    assert ep.is_full({1: n, 4: n, 2: n, 5: n, 3: n, 6: n})
    assert not ep.is_full({1: n, 4: n, 2: n, 5: n, 3: n, 6: n - 1})
    assert ep.is_full({1: n, 4: n})  # one pair sampled, both detectors complete
    assert not ep.is_full({1: n, 4: 0})  # D4 missing although D1 was sampled
    assert not ep.is_full({})
    assert not ep.is_full({d: 0 for d in range(1, 7)})
    assert ep.is_full({1: 3, 4: 3}, min_per_detector=3)
    assert ep.sampled_pairs({1: 2, 4: 2, 6: 1, 2: 0}) == [(1, 4), (3, 6)]


def test_epoch_full_flag_from_counts() -> None:
    n = config.FULL_EPOCH_MIN_PER_DETECTOR
    partial = window(61000.0, {(1, 4): n, (2, 5): n, (3, 6): n - 1}, "p")
    (epoch,) = ep.group_epochs(partial)
    assert not epoch.full and epoch.detector_counts[6] == n - 1
    single = window(61000.0, {(1, 4): 1}, "s") + [exposure("lone", 61000.2, (4,))]
    (epoch,) = ep.group_epochs(single, min_per_detector=1)
    assert epoch.full and epoch.detector_counts[4] == 2 and epoch.detector_counts[1] == 1


def test_survey_year_and_split_at_year_boundary() -> None:
    boundary = config.YEAR2_START_MJD
    assert ep.survey_year(boundary - 0.01) == 1 and ep.survey_year(boundary) == 2
    straddle = window(boundary - 1.0, {(1, 4): 10, (2, 5): 10, (3, 6): 10}, "y")  # 2.1 d long, no gap
    epochs = ep.group_epochs(straddle)
    assert len(epochs) == 2
    assert [e.survey_year for e in epochs] == [1, 2]
    assert epochs[0].t_start_mjd < boundary <= epochs[1].t_start_mjd
    assert sum(len(e.exposures) for e in epochs) == 30


def test_max_span_days_bins_continuous_deep_field_coverage() -> None:
    daily = [exposure(f"d{k:03d}", 60800.0 + k, (1, 4)) for k in range(90)]  # one exposure per day
    assert len(ep.group_epochs(daily)) == 1
    binned = ep.group_epochs(daily, max_span_days=30.0)
    assert [len(e.exposures) for e in binned] == [31, 31, 28]
    with pytest.raises(ValueError):
        ep.group_epochs(daily, max_span_days=0)
    with pytest.raises(ValueError):
        ep.group_epochs(daily, gap_days=0)


def test_group_epochs_empty_input() -> None:
    assert ep.group_epochs([]) == []
    assert ep.summarize([])["n_epochs"] == 0


# --- Visits ---------------------------------------------------------------------------------------


def test_group_visits_splits_bursts() -> None:
    minute = 1.0 / 1440.0
    burst1 = [exposure(f"a{k}", 61000.0 + k * 2.1 * minute, (2, 5)) for k in range(4)]
    burst2_start = burst1[-1].t_max_mjd + 16 * minute  # gap > 15 min
    burst2 = [exposure(f"b{k}", burst2_start + k * 2.1 * minute, (2, 5)) for k in range(3)]
    joined = exposure("c0", burst2[-1].t_max_mjd + 14 * minute, (3, 6))  # gap < 15 min
    visits = ep.group_visits(burst2 + burst1 + [joined])
    assert [len(v) for v in visits] == [4, 4]
    assert [e.obs_id for e in visits[1]] == ["b0", "b1", "b2", "c0"]
    assert [len(v) for v in ep.group_visits(burst1 + burst2, gap_minutes=20.0)] == [7]
    assert ep.group_visits([]) == []
    with pytest.raises(ValueError):
        ep.group_visits(burst1, gap_minutes=0)


# --- Summary --------------------------------------------------------------------------------------


def test_summarize_is_json_ready() -> None:
    burst = 2.1 / 1440.0  # one exposure every 2.1 min, as within a real visit
    exposures = window(60902.864715, FULL, "m", step_days=0.3) + window(61110.0, {(3, 6): 4}, "t", burst)
    epochs = ep.group_epochs(exposures)
    summary = ep.summarize(epochs)
    assert json.loads(json.dumps(summary)) == summary
    assert summary["n_epochs"] == 2 and summary["n_full"] == 1
    assert summary["n_exposures"] == 58 and summary["n_images"] == 116
    first = summary["epochs"][0]
    assert first["start"] == "2025-08-15T20:45:11Z"
    assert first["detector_counts"] == {str(d): 18 for d in range(1, 7)}
    assert first["pairs"] == ["D1+D4", "D2+D5", "D3+D6"]
    assert first["full"] is True and first["survey_year"] == 1
    assert first["n_visits"] == 54  # exposures 0.3 d apart: every exposure is its own visit
    assert first["collections"] == {"spherex_dr1": 108}
    second = summary["epochs"][1]
    assert second["pairs"] == ["D3+D6"] and second["full"] is False and second["n_visits"] == 1
    assert summary["baseline_days"] == pytest.approx(epochs[-1].t_end_mjd - 60902.864715, abs=1e-3)


def test_mjd_to_iso() -> None:
    assert ep.mjd_to_iso(51544.5) == "2000-01-01T12:00:00Z"
    assert ep.mjd_to_iso(61174.0) == "2026-05-14T00:00:00Z"


def test_year_boundary_matches_the_release_boundary_in_the_data() -> None:
    # Last DR1 exposure (2026W20_1A_1247_1, dr1_deep) ends at 61174.5017; the first QR3 one starts at 61174.5327.
    assert ep.survey_year(61174.2872) == 1  # 2026W20_1A_1166_1, the last spherex_dr1 exposure of WISE 0855
    assert ep.survey_year(61174.5017) == 1
    assert ep.survey_year(61174.5327) == 2
    assert ep.mjd_to_iso(config.YEAR2_START_MJD).startswith("2026-05-14T12:")
