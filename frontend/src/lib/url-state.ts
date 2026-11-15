// Shareable URL state for the sky view (nuqs). /explore?ra=&dec=&fov=

import { parseAsFloat, throttle } from "nuqs";

/**
 * Default target: Barnard's Star, "now" position (deg, ICRS). 1.5 deg field: the DR1 cube has
 * 12.9 arcsec pixels and looks blocky below about 0.7 deg.
 */
export const DEFAULT_VIEW = { ra: 269.4461, dec: 4.7707, fov: 1.5 } as const;

/** Field-of-view limits for the preview (deg). */
export const FOV_MIN = 0.25;
export const FOV_MAX = 60;

export const skyViewParsers = {
  ra: parseAsFloat.withDefault(DEFAULT_VIEW.ra),
  dec: parseAsFloat.withDefault(DEFAULT_VIEW.dec),
  fov: parseAsFloat.withDefault(DEFAULT_VIEW.fov),
};

export const skyViewUrlOptions = {
  history: "replace",
  limitUrlUpdates: throttle(300),
} as const;

/** Round for the URL: 1e-5 deg is ~0.04 arcsec, plenty for sharing a view. */
export function roundCoord(value: number): number {
  return Math.round(value * 1e5) / 1e5;
}

export function roundFov(value: number): number {
  return Number(value.toPrecision(4));
}
