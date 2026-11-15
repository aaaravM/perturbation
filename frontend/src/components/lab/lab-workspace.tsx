"use client";
// Lab mode, the research tool at /explore. Aladin fills the stage with the SPHEREx DR1 cube as
// context; per-epoch SPHEREx frames are blinked on top of it; a right-hand panel explains the
// selected object or clicked position. Everything that defines the view lives in the URL.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useQueryStates } from "nuqs";
import { useReducedMotion } from "motion/react";
import { AladinView, type AladinStatus, type SkyView } from "@/components/sky/aladin-view";
import type { AladinSession } from "@/components/sky/aladin-session";
import { Button } from "@/components/ui/button";
import { loadSpectralChannels, type SpectralChannel } from "@/lib/spherex";
import { findFeatured } from "@/lib/targets";
import { API_URL } from "@/lib/manifest";
import { featuredNear, type ResolvedPlace } from "@/lib/lab-resolve";
import { formatDecDms, formatRaHms, separationDeg } from "@/lib/lab-coords";
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
  framesFor,
  loadLiveField,
  loadTargetField,
  motionPath,
  positionAt,
  resolveDetector,
  type FieldState,
} from "@/lib/lab-field";
import { BlinkPlayer, SPEED_DEFAULT } from "@/components/lab/blink-player";
import { ContextBar } from "@/components/lab/context-bar";
import { FieldMessage } from "@/components/lab/field-message";
import { FixtureBanner } from "@/components/lab/fixture-banner";
import { FovControl } from "@/components/lab/fov-control";
import { LabSearch } from "@/components/lab/lab-search";
import { useBlinkLayers } from "@/components/lab/use-blink-layers";
import { useMotionOverlay } from "@/components/lab/use-motion-overlay";
import { DetailPanel, PANEL_WIDTH, useIsDesktop } from "@/components/panel/detail-panel";
import { PositionDetails } from "@/components/panel/position-details";
import { TargetDetails } from "@/components/panel/target-details";

/** Context cube frame before any field is loaded: D2 channel 4 (~1.2 um), as in the preview. */
const DEFAULT_CUBE_FRAME = 20;
/** Frames prepared for a featured target cover about 10 arcmin. */
const TARGET_FIELD_ARCMIN = 10;
const NAV_H = 52;

type PanelState = { kind: "target" } | { kind: "position"; ra: number; dec: number } | null;
type Patch = { ra: number; dec: number; fovArcmin: number; nonce: number };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const fieldArcmin = (fovDeg: number) => clamp(fovDeg * 60, 2, 30);
/** Live fields default to 10 arcmin (API contract). */
const DEFAULT_FIELD_ARCMIN = 10;

/**
 * The square of sky clear of the search box, the player and (on wide screens) the panel, in
 * screen pixels. Aladin's fov is the width of the whole stage (w).
 */
function freeArea(panelOpen: boolean) {
  const w = window.innerWidth;
  const h = Math.max(320, window.innerHeight - NAV_H);
  const desktop = w >= 768;
  const top = desktop ? 130 : 220;
  // The player is about 220 px tall with a two-line note (the brief's link, pasted coordinates).
  const bottom = desktop ? 248 : 250;
  const side = desktop ? (panelOpen ? PANEL_WIDTH + 24 : 430) : 12;
  const px = Math.max(150, Math.min(w - 2 * side, h - top - bottom));
  return { w, px, top, bottom };
}

/** A view that shows a square field of `frameArcmin` in the free area. */
function framedView(
  center: { ra: number; dec: number },
  frameArcmin: number,
  panelOpen: boolean,
  measure = true,
): SkyView {
  if (!measure || typeof window === "undefined") return { ...center, fov: 0.4 };
  const { w, px, top, bottom } = freeArea(panelOpen);
  const fov = clamp(((frameArcmin / 60) * w) / px, BLINK_FOV_MIN_DEG, BLINK_FOV_MAX_DEG);
  // Centre the field vertically in the free area: the view centre moves south of it.
  const dy = (bottom - top) / 2;
  return { ra: center.ra, dec: clamp(center.dec - dy * (fov / w), -90, 90), fov };
}

/** The field (arcmin) that fills the free area at this zoom: what "Watch this patch" asks for. */
function visibleFieldArcmin(fovDeg: number, panelOpen: boolean): number {
  if (fovDeg > BLINK_FOV_MAX_DEG + 1e-6 || typeof window === "undefined") return DEFAULT_FIELD_ARCMIN;
  const { w, px } = freeArea(panelOpen);
  return clamp(Math.round(((fovDeg * 60 * px) / w) * 2) / 2, 2, 30);
}

