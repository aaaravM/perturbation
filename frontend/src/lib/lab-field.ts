// Loading FieldManifests for the Lab and turning them into blink frame lists.
//
// - A featured target loads its static bundle (public/bundles/<slug>/manifest.json). As soon as
//   the backend team drops a real bundle there it is used, with no code change.
// - Development only: if a target's bundle is missing, the synthetic fixture
//   (public/bundles/_fixture) is shown instead, moved onto the target and always under a
//   "Development fixture: not real data" banner. A production build never loads the fixture;
//   it says the data is not available yet.
// - Any other position asks the backend (/api/field/summary, then /api/field/build for D6) when
//   NEXT_PUBLIC_API_URL is set, and says so plainly when it is not.

import {
  API_URL,
  bundleUrl,
  loadBundle,
  resolveFrameUrl,
  type DetectorKey,
  type Epoch,
  type FieldManifest,
} from "@/lib/manifest";
import { findFeatured, type FeaturedTarget } from "@/lib/targets";
import { formatMonthYear, offsetArcsec, propagate, mjdToEpoch, type RaDec } from "@/lib/lab-coords";
import type { LabDetector, LabMode } from "@/lib/lab-state";

export const FIXTURE_SLUG = "_fixture";
export const IS_PRODUCTION = process.env.NODE_ENV === "production";

export const DETECTOR_KEYS: DetectorKey[] = ["D1", "D2", "D3", "D4", "D5", "D6"];

/** SPHEREx band edges (um) per detector. Frames carry their own wl_um when the backend sets it. */
export const DETECTOR_BANDS: Record<DetectorKey, [number, number]> = {
  D1: [0.75, 1.11],
  D2: [1.11, 1.64],
  D3: [1.64, 2.42],
  D4: [2.42, 3.82],
  D5: [3.82, 4.42],
  D6: [4.42, 5.0],
};

/** A cube frame in the middle of each detector, for the all-sky context layer under the blink. */
export function contextFrameFor(det: LabDetector | null, mode: LabMode): number {
  if (mode === "then-now") return 93; // D6, next to WISE W2
  if (!det || det === "rgb") return 42; // D3 middle
  return 17 * (Number(det.slice(1)) - 1) + 8;
}

export interface Coverage {
  epochs: number;
  images: number;
  exposures: number;
}

export interface StreamProgress {
  stage: string;
  done: number;
  total: number;
}

export type FieldState =
  | { status: "idle" }
  | { status: "loading"; what: "bundle" | "live"; progress?: StreamProgress; coverage?: Coverage }
  | {
      status: "ready";
      manifest: FieldManifest;
      manifestUrl: string;
      /** The fixture standing in for a target whose bundle is missing (dev only). */
      standIn: FeaturedTarget | null;
    }
  | { status: "unavailable"; reason: "no-bundle" | "no-backend"; message: string }
  | { status: "error"; message: string; retryable: boolean };

export function isFixture(state: FieldState): boolean {
  return state.status === "ready" && state.manifest.source === "fixture";
}

function shift(pos: RaDec, from: RaDec, to: RaDec): RaDec {
  const o = offsetArcsec(from, pos);
  const cosDec = Math.max(Math.cos((to.dec * Math.PI) / 180), 1e-6);
  return { ra: (((to.ra + o.east / 3600 / cosDec) % 360) + 360) % 360, dec: to.dec + o.north / 3600 };
}

/** Move the fixture onto a featured target so the Lab can be built around any of the five. */
export function recentreFixture(fixture: FieldManifest, target: FeaturedTarget): FieldManifest {
  const from = { ra: fixture.center.ra, dec: fixture.center.dec };
  const to = { ra: target.ra, dec: target.dec };
  const move = (p: RaDec) => shift(p, from, to);
  const motion = fixture.motion
    ? {
        ...fixture.motion,
        epoch_positions: fixture.motion.epoch_positions.map((p) => ({ ...p, ...move(p) })),
        predicted_path: fixture.motion.predicted_path.map(([ra, dec]) => {
          const m = move({ ra, dec });
          return [m.ra, m.dec] as [number, number];
        }),
      }
    : null;
  const astro = fixture.target?.astrometry;
  return {
    ...fixture,
    target: fixture.target
      ? {
          ...fixture.target,
          astrometry: astro ? { ...astro, ...move(astro) } : astro!,
        }
      : null,
    center: { ...fixture.center, ...to },
    grid: { ...fixture.grid, wcs: { ...fixture.grid.wcs, CRVAL1: to.ra, CRVAL2: to.dec } },
    motion,
  };
}

