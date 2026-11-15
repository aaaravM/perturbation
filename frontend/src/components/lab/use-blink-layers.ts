"use client";
// Blink frames as Aladin image overlays. Each frame PNG is fetched first (progress, and a failed
// fetch can never trigger Aladin's own retry through the CDS proxy), turned into a blob URL,
// added with A.image(url, { imgFormat: "png", wcs }) at opacity 0, and then only the current
// frame is made visible. Layers are cached per manifest, so switching mode or detector back and
// forth is instant. Difference images are recoloured to a dark-centred diverging map first.

import { useEffect, useRef, useState } from "react";
import type { AladinWcs } from "@/lib/manifest";
import type { BlinkFrame } from "@/lib/lab-field";
import type { AladinSession } from "@/components/sky/aladin-session";
import { extra, type ImageLayer } from "@/components/sky/aladin-extra";
import { divergingColor } from "@/components/lab/diverging";

interface LayerEntry {
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
}

async function recolourDiverging(blob: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return blob;
  ctx.drawImage(bitmap, 0, 0);
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const px = image.data;
  for (let i = 0; i < px.length; i += 4) {
    const [r, g, b] = divergingColor((px[i] - 127.5) / 127.5);
    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = b;
    px[i + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  bitmap.close?.();
  return new Promise((resolve) => canvas.toBlob((out) => resolve(out ?? blob), "image/png"));
}

let layerSerial = 0;

export function useBlinkLayers({
  session,
  manifestKey,
  wcs,
  frames,
  current,
  visible,
  showFlags,
}: {
  session: AladinSession | null;
  /** Changes when a different manifest is loaded; all cached layers are dropped then. */
  manifestKey: string | null;
  wcs: AladinWcs | null;
  frames: BlinkFrame[];
  current: number;
  visible: boolean;
  showFlags: boolean;
}): BlinkLayerStatus {
  const cacheRef = useRef(new Map<string, LayerEntry>());
  /** Snapshot of each cached layer's state, so render never reads the ref. */
  const [states, setStates] = useState<Record<string, LayerEntry["state"]>>({});
  const bump = () =>
    setStates(Object.fromEntries([...cacheRef.current].map(([key, entry]) => [key, entry.state])));

  // Drop every layer when the manifest or the session changes, and on unmount.
  useEffect(() => {
    const cache = cacheRef.current;
    return () => {
      for (const entry of cache.values()) {
        entry.disposed = true;
        if (session) extra(session).aladin.removeImageLayer(entry.name);
        if (entry.objectUrl) URL.revokeObjectURL(entry.objectUrl);
      }
      cache.clear();
      setStates({});
    };
  }, [session, manifestKey]);

  // Load what the current frame list needs (frames first, then their flags, so flags stack above).
  const flagUrls = showFlags ? frames.map((f) => f.flags?.url).filter((u): u is string => Boolean(u)) : [];
  const wanted = [
    ...frames.map((f) => ({ key: f.key, url: f.url, diverging: Boolean(f.diverging) })),
    ...flagUrls.map((url) => ({ key: `flags|${url}`, url, diverging: false })),
  ];
  const wantedSignature = wanted.map((w) => w.key).join("\n");

  useEffect(() => {
    if (!session || !wcs || !manifestKey) return;
    const { A, aladin } = extra(session);
    const cache = cacheRef.current;
    const todo = wantedSignature
      .split("\n")
      .filter(Boolean)
      .filter((key) => !cache.has(key));
    if (todo.length === 0) return;
    const byKey = new Map(wanted.map((w) => [w.key, w]));
    const entries = todo.map((key) => {
      const entry: LayerEntry = {
        name: `lab-blink-${++layerSerial}`,
        objectUrl: null,
        layer: null,
        state: "loading",
        disposed: false,
      };
      cache.set(key, entry);
      return { key, entry, spec: byKey.get(key)! };
    });
    bump();

    void (async () => {
      // Fetch in parallel, add to Aladin in list order (frames before flags).
      const blobs = await Promise.all(
        entries.map(async ({ spec }) => {
          try {
            const res = await fetch(spec.url);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const blob = await res.blob();
            return spec.diverging ? await recolourDiverging(blob) : blob;
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

  // Visibility: only the current frame (and its flags) is shown.
  const currentKey = frames[current]?.key ?? null;
  const currentFlagsKey = showFlags && frames[current]?.flags ? `flags|${frames[current].flags!.url}` : null;
  useEffect(() => {
    for (const [key, entry] of cacheRef.current) {
      if (entry.state !== "ready" || !entry.layer) continue;
      let opacity = 0;
      if (visible && key === currentKey) opacity = 1;
      if (visible && key === currentFlagsKey) opacity = 0.9;
      if (entry.layer.getOpacity() !== opacity) entry.layer.setOpacity(opacity);
    }
  }, [currentKey, currentFlagsKey, visible, states]);

  const frameStates = frames.map((f) => states[f.key]);
  const loaded = frameStates.filter((s) => s === "ready").length;
  const failed = frameStates.filter((s) => s === "error").length;
  return {
    loaded,
    total: frames.length,
    ready: frames.length > 0 && loaded + failed === frames.length && loaded > 0,
    failed,
  };
}
