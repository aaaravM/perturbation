// The Sky-mode star catalogue: loader, spatial index and search.
//
// Primary data: frontend/public/data/stars/ (manifest.json and three magnitude tiers built from
// the Hipparcos new reduction, van Leeuwen 2007): positions moved to epoch 2026.0 with proper
// motion, V magnitude, B-V, parallax, proper motion, temperature, sRGB colour, HIP number,
// spectral type, constellation and names. Until those files exist, the older d3-celestial files
// in public/data (Hipparcos stars to V = 8: position, V and B-V only) stand in, and the loader
// switches to the full catalogue as soon as its manifest appears.
//
// Stars are addressed by a global id: the tier's offset plus the record index, with offsets taken
// from the manifest's counts so ids stay stable while later tiers load.

export const DEG = Math.PI / 180;
const STRIDE = 8;

export interface StarNames {
  name?: string;
  bayer?: string;
  flamsteed?: string;
  variable?: string;
  gliese?: string;
}

interface TierSpec {
  name: string;
  vmax: number;
  count: number;
  bin?: string;
  rgb?: string;
  meta?: string;
}

interface ManifestJson {
  version: number;
  epoch_jyear: number;
  tiers: TierSpec[];
  fields?: string[];
  collections?: string;
  credits?: string;
}

interface TierMetaJson {
  hip?: number[];
  sp?: string[];
  con?: string[];
  e_plx?: (number | null)[];
  names?: Record<string, StarNames>;
}

type CollectionRef = { tier: string | number; index: number };

export interface SkyGrid {
  bandStart: Int32Array;
  bandCells: Int32Array;
  starts: Int32Array;
  items: Int32Array;
}

export interface StarTier {
  name: string;
  vmax: number;
  count: number;
  offset: number;
  /** count x 8 floats: ra, dec, vmag, bv, plx, pmra, pmdec, teff. */
  data: Float32Array;
  /** count x 3 sRGB bytes. */
  rgb: Uint8Array;
  /** Unit vectors in globe space (see globe-math.ts), count x 3. */
  xyz: Float32Array;
  hip: Int32Array | null;
  sp: string[] | null;
  con: string[] | null;
  /** Parallax errors (mas), when the catalogue has them. */
  ePlx: Float32Array | null;
  names: Map<number, StarNames>;
  grid: SkyGrid;
}

export interface StarCollections {
  nearest: number[];
  brightest: number[];
  fastest: number[];
}

export interface Catalogue {
  /** "hipparcos": the full catalogue; "basic": the stand-in (no distances, motions or names). */
  source: "hipparcos" | "basic";
  epoch: number;
  credits: string;
  /** Tiers as planned, in order; `loaded` says which have arrived. */
  plan: { name: string; vmax: number; count: number; offset: number }[];
  tiers: (StarTier | null)[];
  loadedCount: number;
  totalCount: number;
  complete: boolean;
  collections: StarCollections | null;
  byHip: Map<number, number>;
  version: number;
}

export interface Star {
  id: number;
  tier: number;
  index: number;
  ra: number;
  dec: number;
  vmag: number;
  bv: number | null;
  plx: number | null;
  plxErr: number | null;
  pmra: number | null;
  pmdec: number | null;
  teff: number | null;
  rgb: [number, number, number];
  hip: number | null;
  sp: string | null;
  con: string | null;
  names: StarNames | null;
}

const MANIFEST_URL = "/data/stars/manifest.json";
const BASIC_FILES = ["/data/stars-6.bin", "/data/stars-8.bin"];
const SKY_LINES_URL = "/data/sky-lines.json";

// ------------------------------------------------------------------------------------- vectors

/** Same convention as components/globe/globe-math.ts (kept here so this file has no three.js). */
export function unitVector(raDeg: number, decDeg: number): [number, number, number] {
  const ra = raDeg * DEG;
  const dec = decDeg * DEG;
  const c = Math.cos(dec);
  return [-c * Math.cos(ra), Math.sin(dec), c * Math.sin(ra)];
}

export function angularSeparation(ra1: number, dec1: number, ra2: number, dec2: number): number {
  const a = unitVector(ra1, dec1);
  const b = unitVector(ra2, dec2);
  const d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  return Math.acos(Math.max(-1, Math.min(1, d))) / DEG;
}

// ------------------------------------------------------------------------------------- grid

const BAND = 1; // degrees of declination per band
const NBANDS = 180 / BAND;

