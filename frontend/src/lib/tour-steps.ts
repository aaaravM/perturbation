// The steps of the two guided tours (components/tour runs them). Each step lights up one part of
// the tool, says in a sentence or three what it does and how to use it, explains one key word,
// and uses the control for real with the tour's pointer: a click, a drag on the globe, or typing
// in a search box. Steps adapt to the layout: the Sky folds its star lists away below 1024 px and
// shows the star panel as a bottom sheet below 768 px; the Lab turns its panes into tabs below
// 900 px. Targets are the tools' own controls, found by test id or data-tour attribute.
//
// Browser-only: every function here reads the page, so call them from effects and handlers.

import { TOUR_DEFS, TOUR_HREF, type TourDefinition, type TourId } from "./tour";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** An element: a selector, or a function that finds it. */
export type TourSel = string | (() => HTMLElement | null | undefined);

export type TourAct =
  /** Point at the element and press it. `if` sees the element and can skip the click. */
  | { kind: "click"; target: TourSel; if?: (el: HTMLElement) => boolean; at?: [number, number]; timeout?: number }
  /** Glide to the element and rest there. */
  | { kind: "point"; target: TourSel; at?: [number, number]; timeout?: number }
  /** Press inside `area` at `from` (fractions of its size), drag to `to`, release. */
  | { kind: "drag"; target: TourSel; area: () => Rect | null; from: [number, number]; to: [number, number]; ms?: number }
  /** Click into a text box and type, with a natural rhythm. */
  | { kind: "type"; target: TourSel; text: string; if?: () => boolean }
  /** Empty a text box. */
  | { kind: "clear"; target: TourSel }
  /** Scroll the element into view within its pane. */
  | { kind: "reveal"; target: TourSel }
  | { kind: "wait"; ms: number }
  | { kind: "until"; test: () => boolean; timeout: number }
  /** Move the spotlight on to the step's next target. */
  | { kind: "phase"; phase: number };

export interface TourStep {
  id: string;
  title: string;
  /** One to three plain sentences: what this part does and how to use it. */
  body: string;
  defs: TourDefinition[];
  /** What to light up, per phase (0 first). Null: nothing in particular, the card sits in the middle. */
  spot?: (phase: number) => Rect | null;
  shape?: (phase: number) => "rect" | "circle";
  /** What the card sits beside (default: the spot). */
  anchor?: () => Rect | null;
  /** Done at once on arrival, without the pointer: what the step needs (a pane, a mode). */
  setup?: TourAct[];
  /** The pointer's demonstration. */
  actions?: TourAct[];
  /** Done at once on leaving (clicks only): close what the step opened. */
  cleanup?: TourAct[];
  skip?: () => boolean;
  /** A question before the tour proper: yes runs `setup` and moves on, no closes the tour. */
  confirm?: { yes: string; no: string };
  /** The last step's way on. */
  next?: { label: string; href: string };
}

// ------------------------------------------------------------------------------- finding things

const q = (sel: string) => document.querySelector<HTMLElement>(sel);

/** The element, if it is in the page and laid out. */
export function find(sel: TourSel): HTMLElement | null {
  const el = typeof sel === "string" ? q(sel) : sel();
  return el && el.isConnected && el.getClientRects().length > 0 ? el : null;
}

