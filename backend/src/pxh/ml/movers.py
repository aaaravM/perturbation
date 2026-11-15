"""Find moving and changing sources in SPHEREx per-epoch co-adds.

Input: a ``FieldStack``, the per-epoch co-adds of one or more detectors on one shared north-up grid (built from
``pxh.api.field.detector_coadds`` or loaded from a survey ``.npz``).

Steps (``find_candidates``):

1. **Difference images.** For every detector, S/N difference images (``pxh.imaging.diff.difference`` with
   ``normalize=True``) of the latest full epoch minus the earliest full epoch, and of each pair of adjacent full
   epochs (all epochs when fewer than two are full). Each S/N map is divided by its own robust scatter (1.4826
   MAD, when above 1), so thresholds are in units of the noise actually measured in that image, not only the
   pipeline variance (crowding and resampling make the real noise larger).
2. **Peaks.** Local maxima of +S/N and of -S/N with ``|S/N| >= threshold`` (default 5), in every difference
   image, merged across detectors and epoch pairs within ``MERGE_RADIUS_PX`` (1.5 px). Peaks touching masked,
   saturated or edge pixels are kept and flagged. The many residual peaks in the wings of one saturated star
   are combined into one positive and one negative group (``merge_saturated``).
3. **Dipoles.** A positive peak (the source's later position) and a negative peak (its earlier position) seen
   in the same epoch pair become a *mover* candidate when their separation fits a motion of at most
   ``MAX_MOTION_ARCSEC_YR`` (30"/yr) over that pair's time baseline (plus 1.5 px for the PSF; at least 2.5 px,
   because even a sub-pixel shift leaves lobes about one PSF width apart). Pairs are matched greedily by the
   weaker lobe's S/N. Every other peak is a *variable* candidate at a fixed position.
4. **Stamps** (``cut_stamp``): 4 channels x 21 x 21 pixels centred on the candidate (a mover's lobe midpoint),
   from the detector and epoch pair where it is strongest. The convention, used identically for training and
   inference (``STAMP_CONVENTION``):

   - channel 0, earliest co-add, and channel 1, latest co-add: per-pixel S/N above the stamp's median,
     ``(I - median) * sqrt(weight)``, compressed as ``asinh(x / 5)``; 0 where a pixel is invalid;
   - channel 2: the S/N difference (step 1, noise-rescaled), ``asinh(x / 5)``; 0 where invalid;
   - channel 3: mask, 1 where either epoch is invalid or saturated or the stamp leaves the grid, else 0.

Measurements: ``measure_motion`` fits a position in every epoch co-add of every detector (a Gaussian ePSF fit,
``pxh.photometry.centroid.fit_epsf``) and a proper motion through them (``pxh.photometry.motion``; parallax is
unknown for a new source and is not removed). ``measure_variability`` runs forced photometry at the fixed
position in the two epochs of the best pair (``fit_epsf`` at a fixed position with a fitted background) and
gives the change in magnitude and its significance. The PSF FWHM is measured from stars in each co-add
(``estimate_fwhm``).

Stamps for people (``stamp_png``): a strip of three 64 x 64 panels (earliest, latest, difference), each a
nearest-neighbour 2x upscale of a 32 x 32 pixel cutout; the two co-adds share one asinh stretch, and in the
difference mid-grey is 0.
"""

from __future__ import annotations

import io
import json
import math
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
from astropy.io import fits
from astropy.wcs import WCS
from PIL import Image
from scipy import ndimage

from pxh import config
from pxh.imaging import diff as diff_mod
from pxh.models import Frame
from pxh.photometry.centroid import fit_epsf
from pxh.photometry.forced import gaussian_epsf
from pxh.photometry.motion import fit_proper_motion

FINDER_VERSION = "movers-1"
SNR_THRESHOLD = 5.0
MERGE_RADIUS_PX = 1.5
MAX_MOTION_ARCSEC_YR = 30.0
MIN_DIPOLE_SEP_PX = 2.5
PSF_SLACK_PX = 1.5
STAMP_SIZE = 21
STAMP_SOFTENING = 5.0
PNG_CUTOUT = 32
PNG_PANEL = 64
DEFAULT_FWHM_PX = 1.7
EDGE_PX = 4
SATURATED_GROW_PX = 4
POSITION_FLOOR_MAS = 150.0  # registration of co-adds between epochs (0.1-0.25" seen in Phase 1)
DAYS_PER_YEAR = 365.25
CLASSES = ("mover", "variable", "artifact", "nothing")

STAMP_CONVENTION = {
    "size": STAMP_SIZE,
    "channels": ["earliest co-add", "latest co-add", "S/N difference (latest - earliest)", "mask"],
    "image_channels": "asinh((I - median of the stamp's valid pixels) * sqrt(weight) / 5); 0 where invalid",
    "difference_channel": "asinh(S/N / 5), S/N divided by the difference image's robust scatter when above 1; "
    "0 where invalid",
    "mask_channel": "1 where either epoch is invalid (weight 0) or saturated, or outside the grid; else 0",
    "softening": STAMP_SOFTENING,
    "centre": "mover: midpoint of the two lobes; variable: the peak; pixel = round(x), round(y)",
    "source": "the detector and epoch pair (later, earlier) where the candidate is strongest",
}


# --- the input: a stack of per-epoch co-adds ------------------------------------------------------------