/** The featured target nearest to a patch centre, if it lies inside the patch. */
function featuredInField(ra: number, dec: number, fieldArcmin: number) {
  const best = featuredNear(ra, dec, fieldArcmin / 120)
    .map((t) => ({ t, sep: separationDeg(t, { ra, dec }) * 60 }))
    .sort((a, b) => a.sep - b.sep)[0];
  return best ?? null;
}

interface PickNote {
  slug: string;
  text: string;
}

/** Without the backend, a patch that contains a featured target shows that target's prepared frames. */
function pickNote(name: string, slug: string, sepArcmin: number): PickNote {
  const where = sepArcmin < 0.1 ? "at the position you asked for" : `${sepArcmin.toFixed(1)}′ from the position you asked for`;
  return {
    slug,
    text: `Showing the prepared frames of ${name}, ${where}. Frames for any other patch need the live backend, which is not connected yet.`,
  };
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

export function LabWorkspace() {
  const [q, setQ] = useQueryStates(labParsers, labUrlOptions);
  const reduceMotion = useReducedMotion();
  const desktop = useIsDesktop();
  const isClient = useIsClient();
  const featured = findFeatured(q.target);

  // ------------------------------------------------------------------ view
  const view: SkyView = useMemo(() => {
    const fallback = featured ? framedView(featured, TARGET_FIELD_ARCMIN, Boolean(q.target), isClient) : DEFAULT_VIEW;
    return { ra: q.ra ?? fallback.ra, dec: q.dec ?? fallback.dec, fov: q.fov ?? fallback.fov };
  }, [q.ra, q.dec, q.fov, q.target, featured, isClient]);
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
  // A link to a position (?ra&dec&fov, as in the brief) asks for a live field there. Without the
  // backend, a featured target inside that patch has prepared frames, so those are shown instead,
  // with a note that says so.
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
    const wide = window.matchMedia("(min-width: 768px)").matches;
    if (initialPick) {
      const t = findFeatured(initialPick.slug);
      const v = t ? framedView(t, TARGET_FIELD_ARCMIN, wide) : null;
      void setQ({ target: initialPick.slug, ra: v?.ra ?? null, dec: v?.dec ?? null, fov: v?.fov ?? null, frame: null });
      return;
    }
    // A link to a target with a view too wide for its frames (fov is in degrees) is a link to
    // that target's frames: frame them.
    const t = findFeatured(q.target);
    if (t && q.fov !== null && q.fov > BLINK_FOV_MAX_DEG + 1e-6) {
      const v = framedView(t, TARGET_FIELD_ARCMIN, wide);
      void setQ({ ra: v.ra, dec: v.dec, fov: v.fov });
    }
    // Once, on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [fieldRetry, setFieldRetry] = useState(0);
  const requestKey = q.target ? `target:${q.target}` : patch ? `patch:${JSON.stringify(patch)}` : "";
  const loadKey = requestKey ? `${fieldRetry}#${requestKey}` : "";
  // Results are stored with the request they answer; anything else is still loading.
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

  // A target-less link (?target=_fixture) has no position until the manifest says where it is.
  useEffect(() => {
    if (!manifest || q.ra !== null) return;
    const v = framedView(manifest.center, manifest.fov_arcmin, true);
    void setQ({ ra: v.ra, dec: v.dec, fov: q.fov ?? v.fov });
  }, [manifest, q.ra, q.fov, setQ]);

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
  const det: LabDetector | null = manifest ? resolveDetector(manifest, mode, q.det) : null;
  const frames = useMemo(
    () => (manifest && manifestUrl ? framesFor(manifest, manifestUrl, mode, det) : []),
    [manifest, manifestUrl, mode, det],
  );
  const showPath = q.layers.includes("path");
  const showFlags = q.layers.includes("flags");
  const showWise = q.layers.includes("wise");

  // ------------------------------------------------------------------ playback
  const [frameIndex, setFrameIndex] = useState(q.frame ?? 0);
  const [playing, setPlaying] = useState(q.frame === null);
  const [speed, setSpeed] = useState(SPEED_DEFAULT);
  const [loopCount, setLoopCount] = useState(0);
  const current = frames.length ? clamp(frameIndex, 0, frames.length - 1) : 0;

  const layerStatus = useBlinkLayers({
    session,
    manifestKey: manifest ? `${manifestUrl}|${manifest.generated_at}|${manifest.center.ra}|${manifest.center.dec}` : null,
    wcs: manifest?.grid.wcs ?? null,
    frames,
    current,
    visible: blinkVisible,
    showFlags,
  });
  const canPlay = layerStatus.ready && frames.length > 1 && blinkVisible;
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

  // Reduced motion: never start blinking on its own.
  const autoPausedRef = useRef(false);
  useEffect(() => {
    if (reduceMotion && !autoPausedRef.current) {
      autoPausedRef.current = true;
      setPlaying(false);
    }
  }, [reduceMotion]);

  // Paused frames go into the URL so a shared link opens on the same frame.
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
  const seek = (index: number) => {
    setPlaying(false);
    setFrameIndex(index);
  };
  const togglePlay = useCallback(() => {
    if (canPlay) setPlaying((p) => !p);
  }, [canPlay]);

  // ------------------------------------------------------------------ overlays on the sky
  const path = useMemo(() => (manifest ? motionPath(manifest, frames, mode) : []), [manifest, frames, mode]);
  const markers = useMemo(() => {
    if (!manifest) return [];
    if (mode === "epochs" && manifest.motion) return manifest.motion.epoch_positions.map((p) => ({ ra: p.ra, dec: p.dec }));
    if (mode === "then-now") return frames.map((f) => positionAt(manifest, f)).filter((p): p is { ra: number; dec: number } => p !== null);
    return [];
  }, [manifest, frames, mode]);
  const currentPos = manifest && frames[current] ? positionAt(manifest, frames[current]) : null;

  // ------------------------------------------------------------------ panel
  // A target link opens its panel, except on phones, where the sheet would cover the blink.
  // useIsDesktop() reports the server default (desktop) during hydration, so the phone case is
  // settled on the render after it.
  const [panel, setPanel] = useState<PanelState>(() => (q.target || initialPick ? { kind: "target" } : null));
  const [autoOpened, setAutoOpened] = useState(Boolean(q.target || initialPick));
  if (autoOpened && isClient) {
    setAutoOpened(false);
    if (!desktop && panel?.kind === "target") setPanel(null);
  }
  const [focusRequest, setFocusRequest] = useState(0);
  const openPanel = (next: PanelState, focus: boolean) => {
    setPanel(next);
    if (focus) setFocusRequest((n) => n + 1);
  };
  const closePanel = useCallback(() => setPanel(null), []);

  // Aladin's logo sits in the bottom-right corner, where it shows through the player and the
  // panel. The Lab credits Aladin Lite in text instead (status line and panels).
  useEffect(() => {
    const logo = session?.host.querySelector<HTMLElement>(".aladin-logo-container");
    if (logo) logo.style.display = "none";
  }, [session]);

  useMotionOverlay({
    session,
    path,
    markers,
    current: blinkVisible ? currentPos : null,
    fovDeg: view.fov,
    show: showPath && blinkVisible,
    probe: panel?.kind === "position" ? { ra: panel.ra, dec: panel.dec } : null,
  });

  // ------------------------------------------------------------------ actions
  const selectTarget = useCallback(
    (slug: string, pick: PickNote | null = null) => {
      const t = findFeatured(slug);
      const v = t ? framedView(t, TARGET_FIELD_ARCMIN, true) : null;
      setPatch(null);
      setNote(pick);
      setFrameIndex(0);
      setPlaying(!reduceMotion);
      void setQ({ target: slug, ra: v?.ra ?? null, dec: v?.dec ?? null, fov: v?.fov ?? null, frame: null });
      // On phones the sheet would cover the blink; the player's Details button opens it there.
      if (desktop) {
        setPanel({ kind: "target" });
        setFocusRequest((n) => n + 1);
      } else {
        setPanel(null);
      }
    },
    [reduceMotion, setQ, desktop],
  );

  const watchFieldArcmin = isClient ? visibleFieldArcmin(view.fov, true) : DEFAULT_FIELD_ARCMIN;
  const watchPatch = useCallback(
    (ra: number, dec: number) => {
      const field = visibleFieldArcmin(view.fov, true);
      if (!API_URL) {
        const near = featuredInField(ra, dec, field);
        if (near) {
          selectTarget(near.t.slug, pickNote(near.t.name, near.t.slug, near.sep));
          return "target" as const;
        }
      }
      const v = framedView({ ra, dec }, field, true);
      setNote(null);
      setFrameIndex(0);
      setPlaying(!reduceMotion);
      void setQ({ target: null, ra: v.ra, dec: v.dec, fov: v.fov, frame: null });
      setPatch((p) => ({ ra, dec, fovArcmin: field, nonce: (p?.nonce ?? 0) + 1 }));
      return "patch" as const;
    },
    [view.fov, reduceMotion, setQ, selectTarget],
  );

  const onPlace = (place: ResolvedPlace) => {
    if (place.slug) {
      selectTarget(place.slug);
      return;
    }
    if (watchPatch(place.ra, place.dec) === "patch") {
      openPanel({ kind: "position", ra: place.ra, dec: place.dec }, false);
    }
  };

  const showSky = () => {
    setPatch(null);
    setNote(null);
    void setQ({ target: null, frame: null, fov: Math.max(view.fov, DEFAULT_VIEW.fov) });
    if (panel?.kind === "target") setPanel(null);
  };

  const zoomToField = () => {
    if (!manifest) return;
    const v = framedView(manifest.center, manifest.fov_arcmin, panel !== null);
    void setQ({ ra: v.ra, dec: v.dec, fov: v.fov });
  };

  const setLayer = (layer: LabLayer, on: boolean) => {
    const next = on ? [...new Set([...q.layers, layer])] : q.layers.filter((l) => l !== layer);
    void setQ({ layers: next });
  };

  // ------------------------------------------------------------------ keyboard
  const keyState = useRef({ panel, closePanel, togglePlay, step, blink: frames.length > 0 && blinkVisible });
  useEffect(() => {
    keyState.current = { panel, closePanel, togglePlay, step, blink: frames.length > 0 && blinkVisible };
  });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const s = keyState.current;
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target as HTMLElement | null;
      if (event.key === "Escape") {
        if (s.panel && !target?.closest("[role=dialog], [data-radix-popper-content-wrapper]")) {
          event.preventDefault();
          s.closePanel();
        }
        return;
      }
      if (!s.blink) return;
      if (target?.closest("input, textarea, select, [contenteditable=true], [role=slider], [role=tab], [role=radio], [role=tablist], [role=radiogroup]")) return;
      if (event.key === " " || event.code === "Space") {
        if (target?.closest("button, a, [role=application]") && !target.closest("[data-testid=sky-viewer]")) return;
        event.preventDefault();
        s.togglePlay();
      } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        if (target?.closest("[role=application]")) return; // the sky viewer pans with arrows
        event.preventDefault();
        s.step(event.key === "ArrowLeft" ? -1 : 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ------------------------------------------------------------------ context layer
  const [cubeFrame, setCubeFrame] = useState(DEFAULT_CUBE_FRAME);
  const [channels, setChannels] = useState<SpectralChannel[] | null>(null);
  const [wiseOpacity, setWiseOpacity] = useState(0.5);
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

  // ------------------------------------------------------------------ layout
  const panelOpen = panel !== null;
  const bottomRight = desktop && panelOpen ? PANEL_WIDTH + 28 : undefined;
  const inView = useMemo(
    () => (manifest ? [] : featuredNear(view.ra, view.dec, Math.min(view.fov * 0.45, 3))),
    [manifest, view.ra, view.dec, view.fov],
  );
  const suggestions = useMemo(
    () => (patch ? featuredNear(patch.ra, patch.dec, Math.max(patch.fovArcmin / 120, 0.1)) : []),
    [patch],
  );
  const focusDetector = det && det !== "rgb" ? Number(det.slice(1)) : 6;
  const currentFrame = frames[current] ?? null;
  const fieldTitle = featured?.name ?? (q.target === FIXTURE_SLUG ? "the development fixture" : "this field");

  return (
    <div className="absolute inset-0" data-testid="lab">
      <h1 className="sr-only">Lab: blink SPHEREx images of any patch of sky</h1>
      <AladinView
        key={viewerKey}
        view={view}
        frame={contextFrame}
        allwise={{ enabled: showWise, opacity: wiseOpacity }}
        onViewChange={handleViewChange}
        onStatusChange={setSkyStatus}
        onSkyClick={(pos) => openPanel({ kind: "position", ra: pos.ra, dec: pos.dec }, true)}
        onSessionChange={setSession}
        retryToken={retryToken}
        // Dim the coarser all-sky map around the blink frames so the frames carry the eye.
        contextOpacity={frames.length > 0 && blinkVisible && layerStatus.ready ? 0.5 : 1}
      />

      {/* Top: search, view readout, and the fixture banner */}
      <div className="pointer-events-none absolute inset-x-3 top-3 z-20 flex flex-col items-start gap-2 sm:inset-x-4 sm:top-4 lg:flex-row lg:gap-4">
        <section
          aria-label="Search and view"
          className="panel pointer-events-auto flex w-full flex-col gap-3 px-3.5 pt-3 pb-3 sm:w-[min(400px,100%)]"
        >
          <LabSearch activeSlug={q.target} onPlace={onPlace} onPickTarget={selectTarget} />
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 border-t border-hair pt-2.5">
            <p className="readout text-micro text-fg-dim" data-testid="coordinate-readout" aria-label="View centre">
              {formatRaHms(view.ra, 1)} {formatDecDms(view.dec, 0)}
            </p>
            <FovControl fov={view.fov} onChange={(fov) => void setQ({ fov })} />
          </div>
          <SkyStatusLine status={skyStatus} />
        </section>
        {fixture && (
          <FixtureBanner standIn={field.status === "ready" && field.standIn ? field.standIn.name : null} />
        )}
      </div>

      {/* Bottom: blink player, field status or the all-sky controls */}
      <div
        className="pointer-events-none absolute bottom-3 left-3 z-20 flex justify-center sm:bottom-4 sm:left-4"
        style={{ right: bottomRight ?? (desktop ? 16 : 12) }}
      >
        <div className="pointer-events-auto w-full max-w-[820px]">
          {field.status === "ready" ? (
            frames.length > 0 ? (
              <BlinkPlayer
                manifest={field.manifest}
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
                showPath={showPath}
                showFlags={showFlags}
                hasPath={path.length > 1 || markers.length > 0}
                zoomedOut={!blinkVisible}
                onMode={(m) => void setQ({ mode: m })}
                onDet={(d) => void setQ({ det: d })}
                onTogglePlay={togglePlay}
                onStep={step}
                onSeek={seek}
                onSpeed={setSpeed}
                onShowPath={(on) => setLayer("path", on)}
                onShowFlags={(on) => setLayer("flags", on)}
                onZoomToField={zoomToField}
                onDetails={panel?.kind === "target" ? undefined : () => openPanel({ kind: "target" }, true)}
                note={note && q.target === note.slug ? note.text : null}
              />
            ) : (
              <FieldMessage
                field={{ status: "unavailable", reason: "no-bundle", message: "This field has no frames for the chosen mode." }}
                title={fieldTitle}
                suggestions={[]}
                onWatchTarget={selectTarget}
                onRetry={() => setFieldRetry((n) => n + 1)}
                onShowSky={showSky}
              />
            )
          ) : field.status === "idle" ? (
            <ContextBar
              frame={cubeFrame}
              onFrame={setCubeFrame}
              channels={channels}
              wise={showWise}
              wiseOpacity={wiseOpacity}
              onWise={(on) => setLayer("wise", on)}
              onWiseOpacity={setWiseOpacity}
              inView={inView}
              onWatchTarget={selectTarget}
            />
          ) : (
            <FieldMessage
              field={field}
              title={fieldTitle}
              suggestions={field.status === "unavailable" ? suggestions : []}
              onWatchTarget={selectTarget}
              onRetry={() => setFieldRetry((n) => n + 1)}
              onShowSky={showSky}
            />
          )}
        </div>
      </div>

      <DetailPanel
        open={panelOpen}
        contentKey={panel?.kind === "position" ? `pos:${panel.ra},${panel.dec}` : `target:${q.target ?? ""}`}
        focusRequest={focusRequest}
        label={panel?.kind === "position" ? "Sky position details" : `${fieldTitle} details`}
        onClose={closePanel}
      >
        {panel?.kind === "position" ? (
          <PositionDetails
            key={`${panel.ra},${panel.dec}`}
            ra={panel.ra}
            dec={panel.dec}
            watchFieldArcmin={watchFieldArcmin}
            onWatch={() => void watchPatch(panel.ra, panel.dec)}
            onPickTarget={selectTarget}
          />
        ) : panel?.kind === "target" ? (
          <TargetDetails
            featured={featured ?? null}
            manifest={manifest}
            loading={field.status === "loading"}
            focusDetector={focusDetector}
            currentMjd={currentFrame && mode === "epochs" ? currentFrame.mjd : null}
          />
        ) : null}
      </DetailPanel>

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
  );
}

function SkyStatusLine({ status }: { status: AladinStatus }) {
  return (
    <p aria-live="polite" data-testid="sky-status" data-state={status.state} className="-mt-1 hidden text-micro text-fg-faint sm:block">
      {status.state === "loading" && "Loading the SPHEREx all-sky map from IRSA…"}
      {status.state === "ready" && "Underneath: SPHEREx DR1 all-sky map, 12.9″ pixels, in Aladin Lite"}
      {status.state === "error" && <span className="text-destructive">The all-sky map failed to load</span>}
    </p>
  );
}
