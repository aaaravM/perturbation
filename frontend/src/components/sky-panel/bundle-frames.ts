// Turns a FieldManifest into what the Sky panel shows: the blink sequence (Then vs Now first,
// then the visits of the best detector), the catalogue position of the object on each frame, and
// a simplified spectrum built from the bundle's own points.

import { resolveFrameUrl, type DetectorKey, type FieldManifest, type SpectrumPoint } from "@/lib/manifest";

export interface BlinkFrame {
  key: string;
  src: string;
  /** Short name of the frame, e.g. "WISE 2010" or "Aug 2025". */
  label: string;
  /** Instrument and band, e.g. "SPHEREx D6 · 4.40–5.00 µm". */
  detail: string;
  group: "then-now" | "visits";
  mjd: number;
  partial: boolean;
}

const DETECTORS: DetectorKey[] = ["D1", "D2", "D3", "D4", "D5", "D6"];

/** The detector the backend chose for its difference image, else the Then-vs-Now SPHEREx frame's,
 * else the one with the most visits (longer wavelengths first). */
export function bestDetector(m: FieldManifest): DetectorKey | null {
  const counts = (d: DetectorKey) => m.frames.epoch[d]?.length ?? 0;
  const fromDiff = m.frames.difference[0]?.detector;
  if (fromDiff && counts(fromDiff) > 0) return fromDiff;
  for (const f of m.frames.then_vs_now) {
    const hit = /\b(D[1-6])_E\d+/.exec(f.url) ?? /SPHEREx\s+(D[1-6])\b/.exec(f.instrument);
    const d = hit?.[1] as DetectorKey | undefined;
    if (d && counts(d) > 0) return d;
  }
  let best: DetectorKey | null = null;
  for (const d of [...DETECTORS].reverse()) if (counts(d) > (best ? counts(best) : 0)) best = d;
  return best;
}

const um = (v: number) => v.toFixed(2);

export function blinkFrames(
  m: FieldManifest,
  manifestUrl: string,
): { frames: BlinkFrame[]; detector: DetectorKey | null } {
  const frames: BlinkFrame[] = m.frames.then_vs_now.map((f, i) => ({
    key: `tn${i}`,
    src: resolveFrameUrl(manifestUrl, f.url),
    label: f.label,
    detail: f.instrument,
    group: "then-now",
    mjd: f.mjd,
    partial: false,
  }));
  const detector = bestDetector(m);
  if (detector) {
    const list = [...(m.frames.epoch[detector] ?? [])].sort((a, b) => a.mjd - b.mjd);
    for (const f of list) {
      const epoch = m.epochs.find((e) => e.index === f.epoch);
      frames.push({
        key: `${detector}-${f.epoch}`,
        src: resolveFrameUrl(manifestUrl, f.url),
        label: epoch?.label ?? `Visit ${f.epoch + 1}`,
        detail: `SPHEREx ${detector}${f.wl_um ? ` · ${um(f.wl_um[0])}–${um(f.wl_um[1])} µm` : ""}`,
        group: "visits",
        mjd: f.mjd,
        partial: epoch ? !epoch.full : false,
      });
    }
  }
  return { frames, detector };
}

// ------------------------------------------------------------------------------- positions

const D2R = Math.PI / 180;
const MJD_J2000 = 51544.5;

/** Catalogue position (deg) at an MJD from the bundle's astrometry: linear proper motion. */
export function catalogPosition(m: FieldManifest, mjd: number): { ra: number; dec: number } | null {
  const a = m.target?.astrometry;
  if (!a || !Number.isFinite(a.pmra) || !Number.isFinite(a.pmdec)) return null;
  const refMjd = MJD_J2000 + (a.ref_epoch - 2000) * 365.25;
  const years = (mjd - refMjd) / 365.25;
  const dec = a.dec + (a.pmdec * years) / 3.6e6;
  const ra = a.ra + (a.pmra * years) / 3.6e6 / Math.cos(a.dec * D2R);
  return { ra, dec };
}

