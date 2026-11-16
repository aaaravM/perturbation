// The search's list of finds (public/discoveries/candidates.json, schema in public/discoveries/README.md):
// types, a defensive parser, and the small helpers the AI page uses. It loads the list with
// components/ai/results.tsx.
//
// The file is written by scripts/run_discovery.py and can be regenerated at any time, so nothing
// here trusts it: an entry with a missing or impossible value is dropped (and counted), optional
// parts that do not parse become null, and every URL is checked to stay on this site.

export const DISCOVERIES_URL = "/discoveries/candidates.json";

export type CandidateKind = "mover" | "variable";
export const CLASS_NAMES = ["mover", "variable", "artifact", "nothing"] as const;
export type ClassName = (typeof CLASS_NAMES)[number];

export interface CandidateMotion {
  pm_arcsec_yr: number;
  pm_err_arcsec_yr: number | null;
  /** Direction of motion, degrees east of north. */
  pa_deg: number | null;
  n_epochs: number | null;
}

export interface CandidateVariability {
  /** Later minus earlier magnitude: negative is brighter. */
  delta_mag: number;
  sigma: number | null;
}

export interface CandidateMatch {
  status: "known" | "unknown";
  catalog: string | null;
  name: string | null;
  id: string | null;
  sep_arcsec: number | null;
  catalog_pm_arcsec_yr: number | null;
}

export interface Candidate {
  id: string;
  field: string;
  ra: number;
  dec: number;
  kind: CandidateKind;
  /** P(mover) + P(variable), calibrated. */
  score: number;
  probs: Record<ClassName, number>;
  p_value: number | null;
  q_value: number;
  snr: number | null;
  motion: CandidateMotion | null;
  variability: CandidateVariability | null;
  detectors: string[];
  /** Dates (YYYY-MM-DD) of the earlier and later epoch compared, or null when the file has none. */
  epochs: [string, string] | null;
  match: CandidateMatch;
  /** Same-site PNG strip (earlier | later | difference), or null when there is none. */
  stamp: string | null;
  /** Same-site link into the Lab. */
  lab_url: string;
}

export interface SurveyField {
  id: string;
  name: string;
  kind: string;
  ra: number | null;
  dec: number | null;
  fov_deg: number | null;
  n_epochs: number | null;
  n_candidates: number | null;
  n_kept: number | null;
}

export interface ModelMetrics {
  test_accuracy?: number;
  mover_completeness_snr10?: number;
  variable_completeness_snr10?: number;
  false_alarms_per_deg2_q05?: number;
  mover_completeness_shift_ge_1px_snr10?: number;
  false_alarms_area_deg2?: number;
  false_alarms_per_deg2_q05_upper95?: number;
}

export interface TargetCheck {
  field: string;
  name: string;
  expected: CandidateKind | null;
  catalog_pm_arcsec_yr: number | null;
  radius_arcsec: number | null;
  /** Candidates within the radius of the predicted position. */
  family: number | null;
  q_target: number | null;
  sep_arcsec: number | null;
  found: boolean;
  candidate: Candidate | null;
}

export interface Discoveries {
  version: 1;
  /** ISO time of the run, or null. */
  generated: string | null;
  model: { name: string | null; trained_on: string | null; metrics: ModelMetrics };
  fdr: { method: string | null; alpha: number | null };
  survey: { n_fields: number | null; area_deg2: number | null; detectors: string[]; epochs_median: number | null };
  fields: SurveyField[];
  candidates: Candidate[];
  targets: TargetCheck[];
  /** Entries that were in the file but did not pass the checks. */
  dropped: number;
}

// ------------------------------------------------------------------------------ parsing

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const int = (v: unknown): number | null => {
  const n = num(v);
  return n !== null && Number.isInteger(n) && n >= 0 ? n : null;
};
const prob = (v: unknown): number | null => {
  const n = num(v);
  return n !== null && n >= 0 && n <= 1 ? n : null;
};
const text = (v: unknown, max = 400): string | null =>
  typeof v === "string" && v.trim().length > 0 && v.length <= max ? v.trim() : null;