@dataclass
class FieldStack:
    """Per-epoch co-adds of several detectors on one grid: ``frames[det][epoch]`` and ``saturated[det][epoch]``."""

    wcs: WCS
    shape: tuple[int, int]
    frames: dict[int, dict[int, Frame]]
    saturated: dict[int, dict[int, np.ndarray]]
    full: dict[int, bool]
    epoch_dates: dict[int, tuple[str, str]] = field(default_factory=dict)
    meta: dict[str, Any] = field(default_factory=dict)

    @property
    def dets(self) -> list[int]:
        return sorted(d for d, fr in self.frames.items() if fr)

    @property
    def pixscale_arcsec(self) -> float:
        return float(math.sqrt(abs(np.linalg.det(self.wcs.pixel_scale_matrix))) * 3600.0)

    def copy(self) -> FieldStack:
        frames = {
            d: {e: _copy_frame(fr) for e, fr in eps.items()} for d, eps in self.frames.items()
        }
        sat = {d: {e: m.copy() for e, m in eps.items()} for d, eps in self.saturated.items()}
        return FieldStack(self.wcs, self.shape, frames, sat, dict(self.full), dict(self.epoch_dates), dict(self.meta))


def _copy_frame(fr: Frame) -> Frame:
    return Frame(
        data=np.array(fr.data, dtype=np.float32, copy=True),
        weight=np.array(fr.weight, dtype=np.float32, copy=True),
        wcs=fr.wcs,
        mjd_mid=fr.mjd_mid,
        n_inputs=fr.n_inputs,
        label=fr.label,
        detector=fr.detector,
        epoch_index=fr.epoch_index,
        wavelength_um=fr.wavelength_um,
        meta=dict(fr.meta),
    )


def stack_from_coadds(index: Any, coadds: Iterable[Any], meta: dict[str, Any] | None = None) -> FieldStack:
    """FieldStack from a ``pxh.api.field.FieldIndex`` and its ``DetectorCoadds`` (one per detector)."""
    frames: dict[int, dict[int, Frame]] = {}
    saturated: dict[int, dict[int, np.ndarray]] = {}
    wcs = None
    shape = None
    for co in coadds:
        if not co.frames:
            continue
        frames[int(co.det)] = dict(co.frames)
        saturated[int(co.det)] = {e: np.asarray(m, dtype=bool) for e, m in co.saturated.items()}
        first = next(iter(co.frames.values()))
        wcs, shape = first.wcs, tuple(np.shape(first.data))
    if wcs is None:
        raise ValueError("no detector has any co-add")
    full = {int(e["index"]): bool(e["full"]) for e in index.epoch_entries}
    dates = {int(e["index"]): (str(e["start"]), str(e["end"])) for e in index.epoch_entries}
    return FieldStack(wcs, shape, frames, saturated, full, dates, dict(meta or {}))


def save_stack(path: str | Path, stack: FieldStack) -> None:
    """Write a FieldStack as a compressed ``.npz`` (arrays [det, epoch, y, x]) with the grid WCS header."""
    dets = stack.dets
    epochs = sorted({e for d in dets for e in stack.frames[d]})
    ny, nx = stack.shape
    data = np.full((len(dets), len(epochs), ny, nx), np.nan, dtype=np.float32)
    weight = np.zeros_like(data)
    sat = np.zeros(data.shape, dtype=bool)
    mjd = np.full((len(dets), len(epochs)), np.nan)
    n_in = np.zeros((len(dets), len(epochs)), dtype=np.int32)
    for i, d in enumerate(dets):
        for j, e in enumerate(epochs):
            fr = stack.frames[d].get(e)
            if fr is None:
                continue
            data[i, j] = fr.data
            weight[i, j] = fr.weight
            sat[i, j] = stack.saturated.get(d, {}).get(e, np.zeros(stack.shape, bool))
            mjd[i, j] = fr.mjd_mid
            n_in[i, j] = fr.n_inputs
    header = stack.wcs.to_header().tostring()
    np.savez_compressed(
        path,
        dets=np.array(dets, dtype=np.int32),
        epochs=np.array(epochs, dtype=np.int32),
        data=data,
        weight=weight,
        saturated=sat,
        mjd=mjd,
        n_inputs=n_in,
        full=np.array([bool(stack.full.get(e, False)) for e in epochs]),
        epoch_start=np.array([stack.epoch_dates.get(e, ("", ""))[0] for e in epochs]),
        epoch_end=np.array([stack.epoch_dates.get(e, ("", ""))[1] for e in epochs]),
        wcs_header=np.array(header),
        meta=np.array(json.dumps(stack.meta)),
    )


