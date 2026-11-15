"use client";
// Lab mode at /explore: a scientific workbench. A left Data pane (search, epochs, layers), the
// Aladin viewer in the centre with its toolbar, live status bar and the blink timeline, and a
// right Analysis pane (object, spectrum, light curve, motion, data, provenance). The panes are
// docked and the page never scrolls, so nothing slides away while you pan and zoom. Everything
// that defines the view lives in the URL. On phones the panes become three tabs.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useQueryStates } from "nuqs";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { toast } from "sonner";
import Link from "next/link";
import { CommandIcon, DownloadIcon, GlobeIcon, KeyboardIcon, LinkIcon, MousePointerClickIcon } from "lucide-react";
import { AladinView, type AladinStatus, type SkyView } from "@/components/sky/aladin-view";
import type { AladinSession } from "@/components/sky/aladin-session";
import { extra } from "@/components/sky/aladin-extra";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Term } from "@/components/ui/term";
import { loadSpectralChannels, type SpectralChannel } from "@/lib/spherex";
import { FEATURED_TARGETS, findFeatured } from "@/lib/targets";
import { API_URL } from "@/lib/manifest";
import { featuredNear, resolveQuery, type ResolvedPlace } from "@/lib/lab-resolve";
import { formatDecDms, formatRaHms, mjdNow, mjdToEpoch, separationDeg } from "@/lib/lab-coords";
import { formatAngle, positionAngleDeg, tanFromWcs, type TanGrid } from "@/lib/lab-wcs";
import { loadGaiaCone, downloadUrl, type GaiaCone, type GaiaSource } from "@/lib/lab-catalog";
import {
  BLINK_FOV_MAX_DEG,
  BLINK_FOV_MIN_DEG,
  DEFAULT_VIEW,
  labParsers,
  labUrlOptions,
  type LabDetector,
  type LabLayer,
  type LabMode,
} from "@/lib/lab-state";
import {
  FIXTURE_SLUG,
  contextFrameFor,
  detectorRange,
  framesFor,
  loadLiveField,
  loadTargetField,
  motionPath,
  positionAt,
  resolveDetector,
  availableDetectors,
  type FieldState,
} from "@/lib/lab-field";
import { FieldMessage } from "@/components/lab/field-message";
import { FixtureBanner } from "@/components/lab/fixture-banner";
import { useBlinkLayers } from "@/components/lab/use-blink-layers";
import { useMotionOverlay } from "@/components/lab/use-motion-overlay";
import { nearestSource, useSkyOverlays, type ToolShape } from "@/components/lab/use-sky-overlays";
import { createCursorStore, useCursor, type CursorStore } from "@/components/lab/cursor-store";
import { DEFAULT_DISPLAY, decodePng, histogram as histogramOf, type DisplaySettings } from "@/components/lab/display";
import { DataPane, siaExposureUrl, type LayerId, type LayerRow } from "@/components/lab/data-pane";
import { ViewerToolbar, type Tool } from "@/components/lab/viewer-toolbar";
import { StatusBar } from "@/components/lab/status-bar";
import { Timeline, SPEED_MAX, SPEED_MIN, type BlinkStyle, type CompareMode } from "@/components/lab/timeline";
import { getPreference, prefersReducedMotionNow, useEffectiveReducedMotion, usePreference } from "@/lib/preferences";
import { CompareOverlay } from "@/components/lab/compare-overlay";
import {
  AnalysisPane,
  exportPhotometryCsv,
  exportPositionsCsv,
  exportSpectrumCsv,
  type AnalysisTab,
  type Selection,
} from "@/components/lab/analysis-pane";
import { CommandPalette, ShortcutsDialog, type PaletteAction } from "@/components/lab/command-palette";
import { ResizeHandle, ToolButton, usePaneSize } from "@/components/lab/workbench-ui";
import { cn } from "@/lib/utils";
import { LabTourButton, LabTourHost } from "@/components/tour/tour-host";

/** Context cube frame before any field is loaded: D2 channel 4 (~1.2 um), as in the preview. */
const DEFAULT_CUBE_FRAME = 20;
/** Frames prepared for a featured target cover about 10 arcmin. */
const TARGET_FIELD_ARCMIN = 10;
/** Live fields default to 10 arcmin (API contract). */
const DEFAULT_FIELD_ARCMIN = 10;
/** A click this close (screen pixels) to a Gaia source selects it. */
const PICK_PX = 14;
const HINT_KEY = "pxh-lab-hint-seen";

type Patch = { ra: number; dec: number; fovArcmin: number; nonce: number };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const fieldArcmin = (fovDeg: number) => clamp(fovDeg * 60, 2, 30);

const WIDE_QUERY = "(min-width: 900px)";
function subscribeWide(onChange: () => void) {
  const media = window.matchMedia(WIDE_QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}
/** Three panes from 900 px; tabs below. The server renders the wide layout. */
function useIsWide() {
  return useSyncExternalStore(subscribeWide, () => window.matchMedia(WIDE_QUERY).matches, () => true);
}

/**
 * Reduced motion: the Motion setting (Settings page), else the system setting, read live (motion's
 * own hook keeps the value of its first render, which can miss the setting when the Lab hydrates).
 */
function usePrefersReducedMotion() {
  return useEffectiveReducedMotion();
}

/** Whether a new blink may start by itself: never with reduced motion (read at the moment it starts). */
function autoplayAllowed() {
  return !prefersReducedMotionNow();
}

const noopSubscribe = () => () => {};
/** false during server rendering and hydration, true afterwards. */
function useIsClient() {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}

/** A view (Aladin fov = viewer width) that shows a square field of `frameArcmin` with a margin. */
function framedView(center: { ra: number; dec: number }, frameArcmin: number, size: { w: number; h: number } | null): SkyView {
  const aspect = size && size.h > 0 ? Math.max(1, size.w / size.h) : 1.6;
  const fov = clamp(((frameArcmin / 60) * aspect) * 1.18, BLINK_FOV_MIN_DEG, BLINK_FOV_MAX_DEG);
  return { ra: center.ra, dec: center.dec, fov };
}

/** The field (arcmin) that fills the viewer at this zoom: what "Watch this patch" asks for. */
function visibleFieldArcmin(fovDeg: number, size: { w: number; h: number } | null): number {
  if (fovDeg > BLINK_FOV_MAX_DEG + 1e-6) return DEFAULT_FIELD_ARCMIN;
  const aspect = size && size.h > 0 ? Math.max(1, size.w / size.h) : 1.6;
  return clamp(Math.round(((fovDeg * 60) / aspect / 1.1) * 2) / 2, 2, 30);
}

function featuredInField(ra: number, dec: number, arcmin: number) {
  const best = featuredNear(ra, dec, arcmin / 120)
    .map((t) => ({ t, sep: separationDeg(t, { ra, dec }) * 60 }))
    .sort((a, b) => a.sep - b.sep)[0];
  return best ?? null;
}

interface PickNote {
  slug: string;
  text: string;
}

function pickNote(name: string, slug: string, sepArcmin: number): PickNote {
  const where = sepArcmin < 0.1 ? "at the position you asked for" : `${sepArcmin.toFixed(1)}′ from the position you asked for`;
  return {
    slug,
    text: `Showing the prepared frames of ${name}, ${where}. Frames for any other patch need the live backend, which is not connected yet.`,
  };
}

/** Decoded pixels of an image URL (the flags overlay of the frame on screen), for readouts. */
const decodedCache = new Map<string, Promise<ImageData | null>>();

function useDecoded(url: string | null): ImageData | null {
  const [entries, setEntries] = useState<Record<string, ImageData | null>>({});
  useEffect(() => {
    if (!url || url in entries) return;
    let alive = true;
    let job = decodedCache.get(url);
    if (!job) {
      job = fetch(url)
        .then((r) => (r.ok ? r.blob() : null))
        .then((b) => (b ? decodePng(b) : null))
        .catch(() => null);
      decodedCache.set(url, job);
    }
    void job.then((image) => {
      if (alive) setEntries((e) => ({ ...e, [url]: image }));
    });
    return () => {
      alive = false;
    };
  }, [url, entries]);
  return url ? (entries[url] ?? null) : null;
}

function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize((s) => (s && Math.abs(s.w - width) < 1 && Math.abs(s.h - height) < 1 ? s : { w: Math.round(width), h: Math.round(height) }));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, size] as const;
}

type Measure =
  | { tool: "ruler"; a: { ra: number; dec: number }; b: { ra: number; dec: number } | null; fixed: boolean }
  | { tool: "aperture"; center: { ra: number; dec: number }; edge: { ra: number; dec: number } | null; fixed: boolean }
  | null;

