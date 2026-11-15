"use client";
// Blink frames as Aladin image overlays. Each frame PNG is fetched first (progress, and a failed
// fetch can never trigger Aladin's own retry through the CDS proxy), decoded once (its pixels feed
// the histogram, the status-bar readout and the aperture tool), passed through the display
// settings (cuts, stretch, colour map), turned into a blob URL and added with
// A.image(url, { imgFormat: "png", wcs }) at opacity 0. Only the current frame is visible, with a
// hard cut or a short crossfade. Layers are cached per manifest and display setting, so switching
// mode or detector back and forth is instant. Difference images are recoloured to a dark-centred
// diverging map and are never re-stretched.

import { useCallback, useEffect, useRef, useState } from "react";
import type { AladinWcs } from "@/lib/manifest";
import type { BlinkFrame } from "@/lib/lab-field";
import type { AladinSession } from "@/components/sky/aladin-session";
import { extra, type ImageLayer } from "@/components/sky/aladin-extra";
import { divergingColor } from "@/components/lab/diverging";
import {
  applyDisplay,
  decodePng,
  displaySignature,
  encodePng,
  isDefaultDisplay,
  type DisplaySettings,
} from "@/components/lab/display";

interface LayerEntry {
  frameKey: string;
  sig: string;
  name: string;
  objectUrl: string | null;
  layer: ImageLayer | null;
  state: "loading" | "ready" | "error";
  disposed: boolean;
}

export interface BlinkLayerStatus {
  /** Frames of the current list that are ready to show. */
  loaded: number;
  total: number;
  ready: boolean;
  failed: number;
  /** Decoded pixels of a frame (as published, before display settings), once loaded. */
  raw: (frameKey: string) => ImageData | null;
  /** Blob URL of the frame as displayed, once loaded (for the compare view and PNG export). */
  displayUrl: (frameKey: string) => string | null;
  /** Bumps whenever decoded pixels arrive. */
  rawVersion: number;
}

function recolourDiverging(image: ImageData): ImageData {
  const out = new ImageData(image.width, image.height);
  const px = image.data;
  const dst = out.data;
  for (let i = 0; i < px.length; i += 4) {
    const [r, g, b] = divergingColor((px[i] - 127.5) / 127.5);
    dst[i] = r;
    dst[i + 1] = g;
    dst[i + 2] = b;
    dst[i + 3] = 255;
  }
  return out;
}

let layerSerial = 0;

/** Remove the layers made for an earlier display setting. True when any were removed. */
function disposeStale(cache: Map<string, LayerEntry>, sig: string, session: AladinSession): boolean {
  const { aladin } = extra(session);
  let changed = false;
  for (const [key, entry] of cache) {
    if (entry.frameKey.startsWith("flags|") || entry.sig === "raw" || entry.sig === sig) continue;
    entry.disposed = true;
    aladin.removeImageLayer(entry.name);
    if (entry.objectUrl) URL.revokeObjectURL(entry.objectUrl);
    cache.delete(key);
    changed = true;
  }
  return changed;
}

