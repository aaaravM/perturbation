"use client";
// The pointer over the sky, kept outside React state so a mouse move re-renders only the few
// readouts that subscribe to it (status bar, hover label), never the whole workbench.

import { useSyncExternalStore } from "react";

export interface SkyCursor {
  ra: number;
  dec: number;
  /** Canvas pixels inside the viewer. */
  x: number;
  y: number;
}

type Listener = () => void;

export function createCursorStore() {
  let value: SkyCursor | null = null;
  let frame: number | null = null;
  let pending: SkyCursor | null | undefined;
  const listeners = new Set<Listener>();
  const flush = () => {
    frame = null;
    if (pending === undefined) return;
    value = pending;
    pending = undefined;
    for (const l of listeners) l();
  };
  return {
    get: () => value,
    /** Coalesced to one update per animation frame. */
    set(next: SkyCursor | null) {
      pending = next;
      if (frame === null && typeof window !== "undefined") frame = window.requestAnimationFrame(flush);
    },
    subscribe(listener: Listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export type CursorStore = ReturnType<typeof createCursorStore>;

export function useCursor(store: CursorStore): SkyCursor | null {
  return useSyncExternalStore(store.subscribe, store.get, () => null);
}
