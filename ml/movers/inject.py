"""Synthetic sources injected into real SPHEREx per-epoch co-adds: training data and completeness tests.

Everything injected here is synthetic and is used only to train the classifier and to measure how complete
the finder is. Nothing from this module is ever shown to the public as a detection.

Injected sources (NumPy only):

- **PSF**: a pixel-integrated circular Gaussian core (95% of the light) whose FWHM is measured from isolated
  stars in the same co-add (``pxh.ml.movers.estimate_fwhm``; 1.7 px when too few stars), plus faint wide wings
  (3.5% at 3x, 1.5% at 7x the core width), which only bright sources show. The co-adds are resampled onto a common grid,
  so the Level-2 ePSF would need the resampling kernel too; the measured co-add width already includes it.
- **Noise consistent with the weights**: the source adds Poisson-like variance ``c * model``, where ``c`` is the
  slope of the co-add's variance against its surface brightness, fitted on the field's own bright pixels.
  The added noise is drawn from that variance and the weight map is updated, ``1/w -> 1/w + c * model``.
- **S/N**: a source's S/N in one epoch co-add is ``F * sqrt(sum P^2 w)`` (PSF-weighted). One detector gets the
  drawn S/N, the others 0.2-1 times it (real spectra differ between detectors).

Kinds:

- ``mover``: constant flux, linear motion, speed log-uniform 0.3-20 arcsec/yr, random direction; S/N per epoch
  log-uniform 3-100.
- the bright tail (``bright_frac`` of movers, variables and static sources; 20% in training, none in the
  completeness tests): S/N 150-3000 with a saturated core, masked like the real co-adds (data NaN, weight 0,
  saturation flag, flagged ring around it), so that saturated stars such as the challenge targets are not
  out of the classifier's experience.
- ``variable``: fixed position (half on a real star, half on blank sky), flux factor log-uniform 0.3-3 per
  epoch; the drawn S/N (3-100) is that of the change between the detector's earliest and latest epochs.
- ``static``: constant flux and position, S/N 10-300: it must cancel in the differences.
- ``spike``: one or two hot pixels in one epoch of one detector, 8-80 sigma: an artifact.

Labels come from running the real finder on the injected co-adds (``label_candidates``): a candidate within
2 px of an injection takes its class (mover, variable; spike -> artifact; static -> nothing). Candidates in the
uninjected field (``real_examples``) are artifacts, except near catalogued fast movers (Gaia DR3 or CatWISE2020
faster than 0.2"/yr: labelled mover) or SIMBAD variable-type objects (left out: their label is unknown).
``nothing_stamps`` adds stamps at random positions with no candidate (blank sky and static stars).
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

import numpy as np
from pxh.ml import movers as mv
from scipy import ndimage
from scipy.special import erf

from movers import data as mdata

LABELS = {"mover": 0, "variable": 1, "artifact": 2, "nothing": 3}
INJ_LABEL = {"mover": 0, "variable": 1, "spike": 2, "static": 3}
SQRT2 = math.sqrt(2.0)
MATCH_PX = 2.0
MATCH_PX_SATURATED = 3.5
BRIGHT_SNR = (150.0, 3000.0)  # the bright tail: sources that saturate, like the challenge targets
MARGIN_PX = 8
MIN_SPACING_PX = 12.0
PATCH_HALF = 12
PSF_WEIGHTS = (0.95, 0.035, 0.015)  # core, wing, far wing
PSF_WING_SCALES = (3.0, 7.0)


# --- PSF and noise --------------------------------------------------------------------------------------


def gaussian_sigma(fwhm_px: float) -> float:
    """Sigma of the Gaussian before pixel integration that gives a pixelated FWHM of ``fwhm_px``."""
    s_eff = fwhm_px / 2.3548
    return math.sqrt(max(s_eff**2 - 1.0 / 12.0, 0.25**2))


def _gauss_patch(x: float, y: float, sigma: float, ix: int, iy: int, half: int) -> np.ndarray:
    xs = np.arange(ix - half, ix + half + 1, dtype=float)
    ys = np.arange(iy - half, iy + half + 1, dtype=float)
    gx = 0.5 * (erf((xs - x + 0.5) / (sigma * SQRT2)) - erf((xs - x - 0.5) / (sigma * SQRT2)))
    gy = 0.5 * (erf((ys - y + 0.5) / (sigma * SQRT2)) - erf((ys - y - 0.5) / (sigma * SQRT2)))
    return np.outer(gy, gx)


def psf_patch(x: float, y: float, sigma: float, half: int = PATCH_HALF) -> tuple[int, int, np.ndarray]:
    """(row0, col0, patch): unit-flux point source centred on (x, y): a pixel-integrated Gaussian core with
    95% of the light plus faint wide wings (3.5% at 3x and 1.5% at 7x the core width), as bright stars show."""
    ix, iy = round(x), round(y)
    p = PSF_WEIGHTS[0] * _gauss_patch(x, y, sigma, ix, iy, half)
    for w, k in zip(PSF_WEIGHTS[1:], PSF_WING_SCALES, strict=True):
        p += w * _gauss_patch(x, y, k * sigma, ix, iy, half)
    return iy - half, ix - half, p


def _window(shape: tuple[int, int], r0: int, c0: int, n: int) -> tuple[slice, slice, slice, slice] | None:
    ny, nx = shape
    a0, a1 = max(0, r0), min(ny, r0 + n)
    b0, b1 = max(0, c0), min(nx, c0 + n)
    if a1 <= a0 or b1 <= b0:
        return None
    return slice(a0, a1), slice(b0, b1), slice(a0 - r0, a1 - r0), slice(b0 - c0, b1 - c0)


def variance_slope(fr: Any) -> float:
    """c in var = var_sky + c * (I - sky): the co-add's variance per unit surface brightness (>= 0)."""
    d = np.asarray(fr.data, float)
    w = np.asarray(fr.weight, float)
    ok = (w > 0) & np.isfinite(d)
    if ok.sum() < 200:
        return 0.0
    var = np.where(ok, 1.0 / np.where(ok, w, 1.0), np.nan)
    bkg, vb = float(np.median(d[ok])), float(np.median(var[ok]))
    s = (d - bkg) * np.sqrt(np.where(ok, w, 0.0))
    sel = ok & (s > 20) & (s < 3000)
    if sel.sum() < 20:
        return 0.0
    c = np.median((var[sel] - vb) / (d[sel] - bkg))
    return float(max(c, 0.0)) if np.isfinite(c) else 0.0


