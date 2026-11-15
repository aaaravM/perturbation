"use client";
// Sky mode: the globe of real stars, the side rail (search and star lists), the view controls
// and the right-hand panel. What is selected lives in the URL so a view can be shared:
//   ?target=r-dra        one of the five challenge targets
//   ?star=32349          a catalogue star by HIP number
//   ?ra=..&dec=..        a spot of sky
//   ?mode=3d             3D space instead of the sphere
// Layout: on large screens the rail is a column on the left and the globe uses the space to its
// right; below that the rail sits on top (search, with the lists folded away). The panel is a
// side panel from tablets up and a bottom sheet on phones. The globe is told how much space the
// interface covers and centres itself in the rest.

import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import dynamic from "next/dynamic";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { parseAsFloat, parseAsInteger, parseAsString, parseAsStringLiteral, useQueryStates } from "nuqs";
import { MinusIcon, PlusIcon, RotateCcwIcon } from "lucide-react";
import { FEATURED_TARGETS, findFeatured, type FeaturedTarget } from "@/lib/targets";
import { cn } from "@/lib/utils";
import { Term } from "@/components/ui/term";
import {
  ensureCatalogue,
  getCatalogue,
  getStar,
  spectralMeaning,
  starTitle,
  subscribeCatalogue,
  type Catalogue,
} from "@/lib/stars";
import type {
  GlobeHandle,
  GlobeMarker,
  GlobeSelection,
  GlobeView,
  Insets,
  SkyLayerToggles,
  SkyMode,
} from "@/components/globe/sky-globe";
import { FlatSkyMap } from "@/components/globe/flat-sky-map";
import { LayersControl } from "@/components/globe/layers-control";
import { usePreference } from "@/lib/preferences";
import { formatDec, formatRa } from "@/components/globe/globe-math";
import { SkyPanel } from "@/components/sky-panel/sky-panel";
import { KIND_LABEL, TargetStory } from "@/components/sky-panel/target-story";
import { StarStory } from "@/components/sky-panel/star-story";
import { SpotStory } from "@/components/sky-panel/spot-story";
import { SkyRail } from "@/components/sky-panel/sky-rail";

const SkyGlobe = dynamic(() => import("@/components/globe/sky-globe"), {
  ssr: false,
  loading: () => <GlobeLoading />,
});

const DEFAULT_LAYERS: SkyLayerToggles = {
  spherex: false,
  constellations: false,
  names: true,
  grid: false,
  markers: true,
};

/** Distance of each challenge target for 3D space, from its curated facts (light-years). */
function targetDistancePc(t: FeaturedTarget): number | null {
  const f = t.facts.find((x) => x.label === "Distance");
  const m = f ? /([\d.,]+)\s*light-years/.exec(f.value) : null;
  return m ? Number(m[1].replace(/,/g, "")) / 3.261564 : null;
}

const MARKERS: GlobeMarker[] = FEATURED_TARGETS.map((t) => ({
  slug: t.slug,
  name: t.name,
  ra: t.ra,
  dec: t.dec,
  distancePc: targetDistancePc(t),
  distanceText: t.facts.find((x) => x.label === "Distance")?.value,
}));

const urlKeys = {
  target: parseAsString,
  star: parseAsInteger,
  ra: parseAsFloat,
  dec: parseAsFloat,
  mode: parseAsStringLiteral(["3d"] as const),
};

// ---------------------------------------------------------------------------------- hooks

function useMedia(query: string, server = false) {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia(query);
      m.addEventListener("change", cb);
      return () => m.removeEventListener("change", cb);
    },
    () => window.matchMedia(query).matches,
    () => server,
  );
}

let webglCache: boolean | null = null;
function hasWebGL(): boolean {
  if (webglCache !== null) return webglCache;
  try {
    const c = document.createElement("canvas");
    webglCache = !!c.getContext("webgl2");
  } catch {
    webglCache = false;
  }
  return webglCache;
}

