// User preferences: the schema, the defaults and the small script that mirrors the visual ones
// onto <html> before first paint. Server-safe (no React, no window at import time); the store and
// the hooks live in ./preferences.
//
// Stored in localStorage under "pxh:prefs" as {"v":1,"prefs":{...}}, holding only the values
// that differ from the defaults, so a later change of default still reaches people who never
// touched that setting. Every default equals what the site did before preferences existed.

export const PREFS_STORAGE_KEY = "pxh:prefs";
export const PREFS_VERSION = 1;

export type GlassPref = "full" | "subtle" | "off";
export type MotionPref = "system" | "reduce" | "full";
export type SkyStarDetailPref = "bright" | "more" | "all";
export type SkyStartPref = "sphere" | "3d";
export type LabDetectorPref = "D1" | "D2" | "D3" | "D4" | "D5" | "D6" | "rgb";

export interface Preferences {
  /** Liquid glass look: refraction and highlight, frost only, or solid panels. */
  glass: GlassPref;
  /** Animation: follow the system setting, always reduce, or always play in full. */
  motion: MotionPref;
  /** Show the small "?" after explained words (the dotted underline always stays). */
  termMarks: boolean;
  /** Sky globe stars: bright (to V 6.5, tier 1), more (to V 8, tiers 1-2) or all (tiers 1-3). */
  skyStarDetail: SkyStarDetailPref;
  /** Where the Sky globe opens: on the sphere, or out in 3D space. */
  skyStartIn: SkyStartPref;
  /** Sky globe constellation figures layer at start. */
  skyConstellations: boolean;
  /** Sky globe SPHEREx infrared map layer at start. */
  skyInfraredMap: boolean;
  /** Lab detector when a field opens and the link names none (rgb = false colour). */
  labDetector: LabDetectorPref;
  /** Lab blink interval in milliseconds (150-1200, the timeline's speed range). */
  labBlinkMs: number;
  /** Offer the guided tour the first time the Sky globe or the Lab opens. */
  tourOffer: boolean;
}

export type PreferenceKey = keyof Preferences;

export const PREFERENCE_DEFAULTS: Readonly<Preferences> = Object.freeze({
  glass: "full",
  motion: "system",
  termMarks: true,
  skyStarDetail: "all",
  skyStartIn: "sphere",
  skyConstellations: false,
  skyInfraredMap: false,
  labDetector: "D6",
  labBlinkMs: 500,
  tourOffer: true,
});

/** Allowed values, for settings controls. */
export const PREFERENCE_OPTIONS = {
  glass: ["full", "subtle", "off"],
  motion: ["system", "reduce", "full"],
  skyStarDetail: ["bright", "more", "all"],
  skyStartIn: ["sphere", "3d"],
  labDetector: ["D1", "D2", "D3", "D4", "D5", "D6", "rgb"],
} as const satisfies Partial<Record<PreferenceKey, readonly string[]>>;

/** The Lab timeline's speed range (SPEED_MIN and SPEED_MAX in components/lab/timeline.tsx). */
export const LAB_BLINK_MS_RANGE = { min: 150, max: 1200 } as const;

const oneOf =
  <T extends string>(values: readonly T[]) =>
  (v: unknown): v is T =>
    typeof v === "string" && (values as readonly string[]).includes(v);

const isBoolean = (v: unknown): v is boolean => typeof v === "boolean";

const VALIDATORS: { [K in PreferenceKey]: (v: unknown) => v is Preferences[K] } = {
  glass: oneOf(PREFERENCE_OPTIONS.glass),
  motion: oneOf(PREFERENCE_OPTIONS.motion),
  termMarks: isBoolean,
  skyStarDetail: oneOf(PREFERENCE_OPTIONS.skyStarDetail),
  skyStartIn: oneOf(PREFERENCE_OPTIONS.skyStartIn),
  skyConstellations: isBoolean,
  skyInfraredMap: isBoolean,
  labDetector: oneOf(PREFERENCE_OPTIONS.labDetector),
  labBlinkMs: (v): v is number =>
    typeof v === "number" && Number.isFinite(v) && v >= LAB_BLINK_MS_RANGE.min && v <= LAB_BLINK_MS_RANGE.max,
  tourOffer: isBoolean,
};

export function isValidPreference<K extends PreferenceKey>(key: K, value: unknown): value is Preferences[K] {
  const check = VALIDATORS[key] as ((v: unknown) => boolean) | undefined;
  return check ? check(value) : false;
}

/** The stored overrides: known keys with valid values only. Anything else is dropped. */
export function parseStoredPreferences(raw: string | null): Partial<Preferences> {
  if (!raw) return {};
  try {
    const data: unknown = JSON.parse(raw);
    if (!data || typeof data !== "object") return {};
    const { v, prefs } = data as { v?: unknown; prefs?: unknown };
    if (v !== PREFS_VERSION || !prefs || typeof prefs !== "object") return {};
    const out: Partial<Record<PreferenceKey, unknown>> = {};
    for (const key of Object.keys(PREFERENCE_DEFAULTS) as PreferenceKey[]) {
      const value = (prefs as Record<string, unknown>)[key];
      if (value !== undefined && isValidPreference(key, value) && value !== PREFERENCE_DEFAULTS[key]) out[key] = value;
    }
    return out as Partial<Preferences>;
  } catch {
    return {};
  }
}

/**
 * Inline script for <head>: copies glass, motion and termMarks onto <html> as data-glass,
 * data-motion and data-term-marks before the first paint, so CSS never shows the wrong look.
 * The server renders the defaults on <html>; this only writes when a stored value differs.
 */
export const PREFERENCES_BOOT_SCRIPT = `(function(){try{var s=JSON.parse(localStorage.getItem(${JSON.stringify(
  PREFS_STORAGE_KEY,
)})||"null"),p=s&&s.v===${PREFS_VERSION}&&s.prefs||{},d=document.documentElement;if(p.glass==="subtle"||p.glass==="off")d.setAttribute("data-glass",p.glass);if(p.motion==="reduce"||p.motion==="full")d.setAttribute("data-motion",p.motion);if(p.termMarks===false)d.setAttribute("data-term-marks","false")}catch(e){}})();`;

/** The <html> attributes for the defaults, rendered by the server. */
export const PREFERENCE_HTML_DEFAULTS = {
  "data-glass": PREFERENCE_DEFAULTS.glass,
  "data-motion": PREFERENCE_DEFAULTS.motion,
  "data-term-marks": String(PREFERENCE_DEFAULTS.termMarks),
} as const;