def snr_per_flux(fr: Any, x: float, y: float, sigma: float) -> float:
    """S/N of a unit-flux source at (x, y): sqrt(sum P^2 w)."""
    r0, c0, p = psf_patch(x, y, sigma)
    win = _window(np.shape(fr.data), r0, c0, p.shape[0])
    if win is None:
        return 0.0
    sy, sx, py, px = win
    w = np.asarray(fr.weight, float)[sy, sx]
    return float(math.sqrt(np.sum(p[py, px] ** 2 * w)))


def add_source(
    fr: Any, x: float, y: float, flux: float, sigma: float, c: float, rng: np.random.Generator,
    sat_level: float | None = None, saturated: np.ndarray | None = None,
) -> None:
    """Add a point source (in place) with noise from the variance it adds; weights updated to match.

    With ``sat_level`` (surface brightness), pixels where the source exceeds it become a saturation hole as in
    the real co-adds (data NaN, weight 0, ``saturated`` set), and the pixels around the hole are flagged
    saturated (OVERFLOW in some inputs) but keep their data."""
    r0, c0, p = psf_patch(x, y, sigma)
    win = _window(np.shape(fr.data), r0, c0, p.shape[0])
    if win is None:
        return
    sy, sx, py, px = win
    model = flux * p[py, px]
    w = fr.weight[sy, sx].astype(np.float64)
    valid = w > 0
    var_add = c * np.clip(model, 0.0, None)
    noise = rng.normal(0.0, 1.0, model.shape) * np.sqrt(var_add)
    d = fr.data[sy, sx].astype(np.float64)
    d = np.where(valid, d + model + noise, d)
    with np.errstate(divide="ignore"):
        w_new = np.where(valid, 1.0 / (1.0 / np.where(valid, w, 1.0) + var_add), 0.0)
    if sat_level is not None and saturated is not None:
        hole = model > sat_level
        if hole.any():
            d = np.where(hole, np.nan, d)
            w_new = np.where(hole, 0.0, w_new)
            saturated[sy, sx] |= ndimage.binary_dilation(hole, iterations=1)
    fr.data[sy, sx] = d.astype(np.float32)
    fr.weight[sy, sx] = w_new.astype(np.float32)