function useSize<T extends HTMLElement>() {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: T | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!el) {
      setSize({ width: 0, height: 0 });
      return;
    }
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setSize((s) => (s.width === r.width && s.height === r.height ? s : { width: r.width, height: r.height }));
    });
    ro.observe(el);
    observer.current = ro;
  }, []);
  return [ref, size] as const;
}

/** The site's Motion setting, mirrored on <html> as data-motion ("system", "reduce" or "full"). */
function useMotionSetting(): string | null {
  return useSyncExternalStore(
    (cb) => {
      const observer = new MutationObserver(cb);
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-motion"] });
      return () => observer.disconnect();
    },
    () => document.documentElement.getAttribute("data-motion"),
    () => null,
  );
}

/** Reduced motion: the Motion setting when it says "reduce" or "full", the system's otherwise. */
function useSiteReducedMotion(): boolean {
  const system = useReducedMotion() ?? false;
  const setting = useMotionSetting();
  return setting === "reduce" || (setting !== "full" && system);
}

function useCatalogue(): Catalogue | null {
  useEffect(() => ensureCatalogue(), []);
  return useSyncExternalStore(subscribeCatalogue, getCatalogue, () => null);
}

// ---------------------------------------------------------------------------------- component

export function SkyExperience() {
  const [q, setQ] = useQueryStates(urlKeys, { history: "replace", scroll: false });
  const catalogue = useCatalogue();
  const [localStar, setLocalStar] = useState<number | null>(null);

  // A star from the URL (HIP number) becomes a selection once its tier has loaded.
  const urlStarId = q.star !== null && catalogue ? (catalogue.byHip.get(q.star) ?? null) : null;
  const starId = localStar ?? urlStarId;
  const target = findFeatured(q.target);
  const star = starId !== null ? getStar(catalogue, starId) : null;
  const spot = q.ra !== null && q.dec !== null && Math.abs(q.dec) <= 90 ? { ra: ((q.ra % 360) + 360) % 360, dec: q.dec } : null;
  const selection: GlobeSelection = target
    ? { kind: "target", slug: target.slug }
    : starId !== null
      ? { kind: "star", id: starId }
      : spot
        ? { kind: "spot", ra: spot.ra, dec: spot.dec }
        : null;
  const pendingStar = q.star !== null && starId === null && !target && !(catalogue?.complete ?? false);

  // A link with mode=3d opens 3D space; otherwise the Settings choice, until the visitor picks here.
  const startIn = usePreference("skyStartIn");
  const [modeChoice, setModeChoice] = useState<SkyMode | null>(null);
  const mode: SkyMode = q.mode === "3d" ? "space" : (modeChoice ?? (startIn === "3d" ? "space" : "sphere"));
  const canSpace = catalogue?.source === "hipparcos";

  const reducedMotion = useSiteReducedMotion();
  const isLarge = useMedia("(min-width: 1024px)", true);
  const isTablet = useMedia("(min-width: 768px)", true);
  const coarse = useMedia("(pointer: coarse)", false);
  const [touched, setTouched] = useState(false);
  const webglOk = useSyncExternalStore(
    () => () => {},
    hasWebGL,
    () => true,
  );
  const [globeFailed, setGlobeFailed] = useState(false);
  const flat = !webglOk || globeFailed;

  const [hoveredTarget, setHoveredTarget] = useState<string | null>(null);
  const [railStar, setRailStar] = useState<number | null>(null);
  // Constellation lines and the SPHEREx map start as chosen in Settings, until changed here.
  const startConstellations = usePreference("skyConstellations");
  const startInfrared = usePreference("skyInfraredMap");
  const [layerChoice, setLayers] = useState<SkyLayerToggles | null>(null);
  const layers = useMemo(
    () => layerChoice ?? { ...DEFAULT_LAYERS, constellations: startConstellations, spherex: startInfrared },
    [layerChoice, startConstellations, startInfrared],
  );
  const [view, setView] = useState<GlobeView>("colour");
  const [imagery, setImagery] = useState(1);
  const [panelSize, setPanelSize] = useState({ width: 0, height: 0 });
  const [columnRef, columnSize] = useSize<HTMLDivElement>();
  const [topRef, topSize] = useSize<HTMLDivElement>();
  const globe = useRef<GlobeHandle>(null);
  const opener = useRef<HTMLElement | null>(null);
  const centreText = useRef<HTMLSpanElement>(null);
  const [announcement, setAnnouncement] = useState("");
  const headingId = useId();

  const panelLayout: "side" | "sheet" = isTablet ? "side" : "sheet";
  const open = selection !== null || pendingStar;

  const insets: Insets = useMemo(() => {
    const right = open && panelLayout === "side" ? panelSize.width + 32 : 0;
    if (isLarge) return { top: 0, right, bottom: 0, left: columnSize.width ? columnSize.width + 40 : 0 };
    if (open && panelLayout === "sheet") return { top: topSize.height ? topSize.height + 8 : 0, right: 0, bottom: panelSize.height, left: 0 };
    return { top: topSize.height ? topSize.height + 12 : 0, right, bottom: 56, left: 0 };
  }, [open, panelLayout, panelSize, isLarge, columnSize.width, topSize.height]);

  // ------------------------------------------------------------------ selection
  const remember = (from: HTMLElement | null | undefined) => {
    opener.current = from ?? document.querySelector<HTMLElement>("[data-testid=sky-globe]");
  };
  const selectTarget = useCallback(
    (slug: string, from?: HTMLElement | null) => {
      remember(from);
      setLocalStar(null);
      void setQ({ target: slug, star: null, ra: null, dec: null });
    },
    [setQ],
  );
  const selectStar = useCallback(
    (id: number, from?: HTMLElement | null) => {
      remember(from);
      const s = getStar(getCatalogue(), id);
      setLocalStar(id);
      void setQ({
        target: null,
        star: s?.hip ?? null,
        ra: s && !s.hip ? Number(s.ra.toFixed(5)) : null,
        dec: s && !s.hip ? Number(s.dec.toFixed(5)) : null,
      });
      if (s) setAnnouncement(`${starTitle(s)} selected.`);
    },
    [setQ],
  );
  const selectSpot = useCallback(
    (ra: number, dec: number) => {
      remember(null);
      setLocalStar(null);
      void setQ({ target: null, star: null, ra: Number(ra.toFixed(5)), dec: Number(dec.toFixed(5)) });
    },
    [setQ],
  );
  const close = useCallback(() => {
    setLocalStar(null);
    void setQ({ target: null, star: null, ra: null, dec: null });
    const back = opener.current;
    opener.current = null;
    requestAnimationFrame(() => back?.focus({ preventScroll: true }));
  }, [setQ]);
  const setMode = useCallback(
    (m: SkyMode) => {
      setModeChoice(m);
      void setQ({ mode: m === "space" ? "3d" : null });
      setAnnouncement(m === "space" ? "3D space: the stars move out to their distances from the Sun." : "Back on the sky sphere.");
    },
    [setQ],
  );

  const contentKey = target
    ? `t:${target.slug}`
    : starId !== null
      ? `s:${starId}`
      : spot
        ? `p:${spot.ra.toFixed(4)},${spot.dec.toFixed(4)}`
        : pendingStar
          ? "pending"
          : "";
  useEffect(() => {
    if (!contentKey || contentKey === "pending") return;
    const id = requestAnimationFrame(() => document.getElementById(headingId)?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(id);
  }, [contentKey, headingId]);

  const onCentreChange = useCallback((ra: number, dec: number) => {
    const el = centreText.current;
    if (el) el.textContent = `RA ${formatRa(ra, 1)}  Dec ${formatDec(dec, 1)}`;
  }, []);
  const onUnavailable = useCallback(() => setGlobeFailed(true), []);
  const nextTarget = (t: FeaturedTarget) =>
    FEATURED_TARGETS[(FEATURED_TARGETS.findIndex((x) => x.slug === t.slug) + 1) % FEATURED_TARGETS.length];

  const shareUrl =
    typeof window === "undefined"
      ? ""
      : `${window.location.origin}/sky?${new URLSearchParams(
          Object.entries({
            star: q.star !== null ? String(q.star) : "",
            ra: q.ra !== null ? String(q.ra) : "",
            dec: q.dec !== null ? String(q.dec) : "",
            mode: q.mode ?? "",
          }).filter(([, v]) => v),
        ).toString()}`;

  const eyebrow = target
    ? KIND_LABEL[target.kind]
    : star
      ? starEyebrow(star.sp)
      : spot
        ? "Empty sky"
        : "Star";

  // ------------------------------------------------------------------ pieces
  const rail = (
    <SkyRail
      catalogue={catalogue}
      selection={selection}
      hoveredTarget={hoveredTarget}
      onSelectStar={selectStar}
      onSelectTarget={selectTarget}
      onSelectCoords={selectSpot}
      onHoverStar={setRailStar}
      onHoverTarget={setHoveredTarget}
      compact={!isLarge}
    />
  );

  return (
    <div
      className="absolute inset-0"
      onPointerDownCapture={(e) => {
        if (!touched && (e.target as HTMLElement).closest("[data-testid=sky-globe]")) setTouched(true);
      }}
      onWheelCapture={(e) => {
        if (!touched && (e.target as HTMLElement).closest("[data-testid=sky-globe]")) setTouched(true);
      }}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_70%_at_60%_50%,#0b0b0a_0%,var(--ink)_70%)]"
      />

      {/* The rail sits above the globe and takes the pointer itself, so its words, links and
          explanations work with a mouse; only the shading that fades it into the sky lets drags
          through to the globe. */}
      {isLarge ? (
        <div ref={columnRef} className="absolute top-7 bottom-6 left-8 z-10 flex w-[20rem] flex-col gap-6 xl:left-10">
          <div
            aria-hidden
            className="pointer-events-none absolute -top-7 -bottom-6 -left-10 -z-10 w-[calc(100%+8rem)] bg-[linear-gradient(to_right,rgb(5_5_5/0.94)_0%,rgb(5_5_5/0.88)_62%,rgb(5_5_5/0.45)_82%,transparent_100%)]"
          />
          <Intro mode={mode} />
          <div className="flex min-h-0 flex-1 flex-col">{rail}</div>
        </div>
      ) : (
        <div ref={topRef} className="absolute inset-x-3 top-3 z-10 flex flex-col gap-2 sm:inset-x-5">
          <AnimatePresence initial={false}>
            {!open && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2 }}
              >
                <Intro compact mode={mode} />
              </motion.div>
            )}
          </AnimatePresence>
          <div className="rounded-lg border border-hair bg-ink/85 p-2">{rail}</div>
        </div>
      )}

      {flat ? (
        <div className="absolute inset-0 flex items-center justify-center p-4 lg:pl-[22rem]">
          <FlatSkyMap
            markers={MARKERS}
            selection={selection}
            hovered={hoveredTarget}
            onHoverChange={setHoveredTarget}
            onSelectTarget={(slug) => selectTarget(slug, null)}
            onSelectPatch={selectSpot}
            className="max-w-4xl"
          />
        </div>
      ) : (
        <SkyGlobe
          catalogue={catalogue}
          markers={MARKERS}
          selection={selection}
          hovered={hoveredTarget}
          railStar={railStar}
          onHoverChange={setHoveredTarget}
          onSelectTarget={(slug) => selectTarget(slug)}
          onSelectStar={(id) => selectStar(id)}
          onSelectSpot={selectSpot}
          onClearSelection={close}
          mode={canSpace ? mode : "sphere"}
          layers={layers}
          view={view}
          imagery={imagery}
          insets={insets}
          reducedMotion={reducedMotion}
          onCentreChange={onCentreChange}
          onUnavailable={onUnavailable}
          handleRef={globe}
        />
      )}

      <p id="sky-globe-help" className="sr-only">
        Drag, or use the arrow keys, to turn the view. Plus and minus zoom; scrolling or pinching zooms towards a
        spot, and a double click flies in. Click a star for its details, or empty sky to learn about that spot; Enter
        describes the spot at the centre. The side list and the search box reach every star by keyboard. The 3D
        space button moves the stars with a measured parallax out to their real distances.
      </p>
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>

      <AnimatePresence>
        {isLarge && !flat && !touched && !open && (
          <motion.p
            key="hint"
            aria-hidden
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0, transition: { delay: reducedMotion ? 0 : 3, duration: 0.6 } }}
            exit={{ opacity: 0, transition: { duration: 0.25 } }}
            className="pointer-events-none absolute top-6 text-center text-micro text-fg-faint"
            style={{ left: insets.left, right: insets.right }}
          >
            {mode === "space"
              ? coarse
                ? "Drag to orbit · Pinch to fly closer · Tap a star to fly to it"
                : "Drag to orbit · Scroll to fly closer · Click a star to fly to it"
              : coarse
                ? "Drag to turn · Pinch to zoom · Tap a star"
                : "Drag to turn · Scroll to zoom · Click any star, or empty sky"}
          </motion.p>
        )}
      </AnimatePresence>

      {/* View controls */}
      <div
        className={cn(
          "absolute bottom-4 z-10 flex items-center gap-2 transition-[right,opacity] duration-500 ease-out-expo lg:bottom-6",
          open && !isTablet && "pointer-events-none opacity-0",
        )}
        style={{ right: open && panelLayout === "side" ? panelSize.width + 40 : isLarge ? 32 : 12 }}
      >
        <p
          className={cn("hidden rounded-md bg-ink/70 px-2 py-1.5 text-micro text-fg-faint", !flat && mode === "sphere" && "xl:block")}
          aria-hidden
        >
          <span className="mr-2">Centre</span>
          <span ref={centreText} className="readout whitespace-pre text-fg-dim" />
        </p>
        {!flat && (
          <>
            <ModeSwitch mode={mode} onChange={setMode} disabled={!canSpace} reducedMotion={reducedMotion} />
            <div role="toolbar" aria-label="Globe view" className="inline-flex items-center rounded-md border border-hair bg-ink/80 p-0.5">
              <LayersControl
                layers={layers}
                onLayersChange={setLayers}
                view={view}
                onViewChange={setView}
                imagery={imagery}
                onImageryChange={setImagery}
                disabled={mode === "space"}
              />
              <span aria-hidden className="mx-1 h-4 w-px bg-hair-strong" />
              <IconButton label="Zoom out" onClick={() => globe.current?.zoomBy(1 / 1.3)}>
                <MinusIcon />
              </IconButton>
              <IconButton label="Zoom in" onClick={() => globe.current?.zoomBy(1.3)}>
                <PlusIcon />
              </IconButton>
              <IconButton label="Reset view" onClick={() => globe.current?.resetView()}>
                <RotateCcwIcon />
              </IconButton>
            </div>
          </>
        )}
      </div>

      <AnimatePresence>
        {open && (
          <SkyPanel
            key="panel"
            layout={panelLayout}
            labelledBy={headingId}
            eyebrow={eyebrow}
            contentKey={contentKey}
            onClose={close}
            onSize={setPanelSize}
            reducedMotion={reducedMotion}
          >
            {target ? (
              <TargetStory
                target={target}
                headingId={headingId}
                reducedMotion={reducedMotion}
                next={nextTarget(target)}
                onSelect={(slug) => selectTarget(slug)}
              />
            ) : star && catalogue ? (
              <StarStory
                star={star}
                catalogue={catalogue}
                headingId={headingId}
                reducedMotion={reducedMotion}
                inSpace={mode === "space"}
                onFly3D={() => setMode("space")}
                onSelectTarget={(slug) => selectTarget(slug)}
                shareUrl={shareUrl}
              />
            ) : spot ? (
              <SpotStory
                ra={spot.ra}
                dec={spot.dec}
                catalogue={catalogue}
                headingId={headingId}
                reducedMotion={reducedMotion}
                onSelectStar={(id) => selectStar(id)}
                onHoverStar={setRailStar}
              />
            ) : (
              <p id={headingId} tabIndex={-1} className="text-ui text-fg-dim outline-none">
                Finding HIP <span className="readout">{q.star}</span> in the catalogue…
              </p>
            )}
          </SkyPanel>
        )}
      </AnimatePresence>
    </div>
  );
}

