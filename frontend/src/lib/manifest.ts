// FieldManifest: the one data shape shared by static bundles and the live backend.
// Source of truth: docs/api-contract.md (keep the two in sync).

export type TargetKind = "high-pm-star" | "brown-dwarf" | "young-variable" | "mira-variable" | "bright-star";
export type DetectorKey = "D1" | "D2" | "D3" | "D4" | "D5" | "D6";

export interface Fact {
  label: string;
  value: string;
}

export interface ManifestTarget {
  key: string;
  name: string;
  kind: TargetKind;
  aliases: string[];
  simbad_id?: string;
  /** 2-3 sentences for the public (Sky mode). */
  summary_plain: string;
  facts: Fact[];
  astrometry: {
    ra: number;
    dec: number;
    ref_epoch: number;
    pmra: number;
    pmdec: number;
    parallax?: number | null;
    rv?: number | null;
    source: string;
  };
}

export interface Epoch {
  index: number;
  label: string;
  /** S1 = PA 0 (Year 1), S2 = PA 180 (Year 1), S3/S4 = Year 2. */
  survey: string;
  year: number;
  pa: number;
  start: string;
  end: string;
  mjd_mid: number;
  n_exposures: number;
  detectors: Partial<Record<"1" | "2" | "3" | "4" | "5" | "6", number>>;
  /** false = partial epoch: grey it out and say so. */
  full: boolean;
}

export interface EpochFrame {
  epoch: number;
  url: string;
  mjd: number;
  n?: number;
  wl_um?: [number, number];
  channels?: string;
}

export interface ThenNowFrame {
  label: string;
  url: string;
  mjd: number;
  instrument: string;
}

export interface DifferenceFrame {
  detector: DetectorKey;
  a: number;
  b: number;
  url: string;
  units: "sigma";
  limits: [number, number];
}

export interface FlagsFrame {
  detector: DetectorKey;
  epoch: number;
  url: string;
  legend: Record<string, string>;
}

/** WCS cards passed straight to Aladin Lite's A.image(url, { wcs }). */
export type AladinWcs = Record<string, number | string>;

export interface SpectrumPoint {
  wl_um: number;
  bw_um: number;
  flux_ujy: number;
  err_ujy: number;
  epoch: number;
  detector: number;
  saturated: boolean;
}

export interface EpochPhotometry {
  epoch: number;
  detector: number;
  mjd: number;
  flux_ujy: number;
  err_ujy: number;
  mag_ab: number;
  wl_um: number;
  saturated_frac: number;
}

export interface FieldManifest {
  schema: "pxh-field/1";
  generated_at: string;
  source: "bundle" | "live" | "fixture";
  target: ManifestTarget | null;
  center: { ra: number; dec: number; epoch_mjd: number };
  fov_arcmin: number;
  release: { collections: string[]; file_tags: string[]; latest_obs: string; discovered_at?: string };
  grid: { width: number; height: number; pixscale_arcsec: number; wcs: AladinWcs };
  epochs: Epoch[];
  frames: {
    epoch: Partial<Record<DetectorKey | "rgb", EpochFrame[]>>;
    then_vs_now: ThenNowFrame[];
    difference: DifferenceFrame[];
    flags: FlagsFrame[];
  };
  render?: { stretch: string; note?: string };
  motion: null | {
    method: string;
    epoch_positions: { epoch: number; mjd: number; ra: number; dec: number; err_mas: number }[];
    fit: null | {
      pmra: number;
      pmdec: number;
      pmra_err: number;
      pmdec_err: number;
      total_arcsec_yr: number;
      total_err: number;
      pa_deg: number;
    };
    catalog: null | { pmra: number; pmdec: number; total_arcsec_yr: number; pa_deg: number; source: string };
    predicted_path: [number, number][];
    verdict: "pass" | "partial" | "fail";
    verdict_text: string;
  };
  spectrum: null | {
    points: SpectrumPoint[];
    quicklook: null | { wl_um: number[]; flux_ujy: (number | null)[]; label: string };
    notes: string[];
  };
  lightcurve: null | {
    epoch_photometry: EpochPhotometry[];
    same_channel: { mjd: number; flux_ujy: number; err_ujy: number; wl_um: number }[];
    variability: null | { chi2_dof: number; max_delta_mag: number; significant: boolean };
  };
  checks: { name: string; value: string; pass: boolean }[];
  warnings: string[];
  links: { label: string; url: string }[];
  credits: string;
}

/** Base URL of the live backend (Hugging Face Space). Empty string = not configured. */
export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/$/, "");

/** Static bundle for a curated target (ships with the site, works offline from IRSA). */
export function bundleUrl(slug: string): string {
  return `/bundles/${slug}/manifest.json`;
}

/** Resolve a frame URL relative to the manifest it came from (bundles use relative paths). */
export function resolveFrameUrl(manifestUrl: string, frameUrl: string): string {
  if (/^https?:\/\//.test(frameUrl) || frameUrl.startsWith("/")) return frameUrl;
  return manifestUrl.slice(0, manifestUrl.lastIndexOf("/") + 1) + frameUrl;
}

export async function loadBundle(slug: string, init?: RequestInit): Promise<FieldManifest> {
  const url = bundleUrl(slug);
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`Bundle ${slug} not available (HTTP ${res.status})`);
  const manifest = (await res.json()) as FieldManifest;
  if (manifest.schema !== "pxh-field/1") throw new Error(`Unexpected bundle schema: ${String(manifest.schema)}`);
  return manifest;
}