/** Sky position -> fraction of the frame (0..1 from the left, 0..1 from the top) via grid.wcs (TAN). */
export function skyToFrame(m: FieldManifest, ra: number, dec: number): { x: number; y: number } | null {
  const w = m.grid.wcs;
  const num = (k: string, d = 0) => (typeof w[k] === "number" ? (w[k] as number) : Number(w[k] ?? d));
  const ra0 = num("CRVAL1") * D2R;
  const dec0 = num("CRVAL2") * D2R;
  const r = ra * D2R;
  const d = dec * D2R;
  const cosc = Math.sin(dec0) * Math.sin(d) + Math.cos(dec0) * Math.cos(d) * Math.cos(r - ra0);
  if (!(cosc > 0)) return null;
  const xi = (Math.cos(d) * Math.sin(r - ra0)) / cosc / D2R;
  const eta = (Math.cos(dec0) * Math.sin(d) - Math.sin(dec0) * Math.cos(d) * Math.cos(r - ra0)) / cosc / D2R;
  const c11 = num("CD1_1", num("CDELT1"));
  const c12 = num("CD1_2");
  const c21 = num("CD2_1");
  const c22 = num("CD2_2", num("CDELT2"));
  const det = c11 * c22 - c12 * c21;
  if (!det) return null;
  const p1 = num("CRPIX1") + (c22 * xi - c12 * eta) / det;
  const p2 = num("CRPIX2") + (-c21 * xi + c11 * eta) / det;
  const nx = num("NAXIS1", m.grid.width) || m.grid.width;
  const ny = num("NAXIS2", m.grid.height) || m.grid.height;
  // FITS pixel centres are integers from 1; PNG row 0 is the top (north) row.
  return { x: (p1 - 0.5) / nx, y: (ny + 0.5 - p2) / ny };
}

// ------------------------------------------------------------------------------- spectrum

export interface SpectrumSketch {
  /** Smoothed curve through binned medians, unsaturated points only. */
  curve: { wl: number; flux: number }[];
  points: { wl: number; flux: number; saturated: boolean }[];
  peakWl: number | null;
  source: "points" | "quicklook";
  label: string | null;
  notes: string[];
}

export function spectrumSketch(m: FieldManifest): SpectrumSketch | null {
  const s = m.spectrum;
  if (!s) return null;
  let points: { wl: number; flux: number; saturated: boolean }[] = [];
  let source: SpectrumSketch["source"] = "points";
  let label: string | null = null;
  if (s.points.length > 0) {
    points = s.points
      .filter((p: SpectrumPoint) => Number.isFinite(p.wl_um) && Number.isFinite(p.flux_ujy))
      .map((p) => ({ wl: p.wl_um, flux: p.flux_ujy, saturated: p.saturated }));
  } else if (s.quicklook) {
    source = "quicklook";
    label = s.quicklook.label;
    points = s.quicklook.wl_um
      .map((wl, i) => ({ wl, flux: s.quicklook!.flux_ujy[i], saturated: false }))
      .filter(
        (p): p is { wl: number; flux: number; saturated: boolean } =>
          p.flux !== null && Number.isFinite(p.flux),
      );
  }
  if (points.length === 0) return null;

  // Median per bin in log-wavelength (about 26 bins across 0.75-5 um), unsaturated points only.
  const good = points.filter((p) => !p.saturated).sort((a, b) => a.wl - b.wl);
  const lo = Math.log(0.72);
  const hi = Math.log(5.1);
  const nb = 26;
  const bins: number[][] = Array.from({ length: nb }, () => []);
  const wls: number[][] = Array.from({ length: nb }, () => []);
  for (const p of good) {
    const i = Math.floor(((Math.log(p.wl) - lo) / (hi - lo)) * nb);
    if (i >= 0 && i < nb) {
      bins[i].push(p.flux);
      wls[i].push(p.wl);
    }
  }
  const median = (a: number[]) => {
    const b = [...a].sort((x, y) => x - y);
    const k = Math.floor(b.length / 2);
    return b.length % 2 ? b[k] : (b[k - 1] + b[k]) / 2;
  };
  const curve: { wl: number; flux: number }[] = [];
  for (let i = 0; i < nb; i++) {
    if (bins[i].length) curve.push({ wl: median(wls[i]), flux: median(bins[i]) });
  }
  // Light 3-point smoothing of the medians.
  const smooth = curve.map((p, i) => {
    if (i === 0 || i === curve.length - 1) return p;
    return { wl: p.wl, flux: 0.25 * curve[i - 1].flux + 0.5 * p.flux + 0.25 * curve[i + 1].flux };
  });
  let peakWl: number | null = null;
  let peak = -Infinity;
  for (const p of smooth) if (p.flux > peak) [peak, peakWl] = [p.flux, p.wl];
  return { curve: smooth, points, peakWl, source, label, notes: s.notes ?? [] };
}