const SAFE_ID = /^[A-Za-z0-9][\w.+-]{0,119}$/;
const SAFE_STAMP = /^\/discoveries\/stamps\/[\w.+-]+\.png$/;
const DATA_STAMP = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/;
const SAFE_LAB = /^\/explore\?[\w.~=&%+:,-]*$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DETECTOR = /^D[1-6]$/;

function parseMotion(v: unknown): CandidateMotion | null {
  if (!isObj(v)) return null;
  const pm = num(v.pm_arcsec_yr);
  if (pm === null || pm < 0) return null;
  const err = num(v.pm_err_arcsec_yr);
  const pa = num(v.pa_deg);
  return {
    pm_arcsec_yr: pm,
    pm_err_arcsec_yr: err !== null && err >= 0 ? err : null,
    pa_deg: pa !== null ? ((pa % 360) + 360) % 360 : null,
    n_epochs: int(v.n_epochs),
  };
}

function parseVariability(v: unknown): CandidateVariability | null {
  if (!isObj(v)) return null;
  const dm = num(v.delta_mag);
  if (dm === null || Math.abs(dm) > 20) return null;
  const sigma = num(v.sigma);
  return { delta_mag: dm, sigma: sigma !== null ? Math.abs(sigma) : null };
}

function parseMatch(v: unknown): CandidateMatch {
  const m = isObj(v) ? v : {};
  const sep = num(m.sep_arcsec);
  const pm = num(m.catalog_pm_arcsec_yr);
  return {
    status: m.status === "known" ? "known" : "unknown",
    catalog: text(m.catalog, 60),
    name: text(m.name, 120),
    id: text(m.id, 120),
    sep_arcsec: sep !== null && sep >= 0 ? sep : null,
    catalog_pm_arcsec_yr: pm !== null && pm >= 0 ? pm : null,
  };
}

/** One candidate, or null when a value it cannot do without is missing or impossible. */
export function parseCandidate(v: unknown): Candidate | null {
  if (!isObj(v)) return null;
  const id = typeof v.id === "string" && SAFE_ID.test(v.id) ? v.id : null;
  const field = typeof v.field === "string" && SAFE_ID.test(v.field) ? v.field : null;
  const ra = num(v.ra);
  const dec = num(v.dec);
  const kind = v.kind === "mover" || v.kind === "variable" ? v.kind : null;
  const q = prob(v.q_value);
  if (!id || !field || ra === null || ra < 0 || ra >= 360 || dec === null || Math.abs(dec) > 90 || !kind || q === null)
    return null;

  const rawProbs = isObj(v.probs) ? v.probs : {};
  const probs = {} as Record<ClassName, number>;
  for (const c of CLASS_NAMES) {
    const p = prob(rawProbs[c]);
    if (p === null) return null;
    probs[c] = p;
  }
  const scoreRaw = num(v.score);
  const score = scoreRaw !== null && scoreRaw >= 0 && scoreRaw <= 1.0001 ? Math.min(scoreRaw, 1) : probs.mover + probs.variable;
  const snr = num(v.snr);

  const epochs =
    Array.isArray(v.epochs) &&
    v.epochs.length === 2 &&
    v.epochs.every((d) => typeof d === "string" && ISO_DATE.test(d) && !Number.isNaN(Date.parse(d)))
      ? ([v.epochs[0], v.epochs[1]] as [string, string])
      : null;

  const stamp = typeof v.stamp === "string" && (SAFE_STAMP.test(v.stamp) || DATA_STAMP.test(v.stamp)) ? v.stamp : null;
  const lab_url =
    typeof v.lab_url === "string" && SAFE_LAB.test(v.lab_url)
      ? v.lab_url
      : `/explore?ra=${ra.toFixed(5)}&dec=${dec.toFixed(5)}&fov=0.1667`;

  return {
    id,
    field,
    ra,
    dec,
    kind,
    score,
    probs,
    p_value: prob(v.p_value),
    q_value: q,
    snr: snr !== null ? Math.abs(snr) : null,
    motion: kind === "mover" ? parseMotion(v.motion) : null,
    variability: parseVariability(v.variability),
    detectors: Array.isArray(v.detectors) ? v.detectors.filter((d): d is string => typeof d === "string" && DETECTOR.test(d)) : [],
    epochs,
    match: parseMatch(v.match),
    stamp,
    lab_url,
  };
}