def load_stack(path: str | Path) -> FieldStack:
    """Read a FieldStack written by ``save_stack``."""
    with np.load(path, allow_pickle=False) as z:
        wcs = WCS(fits.Header.fromstring(str(z["wcs_header"])))
        dets = [int(d) for d in z["dets"]]
        epochs = [int(e) for e in z["epochs"]]
        data, weight, sat, mjd, n_in = z["data"], z["weight"], z["saturated"], z["mjd"], z["n_inputs"]
        full = {e: bool(f) for e, f in zip(epochs, z["full"], strict=True)}
        dates = {e: (str(a), str(b)) for e, a, b in zip(epochs, z["epoch_start"], z["epoch_end"], strict=True)}
        meta = json.loads(str(z["meta"]))
    shape = (int(data.shape[2]), int(data.shape[3]))
    frames: dict[int, dict[int, Frame]] = {}
    saturated: dict[int, dict[int, np.ndarray]] = {}
    for i, d in enumerate(dets):
        frames[d], saturated[d] = {}, {}
        for j, e in enumerate(epochs):
            if not np.isfinite(mjd[i, j]) or not np.any(weight[i, j] > 0):
                continue
            frames[d][e] = Frame(
                data=data[i, j], weight=weight[i, j], wcs=wcs, mjd_mid=float(mjd[i, j]),
                n_inputs=int(n_in[i, j]), label=f"D{d} E{e}", detector=d, epoch_index=e,
            )
            saturated[d][e] = sat[i, j]
    return FieldStack(wcs, shape, frames, saturated, full, dates, meta)


# --- difference images ----------------------------------------------------------------------------------


@dataclass
class DiffMap:
    """One S/N difference image (later epoch ``a`` minus earlier epoch ``b``) of one detector."""

    det: int
    a: int
    b: int
    snr: np.ndarray  # noise-rescaled S/N, NaN where invalid
    noise_scale: float  # robust scatter of the raw S/N map that was divided out (>= 1)
    invalid: np.ndarray  # weight 0 in either epoch
    saturated: np.ndarray  # saturated in either epoch
    mjd_a: float
    mjd_b: float
    long: bool  # the latest-minus-earliest pair
    gap: np.ndarray | None = None  # invalid pixels that are not saturation holes (coverage gaps, bad pixels)

    @property
    def dt_yr(self) -> float:
        return (self.mjd_a - self.mjd_b) / DAYS_PER_YEAR

    @property
    def key(self) -> tuple[int, int, int]:
        return (self.det, self.a, self.b)


def epoch_pairs(stack: FieldStack, det: int) -> list[tuple[int, int, bool]]:
    """(later, earlier, is_long) epoch pairs of one detector: latest - earliest full epoch, then adjacent ones."""
    keys = sorted(stack.frames.get(det, {}))
    full = [e for e in keys if stack.full.get(e, False)]
    use = full if len(full) >= 2 else keys
    if len(use) < 2:
        return []
    pairs = [(use[-1], use[0], True)]
    for i in range(len(use) - 1):
        if (use[i + 1], use[i]) != (use[-1], use[0]):
            pairs.append((use[i + 1], use[i], False))
    return pairs


def difference_maps(stack: FieldStack, dets: Sequence[int] | None = None) -> dict[tuple[int, int, int], DiffMap]:
    """Every S/N difference image the finder uses, keyed by (det, later, earlier)."""
    out: dict[tuple[int, int, int], DiffMap] = {}
    for det in dets if dets is not None else stack.dets:
        for a, b, is_long in epoch_pairs(stack, det):
            fa, fb = stack.frames[det][a], stack.frames[det][b]
            d = diff_mod.difference(fa, fb, normalize=True)
            raw = np.asarray(d.data, dtype=np.float32)
            scale = float(d.meta.get("snr_robust_std") or 1.0)
            scale = scale if math.isfinite(scale) and scale > 1.0 else 1.0
            sat_a = stack.saturated.get(det, {}).get(a)
            sat_b = stack.saturated.get(det, {}).get(b)
            sat = np.zeros(stack.shape, dtype=bool)
            for m in (sat_a, sat_b):
                if m is not None:
                    sat |= np.asarray(m, dtype=bool)
            invalid = ~((fa.weight > 0) & (fb.weight > 0))
            holes = ndimage.binary_dilation(sat, iterations=2) if sat.any() else sat
            out[(det, a, b)] = DiffMap(
                det=det, a=a, b=b, snr=raw / np.float32(scale), noise_scale=scale,
                invalid=invalid, saturated=sat,
                mjd_a=float(fa.mjd_mid), mjd_b=float(fb.mjd_mid), long=is_long, gap=invalid & ~holes,
            )
    return out


# --- peaks ----------------------------------------------------------------------------------------------


@dataclass
class Peak:
    x: float
    y: float
    snr: float  # signed
    det: int
    a: int
    b: int
    dt_yr: float
    flags: frozenset[str]


def peak_flags(dm: DiffMap, ix: int, iy: int) -> frozenset[str]:
    ny, nx = dm.snr.shape
    flags = set()
    if ix < EDGE_PX or iy < EDGE_PX or ix >= nx - EDGE_PX or iy >= ny - EDGE_PX:
        flags.add("edge")
    y0, y1, x0, x1 = max(0, iy - 1), min(ny, iy + 2), max(0, ix - 1), min(nx, ix + 2)
    if dm.invalid[y0:y1, x0:x1].any():
        flags.add("masked")
    y0, y1, x0, x1 = max(0, iy - 2), min(ny, iy + 3), max(0, ix - 2), min(nx, ix + 3)
    if dm.saturated[y0:y1, x0:x1].any():
        flags.add("saturated")
    # a coverage gap (not the hole a saturated star leaves) covering 30% of the 9 x 9 pixels around
    y0, y1, x0, x1 = max(0, iy - 4), min(ny, iy + 5), max(0, ix - 4), min(nx, ix + 5)
    gap = dm.gap if dm.gap is not None else dm.invalid
    if gap[y0:y1, x0:x1].mean() > 0.3:
        flags.add("edge")
    return frozenset(flags)


