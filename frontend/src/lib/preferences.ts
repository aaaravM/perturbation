// User preferences store: a few typed values in localStorage ("pxh:prefs"), read through
// useSyncExternalStore so every component sees the same value and the server render (which
// cannot read localStorage) always uses the defaults. Changes in another tab arrive through the
// storage event. Every storage access is wrapped: private windows and blocked storage simply fall
// back to the defaults. The schema and defaults are in ./preferences-schema.
//
//   const glass = usePreference("glass");          // "full" | "subtle" | "off"
//   setPreference("labBlinkMs", 400);
//   resetPreferences(["skyStartIn", "skyStarDetail"]);   // or resetPreferences() for all
//
// glass, motion and termMarks are also mirrored onto <html> (data-glass, data-motion,
// data-term-marks) so CSS can follow them; the root layout's boot script does the same before
// first paint.

import { useCallback, useSyncExternalStore } from "react";
import {
  PREFERENCE_DEFAULTS,
  PREFS_STORAGE_KEY,
  PREFS_VERSION,
  isValidPreference,
  parseStoredPreferences,
  type GlassPref,
  type PreferenceKey,
  type Preferences,
} from "./preferences-schema";

export * from "./preferences-schema";

let overrides: Partial<Preferences> = {};
let snapshot: Preferences = PREFERENCE_DEFAULTS;
let started = false;
const listeners = new Set<() => void>();

function readStorage(): Partial<Preferences> {
  try {
    return parseStoredPreferences(window.localStorage.getItem(PREFS_STORAGE_KEY));
  } catch {
    return {};
  }
}

function writeStorage() {
  try {
    if (Object.keys(overrides).length === 0) window.localStorage.removeItem(PREFS_STORAGE_KEY);
    else window.localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify({ v: PREFS_VERSION, prefs: overrides }));
  } catch {
    // Storage is full or blocked: the choice still holds for this page view.
  }
}

function mirrorToHtml(p: Preferences) {
  const d = document.documentElement;
  d.setAttribute("data-glass", p.glass);
  d.setAttribute("data-motion", p.motion);
  d.setAttribute("data-term-marks", String(p.termMarks));
}

function commit(persist: boolean) {
  snapshot = { ...PREFERENCE_DEFAULTS, ...overrides };
  if (persist) writeStorage();
  mirrorToHtml(snapshot);
  for (const l of listeners) l();
}

function start() {
  if (started || typeof window === "undefined") return;
  started = true;
  overrides = readStorage();
  snapshot = { ...PREFERENCE_DEFAULTS, ...overrides };
  window.addEventListener("storage", (event) => {
    if (event.key !== null && event.key !== PREFS_STORAGE_KEY) return;
    overrides = readStorage();
    commit(false);
  });
}

/** All preferences now (defaults on the server). For code outside React, such as render loops. */
export function getPreferences(): Preferences {
  start();
  return snapshot;
}

/** One preference now (the default on the server). */
export function getPreference<K extends PreferenceKey>(key: K): Preferences[K] {
  return getPreferences()[key];
}

/** Set one preference. Invalid values are ignored; the default value clears the stored override. */
export function setPreference<K extends PreferenceKey>(key: K, value: Preferences[K]): void {
  start();
  if (typeof window === "undefined" || !isValidPreference(key, value)) return;
  const next = { ...overrides };
  if (value === PREFERENCE_DEFAULTS[key]) delete next[key];
  else next[key] = value;
  overrides = next;
  commit(true);
}

/** Back to the defaults: the given keys, or every preference when called without arguments. */
export function resetPreferences(keys?: readonly PreferenceKey[]): void {
  start();
  if (typeof window === "undefined") return;
  if (!keys) overrides = {};
  else {
    const next = { ...overrides };
    for (const k of keys) delete next[k];
    overrides = next;
  }
  commit(true);
}

/** Subscribe outside React; returns the unsubscribe function. */
export function subscribePreferences(listener: () => void): () => void {
  start();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const serverPreferences = () => PREFERENCE_DEFAULTS;

/** Every preference; re-renders when any of them changes. */
export function usePreferences(): Preferences {
  return useSyncExternalStore(subscribePreferences, getPreferences, serverPreferences);
}

/** One preference; re-renders only when that one changes. The default during SSR and hydration. */
export function usePreference<K extends PreferenceKey>(key: K): Preferences[K] {
  const get = useCallback(() => getPreferences()[key], [key]);
  const getServer = useCallback(() => PREFERENCE_DEFAULTS[key], [key]);
  return useSyncExternalStore(subscribePreferences, get, getServer);
}

const noopSubscribe = () => () => {};

/**
 * False during the server render and hydration, true afterwards. Stored preferences are only
 * known from then on, so code that would otherwise animate from the default to the stored value
 * (for example the Sky globe's start mode) can wait for it.
 */
export function usePreferencesReady(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}

// ---------------------------------------------------------------------------------- media queries

function subscribeMedia(query: string, cb: () => void) {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const m = window.matchMedia(query);
  m.addEventListener("change", cb);
  return () => m.removeEventListener("change", cb);
}

function matches(query: string) {
  return typeof window !== "undefined" && !!window.matchMedia && window.matchMedia(query).matches;
}

/** A CSS media query, live. False on the server and during hydration. */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback((cb: () => void) => subscribeMedia(query, cb), [query]);
  const get = useCallback(() => matches(query), [query]);
  return useSyncExternalStore(subscribe, get, () => false);
}

export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
export const REDUCED_TRANSPARENCY_QUERY = "(prefers-reduced-transparency: reduce)";

/** The motion preference combined with the system setting: true means hold still. */
export function reducedMotionFor(pref: Preferences["motion"], systemReduces: boolean): boolean {
  return pref === "reduce" || (pref === "system" && systemReduces);
}

/**
 * Should animation be reduced? The Motion setting ("reduce" or "full") wins; "system" follows
 * prefers-reduced-motion. A drop-in for motion/react's useReducedMotion, which only knows the
 * system setting. False on the server.
 */
export function useEffectiveReducedMotion(): boolean {
  const pref = usePreference("motion");
  const system = useMediaQuery(REDUCED_MOTION_QUERY);
  return reducedMotionFor(pref, system);
}

/** The same decision outside React (render loops, event handlers). */
export function prefersReducedMotionNow(): boolean {
  return reducedMotionFor(getPreference("motion"), matches(REDUCED_MOTION_QUERY));
}

/** The glass look in effect: "off" whenever the system asks for reduced transparency. */
export function useEffectiveGlass(): GlassPref {
  const pref = usePreference("glass");
  const reduceTransparency = useMediaQuery(REDUCED_TRANSPARENCY_QUERY);
  return reduceTransparency ? "off" : pref;
}
