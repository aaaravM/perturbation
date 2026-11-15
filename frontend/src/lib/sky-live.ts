"use client";
// Live data for the Sky panels, from the Perturbation API (NEXT_PUBLIC_API_URL).
//
// A star asks /api/object (with its HIP number and proper motion, so Gaia and SIMBAD find the
// right source); a spot of empty sky asks /api/patch. Each answer comes in parts (sky, gaia,
// simbad, spherex, spectrum, and for a patch stars_count and brightest), each with a status and
// its source. If the service does not have those endpoints, or a part fails, the same facts are
// put together from the endpoints it already has: Gaia DR3 sources (/api/catalog/gaia), SPHEREx
// coverage (/api/field/summary) and the DR1 quick-look spectrum (/api/spectrum/quick). Nothing is
// ever made up: a part that cannot be fetched says so.

import { useEffect, useState } from "react";
import { API_URL } from "@/lib/manifest";
import { parseClassification, type SpectralClassification } from "@/lib/spectral-class";

/**
 * The API base. Production builds use NEXT_PUBLIC_API_URL only; a development build may also
 * take one from localStorage ("pxh:api"), so a local page can be pointed at the live service.
 */
export function apiBase(): string {
  if (API_URL) return API_URL;
  if (process.env.NODE_ENV !== "production" && typeof window !== "undefined") {
    try {
      return (window.localStorage.getItem("pxh:api") ?? "").replace(/\/$/, "");
    } catch {
      return "";
    }
  }
  return "";
}

export type Live<T> =
  | { state: "off" }
  | { state: "loading" }
  | { state: "ok"; value: T }
  | { state: "none"; message: string }
  | { state: "error"; message: string };

export interface GaiaMatch {
  sourceId: string;
  g: number | null;
  bpRp: number | null;
  parallax: number | null;
  parallaxError: number | null;
  distanceLy: number | null;
  pmra: number | null;
  pmdec: number | null;
  rv: number | null;
  teff: number | null;
  ruwe: number | null;
  hint: string | null;
  sepArcsec: number | null;
  url: string | null;
}

export interface SimbadInfo {
  id: string;
  name: string | null;
  type: string | null;
  typeLabel: string | null;
  spType: string | null;
  url: string | null;
}

export interface SkyInfo {
  constellation: string | null;
  constellationName: string | null;
  where: string[];
}

export interface CoverageEpoch {
  label: string;
  start: string | null;
  end: string | null;
  survey: string | null;
  full: boolean;
}

export interface Coverage {
  nImages: number;
  nExposures: number | null;
  epochs: CoverageEpoch[];
  deepField: boolean;
  collections: string[];
}

export interface QuickSpectrum {
  wl: number[];
  flux: (number | null)[];
  err: (number | null)[];
  label: string;
  pixelArcsec: number | null;
  /** What kind of object the spectrum looks like (backend classifier); null from older backends. */
  classification: SpectralClassification | null;
}

export interface StarsCount {
  count: number;
  method: string;
  gLimit: number | null;
  radiusArcmin: number | null;
  densityPerDeg2: number | null;
  message: string | null;
}

export interface BrightSource {
  sourceId: string;
  name: string | null;
  g: number | null;
  sepArcmin: number | null;
  distanceLy: number | null;
  typeLabel: string | null;
}

export interface Brightest {
  stars: BrightSource[];
  gLimit: number | null;
}

const cache = new Map<string, Promise<unknown>>();

class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const url = `${apiBase()}${path}`;
  let p = cache.get(url) as Promise<T> | undefined;
  if (!p) {
    p = fetch(url).then(async (res) => {
      if (!res.ok) {
        let code = "";
        let message = `HTTP ${res.status}`;
        try {
          const j = (await res.json()) as { error?: string; message?: string };
          code = j.error ?? "";
          message = j.message ?? message;
        } catch {
          // not JSON
        }
        throw new HttpError(res.status, code, message);
      }
      return res.json() as Promise<T>;
    });
    cache.set(url, p);
    // Failed and partial answers are not kept, so asking again tries again.
    p.then(
      (j) => {
        if ((j as { complete?: boolean })?.complete === false) cache.delete(url);
      },
      () => cache.delete(url),
    );
  }
  if (!signal) return p;
  return new Promise<T>((resolve, reject) => {
    signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    p!.then(resolve, reject);
  });
}