def find_peaks(dm: DiffMap, threshold: float = SNR_THRESHOLD) -> list[Peak]:
    """Local maxima of +S/N and -S/N at or above ``threshold`` in one difference image."""
    s = np.nan_to_num(dm.snr, nan=0.0)
    ny, nx = s.shape
    out: list[Peak] = []
    for sign in (1.0, -1.0):
        v = sign * s
        mx = ndimage.maximum_filter(v, size=3, mode="constant", cval=0.0)
        ys, xs = np.nonzero((v >= mx) & (v >= threshold))
        for iy, ix in zip(ys.tolist(), xs.tolist(), strict=True):
            y0, y1, x0, x1 = max(0, iy - 1), min(ny, iy + 2), max(0, ix - 1), min(nx, ix + 2)
            w = np.clip(v[y0:y1, x0:x1], 0.0, None)
            tot = float(w.sum())
            if tot > 0:
                yy, xx = np.mgrid[y0:y1, x0:x1]
                px, py = float((w * xx).sum() / tot), float((w * yy).sum() / tot)
            else:
                px, py = float(ix), float(iy)
            out.append(Peak(px, py, float(sign * v[iy, ix]), dm.det, dm.a, dm.b, dm.dt_yr, peak_flags(dm, ix, iy)))
    return out


@dataclass
class Cluster:
    sign: int
    x: float
    y: float
    members: list[Peak]

    @property
    def seed(self) -> Peak:
        return self.members[0]

    @property
    def snr(self) -> float:
        return self.seed.snr


def merge_peaks(peaks: Sequence[Peak], radius: float = MERGE_RADIUS_PX) -> list[Cluster]:
    """Group peaks of the same sign within ``radius`` px (across detectors and pairs), strongest first."""
    clusters: list[Cluster] = []
    cx: list[float] = []
    cy: list[float] = []
    cs: list[int] = []
    for p in sorted(peaks, key=lambda q: -abs(q.snr)):
        sign = 1 if p.snr > 0 else -1
        joined = False
        if clusters:
            d2 = (np.asarray(cx) - p.x) ** 2 + (np.asarray(cy) - p.y) ** 2
            d2[np.asarray(cs) != sign] = np.inf
            k = int(np.argmin(d2))
            if d2[k] <= radius * radius:
                clusters[k].members.append(p)
                joined = True
        if not joined:
            clusters.append(Cluster(sign, p.x, p.y, [p]))
            cx.append(p.x)
            cy.append(p.y)
            cs.append(sign)
    return clusters


# --- candidates -----------------------------------------------------------------------------------------


@dataclass
class Candidate:
    kind: str  # "mover" | "variable"
    x: float  # stamp centre on the grid (0-based pixel)
    y: float
    snr: float  # mover: the stronger lobe's |S/N|; variable: signed S/N (+ brighter, - fainter)
    det: int  # detector of the stamp
    a: int  # later epoch of the stamp's pair
    b: int  # earlier epoch
    dets: list[int]
    pairs: list[tuple[int, int]]
    flags: list[str]
    x_pos: float | None = None  # mover lobes: later (positive) and earlier (negative) positions
    y_pos: float | None = None
    x_neg: float | None = None
    y_neg: float | None = None
    n_peaks: int = 1

    @property
    def pair_key(self) -> tuple[int, int, int]:
        return (self.det, self.a, self.b)


def _sep(p: Peak, n: Peak) -> float:
    return math.hypot(p.x - n.x, p.y - n.y)


def _dipole_limit_px(dt_yr: float, pixscale: float, max_motion: float) -> float:
    return max(MIN_DIPOLE_SEP_PX, max_motion * abs(dt_yr) / pixscale + PSF_SLACK_PX)


