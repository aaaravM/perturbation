"""Offline tests of the mover/variable finder (pxh.ml.movers) and the field pipeline (pxh.ml.finder)."""

from __future__ import annotations

import io
import math

import numpy as np
import pytest
from PIL import Image
from scipy.special import erf

from pxh.imaging import align
from pxh.ml import finder
from pxh.ml import movers as mv
from pxh.ml.realbogus import RealBogus
from pxh.models import Frame

RA0, DEC0 = 150.0, 2.2
EPOCH_MJD = {0: 60900.0, 1: 61085.0, 2: 61265.0}
SIGMA_PSF = 0.8


def _psf(shape: tuple[int, int], x: float, y: float, flux: float) -> np.ndarray:
    yy = np.arange(shape[0], dtype=float)
    xx = np.arange(shape[1], dtype=float)
    s = SIGMA_PSF * math.sqrt(2.0)
    gx = 0.5 * (erf((xx - x + 0.5) / s) - erf((xx - x - 0.5) / s))
    gy = 0.5 * (erf((yy - y + 0.5) / s) - erf((yy - y - 0.5) / s))
    return flux * np.outer(gy, gx)


def make_stack(
    seed: int = 1, mover: tuple[float, float, float, float] | None = (20.0, 20.0, 2.0, 1.5),
    variable: tuple[float, float, float, float] | None = (40.0, 38.0, 150.0, 600.0), saturate: bool = False,
) -> mv.FieldStack:
    """3 detectors x 3 full epochs of a 61 x 61 grid with unit noise, static stars, a mover
    (x0, y0 at epoch 0, vx, vy in px/yr; flux 400) and a variable (x, y, flux at epochs 0-1, flux at epoch 2)."""
    rng = np.random.default_rng(seed)
    wcs, shape = align.make_grid(RA0, DEC0, 6.25)
    stars = [(rng.uniform(5, 55), rng.uniform(5, 55), rng.uniform(30, 300)) for _ in range(12)]
    frames: dict[int, dict[int, Frame]] = {}
    sat: dict[int, dict[int, np.ndarray]] = {}
    for det in (4, 5, 6):
        frames[det], sat[det] = {}, {}
        for e, mjd in EPOCH_MJD.items():
            img = rng.normal(0.0, 1.0, shape)
            for x, y, f in stars:
                if mover is not None and math.hypot(x - mover[0], y - mover[1]) < 8:
                    continue
                if variable is not None and math.hypot(x - variable[0], y - variable[1]) < 8:
                    continue
                img += _psf(shape, x, y, f)
            if mover is not None:
                dt = (mjd - EPOCH_MJD[0]) / 365.25
                img += _psf(shape, mover[0] + mover[2] * dt, mover[1] + mover[3] * dt, 400.0)
            if variable is not None:
                img += _psf(shape, variable[0], variable[1], variable[2] if e < 2 else variable[3])
            weight = np.ones(shape, np.float32)
            s = np.zeros(shape, bool)
            if saturate:
                s[28:33, 28:33] = True
                weight[29:32, 29:32] = 0.0
                img[29:32, 29:32] = np.nan
            frames[det][e] = Frame(data=img.astype(np.float32), weight=weight, wcs=wcs, mjd_mid=mjd, n_inputs=12,
                                   label=f"D{det} E{e}", detector=det, epoch_index=e)
            sat[det][e] = s
    full = {e: True for e in EPOCH_MJD}
    dates = {e: ("2025-01-01", "2025-01-10") for e in EPOCH_MJD}
    return mv.FieldStack(wcs, shape, frames, sat, full, dates, {"id": "synthetic"})


def tiny_model(seed: int = 3) -> RealBogus:
    """A classifier with random weights (the shapes of the real one) and a null set, for plumbing tests."""
    rng = np.random.default_rng(seed)
    shapes = {
        "conv1.weight": (16, 4, 3, 3), "conv1.bias": (16,), "conv2.weight": (16, 16, 3, 3), "conv2.bias": (16,),
        "conv3.weight": (32, 16, 3, 3), "conv3.bias": (32,), "conv4.weight": (32, 32, 3, 3), "conv4.bias": (32,),
        "conv5.weight": (64, 32, 3, 3), "conv5.bias": (64,), "fc1.weight": (64, 128), "fc1.bias": (64,),
        "fc2.weight": (4, 64), "fc2.bias": (4,),
    }
    w = {k: rng.normal(0, 0.2, s) for k, s in shapes.items()}
    w["null_scores"] = np.sort(rng.uniform(0, 0.6, 4000))
    meta = {"name": "tiny", "classes": list(mv.CLASSES), "temperature": 1.5, "metrics": {"test_accuracy": 0.5}}
    return RealBogus(w, meta)


