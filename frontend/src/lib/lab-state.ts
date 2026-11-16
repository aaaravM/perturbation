// Shareable Lab state in the URL (nuqs). Compatible with the brief's example
// /explore?ra=269.452&dec=4.693&fov=0.2 and extended with target, mode, det, frame and layers.
//   ra, dec  view centre (deg, ICRS)      fov    view width (deg)
//   target   featured target slug         mode   epochs | then-now | difference
//   det      D1..D6 | rgb                 frame  index into the current mode's frames
//   layers   comma list: path, flags, wise, gaia

import { parseAsArrayOf, parseAsFloat, parseAsInteger, parseAsString, parseAsStringLiteral, throttle } from "nuqs";

export { DEFAULT_VIEW } from "@/lib/url-state";

export const LAB_MODES = ["epochs", "then-now", "difference"] as const;
export type LabMode = (typeof LAB_MODES)[number];

export const LAB_DETECTORS = ["D1", "D2", "D3", "D4", "D5", "D6", "rgb"] as const;
export type LabDetector = (typeof LAB_DETECTORS)[number];

export const LAB_LAYERS = ["path", "flags", "wise", "gaia"] as const;
export type LabLayer = (typeof LAB_LAYERS)[number];
export const DEFAULT_LAYERS: LabLayer[] = ["path", "gaia"];

/**
 * ra, dec and fov have no URL default: a link with only ?target= frames that target, and a link
 * with nothing at all opens the all-sky view at DEFAULT_VIEW.
 */
export const labParsers = {
  ra: parseAsFloat,
  dec: parseAsFloat,
  fov: parseAsFloat,
  target: parseAsString,
  mode: parseAsStringLiteral(LAB_MODES).withDefault("epochs"),
  det: parseAsStringLiteral(LAB_DETECTORS),
  frame: parseAsInteger,
  layers: parseAsArrayOf(parseAsStringLiteral(LAB_LAYERS)).withDefault(DEFAULT_LAYERS),
};

export const labUrlOptions = {
  history: "replace",
  limitUrlUpdates: throttle(300),
} as const;

/** Blink frames are built for fields up to 30 arcmin; wider views show the all-sky cube only. */
export const BLINK_FOV_MIN_DEG = 2 / 60;
export const BLINK_FOV_MAX_DEG = 30 / 60;
/** Field requested for a new patch ("Watch this patch"), as in the API default. */
export const DEFAULT_FIELD_DEG = 10 / 60;

/** Zoom steps for the field-of-view control (deg). */
export const FOV_STEPS_DEG = [2, 3, 5, 8, 12, 20, 30, 45, 90, 180, 360, 900, 1800, 3600].map((m) => m / 60);

export function nextFovStep(current: number, direction: 1 | -1): number {
  // The URL keeps four significant digits (roundFov), so 20′ comes back as 0.3333°, just under
  // the step itself: compare with a relative margin, or "zoom out" would pick the same step again.
  const eps = current * 1e-3;
  if (direction > 0) return FOV_STEPS_DEG.find((s) => s > current + eps) ?? FOV_STEPS_DEG.at(-1)!;
  return [...FOV_STEPS_DEG].reverse().find((s) => s < current - eps) ?? FOV_STEPS_DEG[0];
}