def pair_dipoles(
    clusters: Sequence[Cluster], pixscale: float = config.PIXEL_SCALE_ARCSEC,
    max_motion: float = MAX_MOTION_ARCSEC_YR,
) -> list[Candidate]:
    """Movers from positive/negative clusters seen in the same epoch pair; the rest become variables."""
    pos = [i for i, c in enumerate(clusters) if c.sign > 0]
    neg = [i for i, c in enumerate(clusters) if c.sign < 0]
    reach = max_motion * 2.5 / pixscale + PSF_SLACK_PX  # no baseline is longer than ~2.5 yr
    options: list[tuple[float, int, int, Peak, Peak]] = []
    for i in pos:
        P = clusters[i]
        for j in neg:
            N = clusters[j]
            if math.hypot(P.x - N.x, P.y - N.y) > reach:
                continue
            best: tuple[float, Peak, Peak] | None = None
            for p in P.members:
                for n in N.members:
                    if (p.a, p.b) != (n.a, n.b):
                        continue
                    if _sep(p, n) <= _dipole_limit_px(p.dt_yr, pixscale, max_motion):
                        score = min(abs(p.snr), abs(n.snr))
                        if best is None or score > best[0]:
                            best = (score, p, n)
            if best is not None:
                options.append((best[0], i, j, best[1], best[2]))
    used: set[int] = set()
    out: list[Candidate] = []
    for _score, i, j, p, n in sorted(options, key=lambda o: -o[0]):
        if i in used or j in used:
            continue
        used.update((i, j))
        members = clusters[i].members + clusters[j].members
        stamp_det = p.det if abs(p.snr) >= abs(n.snr) else n.det
        out.append(Candidate(
            kind="mover",
            x=0.5 * (p.x + n.x), y=0.5 * (p.y + n.y),
            snr=max(abs(p.snr), abs(n.snr)),
            det=stamp_det, a=p.a, b=p.b,
            dets=sorted({m.det for m in members}),
            pairs=sorted({(m.a, m.b) for m in members}),
            flags=sorted({f for m in members for f in m.flags}),
            x_pos=p.x, y_pos=p.y, x_neg=n.x, y_neg=n.y,
            n_peaks=len(members),
        ))
    # peaks left on a mover's track (intermediate epochs) belong to that mover
    rest: list[Cluster] = []
    for k, c in enumerate(clusters):
        if k in used:
            continue
        host = next((m for m in out if _segment_distance(c.x, c.y, m) <= MERGE_RADIUS_PX), None)
        if host is None:
            rest.append(c)
            continue
        host.dets = sorted(set(host.dets) | {p.det for p in c.members})
        host.pairs = sorted(set(host.pairs) | {(p.a, p.b) for p in c.members})
        host.flags = sorted(set(host.flags) | {f for p in c.members for f in p.flags})
        host.n_peaks += len(c.members)
    # one variable per position: a source that brightened in one pair and faded in another gives clusters of
    # both signs at the same place
    groups: list[list[Cluster]] = []
    for c in sorted(rest, key=lambda q: -abs(q.snr)):
        g = next((g for g in groups if math.hypot(g[0].x - c.x, g[0].y - c.y) <= MERGE_RADIUS_PX), None)
        if g is None:
            groups.append([c])
        else:
            g.append(c)
    for g in groups:
        s = g[0].seed
        members = [p for c in g for p in c.members]
        out.append(Candidate(
            kind="variable", x=s.x, y=s.y, snr=s.snr, det=s.det, a=s.a, b=s.b,
            dets=sorted({m.det for m in members}),
            pairs=sorted({(m.a, m.b) for m in members}),
            flags=sorted({f for m in members for f in m.flags}),
            n_peaks=len(members),
        ))
    return out


def _segment_distance(x: float, y: float, m: Candidate) -> float:
    """Distance (px) from (x, y) to the segment between a mover's two lobes."""
    ax, ay, bx, by = m.x_neg, m.y_neg, m.x_pos, m.y_pos
    dx, dy = bx - ax, by - ay
    L2 = dx * dx + dy * dy
    t = 0.0 if L2 == 0 else max(0.0, min(1.0, ((x - ax) * dx + (y - ay) * dy) / L2))
    return math.hypot(x - (ax + t * dx), y - (ay + t * dy))


def find_candidates(
    stack: FieldStack,
    threshold: float = SNR_THRESHOLD,
    *,
    diffs: dict[tuple[int, int, int], DiffMap] | None = None,
    dets: Sequence[int] | None = None,
    merge_radius: float = MERGE_RADIUS_PX,
    max_motion: float = MAX_MOTION_ARCSEC_YR,
) -> tuple[list[Candidate], dict[tuple[int, int, int], DiffMap]]:
    """Mover and variable candidates of a field, with the difference images they came from."""
    diffs = diffs if diffs is not None else difference_maps(stack, dets)
    peaks = [p for dm in diffs.values() for p in find_peaks(dm, threshold)]
    clusters = merge_saturated(merge_peaks(peaks, merge_radius), diffs, stack.shape)
    cands = pair_dipoles(clusters, stack.pixscale_arcsec, max_motion)
    cands.sort(key=lambda c: -abs(c.snr))
    return cands, diffs


def merge_saturated(
    clusters: list[Cluster], diffs: dict[tuple[int, int, int], DiffMap], shape: tuple[int, int],
    grow_px: int = SATURATED_GROW_PX,
) -> list[Cluster]:
    """One positive and one negative cluster per saturated star.

    A saturated core leaves many residual peaks in its wings. Clusters whose strongest peak lies within
    ``grow_px`` of the same connected saturated region (any detector or epoch) are combined: the strongest
    positive and the strongest negative cluster keep the other clusters' peaks as members (so detectors,
    pairs and flags are kept), and the dipole step then decides between a mover and a variable.
    """
    sat = np.zeros(shape, dtype=bool)
    for dm in diffs.values():
        sat |= dm.saturated
    if not sat.any() or not clusters:
        return clusters
    # each pixel's nearest saturated pixel, and that pixel's connected region (regions are not grown, so
    # two stars only share a group when their saturated pixels touch)
    labels, _ = ndimage.label(sat)
    dist, (iy_near, ix_near) = ndimage.distance_transform_edt(~sat, return_indices=True)
    groups: dict[int, list[int]] = {}
    for k, c in enumerate(clusters):
        iy = min(shape[0] - 1, max(0, round(c.seed.y)))
        ix = min(shape[1] - 1, max(0, round(c.seed.x)))
        if dist[iy, ix] <= grow_px:
            groups.setdefault(int(labels[iy_near[iy, ix], ix_near[iy, ix]]), []).append(k)
    drop: set[int] = set()
    for members in groups.values():
        if len(members) < 2:
            continue
        keep = {}
        for sign in (1, -1):
            same = [k for k in members if clusters[k].sign == sign]
            if same:
                keep[sign] = max(same, key=lambda k: abs(clusters[k].snr))
        for k in members:
            target = keep.get(clusters[k].sign)
            if target is None or k == target:
                continue
            clusters[target].members.extend(clusters[k].members)
            drop.add(k)
    return [c for k, c in enumerate(clusters) if k not in drop]