function parseField(v: unknown): SurveyField | null {
  if (!isObj(v)) return null;
  const id = typeof v.id === "string" && SAFE_ID.test(v.id) ? v.id : null;
  if (!id) return null;
  return {
    id,
    name: text(v.name, 120) ?? id,
    kind: text(v.kind, 40) ?? "field",
    ra: num(v.ra),
    dec: num(v.dec),
    fov_deg: num(v.fov_deg),
    n_epochs: int(v.n_epochs),
    n_candidates: int(v.n_candidates),
    n_kept: int(v.n_kept),
  };
}

function parseTarget(v: unknown): TargetCheck | null {
  if (!isObj(v)) return null;
  const field = typeof v.field === "string" && SAFE_ID.test(v.field) ? v.field : null;
  const name = text(v.name, 120);
  if (!field || !name) return null;
  const candidate = parseCandidate(v.candidate);
  const q = prob(v.q_target);
  return {
    field,
    name,
    expected: v.expected === "mover" || v.expected === "variable" ? v.expected : null,
    catalog_pm_arcsec_yr: num(v.catalog_pm_arcsec_yr),
    radius_arcsec: num(v.radius_arcsec),
    family: int(v.family),
    q_target: q,
    sep_arcsec: num(v.sep_arcsec),
    // Only claim "found" when the file says so and the evidence is there.
    found: v.found === true && candidate !== null && q !== null,
    candidate,
  };
}

const METRIC_KEYS = [
  "test_accuracy",
  "mover_completeness_snr10",
  "variable_completeness_snr10",
  "false_alarms_per_deg2_q05",
  "mover_completeness_shift_ge_1px_snr10",
  "false_alarms_area_deg2",
  "false_alarms_per_deg2_q05_upper95",
] as const satisfies readonly (keyof ModelMetrics)[];

/** Parse and check the whole file. Throws only when it is not a version-1 Discoveries file at all. */
export function parseDiscoveries(raw: unknown): Discoveries {
  if (!isObj(raw)) throw new Error("The candidate list is not a JSON object.");
  if (raw.version !== 1) throw new Error(`Unknown candidate list version: ${String(raw.version)}.`);

  const rawCandidates = Array.isArray(raw.candidates) ? raw.candidates : [];
  const seen = new Set<string>();
  const candidates: Candidate[] = [];
  for (const entry of rawCandidates) {
    const c = parseCandidate(entry);
    if (!c || seen.has(c.id)) continue;
    seen.add(c.id);
    candidates.push(c);
  }
  candidates.sort(byConfidence);

  const model = isObj(raw.model) ? raw.model : {};
  const rawMetrics = isObj(model.metrics) ? model.metrics : {};
  const metrics: ModelMetrics = {};
  for (const k of METRIC_KEYS) {
    const n = num(rawMetrics[k]);
    if (n !== null && n >= 0) metrics[k] = n;
  }

  const fdr = isObj(raw.fdr) ? raw.fdr : {};
  const survey = isObj(raw.survey) ? raw.survey : {};
  const generated = typeof raw.generated === "string" && !Number.isNaN(Date.parse(raw.generated)) ? raw.generated : null;
  const area = num(survey.area_deg2);
  const median = num(survey.epochs_median);

  return {
    version: 1,
    generated,
    model: { name: text(model.name, 80), trained_on: text(model.trained_on, 600), metrics },
    fdr: { method: text(fdr.method, 400), alpha: prob(fdr.alpha) },
    survey: {
      n_fields: int(survey.n_fields),
      area_deg2: area !== null && area >= 0 ? area : null,
      detectors: Array.isArray(survey.detectors)
        ? survey.detectors.filter((d): d is string => typeof d === "string" && DETECTOR.test(d))
        : [],
      epochs_median: median !== null && median >= 0 ? median : null,
    },
    fields: (Array.isArray(raw.fields) ? raw.fields : []).map(parseField).filter((f): f is SurveyField => f !== null),
    candidates,
    targets: (Array.isArray(raw.targets) ? raw.targets : []).map(parseTarget).filter((t): t is TargetCheck => t !== null),
    dropped: rawCandidates.length - candidates.length,
  };
}

