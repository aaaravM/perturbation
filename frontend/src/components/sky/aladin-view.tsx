"use client";
// Client-only Aladin Lite 3.8.2 view with the IRSA SPHEREx DR1 cube as the base layer.
//
// - aladin-lite touches `document` at import time, so it is imported dynamically
//   (see aladin-session.ts), never at module level.
// - One long-lived instance per page load, re-parented between mounts (no destroy() in 3.8.2).
// - The view follows `view` (URL state): when it changes from outside (back/forward, a link,
//   an edited URL) the sky moves; when the user pans or zooms, onViewChange reports it.
// - Tile health: SPHEREx tile responses are watched via Resource Timing. If the layer, or every
//   tile for the current frame, fails (or nothing arrives in time), the status turns to "error"
//   so the UI can offer a retry instead of a silently blank or substituted sky.

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { HiPS } from "aladin-lite";
import { cn } from "@/lib/utils";
import { ALLWISE_W2, frameToFrequencyHz } from "@/lib/spherex";
import { FOV_MAX, FOV_MIN, roundCoord, roundFov } from "@/lib/url-state";
import {
  attachSession,
  detachSession,
  emitCurrentView,
  setSessionSubscriber,
  setSpherexLayer,
  type AladinSession,
  type SkyView,
  type TileEvent,
} from "@/components/sky/aladin-session";

export type { SkyView } from "@/components/sky/aladin-session";

export type AladinStatus =
  | { state: "loading" }
  | { state: "ready" }
  /** kind "viewer": the instance itself failed (remount to retry); "layer": data failed. */
  | { state: "error"; kind: "viewer" | "layer"; message: string };

export interface AladinViewProps {
  /** Current view from the URL. External changes move the sky. */
  view: SkyView;
  /** Reports the view rounded for the URL (see roundCoord/roundFov). */
  /** SPHEREx cube frame (1..101, never 0, 50 or 51). Applied after a short debounce. */
  frame: number;
  /** AllWISE W2 comparison overlay. */
  allwise: { enabled: boolean; opacity: number };
  onViewChange?: (view: SkyView, dragging: boolean) => void;
  onStatusChange?: (status: AladinStatus) => void;
  /** A click (not a drag) on the sky. */
  onSkyClick?: (position: { ra: number; dec: number }) => void;
  /** The pointer over the sky, or null when it leaves (for live readouts and tools). */
  onSkyMove?: (position: { ra: number; dec: number; x: number; y: number } | null) => void;
  /** The live Aladin session once attached (null after unmount), for overlays such as the blink. */
  onSessionChange?: (session: AladinSession | null) => void;
  /** Bump to rebuild the SPHEREx layer after an error. */
  retryToken?: number;
  /** Opacity of the SPHEREx context layer (dimmed under blink frames). Default 1. */
  contextOpacity?: number;
  className?: string;
}

const FRAME_DEBOUNCE_MS = 200;
const ALLWISE_LAYER = "allwise-w2";
/** All tiles failed for this long (with none succeeding) -> error. */
const TILE_FAILURE_GRACE_MS = 2500;
/** No SPHEREx tile response at all for this long after the layer is ready -> error. */
const TILE_WATCHDOG_MS = 25000;
/** Longer than the URL throttle (300 ms) plus a render. */
const ECHO_WINDOW_MS = 2000;

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === "string" ? err : "unknown error";
}

function sameView(a: SkyView, b: SkyView) {
  const dRa = Math.abs(((a.ra - b.ra + 540) % 360) - 180);
  return dRa < 1e-7 && Math.abs(a.dec - b.dec) < 1e-7 && Math.abs(a.fov - b.fov) < 1e-7 * b.fov;
}

function roundView(v: SkyView): SkyView {
  return { ra: roundCoord(((v.ra % 360) + 360) % 360), dec: roundCoord(v.dec), fov: roundFov(v.fov) };
}