# --- stamps for the classifier ---------------------------------------------------------------------------


def _cut(arr: np.ndarray, cx: int, cy: int, size: int, fill: float) -> np.ndarray:
    half = size // 2
    ny, nx = arr.shape
    out = np.full((size, size), fill, dtype=np.float64)
    y0, x0 = cy - half, cx - half
    ys0, xs0 = max(0, y0), max(0, x0)
    ys1, xs1 = min(ny, y0 + size), min(nx, x0 + size)
    if ys1 > ys0 and xs1 > xs0:
        out[ys0 - y0 : ys1 - y0, xs0 - x0 : xs1 - x0] = arr[ys0:ys1, xs0:xs1]
    return out


def image_channel(data: np.ndarray, weight: np.ndarray) -> np.ndarray:
    """Stamp convention for a co-add cutout: asinh of the per-pixel S/N above the median, 0 where invalid."""
    ok = (weight > 0) & np.isfinite(data)
    if int(ok.sum()) >= 5:
        bkg = float(np.median(data[ok]))
    else:
        bkg = 0.0
    s = np.where(ok, (np.where(ok, data, 0.0) - bkg) * np.sqrt(np.where(ok, weight, 0.0)), 0.0)
    return np.arcsinh(s / STAMP_SOFTENING)


def normalise_stamp(
    early: np.ndarray, w_early: np.ndarray, late: np.ndarray, w_late: np.ndarray, snr: np.ndarray,
    mask: np.ndarray,
) -> np.ndarray:
    """The 4 x N x N classifier input (see STAMP_CONVENTION) from cutouts of the two epochs and the S/N map."""
    ch_d = np.arcsinh(np.nan_to_num(snr, nan=0.0, posinf=0.0, neginf=0.0) / STAMP_SOFTENING)
    return np.stack([
        image_channel(early, w_early),
        image_channel(late, w_late),
        np.where(mask > 0, np.where(np.isfinite(snr), ch_d, 0.0), ch_d),
        mask.astype(np.float64),
    ]).astype(np.float32)


def cut_stamp(
    stack: FieldStack, diffs: dict[tuple[int, int, int], DiffMap], cand: Candidate, size: int = STAMP_SIZE,
    *, key: tuple[int, int, int] | None = None, x: float | None = None, y: float | None = None,
) -> np.ndarray:
    """Classifier stamp (4 x size x size, float32) of a candidate from its detector and epoch pair."""
    det, a, b = key or cand.pair_key
    dm = diffs[(det, a, b)]
    fa, fb = stack.frames[det][a], stack.frames[det][b]
    cx = round(cand.x if x is None else x)
    cy = round(cand.y if y is None else y)
    inside = _cut(np.ones(stack.shape), cx, cy, size, 0.0) > 0
    mask = _cut((dm.invalid | dm.saturated).astype(float), cx, cy, size, 1.0)
    mask = np.where(inside, mask, 1.0)
    return normalise_stamp(
        _cut(np.asarray(fb.data, float), cx, cy, size, np.nan), _cut(np.asarray(fb.weight, float), cx, cy, size, 0.0),
        _cut(np.asarray(fa.data, float), cx, cy, size, np.nan), _cut(np.asarray(fa.weight, float), cx, cy, size, 0.0),
        _cut(np.asarray(dm.snr, float), cx, cy, size, np.nan),
        mask,
    )


def cut_stamps(
    stack: FieldStack, diffs: dict[tuple[int, int, int], DiffMap], cands: Sequence[Candidate]
) -> np.ndarray:
    if not cands:
        return np.zeros((0, 4, STAMP_SIZE, STAMP_SIZE), dtype=np.float32)
    return np.stack([cut_stamp(stack, diffs, c) for c in cands])


# --- PSF width --------------------------------------------------------------------------------------------


def estimate_fwhm(frame: Frame, saturated: np.ndarray | None = None, default: float = DEFAULT_FWHM_PX) -> float:
    """Median FWHM (px) of isolated, unsaturated stars at S/N 20-1000 in a co-add (second moments)."""
    d = np.asarray(frame.data, dtype=float)
    w = np.asarray(frame.weight, dtype=float)
    ok = (w > 0) & np.isfinite(d)
    if ok.sum() < 100:
        return default
    bkg = float(np.median(d[ok]))
    s = np.where(ok, (d - bkg) * np.sqrt(np.where(ok, w, 0.0)), 0.0)
    mx = ndimage.maximum_filter(s, size=7, mode="constant")
    ys, xs = np.nonzero((s == mx) & (s >= 20) & (s <= 1000))
    ny, nx = d.shape
    fwhms = []
    for iy, ix in zip(ys.tolist(), xs.tolist(), strict=True):
        if iy < 4 or ix < 4 or iy >= ny - 4 or ix >= nx - 4:
            continue
        box = (slice(iy - 3, iy + 4), slice(ix - 3, ix + 4))
        if not ok[box].all() or (saturated is not None and np.asarray(saturated)[box].any()):
            continue
        sub = d[box] - bkg
        # isolated: nothing above a quarter of the peak outside the central 3x3
        outer = sub.copy()
        outer[2:5, 2:5] = -np.inf
        if outer.max() > 0.25 * sub[3, 3]:
            continue
        sub = np.clip(sub, 0.0, None)
        tot = sub.sum()
        if tot <= 0:
            continue
        yy, xx = np.mgrid[-3:4, -3:4]
        mxx = float((sub * xx).sum() / tot)
        myy = float((sub * yy).sum() / tot)
        var = float((sub * ((xx - mxx) ** 2 + (yy - myy) ** 2)).sum() / tot) / 2.0
        if var > 0:
            fwhms.append(2.3548 * math.sqrt(var))
    if len(fwhms) < 3:
        return default
    return float(np.clip(np.median(fwhms), 1.0, 3.5))