function buildGrid(data: Float32Array, count: number): SkyGrid {
  const bandCells = new Int32Array(NBANDS);
  const bandStart = new Int32Array(NBANDS + 1);
  for (let b = 0; b < NBANDS; b++) {
    const mid = -90 + (b + 0.5) * BAND;
    bandCells[b] = Math.max(1, Math.floor((360 * Math.cos(mid * DEG)) / BAND));
    bandStart[b + 1] = bandStart[b] + bandCells[b];
  }
  const ncells = bandStart[NBANDS];
  const cellOf = new Int32Array(count);
  const counts = new Int32Array(ncells + 1);
  for (let i = 0; i < count; i++) {
    const ra = data[i * STRIDE];
    const dec = data[i * STRIDE + 1];
    const b = Math.min(NBANDS - 1, Math.max(0, Math.floor((dec + 90) / BAND)));
    const n = bandCells[b];
    const c = Math.min(n - 1, Math.max(0, Math.floor((((ra % 360) + 360) % 360) / (360 / n))));
    const cell = bandStart[b] + c;
    cellOf[i] = cell;
    counts[cell + 1]++;
  }
  for (let c = 0; c < ncells; c++) counts[c + 1] += counts[c];
  const starts = counts.slice();
  const fill = counts.slice(0, ncells);
  const items = new Int32Array(count);
  for (let i = 0; i < count; i++) items[fill[cellOf[i]]++] = i;
  return { bandStart, bandCells, starts, items };
}

/** Visit every star of a tier within `radius` degrees of (ra, dec). `cosd` is cos(separation). */
export function queryTier(
  tier: StarTier,
  ra: number,
  dec: number,
  radius: number,
  visit: (index: number, cosd: number) => void,
) {
  const [vx, vy, vz] = unitVector(ra, dec);
  const cosR = Math.cos(Math.min(180, radius) * DEG);
  const { bandStart, bandCells, starts, items } = tier.grid;
  const xyz = tier.xyz;
  const b0 = Math.max(0, Math.floor((dec - radius + 90) / BAND));
  const b1 = Math.min(NBANDS - 1, Math.floor((dec + radius + 90) / BAND));
  const scan = (cell: number) => {
    for (let k = starts[cell]; k < starts[cell + 1]; k++) {
      const i = items[k];
      const d = xyz[3 * i] * vx + xyz[3 * i + 1] * vy + xyz[3 * i + 2] * vz;
      if (d >= cosR) visit(i, d);
    }
  };
  for (let b = b0; b <= b1; b++) {
    const n = bandCells[b];
    const lo = -90 + b * BAND;
    const maxAbs = Math.max(Math.abs(lo), Math.abs(lo + BAND));
    if (n === 1 || maxAbs + radius >= 89.5 || radius >= 60) {
      for (let c = 0; c < n; c++) scan(bandStart[b] + c);
      continue;
    }
    const s = Math.sin(radius * DEG) / Math.cos(maxAbs * DEG);
    const dRa = s >= 1 ? 180 : Math.asin(s) / DEG;
    const width = 360 / n;
    const c0 = Math.floor((ra - dRa) / width);
    const c1 = Math.floor((ra + dRa) / width);
    if (c1 - c0 + 1 >= n) {
      for (let c = 0; c < n; c++) scan(bandStart[b] + c);
      continue;
    }
    for (let c = c0; c <= c1; c++) scan(bandStart[b] + (((c % n) + n) % n));
  }
}

/** Visit stars of every loaded tier within `radius` degrees. */
export function queryCatalogue(
  cat: Catalogue,
  ra: number,
  dec: number,
  radius: number,
  visit: (id: number, cosd: number, tier: StarTier, index: number) => void,
) {
  for (const tier of cat.tiers) {
    if (!tier) continue;
    queryTier(tier, ra, dec, radius, (i, d) => visit(tier.offset + i, d, tier, i));
  }
}

/** The `n` nearest stars (brighter than `vmax`) to a position, nearest first. */
export function nearestStars(
  cat: Catalogue,
  ra: number,
  dec: number,
  n: number,
  opts: { vmax?: number; maxRadius?: number; exclude?: number } = {},
): { id: number; sep: number }[] {
  const vmax = opts.vmax ?? 99;
  const maxRadius = opts.maxRadius ?? 20;
  let radius = 0.5;
  let found: { id: number; cosd: number }[] = [];
  while (radius <= maxRadius) {
    found = [];
    queryCatalogue(cat, ra, dec, radius, (id, cosd, tier, i) => {
      if (id === opts.exclude) return;
      if (tier.data[i * STRIDE + 2] > vmax) return;
      found.push({ id, cosd });
    });
    if (found.length >= n) break;
    radius *= 2;
  }
  found.sort((a, b) => b.cosd - a.cosd);
  return found.slice(0, n).map((f) => ({ id: f.id, sep: Math.acos(Math.min(1, f.cosd)) / DEG }));
}

/** Number of loaded stars brighter than `vmax` within `radius` degrees. */
export function countWithin(cat: Catalogue, ra: number, dec: number, radius: number, vmax: number): number {
  let n = 0;
  queryCatalogue(cat, ra, dec, radius, (_id, _d, tier, i) => {
    if (tier.data[i * STRIDE + 2] <= vmax) n++;
  });
  return n;
}

