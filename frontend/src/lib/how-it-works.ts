// Data for the How it works page, read at build time from the prepared target bundles
// (public/bundles/<slug>/manifest.json) and from the Phase 1 report (docs/data-findings.md, whose
// numbers come from docs/phase1/<slug>/summary.json). Server only: it reads files from disk.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { FieldManifest } from "@/lib/manifest";

async function readBundle(slug: string): Promise<FieldManifest | null> {
  try {
    const raw = await readFile(join(process.cwd(), "public", "bundles", slug, "manifest.json"), "utf8");
    return JSON.parse(raw) as FieldManifest;
  } catch {
    return null;
  }
}

/** Days since 1858-11-17 (MJD) to a JavaScript time in ms. */
export const mjdToMs = (mjd: number) => (mjd - 40587) * 86_400_000;

/** The six detectors: wavelength range read from the image files and resolving power (data-findings §3). */
export const DETECTOR_TABLE = [
  { key: "D1", lo: 0.746, hi: 1.117, r: 39 },
  { key: "D2", lo: 1.103, hi: 1.65, r: 41 },
  { key: "D3", lo: 1.63, hi: 2.435, r: 41 },
  { key: "D4", lo: 2.403, hi: 3.847, r: 35 },
  { key: "D5", lo: 3.811, hi: 4.43, r: 112 },
  { key: "D6", lo: 4.412, hi: 5.01, r: 128 },
] as const;

export interface TimelineEpoch {
  index: number;
  label: string;
  start: string;
  end: string;
  survey: string;
  pa: number;
  exposures: number;
  full: boolean;
  perDetector: number[];
}

export interface TrackPoint {
  label: string;
  t: number;
  /** Arcseconds north of where the catalogue puts the star at the first visit. */
  north: number;
  east: number;
  err: number;
}

export interface SpectrumData {
  points: { wl: number; mjy: number }[];
  median: { wl: number; mjy: number }[];
  saturated: number;
}

export interface BlinkData {
  before: { url: string; label: string; n: number };
  after: { url: string; label: string; n: number };
  difference: { url: string; limit: number };
  band: [number, number];
  pixelArcsec: number;
  gridPx: number;
}

export interface HowData {
  epochs: TimelineEpoch[];
  span: { first: string; last: string; days: number; exposures: number };
  renderNote: string | null;
  track: null | {
    measured: TrackPoint[];
    predicted: { t: number; north: number }[];
    fit: { speed: number; err: number; pa: number };
    catalog: { speed: number; pa: number; source: string };
  };
  spectrum: SpectrumData | null;
  /** Epsilon Indi B in the 102 channels of the DR1 cube (quick-look; null where a channel has no data). */
  quicklook: { wl: number[]; mjy: (number | null)[] } | null;
  blink: BlinkData | null;
}

const BARNARD = "barnards-star";
const EPS_INDI_B = "eps-indi-b";

export async function loadHowData(): Promise<HowData> {
  const [barnard, eps] = await Promise.all([readBundle(BARNARD), readBundle(EPS_INDI_B)]);

  const epochs: TimelineEpoch[] = (barnard?.epochs ?? []).map((e) => ({
    index: e.index,
    label: e.label,
    start: e.start,
    end: e.end,
    survey: e.survey,
    pa: e.pa,
    exposures: e.n_exposures,
    full: e.full,
    perDetector: ["1", "2", "3", "4", "5", "6"].map((d) => e.detectors[d as "1"] ?? 0),
  }));
  const first = epochs[0]?.start ?? "";
  const last = epochs.at(-1)?.end ?? "";
  const days = first && last ? Math.round((Date.parse(last) - Date.parse(first)) / 86_400_000) : 0;

  return {
    epochs,
    span: { first, last, days, exposures: epochs.reduce((s, e) => s + e.exposures, 0) },
    renderNote: barnard?.render?.note ?? null,
    track: barnard ? barnardTrack(barnard) : null,
    spectrum: eps ? epsSpectrum(eps) : null,
    quicklook: eps ? epsQuicklook(eps) : null,
    blink: barnard ? barnardBlink(barnard) : null,
  };
}

function barnardTrack(m: FieldManifest): HowData["track"] {
  const motion = m.motion;
  if (!motion?.fit || !motion.catalog || motion.predicted_path.length !== m.epochs.length) return null;
  const [ra0, dec0] = motion.predicted_path[0];
  const cos = Math.cos((dec0 * Math.PI) / 180);
  const north = (dec: number) => (dec - dec0) * 3600;
  const east = (ra: number) => (ra - ra0) * cos * 3600;
  const label = (i: number) => m.epochs.find((e) => e.index === i)?.label ?? `Visit ${i + 1}`;
  return {
    measured: motion.epoch_positions.map((p) => ({
      label: label(p.epoch),
      t: mjdToMs(p.mjd),
      north: north(p.dec),
      east: east(p.ra),
      err: p.err_mas / 1000,
    })),
    predicted: motion.predicted_path.map(([, dec], i) => ({ t: mjdToMs(m.epochs[i].mjd_mid), north: north(dec) })),
    fit: { speed: motion.fit.total_arcsec_yr, err: motion.fit.total_err, pa: motion.fit.pa_deg },
    catalog: { speed: motion.catalog.total_arcsec_yr, pa: motion.catalog.pa_deg, source: motion.catalog.source },
  };
}