# --- measurements -------------------------------------------------------------------------------------------


def _pix_to_world(wcs: WCS, x: float, y: float) -> tuple[float, float]:
    ra, dec = wcs.pixel_to_world_values(x, y)
    return float(ra) % 360.0, float(dec)


def candidate_world(stack: FieldStack, cand: Candidate) -> tuple[float, float]:
    """Sky position of a candidate: a mover's later (positive-lobe) position, a variable's peak."""
    if cand.kind == "mover" and cand.x_pos is not None:
        return _pix_to_world(stack.wcs, cand.x_pos, cand.y_pos)
    return _pix_to_world(stack.wcs, cand.x, cand.y)


def _variance(fr: Frame) -> tuple[np.ndarray, np.ndarray]:
    w = np.asarray(fr.weight, dtype=float)
    valid = (w > 0) & np.isfinite(fr.data)
    with np.errstate(divide="ignore"):
        var = np.where(valid, 1.0 / np.where(valid, w, 1.0), np.nan)
    return var, valid


def measure_motion(
    stack: FieldStack, cand: Candidate, fwhm: dict[int, float] | None = None, min_snr: float = 3.0
) -> dict[str, Any] | None:
    """Proper motion of a mover from ePSF positions in every epoch co-add (None if it cannot be fitted)."""
    if cand.kind != "mover" or cand.x_pos is None:
        return None
    mjd_a = stack.frames[cand.det][cand.a].mjd_mid
    mjd_b = stack.frames[cand.det][cand.b].mjd_mid
    span = mjd_a - mjd_b
    if span <= 0:
        return None
    vx = (cand.x_pos - cand.x_neg) / span
    vy = (cand.y_pos - cand.y_neg) / span
    ny, nx = stack.shape
    t, ras, decs, errs, eps = [], [], [], [], []
    for det in stack.dets:
        epsf = gaussian_epsf((fwhm or {}).get(det, DEFAULT_FWHM_PX))
        for e, fr in stack.frames[det].items():
            xp = cand.x_neg + vx * (fr.mjd_mid - mjd_b)
            yp = cand.y_neg + vy * (fr.mjd_mid - mjd_b)
            if not (2 <= xp < nx - 2 and 2 <= yp < ny - 2):
                continue
            var, valid = _variance(fr)
            fit = fit_epsf(np.asarray(fr.data, float), var, valid, epsf, xp, yp, box=5,
                           fit_position=True, fit_background=True, max_shift=1.5, search_radius=0.5)
            if not fit.ok or not (fit.flux_err > 0) or fit.flux / fit.flux_err < min_snr:
                continue
            if not (math.isfinite(fit.x_err) and math.isfinite(fit.y_err)):
                continue
            ra, dec = _pix_to_world(stack.wcs, fit.x, fit.y)
            err = math.hypot(0.5 * (fit.x_err + fit.y_err) * stack.pixscale_arcsec * 1000.0, POSITION_FLOOR_MAS)
            t.append(fr.mjd_mid)
            ras.append(ra)
            decs.append(dec)
            errs.append(err)
            eps.append(e)
    if len(t) < 3 or len(set(eps)) < 2:
        return None
    try:
        mf = fit_proper_motion(t, ras, decs, errs, errs)
    except ValueError:
        return None
    used_epochs = {e for e, u in zip(eps, mf.used, strict=True) if u}
    return {
        "pm_arcsec_yr": round(mf.total_masyr / 1000.0, 4),
        "pm_err_arcsec_yr": round(mf.total_err_masyr / 1000.0, 4),
        "pa_deg": round(float(mf.pa_deg), 2),
        "n_epochs": len(used_epochs),
        "pmra_masyr": round(mf.pmra_masyr, 1),
        "pmdec_masyr": round(mf.pmdec_masyr, 1),
        "chi2_red": round(float(mf.chi2_red), 3) if math.isfinite(mf.chi2_red) else None,
        "n_positions": int(mf.n_used),
        "ref_mjd": round(mf.ref_mjd, 3),
        "ra_ref": round(mf.ra0_deg, 6),
        "dec_ref": round(mf.dec0_deg, 6),
    }


def forced_flux(fr: Frame, x: float, y: float, fwhm: float) -> tuple[float, float]:
    """PSF flux (MJy/sr x px) and its error at a fixed position, with a fitted constant background."""
    var, valid = _variance(fr)
    fit = fit_epsf(np.asarray(fr.data, float), var, valid, gaussian_epsf(fwhm), x, y, box=7,
                   fit_position=False, fit_background=True)
    if not fit.ok or not math.isfinite(fit.flux_err) or fit.flux_err <= 0:
        return math.nan, math.nan
    return float(fit.flux), float(fit.flux_err)


