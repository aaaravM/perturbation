// Catalogue lookups for "click any star" in the Lab, straight from the archives:
// - Gaia DR3 sources in a cone: the CfA mirror of VizieR (I/355/gaiadr3, CORS open), or the
//   Perturbation backend's /api/catalog/gaia (IRSA Gator) when VizieR does not answer.
//   Positions are Gaia's epoch 2016.0, moved linearly with their proper motion to the epoch shown.
// - SIMBAD (CfA mirror, TAP): the name, object type and spectral type of a Gaia source, looked up
//   by its exact "Gaia DR3 <id>" identifier, so nothing is matched by guesswork.
// - SPHEREx coverage (/api/field/summary) and the quick-look spectrum (/api/spectrum/quick) from
//   the backend, when it is connected.
// Nothing here is ever filled in when an archive does not answer: the caller says so instead.

import { API_URL } from "@/lib/manifest";
import { propagate } from "@/lib/lab-coords";

export const VIZIER_MIRROR = "https://vizier.cfa.harvard.edu/viz-bin/asu-tsv";
export const SIMBAD_TAP = "https://simbad.cfa.harvard.edu/simbad/sim-tap/sync";
export const GAIA_EPOCH = 2016.0;
/** Brightest sources kept per cone: plenty for clicking, light enough to draw. */
export const GAIA_MAX_ROWS = 2500;

export interface GaiaSource {
  /** Gaia DR3 source_id, kept as a string (too large for a JavaScript number). */
  id: string;
  /** Position at the epoch the cone was asked for (moved from 2016.0). */
  ra: number;
  dec: number;
  ra2016: number;
  dec2016: number;
  g: number | null;
  bpRp: number | null;
  pmra: number | null;
  pmdec: number | null;
  pmraErr: number | null;
  pmdecErr: number | null;
  parallax: number | null;
  parallaxErr: number | null;
  ruwe: number | null;
  rv: number | null;
  teff: number | null;
  distGspPhot: number | null;
  variable: string | null;
}

export interface GaiaCone {
  sources: GaiaSource[];
  /** "VizieR (CfA mirror)" or "IRSA Gator via the Perturbation backend". */
  via: string;
  /** True when the cone held more sources than were kept (the faintest were dropped). */
  truncated: boolean;
  epoch: number;
  center: { ra: number; dec: number };
  radiusArcmin: number;
}

const num = (text: string | undefined): number | null => {
  if (text === undefined) return null;
  const t = text.trim();
  if (!t) return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
};

function moveTo(ra: number, dec: number, pmra: number | null, pmdec: number | null, epoch: number) {
  if (pmra === null || pmdec === null) return { ra, dec };
  return propagate({ ra, dec, pmra, pmdec }, GAIA_EPOCH, epoch);
}

const VIZIER_COLUMNS = [
  "Source",
  "RA_ICRS",
  "DE_ICRS",
  "Gmag",
  "BP-RP",
  "pmRA",
  "e_pmRA",
  "pmDE",
  "e_pmDE",
  "Plx",
  "e_Plx",
  "RUWE",
  "RV",
  "Teff",
  "Dist",
  "VarFlag",
];

/** Parse VizieR's asu-tsv answer: comment lines, a header, a units line, a dashes line, rows. */
export function parseVizierTsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0 && !l.startsWith("#"));
  if (lines.length < 3) return [];
  const header = lines[0].split("\t").map((h) => h.trim());
  const rows: Record<string, string>[] = [];
  for (const line of lines.slice(1)) {
    if (/^-+(\t-+)*\s*$/.test(line)) continue;
    const cells = line.split("\t");
    if (cells.length !== header.length) continue;
    // The units line: no numeric source id.
    if (!/^\s*\d+\s*$/.test(cells[0] ?? "")) continue;
    rows.push(Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ""])));
  }
  return rows;
}