/** Stars brighter than `vmax` over the whole sky (loaded tiers). */
export function countBrighter(cat: Catalogue, vmax: number): number {
  let n = 0;
  for (const tier of cat.tiers) {
    if (!tier) continue;
    if (tier.vmax <= vmax) {
      n += tier.count;
      continue;
    }
    for (let i = 0; i < tier.count; i++) if (tier.data[i * STRIDE + 2] <= vmax) n++;
  }
  return n;
}

// ------------------------------------------------------------------------------------- records

const num = (v: number) => (Number.isFinite(v) ? v : null);

export function tierOf(cat: Catalogue, id: number): { tier: StarTier; index: number; t: number } | null {
  for (let t = 0; t < cat.plan.length; t++) {
    const p = cat.plan[t];
    if (id >= p.offset && id < p.offset + p.count) {
      const tier = cat.tiers[t];
      return tier ? { tier, index: id - p.offset, t } : null;
    }
  }
  return null;
}

export function getStar(cat: Catalogue | null, id: number | null | undefined): Star | null {
  if (!cat || id === null || id === undefined || id < 0) return null;
  const hit = tierOf(cat, id);
  if (!hit) return null;
  const { tier, index, t } = hit;
  const o = index * STRIDE;
  const d = tier.data;
  const plx = d[o + 4];
  const hip = tier.hip ? tier.hip[index] : 0;
  return {
    id,
    tier: t,
    index,
    ra: d[o],
    dec: d[o + 1],
    vmag: d[o + 2],
    bv: num(d[o + 3]),
    plx: Number.isFinite(plx) && plx > 0 ? plx : null,
    plxErr: tier.ePlx && Number.isFinite(tier.ePlx[index]) && tier.ePlx[index] > 0 ? tier.ePlx[index] : null,
    pmra: num(d[o + 5]),
    pmdec: num(d[o + 6]),
    teff: num(d[o + 7]),
    rgb: [tier.rgb[3 * index], tier.rgb[3 * index + 1], tier.rgb[3 * index + 2]],
    hip: hip > 0 ? hip : null,
    sp: tier.sp?.[index] || null,
    con: tier.con?.[index] || null,
    names: tier.names.get(index) ?? null,
  };
}

export function starById(cat: Catalogue | null, hip: number): Star | null {
  if (!cat) return null;
  const id = cat.byHip.get(hip);
  return id === undefined ? null : getStar(cat, id);
}

/** The most familiar name: proper name, then Bayer, then Flamsteed, then HIP number. */
export function starTitle(s: Star): string {
  const n = s.names;
  return n?.name ?? n?.bayer ?? n?.flamsteed ?? n?.variable ?? n?.gliese ?? (s.hip ? `HIP ${s.hip}` : "Unnamed star");
}

/** Every designation the catalogue gives, most familiar first, without the title. */
export function starDesignations(s: Star): string[] {
  const all = [
    s.names?.name,
    s.names?.bayer,
    s.names?.flamsteed,
    s.names?.variable,
    s.names?.gliese,
    s.hip ? `HIP ${s.hip}` : undefined,
  ].filter(
    (x): x is string => !!x,
  );
  const title = starTitle(s);
  return all.filter((x) => x !== title);
}

// ------------------------------------------------------------------------------------- store

let current: Catalogue | null = null;
let started = false;
const listeners = new Set<() => void>();
let skyLinesPromise: Promise<{ named: { name: string; ra: number; dec: number; mag: number }[]; constellations: { id: string; name: string }[] }> | null = null;

function emit(cat: Catalogue) {
  current = { ...cat, version: (current?.version ?? 0) + 1 };
  listeners.forEach((l) => l());
}