# --- per-field context ------------------------------------------------------------------------------------


@dataclass
class FieldContext:
    """What the injector needs to know about a field, computed once."""

    stack: mv.FieldStack
    sigma: dict[tuple[int, int], float]
    slope: dict[tuple[int, int], float]
    stars: np.ndarray  # [N, 2] x, y of isolated unsaturated stars (S/N 10-500) in the latest co-add
    long_pair: dict[int, tuple[int, int]]  # det -> (later, earlier) epochs of its long difference
    cats: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def build(cls, stack: mv.FieldStack, cats: dict[str, Any] | None = None) -> FieldContext:
        sigma, slope = {}, {}
        for det in stack.dets:
            for e, fr in stack.frames[det].items():
                fw = mv.estimate_fwhm(fr, stack.saturated.get(det, {}).get(e))
                sigma[(det, e)] = gaussian_sigma(fw)
                slope[(det, e)] = variance_slope(fr)
        long_pair = {}
        for det in stack.dets:
            pairs = mv.epoch_pairs(stack, det)
            if pairs:
                long_pair[det] = (pairs[0][0], pairs[0][1])
        return cls(stack, sigma, slope, _stars(stack), long_pair, cats or {})


def _stars(stack: mv.FieldStack) -> np.ndarray:
    det = stack.dets[-1]
    e = max(stack.frames[det])
    fr = stack.frames[det][e]
    d, w = np.asarray(fr.data, float), np.asarray(fr.weight, float)
    ok = (w > 0) & np.isfinite(d)
    if ok.sum() < 100:
        return np.zeros((0, 2))
    s = np.where(ok, (d - np.median(d[ok])) * np.sqrt(np.where(ok, w, 0.0)), 0.0)
    mx = ndimage.maximum_filter(s, size=5, mode="constant")
    ys, xs = np.nonzero((s == mx) & (s >= 10) & (s <= 500))
    sat = stack.saturated.get(det, {}).get(e)
    keep = [(x, y) for x, y in zip(xs, ys, strict=True)
            if MARGIN_PX <= x < s.shape[1] - MARGIN_PX and MARGIN_PX <= y < s.shape[0] - MARGIN_PX
            and (sat is None or not sat[max(0, y - 2) : y + 3, max(0, x - 2) : x + 3].any())]
    return np.array(keep, dtype=float).reshape(-1, 2)


# --- injections --------------------------------------------------------------------------------------------


@dataclass
class Injection:
    kind: str  # mover | variable | static | spike
    x0: float
    y0: float
    t_ref: float = 0.0
    vx: float = 0.0  # px per day
    vy: float = 0.0
    snr: float = 0.0
    speed: float = 0.0  # arcsec/yr
    pa: float = 0.0
    best_det: int = 0
    on_star: bool = False
    spike_key: tuple[int, int] | None = None
    saturated: bool = False  # bright enough to leave saturation holes
    factors: dict[int, float] = field(default_factory=dict)
    delta_mag: float = 0.0  # variables: magnitude change between the best detector's long-pair epochs
    flux: dict[int, float] = field(default_factory=dict)  # per detector: mover/static flux, variable base flux
    star_flux: dict[int, float] = field(default_factory=dict)  # variables on a star: the star's flux

    def pos(self, mjd: float) -> tuple[float, float]:
        return self.x0 + self.vx * (mjd - self.t_ref), self.y0 + self.vy * (mjd - self.t_ref)