type Raw = Record<string, unknown>;
const fin = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : (v as number);
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const r5 = (v: number) => v.toFixed(5);
const obj = (v: unknown): Raw | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Raw) : null);

/** A part of an /api/object or /api/patch answer: ok, or why not. */
function partOf(raw: unknown): { ok: Raw } | { not: Live<never> } | null {
  const o = obj(raw);
  if (!o) return null;
  const status = str(o.status);
  if (!status || status === "ok") return { ok: o };
  if (status === "none") return { not: { state: "none", message: str(o.message) ?? "" } };
  return { not: { state: "error", message: str(o.message) ?? "The service did not answer in time." } };
}

// --------------------------------------------------------------------------------- parsers

function parseGaia(o: Raw | null, sep?: number | null): GaiaMatch | null {
  if (!o) return null;
  const id = str(o.source_id) ?? (typeof o.source_id === "number" ? String(o.source_id) : null);
  if (!id) return null;
  return {
    sourceId: id,
    g: fin(o.g ?? o.phot_g_mean_mag),
    bpRp: fin(o.bp_rp),
    parallax: fin(o.parallax),
    parallaxError: fin(o.parallax_error),
    distanceLy: fin(o.distance_ly),
    pmra: fin(o.pmra),
    pmdec: fin(o.pmdec),
    rv: fin(o.radial_velocity ?? o.rv),
    teff: fin(o.teff_gspphot ?? o.teff),
    ruwe: fin(o.ruwe),
    hint: str(o.hint),
    sepArcsec: fin(o.separation_arcsec ?? o.sep_arcsec) ?? sep ?? null,
    url: str(o.url),
  };
}

function parseSimbad(o: Raw | null): SimbadInfo | null {
  if (!o) return null;
  const id = str(o.main_id ?? o.id ?? o.name);
  if (!id) return null;
  return {
    id,
    name: str(o.name),
    type: str(o.otype ?? o.type),
    typeLabel: str(o.otype_label ?? o.type_label),
    spType: str(o.sp_type ?? o.sptype),
    url: str(o.url),
  };
}

function parseSky(o: Raw | null): SkyInfo | null {
  if (!o) return null;
  const where = Array.isArray(o.where)
    ? (o.where as unknown[]).filter((w): w is string => typeof w === "string" && !!w.trim())
    : typeof o.where === "string"
      ? [o.where]
      : [];
  const constellation = str(o.constellation);
  const constellationName = str(o.constellation_name);
  if (!constellation && !constellationName && !where.length) return null;
  return { constellation, constellationName, where };
}

function parseCoverage(o: Raw | null): Coverage | null {
  if (!o) return null;
  const epochsRaw = Array.isArray(o.epochs) ? (o.epochs as Raw[]) : [];
  const nImages = fin(o.n_images) ?? epochsRaw.length;
  return {
    nImages,
    nExposures: fin(o.n_exposures),
    epochs: epochsRaw.map((e) => ({
      label: str(e.label) ?? "",
      start: str(e.start),
      end: str(e.end),
      survey: str(e.survey),
      full: e.full !== false,
    })),
    deepField: o.deep_field === true,
    collections: Array.isArray(o.collections)
      ? (o.collections as unknown[]).filter((c): c is string => typeof c === "string")
      : [],
  };
}

function parseSpectrum(o: Raw | null): QuickSpectrum | null {
  if (!o || !Array.isArray(o.wl_um) || !Array.isArray(o.flux_ujy)) return null;
  const wl = (o.wl_um as unknown[]).map((v) => fin(v) ?? Number.NaN);
  const flux = (o.flux_ujy as unknown[]).map(fin);
  const err = Array.isArray(o.err_ujy) ? (o.err_ujy as unknown[]).map(fin) : flux.map(() => null);
  if (!flux.some((f) => f !== null)) return null;
  return {
    wl,
    flux,
    err,
    label: str(o.label) ?? "SPHEREx DR1 quick-look spectrum",
    pixelArcsec: fin(o.pixel_arcsec),
    classification: parseClassification(o.classification),
  };
}

function parseStarsCount(o: Raw | null): StarsCount | null {
  const count = o ? fin(o.count) : null;
  if (!o || count === null) return null;
  return {
    count,
    method: str(o.method) ?? "exact",
    gLimit: fin(o.g_limit),
    radiusArcmin: fin(o.radius_arcmin),
    densityPerDeg2: fin(o.density_per_deg2),
    message: str(o.message),
  };
}