async function gaiaFromVizier(ra: number, dec: number, radiusArcmin: number, epoch: number, signal?: AbortSignal) {
  const params = new URLSearchParams({
    "-source": "I/355/gaiadr3",
    "-c": `${ra.toFixed(6)} ${dec >= 0 ? "+" : ""}${dec.toFixed(6)}`,
    "-c.rm": radiusArcmin.toFixed(3),
    "-out": VIZIER_COLUMNS.join(","),
    "-out.max": String(GAIA_MAX_ROWS),
    "-sort": "Gmag",
  });
  const res = await fetch(`${VIZIER_MIRROR}?${params.toString()}`, { signal });
  if (!res.ok) throw new Error(`VizieR answered HTTP ${res.status}`);
  const rows = parseVizierTsv(await res.text());
  return rows
    .map((r): GaiaSource | null => {
      const ra2016 = num(r.RA_ICRS);
      const dec2016 = num(r.DE_ICRS);
      if (ra2016 === null || dec2016 === null) return null;
      const pmra = num(r.pmRA);
      const pmdec = num(r.pmDE);
      const now = moveTo(ra2016, dec2016, pmra, pmdec, epoch);
      return {
        id: r.Source.trim(),
        ra: now.ra,
        dec: now.dec,
        ra2016,
        dec2016,
        g: num(r.Gmag),
        bpRp: num(r["BP-RP"]),
        pmra,
        pmdec,
        pmraErr: num(r.e_pmRA),
        pmdecErr: num(r.e_pmDE),
        parallax: num(r.Plx),
        parallaxErr: num(r.e_Plx),
        ruwe: num(r.RUWE),
        rv: num(r.RV),
        teff: num(r.Teff),
        distGspPhot: num(r.Dist),
        variable: r.VarFlag?.trim() || null,
      };
    })
    .filter((s): s is GaiaSource => s !== null);
}

async function gaiaFromBackend(ra: number, dec: number, radiusArcmin: number, epoch: number, signal?: AbortSignal) {
  const mjd = 51544.5 + (epoch - 2000) * 365.25;
  const url = `${API_URL}/api/catalog/gaia?ra=${ra.toFixed(5)}&dec=${dec.toFixed(5)}&radius_arcmin=${Math.min(15, radiusArcmin).toFixed(2)}&epoch_mjd=${mjd.toFixed(1)}`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`The backend answered HTTP ${res.status}`);
  const rows = (await res.json()) as {
    source_id: string;
    ra: number;
    dec: number;
    g: number | null;
    bp_rp: number | null;
    pmra: number | null;
    pmdec: number | null;
    parallax: number | null;
  }[];
  return rows
    .filter((r) => Number.isFinite(r.ra) && Number.isFinite(r.dec))
    .sort((a, b) => (a.g ?? 99) - (b.g ?? 99))
    .slice(0, GAIA_MAX_ROWS)
    .map(
      (r): GaiaSource => ({
        id: String(r.source_id),
        ra: r.ra,
        dec: r.dec,
        // The backend returns positions already moved; 2016.0 is recovered for display only.
        ...(() => {
          const back =
            r.pmra === null || r.pmdec === null
              ? { ra: r.ra, dec: r.dec }
              : propagate({ ra: r.ra, dec: r.dec, pmra: r.pmra, pmdec: r.pmdec }, epoch, GAIA_EPOCH);
          return { ra2016: back.ra, dec2016: back.dec };
        })(),
        g: r.g,
        bpRp: r.bp_rp,
        pmra: r.pmra,
        pmdec: r.pmdec,
        pmraErr: null,
        pmdecErr: null,
        parallax: r.parallax,
        parallaxErr: null,
        ruwe: null,
        rv: null,
        teff: null,
        distGspPhot: null,
        variable: null,
      }),
    );
}

/** Gaia DR3 sources within `radiusArcmin` of a point, moved to `epoch` (Julian years). */
export async function loadGaiaCone(
  center: { ra: number; dec: number },
  radiusArcmin: number,
  epoch: number,
  signal?: AbortSignal,
): Promise<GaiaCone> {
  const base = { epoch, center, radiusArcmin };
  try {
    const sources = await gaiaFromVizier(center.ra, center.dec, radiusArcmin, epoch, signal);
    return { ...base, sources, via: "VizieR (CfA mirror)", truncated: sources.length >= GAIA_MAX_ROWS };
  } catch (err) {
    if (signal?.aborted || !API_URL) throw err;
    const sources = await gaiaFromBackend(center.ra, center.dec, radiusArcmin, epoch, signal);
    return { ...base, sources, via: "IRSA Gator via the Perturbation backend", truncated: sources.length >= GAIA_MAX_ROWS };
  }
}

// ---------------------------------------------------------------------------------------------
// SIMBAD
// ---------------------------------------------------------------------------------------------

export interface SimbadInfo {
  mainId: string;
  otype: string | null;
  otypeText: string | null;
  spType: string | null;
  /** A few well-known other names (HD, HIP, GJ, 2MASS, ...). */
  names: string[];
  url: string;
}