def measure_variability(
    stack: FieldStack, diffs: dict[tuple[int, int, int], DiffMap], cand: Candidate,
    fwhm: dict[int, float] | None = None,
) -> dict[str, Any] | None:
    """Change in magnitude (later minus earlier; negative = brighter) and its significance, from forced
    photometry at the candidate's position in the two epochs of its pair.

    Errors are scaled by the difference image's noise scale. When one flux is below 2 sigma, that flux is
    replaced by its 2-sigma limit, so ``delta_mag`` is then a limit on the change (``limit`` is True).
    """
    if cand.kind != "variable":
        return None
    fw = (fwhm or {}).get(cand.det, DEFAULT_FWHM_PX)
    scale = diffs[cand.pair_key].noise_scale
    f_late, e_late = forced_flux(stack.frames[cand.det][cand.a], cand.x, cand.y, fw)
    f_early, e_early = forced_flux(stack.frames[cand.det][cand.b], cand.x, cand.y, fw)
    if not all(math.isfinite(v) for v in (f_late, e_late, f_early, e_early)):
        return None
    e_late, e_early = e_late * scale, e_early * scale
    sigma = abs(f_late - f_early) / math.hypot(e_late, e_early)
    lo_late, lo_early = max(f_late, 2 * e_late), max(f_early, 2 * e_early)
    limit = f_late < 2 * e_late or f_early < 2 * e_early
    delta = -2.5 * math.log10(lo_late / lo_early)
    return {
        "delta_mag": round(delta, 3),
        "sigma": round(sigma, 2),
        "limit": bool(limit),
        "flux_early": f_early, "flux_late": f_late, "flux_err_early": e_early, "flux_err_late": e_late,
    }


def measure_all(
    stack: FieldStack, diffs: dict[tuple[int, int, int], DiffMap], cands: Sequence[Candidate]
) -> list[dict[str, Any]]:
    """``{motion, variability}`` for every candidate (one FWHM per detector, measured from its latest co-add)."""
    fwhm = {}
    for det in stack.dets:
        last = max(stack.frames[det])
        fwhm[det] = estimate_fwhm(stack.frames[det][last], stack.saturated.get(det, {}).get(last))
    out = []
    for c in cands:
        out.append({
            "motion": measure_motion(stack, c, fwhm) if c.kind == "mover" else None,
            "variability": measure_variability(stack, diffs, c, fwhm) if c.kind == "variable" else None,
        })
    return out


# --- stamps for people --------------------------------------------------------------------------------------


def _asinh_levels(arr: np.ndarray, valid: np.ndarray, bkg: float, noise: float, top: float) -> np.ndarray:
    beta = max(noise, 1e-12)
    norm = math.asinh(max(top - bkg, beta) / beta)
    lev = np.arcsinh(np.clip(arr - bkg, 0.0, None) / beta) / norm
    return np.where(valid, np.clip(lev, 0.0, 1.0) * 255.0, 0.0)


def stamp_png(
    stack: FieldStack, diffs: dict[tuple[int, int, int], DiffMap], cand: Candidate, cutout: int = PNG_CUTOUT,
    panel: int = PNG_PANEL,
) -> bytes:
    """Grey PNG strip (3 x ``panel`` by ``panel``): earliest co-add, latest co-add, S/N difference."""
    dm = diffs[cand.pair_key]
    fa, fb = stack.frames[cand.det][cand.a], stack.frames[cand.det][cand.b]
    cx, cy = round(cand.x), round(cand.y)

    def cut(arr: np.ndarray, fill: float) -> np.ndarray:
        # an even cutout keeps pixels cx-16 .. cx+15: the candidate is at the panel centre to half a pixel
        size = cutout + 1 if cutout % 2 == 0 else cutout
        return _cut(np.asarray(arr, float), cx, cy, size, fill)[:cutout, :cutout]

    e_d, e_w = cut(fb.data, np.nan), cut(fb.weight, 0.0)
    l_d, l_w = cut(fa.data, np.nan), cut(fa.weight, 0.0)
    s = cut(dm.snr, np.nan)
    ve, vl = (e_w > 0) & np.isfinite(e_d), (l_w > 0) & np.isfinite(l_d)
    both = np.concatenate([e_d[ve], l_d[vl]])
    if both.size:
        bkg = float(np.median(both))
        noise = float(1.4826 * np.median(np.abs(both - bkg))) or float(np.std(both)) or 1.0
        top = float(np.percentile(both, 99.5))
    else:
        bkg, noise, top = 0.0, 1.0, 1.0
    p1 = _asinh_levels(e_d, ve, bkg, noise, top)
    p2 = _asinh_levels(l_d, vl, bkg, noise, top)
    fin = np.isfinite(s)
    lim = max(5.0, float(np.percentile(np.abs(s[fin]), 99.0))) if fin.any() else 5.0
    p3 = np.where(fin, 127.5 + 127.5 * np.clip(np.nan_to_num(s) / lim, -1.0, 1.0), 127.5)
    k = max(1, panel // cutout)
    # grid row 0 is south: flip so north is up (east stays left), as in every other PNG of the app
    strip = np.concatenate([np.kron(np.flipud(p), np.ones((k, k))) for p in (p1, p2, p3)], axis=1)
    img = Image.fromarray(np.round(strip).astype(np.uint8), mode="L")
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()
