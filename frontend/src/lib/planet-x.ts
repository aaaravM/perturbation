// Data for the Planet X page, read at build time from the Pluto bundle
// (public/planet-x/pluto.json and its PNGs in public/planet-x/stamps/, written by
// scripts/pluto_products.py; the method and every number are in docs/validation/pluto.md).
// Server only: it reads the file from disk and hands the page only what it shows.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

const BASE = "/planet-x/";

/* ------------------------------------------------------------------ */
/* The bundle as written by scripts/pluto_products.py (the parts used) */
/* ------------------------------------------------------------------ */

interface Dist {
  n: number;
  median: number;
  p10: number;
  p90: number;
  min: number;
  max: number;
}

interface RawFrame {
  png: string;
  obs_id: string;
  detector: number;
  date_utc: string;
  wavelength_um: number;
  pluto_px: [number, number];
  snr: number;
}

interface RawBlink {
  detector: number;
  grid_px: number;
  pixel_arcsec: number;
  fov_arcmin: number;
  span_days: number;
  pluto_moved_arcsec: number;
  frames: RawFrame[];
}

interface RawStack {
  detector: number;
  n: number;
  n_observations: number;
  grid_px: number;
  pixel_arcsec: number;
  span_days: number;
  trail_arcsec: number;
  wavelength_range_um: [number, number];
  mjd: number[];
  star_aligned_png: string;
  pluto_aligned_png: string;
  pluto_px_pluto_aligned: [number, number];
  difference_pngs: { single: string; star_aligned: string; pluto_aligned: string; single_obs_id: string; limits_sigma: [number, number] };
  singles: { obs_id: string; snr: number | null }[];
  snr_single_median: number;
  n_single_measured: number;
  snr_stack: number;
  snr_expected_sqrt_n: number;
  dots: { obs: string; snr: number; px: [number, number] }[];
}

interface RawVisit {
  visit: number;
  start_utc: string;
  end_utc: string;
  n_images: number;
  n_exposures: number;
  n_clean: number;
  collections: string[];
  wavelength_um: [number, number];
  solar_elongation_deg: [number, number];
  distance_au: [number, number];
  pluto_moved_arcsec: number;
}

interface RawBundle {
  provenance: { n_observations_scanned: number; ephemeris: { source: string; target: string } };
  summary: {
    n_images: number;
    n_exposures: number;
    n_clean: number;
    wavelength_um: [number, number];
    psf_fwhm_arcsec: Dist;
    snr: Dist;
    visits: RawVisit[];
  };
  astrometry: {
    n: number;
    median_east_arcsec: number;
    median_north_arcsec: number;
    wmean_east_arcsec: number;
    wmean_east_err_arcsec: number;
    wmean_north_arcsec: number;
    wmean_north_err_arcsec: number;
    rms_east_arcsec: number;
    rms_north_arcsec: number;
    median_formal_err_arcsec: number;
    chi2_red_east: number;
    chi2_red_north: number;
    total_offset_arcsec: Dist;
  };
  depth5_ab: Record<"0.75-3.8 um" | "3.8-5.0 um", Dist>;
  static_sky: { n_images_with_template: number; n_blended: number; fraction_of_pluto: Dist };
  outlier_check: { n: number; flux_ratio_kept_over_masked: Dist; n_images_with_outlier_on_pluto: number };
  spectrum: {
    points: { um: number; dum: number; flux_ujy: number; err_ujy: number }[];
    bins: {
      lo_um: number;
      hi_um: number;
      um: number;
      n: number;
      flux_ujy: number;
      err_ujy: number;
      chi2_red: number;
      sunlight_shape_ujy: number;
      relative_reflectance: number;
      relative_reflectance_err: number;
    }[];
    bands: {
      lo_um: number;
      hi_um: number;
      continuum_um: [number, number];
      relative_reflectance_in: number;
      relative_reflectance_continuum: number;
      depth: number;
      depth_err: number;
      significance_sigma: number;
      references: string;
    }[];
  };
  tracked_blink: RawBlink;
  skyfixed_blink: RawBlink;
  shift_and_stack: RawStack;
  shift_and_stack_faint: RawStack;
  planet_x_geometry: {
    pixel_arcsec: number;
    /** The solar elongations of the Pluto images, at which the within-visit motion is modelled. */
    elongation_deg: [number, number];
    cases: {
      distance_au: number;
      shift_between_visits_arcsec: [number, number];
      shift_between_visits_px: [number, number];
      /** Shortest and longest track in a 7-day window seen at those elongations. */
      within_visit_arcsec: { "7_days": [number, number] };
      within_visit_px: { "7_days": [number, number] };
    }[];
  };
  published: {
    tombaugh: { plates: [string, string]; found_on_blink_comparator: string; announced: string };
    spherex_depth_ab: {
      single_visit: Record<"0.75-3.8 um" | "3.8-5.0 um", [number, number]>;
      four_surveys: Record<"0.75-3.8 um" | "3.8-5.0 um", [number, number]>;
    };
    planet_nine: {
      brown_batygin_2016_v: [number, number];
      brown_batygin_2022_ztf_ruled_out_fraction: number;
      linder_mordasini_2016: { V: number; W1_vega: number; W1_ab: number; W2_ab: number };
    };
    wise_0855: { proper_motion_arcsec_per_yr: number; distance_pc: number; temperature_k: [number, number] };
    pluto_system: { rotation_period_days: number; charon_distance_km: number };
  };
  exposures: {
    obs_id: string;
    detector: number;
    um: number;
    ab: number;
    clean: boolean;
    off_e: number | null;
    off_n: number | null;
  }[];
}