// ------------------------------------------------------------------------------ helpers

/** The most trustworthy first: lowest q, then highest score. */
export function byConfidence(a: Candidate, b: Candidate): number {
  return a.q_value - b.q_value || b.score - a.score || a.id.localeCompare(b.id);
}

export const FDR_LEVELS = [0.01, 0.05, 0.1, 0.2] as const;
export type FdrLevel = (typeof FDR_LEVELS)[number];
export const DEFAULT_FDR: FdrLevel = 0.05;

/** "1 in 20" for 0.05. */
export function oneIn(alpha: number): string {
  return `1 in ${Math.round(1 / alpha)}`;
}

export function percent(x: number, digits = 0): string {
  return `${(x * 100).toFixed(digits)}%`;
}

/** A probability as a percentage, without rounding a small one down to "0%". */
export function probPercent(p: number): string {
  if (p > 0 && p < 0.005) return "<1%";
  if (p < 1 && p > 0.995) return ">99%";
  return percent(p);
}

/** A q-value or p-value: small ones in scientific-ish plain form, never "0". */
export function formatQ(q: number): string {
  if (q === 0) return "< 0.0001";
  if (q < 0.0001) return "< 0.0001";
  if (q < 0.01) return q.toFixed(4);
  return q.toFixed(3);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2025-07-22" -> "22 Jul 2025" (no time zone involved). */
export function formatDay(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${MONTHS[m - 1] ?? "?"} ${y}`;
}

/** "2025-07-22" -> "Jul 2025". */
export function formatMonth(iso: string): string {
  const [y, m] = iso.split("-").map(Number);
  return `${MONTHS[m - 1] ?? "?"} ${y}`;
}

/** Days between the two compared epochs. */
export function daysBetween(epochs: [string, string]): number {
  return Math.round((Date.parse(epochs[1]) - Date.parse(epochs[0])) / 86_400_000);
}

/** "2026-11-15T07:09:45Z" -> "15 Nov 2026, 07:09 UTC". */
export function formatRun(iso: string): string {
  const d = new Date(iso);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${hh}:${mm} UTC`;
}

const COMPASS = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];

/** Position angle (degrees east of north) as a compass word. */
export function compass(paDeg: number): string {
  return COMPASS[Math.round((((paDeg % 360) + 360) % 360) / 45) % 8];
}

export const KIND_LABEL: Record<CandidateKind, string> = { mover: "Moves", variable: "Changes brightness" };
export const CLASS_LABEL: Record<ClassName, string> = {
  mover: "Mover",
  variable: "Changes brightness",
  artifact: "Artifact",
  nothing: "Nothing",
};

/** The field's display name, or its id. */
export function fieldName(data: Pick<Discoveries, "fields">, id: string): string {
  return data.fields.find((f) => f.id === id)?.name ?? id;
}

/** How a brightness change reads: "1.3 times brighter" / "fainter by 0.32 mag". */
export function brightnessWords(v: CandidateVariability): string {
  const factor = 10 ** (-0.4 * v.delta_mag);
  if (Math.abs(v.delta_mag) < 0.005) return "No measurable change";
  return factor >= 1
    ? `${factor.toFixed(factor < 10 ? 2 : 0)} times brighter later`
    : `${(1 / factor).toFixed(1 / factor < 10 ? 2 : 0)} times fainter later`;
}