def _loguniform(rng: np.random.Generator, lo: float, hi: float) -> float:
    return float(math.exp(rng.uniform(math.log(lo), math.log(hi))))


def _place(rng: np.random.Generator, shape: tuple[int, int], taken: list[tuple[float, float]]) -> tuple[float, float]:
    ny, nx = shape
    for _ in range(200):
        x = rng.uniform(MARGIN_PX, nx - 1 - MARGIN_PX)
        y = rng.uniform(MARGIN_PX, ny - 1 - MARGIN_PX)
        if all(math.hypot(x - a, y - b) >= MIN_SPACING_PX for a, b in taken):
            return x, y
    return x, y


def _det_snrs(rng: np.random.Generator, dets: list[int], snr: float) -> tuple[int, dict[int, float]]:
    best = int(rng.choice(dets))
    return best, {d: snr if d == best else snr * rng.uniform(0.2, 1.0) for d in dets}


def inject(
    ctx: FieldContext, rng: np.random.Generator, *, n_mover: int = 6, n_variable: int = 6, n_static: int = 4,
    n_spike: int = 3, snr_range: tuple[float, float] = (3.0, 100.0), speed_range: tuple[float, float] = (0.3, 20.0),
    bright_frac: float = 0.0,
) -> tuple[mv.FieldStack, list[Injection]]:
    """A copy of the field with synthetic sources added, and the list of what was injected."""
    st = ctx.stack.copy()
    dets = st.dets
    all_mjd = [fr.mjd_mid for d in dets for fr in st.frames[d].values()]
    t_ref = 0.5 * (min(all_mjd) + max(all_mjd))
    pix = st.pixscale_arcsec
    taken: list[tuple[float, float]] = []
    injections: list[Injection] = []

    kinds = ["mover"] * n_mover + ["variable"] * n_variable + ["static"] * n_static + ["spike"] * n_spike
    rng.shuffle(kinds)
    for kind in kinds:
        bright = kind != "spike" and rng.random() < bright_frac
        snr_k = BRIGHT_SNR if bright else snr_range
        on_star = False
        if kind == "variable" and len(ctx.stars) and rng.random() < 0.5:
            free = [s for s in ctx.stars if all(math.hypot(s[0] - a, s[1] - b) >= MIN_SPACING_PX for a, b in taken)]
            if free:
                x, y = free[int(rng.integers(len(free)))]
                x, y = float(x) + rng.uniform(-0.3, 0.3), float(y) + rng.uniform(-0.3, 0.3)
                on_star = True
            else:
                x, y = _place(rng, st.shape, taken)
        else:
            x, y = _place(rng, st.shape, taken)
        taken.append((x, y))
        if kind == "mover":
            inj = _inject_mover(st, ctx, rng, x, y, t_ref, pix, snr_k, speed_range, bright)
        elif kind == "variable":
            inj = _inject_variable(st, ctx, rng, x, y, snr_k, bright)
            inj.on_star = on_star
        elif kind == "static":
            inj = _inject_static(st, ctx, rng, x, y, BRIGHT_SNR if bright else (10.0, 300.0), bright)
        else:
            inj = _inject_spike(st, rng, x, y)
        if inj is not None:
            injections.append(inj)
    return st, injections


def _sat_level(rng: np.random.Generator, flux: float, sigma: float) -> float:
    """Surface brightness above which a bright injected source saturates: 3-60% of its peak pixel
    (log-uniform), so the holes range from one pixel to a dozen, as for the bright stars in the survey."""
    peak = flux * float(psf_patch(0.0, 0.0, sigma)[2].max())
    return peak * _loguniform(rng, 0.03, 0.6)