function parseBrightest(o: Raw | null): Brightest | null {
  if (!o || !Array.isArray(o.stars)) return null;
  const stars = (o.stars as Raw[])
    .map((s) => ({
      sourceId: str(s.source_id) ?? (typeof s.source_id === "number" ? String(s.source_id) : ""),
      name: str(s.name) ?? str(s.simbad_id),
      g: fin(s.g),
      sepArcmin: fin(s.separation_arcmin),
      distanceLy: fin(s.distance_ly),
      typeLabel: str(s.otype_label),
    }))
    .filter((s) => s.sourceId);
  return { stars, gLimit: fin(o.g_limit) };
}

// --------------------------------------------------------------------------------- requests

export interface ObjectLive {
  sky: Live<SkyInfo>;
  gaia: Live<GaiaMatch>;
  simbad: Live<SimbadInfo>;
  coverage: Live<Coverage>;
  spectrum: Live<QuickSpectrum>;
  starsCount: Live<StarsCount>;
  brightest: Live<Brightest>;
}

type Part = keyof ObjectLive;
const PARTS: Part[] = ["sky", "gaia", "simbad", "coverage", "spectrum", "starsCount", "brightest"];

function failure(e: unknown, what: string): Live<never> {
  if (e instanceof HttpError) {
    if (e.code === "no_coverage" || e.code === "not_found") return { state: "none", message: e.message };
    return { state: "error", message: `${what}: ${e.message}` };
  }
  return { state: "error", message: `${what} could not be reached.` };
}

/** Nearest Gaia DR3 source to a catalogue star, matched by position and brightness. */
async function gaiaFor(ra: number, dec: number, vmag: number | null, signal: AbortSignal): Promise<GaiaMatch | null> {
  const rows = await getJson<Raw[]>(`/api/catalog/gaia?ra=${r5(ra)}&dec=${r5(dec)}&radius_arcmin=0.25`, signal);
  let best: { row: Raw; sep: number } | null = null;
  const c = Math.cos(dec * (Math.PI / 180));
  for (const row of rows ?? []) {
    const rra = fin(row.ra);
    const rdec = fin(row.dec);
    if (rra === null || rdec === null) continue;
    const dra = (((rra - ra + 540) % 360) - 180) * c;
    const sep = Math.hypot(dra, rdec - dec) * 3600;
    const g = fin(row.g);
    if (vmag !== null && g !== null && Math.abs(g - vmag) > 2.5) continue;
    if (sep > 12) continue;
    if (!best || sep < best.sep) best = { row, sep };
  }
  return best ? parseGaia(best.row, best.sep) : null;
}

export interface StarQuery {
  vmag?: number | null;
  hip?: number | null;
  pmra?: number | null;
  pmdec?: number | null;
}

/**
 * Live facts for one place. `kind` "star" asks /api/object, "spot" /api/patch; the endpoints the
 * service already had fill in whatever those do not answer.
 */