def test_finds_the_mover_and_the_variable() -> None:
    stack = make_stack()
    cands, diffs = mv.find_candidates(stack)
    assert len(diffs) == 9  # 3 detectors x (long pair + 2 adjacent pairs)
    movers = [c for c in cands if c.kind == "mover"]
    variables = [c for c in cands if c.kind == "variable"]
    # the mover: 2.5 px/yr over 0.99 yr, lobes at its first and last positions
    end_x, end_y = 20.0 + 2.0 * 0.9993, 20.0 + 1.5 * 0.9993
    m = min(movers, key=lambda c: math.hypot(c.x_pos - end_x, c.y_pos - end_y))
    assert math.hypot(m.x_pos - end_x, m.y_pos - end_y) < 1.0
    assert math.hypot(m.x_neg - 20.0, m.y_neg - 20.0) < 1.0
    assert m.dets == [4, 5, 6] and m.snr > 20
    v = min(variables, key=lambda c: math.hypot(c.x - 40.0, c.y - 38.0))
    assert math.hypot(v.x - 40.0, v.y - 38.0) < 1.0 and v.snr > 20  # brightened: positive
    # nothing else of note: no candidate stronger than 8 sigma away from the two sources
    for c in cands:
        near = math.hypot(c.x - 40, c.y - 38) < 4 or math.hypot(c.x - 21, c.y - 20.8) < 4
        assert near or abs(c.snr) < 8


def test_static_field_has_no_strong_candidates() -> None:
    stack = make_stack(mover=None, variable=None)
    cands, _ = mv.find_candidates(stack)
    assert all(abs(c.snr) < 7 for c in cands)


def test_stamps_follow_the_convention() -> None:
    stack = make_stack()
    cands, diffs = mv.find_candidates(stack)
    stamps = mv.cut_stamps(stack, diffs, cands)
    assert stamps.shape == (len(cands), 4, 21, 21) and stamps.dtype == np.float32
    assert np.isfinite(stamps).all()
    assert set(np.unique(stamps[:, 3])) <= {0.0, 1.0}
    v = min(cands, key=lambda c: math.hypot(c.x - 40.0, c.y - 38.0))
    s = mv.cut_stamp(stack, diffs, v)
    assert s[2, 10, 10] == pytest.approx(np.arcsinh(diffs[v.pair_key].snr[round(v.y), round(v.x)] / 5.0),
                                         rel=1e-5)
    assert s[1, 10, 10] > s[0, 10, 10] > 0  # brighter in the later epoch
    # off the grid: masked
    edge = mv.Candidate("variable", 1.0, 1.0, 5.0, v.det, v.a, v.b, [v.det], [(v.a, v.b)], [])
    e = mv.cut_stamp(stack, diffs, edge)
    assert e[3, 0, 0] == 1.0 and e[0, 0, 0] == 0.0


def test_saturated_core_is_one_flagged_candidate() -> None:
    stack = make_stack(mover=(30.0, 29.0, 2.0, 0.0), variable=None, saturate=True)
    cands, _ = mv.find_candidates(stack)
    near = [c for c in cands if math.hypot(c.x - 31.0, c.y - 29.0) < 6]
    assert len(near) == 1 and "saturated" in near[0].flags


def test_motion_and_variability_measurements() -> None:
    stack = make_stack()
    cands, diffs = mv.find_candidates(stack)
    meas = mv.measure_all(stack, diffs, cands)
    m_i = min(range(len(cands)), key=lambda i: math.hypot((cands[i].x_pos or 99) - 22.0, (cands[i].y_pos or 99) - 21.5))
    motion = meas[m_i]["motion"]
    # 2.5 px/yr x 6.15 arcsec/px = 15.4 arcsec/yr, moving west (x up) and north: PA = 360 - atan(2/1.5)
    assert motion["pm_arcsec_yr"] == pytest.approx(2.5 * stack.pixscale_arcsec, rel=0.1)
    assert motion["pa_deg"] == pytest.approx(360.0 - math.degrees(math.atan2(2.0, 1.5)), abs=8.0)
    assert motion["n_epochs"] == 3
    v_i = min(range(len(cands)), key=lambda i: math.hypot(cands[i].x - 40.0, cands[i].y - 38.0))
    var = meas[v_i]["variability"]
    assert var["delta_mag"] == pytest.approx(-2.5 * math.log10(600.0 / 150.0), abs=0.25)
    assert var["sigma"] > 10


def test_stamp_png_is_a_three_panel_strip() -> None:
    stack = make_stack()
    cands, diffs = mv.find_candidates(stack)
    img = Image.open(io.BytesIO(mv.stamp_png(stack, diffs, cands[0])))
    assert img.size == (192, 64) and img.mode == "L"
    px = np.asarray(img)
    assert px[:, 128:].min() < 100 or px[:, 128:].max() > 160  # the difference panel shows the change


def test_stack_round_trip(tmp_path) -> None:
    stack = make_stack()
    path = tmp_path / "s.npz"
    mv.save_stack(path, stack)
    back = mv.load_stack(path)
    assert back.dets == stack.dets and back.shape == stack.shape and back.full == stack.full
    np.testing.assert_array_equal(back.frames[5][1].data, stack.frames[5][1].data)
    assert back.frames[6][2].mjd_mid == stack.frames[6][2].mjd_mid
    assert back.meta == stack.meta