def _inject_mover(st, ctx, rng, x, y, t_ref, pix, snr_range, speed_range, bright=False) -> Injection:
    snr = _loguniform(rng, *snr_range)
    speed = _loguniform(rng, *speed_range)
    pa = rng.uniform(0.0, 360.0)
    v_px_day = speed / pix / 365.25
    # grid: x increases to the west (east is left), y to the north; PA is east of north
    vx = -v_px_day * math.sin(math.radians(pa))
    vy = v_px_day * math.cos(math.radians(pa))
    inj = Injection("mover", x, y, t_ref, vx, vy, snr, speed, pa, saturated=bright)
    best, det_snr = _det_snrs(rng, st.dets, snr)
    inj.best_det = best
    for det in st.dets:
        norms = [snr_per_flux(fr, *inj.pos(fr.mjd_mid), ctx.sigma[(det, e)]) for e, fr in st.frames[det].items()]
        norms = [n for n in norms if n > 0]
        if not norms:
            continue
        flux = det_snr[det] / float(np.median(norms))
        inj.flux[det] = flux
        level = _sat_level(rng, flux, ctx.sigma[(det, max(st.frames[det]))]) if bright else None
        for e, fr in st.frames[det].items():
            add_source(fr, *inj.pos(fr.mjd_mid), flux, ctx.sigma[(det, e)], ctx.slope[(det, e)], rng,
                       level, st.saturated.get(det, {}).get(e))
    return inj


def _inject_variable(st, ctx, rng, x, y, snr_range, bright=False) -> Injection:
    snr = _loguniform(rng, *snr_range)
    epochs = sorted({e for d in st.dets for e in st.frames[d]})
    best, det_snr = _det_snrs(rng, st.dets, snr)
    a, b = ctx.long_pair.get(best, (epochs[-1], epochs[0]))
    for _ in range(50):
        factors = {e: _loguniform(rng, 0.3, 3.0) for e in epochs}
        if abs(math.log(factors[a] / factors[b])) >= 0.2:
            break
    inj = Injection("variable", x, y, snr=snr, best_det=best, factors=factors, saturated=bright)
    inj.delta_mag = -2.5 * math.log10(factors[a] / factors[b])
    for det in st.dets:
        da, db = ctx.long_pair.get(det, (a, b))
        if da not in st.frames[det] or db not in st.frames[det]:
            continue
        na = snr_per_flux(st.frames[det][da], x, y, ctx.sigma[(det, da)])
        nb = snr_per_flux(st.frames[det][db], x, y, ctx.sigma[(det, db)])
        if na <= 0 or nb <= 0:
            continue
        change = abs(factors[da] - factors[db])
        if change < 1e-3:
            continue
        f0 = det_snr[det] * math.sqrt(1.0 / na**2 + 1.0 / nb**2) / change
        inj.flux[det] = f0
        star = star_flux(st.frames[det][da], x, y, ctx.sigma[(det, da)])
        if star > 0:
            inj.star_flux[det] = star
        level = _sat_level(rng, f0, ctx.sigma[(det, da)]) if bright else None
        for e, fr in st.frames[det].items():
            add_source(fr, x, y, f0 * factors[e], ctx.sigma[(det, e)], ctx.slope[(det, e)], rng,
                       level, st.saturated.get(det, {}).get(e))
    return inj


def _inject_static(st, ctx, rng, x, y, snr_range=(10.0, 300.0), bright=False) -> Injection:
    snr = _loguniform(rng, *snr_range)
    best, det_snr = _det_snrs(rng, st.dets, snr)
    inj = Injection("static", x, y, snr=snr, best_det=best, saturated=bright)
    for det in st.dets:
        norms = [snr_per_flux(fr, x, y, ctx.sigma[(det, e)]) for e, fr in st.frames[det].items()]
        norms = [n for n in norms if n > 0]
        if not norms:
            continue
        flux = det_snr[det] / float(np.median(norms))
        inj.flux[det] = flux
        level = _sat_level(rng, flux, ctx.sigma[(det, max(st.frames[det]))]) if bright else None
        for e, fr in st.frames[det].items():
            add_source(fr, x, y, flux, ctx.sigma[(det, e)], ctx.slope[(det, e)], rng, level,
                       st.saturated.get(det, {}).get(e))
    return inj