export function subscribeCatalogue(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function getCatalogue(): Catalogue | null {
  return current;
}

/** The full catalogue has replaced the stand-in (read through a call so TypeScript does not narrow it). */
function fullLoaded(): boolean {
  return getCatalogue()?.source === "hipparcos";
}

/** Start loading (once per page). Tier 1 first, then the fainter tiers in the background. */
export function ensureCatalogue() {
  if (started || typeof window === "undefined") return;
  started = true;
  void load();
}

export function loadSkyLines() {
  skyLinesPromise ??= fetch(SKY_LINES_URL)
    .then((r) => (r.ok ? r.json() : { named: [], constellations: [] }))
    .then((j) => ({ named: j.named ?? [], constellations: j.constellations ?? [] }))
    .catch(() => ({ named: [], constellations: [] }));
  return skyLinesPromise;
}

async function load() {
  let manifest: ManifestJson | null = null;
  try {
    const res = await fetch(MANIFEST_URL, { cache: "no-cache" });
    if (res.ok && (res.headers.get("content-type") ?? "").includes("json")) {
      const j = (await res.json()) as ManifestJson;
      if (j && j.version === 1 && Array.isArray(j.tiers) && j.tiers.length) manifest = j;
    }
  } catch {
    manifest = null;
  }
  if (manifest) {
    try {
      await loadFull(manifest);
      return;
    } catch {
      // fall through to the stand-in
    }
  }
  await loadBasic();
  // The full catalogue may be built while the page is open: look again now and then.
  const retry = async (delay: number) => {
    await new Promise((r) => setTimeout(r, delay));
    try {
      const res = await fetch(MANIFEST_URL, { cache: "no-cache" });
      if (res.ok && (res.headers.get("content-type") ?? "").includes("json")) {
        const j = (await res.json()) as ManifestJson;
        if (j?.version === 1 && Array.isArray(j.tiers) && j.tiers.length) {
          await loadFull(j);
          return;
        }
      }
    } catch {
      // keep the stand-in
    }
    if (delay < 120_000) void retry(delay * 2);
  };
  void retry(15_000);
}

function baseUrl(file: string) {
  return file.startsWith("/") ? file : `/data/stars/${file}`;
}

async function loadFull(m: ManifestJson) {
  const plan = m.tiers.map((t, i, all) => ({
    name: t.name,
    vmax: t.vmax,
    count: t.count,
    offset: all.slice(0, i).reduce((s, x) => s + x.count, 0),
  }));
  const cat: Catalogue = {
    source: "hipparcos",
    epoch: m.epoch_jyear ?? 2026,
    credits: m.credits ?? "",
    plan,
    tiers: plan.map(() => null),
    loadedCount: 0,
    totalCount: plan.reduce((s, p) => s + p.count, 0),
    complete: false,
    collections: null,
    byHip: new Map(),
    version: 0,
  };
  let collectionsRaw: Record<string, CollectionRef[]> | null = null;
  const collectionsPromise = m.collections
    ? fetch(baseUrl(m.collections))
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null)
    : Promise.resolve(null);

  for (let t = 0; t < m.tiers.length; t++) {
    const spec = m.tiers[t];
    const [bin, rgb, meta] = await Promise.all([
      fetch(baseUrl(spec.bin ?? `${spec.name}.bin`)).then((r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.arrayBuffer();
      }),
      fetch(baseUrl(spec.rgb ?? `${spec.name}.rgb`)).then((r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.arrayBuffer();
      }),
      fetch(baseUrl(spec.meta ?? `${spec.name}.meta.json`))
        .then((r) => (r.ok ? (r.json() as Promise<TierMetaJson>) : null))
        .catch(() => null),
    ]);
    const count = Math.min(spec.count, Math.floor(bin.byteLength / (4 * STRIDE)), Math.floor(rgb.byteLength / 3));
    const data = new Float32Array(bin, 0, count * STRIDE);
    const tier = makeTier(spec.name, spec.vmax, count, plan[t].offset, data, new Uint8Array(rgb, 0, count * 3), meta);
    cat.tiers[t] = tier;
    if (tier.hip) for (let i = 0; i < count; i++) if (tier.hip[i] > 0) cat.byHip.set(tier.hip[i], tier.offset + i);
    cat.loadedCount += count;
    if (t === 0) collectionsRaw = await collectionsPromise;
    cat.collections = resolveCollections(cat, collectionsRaw);
    cat.complete = t === m.tiers.length - 1;
    emit(cat);
    // Let the page breathe between tiers.
    await new Promise((r) => setTimeout(r, t === 0 ? 400 : 150));
  }
}

function resolveCollections(cat: Catalogue, raw: Record<string, CollectionRef[]> | null): StarCollections {
  const toId = (ref: CollectionRef): number | null => {
    const t =
      typeof ref.tier === "number" ? ref.tier : cat.plan.findIndex((p) => p.name === ref.tier);
    const p = cat.plan[t];
    if (!p || ref.index < 0 || ref.index >= p.count) return null;
    return p.offset + ref.index;
  };
  const list = (key: string) =>
    Array.isArray(raw?.[key]) ? (raw![key].map(toId).filter((x) => x !== null) as number[]) : [];
  const brightest = list("brightest");
  return {
    nearest: list("nearest"),
    brightest: brightest.length ? brightest : computeBrightest(cat, 30),
    fastest: list("fastest"),
  };
}

function computeBrightest(cat: Catalogue, n: number): number[] {
  const first = cat.tiers[0];
  if (!first) return [];
  const order = Array.from({ length: first.count }, (_, i) => i).sort(
    (a, b) => first.data[a * STRIDE + 2] - first.data[b * STRIDE + 2],
  );
  return order.slice(0, n).map((i) => first.offset + i);
}