export function useBlinkLayers({
  session,
  manifestKey,
  wcs,
  frames,
  current,
  visible,
  showFlags,
  display,
  crossfadeMs,
  opacity,
  hidden,
}: {
  session: AladinSession | null;
  /** Changes when a different manifest is loaded; all cached layers are dropped then. */
  manifestKey: string | null;
  wcs: AladinWcs | null;
  frames: BlinkFrame[];
  current: number;
  visible: boolean;
  showFlags: boolean;
  display: DisplaySettings;
  /** 0 for a hard blink; otherwise the length of the crossfade between frames. */
  crossfadeMs: number;
  /** Opacity of the SPHEREx frames layer (0-1). */
  opacity: number;
  /** Hide every frame (the compare view draws them itself). */
  hidden: boolean;
}): BlinkLayerStatus {
  const cacheRef = useRef(new Map<string, LayerEntry>());
  const rawRef = useRef(new Map<string, ImageData>());
  const blobRef = useRef(new Map<string, Blob>());
  /** Snapshot of each cached layer's state, so render never reads the ref. */
  const [states, setStates] = useState<Record<string, LayerEntry["state"]>>({});
  const [rawVersion, setRawVersion] = useState(0);
  const bump = () =>
    setStates(Object.fromEntries([...cacheRef.current].map(([key, entry]) => [key, entry.state])));

  // Drop every layer when the manifest or the session changes, and on unmount.
  useEffect(() => {
    const cache = cacheRef.current;
    const raw = rawRef.current;
    const blobs = blobRef.current;
    return () => {
      for (const entry of cache.values()) {
        entry.disposed = true;
        if (session) extra(session).aladin.removeImageLayer(entry.name);
        if (entry.objectUrl) URL.revokeObjectURL(entry.objectUrl);
      }
      cache.clear();
      raw.clear();
      blobs.clear();
      setStates({});
    };
  }, [session, manifestKey]);

  const sig = displaySignature(display);
  // Load what the current frame list needs (frames first, then their flags, so flags stack above).
  const flagUrls = showFlags ? frames.map((f) => f.flags?.url).filter((u): u is string => Boolean(u)) : [];
  const wanted = [
    ...frames.map((f) => ({ frameKey: f.key, url: f.url, diverging: Boolean(f.diverging), sig: f.diverging ? "raw" : sig })),
    ...flagUrls.map((url) => ({ frameKey: `flags|${url}`, url, diverging: false, sig: "raw" })),
  ];
  const wantedSignature = wanted.map((w) => `${w.frameKey}#${w.sig}`).join("\n");
  const displayRef = useRef(display);
  useEffect(() => {
    displayRef.current = display;
  });

  useEffect(() => {
    if (!session || !wcs || !manifestKey) return;
    const { A, aladin } = extra(session);
    const cache = cacheRef.current;
    const specs = wantedSignature
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [frameKey, s] = [line.slice(0, line.lastIndexOf("#")), line.slice(line.lastIndexOf("#") + 1)];
        const w = wanted.find((x) => x.frameKey === frameKey)!;
        return { key: `${frameKey}#${s}`, frameKey, url: w.url, diverging: w.diverging, sig: s };
      })
      .filter((spec) => !cache.has(spec.key));
    if (specs.length === 0) return;
    const entries = specs.map((spec) => {
      const entry: LayerEntry = {
        frameKey: spec.frameKey,
        sig: spec.sig,
        name: `lab-blink-${++layerSerial}`,
        objectUrl: null,
        layer: null,
        state: "loading",
        disposed: false,
      };
      cache.set(spec.key, entry);
      return { entry, spec };
    });
    bump();
    const settings = displayRef.current;

    void (async () => {
      // Fetch and decode in parallel, add to Aladin in list order (frames before flags).
      const blobs = await Promise.all(
        entries.map(async ({ spec }) => {
          try {
            let blob = blobRef.current.get(spec.url) ?? null;
            if (!blob) {
              const res = await fetch(spec.url);
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
              blob = await res.blob();
              blobRef.current.set(spec.url, blob);
            }
            let raw = rawRef.current.get(spec.frameKey) ?? null;
            if (!raw) {
              raw = await decodePng(blob);
              if (raw) {
                rawRef.current.set(spec.frameKey, raw);
                setRawVersion((v) => v + 1);
              }
            }
            if (spec.diverging) {
              if (!raw) return blob;
              return (await encodePng(recolourDiverging(raw))) ?? blob;
            }
            if (spec.sig === "raw" || isDefaultDisplay(settings) || !raw) return blob;
            return (await encodePng(applyDisplay(raw, settings))) ?? blob;
          } catch {
            return null;
          }
        }),
      );
      entries.forEach(({ entry }, i) => {
        const blob = blobs[i];
        if (entry.disposed) return;
        if (!blob) {
          entry.state = "error";
          bump();
          return;
        }
        entry.objectUrl = URL.createObjectURL(blob);
        const image = A.image(entry.objectUrl, {
          name: entry.name,
          imgFormat: "png",
          // Aladin's WCS parser requires NAXIS, which the manifest grid does not carry.
          wcs: { NAXIS: 2, ...wcs },
          opacity: 0,
          successCallback: () => {
            if (entry.disposed) {
              aladin.removeImageLayer(entry.name);
              return;
            }
            entry.state = "ready";
            bump();
          },
          errorCallback: () => {
            entry.state = "error";
            bump();
          },
        });
        entry.layer = image;
        aladin.setOverlayImageLayer(image, entry.name);
      });
    })();
    // `wanted` is derived from the signature.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, wcs, manifestKey, wantedSignature]);

  /** The entry to show for a frame: the current display setting when ready, else any ready one. */
  const pick = useCallback(
    (frameKey: string, wantSig: string): LayerEntry | null => {
      let fallback: LayerEntry | null = null;
      for (const entry of cacheRef.current.values()) {
        if (entry.frameKey !== frameKey || entry.state !== "ready" || !entry.layer) continue;
        if (entry.sig === wantSig) return entry;
        fallback = entry;
      }
      return fallback;
    },
    [],
  );

  // Once every frame has its layer for the current display setting, drop the stale ones.
  const frameSig = (f: BlinkFrame) => (f.diverging ? "raw" : sig);
  const allCurrent = frames.length > 0 && frames.every((f) => states[`${f.key}#${frameSig(f)}`] === "ready" || states[`${f.key}#${frameSig(f)}`] === "error");
  useEffect(() => {
    if (!allCurrent || !session) return;
    if (disposeStale(cacheRef.current, sig, session)) bump();
  }, [allCurrent, sig, session]);

  // Visibility: only the current frame (and its flags) is shown, with an optional crossfade.
  const currentFrame = frames[current] ?? null;
  const currentKey = currentFrame?.key ?? null;
  const currentFlagsKey = showFlags && currentFrame?.flags ? `flags|${currentFrame.flags.url}` : null;
  const shownRef = useRef<LayerEntry | null>(null);
  const tweenRef = useRef<number | null>(null);
  useEffect(() => {
    if (tweenRef.current !== null) cancelAnimationFrame(tweenRef.current);
    tweenRef.current = null;
    const show = visible && !hidden;
    const target = show && currentKey && currentFrame ? pick(currentKey, frameSig(currentFrame)) : null;
    const flagsEntry = show && currentFlagsKey ? pick(currentFlagsKey, "raw") : null;
    const previous = shownRef.current;
    const fade = crossfadeMs > 0 && previous && target && previous !== target && previous.layer && !previous.disposed;
    for (const entry of cacheRef.current.values()) {
      if (entry.state !== "ready" || !entry.layer) continue;
      let o = 0;
      if (entry === target) o = fade ? 0 : opacity;
      if (entry === flagsEntry) o = 0.9;
      if (fade && entry === previous) o = opacity;
      if (entry.layer.getOpacity() !== o) entry.layer.setOpacity(o);
    }
    shownRef.current = target;
    if (fade && target?.layer && previous?.layer) {
      const start = performance.now();
      const from = previous.layer;
      const to = target.layer;
      const step = (now: number) => {
        const t = Math.min(1, (now - start) / crossfadeMs);
        const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
        to.setOpacity(opacity * e);
        if (!previous.disposed) from.setOpacity(opacity * (1 - e));
        if (t < 1) tweenRef.current = requestAnimationFrame(step);
        else tweenRef.current = null;
      };
      tweenRef.current = requestAnimationFrame(step);
    }
    // `frameSig` and `currentFrame` follow currentKey and sig.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentKey, currentFlagsKey, visible, hidden, states, opacity, crossfadeMs, sig, pick]);

  useEffect(
    () => () => {
      if (tweenRef.current !== null) cancelAnimationFrame(tweenRef.current);
    },
    [],
  );

  const raw = useCallback((frameKey: string) => rawRef.current.get(frameKey) ?? null, []);
  const displayUrl = useCallback(
    (frameKey: string) => {
      const f = frames.find((x) => x.key === frameKey);
      return (f ? pick(frameKey, f.diverging ? "raw" : sig) : null)?.objectUrl ?? null;
    },
    [frames, pick, sig],
  );

  const frameStates = frames.map((f) => {
    const s = states[`${f.key}#${frameSig(f)}`];
    if (s === "ready" || s === "error") return s;
    // A frame shown with an older display setting still counts as loaded.
    return Object.entries(states).some(([k, v]) => k.startsWith(`${f.key}#`) && v === "ready") ? "ready" : s;
  });
  const loaded = frameStates.filter((s) => s === "ready").length;
  const failed = frameStates.filter((s) => s === "error").length;
  return {
    loaded,
    total: frames.length,
    ready: frames.length > 0 && loaded + failed === frames.length && loaded > 0,
    failed,
    raw,
    displayUrl,
    rawVersion,
  };
}
