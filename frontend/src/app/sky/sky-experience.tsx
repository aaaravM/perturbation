"use client";
// Sky mode: the globe, the list of featured objects, the view controls and the right-hand panel.
// Selection lives in the URL for featured objects (/sky?target=r-dra), so a view can be shared.
// Layout: on large screens an editorial left column (intro, list, map caption) and the globe in
// the space to its right; below that, the intro on top and the list as a bottom rail; the panel
// is a side panel from tablets up and a bottom sheet on phones. The globe is told how much space
// the interface covers and centres itself in the rest.

import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import dynamic from "next/dynamic";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { parseAsString, useQueryState } from "nuqs";
import { MinusIcon, PlusIcon, RotateCcwIcon } from "lucide-react";
import { FEATURED_TARGETS, findFeatured, type FeaturedTarget } from "@/lib/targets";
import { cn } from "@/lib/utils";
import type {
  GlobeHandle,
  GlobeSelection,
  GlobeView,
  Insets,
  SkyLayerToggles,
} from "@/components/globe/sky-globe";
import { FlatSkyMap } from "@/components/globe/flat-sky-map";
import { LayersControl } from "@/components/globe/layers-control";
import { formatDec, formatRa } from "@/components/globe/globe-math";
import { SkyPanel } from "@/components/sky-panel/sky-panel";
import { KIND_LABEL, TargetStory } from "@/components/sky-panel/target-story";
import { PatchStory } from "@/components/sky-panel/patch-story";

const SkyGlobe = dynamic(() => import("@/components/globe/sky-globe"), {
  ssr: false,
  loading: () => <GlobeLoading />,
});

const SKY_TEXTURE_META = "/textures/spherex-sky.json";
/** Constellations start faint and the grid off; everything else on. */
const DEFAULT_LAYERS: SkyLayerToggles = {
  stars: true,
  constellations: true,
  names: true,
  grid: false,
  markers: true,
};
const MARKERS = FEATURED_TARGETS.map(({ slug, name, ra, dec }) => ({ slug, name, ra, dec }));

// ---------------------------------------------------------------------------------- media hooks

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

/** Callback ref that tracks an element's size; reports 0 x 0 while it is unmounted. */
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
      setSize((s) =>
        s.width === r.width && s.height === r.height ? s : { width: r.width, height: r.height },
      );
    });
    ro.observe(el);
    observer.current = ro;
  }, []);
  return [ref, size] as const;
}

/** Band ranges of the globe texture, from the JSON that documents it (public/textures). */
type SkyMeta = Partial<Record<"blue" | "green" | "red" | "mono", [number, number]>>;
function useSkyMeta(enabled: boolean): SkyMeta | null {
  const [meta, setMeta] = useState<SkyMeta | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    fetch(SKY_TEXTURE_META, { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then(
        (
          j: {
            channels?: {
              rgb?: Record<string, { range_um?: [number, number] }>;
              mono?: { range_um?: [number, number] };
            };
          } | null,
        ) => {
          const rgb = j?.channels?.rgb;
          if (!rgb) return;
          const ok = (r: unknown): r is [number, number] =>
            Array.isArray(r) && r.length === 2 && r.every((v) => Number.isFinite(v));
          const pick = (r: unknown) => (ok(r) ? r : undefined);
          setMeta({
            blue: pick(rgb.blue?.range_um),
            green: pick(rgb.green?.range_um),
            red: pick(rgb.red?.range_um),
            mono: pick(j?.channels?.mono?.range_um),
          });
        },
      )
      .catch(() => {});
    return () => controller.abort();
  }, [enabled]);
  return meta;
}

// ---------------------------------------------------------------------------------- component