/** Single-exposure fluxes in mJy, and a running median in 0.05 µm bins. */
function epsSpectrum(m: FieldManifest): SpectrumData | null {
  const pts = (m.spectrum?.points ?? []).filter((p) => Number.isFinite(p.flux_ujy) && Number.isFinite(p.wl_um));
  if (!pts.length) return null;
  const clean = pts.filter((p) => !p.saturated);
  const points = clean.map((p) => ({ wl: round(p.wl_um, 4), mjy: round(p.flux_ujy / 1000, 3) }));
  const bins = new Map<number, number[]>();
  for (const p of points) {
    const b = Math.round(p.wl / 0.05);
    bins.set(b, [...(bins.get(b) ?? []), p.mjy]);
  }
  const median = [...bins.entries()]
    .filter(([, v]) => v.length >= 2)
    .sort(([a], [b]) => a - b)
    .map(([b, v]) => {
      const s = [...v].sort((x, y) => x - y);
      const mid = s.length / 2;
      const med = s.length % 2 ? s[Math.floor(mid)] : (s[mid - 1] + s[mid]) / 2;
      return { wl: round(b * 0.05, 3), mjy: round(med, 3) };
    });
  return { points, median, saturated: pts.length - clean.length };
}

function epsQuicklook(m: FieldManifest): HowData["quicklook"] {
  const q = m.spectrum?.quicklook;
  if (!q || q.wl_um.length !== 102 || q.flux_ujy.length !== 102) return null;
  return {
    wl: q.wl_um.map((v) => round(v, 3)),
    mjy: q.flux_ujy.map((v) => (v === null || !Number.isFinite(v) ? null : round(v / 1000, 2))),
  };
}

function barnardBlink(m: FieldManifest): BlinkData | null {
  const d6 = m.frames.epoch.D6 ?? [];
  const before = d6.find((f) => f.epoch === 0);
  const after = d6.find((f) => f.epoch === 4);
  const diff = m.frames.difference.find((f) => f.detector === "D6");
  if (!before || !after || !diff) return null;
  const label = (i: number) => m.epochs.find((e) => e.index === i)?.label ?? "";
  const base = `/bundles/${BARNARD}/`;
  return {
    before: { url: base + before.url, label: label(0), n: before.n ?? 0 },
    after: { url: base + after.url, label: label(4), n: after.n ?? 0 },
    difference: { url: base + diff.url, limit: Math.max(Math.abs(diff.limits[0]), Math.abs(diff.limits[1])) },
    band: before.wl_um ?? [4.412, 5.01],
    pixelArcsec: m.grid.pixscale_arcsec,
    gridPx: m.grid.width,
  };
}

const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;

/** The challenge's five test targets: what SPHEREx measured here against the catalogues. */
export interface ValidationRow {
  target: string;
  quantity: string;
  measured: string;
  catalogue: string;
  agreement: string;
  ok: boolean;
}

/** From docs/data-findings.md §6 (numbers in docs/phase1/<slug>/summary.json). */
export const VALIDATION_ROWS: ValidationRow[] = [
  {
    target: "Barnard’s Star",
    quantity: "Speed across the sky",
    measured: "10.55 ± 0.12″ a year",
    catalogue: "10.41″ a year (Gaia DR3)",
    agreement: "Within 1.3%",
    ok: true,
  },
  {
    target: "Barnard’s Star",
    quantity: "Direction of motion",
    measured: "349.4°",
    catalogue: "355.6° (Gaia DR3)",
    agreement: "6.2° off, inside the 10° allowed; one biased visit",
    ok: true,
  },
  {
    target: "Epsilon Indi B",
    quantity: "Speed and direction",
    measured: "4.699 ± 0.016″ a year toward 121.5°",
    catalogue: "4.685″ a year toward 121.8° (Gaia DR3)",
    agreement: "Within 0.3% and 0.3°",
    ok: true,
  },
  {
    target: "WISE 0855−0714",
    quantity: "Shift, May 2025 to May 2026",
    measured: "7.98 ± 0.77″",
    catalogue: "8.04″ predicted (Kirkpatrick et al. 2021)",
    agreement: "Ratio 0.99, direction within 0.2°",
    ok: true,
  },
  {
    target: "RW Aurigae",
    quantity: "Brightness at 3.8–4.4 µm, Sep 2025 to Sep 2026",
    measured: "Faded 0.86 ± 0.04 magnitudes",
    catalogue: "No catalogue value for these dates",
    agreement: "A real change: 23 times its uncertainty",
    ok: true,
  },
  {
    target: "RW Aurigae",
    quantity: "Speed across the sky",
    measured: "0.52 ± 0.07″ a year",
    catalogue: "0.03″ a year (Gaia DR3)",
    agreement: "Does not agree; a close companion star is the likely cause",
    ok: false,
  },
  {
    target: "R Draconis",
    quantity: "Pulsation, 839 exposures",
    measured: "Brightest at phase 0.03; amplitude 0.355 ± 0.018 magnitudes",
    catalogue: "246.12-day period and date of maximum (VSX)",
    agreement: "Peak within 0.03 of a cycle, about 7 days",
    ok: true,
  },
];