function starEyebrow(sp: string | null): string {
  const m = spectralMeaning(sp);
  if (!m) return "Star";
  const first = m.split(/[;:.]/)[0].replace(/^(A|An) /, "");
  const clean = first.replace(/, steadily burning hydrogen like the Sun/, "");
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

// ---------------------------------------------------------------------------------- pieces

function Intro({ compact = false, mode }: { compact?: boolean; mode: SkyMode }) {
  return (
    <div className="flex flex-col gap-2.5">
      <h1 className={cn("text-balance text-fg", compact ? "text-heading" : "text-title")}>
        {mode === "space" ? "The stars around the Sun" : "Every star you can click"}
      </h1>
      {compact ? null : (
        <p className="text-ui measure text-pretty text-fg-dim">
          {mode === "space" ? (
            <>
              Stars with a measured <Term k="parallax">parallax</Term> sit at their real distances; the rest
              stay on the faint outer shell. Fly around; click any star.
            </>
          ) : (
            <>
              About 118,000 stars from the Hipparcos catalogue, in their true colours. Click one to see
              what is known about it, and what SPHEREx has seen there.
            </>
          )}
        </p>
      )}
    </div>
  );
}

function ModeSwitch({
  mode,
  onChange,
  disabled,
  reducedMotion,
}: {
  mode: SkyMode;
  onChange: (m: SkyMode) => void;
  disabled: boolean;
  reducedMotion: boolean;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="View"
      className="relative inline-flex items-center rounded-md border border-hair bg-ink/80 p-0.5"
      data-testid="mode-toggle"
      title={disabled ? "3D space needs the distance catalogue, which is still loading" : undefined}
    >
      {(
        [
          { id: "sphere", label: "Sphere" },
          { id: "space", label: "3D space" },
        ] as const
      ).map((m) => {
        const on = mode === m.id;
        return (
          <button
            key={m.id}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={disabled && m.id === "space"}
            onClick={() => onChange(m.id)}
            className={cn(
              "relative h-7 rounded-[4px] px-2.5 text-micro font-medium transition-colors disabled:opacity-40",
              on ? "text-fg" : "text-fg-dim hover:text-fg",
            )}
            data-testid={`mode-${m.id}`}
          >
            {on ? (
              <motion.span
                layoutId="sky-mode-pill"
                className="absolute inset-0 rounded-[4px] border border-accent-muted bg-white/[0.06]"
                transition={reducedMotion ? { duration: 0 } : { type: "spring", stiffness: 480, damping: 38 }}
              />
            ) : null}
            <span className="relative">{m.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="grid size-7 place-items-center rounded-[4px] text-fg-dim transition-colors hover:bg-white/[0.06] hover:text-fg [&_svg]:size-3.5"
    >
      {children}
    </button>
  );
}

function GlobeLoading() {
  return (
    <div className="absolute inset-0 grid place-items-center" aria-hidden>
      <div className="size-[min(62vh,80vw)] animate-pulse rounded-full bg-white/[0.015]" />
    </div>
  );
}