export function rectOf(el: Element): Rect {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

/** The box around every one of the elements that is on screen. */
export const spotOf =
  (...sels: TourSel[]) =>
  (): Rect | null => {
    const rects = sels
      .map(find)
      .filter((e): e is HTMLElement => !!e)
      .map(rectOf)
      .filter((r) => r.w > 0 && r.h > 0);
    if (!rects.length) return null;
    const x = Math.min(...rects.map((r) => r.x));
    const y = Math.min(...rects.map((r) => r.y));
    return { x, y, w: Math.max(...rects.map((r) => r.x + r.w)) - x, h: Math.max(...rects.map((r) => r.y + r.h)) - y };
  };

const byText = (sel: string, text: string) => () =>
  [...document.querySelectorAll<HTMLElement>(sel)].find((e) => e.textContent?.includes(text)) ?? null;

// ------------------------------------------------------------------------------- Sky

const SKY_GLOBE = "[data-testid=sky-globe]";
const SKY_SEARCH = "[data-testid=star-search]";
const SKY_PANEL = "[data-testid=sky-panel]";
const CLOSE_PANEL = `${SKY_PANEL} button[aria-label='Close panel']`;
const BROWSE = byText("[data-testid=sky-rail] button[aria-expanded]", "Browse stars");
const searchBox = () => find(SKY_SEARCH)?.parentElement;
const searchOption = (text: string) => byText("[data-testid=search-results] [role=option]", text);

/** The part of the Sky that the globe has to itself: not under the rail, the panel or the controls. */
function skyFreeArea(): Rect | null {
  const globe = find(SKY_GLOBE);
  if (!globe) return null;
  const g = globe.getBoundingClientRect();
  let { left, top, right, bottom } = g;
  const side = find("[data-tour=sky-side]");
  if (side) left = Math.max(left, side.getBoundingClientRect().right + 24);
  const head = find("[data-tour=sky-top]");
  if (head) top = Math.max(top, head.getBoundingClientRect().bottom + 6);
  const panel = find(SKY_PANEL);
  if (panel) {
    const p = panel.getBoundingClientRect();
    if (panel.dataset.layout === "side") right = Math.min(right, p.left - 12);
    else bottom = Math.min(bottom, p.top - 6);
  }
  const controls = find("[data-tour=sky-controls]");
  if (controls && !side && !(panel && panel.dataset.layout !== "side")) {
    bottom = Math.min(bottom, controls.getBoundingClientRect().top - 6);
  }
  return { x: left, y: top, w: right - left, h: bottom - top };
}

/** A circle around the globe (or, in 3D space, the middle of the view). */
export function skyGlobeSpot(): Rect | null {
  const a = skyFreeArea();
  if (!a || a.w < 80 || a.h < 80) return null;
  const d = Math.min(a.w * 0.94, a.h * 0.8, 660);
  return { x: a.x + (a.w - d) / 2, y: a.y + (a.h - d) / 2, w: d, h: d };
}

const circleThen = (from: number) => (phase: number) => (phase >= from ? "circle" : "rect");

export function skyTour(): TourStep[] {
  const compact = window.innerWidth < 1024; // the rail sits on top, its lists folded away
  const sheet = window.innerWidth < 768; // the star panel is a bottom sheet over the controls
  const noGlobe = () => !find(SKY_GLOBE);
  const closeSheet: TourAct[] = sheet ? [{ kind: "click", target: CLOSE_PANEL }] : [];
  const toSpace: TourAct[] = [
    { kind: "until", test: () => !!q("[data-testid=mode-space]") && !q("[data-testid=mode-space]")!.hasAttribute("disabled"), timeout: 15000 },
    { kind: "click", target: "[data-testid=mode-space]", if: (el) => el.getAttribute("aria-checked") !== "true" },
  ];
  // Barnard's Star, the challenge target: from the Challenge list, or by search where the lists fold away.
  const pickBarnard: TourAct[] = compact
    ? [
        { kind: "type", target: SKY_SEARCH, text: "Barnard" },
        { kind: "click", target: searchOption("Barnard's Star"), timeout: 6000 },
      ]
    : [
        { kind: "click", target: "[data-testid=rail-tab-targets]", if: (el) => el.getAttribute("aria-selected") !== "true" },
        { kind: "click", target: "[data-testid=rail-target-barnards-star]" },
      ];
  const barnardOpen = () => !!q("[data-testid=target-story][data-slug=barnards-star]");

  return [
    {
      id: "globe",
      title: "The sky globe",
      body: "Every dot is a real star, drawn in its true colour where it sits in the sky. Click any of them to see what is known about it.",
      defs: [TOUR_DEFS.hipparcos],
      spot: skyGlobeSpot,
      shape: () => "circle",
    },
    {
      id: "turn",
      title: "Turn and zoom",
      body: "Drag to turn the sky; scroll or pinch to zoom, and double-click to fly in. The arrow keys and + and − work too.",
      defs: [TOUR_DEFS.raDec],
      spot: skyGlobeSpot,
      shape: () => "circle",
      skip: noGlobe,
      actions: [{ kind: "drag", target: SKY_GLOBE, area: skyGlobeSpot, from: [0.3, 0.56], to: [0.68, 0.46], ms: 1150 }],
    },
    {
      id: "search",
      title: "Find a star",
      body: "Type a name such as Sirius or α Cen, a HIP number or coordinates, then pick the star from the list.",
      defs: [TOUR_DEFS.hip],
      spot: spotOf(searchBox, "[data-testid=search-results]"),
      setup: closeSheet,
      actions: [
        { kind: "type", target: SKY_SEARCH, text: "Sirius" },
        { kind: "click", target: searchOption("Sirius"), timeout: 6000 },
      ],
      cleanup: [{ kind: "clear", target: SKY_SEARCH }],
    },
    {
      id: "panel",
      title: "What is known about it",
      body: "The panel gives the star's brightness, colour, distance and motion, and further down what SPHEREx has seen there.",
      defs: [TOUR_DEFS.properMotion],
      spot: spotOf(SKY_PANEL),
      setup: [
        { kind: "type", target: SKY_SEARCH, text: "Sirius", if: () => !q("[data-testid=star-story]") },
        { kind: "click", target: searchOption("Sirius"), if: () => !q("[data-testid=star-story]"), timeout: 6000 },
      ],
      actions: [{ kind: "point", target: "[data-testid=fact-motion]", at: [0.3, 0.5] }],
    },
    {
      id: "lists",
      title: "Lists of stars",
      body: "The five challenge targets, and the nearest, brightest and fastest-moving stars in the catalogue. Barnard's Star tops the fastest.",
      defs: [TOUR_DEFS.magnitude],
      spot: compact ? spotOf("[data-testid=sky-rail]") : spotOf("[data-testid=sky-rail] [role=tablist]", "[data-testid=sky-rail] [role=tabpanel]"),
      setup: closeSheet,
      actions: [
        ...(compact ? ([{ kind: "click", target: BROWSE, if: (el) => el.getAttribute("aria-expanded") !== "true" }, { kind: "wait", ms: 450 }] as TourAct[]) : []),
        { kind: "click", target: "[data-testid=rail-tab-fastest]" },
        { kind: "point", target: "[data-testid=rail-list-fastest] [data-testid=rail-star]", at: [0.35, 0.5], timeout: 4000 },
      ],
      cleanup: compact ? [{ kind: "click", target: BROWSE, if: (el) => el.getAttribute("aria-expanded") === "true" }] : [],
    },
    {
      id: "layers",
      title: "Layers",
      body: "Show the SPHEREx infrared map behind the stars, or the constellation figures, star names and a grid.",
      defs: [TOUR_DEFS.spherex],
      spot: (phase) => (phase === 0 ? spotOf("[data-testid=layers-button]", "[data-testid=layers-panel]")() : skyGlobeSpot()),
      shape: circleThen(1),
      anchor: skyGlobeSpot,
      skip: noGlobe,
      setup: [
        ...closeSheet,
        { kind: "click", target: "[data-testid=mode-sphere]", if: (el) => el.getAttribute("aria-checked") !== "true" },
        { kind: "wait", ms: 200 },
      ],
      actions: [
        { kind: "click", target: "[data-testid=layers-button]", if: () => !q("[data-testid=layers-panel]") },
        { kind: "click", target: "[data-testid=layer-spherex]", if: (el) => el.getAttribute("aria-checked") !== "true", timeout: 3000 },
        { kind: "wait", ms: 600 },
        { kind: "click", target: "[data-testid=layers-button]", if: () => !!q("[data-testid=layers-panel]") },
        { kind: "phase", phase: 1 },
      ],
      cleanup: [{ kind: "click", target: "[data-testid=layers-button][data-state=open]" }],
    },
    {
      id: "space",
      title: "3D space",
      body: "Stars with a measured distance move out to their places around the Sun; the rest stay on a faint outer shell. Drag to orbit, and click a star to fly to it.",
      defs: [TOUR_DEFS.parallax],
      spot: (phase) => (phase === 0 ? spotOf("[data-testid=mode-toggle]")() : skyGlobeSpot()),
      shape: circleThen(1),
      anchor: skyGlobeSpot,
      skip: noGlobe,
      setup: closeSheet,
      actions: [...toSpace, { kind: "wait", ms: 500 }, { kind: "phase", phase: 1 }],
    },
    {
      id: "focus",
      title: "Focus on one star",
      body: "Pick Barnard's Star: the other stars dim, and a line from the Sun shows how far away it is.",
      defs: [TOUR_DEFS.lightYear],
      spot: (phase) =>
        phase === 0
          ? compact
            ? spotOf(searchBox, "[data-testid=search-results]")()
            : spotOf("[data-testid=rail-tab-targets]", "[data-testid=rail-target-barnards-star]")()
          : skyGlobeSpot(),
      shape: circleThen(1),
      anchor: skyGlobeSpot,
      skip: noGlobe,
      setup: [
        ...closeSheet,
        { kind: "until", test: () => !!q("[data-testid=mode-space]") && !q("[data-testid=mode-space]")!.hasAttribute("disabled"), timeout: 15000 },
        { kind: "click", target: "[data-testid=mode-space]", if: (el) => el.getAttribute("aria-checked") !== "true" },
      ],
      actions: [...pickBarnard, { kind: "phase", phase: 1 }],
      cleanup: compact ? [{ kind: "clear", target: SKY_SEARCH }] : [],
    },
    {
      id: "lab",
      title: "See it in SPHEREx",
      body: "Open in the Lab shows Barnard's Star in SPHEREx images taken months apart, so you can watch it move.",
      defs: [TOUR_DEFS.infrared],
      spot: spotOf("[data-testid=open-in-lab]"),
      setup: [
        ...pickBarnard.map((a) => ({ ...a, if: () => !barnardOpen() }) as TourAct),
        { kind: "until", test: barnardOpen, timeout: 4000 },
        { kind: "wait", ms: 350 },
        { kind: "reveal", target: "[data-testid=open-in-lab]" },
      ],
      actions: [{ kind: "point", target: "[data-testid=open-in-lab]", at: [0.4, 0.5] }],
      cleanup: compact ? [{ kind: "clear", target: SKY_SEARCH }] : [],
      next: { label: "Take the Lab tour", href: TOUR_HREF.lab },
    },
  ];
}

// ------------------------------------------------------------------------------- Lab

const LAB_VIEWER = "[data-tour=lab-viewer]";
const ANALYSIS = "[data-testid=detail-panel]";
const labReady = () => q("[data-testid=blink-player]")?.dataset.ready === "true";
const onBarnard = () => new URLSearchParams(window.location.search).get("target") === "barnards-star";

export function labTour(opts: { reduced: boolean }): TourStep[] {
  const wide = window.innerWidth >= 900; // three panes; below, the panes are tabs
  const phone = window.innerWidth < 640;
  // Wide: a pane the visitor hid comes back for the step that needs it (for the tour only).
  const show = (p: "data" | "player" | "analysis"): TourAct[] =>
    wide ? [{ kind: "click", target: `[data-testid=lab-toggle-${p}]`, if: (el) => el.getAttribute("aria-pressed") === "false" }] : [];
  const pane = (t: "data" | "viewer" | "analysis"): TourAct[] =>
    wide
      ? show(t === "viewer" ? "player" : t)
      : [{ kind: "click", target: `[data-testid=phone-tab-${t}]`, if: (el) => el.getAttribute("aria-selected") !== "true" }];
  const epochsMode: TourAct = { kind: "click", target: "[data-testid=mode-epochs]", if: (el) => el.getAttribute("aria-selected") !== "true" };
  const PLAY = "[data-testid=blink-play]";
  const playing = () => q(PLAY)?.dataset.playing === "true";

  const steps: TourStep[] = [];
  if (!onBarnard()) {
    steps.push({
      id: "switch",
      title: "The tour uses Barnard's Star",
      body: "Its SPHEREx images are prepared in advance, so the tour works even when the live archive is slow. Switch to it now?",
      defs: [],
      confirm: { yes: "Switch to Barnard's Star", no: "Not now" },
      setup: [...pane("data"), { kind: "click", target: "[data-testid=quick-pick-barnards-star]", timeout: 4000 }],
    });
  }

  const fov: TourStep[] = phone
    ? []
    : [
        {
          id: "fov",
          title: "Field of view",
          body: "How wide the view is; − and + zoom in steps. The blink frames show in views up to 30′ across, and wider views show only the all-sky map.",
          defs: [TOUR_DEFS.arcminute],
          spot: spotOf("[data-testid=fov-control]"),
          setup: pane("viewer"),
          actions: [{ kind: "click", target: "[data-testid=fov-control] button[aria-label^='Zoom in']" }],
        },
      ];

  steps.push(
    {
      id: "lab",
      title: "The Lab",
      body: wide
        ? "A workbench for SPHEREx images. The sky around Barnard's Star is in the middle; its visits and layers are on the left, and what is known and measured on the right."
        : "A workbench for SPHEREx images, here of the sky around Barnard's Star. The Data and Analysis tabs hold its visits, layers and measurements.",
      defs: [TOUR_DEFS.spherex],
      spot: spotOf(LAB_VIEWER),
      setup: [...pane("viewer"), ...show("data"), ...show("analysis"), { kind: "until", test: labReady, timeout: 20000 }],
    },
    {
      id: "field",
      title: "Choose a field",
      body: "Type a name or coordinates and press Enter, or pick one of the five challenge targets below the box.",
      defs: [TOUR_DEFS.raDec],
      spot: spotOf("[data-testid=data-pane] > div:first-child"),
      setup: pane("data"),
      actions: [
        { kind: "type", target: "[data-testid=lab-search]", text: "Barnard's Star" },
        { kind: "click", target: "form[role=search] button[type=submit]" },
        { kind: "until", test: () => !!q("[data-testid=lab-search-status]")?.textContent?.includes("Featured target"), timeout: 4000 },
      ],
      cleanup: [{ kind: "clear", target: "[data-testid=lab-search]" }],
    },
    ...fov,
    {
      id: "blink",
      title: "The blink",
      body: "The visits play in date order, over and over. The other stars stay put while Barnard's Star moves north, up the screen. Play, pause or step here, or press Space.",
      defs: [TOUR_DEFS.blink],
      spot: spotOf(PLAY, "[data-testid=blink-scrubber]", "[data-testid=frame-counter]"),
      setup: [...pane("viewer"), epochsMode, { kind: "until", test: labReady, timeout: 8000 }],
      // With reduced motion the blink does not start by itself, and the tour does not start it either.
      actions: opts.reduced
        ? [{ kind: "click", target: "[data-testid=blink-next]" }]
        : [
            { kind: "click", target: PLAY, if: () => playing() },
            { kind: "wait", ms: 900 },
            { kind: "click", target: PLAY, if: () => !playing() },
          ],
    },
    {
      id: "visits",
      title: "Visits",
      body: "Each row is one SPHEREx visit to this patch: its date, survey and how many exposures it took. Click a date to show that visit.",
      defs: [TOUR_DEFS.epoch],
      spot: spotOf("[data-testid=epoch-table]"),
      setup: [...pane("data"), ...show("player"), epochsMode],
      actions: [{ kind: "click", target: "[data-testid=epoch-row][data-epoch='2'] td:nth-child(2) button", at: [0.4, 0.5] }],
    },
    {
      id: "detectors",
      title: "Six detectors",
      body: "SPHEREx records each patch with six detectors, each in its own band of infrared wavelengths. Colour shows three of them at once.",
      defs: [TOUR_DEFS.detector, TOUR_DEFS.micron],
      spot: spotOf("[role=radiogroup][aria-label=Detector]", "[data-testid=det-range]"),
      setup: [...pane("viewer"), epochsMode],
      actions: [{ kind: "click", target: "[data-testid=det-D1]" }, { kind: "wait", ms: 700 }],
    },
    {
      id: "difference",
      title: "Difference",
      body: "Difference subtracts the first visit from one a year later. At the centre Barnard's Star leaves a pair: blue where it was at the first visit, red where it was a year on.",
      defs: [TOUR_DEFS.difference],
      spot: (phase) => (phase === 0 ? spotOf("[data-testid=mode-difference]")() : spotOf(LAB_VIEWER)()),
      anchor: spotOf(LAB_VIEWER),
      setup: pane("viewer"),
      actions: [
        { kind: "click", target: "[data-testid=mode-difference]" },
        { kind: "phase", phase: 1 },
        { kind: "point", target: LAB_VIEWER, at: [0.5, 0.48] },
      ],
    },
    {
      id: "motion",
      title: "Measured motion",
      body: "From its position at each visit, the Lab measures how fast Barnard's Star moves and in which direction, and sets that beside Gaia's catalogue value.",
      defs: [TOUR_DEFS.arcsecond, TOUR_DEFS.gaia],
      spot: spotOf(ANALYSIS),
      setup: pane("analysis"),
      actions: [
        { kind: "click", target: "[data-testid=analysis-tab-motion]" },
        { kind: "point", target: "[data-testid=tab-motion] dl", at: [0.3, 0.3], timeout: 3000 },
      ],
    },
    {
      id: "spectrum",
      title: "Spectrum",
      body: "Brightness against wavelength, one point per SPHEREx exposure. Barnard's Star is so bright that most of its points are saturated, drawn hollow.",
      defs: [TOUR_DEFS.spectrum],
      spot: spotOf(ANALYSIS),
      setup: pane("analysis"),
      actions: [{ kind: "click", target: "[data-testid=analysis-tab-spectrum]" }],
    },
    {
      id: "overlays",
      title: "Overlays",
      body: "Layers draw Gaia's stars as circles, the pixels SPHEREx flagged and the measured path. In NASA's WISE image from 2010, Barnard's Star still sits well south of where it is now.",
      defs: [TOUR_DEFS.wise],
      spot: (phase) => (phase === 0 ? spotOf("[data-testid=layer-list]")() : spotOf(LAB_VIEWER)()),
      anchor: wide ? spotOf(LAB_VIEWER) : undefined,
      setup: [...pane("viewer"), epochsMode, ...pane("data"), { kind: "reveal", target: "[data-testid=layer-list]" }],
      actions: [
        { kind: "click", target: "[data-testid=layer-toggle-wise]", if: (el) => el.getAttribute("aria-checked") !== "true" },
        { kind: "wait", ms: 400 },
        // On phones the viewer is a tab of its own: over to it, to see the old image.
        ...(wide ? [] : ([{ kind: "click", target: "[data-testid=phone-tab-viewer]" }] as TourAct[])),
        { kind: "phase", phase: 1 },
        { kind: "point", target: LAB_VIEWER, at: [0.47, 0.72] },
      ],
    },
    {
      id: "share",
      title: "Share it, and go further",
      body: "The address keeps the whole view, so a copied link opens exactly this. The AI page shows the candidates the search has found.",
      defs: [TOUR_DEFS.candidate],
      spot: spotOf("[data-testid=copy-link]", "header a[href='/ai']"),
      actions: [{ kind: "point", target: "[data-testid=copy-link]" }],
    },
  );
  return steps;
}

export function buildTour(id: TourId, opts: { reduced: boolean }): TourStep[] {
  return id === "sky" ? skyTour() : labTour(opts);
}

/** Whether a step uses the pointer at all. */
export const usesPointer = (s: TourStep) => (s.actions ?? []).some((a) => a.kind !== "wait" && a.kind !== "until" && a.kind !== "phase");

