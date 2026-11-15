// The home page story: real SPHEREx frames and measured results, with where each number comes from.
// Frames: the prepared Barnard's Star bundle (public/bundles/barnards-star; scripts/build_bundles.py).
// Numbers: docs/phase1/<slug>/summary.json and docs/data-findings.md (sections 1 and 6).

const FRAMES = "/bundles/barnards-star/frames";

/** The SPHEREx all-sky textures (public/textures/spherex-sky.json): plate carrée, ICRS, RA 0 at the left. */
export const SKY_TEXTURE = { small: "/textures/spherex-sky-rgb-2k.webp", large: "/textures/spherex-sky-rgb-4k.webp" } as const;

/** Still of the globe at rest (scripts/make_landing_globe.py, same view as HERO_VIEW). */
export const GLOBE_STILL = "/landing/globe-hero.webp";

/** The globe at rest: the view centre, in degrees. Keep in step with scripts/make_landing_globe.py. */
export const HERO_VIEW = { ra: 300, dec: 18 } as const;

/**
 * Barnard's Star field: 99 x 99 pixels of 6.15 arcseconds (10.1 arcminutes), north up, east left,
 * centred on CRVAL in the bundle manifest.
 */
export const FIELD = {
  ra: 269.446228142545,
  dec: 4.768721327547757,
  px: 99,
  /** Width in radians: 99 x 6.15 arcseconds. */
  widthRad: (99 * 6.15 * Math.PI) / (180 * 3600),
} as const;

export interface Detector {
  key: "D1" | "D2" | "D3" | "D4" | "D5" | "D6";
  /** Wavelength range in microns (manifest frames.epoch.Dn[].wl_um). */
  wl: readonly [number, number];
  src: string;
}

/** The six detectors, first full visit (August 2025). */
export const DETECTORS: readonly Detector[] = [
  { key: "D1", wl: [0.746, 1.117], src: `${FRAMES}/D1_E0.png` },
  { key: "D2", wl: [1.103, 1.65], src: `${FRAMES}/D2_E0.png` },
  { key: "D3", wl: [1.63, 2.435], src: `${FRAMES}/D3_E0.png` },
  { key: "D4", wl: [2.403, 3.847], src: `${FRAMES}/D4_E0.png` },
  { key: "D5", wl: [3.811, 4.43], src: `${FRAMES}/D5_E0.png` },
  { key: "D6", wl: [4.412, 5.01], src: `${FRAMES}/D6_E0.png` },
];

/** Each detector records 17 narrow bands: 6 x 17 = 102. */
export const BANDS_PER_DETECTOR = 17;

export interface Visit {
  label: string;
  src: string;
  /** The star's measured position in the frame, in pixels from the top-left corner. */
  x: number;
  y: number;
  /** Distance from the August 2025 position, in arcseconds. */
  moved: number;
}

/**
 * The three full visits in D6 (4.4-5.0 microns). Positions: the manifest's motion.epoch_positions
 * (per-exposure PSF fits) through the frame's WCS; distances from the August 2025 position.
 */
export const VISITS: readonly Visit[] = [
  { label: "Aug 2025", src: `${FRAMES}/D6_E0.png`, x: 49.311, y: 50.393, moved: 0 },
  { label: "Mar 2026", src: `${FRAMES}/D6_E2.png`, x: 49.451, y: 49.406, moved: 6.13 },
  { label: "Aug 2026", src: `${FRAMES}/D6_E4.png`, x: 49.602, y: 48.734, moved: 10.36 },
];

/** August 2026 minus August 2025 in D6, in units of the noise (linear from -50 to +50). */
export const DIFFERENCE = { src: `${FRAMES}/DIFF_D6_E4-E0.png`, label: "Aug 2026 minus Aug 2025" } as const;

/** Barnard's Star's motion: SPHEREx fit against Gaia DR3 (data-findings section 6.1). */
export const BARNARD_MOTION = { perYear: 10.55, err: 0.12, gaia: 10.41, oneYear: 10.36 } as const;

export interface Result {
  key: string;
  name: string;
  value: number;
  digits: number;
  suffix: string;
  /** The value as a screen reader should read it. */
  spoken: string;
  source: string;
}

/**
 * The three headline results (data-findings section 1; phase1 summaries):
 * - Barnard's Star: motion.primary.fit, 10545.9 +/- 118.9 mas/yr from 75 exposures; Gaia DR3 10406.5.
 * - WISE 0855-0714: motion.shift_model, 7.98 +/- 0.77 arcsec in 360 days, 10.3 sigma from a static
 *   source, with the neighbour modelled; predicted 8.04 arcsec.
 * - RW Aurigae: variability.first_to_last.best, D5 (3.8-4.4 microns), 0.856 +/- 0.037 mag fainter
 *   from September 2025 to September 2026, 22.9 sigma.
 */
export const RESULTS: readonly Result[] = [
  {
    key: "barnard",
    name: "Barnard's Star",
    value: 10.55,
    digits: 2,
    suffix: "″",
    spoken: "10.55 arcseconds a year, plus or minus 0.12",
    source: "SPHEREx DR1 and QR3, 75 exposures. Gaia DR3: 10.41″.",
  },
  {
    key: "wise-0855",
    name: "WISE 0855−0714",
    value: 10.3,
    digits: 1,
    suffix: "σ",
    spoken: "10.3 sigma",
    source: "SPHEREx DR1, May 2025 to May 2026. Predicted shift: 8.04″.",
  },
  {
    key: "rw-aur",
    name: "RW Aurigae",
    value: 0.86,
    digits: 2,
    suffix: " mag",
    spoken: "0.86 magnitudes, plus or minus 0.04",
    source: "SPHEREx DR1 and QR3, 3.8–4.4 µm, Sept 2025 to Sept 2026.",
  },
];

/** Stars in the Sky globe (Hipparcos, all three tiers; Settings, Star detail). */
export const SKY_STAR_COUNT = 117_955;
