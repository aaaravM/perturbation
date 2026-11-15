// What kind of object a SPHEREx quick-look spectrum looks like: the `classification` object that
// /api/spectrum/quick and the `spectrum` part of /api/object carry (model specclass-v1, a small neural
// network trained on SPHEREx spectra of catalogued stars and galaxies; docs/api-contract.md, section 2).
// Nothing here is computed in the browser: the backend classifies, this file only reads its answer.

import { useEffect, useState } from "react";
import { API_URL } from "@/lib/manifest";

export interface ClassProbability {
  key: string;
  name: string;
  p: number;
}

export interface SpectralClassification {
  status: "ok" | "none";
  /** Plain words: why there is no class (status "none"). */
  reason: string | null;
  label: string | null;
  labelText: string | null;
  /** Every class, most likely first. */
  probs: ClassProbability[];
  confidence: number | null;
  anomaly: { score: number; pValue: number; unusual: boolean } | null;
  channelsUsed: number | null;
  caveats: string[];
  model: string;
}

/** Plain names of the seven classes (the backend sends them too, as label_text, for the top class). */
export const CLASS_NAMES: Record<string, string> = {
  hot_star: "hot star",
  sunlike_star: "Sun-like star",
  cool_star: "cool star",
  brown_dwarf: "brown dwarf",
  young_dusty: "young or dusty star",
  galaxy: "galaxy",
  quasar: "quasar",
};

/**
 * The class the catalogues give a challenge target, by its kind (lib/manifest.ts), when it is one of the seven:
 * the two brown dwarfs and the young star RW Aurigae. The others (a Mira giant, bright stars) are none of them.
 */
export function catalogueClass(kind: string | undefined): string | null {
  if (kind === "brown-dwarf") return "brown_dwarf";
  if (kind === "young-variable") return "young_dusty";
  return null;
}

type Raw = Record<string, unknown>;

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function text(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

/** Read the API's `classification` object; null when it is missing or malformed (older backends). */
export function parseClassification(raw: unknown): SpectralClassification | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Raw;
  if (o.status !== "ok" && o.status !== "none") return null;
  const model = text(o.model) ?? "specclass-v1";
  if (o.status === "none") {
    return {
      status: "none",
      reason: text(o.reason) ?? "This spectrum cannot be classified.",
      label: null,
      labelText: null,
      probs: [],
      confidence: null,
      anomaly: null,
      channelsUsed: num(o.channels_used),
      caveats: [],
      model,
    };
  }
  const probsRaw = o.probs && typeof o.probs === "object" ? (o.probs as Raw) : {};
  const probs = Object.entries(probsRaw)
    .map(([key, p]) => ({ key, name: CLASS_NAMES[key] ?? key.replace(/_/g, " "), p: num(p) ?? 0 }))
    .sort((a, b) => b.p - a.p);
  const label = text(o.label);
  if (!label || probs.length === 0) return null;
  const an = o.anomaly && typeof o.anomaly === "object" ? (o.anomaly as Raw) : null;
  const score = an ? num(an.score) : null;
  const pValue = an ? num(an.p_value) : null;
  return {
    status: "ok",
    reason: null,
    label,
    labelText: text(o.label_text) ?? CLASS_NAMES[label] ?? label,
    probs,
    confidence: num(o.confidence) ?? probs[0].p,
    anomaly: score !== null && pValue !== null ? { score, pValue, unusual: Boolean(an?.unusual) } : null,
    channelsUsed: num(o.channels_used),
    caveats: Array.isArray(o.caveats) ? (o.caveats as unknown[]).filter((c): c is string => typeof c === "string") : [],
    model,
  };
}

/** "From its SPHEREx spectrum, this looks most like a cool star (82% confidence)." */
export function classSentence(c: SpectralClassification): string {
  if (c.status !== "ok" || !c.labelText) return c.reason ?? "";
  const p = c.confidence ?? 0;
  const pct = p >= 0.995 ? "over 99%" : p < 0.005 ? "<1%" : `${Math.round(p * 100)}%`;
  return `From its SPHEREx spectrum, this looks most like a ${c.labelText} (${pct} confidence).`;
}

/** A backend from before the classifier: its quick look has no `classification` field at all. */
type Unavailable = "unavailable";

const CACHE = new Map<string, SpectralClassification | null | Unavailable>();

/**
 * The classification of the quick-look spectrum at a position (needs the backend): null where the cube has
 * no data, "unavailable" when the backend does not classify yet.
 */
export async function loadClassification(
  ra: number,
  dec: number,
  signal?: AbortSignal,
): Promise<SpectralClassification | null | Unavailable> {
  if (!API_URL) throw new Error("no-backend");
  const key = `${ra.toFixed(5)},${dec.toFixed(5)}`;
  const cached = CACHE.get(key);
  if (cached !== undefined) return cached;
  const res = await fetch(`${API_URL}/api/spectrum/quick?ra=${ra.toFixed(5)}&dec=${dec.toFixed(5)}`, { signal });
  if (res.status === 404) {
    CACHE.set(key, null);
    return null;
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as Raw;
  const c = "classification" in body ? parseClassification(body.classification) : "unavailable";
  CACHE.set(key, c);
  return c;
}

export type ClassState =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "ok"; value: SpectralClassification | null }
  | { state: "error"; message: string };

/** React hook: the classification at a position; idle when there is no position, no backend or no classifier. */
export function useSpectralClass(point: { ra: number; dec: number } | null): ClassState {
  // Without a backend (a local copy without .env.local) there is nothing to ask: stay idle, show nothing.
  const key = point && API_URL ? `${point.ra.toFixed(5)},${point.dec.toFixed(5)}` : "";
  const [result, setResult] = useState<{ key: string; value: ClassState } | null>(null);
  useEffect(() => {
    if (!key) return;
    const [ra, dec] = key.split(",").map(Number);
    const ctl = new AbortController();
    loadClassification(ra, dec, ctl.signal)
      .then((value) => setResult({ key, value: value === "unavailable" ? { state: "idle" } : { state: "ok", value } }))
      .catch((e: unknown) => {
        if (ctl.signal.aborted) return;
        const message = e instanceof Error && e.message === "no-backend" ? "The live backend is not configured." : "The classifier could not be reached.";
        setResult({ key, value: { state: "error", message } });
      });
    return () => ctl.abort();
  }, [key]);
  if (!key) return { state: "idle" };
  if (!result || result.key !== key) return { state: "loading" };
  return result.value;
}