export function LabWorkspace() {
  const [q, setQ] = useQueryStates(labParsers, labUrlOptions);
  const reduceMotion = usePrefersReducedMotion();
  const wide = useIsWide();
  const isClient = useIsClient();
  const featured = findFeatured(q.target);
  const [viewerRef, viewerSize] = useElementSize<HTMLDivElement>();
  const cursor = useMemo<CursorStore>(() => createCursorStore(), []);

  // The workbench fills the window: the document itself never scrolls here, so the panes cannot
  // slide away under the navigation bar while the wheel zooms the sky.
  useEffect(() => {
    const html = document.documentElement;
    const prev = { overflow: html.style.overflow, overscroll: html.style.overscrollBehavior };
    window.scrollTo(0, 0);
    html.style.overflow = "hidden";
    html.style.overscrollBehavior = "none";
    return () => {
      html.style.overflow = prev.overflow;
      html.style.overscrollBehavior = prev.overscroll;
    };
  }, []);

  // ------------------------------------------------------------------ view
  const view: SkyView = useMemo(() => {
    const fallback = featured ? framedView(featured, TARGET_FIELD_ARCMIN, isClient ? viewerSize : null) : DEFAULT_VIEW;
    return { ra: q.ra ?? fallback.ra, dec: q.dec ?? fallback.dec, fov: q.fov ?? fallback.fov };
  }, [q.ra, q.dec, q.fov, featured, isClient, viewerSize]);
  const blinkVisible = view.fov <= BLINK_FOV_MAX_DEG + 1e-6;

  const [session, setSession] = useState<AladinSession | null>(null);
  const [skyStatus, setSkyStatus] = useState<AladinStatus>({ state: "loading" });
  const [retryToken, setRetryToken] = useState(0);
  const [viewerKey, setViewerKey] = useState(0);

  const handleViewChange = useCallback(
    (next: SkyView) => {
      void setQ({ ra: next.ra, dec: next.dec, fov: next.fov });
    },
    [setQ],
  );

  // ------------------------------------------------------------------ field (manifest) loading
  const [initialPick] = useState(() => {
    if (q.target || API_URL || q.ra === null || q.dec === null) return null;
    const fov = q.fov ?? DEFAULT_VIEW.fov;
    if (fov > BLINK_FOV_MAX_DEG + 1e-6) return null;
    const near = featuredInField(q.ra, q.dec, fieldArcmin(fov));
    return near ? pickNote(near.t.name, near.t.slug, near.sep) : null;
  });
  const [note, setNote] = useState<PickNote | null>(initialPick);
  const [patch, setPatch] = useState<Patch | null>(() =>
    !initialPick && !q.target && q.ra !== null && q.dec !== null && (q.fov ?? DEFAULT_VIEW.fov) <= BLINK_FOV_MAX_DEG + 1e-6
      ? { ra: q.ra, dec: q.dec, fovArcmin: fieldArcmin(q.fov ?? DEFAULT_VIEW.fov), nonce: 0 }
      : null,
  );
  useEffect(() => {
    if (initialPick) {
      const t = findFeatured(initialPick.slug);
      const v = t ? framedView(t, TARGET_FIELD_ARCMIN, null) : null;
      void setQ({ target: initialPick.slug, ra: v?.ra ?? null, dec: v?.dec ?? null, fov: v?.fov ?? null, frame: null });
      return;
    }
    const t = findFeatured(q.target);
    if (t && q.fov !== null && q.fov > BLINK_FOV_MAX_DEG + 1e-6) {
      const v = framedView(t, TARGET_FIELD_ARCMIN, null);
      void setQ({ ra: v.ra, dec: v.dec, fov: v.fov });
    }
    // Once, on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [fieldRetry, setFieldRetry] = useState(0);
  const requestKey = q.target ? `target:${q.target}` : patch ? `patch:${JSON.stringify(patch)}` : "";
  const loadKey = requestKey ? `${fieldRetry}#${requestKey}` : "";
  const [fieldEntry, setFieldEntry] = useState<{ key: string; state: FieldState }>({ key: "", state: { status: "idle" } });
  const field: FieldState = !loadKey
    ? { status: "idle" }
    : fieldEntry.key === loadKey
      ? fieldEntry.state
      : { status: "loading", what: requestKey.startsWith("target:") ? "bundle" : "live" };

  useEffect(() => {
    if (!loadKey) return;
    const request = loadKey.slice(loadKey.indexOf("#") + 1);
    const controller = new AbortController();
    const signal = controller.signal;
    const update = (state: FieldState) => {
      if (!signal.aborted) setFieldEntry({ key: loadKey, state });
    };
    let job: Promise<FieldState>;
    if (request.startsWith("target:")) {
      job = loadTargetField(request.slice(7), signal);
    } else {
      const p = JSON.parse(request.slice(6)) as Patch;
      job = loadLiveField({ ra: p.ra, dec: p.dec }, p.fovArcmin, update, signal);
    }
    job.then(update).catch((err: unknown) => {
      update({
        status: "error",
        message: err instanceof Error ? err.message : "Something went wrong while loading the frames.",
        retryable: true,
      });
    });
    return () => controller.abort();
  }, [loadKey]);

  const manifest = field.status === "ready" ? field.manifest : null;
  const manifestUrl = field.status === "ready" ? field.manifestUrl : null;
  const fixture = manifest?.source === "fixture";
  const grid: TanGrid | null = useMemo(
    () => (manifest ? tanFromWcs(manifest.grid.wcs, manifest.grid.width, manifest.grid.height) : null),
    [manifest],
  );

  useEffect(() => {
    if (!manifest || q.ra !== null) return;
    const v = framedView(manifest.center, manifest.fov_arcmin, viewerSize);
    void setQ({ ra: v.ra, dec: v.dec, fov: q.fov ?? v.fov });
  }, [manifest, q.ra, q.fov, setQ, viewerSize]);

  // ------------------------------------------------------------------ mode, detector, frames
  const modeAvailable = (m: LabMode) =>
    !manifest
      ? true
      : m === "then-now"
        ? manifest.frames.then_vs_now.length > 1
        : m === "difference"
          ? manifest.frames.difference.length > 0
          : true;
  const mode: LabMode = modeAvailable(q.mode) ? q.mode : "epochs";
  // A detector in the link wins; otherwise the Settings choice, when this field has it.
  const preferredDet = usePreference("labDetector");
  const det: LabDetector | null = manifest ? resolveDetector(manifest, mode, q.det ?? preferredDet) : null;
  const frames = useMemo(
    () => (manifest && manifestUrl ? framesFor(manifest, manifestUrl, mode, det) : []),
    [manifest, manifestUrl, mode, det],
  );
  const showPath = q.layers.includes("path");
  const showFlags = q.layers.includes("flags");
  const showWise = q.layers.includes("wise");
  const showGaia = q.layers.includes("gaia");

  // ------------------------------------------------------------------ playback
  const [frameIndex, setFrameIndex] = useState(q.frame ?? 0);
  const [playing, setPlaying] = useState(q.frame === null);
  // Blink speed: the Settings choice until it is changed here.
  const preferredSpeed = usePreference("labBlinkMs");
  const [speedChoice, setSpeed] = useState<number | null>(null);
  const speed = speedChoice ?? preferredSpeed;
  const [loopCount, setLoopCount] = useState(0);
  const [blinkStyle, setBlinkStyle] = useState<BlinkStyle>("hard");
  const [compare, setCompare] = useState<CompareMode>("off");
  const [compareA, setCompareA] = useState(0);
  const current = frames.length ? clamp(frameIndex, 0, frames.length - 1) : 0;
  const [display, setDisplay] = useState<DisplaySettings>(DEFAULT_DISPLAY);
  const [epochsVisible, setEpochsVisible] = useState(true);
  const [epochsOpacity, setEpochsOpacity] = useState(1);
  const [cubeVisible, setCubeVisible] = useState(true);
  const [cubeOpacity, setCubeOpacity] = useState(1);
  const [wiseOpacity, setWiseOpacity] = useState(0.5);
  const compareOn = compare !== "off" && mode !== "difference" && frames.length > 1;

  const layerStatus = useBlinkLayers({
    session,
    manifestKey: manifest ? `${manifestUrl}|${manifest.generated_at}|${manifest.center.ra}|${manifest.center.dec}` : null,
    wcs: manifest?.grid.wcs ?? null,
    frames,
    current,
    visible: blinkVisible && epochsVisible,
    showFlags,
    display,
    crossfadeMs: blinkStyle === "fade" && !reduceMotion ? Math.min(420, speed * 0.6) : 0,
    opacity: epochsOpacity,
    hidden: compareOn,
  });
  const canPlay = layerStatus.ready && frames.length > 1 && blinkVisible && !compareOn;
  const isPlaying = playing && canPlay;

  useEffect(() => {
    if (!isPlaying) return;
    const timer = window.setTimeout(() => {
      const next = (current + 1) % frames.length;
      setFrameIndex(next);
      if (next === 0) setLoopCount((c) => c + 1);
    }, speed);
    return () => window.clearTimeout(timer);
  }, [isPlaying, current, frames.length, speed]);

  const autoPausedRef = useRef(false);
  useEffect(() => {
    if (reduceMotion && !autoPausedRef.current) {
      autoPausedRef.current = true;
      setPlaying(false);
    }
  }, [reduceMotion]);

  useEffect(() => {
    if (!frames.length) return;
    void setQ({ frame: playing ? null : current });
  }, [playing, current, frames.length, setQ]);

  const step = useCallback(
    (delta: 1 | -1) => {
      if (!frames.length) return;
      setPlaying(false);
      setFrameIndex((current + delta + frames.length) % frames.length);
    },
    [current, frames.length],
  );
  const seek = useCallback((index: number) => {
    setPlaying(false);
    setFrameIndex(index);
  }, []);
  const togglePlay = useCallback(() => {
    if (canPlay) setPlaying((p) => !p);
  }, [canPlay]);
  const seekEpoch = (epochIndex: number) => {
    const i = frames.findIndex((f) => f.epoch?.index === epochIndex);
    if (i >= 0) seek(i);
  };

  // ------------------------------------------------------------------ overlays on the sky
  const path = useMemo(() => (manifest ? motionPath(manifest, frames, mode) : []), [manifest, frames, mode]);
  const markers = useMemo(() => {
    if (!manifest) return [];
    if (mode === "epochs" && manifest.motion) return manifest.motion.epoch_positions.map((p) => ({ ra: p.ra, dec: p.dec }));
    if (mode === "then-now") return frames.map((f) => positionAt(manifest, f)).filter((p): p is { ra: number; dec: number } => p !== null);
    return [];
  }, [manifest, frames, mode]);
  const currentPos = manifest && frames[current] ? positionAt(manifest, frames[current]) : null;

  // ------------------------------------------------------------------ selection and panes
  const [selection, setSelection] = useState<Selection>(() => (q.target || initialPick ? { kind: "target" } : null));
  const [tab, setTab] = useState<AnalysisTab>("object");
  const [phoneTab, setPhoneTab] = useState<"data" | "viewer" | "analysis">("viewer");
  const [leftW, setLeftW] = usePaneSize("pxh-lab-left", 280, 236, 420);
  const [rightW, setRightW] = usePaneSize("pxh-lab-right", 404, 320, 560);
  const [tool, setTool] = useState<Tool>("inspect");
  const [measure, setMeasure] = useState<Measure>(null);
  const [grid2, setGrid2] = useState(false);
  const [crosshair, setCrosshair] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [hint, setHint] = useState(false);

  useEffect(() => {
    // A moment after arrival, once: the first-visit hint.
    const t = window.setTimeout(() => {
      try {
        if (!window.localStorage.getItem(HINT_KEY)) setHint(true);
      } catch {
        setHint(true);
      }
    }, 900);
    return () => window.clearTimeout(t);
  }, []);
  const dismissHint = useCallback(() => {
    setHint(false);
    try {
      window.localStorage.setItem(HINT_KEY, "1");
    } catch {
      // not remembered
    }
  }, []);
  useEffect(() => {
    if (!hint) return;
    const t = window.setTimeout(dismissHint, 12000);
    return () => window.clearTimeout(t);
  }, [hint, dismissHint]);

  const clearSelection = useCallback(() => {
    setSelection(null);
    if (!wide) setPhoneTab("viewer");
  }, [wide]);

  // Aladin's logo would show through the panes; Aladin Lite is credited in the provenance tab.
  useEffect(() => {
    const logo = session?.host.querySelector<HTMLElement>(".aladin-logo-container");
    if (logo) logo.style.display = "none";
  }, [session]);

  // Grid and crosshair.
  useEffect(() => {
    if (!session) return;
    const { aladin } = extra(session);
    try {
      aladin.setCooGrid?.({ enabled: grid2, color: "#a6a5a0", opacity: 0.45, labelSize: 11 });
    } catch {
      // older builds
    }
  }, [session, grid2]);
  useEffect(() => {
    if (!session) return;
    try {
      extra(session).aladin.showReticle?.(crosshair);
    } catch {
      // older builds
    }
  }, [session, crosshair]);

  useMotionOverlay({
    session,
    path,
    markers,
    current: blinkVisible ? currentPos : null,
    fovDeg: view.fov,
    show: showPath && blinkVisible,
    probe: selection?.kind === "position" ? { ra: selection.ra, dec: selection.dec } : null,
  });

  // ------------------------------------------------------------------ Gaia DR3 in view
  const gaiaEpoch = manifest ? mjdToEpoch(manifest.center.epoch_mjd) : mjdToEpoch(Math.round(mjdNow()));
  const gaiaWanted = showGaia && view.fov <= BLINK_FOV_MAX_DEG + 1e-6;
  const [cone, setCone] = useState<{ state: "idle" | "loading" | "ready" | "error"; cone: GaiaCone | null; message?: string }>({
    state: "idle",
    cone: null,
  });
  const coneRef = useRef(cone);
  useEffect(() => {
    coneRef.current = cone;
  });
  const inflightRef = useRef<{ center: { ra: number; dec: number }; radiusArcmin: number; epoch: number; controller: AbortController } | null>(null);
  useEffect(() => () => inflightRef.current?.controller.abort(), []);
  useEffect(() => {
    if (!gaiaWanted) return;
    const radius = clamp(view.fov * 60 * 0.75, 1, 15);
    const covers = (c: { center: { ra: number; dec: number }; radiusArcmin: number; epoch: number } | null | undefined) =>
      Boolean(c && Math.abs(c.epoch - gaiaEpoch) < 0.01 && separationDeg(c.center, view) * 60 + radius <= c.radiusArcmin * 1.06);
    // Already drawn, or on its way: nothing to fetch.
    if (covers(coneRef.current.cone) || covers(inflightRef.current)) return;
    const t = window.setTimeout(() => {
      inflightRef.current?.controller.abort();
      const controller = new AbortController();
      const r = Math.min(15, radius * 1.25);
      const center = { ra: view.ra, dec: view.dec };
      inflightRef.current = { center, radiusArcmin: r, epoch: gaiaEpoch, controller };
      setCone((c) => ({ ...c, state: "loading" }));
      loadGaiaCone(center, r, gaiaEpoch, controller.signal)
        .then((result) => {
          if (inflightRef.current?.controller === controller) inflightRef.current = null;
          setCone({ state: "ready", cone: result });
        })
        .catch((err: unknown) => {
          if (controller.signal.aborted) return;
          if (inflightRef.current?.controller === controller) inflightRef.current = null;
          setCone((c) => ({ ...c, state: "error", message: err instanceof Error ? err.message : "unknown error" }));
        });
    }, 450);
    return () => window.clearTimeout(t);
  }, [gaiaWanted, view, gaiaEpoch]);
  const sources = useMemo(() => (gaiaWanted && cone.cone ? cone.cone.sources : []), [gaiaWanted, cone.cone]);

  // ------------------------------------------------------------------ tools on the sky
  const toolShape: ToolShape = useMemo(() => {
    if (measure?.tool === "ruler" && measure.b) return { ruler: { a: measure.a, b: measure.b }, aperture: null };
    if (measure?.tool === "aperture" && measure.edge) {
      return { ruler: null, aperture: { center: measure.center, radiusDeg: separationDeg(measure.center, measure.edge) } };
    }
    return { ruler: null, aperture: null };
  }, [measure]);
  const selectedStar = selection?.kind === "star" ? selection.source : null;
  useSkyOverlays({ session, sources, showSources: gaiaWanted, selected: selectedStar, fovDeg: view.fov, tools: toolShape });

  // Live tool lines follow the pointer until the second click fixes them.
  useEffect(() => {
    if (!measure || measure.fixed) return;
    return cursor.subscribe(() => {
      const c = cursor.get();
      if (!c) return;
      setMeasure((m) =>
        !m || m.fixed ? m : m.tool === "ruler" ? { ...m, b: { ra: c.ra, dec: c.dec } } : { ...m, edge: { ra: c.ra, dec: c.dec } },
      );
    });
  }, [measure, cursor]);

  const pickRadiusDeg = viewerSize ? (PICK_PX * view.fov) / Math.max(1, viewerSize.w) : view.fov * 0.02;

  const onSkyClick = (pos: { ra: number; dec: number }) => {
    if (hint) dismissHint();
    if (tool === "ruler" || tool === "aperture") {
      setMeasure((m) => {
        if (tool === "ruler") {
          if (m?.tool === "ruler" && !m.fixed) return { ...m, b: pos, fixed: true };
          return { tool: "ruler", a: pos, b: null, fixed: false };
        }
        if (m?.tool === "aperture" && !m.fixed) return { ...m, edge: pos, fixed: true };
        return { tool: "aperture", center: pos, edge: null, fixed: false };
      });
      return;
    }
    const near = gaiaWanted ? nearestSource(sources, pos.ra, pos.dec, pickRadiusDeg) : null;
    if (near && cone.cone) {
      setSelection({ kind: "star", source: near, epoch: cone.cone.epoch, via: cone.cone.via });
    } else {
      setSelection({ kind: "position", ra: pos.ra, dec: pos.dec });
    }
    setTab("object");
  };

  // ------------------------------------------------------------------ actions
  const selectTarget = useCallback(
    (slug: string, pick: PickNote | null = null) => {
      const t = findFeatured(slug);
      const v = t ? framedView(t, TARGET_FIELD_ARCMIN, viewerSize) : null;
      setPatch(null);
      setNote(pick);
      setFrameIndex(0);
      setPlaying(autoplayAllowed());
      setCompare("off");
      void setQ({ target: slug, ra: v?.ra ?? null, dec: v?.dec ?? null, fov: v?.fov ?? null, frame: null });
      setSelection({ kind: "target" });
      setTab("object");
    },
    [setQ, viewerSize],
  );

  const watchFieldArcmin = isClient ? visibleFieldArcmin(view.fov, viewerSize) : DEFAULT_FIELD_ARCMIN;
  const watchPatch = useCallback(
    (ra: number, dec: number, arcmin?: number) => {
      const f = arcmin ?? visibleFieldArcmin(view.fov, viewerSize);
      if (!API_URL) {
        const near = featuredInField(ra, dec, f);
        if (near) {
          selectTarget(near.t.slug, pickNote(near.t.name, near.t.slug, near.sep));
          return "target" as const;
        }
      }
      const v = framedView({ ra, dec }, f, viewerSize);
      setNote(null);
      setFrameIndex(0);
      setPlaying(autoplayAllowed());
      setCompare("off");
      void setQ({ target: null, ra: v.ra, dec: v.dec, fov: v.fov, frame: null });
      setPatch((p) => ({ ra, dec, fovArcmin: f, nonce: (p?.nonce ?? 0) + 1 }));
      return "patch" as const;
    },
    [view.fov, setQ, selectTarget, viewerSize],
  );

  const watchStar = (s: GaiaSource) => {
    if (manifest && separationDeg(manifest.center, s) * 60 <= manifest.fov_arcmin / 2) {
      // Already in the loaded field: centre it and play.
      void setQ({ ra: s.ra, dec: s.dec, fov: Math.min(view.fov, framedView(s, Math.min(6, manifest.fov_arcmin), viewerSize).fov) });
      setPlaying(autoplayAllowed());
      if (!wide) setPhoneTab("viewer");
      return;
    }
    watchPatch(s.ra, s.dec, 6);
    if (!wide) setPhoneTab("viewer");
  };

  const onPlace = (place: ResolvedPlace) => {
    if (place.slug) {
      selectTarget(place.slug);
      return;
    }
    if (watchPatch(place.ra, place.dec) === "patch") {
      setSelection({ kind: "position", ra: place.ra, dec: place.dec });
      setTab("object");
    }
  };

  const showSky = () => {
    setPatch(null);
    setNote(null);
    void setQ({ target: null, frame: null, fov: Math.max(view.fov, DEFAULT_VIEW.fov) });
    if (selection?.kind === "target") setSelection(null);
  };

  const zoomToField = useCallback(() => {
    if (!manifest) return;
    const v = framedView(manifest.center, manifest.fov_arcmin, viewerSize);
    void setQ({ ra: v.ra, dec: v.dec, fov: v.fov });
  }, [manifest, setQ, viewerSize]);

  const setLayer = useCallback(
    (layer: LabLayer, on: boolean) => {
      const next = on ? [...new Set([...q.layers, layer])] : q.layers.filter((l) => l !== layer);
      void setQ({ layers: next });
    },
    [q.layers, setQ],
  );

  const setMode = useCallback(
    (m: LabMode) => {
      setCompare((c) => (m === "difference" ? "off" : c));
      void setQ({ mode: m });
    },
    [setQ],
  );

  const chooseTool = useCallback((t: Tool) => {
    setTool(t);
    setMeasure(null);
  }, []);

  // ------------------------------------------------------------------ context layer
  const [cubeFrame, setCubeFrame] = useState(DEFAULT_CUBE_FRAME);
  const [channels, setChannels] = useState<SpectralChannel[] | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    loadSpectralChannels(controller.signal)
      .then(setChannels)
      .catch(() => {
        if (!controller.signal.aborted) setChannels([]);
      });
    return () => controller.abort();
  }, []);
  const contextFrame = manifest ? contextFrameFor(det, mode) : cubeFrame;

  const retrySky = () => {
    if (skyStatus.state === "error" && skyStatus.kind === "viewer") setViewerKey((k) => k + 1);
    else setRetryToken((t) => t + 1);
  };

  // ------------------------------------------------------------------ exports
  const currentFrame = frames[current] ?? null;
  const fieldTitle = featured?.name ?? (q.target === FIXTURE_SLUG ? "the development fixture" : manifest ? "this field" : "the all-sky map");
  const slug = featured?.slug ?? (manifest ? `field-${manifest.center.ra.toFixed(3)}_${manifest.center.dec.toFixed(3)}` : "sky");
  const exportFrame = useCallback(() => {
    if (!currentFrame) return;
    const url = layerStatus.displayUrl(currentFrame.key);
    if (!url) return;
    downloadUrl(`${slug}-${det ?? mode}-${currentFrame.label.replace(/[^a-z0-9]+/gi, "-")}.png`, url);
  }, [currentFrame, layerStatus, slug, det, mode]);
  const copyLink = useCallback(() => {
    void navigator.clipboard
      ?.writeText(window.location.href)
      .then(() => toast("Link copied", { description: "It opens this view, frame and layers." }))
      .catch(() => toast("Copy failed", { description: window.location.href }));
  }, []);
  const irsaLink = manifest && currentFrame?.epoch ? siaExposureUrl(manifest, currentFrame.epoch) : null;

  // ------------------------------------------------------------------ keyboard
  const keyState = useRef({
    selection,
    clearSelection,
    togglePlay,
    step,
    blink: frames.length > 0 && blinkVisible,
    measure,
    compareOn,
    manifest,
    mode,
    speed,
    zoomToField,
    setMode,
    chooseTool,
    phoneTab,
    wide,
  });
  useEffect(() => {
    keyState.current = {
      selection,
      clearSelection,
      togglePlay,
      step,
      blink: frames.length > 0 && blinkVisible,
      measure,
      compareOn,
      manifest,
      mode,
      speed,
      zoomToField,
      setMode,
      chooseTool,
      phoneTab,
      wide,
    };
  });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const s = keyState.current;
      const target = event.target as HTMLElement | null;
      // Escape first: the sky viewer swallows keys (defaultPrevented), but Esc must still work there.
      if (event.key === "Escape" && !target?.closest("[role=dialog], [data-radix-popper-content-wrapper]")) {
        if (s.measure) {
          event.preventDefault();
          setMeasure(null);
        } else if (s.compareOn) {
          event.preventDefault();
          setCompare("off");
        } else if (s.selection || (!s.wide && s.phoneTab !== "viewer")) {
          event.preventDefault();
          s.clearSelection();
        }
        return;
      }
      if (event.defaultPrevented) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((o) => !o);
        return;
      }
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      if (target?.closest("[role=dialog], [data-radix-popper-content-wrapper]")) return;
      const typing = target?.closest("input, textarea, select, [contenteditable=true]");
      if (typing) return;
      const inWidget = target?.closest("[role=slider], [role=tab], [role=radio], [role=tablist], [role=radiogroup], [role=separator]");
      const key = event.key;
      if (key === "?") {
        event.preventDefault();
        setShortcutsOpen(true);
        return;
      }
      if (!inWidget) {
        const lower = key.toLowerCase();
        const handled = (() => {
          if (lower === "v") s.chooseTool("inspect");
          else if (lower === "r") s.chooseTool("ruler");
          else if (lower === "a") s.chooseTool("aperture");
          else if (lower === "g") setGrid2((g) => !g);
          else if (lower === "x") setCrosshair((c) => !c);
          else if (lower === "f") s.zoomToField();
          else if (lower === "c") setBlinkStyle((b) => (b === "hard" ? "fade" : "hard"));
          else if (lower === "w") setCompare((c) => (c === "wipe" ? "off" : "wipe"));
          else if (lower === "e") s.setMode("epochs");
          else if (lower === "t" && s.manifest && s.manifest.frames.then_vs_now.length > 1) s.setMode("then-now");
          else if (lower === "d" && s.manifest && s.manifest.frames.difference.length > 0) s.setMode("difference");
          else if (key === "[") setSpeed((v) => Math.min(SPEED_MAX, (v ?? getPreference("labBlinkMs")) + 50));
          else if (key === "]") setSpeed((v) => Math.max(SPEED_MIN, (v ?? getPreference("labBlinkMs")) - 50));
          else if (/^[1-6]$/.test(key) && s.manifest) {
            const d = `D${key}` as LabDetector;
            if (availableDetectors(s.manifest).includes(d)) void setQ({ det: d });
          } else return false;
          return true;
        })();
        if (handled) {
          event.preventDefault();
          return;
        }
      }
      if (!s.blink || inWidget) return;
      if (key === " " || event.code === "Space") {
        if (target?.closest("button, a, [role=application]") && !target.closest("[data-testid=sky-viewer]")) return;
        event.preventDefault();
        s.togglePlay();
      } else if (key === "ArrowLeft" || key === "ArrowRight") {
        if (target?.closest("[role=application]")) return;
        event.preventDefault();
        s.step(key === "ArrowLeft" ? -1 : 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setQ]);

  // ------------------------------------------------------------------ palette
  const paletteActions: PaletteAction[] = [
    ...FEATURED_TARGETS.map((t) => ({ id: `go-${t.slug}`, group: "Go to" as const, label: t.name, hint: t.tagline, run: () => selectTarget(t.slug) })),
    { id: "mode-epochs", group: "Blink", label: "Epochs", shortcut: "E", run: () => setMode("epochs") },
    { id: "mode-tn", group: "Blink", label: "Then vs Now", shortcut: "T", disabled: !manifest || manifest.frames.then_vs_now.length < 2, run: () => setMode("then-now") },
    { id: "mode-diff", group: "Blink", label: "Difference", shortcut: "D", disabled: !manifest || manifest.frames.difference.length === 0, run: () => setMode("difference") },
    { id: "play", group: "Blink", label: isPlaying ? "Pause" : "Play", shortcut: "Space", disabled: !canPlay, run: togglePlay },
    { id: "fade", group: "Blink", label: blinkStyle === "hard" ? "Crossfade between frames" : "Hard blink", shortcut: "C", run: () => setBlinkStyle((b) => (b === "hard" ? "fade" : "hard")) },
    { id: "wipe", group: "Blink", label: compare === "wipe" ? "Stop comparing" : "Wipe compare", shortcut: "W", disabled: frames.length < 2, run: () => setCompare((c) => (c === "wipe" ? "off" : "wipe")) },
    { id: "split", group: "Blink", label: "Split compare", disabled: frames.length < 2, run: () => setCompare("split") },
    ...(["D1", "D2", "D3", "D4", "D5", "D6", "rgb"] as LabDetector[]).map((d, i) => ({
      id: `det-${d}`,
      group: "Detector" as const,
      label: d === "rgb" ? "Colour composite" : `${d}  ${manifest ? detectorRange(manifest, d as "D1").map((v) => v.toFixed(2)).join("–") + " µm" : ""}`,
      shortcut: d === "rgb" ? undefined : String(i + 1),
      disabled: !manifest || !availableDetectors(manifest).includes(d),
      run: () => void setQ({ det: d }),
    })),
    { id: "layer-gaia", group: "Layers", label: `${showGaia ? "Hide" : "Show"} Gaia DR3 stars`, run: () => setLayer("gaia", !showGaia) },
    { id: "layer-flags", group: "Layers", label: `${showFlags ? "Hide" : "Show"} flags`, run: () => setLayer("flags", !showFlags) },
    { id: "layer-path", group: "Layers", label: `${showPath ? "Hide" : "Show"} motion path`, run: () => setLayer("path", !showPath) },
    { id: "layer-wise", group: "Layers", label: `${showWise ? "Hide" : "Show"} WISE 2010`, run: () => setLayer("wise", !showWise) },
    { id: "tool-inspect", group: "Tools", label: "Inspect", shortcut: "V", run: () => chooseTool("inspect") },
    { id: "tool-ruler", group: "Tools", label: "Ruler", shortcut: "R", run: () => chooseTool("ruler") },
    { id: "tool-aperture", group: "Tools", label: "Aperture", shortcut: "A", run: () => chooseTool("aperture") },
    { id: "view-grid", group: "View", label: `${grid2 ? "Hide" : "Show"} the RA/Dec grid`, shortcut: "G", run: () => setGrid2((g) => !g) },
    { id: "view-cross", group: "View", label: `${crosshair ? "Hide" : "Show"} the crosshair`, shortcut: "X", run: () => setCrosshair((c) => !c) },
    { id: "view-field", group: "View", label: "Zoom to the field", shortcut: "F", disabled: !manifest, run: zoomToField },
    { id: "view-sky", group: "View", label: "Back to the all-sky map", run: showSky },
    { id: "shortcuts", group: "View", label: "Keyboard shortcuts", shortcut: "?", run: () => setShortcutsOpen(true) },
    { id: "export-png", group: "Export", label: "PNG of the frame on screen", disabled: !currentFrame, run: exportFrame },
    { id: "export-spec", group: "Export", label: "Spectrum (CSV)", disabled: !manifest?.spectrum?.points.length, run: () => manifest && exportSpectrumCsv(manifest) },
    { id: "export-phot", group: "Export", label: "Photometry (CSV)", disabled: !manifest?.lightcurve?.epoch_photometry.length, run: () => manifest && exportPhotometryCsv(manifest) },
    { id: "export-pos", group: "Export", label: "Positions (CSV)", disabled: !manifest?.motion?.epoch_positions.length, run: () => manifest && exportPositionsCsv(manifest) },
    { id: "export-link", group: "Export", label: "Copy a link to this view", run: copyLink },
    { id: "export-irsa", group: "Export", label: "IRSA exposure list for this epoch", disabled: !irsaLink, run: () => irsaLink && window.open(irsaLink, "_blank", "noopener") },
  ];

  const paletteSearch = (text: string) => {
    void resolveQuery(text)
      .then(onPlace)
      .catch((err: unknown) => toast("Not found", { description: err instanceof Error ? err.message : text }));
  };

  // ------------------------------------------------------------------ derived readouts
  const histogram = useMemo(() => {
    const raw = currentFrame ? layerStatus.raw(currentFrame.key) : null;
    return raw ? histogramOf(raw) : null;
    // rawVersion tells when pixels arrive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentFrame, layerStatus.rawVersion]);
  const frameRaw = currentFrame && mode !== "difference" ? layerStatus.raw(currentFrame.key) : null;
  const flagsImage = useDecoded(currentFrame?.flags?.url ?? null);
  const wavelength =
    currentFrame && mode === "epochs" && det && det !== "rgb" && manifest
      ? (() => {
          const r = manifest.frames.epoch[det]?.find((f) => f.epoch === currentFrame.epoch?.index)?.wl_um ?? detectorRange(manifest, det);
          return `${r[0].toFixed(2)}–${r[1].toFixed(2)} µm (${det})`;
        })()
      : mode === "then-now" && currentFrame
        ? currentFrame.detail.replace(/(\d)\s?um\b/g, "$1 µm")
        : det === "rgb"
          ? "D1/D3/D6 composite"
          : null;
  const frameLabel = currentFrame ? [currentFrame.label, currentFrame.detail.length <= 4 ? currentFrame.detail : null].filter(Boolean).join(" · ") : null;

  const measurement = measureReadout(measure, frames, layerStatus, grid, sources);
  const focusDetector = det && det !== "rgb" ? Number(det.slice(1)) : 6;

  const layerRows: LayerRow[] = [
    { id: "epochs", visible: epochsVisible, opacity: epochsOpacity, disabled: !manifest, note: manifest ? `${frames.length} frames, ${det === "rgb" ? "colour" : (det ?? "")}` : undefined },
    { id: "difference", visible: mode === "difference", disabled: !manifest || manifest.frames.difference.length === 0 },
    { id: "wise", visible: showWise, opacity: wiseOpacity },
    {
      id: "gaia",
      visible: showGaia,
      note: !showGaia
        ? undefined
        : !gaiaWanted
          ? "Zoom in below 30′ to see catalogue stars"
          : cone.state === "loading"
            ? "Loading stars in view…"
            : cone.state === "error"
              ? "The catalogue did not answer"
              : cone.cone
                ? `${cone.cone.sources.length.toLocaleString("en-US")}${cone.cone.truncated ? " brightest" : ""} stars · ${cone.cone.via}`
                : undefined,
    },
    { id: "flags", visible: showFlags, disabled: !frames.some((f) => f.flags) },
    { id: "path", visible: showPath, disabled: path.length < 2 && markers.length === 0 },
    { id: "cube", visible: cubeVisible, opacity: cubeOpacity },
  ];
  const onLayerVisible = (id: LayerId, on: boolean) => {
    if (id === "epochs") setEpochsVisible(on);
    else if (id === "difference") setMode(on ? "difference" : "epochs");
    else if (id === "cube") setCubeVisible(on);
    else setLayer(id as LabLayer, on);
  };
  const onLayerOpacity = (id: LayerId, v: number) => {
    if (id === "epochs") setEpochsOpacity(v);
    else if (id === "wise") setWiseOpacity(v);
    else if (id === "cube") setCubeOpacity(v);
  };
  const contextOpacity = !cubeVisible ? 0 : frames.length > 0 && blinkVisible && layerStatus.ready && epochsVisible ? 0.5 * cubeOpacity : cubeOpacity;

  const notes = manifest
    ? `${manifest.release.collections.map((c) => c.replace("spherex_", "").toUpperCase()).join(" + ")} · ${manifest.epochs.length} epochs · ${manifest.epochs.reduce((n, e) => n + e.n_exposures, 0)} exposures · ${manifest.source === "live" ? "built live" : manifest.source === "bundle" ? "prepared bundle" : "fixture"}`
    : field.status === "loading"
      ? "Loading…"
      : "SPHEREx DR1 all-sky map";

  // ------------------------------------------------------------------ layout pieces
  const dataPane = (
    <DataPane
      activeSlug={q.target}
      onPlace={onPlace}
      onPickTarget={(s) => {
        selectTarget(s);
        if (!wide) setPhoneTab("viewer");
      }}
      manifest={manifest}
      frames={frames}
      current={current}
      det={det}
      mode={mode}
      onSeekEpoch={seekEpoch}
      layers={layerRows}
      onLayerVisible={onLayerVisible}
      onLayerOpacity={onLayerOpacity}
      cubeFrame={cubeFrame}
      onCubeFrame={setCubeFrame}
      channels={channels}
      fieldLoading={field.status === "loading"}
    />
  );

  const analysisPane = (
    <AnalysisPane
      selection={selection}
      tab={tab}
      onTab={setTab}
      featured={featured ?? null}
      manifest={manifest}
      loading={field.status === "loading"}
      focusDetector={focusDetector}
      currentMjd={currentFrame && mode === "epochs" ? currentFrame.mjd : null}
      watchFieldArcmin={watchFieldArcmin}
      onWatchPosition={(ra, dec) => {
        void watchPatch(ra, dec);
        if (!wide) setPhoneTab("viewer");
      }}
      onWatchStar={watchStar}
      onPickTarget={selectTarget}
      onClose={clearSelection}
      closeLabel={wide ? undefined : "Back to the viewer"}
      fieldTitle={fieldTitle}
      hint={hint}
    />
  );

  const viewer = (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <ViewerToolbar
        tool={tool}
        onTool={chooseTool}
        grid={grid2}
        onGrid={setGrid2}
        crosshair={crosshair}
        onCrosshair={setCrosshair}
        display={display}
        onDisplay={setDisplay}
        histogram={histogram}
        fov={view.fov}
        onFov={(fov) => void setQ({ fov })}
        onZoomToField={zoomToField}
        hasField={Boolean(manifest)}
      />
      <div ref={viewerRef} className={cn("relative min-h-0 flex-1 overflow-hidden", tool !== "inspect" && "cursor-crosshair")} data-tool={tool} data-tour="lab-viewer">
        <AladinView
          key={viewerKey}
          view={view}
          frame={contextFrame}
          allwise={{ enabled: showWise, opacity: wiseOpacity }}
          onViewChange={handleViewChange}
          onStatusChange={setSkyStatus}
          onSkyClick={onSkyClick}
          onSkyMove={(p) => cursor.set(p)}
          onSessionChange={setSession}
          retryToken={retryToken}
          contextOpacity={contextOpacity}
        />
        <HoverMarker cursor={cursor} session={session} sources={sources} radiusDeg={pickRadiusDeg} enabled={tool === "inspect" && gaiaWanted} selectedId={selectedStar?.id ?? null} />
        <CompareOverlay
          mode={compareOn ? compare : "off"}
          session={session}
          grid={grid}
          view={view}
          a={frames[compareA] ?? null}
          b={currentFrame}
          urlA={frames[compareA] ? layerStatus.displayUrl(frames[compareA].key) : null}
          urlB={currentFrame ? layerStatus.displayUrl(currentFrame.key) : null}
        />
        <div className="pointer-events-none absolute inset-x-2 top-2 z-20 flex flex-col items-start gap-2">
          {fixture && <FixtureBanner standIn={field.status === "ready" && field.standIn ? field.standIn.name : null} />}
          <SkyStatusLine status={skyStatus} />
        </div>
        <AnimatePresence>
          {hint && skyStatus.state === "ready" && (
            <motion.div
              key="hint"
              initial={reduceMotion ? false : { opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
              className="pointer-events-auto absolute top-3 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 rounded-md border border-hair bg-ink/85 px-3 py-1.5 text-micro text-fg-dim"
              data-testid="lab-hint"
            >
              <MousePointerClickIcon className="size-3.5 text-fg-faint" aria-hidden />
              Click any star to learn about it
              <button type="button" onClick={dismissHint} className="ml-1 text-fg-faint underline decoration-hair-strong underline-offset-4 hover:text-fg">
                Got it
              </button>
            </motion.div>
          )}
        </AnimatePresence>
        {field.status !== "idle" && field.status !== "ready" && field.status !== "loading" && (
          <div className="absolute inset-x-3 bottom-3 z-20 flex justify-center">
            <div className="w-full max-w-[640px]">
              <FieldMessage
                field={field}
                title={fieldTitle}
                suggestions={field.status === "unavailable" && patch ? featuredNear(patch.ra, patch.dec, Math.max(patch.fovArcmin / 120, 0.1)) : []}
                onWatchTarget={selectTarget}
                onRetry={() => setFieldRetry((n) => n + 1)}
                onShowSky={showSky}
              />
            </div>
          </div>
        )}
        {field.status === "ready" && frames.length === 0 && (
          <div className="absolute inset-x-3 bottom-3 z-20 flex justify-center">
            <div className="w-full max-w-[640px]">
              <FieldMessage
                field={{ status: "unavailable", reason: "no-bundle", message: "This field has no frames for the chosen mode." }}
                title={fieldTitle}
                suggestions={[]}
                onWatchTarget={selectTarget}
                onRetry={() => setFieldRetry((n) => n + 1)}
                onShowSky={showSky}
              />
            </div>
          </div>
        )}
        {!wide && (selection || manifest) && (
          <PhonePeek
            title={
              selection?.kind === "star"
                ? `Gaia DR3 ${selection.source.id}`
                : selection?.kind === "position"
                  ? `${formatRaHms(selection.ra, 1)} ${formatDecDms(selection.dec, 0)}`
                  : fieldTitle
            }
            onDetails={() => setPhoneTab("analysis")}
          />
        )}
        <LabTourHost offerClassName="absolute inset-x-2 bottom-[4.25rem] z-10 flex justify-end min-[900px]:inset-x-auto min-[900px]:right-3 min-[900px]:bottom-3" />
        {skyStatus.state === "error" && (
          <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center p-4">
            <div role="alert" data-testid="sky-error" className="panel pointer-events-auto flex w-full max-w-sm flex-col gap-3 p-5">
              <p className="text-body font-medium text-fg">The SPHEREx map did not load</p>
              <p className="text-ui text-fg-dim">{skyStatus.message}</p>
              <p className="text-meta text-fg-faint">
                The sky data comes straight from IRSA at Caltech. Your view is kept in the address bar, so nothing is lost.
              </p>
              <div>
                <Button variant="outline" onClick={retrySky} className="mt-1 border-hair-strong">
                  Try again
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
      <StatusBar
        cursor={cursor}
        grid={grid}
        frameRaw={frameRaw}
        flags={flagsImage && currentFrame?.flags ? { image: flagsImage, legend: currentFrame.flags.legend } : null}
        frameLabel={frameLabel}
        wavelength={wavelength}
        fov={view.fov}
        measurement={measurement}
      />
      <Timeline
        field={field}
        manifest={manifest}
        mode={mode}
        det={det}
        frames={frames}
        current={current}
        playing={isPlaying}
        speed={speed}
        loopCount={loopCount}
        loaded={layerStatus.loaded}
        ready={layerStatus.ready}
        failed={layerStatus.failed}
        zoomedOut={!blinkVisible}
        blinkStyle={blinkStyle}
        compare={compareOn ? compare : "off"}
        compareA={clamp(compareA, 0, Math.max(0, frames.length - 1))}
        note={note && q.target === note.slug ? note.text : null}
        onMode={setMode}
        onDet={(d) => void setQ({ det: d })}
        onTogglePlay={togglePlay}
        onStep={step}
        onSeek={seek}
        onSpeed={setSpeed}
        onBlinkStyle={setBlinkStyle}
        onCompare={(c) => {
          setCompare(c);
          if (c === "off") return;
          setPlaying(false);
          // Start with the first frame against the last.
          const a = clamp(compareA, 0, frames.length - 1);
          if (current === a) setFrameIndex(a === frames.length - 1 ? 0 : frames.length - 1);
        }}
        onCompareA={setCompareA}
        onZoomToField={zoomToField}
      />
    </div>
  );

  const sessionBar = (
    <div className="flex h-9 shrink-0 items-center gap-3 border-b border-hair bg-ink-2 px-3" data-testid="session-bar">
      <p className="flex min-w-0 items-baseline gap-2 text-micro">
        <span className="shrink-0 font-medium text-fg">{featured?.name ?? (manifest ? "Field" : "Sky")}</span>
        <span className="readout truncate text-fg-dim" data-testid="coordinate-readout" aria-label="View centre">
          {formatRaHms(view.ra, 1)} {formatDecDms(view.dec, 0)}
        </span>
        <span className="hidden truncate text-fg-faint md:inline" data-testid="session-notes">
          {notes}
        </span>
      </p>
      <div className="ml-auto flex shrink-0 items-center gap-0.5">
        {/* Back to the same place on the Sky globe: the target, else the view centre. */}
        <Link
          href={featured ? `/sky?target=${featured.slug}` : `/sky?ra=${view.ra.toFixed(5)}&dec=${view.dec.toFixed(5)}`}
          prefetch={false}
          className="mr-1 inline-flex h-7 items-center gap-1.5 rounded-[5px] px-2 text-micro text-fg-dim transition-colors duration-150 hover:bg-white/[0.06] hover:text-fg"
          data-testid="lab-to-sky"
        >
          <GlobeIcon className="size-3.5" aria-hidden />
          <span className="hidden sm:inline">On the sky globe</span>
          <span className="sr-only sm:hidden">Show this on the sky globe</span>
        </Link>
        <LabTourButton />
        <ToolButton label="Command palette" shortcut="Ctrl K" onClick={() => setPaletteOpen(true)} testId="open-palette">
          <CommandIcon className="size-3.5" aria-hidden />
        </ToolButton>
        <ToolButton label="Keyboard shortcuts" shortcut="?" onClick={() => setShortcutsOpen(true)} testId="open-shortcuts">
          <KeyboardIcon className="size-3.5" aria-hidden />
        </ToolButton>
        <ToolButton label="Copy a link to this view" onClick={copyLink} testId="copy-link">
          <LinkIcon className="size-3.5" aria-hidden />
        </ToolButton>
        <ExportMenu
          items={[
            { label: "PNG of the frame on screen", disabled: !currentFrame, run: exportFrame },
            { label: "Spectrum (CSV)", disabled: !manifest?.spectrum?.points.length, run: () => manifest && exportSpectrumCsv(manifest) },
            { label: "Photometry (CSV)", disabled: !manifest?.lightcurve?.epoch_photometry.length, run: () => manifest && exportPhotometryCsv(manifest) },
            { label: "Positions (CSV)", disabled: !manifest?.motion?.epoch_positions.length, run: () => manifest && exportPositionsCsv(manifest) },
          ]}
          irsa={irsaLink}
        />
      </div>
    </div>
  );

  return (
    <div className="absolute inset-0 flex flex-col bg-ink" data-testid="lab">
      <h1 className="sr-only">Lab: a workbench for SPHEREx images of any patch of sky</h1>
      {sessionBar}
      {wide ? (
        <div className="flex min-h-0 flex-1">
          <aside aria-label="Data" className="flex min-h-0 shrink-0 flex-col bg-ink-2" style={{ width: leftW }}>
            {dataPane}
          </aside>
          <ResizeHandle label="Resize the data pane" value={leftW} min={236} max={420} onChange={setLeftW} side="left" />
          {viewer}
          <ResizeHandle label="Resize the analysis pane" value={rightW} min={320} max={560} onChange={setRightW} side="right" />
          <aside aria-label="Analysis pane" className="flex min-h-0 shrink-0 flex-col bg-ink-2" style={{ width: rightW }}>
            {analysisPane}
          </aside>
        </div>
      ) : (
        <>
          <PhoneTabs tab={phoneTab} onTab={setPhoneTab} />
          <div className="relative flex min-h-0 flex-1 flex-col">
            {viewer}
            {phoneTab === "data" && <div className="absolute inset-0 z-30 flex flex-col bg-ink-2">{dataPane}</div>}
            {phoneTab === "analysis" && <div className="absolute inset-0 z-30 flex flex-col bg-ink-2">{analysisPane}</div>}
          </div>
        </>
      )}
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        actions={paletteActions}
        onCoordinates={(ra, dec) => onPlace({ name: "coordinates", ra, dec, kind: "coordinates", provenance: "Coordinates as typed (ICRS)." })}
        onSearch={paletteSearch}
      />
      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
    </div>
  );
}

function measureReadout(
  measure: Measure,
  frames: { key: string; label: string }[],
  layers: { raw: (key: string) => ImageData | null },
  grid: TanGrid | null,
  sources: GaiaSource[],
): ReactNode {
  if (!measure) return null;
  if (measure.tool === "ruler") {
    if (!measure.b) return <span className="text-fg-dim">Ruler: click the second point</span>;
    const d = separationDeg(measure.a, measure.b);
    const pa = positionAngleDeg(measure.a, measure.b);
    return (
      <>
        <span className="text-fg-faint">Distance</span>
        <span className="readout">{formatAngle(d)}</span>
        <span className="text-fg-faint">
          <Term k="positionAngle" mark={false}>PA</Term>
        </span>
        <span className="readout">{pa.toFixed(1)}°</span>
      </>
    );
  }
  if (!measure.edge) return <span className="text-fg-dim">Aperture: click to set the radius</span>;
  const r = separationDeg(measure.center, measure.edge);
  const inside = sources.filter((s) => separationDeg(measure.center, s) <= r);
  const brightest = inside.reduce<number | null>((m, s) => (s.g !== null && (m === null || s.g < m) ? s.g : m), null);
  // Mean display level inside the circle, per frame: compares epochs of one detector.
  const levels = grid ? frames.map((f) => meanLevel(layers.raw(f.key), grid, measure.center, r)) : [];
  const finite = levels.filter((v): v is number => v !== null);
  return (
    <>
      <span className="text-fg-faint">Radius</span>
      <span className="readout">{formatAngle(r)}</span>
      <span className="text-fg-faint">Gaia</span>
      <span className="readout">
        {inside.length}
        {brightest !== null ? `, brightest G ${brightest.toFixed(1)}` : ""}
      </span>
      {finite.length > 1 && (
        <Popover>
          <PopoverTrigger asChild>
            <button type="button" className="inline-flex items-center gap-1.5 rounded-sm text-fg-dim hover:text-fg" data-testid="aperture-levels">
              <span>Level by epoch</span>
              <Sparkline values={levels} />
            </button>
          </PopoverTrigger>
          <PopoverContent side="top" className="w-64 border-hair-strong bg-popover p-3 text-micro text-fg-dim">
            <p className="mb-2 text-fg">Mean display level in the aperture</p>
            <ul className="readout flex flex-col gap-0.5">
              {frames.map((f, i) => (
                <li key={f.key} className="flex justify-between">
                  <span>{f.label}</span>
                  <span className="text-fg">{levels[i] === null ? "–" : (levels[i] as number).toFixed(1)}</span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-pretty text-fg-faint">
              Display levels (0–255) of the frames, stretched the same way for every epoch, so they compare epochs; they
              are not a calibrated flux.
            </p>
          </PopoverContent>
        </Popover>
      )}
    </>
  );
}

function meanLevel(raw: ImageData | null, grid: TanGrid, center: { ra: number; dec: number }, rDeg: number): number | null {
  if (!raw) return null;
  let sum = 0;
  let n = 0;
  const pxDeg = Math.abs(grid.cd22) || 1e-3;
  const rPx = rDeg / pxDeg;
  // Cheap: scan the bounding box in pixel space around the centre.
  const c = tanCenter(grid, center);
  if (!c) return null;
  for (let row = Math.floor(c.row - rPx); row <= Math.ceil(c.row + rPx); row++) {
    for (let col = Math.floor(c.col - rPx); col <= Math.ceil(c.col + rPx); col++) {
      if (row < 0 || col < 0 || row >= raw.height || col >= raw.width) continue;
      if ((row - c.row) ** 2 + (col - c.col) ** 2 > rPx * rPx) continue;
      const i = (row * raw.width + col) * 4;
      if (raw.data[i + 3] === 0) continue;
      sum += raw.data[i] * 0.299 + raw.data[i + 1] * 0.587 + raw.data[i + 2] * 0.114;
      n += 1;
    }
  }
  return n ? sum / n : null;
}

function tanCenter(grid: TanGrid, p: { ra: number; dec: number }) {
  // Same mapping as pngPixelAt, without rounding.
  const D2R = Math.PI / 180;
  const a0 = grid.crval1 * D2R;
  const d0 = grid.crval2 * D2R;
  const a = p.ra * D2R;
  const d = p.dec * D2R;
  const cosc = Math.sin(d0) * Math.sin(d) + Math.cos(d0) * Math.cos(d) * Math.cos(a - a0);
  if (cosc <= 0) return null;
  const xi = (Math.cos(d) * Math.sin(a - a0)) / cosc / D2R;
  const eta = (Math.cos(d0) * Math.sin(d) - Math.sin(d0) * Math.cos(d) * Math.cos(a - a0)) / cosc / D2R;
  const det = grid.cd11 * grid.cd22 - grid.cd12 * grid.cd21;
  const x = (grid.cd22 * xi - grid.cd12 * eta) / det + grid.crpix1;
  const y = (-grid.cd21 * xi + grid.cd11 * eta) / det + grid.crpix2;
  return { col: x - 1, row: grid.height - y };
}

function Sparkline({ values }: { values: (number | null)[] }) {
  const v = values.filter((x): x is number => x !== null);
  if (v.length < 2) return null;
  const lo = Math.min(...v);
  const hi = Math.max(...v);
  const pts = values
    .map((x, i) => (x === null ? null : `${(i / (values.length - 1)) * 48},${12 - ((x - lo) / (hi - lo || 1)) * 10}`))
    .filter(Boolean)
    .join(" ");
  return (
    <svg width="50" height="14" viewBox="0 0 50 14" aria-hidden>
      <polyline points={pts} fill="none" stroke="var(--accent)" strokeWidth="1.25" />
    </svg>
  );
}

/** A ring and a label on the Gaia source nearest the pointer (DOM, so it follows at 60 fps). */
function HoverMarker({
  cursor,
  session,
  sources,
  radiusDeg,
  enabled,
  selectedId,
}: {
  cursor: CursorStore;
  session: AladinSession | null;
  sources: GaiaSource[];
  radiusDeg: number;
  enabled: boolean;
  selectedId: string | null;
}) {
  const c = useCursor(cursor);
  if (!enabled || !c || !session) return null;
  const s = nearestSource(sources, c.ra, c.dec, radiusDeg);
  if (!s) return null;
  const p = extra(session).aladin.world2pix(s.ra, s.dec);
  if (!p || !p.every(Number.isFinite)) return null;
  return (
    <div className="pointer-events-none absolute inset-0 z-10" data-testid="hover-marker">
      <span
        aria-hidden
        className={cn("absolute size-6 -translate-x-1/2 -translate-y-1/2 rounded-full border", s.id === selectedId ? "border-accent" : "border-fg/80")}
        style={{ left: p[0], top: p[1] }}
      />
      <span className="absolute translate-x-4 -translate-y-1/2 rounded-[4px] border border-hair bg-ink/90 px-1.5 py-0.5 text-micro whitespace-nowrap text-fg" style={{ left: p[0], top: p[1] }}>
        <span className="readout">G {s.g !== null ? s.g.toFixed(1) : "–"}</span>
        {s.bpRp !== null && <span className="readout text-fg-dim"> · BP−RP {s.bpRp.toFixed(2)}</span>}
        <span className="text-fg-faint"> · click for details</span>
      </span>
    </div>
  );
}

function PhoneTabs({ tab, onTab }: { tab: "data" | "viewer" | "analysis"; onTab: (t: "data" | "viewer" | "analysis") => void }) {
  const reduce = useReducedMotion();
  const tabs = [
    { value: "data" as const, label: "Data" },
    { value: "viewer" as const, label: "Viewer" },
    { value: "analysis" as const, label: "Analysis" },
  ];
  return (
    <div role="tablist" aria-label="Workbench panes" className="grid h-9 shrink-0 grid-cols-3 border-b border-hair bg-ink-2" data-testid="phone-tabs">
      {tabs.map((t) => (
        <button
          key={t.value}
          type="button"
          role="tab"
          aria-selected={tab === t.value}
          data-testid={`phone-tab-${t.value}`}
          onClick={() => onTab(t.value)}
          className={cn("relative text-micro text-fg-dim transition-colors", tab === t.value && "text-fg")}
        >
          {t.label}
          {tab === t.value && (
            <motion.span
              aria-hidden
              layoutId="phone-tab"
              className="absolute inset-x-6 bottom-0 h-0.5 rounded-full bg-accent"
              transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 520, damping: 42 }}
            />
          )}
        </button>
      ))}
    </div>
  );
}

function PhonePeek({ title, onDetails }: { title: string; onDetails: () => void }) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      initial={reduce ? false : { y: 16, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
      className="absolute inset-x-2 bottom-2 z-20 flex items-center justify-between gap-3 rounded-lg border border-hair bg-ink-2/95 px-3 py-2"
      data-testid="phone-peek"
    >
      <p className="min-w-0 truncate text-meta text-fg">{title}</p>
      <button
        type="button"
        onClick={onDetails}
        data-testid="open-details"
        className="h-7 shrink-0 rounded-md border border-hair-strong px-2.5 text-micro text-fg transition-colors hover:bg-white/[0.06]"
      >
        Details
      </button>
    </motion.div>
  );
}

function ExportMenu({ items, irsa }: { items: { label: string; disabled?: boolean; run: () => void }[]; irsa: string | null }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Export"
          data-testid="open-export"
          className="grid size-7 place-items-center rounded-[5px] text-fg-dim transition-colors hover:bg-white/[0.06] hover:text-fg"
        >
          <DownloadIcon className="size-3.5" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-60 border-hair-strong bg-popover p-1" data-testid="export-menu">
        <ul className="flex flex-col">
          {items.map((it) => (
            <li key={it.label}>
              <button
                type="button"
                disabled={it.disabled}
                onClick={() => {
                  setOpen(false);
                  it.run();
                }}
                className="w-full rounded-[5px] px-2 py-1.5 text-left text-meta text-fg-dim transition-colors hover:bg-white/[0.06] hover:text-fg disabled:opacity-40"
              >
                {it.label}
              </button>
            </li>
          ))}
          <li>
            {irsa ? (
              <a href={irsa} target="_blank" rel="noreferrer noopener" className="block rounded-[5px] px-2 py-1.5 text-meta text-fg-dim hover:bg-white/[0.06] hover:text-fg">
                IRSA exposure list for this epoch
              </a>
            ) : (
              <span className="block px-2 py-1.5 text-meta text-fg-faint">IRSA exposure list (pick an epoch)</span>
            )}
          </li>
        </ul>
      </PopoverContent>
    </Popover>
  );
}

function SkyStatusLine({ status }: { status: AladinStatus }) {
  return (
    <p
      aria-live="polite"
      data-testid="sky-status"
      data-state={status.state}
      className={cn("rounded-[4px] bg-ink/70 px-1.5 py-0.5 text-micro text-fg-faint transition-opacity duration-500", status.state === "ready" && "opacity-0")}
    >
      {status.state === "loading" && "Loading the SPHEREx all-sky map from IRSA…"}
      {status.state === "ready" && "SPHEREx DR1 all-sky map, 12.9″ pixels, in Aladin Lite"}
      {status.state === "error" && <span className="text-destructive">The all-sky map failed to load</span>}
    </p>
  );
}
