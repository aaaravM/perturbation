// One long-lived Aladin Lite instance per page load. Aladin 3.8.2 has no destroy() or off(),
// so creating a new instance on every visit to /explore would leak a WebGL context, a render
// loop and its listeners. Instead the instance lives in a detached <div> that is moved into
// whichever React mount point is current, and moved out (kept alive) on unmount. Its event
// listeners are registered once and forward to the current subscriber.
//
// Explicit IRSA URLs only (CDS is degraded): `survey: []` and `hipsList: []` stop Aladin from
// loading its CDS defaults; `log: false` disables its usage ping. No HiPS IDs, no VizieR/Simbad
// helpers, no gotoObject, no Simbad pointer.

import type { Aladin, AladinOptions, HiPS } from "aladin-lite";
import { SPHEREX_CUBE, SPHEREX_TILE_RE } from "@/lib/spherex";

type AladinStatic = (typeof import("aladin-lite"))["default"];

export interface SkyView {
  ra: number;
  dec: number;
  fov: number;
}

export interface TileEvent {
  layer: "spherex" | "allwise";
  /** Cube frame from the tile name (SPHEREx only); frame 0 has no suffix. */
  frame: number | null;
  /** HTTP status from Resource Timing; 0 when the browser could not tell. */
  status: number;
  url: string;
}

export interface SessionSubscriber {
  onView?: (view: SkyView, dragging: boolean) => void;
  onTile?: (event: TileEvent) => void;
  /** A click (not the end of a drag) on the sky, in ICRS degrees. */
  onClick?: (position: { ra: number; dec: number }) => void;
}

export interface AladinSession {
  A: AladinStatic;
  aladin: Aladin;
  host: HTMLDivElement;
  /** How many Aladin instances this page load has created (should stay 1). */
  instances: number;
  /** The SPHEREx base layer, kept across mounts. */
  cube: HiPS | null;
  /** Frames whose tiles have loaded at least once (Aladin keeps them cached). */
  goodFrames: Set<number>;
}

const BASE_OPTIONS: AladinOptions = {
  survey: [],
  hipsList: [],
  log: false,
  samp: false,
  mode: "dark",
  backgroundColor: "rgb(5,5,5)",
  projection: "TAN",
  cooFrame: "ICRSd",
  showReticle: false,
  showZoomControl: false,
  showLayersControl: false,
  showFullscreenControl: false,
  showSimbadPointerControl: false,
  showCooGridControl: false,
  showSettingsControl: false,
  showShareControl: false,
  showColorPickerControl: false,
  showFrame: false,
  showFov: false,
  showCooLocation: false,
  showProjectionControl: false,
  showStatusBar: false,
  showContextMenu: false,
};

const ALLWISE_PATH = "/data/hips/CDS/AllWISE/W2/";

let sessionPromise: Promise<AladinSession> | null = null;
let subscriber: SessionSubscriber | null = null;
let instances = 0;

export function setSessionSubscriber(next: SessionSubscriber | null) {
  subscriber = next;
}

function readView(aladin: Aladin): SkyView | null {
  const [ra, dec] = aladin.getRaDec();
  const [fov] = aladin.getFov();
  return [ra, dec, fov].every(Number.isFinite) ? { ra, dec, fov } : null;
}

export function emitCurrentView(session: AladinSession, dragging = false) {
  const view = readView(session.aladin);
  if (view) subscriber?.onView?.(view, dragging);
}

/** Resource Timing exposes the HTTP status of Aladin's tile fetches (IRSA sends CORS headers). */
function observeTiles() {
  if (typeof PerformanceObserver === "undefined") return;
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries() as PerformanceResourceTiming[]) {
      const url = entry.name;
      const match = SPHEREX_TILE_RE.exec(url);
      const status = typeof entry.responseStatus === "number" ? entry.responseStatus : 0;
      if (match) {
        subscriber?.onTile?.({
          layer: "spherex",
          frame: match[1] === undefined ? 0 : Number(match[1]),
          status,
          url,
        });
      } else if (url.includes(ALLWISE_PATH) && /\/Npix\d+\./.test(url)) {
        subscriber?.onTile?.({ layer: "allwise", frame: null, status, url });
      }
    }
  });
  try {
    observer.observe({ type: "resource", buffered: false });
  } catch {
    // Very old browsers: no tile health reporting, the watchdog still applies.
  }
  performance.setResourceTimingBufferSize?.(2000);
}

/**
 * Get (or create) the session and attach its host to `mount`. The host is moved, never
 * recreated, so the WebGL context and listeners survive navigation.
 */
export function attachSession(mount: HTMLElement, initialView: SkyView): Promise<AladinSession> {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const A = (await import("aladin-lite")).default;
      await A.init; // a Promise in 3.8.2, not a function
      const host = document.createElement("div");
      host.className = "aladin-host";
      host.setAttribute("aria-hidden", "true");
      host.style.width = "100%";
      host.style.height = "100%";
      // Aladin measures its container on creation, so create it in the live mount point.
      mount.appendChild(host);
      const { ra, dec, fov } = initialView;
      const aladin = A.aladin(host, { ...BASE_OPTIONS, target: `${ra} ${dec}`, fov });
      instances += 1;
      const session: AladinSession = {
        A,
        aladin,
        host,
        instances,
        cube: null,
        goodFrames: new Set(),
      };
      aladin.on("positionChanged", (event) => {
        const view = readView(aladin);
        if (view) subscriber?.onView?.(view, Boolean(event?.dragging));
      });
      aladin.on("zoomChanged", () => emitCurrentView(session));
      // Aladin keeps one callback per event, so register once and forward to the subscriber.
      aladin.on("click", ((event: { ra: number; dec: number; isDragging?: boolean }) => {
        if (event?.isDragging || !Number.isFinite(event?.ra) || !Number.isFinite(event?.dec)) return;
        subscriber?.onClick?.({ ra: event.ra, dec: event.dec });
      }) as never);
      observeTiles();
      return session;
    })().catch((err) => {
      sessionPromise = null; // allow a retry
      throw err;
    });
    return sessionPromise;
  }
  return sessionPromise.then((session) => {
    if (session.host.parentElement !== mount) mount.appendChild(session.host);
    return session;
  });
}

/** Detach the host from `mount` (keeping the instance alive for the next visit). */
export function detachSession(mount: HTMLElement) {
  void sessionPromise?.then((session) => {
    if (session.host.parentElement === mount) mount.removeChild(session.host);
  });
}

/** Create the SPHEREx cube layer and make it the base layer (also used by "Try again"). */
export function setSpherexLayer(
  session: AladinSession,
  callbacks: { onReady: (hips: HiPS) => void; onError: (err: unknown) => void },
): HiPS {
  const cube = session.A.HiPS(SPHEREX_CUBE, {
    name: "SPHEREx DR1",
    successCallback: callbacks.onReady,
    errorCallback: callbacks.onError,
  });
  session.aladin.setBaseImageLayer(cube);
  session.cube = cube;
  session.goodFrames.clear();
  return cube;
}