/* ------------------------------------------------------------------ */
/* What the page receives                                              */
/* ------------------------------------------------------------------ */

export interface BlinkFrame {
  url: string;
  /** "2026-04-25 05:43" (UTC). */
  date: string;
  um: number;
  /** Pluto's predicted pixel (x right, y down, 0 at the first pixel's centre). */
  px: [number, number];
  snr: number;
  /** SPHEREx's fitted position minus JPL's prediction, arcsec. */
  offE: number | null;
  offN: number | null;
}

export interface BlinkSet {
  frames: BlinkFrame[];
  detector: number;
  gridPx: number;
  pixelArcsec: number;
  spanDays: number;
  movedArcsec: number;
}

export interface StackSet {
  detector: number;
  n: number;
  observations: number;
  gridPx: number;
  pixelArcsec: number;
  spanDays: number;
  trailArcsec: number;
  um: [number, number];
  first: string;
  last: string;
  starsUrl: string;
  plutoUrl: string;
  plutoPx: [number, number];
  diff: { single: string; stars: string; pluto: string; sigma: number };
  singleSnr: number | null;
  /** Pluto's position in the star-aligned frame at each observation, and its S/N there. */
  dots: { px: [number, number]; snr: number }[];
  snrSingleMedian: number;
  nSingleMeasured: number;
  snrStack: number;
  snrSqrtN: number;
}

export interface SpectrumData {
  points: { um: number; dum: number; mjy: number; err: number }[];
  bins: { um: number; lo: number; hi: number; n: number; mjy: number; err: number; sun: number; refl: number; reflErr: number; chi2: number }[];
  bands: {
    lo: number;
    hi: number;
    cont: [number, number];
    reflIn: number;
    reflCont: number;
    depth: number;
    depthErr: number;
    sigma: number;
    refs: string;
  }[];
}

export interface PlanetXData {
  images: number;
  exposures: number;
  clean: number;
  observationsScanned: number;
  ephemeris: string;
  um: [number, number];
  psfFwhm: Dist;
  snr: Dist;
  visits: RawVisit[];
  astrometry: RawBundle["astrometry"];
  depth: RawBundle["depth5_ab"];
  staticSky: RawBundle["static_sky"];
  outlier: RawBundle["outlier_check"];
  /** Median AB magnitude of the clean measurements below 1 µm, and how many. */
  plutoAb: { median: number; n: number };
  spectrum: SpectrumData;
  tracked: BlinkSet;
  skyFixed: BlinkSet;
  bright: StackSet;
  faint: StackSet;
  geometry: RawBundle["planet_x_geometry"];
  published: RawBundle["published"];
}

const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;

const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  const m = s.length / 2;
  return s.length % 2 ? s[Math.floor(m)] : (s[m - 1] + s[m]) / 2;
};

/** Days since 1858-11-17 (MJD) to "YYYY-MM-DD". */
const mjdDate = (mjd: number) => new Date((mjd - 40587) * 86_400_000).toISOString().slice(0, 10);