function httpStatus(err: unknown): number | null {
  const m = err instanceof Error ? /HTTP (\d{3})/.exec(err.message) : null;
  return m ? Number(m[1]) : null;
}

export async function loadTargetField(slug: string, signal?: AbortSignal): Promise<FieldState> {
  if (slug === FIXTURE_SLUG) {
    if (IS_PRODUCTION) {
      return { status: "unavailable", reason: "no-bundle", message: "The development fixture is not part of this build." };
    }
    const manifest = await loadBundle(FIXTURE_SLUG, { signal });
    return { status: "ready", manifest, manifestUrl: bundleUrl(FIXTURE_SLUG), standIn: null };
  }
  const featured = findFeatured(slug);
  try {
    const manifest = await loadBundle(slug, { signal });
    return { status: "ready", manifest, manifestUrl: bundleUrl(slug), standIn: null };
  } catch (err) {
    if (signal?.aborted) throw err;
    const status = httpStatus(err);
    const missing = status === 404;
    if (!missing) {
      return {
        status: "error",
        message: `The prepared frames for ${featured?.name ?? slug} could not be read (${err instanceof Error ? err.message : "unknown error"}).`,
        retryable: true,
      };
    }
    if (IS_PRODUCTION || !featured) {
      return {
        status: "unavailable",
        reason: "no-bundle",
        message: featured
          ? `SPHEREx frames for ${featured.name} are being prepared and are not available yet.`
          : `There is no prepared field called “${slug}”.`,
      };
    }
    const fixture = await loadBundle(FIXTURE_SLUG, { signal });
    return {
      status: "ready",
      manifest: recentreFixture(fixture, featured),
      manifestUrl: bundleUrl(FIXTURE_SLUG),
      standIn: featured,
    };
  }
}

/** The backend's error shape (API contract section 2): {error, message, retryable}. */
async function apiFailure(res: Response): Promise<FieldState> {
  let body: { error?: string; message?: string; retryable?: boolean } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    // not JSON
  }
  if (res.status === 404 && body.error === "no_coverage") {
    return {
      status: "unavailable",
      reason: "no-bundle",
      message: body.message ?? "SPHEREx has not released any images of this position yet.",
    };
  }
  return {
    status: "error",
    message: body.message ?? `The backend answered HTTP ${res.status}.`,
    retryable: body.retryable ?? res.status >= 500,
  };
}

/**
 * Build a live field for any position (API contract section 2): coverage first from
 * /api/field/summary (a few seconds), then the frames of the default detector, D6, from
 * /api/field/build (one detector per request, frames inline as data: URLs). Resolves with the
 * final state; reports intermediate states via onState.
 */
