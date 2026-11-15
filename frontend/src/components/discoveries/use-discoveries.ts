"use client";
// Loads the Discoveries list once per page view. A missing file (404) is not an error: the automatic
// search has not published a list yet, and the pages say so.

import * as React from "react";
import { DISCOVERIES_URL, parseDiscoveries, type Discoveries } from "@/lib/discoveries";

export type DiscoveriesState =
  | { status: "loading" }
  | { status: "ready"; data: Discoveries }
  | { status: "missing" }
  | { status: "error"; message: string };

export function useDiscoveries(): DiscoveriesState & { retry: () => void } {
  const [state, setState] = React.useState<DiscoveriesState>({ status: "loading" });
  const [attempt, setAttempt] = React.useState(0);

  React.useEffect(() => {
    const ctrl = new AbortController();
    (async () => {
      try {
        const res = await fetch(DISCOVERIES_URL, { cache: "no-cache", signal: ctrl.signal });
        if (res.status === 404) {
          setState({ status: "missing" });
          return;
        }
        if (!res.ok) throw new Error(`The list answered ${res.status}.`);
        setState({ status: "ready", data: parseDiscoveries(await res.json()) });
      } catch (err) {
        if (ctrl.signal.aborted) return;
        setState({ status: "error", message: err instanceof Error ? err.message : "The list could not be read." });
      }
    })();
    return () => ctrl.abort();
  }, [attempt]);

  const retry = React.useCallback(() => {
    setState({ status: "loading" });
    setAttempt((n) => n + 1);
  }, []);

  return { ...state, retry };
}