async function tap<T extends unknown[]>(query: string, signal?: AbortSignal): Promise<T[]> {
  const params = new URLSearchParams({ request: "doQuery", lang: "adql", format: "json", query });
  const res = await fetch(`${SIMBAD_TAP}?${params.toString()}`, { signal });
  if (!res.ok) throw new Error(`SIMBAD answered HTTP ${res.status}`);
  const body = (await res.json()) as { data?: T[] };
  return body.data ?? [];
}

const NAME_ORDER = [/^NAME /, /^V\* /, /^HD /, /^HIP /, /^GJ /, /^Gl /, /^LHS /, /^LP /, /^2MASS /, /^WISE/, /^TYC /, /^BD/];

/** SIMBAD's entry for a Gaia DR3 source, or null when SIMBAD does not know it. */
export async function simbadForGaia(sourceId: string, signal?: AbortSignal): Promise<SimbadInfo | null> {
  if (!/^\d+$/.test(sourceId)) return null;
  const rows = await tap<[string, string | null, string | null, string | null, number]>(
    `SELECT b.main_id, b.otype, d.description, b.sp_type, b.oid FROM ident AS i JOIN basic AS b ON i.oidref = b.oid LEFT JOIN otypedef AS d ON b.otype = d.otype WHERE i.id = 'Gaia DR3 ${sourceId}'`,
    signal,
  );
  const row = rows[0];
  if (!row) return null;
  const [mainId, otype, otypeText, spType, oid] = row;
  let names: string[] = [];
  try {
    const ids = await tap<[string]>(`SELECT id FROM ident WHERE oidref = ${Number(oid)}`, signal);
    const all = ids.map((r) => r[0]).filter((n) => n && n !== mainId && !n.startsWith("Gaia "));
    names = NAME_ORDER.flatMap((re) => all.filter((n) => re.test(n)).slice(0, 1)).slice(0, 5);
  } catch {
    // The other names are a nicety.
  }
  return {
    mainId: mainId.replace(/^NAME /, "").replace(/\s+/g, " "),
    otype,
    otypeText,
    spType: spType?.trim() || null,
    names: names.map((n) => n.replace(/^NAME /, "").replace(/\s+/g, " ")),
    url: `https://simbad.cfa.harvard.edu/simbad/sim-id?Ident=${encodeURIComponent(mainId)}`,
  };
}

// ---------------------------------------------------------------------------------------------
// SPHEREx, from the backend
// ---------------------------------------------------------------------------------------------

export interface SpherexCoverage {
  nEpochs: number;
  nImages: number;
  nExposures: number;
  detectors: Record<string, number>;
  collections: string[];
  deepField: boolean;
  epochs: { label: string; survey: string; full: boolean; n_exposures: number }[];
}

/** What SPHEREx has observed at a point (a 2′ field): needs the backend. */
export async function loadCoverage(ra: number, dec: number, signal?: AbortSignal): Promise<SpherexCoverage> {
  if (!API_URL) throw new Error("no-backend");
  const res = await fetch(`${API_URL}/api/field/summary?ra=${ra.toFixed(5)}&dec=${dec.toFixed(5)}&fov=2.0`, { signal });
  if (res.status === 404) {
    return { nEpochs: 0, nImages: 0, nExposures: 0, detectors: {}, collections: [], deepField: false, epochs: [] };
  }
  if (!res.ok) throw new Error(`The backend answered HTTP ${res.status}`);
  const body = (await res.json()) as {
    n_epochs?: number;
    n_images?: number;
    n_exposures?: number;
    detectors?: Record<string, number>;
    collections?: string[];
    deep_field?: boolean;
    epochs?: { label: string; survey: string; full: boolean; n_exposures: number }[];
  };
  return {
    nEpochs: Number(body.n_epochs ?? body.epochs?.length ?? 0),
    nImages: Number(body.n_images ?? 0),
    nExposures: Number(body.n_exposures ?? 0),
    detectors: body.detectors ?? {},
    collections: body.collections ?? [],
    deepField: Boolean(body.deep_field),
    epochs: body.epochs ?? [],
  };
}

export interface QuickSpectrum {
  wl_um: number[];
  flux_ujy: (number | null)[];
  err_ujy?: (number | null)[];
  label: string;
  pixel_arcsec?: number;
}

/** The DR1 all-sky cube spectrum at a point: needs the backend. */
export async function loadQuickSpectrum(ra: number, dec: number, signal?: AbortSignal): Promise<QuickSpectrum> {
  if (!API_URL) throw new Error("no-backend");
  const res = await fetch(`${API_URL}/api/spectrum/quick?ra=${ra.toFixed(6)}&dec=${dec.toFixed(6)}`, { signal });
  if (!res.ok) throw new Error(res.status === 404 ? "No DR1 cube data at this position" : `HTTP ${res.status}`);
  return (await res.json()) as QuickSpectrum;
}