export function loadLiveField(
  pos: RaDec,
  fovArcmin: number,
  onState: (state: FieldState) => void,
  signal: AbortSignal,
): Promise<FieldState> {
  if (!API_URL) {
    return Promise.resolve({
      status: "unavailable",
      reason: "no-backend",
      message:
        "Frames for a new patch of sky are built on demand by the Perturbation backend, which is not connected to this site yet.",
    });
  }
  // Rounded the same way every time, so repeats hit the backend's CDN cache.
  const query = `ra=${pos.ra.toFixed(5)}&dec=${pos.dec.toFixed(5)}&fov=${fovArcmin.toFixed(1)}`;
  return (async (): Promise<FieldState> => {
    onState({ status: "loading", what: "live", progress: { stage: "search", done: 0, total: 0 } });
    let coverage: Coverage | undefined;
    try {
      const res = await fetch(`${API_URL}/api/field/summary?${query}`, { signal });
      if (res.ok) {
        const body = (await res.json()) as {
          n_epochs?: number;
          epochs?: unknown[] | number;
          n_images?: number;
          n_exposures?: number;
        };
        coverage = {
          epochs: Number(body.n_epochs ?? (Array.isArray(body.epochs) ? body.epochs.length : (body.epochs ?? 0))),
          images: Number(body.n_images ?? 0),
          exposures: Number(body.n_exposures ?? 0),
        };
        if (coverage.images === 0) {
          return {
            status: "unavailable",
            reason: "no-bundle",
            message: "SPHEREx has not released any images of this position yet.",
          };
        }
      } else if (res.status === 404 || res.status === 422) {
        return apiFailure(res);
      }
    } catch (err) {
      if (signal.aborted) throw err;
      // Coverage is a nicety; the build below reports its own errors.
    }

    onState({ status: "loading", what: "live", coverage, progress: { stage: "coadd", done: 0, total: 0 } });
    let res: Response;
    try {
      res = await fetch(`${API_URL}/api/field/build?${query}&det=D6&modes=epoch,difference,flags`, { signal });
    } catch (err) {
      if (signal.aborted) throw err;
      return { status: "error", message: "The Perturbation backend could not be reached.", retryable: true };
    }
    if (!res.ok) return apiFailure(res);
    let manifest: FieldManifest;
    try {
      manifest = (await res.json()) as FieldManifest;
    } catch {
      return { status: "error", message: "The backend sent a field this page cannot read.", retryable: true };
    }
    if (manifest.schema !== "pxh-field/1") {
      return { status: "error", message: "The backend sent a field this page cannot read.", retryable: true };
    }
    return { status: "ready", manifest, manifestUrl: `${API_URL}/api/field/build`, standIn: null };
  })();
}

// ---------------------------------------------------------------------------------------------
// Frames for the current mode
// ---------------------------------------------------------------------------------------------

export interface BlinkFrame {
  /** Stable identity for layer caching. */
  key: string;
  url: string;
  mjd: number;
  /** "Aug 2025", "WISE 2010", "May 2025 → Oct 2026" */
  label: string;
  /** "S2", "AllWISE W2 4.6 µm", "Last minus first epoch" */
  detail: string;
  epoch: Epoch | null;
  partial: boolean;
  /** Diverging colour map for a difference image in sigma. */
  diverging?: { limits: [number, number] };
  /** Difference images: the two epochs compared (labels). */
  compare?: { first: string; last: string };
  flags?: { url: string; legend: Record<string, string> };
}

export function availableDetectors(manifest: FieldManifest): LabDetector[] {
  const dets: LabDetector[] = DETECTOR_KEYS.filter((d) => (manifest.frames.epoch[d]?.length ?? 0) > 0);
  if ((manifest.frames.epoch.rgb?.length ?? 0) > 0) dets.push("rgb");
  return dets;
}

export function differenceDetectors(manifest: FieldManifest): DetectorKey[] {
  return DETECTOR_KEYS.filter((d) => manifest.frames.difference.some((f) => f.detector === d));
}

/** The detector to show: the URL's, else D6 (best for motion and cool objects), else the first. */
export function resolveDetector(manifest: FieldManifest, mode: LabMode, requested: LabDetector | null): LabDetector | null {
  const options: LabDetector[] = mode === "difference" ? differenceDetectors(manifest) : availableDetectors(manifest);
  if (requested && options.includes(requested)) return requested;
  if (options.includes("D6")) return "D6";
  return options[0] ?? null;
}