export function AladinView({
  view,
  frame,
  allwise,
  onViewChange,
  onStatusChange,
  onSkyClick,
  onSkyMove,
  onSessionChange,
  retryToken = 0,
  contextOpacity = 1,
  className,
}: AladinViewProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<AladinSession | null>(null);
  const cubeRef = useRef<HiPS | null>(null);
  const wiseRef = useRef<HiPS | null>(null);
  const [session, setSession] = useState<AladinSession | null>(null);

  const viewRef = useRef(view);
  const frameRef = useRef(frame);
  const contextOpacityRef = useRef(contextOpacity);
  /**
   * Views we reported in the last ECHO_WINDOW_MS: a URL update matching one of them is our own
   * echo (the URL is throttled, so it can lag a pan in progress). Cleared on external moves, so
   * going back to an earlier view still moves the sky.
   */
  const recentRef = useRef<{ view: SkyView; at: number }[]>([]);
  const onViewChangeRef = useRef(onViewChange);
  const onStatusChangeRef = useRef(onStatusChange);
  const onSkyClickRef = useRef(onSkyClick);
  const onSkyMoveRef = useRef(onSkyMove);
  const onSessionChangeRef = useRef(onSessionChange);
  const statusRef = useRef<AladinStatus["state"]>("loading");
  const tileStatsRef = useRef({ frame, ok: 0, failed: 0, lastStatus: 0 });
  const failureTimerRef = useRef<number | undefined>(undefined);
  const watchdogRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    viewRef.current = view;
    onViewChangeRef.current = onViewChange;
    onStatusChangeRef.current = onStatusChange;
    onSkyClickRef.current = onSkyClick;
    onSkyMoveRef.current = onSkyMove;
    onSessionChangeRef.current = onSessionChange;
  });

  const setStatus = useCallback((status: AladinStatus) => {
    statusRef.current = status.state;
    onStatusChangeRef.current?.(status);
  }, []);

  const armWatchdog = useCallback(() => {
    window.clearTimeout(watchdogRef.current);
    watchdogRef.current = window.setTimeout(() => {
      if (tileStatsRef.current.ok === 0 && statusRef.current === "loading") {
        setStatus({
          state: "error",
          kind: "layer",
          message: "IRSA has not sent any SPHEREx tiles yet. The service may be busy.",
        });
      }
    }, TILE_WATCHDOG_MS);
  }, [setStatus]);

  /** Start tracking tiles for `forFrame`. Frames that loaded before are cached by Aladin. */
  const beginFrame = useCallback(
    (forFrame: number) => {
      tileStatsRef.current = { frame: forFrame, ok: 0, failed: 0, lastStatus: 0 };
      window.clearTimeout(failureTimerRef.current);
      window.clearTimeout(watchdogRef.current);
      if (sessionRef.current?.goodFrames.has(forFrame)) {
        setStatus({ state: "ready" });
      } else {
        setStatus({ state: "loading" });
        armWatchdog();
      }
    },
    [armWatchdog, setStatus],
  );

  const handleTile = useCallback(
    (event: TileEvent) => {
      if (event.layer !== "spherex") return;
      const stats = tileStatsRef.current;
      if (event.frame !== stats.frame) return;
      const ok = event.status === 0 || (event.status >= 200 && event.status < 400);
      if (ok) {
        stats.ok += 1;
        sessionRef.current?.goodFrames.add(stats.frame);
        window.clearTimeout(failureTimerRef.current);
        window.clearTimeout(watchdogRef.current);
        if (statusRef.current !== "ready") setStatus({ state: "ready" });
        return;
      }
      stats.failed += 1;
      stats.lastStatus = event.status;
      if (stats.ok > 0) return; // a few missing tiles at the edge of coverage are fine
      window.clearTimeout(failureTimerRef.current);
      failureTimerRef.current = window.setTimeout(() => {
        const s = tileStatsRef.current;
        if (s.ok === 0 && s.failed > 0) {
          setStatus({
            state: "error",
            kind: "layer",
            message: `IRSA returned HTTP ${s.lastStatus} for the SPHEREx tiles at this wavelength.`,
          });
        }
      }, TILE_FAILURE_GRACE_MS);
    },
    [setStatus],
  );

  // Attach the long-lived instance to this mount.
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    let cancelled = false;

    setSessionSubscriber({
      onView: (raw, dragging) => {
        // Aladin's actual centre, for tests and debugging (the URL is throttled and rounded).
        mount.dataset.center = `${raw.ra.toFixed(5)},${raw.dec.toFixed(5)},${raw.fov.toFixed(4)}`;
        const next = roundView(raw);
        const recent = recentRef.current;
        recent.push({ view: next, at: performance.now() });
        if (recent.length > 64) recent.shift();
        onViewChangeRef.current?.(next, dragging);
      },
      onTile: handleTile,
      onClick: (position) => onSkyClickRef.current?.(position),
      onMove: (position) => onSkyMoveRef.current?.(position),
    });

    setStatus({ state: "loading" });
    attachSession(mount, viewRef.current)
      .then((s) => {
        if (cancelled) return;
        sessionRef.current = s;
        // Coming back to /explore: jump to the URL's view instead of where we left off.
        const target = viewRef.current;
        recentRef.current = [{ view: target, at: performance.now() }];
        s.aladin.gotoRaDec(target.ra, target.dec);
        s.aladin.setFoV(target.fov);
        emitCurrentView(s);
        setSession(s);
        onSessionChangeRef.current?.(s);
      })
      .catch((err) => {
        if (cancelled) return;
        setStatus({
          state: "error",
          kind: "viewer",
          message: `The sky viewer could not start (${errorMessage(err)}). It needs WebGL 2.`,
        });
      });

    return () => {
      cancelled = true;
      setSessionSubscriber(null);
      window.clearTimeout(failureTimerRef.current);
      window.clearTimeout(watchdogRef.current);
      // The overlay switch resets on the next visit, so the layer must go too.
      if (wiseRef.current) sessionRef.current?.aladin.removeImageLayer(ALLWISE_LAYER);
      onSessionChangeRef.current?.(null);
      sessionRef.current = null;
      cubeRef.current = null;
      wiseRef.current = null;
      detachSession(mount);
    };
  }, [handleTile, setStatus]);

  // SPHEREx layer: created on the first visit, reused on later visits, rebuilt on retry.
  const handledRetryRef = useRef(0);
  const appliedFrameRef = useRef(frame);
  useEffect(() => {
    if (!session) return;
    let stale = false;
    const rebuild = !session.cube || retryToken !== handledRetryRef.current;
    handledRetryRef.current = retryToken;
    if (rebuild) {
      cubeRef.current = setSpherexLayer(session, {
        onReady: (hips) => {
          if (stale) return;
          // The slider may have moved while the layer was loading.
          appliedFrameRef.current = frameRef.current;
          if (tileStatsRef.current.frame !== frameRef.current) beginFrame(frameRef.current);
          hips.setFrequency({ value: frameToFrequencyHz(frameRef.current), unit: "Hz" });
          hips.setOpacity(contextOpacityRef.current);
        },
        onError: (err) => {
          if (stale) return;
          setStatus({
            state: "error",
            kind: "layer",
            message: `The SPHEREx sky map did not load from IRSA (${errorMessage(err)}).`,
          });
        },
      });
    } else {
      cubeRef.current = session.cube;
      if (session.cube?.added) {
        session.cube.setFrequency({ value: frameToFrequencyHz(frameRef.current), unit: "Hz" });
      }
    }
    beginFrame(frameRef.current);
    return () => {
      stale = true;
    };
  }, [session, retryToken, beginFrame, setStatus]);

  // Wavelength frame, debounced.
  useEffect(() => {
    frameRef.current = frame;
    if (frame === appliedFrameRef.current) return;
    const timer = window.setTimeout(() => {
      const cube = cubeRef.current;
      if (!cube?.added) return;
      appliedFrameRef.current = frame;
      beginFrame(frame);
      cube.setFrequency({ value: frameToFrequencyHz(frame), unit: "Hz" });
    }, FRAME_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [frame, beginFrame]);

  // URL -> view: move the sky when the URL changes from outside (back/forward, links, edits).
  useEffect(() => {
    const s = sessionRef.current;
    if (!s || !session) return;
    const now = performance.now();
    const echo = recentRef.current.some(
      (e) => now - e.at < ECHO_WINDOW_MS && sameView(e.view, view),
    );
    if (echo) return;
    recentRef.current = [{ view, at: now }];
    s.aladin.gotoRaDec(view.ra, view.dec);
    s.aladin.setFoV(view.fov);
    emitCurrentView(s);
  }, [view, session]);

  // Context layer opacity.
  useEffect(() => {
    contextOpacityRef.current = contextOpacity;
    const cube = cubeRef.current;
    if (session && cube?.added && cube.getOpacity() !== contextOpacity) cube.setOpacity(contextOpacity);
  }, [session, contextOpacity]);

  // AllWISE W2 overlay: added on demand, removed when switched off.
  const { enabled: wiseEnabled, opacity: wiseOpacity } = allwise;
  useEffect(() => {
    if (!session) return;
    const { A, aladin } = session;
    if (wiseEnabled) {
      if (!wiseRef.current) {
        const layer = A.HiPS(ALLWISE_W2, { name: "AllWISE W2", opacity: wiseOpacity });
        wiseRef.current = aladin.setOverlayImageLayer(layer, ALLWISE_LAYER);
      }
      wiseRef.current.setOpacity(wiseOpacity);
    } else if (wiseRef.current) {
      aladin.removeImageLayer(ALLWISE_LAYER);
      wiseRef.current = null;
    }
  }, [wiseEnabled, wiseOpacity, session]);

  // Keyboard: arrows pan by 15% of the field, + and - zoom. North up, east left.
  const onKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    const s = sessionRef.current;
    if (!s || event.altKey || event.ctrlKey || event.metaKey) return;
    const [ra, dec] = s.aladin.getRaDec();
    const [fov] = s.aladin.getFov();
    const step = fov * 0.15;
    const cosDec = Math.max(Math.cos((dec * Math.PI) / 180), 0.05);
    let next: { ra: number; dec: number } | null = null;
    let nextFov: number | null = null;
    switch (event.key) {
      case "ArrowLeft":
        next = { ra: ra + step / cosDec, dec };
        break;
      case "ArrowRight":
        next = { ra: ra - step / cosDec, dec };
        break;
      case "ArrowUp":
        next = { ra, dec: Math.min(dec + step, 90) };
        break;
      case "ArrowDown":
        next = { ra, dec: Math.max(dec - step, -90) };
        break;
      case "+":
      case "=":
        nextFov = Math.max(fov / 1.25, FOV_MIN);
        break;
      case "-":
      case "_":
        nextFov = Math.min(fov * 1.25, FOV_MAX);
        break;
      default:
        return;
    }
    event.preventDefault();
    if (next) s.aladin.gotoRaDec(((next.ra % 360) + 360) % 360, next.dec);
    if (nextFov) s.aladin.setFoV(nextFov);
    emitCurrentView(s);
  }, []);

  return (
    <div
      ref={mountRef}
      data-lenis-prevent
      data-testid="sky-viewer"
      data-instances={session?.instances ?? 0}
      role="application"
      tabIndex={0}
      aria-roledescription="sky viewer"
      aria-label="SPHEREx DR1 all-sky map. Drag to pan, scroll or pinch to zoom. With the keyboard: arrow keys pan, plus and minus zoom."
      onKeyDown={onKeyDown}
      className={cn(
        "absolute inset-0 bg-ink outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent",
        className,
      )}
    />
  );
}