def _inject_spike(st, rng, x, y) -> Injection | None:
    det = int(rng.choice(st.dets))
    e = int(rng.choice(sorted(st.frames[det])))
    fr = st.frames[det][e]
    ix, iy = round(x), round(y)
    if fr.weight[iy, ix] <= 0:
        return None
    amp_sigma = _loguniform(rng, 8.0, 80.0)
    pix = [(iy, ix)]
    if rng.random() < 0.3:
        dy, dx = [(0, 1), (1, 0), (1, 1), (0, -1)][int(rng.integers(4))]
        pix.append((iy + dy, ix + dx))
    for py, px in pix:
        w = fr.weight[py, px]
        if w > 0:
            fr.data[py, px] += np.float32(amp_sigma * rng.uniform(0.6, 1.0) / math.sqrt(float(w)))
    inj = Injection("spike", float(ix), float(iy), snr=amp_sigma, best_det=det, spike_key=(det, e))
    return inj


def star_flux(fr: Any, x: float, y: float, sigma: float) -> float:
    """PSF-weighted flux already in the co-add at (x, y), above the local median (0 if none)."""
    r0, c0, p = psf_patch(x, y, sigma, half=3)
    win = _window(np.shape(fr.data), r0, c0, p.shape[0])
    if win is None:
        return 0.0
    sy, sx, py, px = win
    d = np.asarray(fr.data, float)[sy, sx]
    w = np.asarray(fr.weight, float)[sy, sx]
    ok = (w > 0) & np.isfinite(d)
    if ok.sum() < 5:
        return 0.0
    big = np.asarray(fr.data, float)[max(0, r0 - 4) : r0 + p.shape[0] + 4, max(0, c0 - 4) : c0 + p.shape[0] + 4]
    bkg = float(np.nanmedian(big))
    pp = p[py, px][ok]
    return float(max(0.0, np.sum(pp * (d[ok] - bkg)) / np.sum(pp * pp)))


def expected_snr(ctx: FieldContext, inj: Injection, c: mv.Candidate, noise_scale: float) -> float:
    """Peak |S/N| the injected source alone (noiseless) puts in the candidate's difference image."""
    det, a, b = c.det, c.a, c.b
    if inj.kind not in ("mover", "variable") or det not in inj.flux:
        return 0.0
    fa, fb = ctx.stack.frames[det][a], ctx.stack.frames[det][b]
    if inj.kind == "mover":
        (xa, ya), (xb, yb) = inj.pos(fa.mjd_mid), inj.pos(fb.mjd_mid)
        fla = flb = inj.flux[det]
    else:
        xa = xb = inj.x0
        ya = yb = inj.y0
        fla, flb = inj.flux[det] * inj.factors.get(a, 1.0), inj.flux[det] * inj.factors.get(b, 1.0)
    cx, cy = round(0.5 * (xa + xb)), round(0.5 * (ya + yb))
    half = 9
    model = np.zeros((2 * half + 1, 2 * half + 1))
    for x, y, f, sign, key in ((xa, ya, fla, 1.0, (det, a)), (xb, yb, flb, -1.0, (det, b))):
        r0, c0, p = psf_patch(x, y, ctx.sigma[key])
        win = _window(model.shape, r0 - (cy - half), c0 - (cx - half), p.shape[0])
        if win is not None:
            sy, sx, py, px = win
            model[sy, sx] += sign * f * p[py, px]
    win = _window(np.shape(fa.data), cy - half, cx - half, 2 * half + 1)
    if win is None:
        return 0.0
    sy, sx, py, px = win
    wa = np.asarray(fa.weight, float)[sy, sx]
    wb = np.asarray(fb.weight, float)[sy, sx]
    ok = (wa > 0) & (wb > 0)
    if not ok.any():
        return 0.0
    noise = np.sqrt(1.0 / np.where(ok, wa, 1.0) + 1.0 / np.where(ok, wb, 1.0)) * noise_scale
    return float(np.max(np.where(ok, np.abs(model[py, px]) / noise, 0.0)))