export function framesFor(manifest: FieldManifest, manifestUrl: string, mode: LabMode, det: LabDetector | null): BlinkFrame[] {
  // Live manifests carry absolute URLs; a root-relative one still belongs to the backend.
  const abs = (url: string) =>
    /^(data|blob):/.test(url)
      ? url // live frames arrive inline
      : manifest.source === "live" && API_URL && url.startsWith("/") && !url.startsWith("//")
        ? `${API_URL}${url}`
        : resolveFrameUrl(manifestUrl, url);
  const epochOf = (index: number) => manifest.epochs.find((e) => e.index === index) ?? null;
  if (mode === "then-now") {
    return manifest.frames.then_vs_now.map((f) => ({
      key: `tn|${abs(f.url)}`,
      url: abs(f.url),
      mjd: f.mjd,
      label: f.label,
      detail: f.instrument,
      epoch: null,
      partial: false,
    }));
  }
  if (mode === "difference") {
    const d = manifest.frames.difference.find((f) => f.detector === det);
    if (!d) return [];
    const a = epochOf(d.a);
    const b = epochOf(d.b);
    return [
      {
        key: `diff|${abs(d.url)}`,
        url: abs(d.url),
        mjd: a?.mjd_mid ?? 0,
        label: `${b?.label ?? `Epoch ${d.b}`} → ${a?.label ?? `Epoch ${d.a}`}`,
        detail: `${d.detector}, last minus first epoch`,
        epoch: a,
        partial: Boolean((a && !a.full) || (b && !b.full)),
        diverging: { limits: d.limits },
        compare: { first: b?.label ?? `epoch ${d.b}`, last: a?.label ?? `epoch ${d.a}` },
      },
    ];
  }
  if (!det) return [];
  const list = manifest.frames.epoch[det] ?? [];
  return [...list]
    .sort((x, y) => x.mjd - y.mjd)
    .map((f) => {
      const epoch = epochOf(f.epoch);
      const flags =
        det === "rgb" ? undefined : manifest.frames.flags.find((fl) => fl.detector === det && fl.epoch === f.epoch);
      return {
        key: `ep|${abs(f.url)}`,
        url: abs(f.url),
        mjd: f.mjd,
        label: epoch?.label ?? formatMonthYear(f.mjd),
        detail: epoch?.survey ?? "",
        epoch,
        partial: epoch ? !epoch.full : false,
        flags: flags ? { url: abs(flags.url), legend: flags.legend } : undefined,
      };
    });
}

/** Wavelength range for a detector, from the frames when present. */
export function detectorRange(manifest: FieldManifest | null, det: DetectorKey): [number, number] {
  const wl = manifest?.frames.epoch[det]?.find((f) => f.wl_um)?.wl_um;
  return wl ?? DETECTOR_BANDS[det];
}

/**
 * Where the target is at each frame's date: measured epoch positions when the backend measured
 * them, else the catalogue motion. Used for the marker that follows the blink.
 */
export function positionAt(manifest: FieldManifest, frame: BlinkFrame): RaDec | null {
  const measured = frame.epoch && manifest.motion?.epoch_positions.find((p) => p.epoch === frame.epoch!.index);
  if (measured) return { ra: measured.ra, dec: measured.dec };
  const astro = manifest.target?.astrometry;
  if (!astro) return null;
  if (!manifest.target || (astro.pmra === 0 && astro.pmdec === 0)) return { ra: astro.ra, dec: astro.dec };
  return propagate(astro, astro.ref_epoch, mjdToEpoch(frame.mjd));
}

/** The motion path to draw: the backend's predicted path, or catalogue motion across the frames. */
export function motionPath(manifest: FieldManifest, frames: BlinkFrame[], mode: LabMode): [number, number][] {
  if (mode !== "then-now" && manifest.motion?.predicted_path?.length) return manifest.motion.predicted_path;
  const astro = manifest.target?.astrometry;
  if (!astro || frames.length < 2) return [];
  const mjds = frames.map((f) => f.mjd).sort((a, b) => a - b);
  const first = mjds[0];
  const last = mjds[mjds.length - 1];
  const steps = 12;
  return Array.from({ length: steps + 1 }, (_, i) => {
    const p = propagate(astro, astro.ref_epoch, mjdToEpoch(first + ((last - first) * i) / steps));
    return [p.ra, p.dec] as [number, number];
  });
}