export interface ObjectSpot {
  coverage: SpherexCoverage | null;
  spectrum: QuickSpectrum | null;
  /** Plain words about where the spot is (constellation, galactic plane), from the backend. */
  where: { constellation: string | null; sentence: string | null } | null;
}

type Part<T> = ({ status: "ok" } & T) | { status: "none" | "error" | "timeout"; message?: string };

/**
 * Everything the backend knows at one spot, in one request (/api/object, "pxh-object/1").
 * Throws when the endpoint is missing, so callers fall back to the single endpoints.
 */
export async function loadObjectSpot(s: GaiaSource, epoch: number, signal?: AbortSignal): Promise<ObjectSpot> {
  if (!API_URL) throw new Error("no-backend");
  const q = new URLSearchParams({ ra: s.ra.toFixed(6), dec: s.dec.toFixed(6), epoch: epoch.toFixed(3), radius_arcsec: "6" });
  if (s.pmra !== null && s.pmdec !== null) {
    q.set("pmra", s.pmra.toFixed(3));
    q.set("pmdec", s.pmdec.toFixed(3));
  }
  const res = await fetch(`${API_URL}/api/object?${q.toString()}`, { signal });
  if (!res.ok) throw new Error(`The backend answered HTTP ${res.status}`);
  const body = (await res.json()) as {
    schema?: string;
    sky?: Part<{ constellation_name?: string; where?: string | string[] }>;
    spherex?: Part<{
      n_images?: number;
      n_exposures?: number;
      n_epochs?: number;
      deep_field?: boolean;
      collections?: string[];
      detectors?: Record<string, number>;
      epochs?: { label: string; survey?: string; full: boolean; n_exposures: number }[];
    }>;
    spectrum?: Part<QuickSpectrum>;
  };
  if (body.schema !== "pxh-object/1") throw new Error("unexpected answer");
  const sp = body.spherex;
  const coverage: SpherexCoverage | null =
    sp?.status === "ok"
      ? {
          nEpochs: Number(sp.n_epochs ?? 0),
          nImages: Number(sp.n_images ?? 0),
          nExposures: Number(sp.n_exposures ?? 0),
          detectors: sp.detectors ?? {},
          collections: sp.collections ?? [],
          deepField: Boolean(sp.deep_field),
          epochs: (sp.epochs ?? []).map((e) => ({ ...e, survey: e.survey ?? "" })),
        }
      : sp?.status === "none"
        ? { nEpochs: 0, nImages: 0, nExposures: 0, detectors: {}, collections: [], deepField: false, epochs: [] }
        : null;
  const spectrum = body.spectrum?.status === "ok" ? (body.spectrum as QuickSpectrum) : null;
  const sky = body.sky?.status === "ok" ? body.sky : null;
  return {
    coverage,
    spectrum,
    where: sky
      ? {
          constellation: sky.constellation_name ?? null,
          sentence: Array.isArray(sky.where) ? (sky.where[0] ?? null) : (sky.where ?? null),
        }
      : null,
  };
}

// ---------------------------------------------------------------------------------------------
// Derived quantities, all from the catalogue values above
// ---------------------------------------------------------------------------------------------

/** Distance in light-years from a parallax in mas (only when it is clearly measured). */
export function parallaxDistanceLy(plx: number | null, plxErr: number | null): number | null {
  if (plx === null || plx <= 0) return null;
  if (plxErr !== null && plx / plxErr < 5) return null;
  return (1000 / plx) * 3.26156;
}

export function totalProperMotion(s: Pick<GaiaSource, "pmra" | "pmdec">): number | null {
  if (s.pmra === null || s.pmdec === null) return null;
  return Math.hypot(s.pmra, s.pmdec) / 1000;
}

// ---------------------------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------------------------

/** RFC 4180 CSV with a header row. */
export function toCsv(header: string[], rows: (string | number | boolean | null | undefined)[][]): string {
  const cell = (v: string | number | boolean | null | undefined) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [header, ...rows].map((r) => r.map(cell).join(",")).join("\n") + "\n";
}

export function downloadText(name: string, text: string, type = "text/csv") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  downloadUrl(name, url);
  window.setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function downloadUrl(name: string, url: string) {
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}