function makeTier(
  name: string,
  vmax: number,
  count: number,
  offset: number,
  data: Float32Array,
  rgb: Uint8Array,
  meta: TierMetaJson | null,
): StarTier {
  const xyz = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const v = unitVector(data[i * STRIDE], data[i * STRIDE + 1]);
    xyz[3 * i] = v[0];
    xyz[3 * i + 1] = v[1];
    xyz[3 * i + 2] = v[2];
  }
  const names = new Map<number, StarNames>();
  if (meta?.names) {
    for (const [k, v] of Object.entries(meta.names)) {
      const i = Number(k);
      if (Number.isInteger(i) && i >= 0 && i < count && v) names.set(i, v);
    }
  }
  return {
    name,
    vmax,
    count,
    offset,
    data,
    rgb,
    xyz,
    hip: Array.isArray(meta?.hip) ? Int32Array.from(meta!.hip.slice(0, count), (x) => x | 0) : null,
    sp: Array.isArray(meta?.sp) ? meta!.sp : null,
    con: Array.isArray(meta?.con) ? meta!.con : null,
    ePlx: Array.isArray(meta?.e_plx) ? Float32Array.from(meta!.e_plx.slice(0, count), (x) => (x === null ? Number.NaN : x)) : null,
    names,
    grid: buildGrid(data, count),
  };
}

/** The stand-in: d3-celestial's Hipparcos stars (PXS1 files), with names of the brightest. */
async function loadBasic() {
  const plan = [
    { name: "tier1", vmax: 6, count: 0, offset: 0 },
    { name: "tier2", vmax: 8, count: 0, offset: 0 },
  ];
  const cat: Catalogue = {
    source: "basic",
    epoch: 2000,
    credits: "Hipparcos stars via d3-celestial (Olaf Frohn, BSD-3-Clause).",
    plan,
    tiers: [null, null],
    loadedCount: 0,
    totalCount: 0,
    complete: false,
    collections: null,
    byHip: new Map(),
    version: 0,
  };
  const lines = await loadSkyLines();
  for (let t = 0; t < BASIC_FILES.length; t++) {
    if (fullLoaded()) return;
    let buf: ArrayBuffer;
    try {
      const res = await fetch(BASIC_FILES[t]);
      if (!res.ok) throw new Error(String(res.status));
      buf = await res.arrayBuffer();
    } catch {
      break;
    }
    const view = new DataView(buf);
    const n = view.getUint32(4, true);
    const ra = new Float32Array(buf, 8, n);
    const dec = new Float32Array(buf, 8 + 4 * n, n);
    const mag = new Int16Array(buf, 8 + 8 * n, n);
    const bv = new Int16Array(buf, 8 + 10 * n, n);
    const data = new Float32Array(n * STRIDE).fill(Number.NaN);
    const rgb = new Uint8Array(n * 3);
    for (let i = 0; i < n; i++) {
      data[i * STRIDE] = ra[i];
      data[i * STRIDE + 1] = dec[i];
      data[i * STRIDE + 2] = mag[i] / 100;
      const b = bv[i] === -32768 ? Number.NaN : bv[i] / 1000;
      data[i * STRIDE + 3] = b;
      data[i * STRIDE + 7] = Number.isFinite(b) ? bvToTeff(b) : Number.NaN;
      const c = Number.isFinite(b) ? blackbodyRgb(bvToTeff(b)) : [255, 255, 255];
      rgb[3 * i] = c[0];
      rgb[3 * i + 1] = c[1];
      rgb[3 * i + 2] = c[2];
    }
    plan[t].count = n;
    plan[t].offset = t === 0 ? 0 : plan[0].count;
    const tier = makeTier(plan[t].name, plan[t].vmax, n, plan[t].offset, data, rgb, null);
    if (t === 0) {
      for (const s of lines.named) {
        let best = -1;
        let bestD = Math.cos(0.3 * DEG);
        queryTier(tier, s.ra, s.dec, 0.3, (i, d) => {
          if (d > bestD) {
            bestD = d;
            best = i;
          }
        });
        if (best >= 0 && !tier.names.has(best)) tier.names.set(best, { name: s.name });
      }
    }
    cat.tiers[t] = tier;
    cat.loadedCount += n;
    cat.totalCount = cat.loadedCount;
    cat.complete = t === BASIC_FILES.length - 1;
    cat.collections = { nearest: [], brightest: computeBrightest(cat, 30), fastest: [] };
    if (fullLoaded()) return;
    emit(cat);
  }
}

// ------------------------------------------------------------------------------------- colour

/** B-V to effective temperature (K), Ballesteros (2012). */
export function bvToTeff(bv: number): number {
  const b = Math.min(2, Math.max(-0.4, bv));
  return 4600 * (1 / (0.92 * b + 1.7) + 1 / (0.92 * b + 0.62));
}