export function useLiveObject(kind: "star" | "spot", ra: number | null, dec: number | null, q: StarQuery = {}): ObjectLive {
  const { vmag = null, hip = null, pmra = null, pmdec = null } = q;
  const key = ra === null || dec === null ? "" : `${kind}:${r5(ra)},${r5(dec)}:${hip ?? ""}`;
  const [state, setState] = useState<{ key: string; value: ObjectLive } | null>(null);

  useEffect(() => {
    if (!key || ra === null || dec === null || !apiBase()) return;
    const controller = new AbortController();
    const { signal } = controller;
    const value = Object.fromEntries(PARTS.map((p) => [p, { state: "loading" }])) as unknown as ObjectLive;
    if (kind === "spot") value.gaia = value.simbad = { state: "none", message: "" };
    else value.starsCount = value.brightest = { state: "none", message: "" };
    const filled = new Set<Part>();
    const set = (part: Part, v: Live<unknown>, final = true) => {
      if (signal.aborted) return;
      if (final) filled.add(part);
      (value as unknown as Record<Part, Live<unknown>>)[part] = v;
      setState({ key, value: { ...value } });
    };

    // The combined endpoint gets a short head start; whatever it has not answered by then comes
    // from the endpoints that already exist, in parallel.
    let fallbackStarted = false;
    const startFallback = () => {
      if (fallbackStarted || signal.aborted) return;
      fallbackStarted = true;
      if (kind === "star" && !filled.has("gaia")) {
        gaiaFor(ra, dec, vmag, signal)
          .then((m) => {
            if (!filled.has("gaia"))
              set("gaia", m ? { state: "ok", value: m } : { state: "none", message: "No Gaia DR3 source matches this star." });
          })
          .catch((e) => !filled.has("gaia") && !signal.aborted && set("gaia", failure(e, "Gaia DR3")));
      }
      if (!filled.has("coverage")) {
        getJson<Raw>(`/api/field/summary?ra=${r5(ra)}&dec=${r5(dec)}&fov=10`, signal)
          .then((j) => {
            if (filled.has("coverage")) return;
            const c = parseCoverage(j);
            set("coverage", c ? { state: "ok", value: c } : { state: "none", message: "No SPHEREx images here yet." });
          })
          .catch((e) => !filled.has("coverage") && !signal.aborted && set("coverage", failure(e, "SPHEREx coverage")));
      }
      if (!filled.has("spectrum")) {
        getJson<Raw>(`/api/spectrum/quick?ra=${r5(ra)}&dec=${r5(dec)}`, signal)
          .then((j) => {
            if (filled.has("spectrum")) return;
            const sp = parseSpectrum(j);
            set(
              "spectrum",
              sp
                ? { state: "ok", value: sp }
                : { state: "none", message: "The quick-look cube has no usable data here (very bright stars are blank in it)." },
            );
          })
          .catch((e) => !filled.has("spectrum") && !signal.aborted && set("spectrum", failure(e, "The quick-look spectrum")));
      }
      for (const p of ["sky", "simbad", "starsCount", "brightest"] as Part[]) {
        if (!filled.has(p) && value[p].state === "loading")
          set(p, { state: "none", message: "Not on the live service yet." });
      }
    };
    const headStart = setTimeout(startFallback, 1500);
    signal.addEventListener("abort", () => clearTimeout(headStart));

    const params = new URLSearchParams({ ra: r5(ra), dec: r5(dec) });
    if (kind === "star") {
      if (hip) params.set("hip", String(hip));
      if (pmra !== null && pmdec !== null) {
        params.set("pmra", pmra.toFixed(2));
        params.set("pmdec", pmdec.toFixed(2));
      }
    }
    getJson<Raw>(`/api/${kind === "star" ? "object" : "patch"}?${params.toString()}`, signal)
      .then((answer) => {
        if (signal.aborted) return;
        const take = <T,>(part: Part, raw: unknown, parse: (o: Raw | null) => T | null, empty: string) => {
          const p = partOf(raw);
          if (!p) return;
          if ("ok" in p) {
            const v = parse(p.ok);
            set(part, v ? { state: "ok", value: v } : { state: "none", message: empty });
          } else if (p.not.state === "none") {
            set(part, p.not);
          }
          // An error or timeout leaves the part to the older endpoints (or to its own message).
          else if (part === "sky" || part === "simbad" || part === "starsCount" || part === "brightest") {
            set(part, p.not);
          }
        };
        take("sky", answer.sky, parseSky, "");
        if (kind === "star") {
          take("gaia", answer.gaia, (o) => parseGaia(o), "No Gaia DR3 source here.");
          take("simbad", answer.simbad, parseSimbad, "SIMBAD has no entry here.");
        } else {
          take("starsCount", answer.stars_count, parseStarsCount, "");
          take("brightest", answer.brightest, parseBrightest, "No Gaia stars here.");
        }
        take("coverage", answer.spherex ?? answer.coverage, parseCoverage, "No SPHEREx images here yet.");
        take("spectrum", answer.spectrum, parseSpectrum, "The quick-look cube has no usable data here (very bright stars are blank in it).");
        startFallback();
      })
      .catch(() => startFallback());

    return () => controller.abort();
  }, [key, kind, ra, dec, vmag, hip, pmra, pmdec]);

  if (!apiBase()) {
    return Object.fromEntries(PARTS.map((p) => [p, { state: "off" }])) as unknown as ObjectLive;
  }
  if (state && state.key === key) return state.value;
  return Object.fromEntries(PARTS.map((p) => [p, { state: "loading" }])) as unknown as ObjectLive;
}
