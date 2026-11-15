// Guided tours of the Sky globe and the Lab: which tour is running, the first-visit offers, and the
// explanations the tour cards give. The steps themselves are in ./tour-steps; the overlay that runs
// them (spotlight, card and the pointer that shows each control) is components/tour.
//
//   startTour("lab", buttonElement);   // focus goes back to the element when the tour ends
//   const active = useActiveTour();    // "sky" | "lab" | null
//
// Kept in this browser: the Offer setting in the preferences store ("tourOffer"), and the tools
// whose offer has been shown, in localStorage "pxh-tour-seen" (listed under Settings > Data and
// privacy).

import { useSyncExternalStore } from "react";
import { GLOSSARY } from "./glossary";

export type TourId = "sky" | "lab";

export const TOUR_NAMES: Record<TourId, string> = { sky: "Sky", lab: "Lab" };

/** Replay links (Settings, the end of the Sky tour). The Lab tour runs on Barnard's Star. */
export const TOUR_HREF: Record<TourId, string> = {
  sky: "/sky?tour=1",
  lab: "/explore?target=barnards-star&tour=1",
};

// ------------------------------------------------------------------------------- running tour

interface ActiveTour {
  id: TourId | null;
  /** Where focus returns when the tour closes (the Tour button that started it). */
  from: HTMLElement | null;
  /** The step on screen, so a tour whose host is remounted (the Lab's panes turning into tabs) carries on. */
  step: string | null;
}

let active: ActiveTour = { id: null, from: null, step: null };
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export function startTour(id: TourId, from: HTMLElement | null = null): void {
  active = { id, from, step: null };
  markTourSeen(id);
  emit();
}

/** Close the tour (only that tool's, when `only` is given); focus returns to the Tour button. */
export function endTour(only?: TourId): void {
  if (!active.id || (only && active.id !== only)) return;
  const id = active.id;
  const from = active.from;
  active = { id: null, from: null, step: null };
  emit();
  requestAnimationFrame(() => {
    const back =
      from && from.isConnected ? from : document.querySelector<HTMLElement>(`[data-tour-button="${id}"]`);
    back?.focus({ preventScroll: true });
  });
}

export function noteTourStep(step: string): void {
  if (active.id) active = { ...active, step };
}

/** The step the running tour is on, if it has started one. */
export function currentTourStep(): string | null {
  return active.step;
}

const hosts: Record<TourId, number> = { sky: 0, lab: 0 };

/**
 * A tool's tour host is mounted; the returned function unmounts it. When the last host of a tool
 * goes (the visitor left the tool), its tour ends; a host that is only remounted keeps it.
 */
export function mountTourHost(id: TourId): () => void {
  hosts[id] += 1;
  return () => {
    hosts[id] -= 1;
    window.setTimeout(() => {
      if (hosts[id] === 0) endTour(id);
    }, 0);
  };
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The tour running now, if any. */
export function useActiveTour(): TourId | null {
  return useSyncExternalStore(
    subscribe,
    () => active.id,
    () => null,
  );
}

// ------------------------------------------------------------------------------- first visit

export const TOUR_SEEN_KEY = "pxh-tour-seen";

function readSeen(): string[] {
  return (window.localStorage.getItem(TOUR_SEEN_KEY) ?? "").split(",").filter(Boolean);
}

/** Whether this tool's offer was already shown (true when storage cannot be read: never nag). */
export function tourSeen(id: TourId): boolean {
  try {
    return readSeen().includes(id);
  } catch {
    return true;
  }
}

export function markTourSeen(id: TourId): void {
  try {
    const seen = readSeen();
    if (!seen.includes(id)) window.localStorage.setItem(TOUR_SEEN_KEY, [...seen, id].join(","));
  } catch {
    // Blocked storage: the offer simply is not remembered.
  }
}

// ------------------------------------------------------------------------------- explanations

export interface TourDefinition {
  term: string;
  text: string;
}

const fromGlossary = (k: keyof typeof GLOSSARY, term?: string): TourDefinition => ({
  term: term ?? GLOSSARY[k].term,
  text: GLOSSARY[k].short,
});

/**
 * The explanation on each card. Where the site's glossary (lib/glossary.ts) has the word, its
 * wording is used, so a definition reads the same here as under the explained word elsewhere.
 * Sources of the others:
 *   raDec      the glossary's right ascension and declination, joined
 *   hip        public/data/stars: HIP 32349 (Sirius) heads the brightest list
 *   spherex    NASA/JPL: launched 11 March 2025; 102 colours = 6 detectors x 17 channels
 *              (backend config CHANNELS_PER_DETECTOR); revisits as in the glossary's "epoch"
 *   lightYear  IAU: 9,460,730,472,580.8 km; Barnard's Star 6.0 light-years (lib/targets.ts)
 *   infrared   a 3,200 K red dwarf emits about 9/10 of its light beyond 0.7 um (Planck)
 *   blink      the glossary's blink; Clyde Tombaugh found Pluto with a blink comparator in 1930
 *   detector   backend config DETECTOR_BANDS_UM: D1 0.75-1.11 um, D6 4.41-5.01 um
 *   spectrum   six detectors of 17 channels each (backend config, How it works)
 */
export const TOUR_DEFS = {
  hipparcos: fromGlossary("hipparcos", "Hipparcos"),
  raDec: {
    term: "Right ascension and declination",
    text: "Sky longitude and latitude. Right ascension is measured eastward along the celestial equator; declination is degrees north (+) or south (−) of it.",
  },
  hip: {
    term: "HIP number",
    text: "A star's number in the Hipparcos catalogue. Sirius, the brightest star in the night sky, is HIP 32349.",
  },
  properMotion: fromGlossary("properMotion"),
  magnitude: fromGlossary("magnitude"),
  spherex: {
    term: "SPHEREx",
    text: "NASA's infrared space telescope, launched in March 2025. It maps the whole sky in 102 infrared colours and comes back to each patch about every six months.",
  },
  parallax: fromGlossary("parallax"),
  lightYear: {
    term: "Light-year",
    text: "The distance light travels in a year, about 9.46 trillion kilometres. Barnard's Star is about 6 light-years away.",
  },
  infrared: {
    term: "Infrared",
    text: "Light with wavelengths longer than red light, invisible to our eyes. Cool objects such as red dwarfs and brown dwarfs give off most of their light in it.",
  },
  blink: {
    term: "Blink",
    text: "Flipping quickly between images of the same sky taken at different times. Anything that moved or changed brightness jumps out. Clyde Tombaugh found Pluto this way in 1930.",
  },
  arcminute: fromGlossary("arcminute"),
  epoch: fromGlossary("epoch"),
  detector: {
    term: "Detector",
    text: "One of SPHEREx's six infrared detector arrays. D1 records the shortest wavelengths, 0.75 to 1.11 µm, and D6 the longest, 4.41 to 5.01 µm.",
  },
  micron: fromGlossary("micron"),
  difference: fromGlossary("difference"),
  arcsecond: fromGlossary("arcsecond"),
  gaia: fromGlossary("gaia"),
  spectrum: {
    term: "Spectrum",
    text: "Light spread out by wavelength, showing how bright something is at each one. SPHEREx measures 102 wavelength bands: 17 on each of its six detectors.",
  },
  wise: fromGlossary("wise"),
  candidate: fromGlossary("candidate"),
} as const satisfies Record<string, TourDefinition>;