/** Approximate blackbody sRGB colour of a temperature, brightest channel 255. */
export function blackbodyRgb(teff: number): [number, number, number] {
  const t = Math.min(40000, Math.max(1000, teff)) / 100;
  const r = t <= 66 ? 255 : 329.698727446 * Math.pow(t - 60, -0.1332047592);
  const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * Math.pow(t - 60, -0.0755148492);
  const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  const c = [r, g, b].map((v) => Math.min(255, Math.max(0, v)));
  const m = Math.max(...c) || 1;
  return [Math.round((c[0] / m) * 255), Math.round((c[1] / m) * 255), Math.round((c[2] / m) * 255)];
}

// ------------------------------------------------------------------------------------- search

const GREEK: Record<string, string> = {
  alpha: "α", alf: "α", beta: "β", bet: "β", gamma: "γ", gam: "γ", delta: "δ", del: "δ",
  epsilon: "ε", eps: "ε", zeta: "ζ", zet: "ζ", eta: "η", theta: "θ", tet: "θ", the: "θ",
  iota: "ι", iot: "ι", kappa: "κ", kap: "κ", lambda: "λ", lam: "λ", mu: "μ", nu: "ν", xi: "ξ",
  ksi: "ξ", omicron: "ο", omi: "ο", pi: "π", rho: "ρ", sigma: "σ", sig: "σ", tau: "τ",
  upsilon: "υ", ups: "υ", phi: "φ", chi: "χ", psi: "ψ", omega: "ω", ome: "ω",
};
const SUPERSCRIPT: Record<string, string> = { "¹": "1", "²": "2", "³": "3", "⁴": "4", "⁵": "5", "⁶": "6", "⁷": "7", "⁸": "8", "⁹": "9", "⁰": "0" };