export function SkyExperience() {
  const [targetSlug, setTargetSlug] = useQueryState(
    "target",
    parseAsString.withOptions({ history: "replace", scroll: false }),
  );
  const [patch, setPatch] = useState<{ ra: number; dec: number } | null>(null);
  const target = findFeatured(targetSlug);
  const selection: GlobeSelection = target
    ? { kind: "target", slug: target.slug }
    : patch
      ? { kind: "patch", ra: patch.ra, dec: patch.dec }
      : null;

  const reducedMotion = useReducedMotion() ?? false;
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

  const [hovered, setHovered] = useState<string | null>(null);
  const [layers, setLayers] = useState<SkyLayerToggles>(DEFAULT_LAYERS);
  const [view, setView] = useState<GlobeView>("colour");
  const [imagery, setImagery] = useState(1);
  const [textureReady, setTextureReady] = useState(false);
  const [panelSize, setPanelSize] = useState({ width: 0, height: 0 });
  const [columnRef, columnSize] = useSize<HTMLDivElement>();
  const [introRef, introSize] = useSize<HTMLDivElement>();
  const [railRef, railSize] = useSize<HTMLDivElement>();
  const globe = useRef<GlobeHandle>(null);
  const opener = useRef<HTMLElement | null>(null);
  const centreText = useRef<HTMLSpanElement>(null);
  const [announcement, setAnnouncement] = useState("");
  const keyboardTurn = useRef(false);
  const announceTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const headingId = useId();

  const panelLayout: "side" | "sheet" = isTablet ? "side" : "sheet";
  const open = selection !== null;

  // Space the interface covers; the globe centres itself in what is left.
  const insets: Insets = useMemo(() => {
    const right = open && panelLayout === "side" ? panelSize.width + 32 : 0;
    if (isLarge) return { top: 0, right, bottom: 0, left: columnSize.width ? columnSize.width + 40 : 0 };
    if (open && panelLayout === "sheet") return { top: 0, right: 0, bottom: panelSize.height, left: 0 };
    return {
      top: !open && introSize.height ? introSize.height + 24 : 0,
      right,
      bottom: railSize.height ? railSize.height + 28 : 0,
      left: 0,
    };
  }, [open, panelLayout, panelSize, isLarge, columnSize.width, introSize.height, railSize.height]);

  // ------------------------------------------------------------------ selection
  const selectTarget = useCallback(
    (slug: string, from?: HTMLElement | null) => {
      if (from !== undefined) opener.current = from;
      else if (!opener.current)
        opener.current = document.querySelector<HTMLElement>("[data-testid=sky-globe]");
      setPatch(null);
      void setTargetSlug(slug);
    },
    [setTargetSlug],
  );
  const selectPatch = useCallback(
    (ra: number, dec: number) => {
      opener.current = document.querySelector<HTMLElement>("[data-testid=sky-globe]");
      void setTargetSlug(null);
      setPatch({ ra, dec });
    },
    [setTargetSlug],
  );
  const close = useCallback(() => {
    void setTargetSlug(null);
    setPatch(null);
    const back = opener.current;
    opener.current = null;
    requestAnimationFrame(() => back?.focus({ preventScroll: true }));
  }, [setTargetSlug]);

  // Focus the panel heading whenever it shows something new.
  const contentKey = target
    ? `t:${target.slug}`
    : patch
      ? `p:${patch.ra.toFixed(4)},${patch.dec.toFixed(4)}`
      : "";
  useEffect(() => {
    if (!contentKey) return;
    const id = requestAnimationFrame(() =>
      document.getElementById(headingId)?.focus({ preventScroll: true }),
    );
    return () => cancelAnimationFrame(id);
  }, [contentKey, headingId]);

  const onCentreChange = useCallback((ra: number, dec: number) => {
    const el = centreText.current;
    if (el) el.textContent = `RA ${formatRa(ra, 1)}  Dec ${formatDec(dec, 1)}`;
    if (keyboardTurn.current) {
      clearTimeout(announceTimer.current);
      announceTimer.current = setTimeout(() => {
        keyboardTurn.current = false;
        setAnnouncement(
          `Centre of view: right ascension ${Math.round(ra)} degrees, declination ${dec < 0 ? "minus " : ""}${Math.abs(Math.round(dec))} degrees.`,
        );
      }, 650);
    }
  }, []);
  useEffect(() => () => clearTimeout(announceTimer.current), []);

  const onTextureReady = useCallback(() => setTextureReady(true), []);
  const skyMeta = useSkyMeta(textureReady || flat);
  const onUnavailable = useCallback(() => setGlobeFailed(true), []);
  const nextTarget = (t: FeaturedTarget) =>
    FEATURED_TARGETS[(FEATURED_TARGETS.findIndex((x) => x.slug === t.slug) + 1) % FEATURED_TARGETS.length];

  // ------------------------------------------------------------------ pieces
  const list = (
    <TargetList
      targets={FEATURED_TARGETS}
      selected={target?.slug ?? null}
      hovered={hovered}
      onHover={setHovered}
      onSelect={(slug, el) => selectTarget(slug, el)}
      variant={isLarge ? "column" : "rail"}
    />
  );

  const band = (b: [number, number] | undefined) =>
    b ? <span className="readout">{`${b[0].toFixed(2)}–${b[1].toFixed(2)}`}</span> : null;
  const caption = (
    <p className="text-micro text-pretty text-fg-faint" data-testid="globe-caption">
      {textureReady || flat ? (
        <>
          {view === "mono" && !flat ? (
            <>
              SPHEREx all-sky map, Data Release 1, at {skyMeta?.mono ? band(skyMeta.mono) : "about 1.25"} µm:
              one of its 102 colours on its own, shown in grey.
            </>
          ) : skyMeta?.blue && skyMeta.green && skyMeta.red ? (
            <>
              SPHEREx all-sky map, Data Release 1, in false colour: blue {band(skyMeta.blue)} µm, green{" "}
              {band(skyMeta.green)} µm, red {band(skyMeta.red)} µm.
            </>
          ) : (
            <>SPHEREx all-sky map, Data Release 1, in false colour.</>
          )}{" "}
          {layers.stars && !flat ? "White dots: Hipparcos catalogue stars to magnitude 8. " : null}
          Seen from outside, so the sky is mirror-reversed, as on a classic celestial globe.
        </>
      ) : (
        <>
          The SPHEREx map is still being prepared for the globe. Until it arrives, the white dots show the
          stars of the Hipparcos catalogue.
        </>
      )}
    </p>
  );

  return (
    <div
      className="absolute inset-0"
      onPointerDownCapture={(e) => {
        if (!touched && (e.target as HTMLElement).closest("[data-testid=sky-globe]")) setTouched(true);
      }}
      onKeyDownCapture={(e) => {
        if ((e.target as HTMLElement).dataset.testid === "sky-globe" && e.key.startsWith("Arrow")) {
          keyboardTurn.current = true;
        }
      }}
    >
      {/* Quiet backdrop: a faint pool of light behind the globe, nothing more. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_70%_at_58%_50%,#0d0d0c_0%,var(--ink)_70%)]"
      />

      {/* Heading and list first in reading order; they float above the globe (z-10).
          Large screens: one editorial column on the left. */}
      {isLarge ? (
        <div
          ref={columnRef}
          className="pointer-events-none absolute top-8 bottom-7 left-8 z-10 flex w-[19.5rem] flex-col gap-8 xl:left-10"
        >
          {/* A scrim behind the column, for when the globe is flown close and passes under it. */}
          <div
            aria-hidden
            className="absolute -top-8 -bottom-7 -left-10 -z-10 w-[calc(100%+9rem)] bg-[linear-gradient(to_right,rgb(5_5_5/0.9)_0%,rgb(5_5_5/0.78)_55%,transparent_100%)]"
          />
          <Intro />
          <div className="pointer-events-auto">{list}</div>
          <div className="pointer-events-auto mt-auto">{caption}</div>
        </div>
      ) : (
        <>
          <AnimatePresence initial={false}>
            {!open && (
              <motion.div
                ref={introRef}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="pointer-events-none absolute inset-x-4 top-4 z-10 sm:inset-x-6"
              >
                <Intro compact />
              </motion.div>
            )}
          </AnimatePresence>
          <div
            ref={railRef}
            className="absolute bottom-3 left-0 z-10 transition-[right] duration-500 ease-out-expo"
            style={{ right: open && panelLayout === "side" ? panelSize.width + 24 : 0 }}
          >
            {list}
          </div>
        </>
      )}

      {flat ? (
        <div className="absolute inset-0 flex items-center justify-center p-4 lg:pl-[22rem]">
          <FlatSkyMap
            markers={MARKERS}
            selection={selection}
            hovered={hovered}
            onHoverChange={setHovered}
            onSelectTarget={(slug) => selectTarget(slug, null)}
            onSelectPatch={selectPatch}
            className="max-w-4xl"
          />
        </div>
      ) : (
        <SkyGlobe
          markers={MARKERS}
          selection={selection}
          hovered={hovered}
          onHoverChange={setHovered}
          onSelectTarget={(slug) => selectTarget(slug)}
          onSelectPatch={selectPatch}
          layers={layers}
          view={view}
          imagery={imagery}
          insets={insets}
          reducedMotion={reducedMotion}
          onTextureReady={onTextureReady}
          onCentreChange={onCentreChange}
          onUnavailable={onUnavailable}
          handleRef={globe}
        />
      )}

      <p id="sky-globe-help" className="sr-only">
        Drag, or use the arrow keys, to fly round the globe. Plus and minus zoom; scrolling or pinching zooms
        towards a spot, a double click flies in, and Shift-drag or right-drag moves the view a little. Enter
        describes the patch of sky at the centre. The five featured objects are also listed as buttons.
      </p>
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>

      {/* First-visit hint, until the globe is first touched. */}
      <AnimatePresence>
        {isLarge && !flat && !touched && !open && (
          <motion.p
            key="hint"
            aria-hidden
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0, transition: { delay: reducedMotion ? 0 : 2.8, duration: 0.6 } }}
            exit={{ opacity: 0, transition: { duration: 0.25 } }}
            className="pointer-events-none absolute top-7 text-center text-micro text-fg-faint"
            style={{ left: insets.left, right: insets.right }}
          >
            {coarse
              ? "Drag to orbit · Pinch to zoom · Double-tap to fly in"
              : "Drag to orbit · Scroll to zoom · Double-click to fly in"}
          </motion.p>
        )}
      </AnimatePresence>

      {/* View controls */}
      <div
        className={cn(
          "absolute flex items-center gap-3 transition-[right,opacity] duration-500 ease-out-expo",
          isLarge ? "bottom-7" : "right-4",
          open && !isTablet && "pointer-events-none opacity-0",
        )}
        style={
          isLarge
            ? { right: open && panelLayout === "side" ? panelSize.width + 40 : 32 }
            : {
                bottom: railSize.height + 18,
                right: open && panelLayout === "side" ? panelSize.width + 32 : 16,
              }
        }
      >
        <p
          className={cn("hidden rounded-md bg-ink/70 px-2 py-1.5 text-micro text-fg-faint", !flat && "sm:block")}
          aria-hidden
        >
          <span className="mr-2">Centre</span>
          <span ref={centreText} className="readout whitespace-pre text-fg-dim" />
        </p>
        {!flat && (
          <div
            role="toolbar"
            aria-label="Globe view"
            className="inline-flex items-center rounded-md border border-hair bg-ink/70 p-0.5"
          >
            <LayersControl
              layers={layers}
              onLayersChange={setLayers}
              view={view}
              onViewChange={setView}
              imagery={imagery}
              onImageryChange={setImagery}
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
        )}
      </div>

      <AnimatePresence>
        {open && (
          <SkyPanel
            key="panel"
            layout={panelLayout}
            labelledBy={headingId}
            eyebrow={target ? KIND_LABEL[target.kind] : "Anywhere on the globe"}
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
            ) : patch ? (
              <PatchStory
                ra={patch.ra}
                dec={patch.dec}
                headingId={headingId}
                targets={FEATURED_TARGETS}
                onSelect={(slug) => selectTarget(slug)}
              />
            ) : null}
          </SkyPanel>
        )}
      </AnimatePresence>
    </div>
  );
}