def test_field_pipeline_scores_and_fdr() -> None:
    stack = make_stack()
    model = tiny_model()
    scored, diffs = finder.score_field(stack, model)
    finder.apply_fdr(scored)
    assert scored and all(0.0 < s.p <= 1.0 and s.p <= s.q <= 1.0 for s in scored if s.in_family)
    for s in scored:
        assert s.score == pytest.approx(float(s.probs[0] + s.probs[1]))
        assert s.kind in ("mover", "variable")
    meas = finder.measure(stack, diffs, scored[:3])
    rec = finder.candidate_record(stack, scored[0], "c-0", "synthetic", meas[0], dict(finder.NO_MATCH), "/s.png")
    assert set(rec) == {"id", "field", "ra", "dec", "kind", "score", "probs", "p_value", "q_value", "snr", "motion",
                        "variability", "detectors", "epochs", "match", "stamp", "lab_url"}
    assert rec["lab_url"].startswith("/explore?ra=") and rec["lab_url"].endswith("&fov=0.1667")


def test_catalogue_match_rules() -> None:
    src = finder.catalog_source("Gaia DR3", "1", "Gaia DR3 1", 150.0, 2.2, 57388.5, -1000.0, 0.0)  # 1"/yr west
    mjd = 57388.5 + 365.25 * 10  # ten years later: 10" west
    ra_now = 150.0 - 10.0 / 3600.0 / math.cos(math.radians(2.2))
    hit = finder.catalogue_match(ra_now, 2.2, mjd, "mover", {"pm_arcsec_yr": 1.1, "pm_err_arcsec_yr": 0.1}, [src])
    assert hit["status"] == "known" and hit["sep_arcsec"] < 0.1 and hit["catalog_pm_arcsec_yr"] == 1.0
    wrong_speed = finder.catalogue_match(ra_now, 2.2, mjd, "mover", {"pm_arcsec_yr": 5.0, "pm_err_arcsec_yr": 0.2},
                                         [src])
    assert wrong_speed["status"] == "unknown"
    far = finder.catalogue_match(150.0, 2.2, mjd, "variable", None, [src])  # the star has left its 2016 spot
    assert far["status"] == "unknown"
    simbad = finder.catalog_source("SIMBAD", "V* X", "V* X", ra_now, 2.2, mjd, None, None)
    both = finder.catalogue_match(ra_now, 2.2, mjd, "variable", None, [src, simbad])
    assert both["catalog"] == "SIMBAD"


def test_static_star_residual_veto() -> None:
    mjd = 61000.0
    bright = finder.catalog_source("Gaia DR3", "2", "Gaia DR3 2", 150.0, 2.2, 57388.5, 2.0, -1.0, mag=13.9)
    faint = finder.catalog_source("Gaia DR3", "3", "Gaia DR3 3", 150.0, 2.2, 57388.5, 2.0, -1.0, mag=20.0)
    near = 150.0 + 3.0 / 3600.0  # 3" east
    no_motion = {"pm_arcsec_yr": 1.2, "pm_err_arcsec_yr": 0.8}
    hit = finder.static_star_residual(near, 2.2, mjd, no_motion, [bright])
    assert hit is not None and hit["id"] == "2" and hit["sep_arcsec"] == pytest.approx(3.0, abs=0.1)
    assert finder.static_star_residual(near, 2.2, mjd, None, [bright]) is not None
    # a significant motion, a faint star, a star far away or no magnitude never veto
    assert finder.static_star_residual(near, 2.2, mjd, {"pm_arcsec_yr": 3.7, "pm_err_arcsec_yr": 0.4}, [bright]) is None
    assert finder.static_star_residual(near, 2.2, mjd, no_motion, [faint]) is None
    assert finder.static_star_residual(150.0 + 20.0 / 3600.0, 2.2, mjd, no_motion, [bright]) is None
    unknown_mag = finder.catalog_source("Gaia DR3", "5", "Gaia DR3 5", 150.0, 2.2, 57388.5, 2.0, -1.0)
    assert finder.static_star_residual(near, 2.2, mjd, no_motion, [unknown_mag]) is None
    still = finder.catalog_source("Gaia DR3", "4", "Gaia DR3 4", 150.0, 2.2, 57388.5, 0.0, 0.0, mag=12.0)
    assert finder.static_star_residual(near, 2.2, mjd, no_motion, [still]) is not None
    # a star with a catalogued motion of its own (0.5"/yr) is not static
    fast = finder.catalog_source("Gaia DR3", "6", "Gaia DR3 6", 150.0, 2.2, 57388.5, 500.0, 0.0, mag=12.0)
    assert finder.static_star_residual(near, 2.2, mjd, no_motion, [fast]) is None