MIN_EXPECTED_SNR = 3.0
MIN_STAR_FRACTION = 0.15


def learnable(ctx: FieldContext, inj: Injection, c: mv.Candidate, noise_scale: float) -> tuple[bool, float]:
    """Whether a matched candidate can be credited to the injection: its expected S/N in the candidate's
    difference image is at least 3, and a variable on a real star changes that star by at least 15%."""
    if inj.kind not in ("mover", "variable"):
        return True, 0.0
    snr = expected_snr(ctx, inj, c, noise_scale)
    if snr < MIN_EXPECTED_SNR:
        return False, snr
    if inj.kind == "variable" and inj.on_star and c.det in inj.star_flux:
        change = inj.flux.get(c.det, 0.0) * abs(inj.factors.get(c.a, 1.0) - inj.factors.get(c.b, 1.0))
        if change < MIN_STAR_FRACTION * inj.star_flux[c.det]:
            return False, snr
    return True, snr


# --- labelling -----------------------------------------------------------------------------------------------


def _cand_points(c: mv.Candidate) -> list[tuple[float, float]]:
    pts = [(c.x, c.y)]
    if c.x_pos is not None:
        pts += [(c.x_pos, c.y_pos), (c.x_neg, c.y_neg)]
    return pts


def match_injection(stack: mv.FieldStack, c: mv.Candidate, injections: list[Injection]) -> tuple[int, float]:
    """Index of the injection a candidate belongs to (-1 if none) and the distance in px."""
    best, best_d = -1, math.inf
    mjd_a = stack.frames[c.det][c.a].mjd_mid
    mjd_b = stack.frames[c.det][c.b].mjd_mid
    for k, inj in enumerate(injections):
        if inj.kind == "mover":
            pa_, pb_ = inj.pos(mjd_a), inj.pos(mjd_b)
            targets = [pa_, pb_, (0.5 * (pa_[0] + pb_[0]), 0.5 * (pa_[1] + pb_[1]))]
        else:
            targets = [(inj.x0, inj.y0)]
        d = min(math.hypot(p[0] - t[0], p[1] - t[1]) for p in _cand_points(c) for t in targets)
        d_eff = d * MATCH_PX / MATCH_PX_SATURATED if inj.saturated else d
        if d_eff < best_d:
            best, best_d = k, d_eff
    return (best, best_d) if best_d <= MATCH_PX else (-1, best_d)


def candidate_row(stack: mv.FieldStack, c: mv.Candidate) -> dict[str, Any]:
    return {
        "field": stack.meta.get("id"), "det": c.det, "a": c.a, "b": c.b, "x": round(c.x, 2), "y": round(c.y, 2),
        "finder_kind": c.kind, "cand_snr": round(float(c.snr), 2), "flags": ",".join(c.flags),
        "n_dets": len(c.dets), "n_pairs": len(c.pairs),
    }


def label_candidates(
    st: mv.FieldStack, injections: list[Injection], *, threshold: float = mv.SNR_THRESHOLD,
    ctx: FieldContext | None = None,
) -> tuple[np.ndarray, list[int], list[dict[str, Any]], list[mv.Candidate], dict]:
    """Run the finder on an injected field; stamps, labels and rows of candidates matched to injections.

    With ``ctx``, candidates that cannot be credited to their injection (``learnable``) are left out."""
    cands, diffs = mv.find_candidates(st, threshold)
    stamps, labels, rows, kept = [], [], [], []
    for c in cands:
        k, d = match_injection(st, c, injections)
        if k < 0:
            continue
        inj = injections[k]
        exp_snr = 0.0
        if ctx is not None:
            ok, exp_snr = learnable(ctx, inj, c, diffs[c.pair_key].noise_scale)
            if not ok:
                continue
        row = candidate_row(st, c) | {
            "source": "injected", "inj_kind": inj.kind, "inj_snr": round(inj.snr, 2), "inj_speed": round(inj.speed, 3),
            "inj_delta_mag": round(inj.delta_mag, 3), "inj_on_star": inj.on_star, "match_px": round(d, 2),
            "inj_index": k, "expected_snr": round(exp_snr, 2),
        }
        stamps.append(mv.cut_stamp(st, diffs, c))
        labels.append(INJ_LABEL[inj.kind])
        rows.append(row)
        kept.append(c)
    arr = np.stack(stamps) if stamps else np.zeros((0, 4, mv.STAMP_SIZE, mv.STAMP_SIZE), np.float32)
    return arr, labels, rows, kept, diffs