// ---------------------------------------------------------------------------------- pieces

function Intro({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex flex-col gap-3">
      <h1 className={cn("text-balance text-fg", compact ? "text-heading" : "text-title")}>
        The sky as SPHEREx sees it
      </h1>
      <p className={cn("text-pretty text-fg-dim", compact ? "text-meta" : "text-ui measure")}>
        {compact
          ? "The whole sky in infrared light, on a globe you can fly around. Pick an object to watch it move."
          : "The whole sky in infrared light, wrapped around a globe you can fly around, with the real stars as white dots. Pick an object to watch it move, or click anywhere to see what is there."}
      </p>
    </div>
  );
}

function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
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

function TargetList({
  targets,
  selected,
  hovered,
  onHover,
  onSelect,
  variant,
}: {
  targets: FeaturedTarget[];
  selected: string | null;
  hovered: string | null;
  onHover: (slug: string | null) => void;
  onSelect: (slug: string, el: HTMLElement) => void;
  variant: "column" | "rail";
}) {
  const column = variant === "column";
  return (
    <nav aria-labelledby="featured-heading" data-testid="target-list">
      <h2 id="featured-heading" className={cn("text-meta text-fg-faint", column ? "mb-2.5" : "sr-only")}>
        Five objects to start with
      </h2>
      <ul
        className={cn(
          column
            ? "flex flex-col"
            : "flex snap-x snap-mandatory gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] sm:px-6 [&::-webkit-scrollbar]:hidden",
        )}
      >
        {targets.map((t, i) => {
          const isSelected = selected === t.slug;
          const isHovered = hovered === t.slug;
          return (
            <li key={t.slug} className={cn(column ? "" : "shrink-0 snap-start")}>
              <button
                type="button"
                aria-pressed={isSelected}
                onClick={(e) => onSelect(t.slug, e.currentTarget)}
                onPointerEnter={() => onHover(t.slug)}
                onPointerLeave={() => onHover(null)}
                onFocus={() => onHover(t.slug)}
                onBlur={() => onHover(null)}
                className={cn(
                  "group relative flex w-full flex-col items-start text-left transition-colors duration-200",
                  column
                    ? "gap-0.5 border-t border-hair py-3 pr-2 pl-4 hover:bg-white/[0.025]"
                    : "panel w-[13.5rem] gap-0.5 px-3.5 py-2.5",
                  column && i === targets.length - 1 && "border-b",
                  (isSelected || isHovered) && !column && "border-hair-strong",
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    "absolute rounded-full bg-accent transition-[opacity,transform] duration-300 ease-out-expo",
                    column ? "top-3.5 bottom-3.5 left-0 w-0.5 origin-center" : "inset-x-3.5 top-0 h-px",
                    isSelected ? "scale-100 opacity-100" : "scale-50 opacity-0",
                  )}
                />
                <span
                  className={cn(
                    "text-ui font-medium transition-colors",
                    isSelected || isHovered ? "text-fg" : "text-fg/90",
                  )}
                >
                  {t.name}
                </span>
                <span className="text-meta text-pretty text-fg-dim">{t.tagline}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function GlobeLoading() {
  return (
    <div className="absolute inset-0 grid place-items-center" aria-hidden>
      <div className="size-[min(62vh,80vw)] animate-pulse rounded-full bg-white/[0.02]" />
    </div>
  );
}