export function normaliseName(s: string): string {
  let t = s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[¹²³⁴⁵⁶⁷⁸⁹⁰]/g, (c) => SUPERSCRIPT[c] ?? c)
    .replace(/[’'`]/g, "")
    .replace(/[−–]/g, "-");
  t = t.replace(/\b([a-z]+)(?=\s|\d|$)/g, (w) => GREEK[w] ?? w);
  return t.replace(/\s+/g, " ").trim();
}

interface NameEntry {
  id: number;
  keys: string[];
  label: string;
  vmag: number;
}

let nameIndex: { version: number; entries: NameEntry[] } | null = null;

function names(cat: Catalogue): NameEntry[] {
  if (nameIndex && nameIndex.version === cat.version) return nameIndex.entries;
  const entries: NameEntry[] = [];
  for (const tier of cat.tiers) {
    if (!tier) continue;
    for (const [i, n] of tier.names) {
      const keys = [n.name, n.bayer, n.flamsteed, n.variable, n.gliese]
        .filter((x): x is string => !!x)
        .map(normaliseName);
      if (!keys.length) continue;
      entries.push({
        id: tier.offset + i,
        keys,
        label: n.name ?? n.bayer ?? n.flamsteed ?? n.variable ?? n.gliese ?? "",
        vmag: tier.data[i * STRIDE + 2],
      });
    }
  }
  entries.sort((a, b) => a.vmag - b.vmag);
  nameIndex = { version: cat.version, entries };
  return entries;
}

export type SearchHit =
  | { kind: "star"; id: number; label: string; detail: string }
  | { kind: "coords"; ra: number; dec: number; label: string; detail: string };

/** Parse "101.287 -16.716", "06 45 08.9 -16 42 58" or "6h45m9s -16d42m58s". */
export function parseCoordinates(q: string): { ra: number; dec: number } | null {
  const s = q.trim().replace(/[−–]/g, "-").replace(/,/g, " ");
  const dec2 = /^(\d{1,3}(?:\.\d+)?)\s*°?\s+([+-]?\d{1,2}(?:\.\d+)?)\s*°?$/.exec(s);
  if (dec2) {
    const ra = Number(dec2[1]);
    const dec = Number(dec2[2]);
    if (ra >= 0 && ra < 360 && Math.abs(dec) <= 90) return { ra, dec };
    return null;
  }
  const sexa =
    /^(\d{1,2})[h:\s]\s*(\d{1,2})[m:\s]\s*(\d{1,2}(?:\.\d+)?)s?\s+([+-]?)(\d{1,2})[d°:\s]\s*(\d{1,2})['′m:\s]\s*(\d{1,2}(?:\.\d+)?)["″s]?$/i.exec(
      s,
    );
  if (sexa) {
    const ra = (Number(sexa[1]) + Number(sexa[2]) / 60 + Number(sexa[3]) / 3600) * 15;
    const dec = (sexa[4] === "-" ? -1 : 1) * (Number(sexa[5]) + Number(sexa[6]) / 60 + Number(sexa[7]) / 3600);
    if (ra >= 0 && ra < 360 && Math.abs(dec) <= 90) return { ra, dec };
  }
  return null;
}

export function searchStars(cat: Catalogue | null, query: string, limit = 8): SearchHit[] {
  const q = query.trim();
  if (!q) return [];
  const hits: SearchHit[] = [];
  const coords = parseCoordinates(q);
  if (coords) {
    hits.push({
      kind: "coords",
      ra: coords.ra,
      dec: coords.dec,
      label: "Go to these coordinates",
      detail: `RA ${coords.ra.toFixed(3)}°, Dec ${coords.dec >= 0 ? "+" : "−"}${Math.abs(coords.dec).toFixed(3)}°`,
    });
  }
  if (!cat) return hits;
  const hip = /^(?:hip\s*)?(\d{1,6})$/i.exec(q);
  if (hip) {
    const id = cat.byHip.get(Number(hip[1]));
    const s = id !== undefined ? getStar(cat, id) : null;
    if (s) hits.push({ kind: "star", id: s.id, label: starTitle(s), detail: `HIP ${s.hip} · V ${s.vmag.toFixed(2)}` });
  }
  const n = normaliseName(q);
  if (n.length >= 1) {
    const words = n.split(" ");
    // Word by word: "alpha cen" and "alpha centauri" both find "α¹ Cen".
    const wordwise = (k: string) => {
      const kw = k.split(" ");
      if (words.length > kw.length) return false;
      return words.every(
        (w, i) => kw[i].startsWith(w) || (i > 0 && kw[i].length === 3 && w.startsWith(kw[i])),
      );
    };
    const prefix: NameEntry[] = [];
    const inner: NameEntry[] = [];
    for (const e of names(cat)) {
      if (e.keys.some((k) => k.startsWith(n) || wordwise(k) || k.split(" ").some((w) => w.startsWith(n))))
        prefix.push(e);
      else if (n.length >= 3 && e.keys.some((k) => k.includes(n))) inner.push(e);
      if (prefix.length >= limit) break;
    }
    for (const e of [...prefix, ...inner]) {
      if (hits.length >= limit) break;
      if (hits.some((h) => h.kind === "star" && h.id === e.id)) continue;
      const s = getStar(cat, e.id);
      if (!s) continue;
      const other = starDesignations(s).slice(0, 2).join(" · ");
      hits.push({
        kind: "star",
        id: e.id,
        label: starTitle(s),
        detail: [other, `V ${s.vmag.toFixed(2)}`].filter(Boolean).join(" · "),
      });
    }
  }
  return hits.slice(0, limit);
}

// ------------------------------------------------------------------------------------- facts

export const CONSTELLATIONS: Record<string, string> = {
  And: "Andromeda", Ant: "Antlia", Aps: "Apus", Aqr: "Aquarius", Aql: "Aquila", Ara: "Ara", Ari: "Aries",
  Aur: "Auriga", Boo: "Boötes", Cae: "Caelum", Cam: "Camelopardalis", Cnc: "Cancer", CVn: "Canes Venatici",
  CMa: "Canis Major", CMi: "Canis Minor", Cap: "Capricornus", Car: "Carina", Cas: "Cassiopeia",
  Cen: "Centaurus", Cep: "Cepheus", Cet: "Cetus", Cha: "Chamaeleon", Cir: "Circinus", Col: "Columba",
  Com: "Coma Berenices", CrA: "Corona Australis", CrB: "Corona Borealis", Crv: "Corvus", Crt: "Crater",
  Cru: "Crux", Cyg: "Cygnus", Del: "Delphinus", Dor: "Dorado", Dra: "Draco", Equ: "Equuleus",
  Eri: "Eridanus", For: "Fornax", Gem: "Gemini", Gru: "Grus", Her: "Hercules", Hor: "Horologium",
  Hya: "Hydra", Hyi: "Hydrus", Ind: "Indus", Lac: "Lacerta", Leo: "Leo", LMi: "Leo Minor", Lep: "Lepus",
  Lib: "Libra", Lup: "Lupus", Lyn: "Lynx", Lyr: "Lyra", Men: "Mensa", Mic: "Microscopium",
  Mon: "Monoceros", Mus: "Musca", Nor: "Norma", Oct: "Octans", Oph: "Ophiuchus", Ori: "Orion",
  Pav: "Pavo", Peg: "Pegasus", Per: "Perseus", Phe: "Phoenix", Pic: "Pictor", Psc: "Pisces",
  PsA: "Piscis Austrinus", Pup: "Puppis", Pyx: "Pyxis", Ret: "Reticulum", Sge: "Sagitta",
  Sgr: "Sagittarius", Sco: "Scorpius", Scl: "Sculptor", Sct: "Scutum", Ser: "Serpens", Sex: "Sextans",
  Tau: "Taurus", Tel: "Telescopium", Tri: "Triangulum", TrA: "Triangulum Australe", Tuc: "Tucana",
  UMa: "Ursa Major", UMi: "Ursa Minor", Vel: "Vela", Vir: "Virgo", Vol: "Volans", Vul: "Vulpecula",
};

export function constellationName(abbr: string | null | undefined): string | null {
  if (!abbr) return null;
  const key = Object.keys(CONSTELLATIONS).find((k) => k.toLowerCase() === abbr.toLowerCase());
  return key ? CONSTELLATIONS[key] : null;
}

const CLASS_TEXT: Record<string, { colour: string; temp: string }> = {
  O: { colour: "blue", temp: "one of the hottest kinds of star, above 30,000 K" },
  B: { colour: "blue-white", temp: "very hot, about 10,000 to 30,000 K" },
  A: { colour: "white", temp: "hot, about 7,500 to 10,000 K" },
  F: { colour: "yellow-white", temp: "a little hotter than the Sun" },
  G: { colour: "yellow", temp: "about as hot as the Sun" },
  K: { colour: "orange", temp: "cooler than the Sun" },
  M: { colour: "red", temp: "cool, under about 3,900 K" },
  L: { colour: "deep red", temp: "a very cool brown dwarf or tiny star" },
  T: { colour: "", temp: "a cool brown dwarf" },
  Y: { colour: "", temp: "the coolest kind of brown dwarf" },
};

/** One plain-English line for a spectral type such as "K1.5III" or "A1V". */
export function spectralMeaning(sp: string | null | undefined): string | null {
  if (!sp) return null;
  const s = sp.trim();
  if (/^(D[ABOQZC]?|WD)/.test(s)) return "A white dwarf: the small, hot core left behind by a star like the Sun.";
  if (/^W[NCRO]?/.test(s)) return "A Wolf-Rayet star: very hot and massive, blowing away its outer layers.";
  if (/^(C|R|N|S)\b|^C-|^C\d|^S\d/.test(s)) return "A cool giant star whose atmosphere is rich in carbon or heavy elements.";
  const m = /^(?:sd|d|g|c)?([OBAFGKMLTY])(\d+(?:\.\d+)?)?(?:[-/][OBAFGKM]?\d*(?:\.\d+)?)?\s*/.exec(s);
  if (!m) return null;
  const cls = CLASS_TEXT[m[1]];
  const rest = s.slice(m[0].length);
  let size = "";
  if (/^(Ia\+|Ia0|0-Ia|0)(?!\d)/.test(rest) || /^I(a|ab|b)?(?![IV])/.test(rest)) size = "supergiant";
  else if (/^II(?!I)/.test(rest)) size = "bright giant";
  else if (/^III/.test(rest)) size = "giant";
  else if (/^IV/.test(rest)) size = "subgiant";
  else if (/^V(?!I)/.test(rest) || s.startsWith("d")) size = "main-sequence";
  else if (s.startsWith("sd")) size = "subdwarf";
  if (m[1] === "L" || m[1] === "T" || m[1] === "Y") return `${cls.temp[0].toUpperCase()}${cls.temp.slice(1)}.`;
  const noun =
    size === "main-sequence"
      ? `${cls.colour} main-sequence star, steadily burning hydrogen like the Sun`
      : size
        ? `${cls.colour} ${size} star`
        : `${cls.colour} star`;
  const article = /^[aeiou]/.test(noun) ? "An" : "A";
  return `${article} ${noun}; ${cls.temp}.`;
}

/** Distance in parsecs from a parallax in milliarcseconds (null when not usable). */
export function distancePc(plx: number | null | undefined): number | null {
  if (!plx || !Number.isFinite(plx) || plx <= 0) return null;
  return 1000 / plx;
}

export const LY_PER_PC = 3.261564;

/** Total proper motion (arcsec/yr) and its position angle (deg, north through east). */
export function properMotion(pmra: number | null, pmdec: number | null): { total: number; pa: number } | null {
  if (pmra === null || pmdec === null) return null;
  const total = Math.hypot(pmra, pmdec) / 1000;
  const pa = ((Math.atan2(pmra, pmdec) / DEG) % 360 + 360) % 360;
  return { total, pa };
}

/** Featured (challenge) targets as search hits, matched by name, slug or common alias. */
export const TARGET_ALIASES: Record<string, string[]> = {
  "barnards-star": ["barnard", "gj 699", "hip 87937", "v2500 oph"],
  "eps-indi-b": ["eps indi b", "epsilon indi b", "ε indi b", "eps ind b"],
  "wise-0855": ["wise 0855", "wise j0855", "wise 0855-0714"],
  "rw-aur": ["rw aur", "rw aurigae"],
  "r-dra": ["r dra", "r draconis"],
};
