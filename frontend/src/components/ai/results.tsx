"use client";
// The published results the AI page reads, each fetched once per page view and shared by its
// sections: the survey candidates and the mover network's metrics (/discoveries/candidates.json,
// checked by lib/discoveries.ts) and the spectral classifier's model card (/models/specclass.json,
// as How it works reads it). The same files and the same formatting as How it works, so the numbers
// cannot disagree.

import * as React from "react";
import type { Load, SpecResults } from "@/components/how-it-works/model-results";
import { DISCOVERIES_URL, parseDiscoveries, type Discoveries } from "@/lib/discoveries";

export const SPEC_CARD_URL = "/models/specclass.json";

const shared = new Map<string, Promise<unknown>>();

function fetchOnce<T>(url: string, parse: (raw: unknown) => T): Promise<T> {
  let p = shared.get(url) as Promise<T> | undefined;
  if (!p) {
    p = fetch(url, { cache: "no-cache" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then(parse);
    // A failed read is not kept: the next visit to the page tries again.
    p.catch(() => shared.delete(url));
    shared.set(url, p);
  }
  return p;
}

function useShared<T>(url: string, parse: (raw: unknown) => T): Load<T> {
  const [load, setLoad] = React.useState<Load<T>>({ state: "loading" });
  React.useEffect(() => {
    let alive = true;
    fetchOnce(url, parse)
      .then((data) => alive && setLoad({ state: "ok", data }))
      .catch(() => alive && setLoad({ state: "missing" }));
    return () => {
      alive = false;
    };
  }, [url, parse]);
  return load;
}

/** specclass.json as How it works reads it, plus its description and the long name of each kind. */
export interface SpecCard extends Omit<SpecResults, "classes"> {
  description?: string;
  classes?: { key: string; name: string; long?: string }[];
}

const asSpec = (raw: unknown) => raw as SpecCard;

/** The survey's candidate list and the mover network's metrics. */
export function useCandidates(): Load<Discoveries> {
  return useShared(DISCOVERIES_URL, parseDiscoveries);
}

/** The spectral classifier's model card. */
export function useSpecCard(): Load<SpecCard> {
  return useShared(SPEC_CARD_URL, asSpec);
}

/** A plain line while a file loads, or when it is not published. */
export function Pending({ load, what }: { load: Load<unknown>; what: string }) {
  return (
    <p className="text-ui text-fg-faint" role="status">
      {load.state === "loading" ? `Reading the ${what}…` : `The ${what} could not be read on this site just now.`}
    </p>
  );
}