function blinkSet(b: RawBlink, exposures: RawBundle["exposures"]): BlinkSet {
  return {
    detector: b.detector,
    gridPx: b.grid_px,
    pixelArcsec: b.pixel_arcsec,
    spanDays: b.span_days,
    movedArcsec: b.pluto_moved_arcsec,
    frames: b.frames.map((f) => {
      const e = exposures.find((x) => x.obs_id === f.obs_id && x.detector === f.detector);
      return {
        url: BASE + f.png,
        date: f.date_utc,
        um: f.wavelength_um,
        px: [round(f.pluto_px[0], 2), round(f.pluto_px[1], 2)],
        snr: f.snr,
        offE: e?.off_e ?? null,
        offN: e?.off_n ?? null,
      };
    }),
  };
}

function stackSet(s: RawStack): StackSet {
  const single = s.singles.find((x) => x.obs_id === s.difference_pngs.single_obs_id);
  return {
    detector: s.detector,
    n: s.n,
    observations: s.n_observations,
    gridPx: s.grid_px,
    pixelArcsec: s.pixel_arcsec,
    spanDays: s.span_days,
    trailArcsec: s.trail_arcsec,
    um: s.wavelength_range_um,
    first: mjdDate(Math.min(...s.mjd)),
    last: mjdDate(Math.max(...s.mjd)),
    starsUrl: BASE + s.star_aligned_png,
    plutoUrl: BASE + s.pluto_aligned_png,
    plutoPx: s.pluto_px_pluto_aligned,
    diff: {
      single: BASE + s.difference_pngs.single,
      stars: BASE + s.difference_pngs.star_aligned,
      pluto: BASE + s.difference_pngs.pluto_aligned,
      sigma: Math.max(...s.difference_pngs.limits_sigma.map(Math.abs)),
    },
    singleSnr: single?.snr ?? null,
    dots: s.dots.map((d) => ({ px: [round(d.px[0], 2), round(d.px[1], 2)], snr: d.snr })),
    snrSingleMedian: s.snr_single_median,
    nSingleMeasured: s.n_single_measured,
    snrStack: s.snr_stack,
    snrSqrtN: s.snr_expected_sqrt_n,
  };
}

export async function loadPlanetX(): Promise<PlanetXData> {
  const raw = await readFile(join(process.cwd(), "public", "planet-x", "pluto.json"), "utf8");
  const b = JSON.parse(raw) as RawBundle;
  const blue = b.exposures.filter((e) => e.clean && e.um < 1);

  return {
    images: b.summary.n_images,
    exposures: b.summary.n_exposures,
    clean: b.summary.n_clean,
    observationsScanned: b.provenance.n_observations_scanned,
    ephemeris: b.provenance.ephemeris.source,
    um: b.summary.wavelength_um,
    psfFwhm: b.summary.psf_fwhm_arcsec,
    snr: b.summary.snr,
    visits: b.summary.visits,
    astrometry: b.astrometry,
    depth: b.depth5_ab,
    staticSky: b.static_sky,
    outlier: b.outlier_check,
    plutoAb: { median: median(blue.map((e) => e.ab)), n: blue.length },
    spectrum: {
      points: b.spectrum.points.map((p) => ({
        um: p.um,
        dum: p.dum,
        mjy: round(p.flux_ujy / 1000, 4),
        err: round(p.err_ujy / 1000, 4),
      })),
      bins: b.spectrum.bins.map((x) => ({
        um: round(x.um, 4),
        lo: round(x.lo_um, 4),
        hi: round(x.hi_um, 4),
        n: x.n,
        mjy: round(x.flux_ujy / 1000, 4),
        err: round(x.err_ujy / 1000, 4),
        sun: round(x.sunlight_shape_ujy / 1000, 4),
        refl: x.relative_reflectance,
        reflErr: x.relative_reflectance_err,
        chi2: x.chi2_red,
      })),
      bands: b.spectrum.bands.map((x) => ({
        lo: x.lo_um,
        hi: x.hi_um,
        cont: x.continuum_um,
        reflIn: x.relative_reflectance_in,
        reflCont: x.relative_reflectance_continuum,
        depth: x.depth,
        depthErr: x.depth_err,
        sigma: x.significance_sigma,
        refs: x.references,
      })),
    },
    tracked: blinkSet(b.tracked_blink, b.exposures),
    skyFixed: blinkSet(b.skyfixed_blink, b.exposures),
    bright: stackSet(b.shift_and_stack),
    faint: stackSet(b.shift_and_stack_faint),
    geometry: b.planet_x_geometry,
    published: b.published,
  };
}