def nothing_stamps(
    st: mv.FieldStack, diffs: dict, cands: list[mv.Candidate], rng: np.random.Generator, n: int,
    on_stars: np.ndarray | None = None,
) -> tuple[np.ndarray, list[dict[str, Any]]]:
    """Stamps at random positions (half on static stars when given) with no candidate within 4 px."""
    keys = list(diffs)
    if not keys:
        return np.zeros((0, 4, mv.STAMP_SIZE, mv.STAMP_SIZE), np.float32), []
    pts = np.array([(c.x, c.y) for c in cands]) if cands else np.zeros((0, 2))
    ny, nx = st.shape
    out, rows = [], []
    tries = 0
    while len(out) < n and tries < 20 * n:
        tries += 1
        if on_stars is not None and len(on_stars) and rng.random() < 0.5:
            x, y = on_stars[int(rng.integers(len(on_stars)))]
            where = "star"
        else:
            x, y = rng.uniform(4, nx - 5), rng.uniform(4, ny - 5)
            where = "blank"
        if len(pts) and np.min(np.hypot(pts[:, 0] - x, pts[:, 1] - y)) < 4.0:
            continue
        key = keys[int(rng.integers(len(keys)))]
        fake = mv.Candidate("variable", float(x), float(y), 0.0, key[0], key[1], key[2], [key[0]], [(key[1], key[2])], [])
        out.append(mv.cut_stamp(st, diffs, fake))
        rows.append({"field": st.meta.get("id"), "det": key[0], "a": key[1], "b": key[2], "x": round(float(x), 2),
                     "y": round(float(y), 2), "finder_kind": "none", "cand_snr": 0.0, "flags": "", "n_dets": 0,
                     "n_pairs": 0, "source": f"nothing-{where}"})
    arr = np.stack(out) if out else np.zeros((0, 4, mv.STAMP_SIZE, mv.STAMP_SIZE), np.float32)
    return arr, rows


def real_labels(stack: mv.FieldStack, cands: list[mv.Candidate], cats: dict[str, Any]) -> list[tuple[str, dict]]:
    """Label of each real candidate: ("mover", match) near a catalogued fast mover, ("skip", match) near a
    SIMBAD variable-type object, else ("artifact", {})."""
    movers = mdata.fast_movers(cats) if cats else []
    variables = mdata.simbad_variables(cats) if cats else []
    out = []
    for c in cands:
        fa = stack.frames[c.det][c.a]
        fb = stack.frames[c.det][c.b]
        pts = [stack.wcs.pixel_to_world_values(px, py) for px, py in _cand_points(c)]
        label, info = "artifact", {}
        for m in movers:
            for mjd in (fa.mjd_mid, fb.mjd_mid):
                ra, dec = mdata.mover_positions(m, mjd)
                if min(float(mdata.sep_arcsec(ra, dec, np.array([p[0]]), np.array([p[1]]))[0]) for p in pts) <= 6.0:
                    label, info = "mover", {"catalog": m["catalog"], "id": m["id"], "pm_masyr": m["pm_masyr"]}
                    break
            if label == "mover":
                break
        if label == "artifact" and variables:
            vra = np.array([v["ra"] for v in variables])
            vdec = np.array([v["dec"] for v in variables])
            for p in pts:
                if np.min(mdata.sep_arcsec(float(p[0]), float(p[1]), vra, vdec)) <= 6.0:
                    label, info = "skip", {"simbad": True}
                    break
        out.append((label, info))
    return out
