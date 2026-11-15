// The five NASA challenge targets, for markers, quick picks and plain-language panels.
// Positions are barycentric ICRS on 2026-11-14 (propagated from Gaia DR3 / Kirkpatrick et al. 2021
// with proper motion and parallax by backend/src/pxh/sky/propagate.py). Full astrometry lives in the
// bundles (FieldManifest.target.astrometry) and in the backend's curated table.

import type { TargetKind } from "./manifest";

export interface FeaturedTarget {
  slug: string;
  name: string;
  kind: TargetKind;
  /** Where it is now (deg). */
  ra: number;
  dec: number;
  /** One line for markers and lists. */
  tagline: string;
  /** 2-3 sentences for the Sky-mode panel. */
  summary: string;
  facts: { label: string; value: string }[];
  /** What to look for in the SPHEREx images. */
  watchFor: string;
}

export const FEATURED_TARGETS: FeaturedTarget[] = [
  {
    slug: "barnards-star",
    name: "Barnard's Star",
    kind: "high-pm-star",
    ra: 269.4460727,
    dec: 4.7707237,
    tagline: "The fastest-moving star in our sky",
    summary:
      "A small, cool red dwarf only 6 light-years away, the closest single star to the Sun. It crosses our sky faster than any other star: about 10 arcseconds a year, enough to travel the width of the full Moon in under two centuries.",
    facts: [
      { label: "Distance", value: "6.0 light-years" },
      { label: "Motion", value: "10.4″ per year" },
      { label: "Type", value: "Red dwarf" },
    ],
    watchFor: "The bright star at the centre shifts upward (north) between maps taken a year apart.",
  },
  {
    slug: "eps-indi-b",
    name: "Epsilon Indi B",
    kind: "brown-dwarf",
    ra: 331.0984097,
    dec: -56.8012581,
    tagline: "A pair of brown dwarfs orbiting a star",
    summary:
      "Two brown dwarfs, objects too massive to be planets but too small to shine like stars, circling each other about 12 light-years away. Together they orbit the star Epsilon Indi A from roughly 1,500 times the Earth-Sun distance.",
    facts: [
      { label: "Distance", value: "11.9 light-years" },
      { label: "Motion", value: "4.7″ per year" },
      { label: "Type", value: "Brown-dwarf binary" },
    ],
    watchFor: "A faint dot that drifts south-east between maps, while the stars around it stay put.",
  },
  {
    slug: "wise-0855",
    name: "WISE 0855−0714",
    kind: "brown-dwarf",
    ra: 133.7577876,
    dec: -7.2420245,
    tagline: "The coldest known brown dwarf",
    summary:
      "A free-floating brown dwarf about as cold as a winter day on Earth, 7.4 light-years away. It is invisible in ordinary light; SPHEREx only sees its faint glow at its longest infrared wavelengths, 4 to 5 microns.",
    facts: [
      { label: "Distance", value: "7.4 light-years" },
      { label: "Motion", value: "8.2″ per year" },
      { label: "Temperature", value: "≈ 250–285 K" },
    ],
    watchFor: "Only in the longest-wavelength maps: a faint spot that moves west.",
  },
  {
    slug: "rw-aur",
    name: "RW Aurigae",
    kind: "young-variable",
    ra: 76.9560904,
    dec: 30.4011219,
    tagline: "A young star that flickers unpredictably",
    summary:
      "A young star system, a few million years old, still wrapped in the disk of gas and dust it formed from. Clumps in that disk sometimes pass in front of the star, so its brightness changes without warning.",
    facts: [
      { label: "Distance", value: "≈ 510 light-years" },
      { label: "Age", value: "A few million years" },
      { label: "Type", value: "T Tauri binary" },
    ],
    watchFor: "The star brightens at some wavelengths and fades at others between visits.",
  },
  {
    slug: "r-dra",
    name: "R Draconis",
    kind: "mira-variable",
    ra: 248.1672205,
    dec: 66.755025,
    tagline: "A giant star that pulses every 8 months",
    summary:
      "An old, swollen red giant that pulsates, swelling and shrinking over about 246 days. Near the north ecliptic pole, where SPHEREx looks almost every day, so its rhythm shows up as a real light curve.",
    facts: [
      { label: "Period", value: "246 days" },
      { label: "Type", value: "Mira variable" },
      { label: "SPHEREx visits", value: "Almost daily" },
    ],
    watchFor: "The star swells in brightness and fades again over months.",
  },
];

export function findFeatured(slug: string | null | undefined): FeaturedTarget | undefined {
  return FEATURED_TARGETS.find((t) => t.slug === slug);
}
