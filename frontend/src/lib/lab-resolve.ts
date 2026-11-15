// Name and coordinate resolution for the Lab search box, in this order:
//   1. coordinates typed directly (decimal or sexagesimal)
//   2. featured-target aliases (instant, and the only way "WISE 0855-0714" resolves at all)
//   3. the backend's /api/resolve, when NEXT_PUBLIC_API_URL is set
//   4. otherwise the CfA mirror of Sesame (CDS Strasbourg itself is degraded)
// Catalogue (J2000) positions are moved to today with their proper motion, linearly.

import { API_URL } from "@/lib/manifest";
import { FEATURED_TARGETS, type FeaturedTarget } from "@/lib/targets";
import { mjdNow, mjdToEpoch, parseCoordinates, propagate } from "@/lib/lab-coords";

export const SESAME_MIRROR = "https://vizier.cfa.harvard.edu/viz-bin/nph-sesame/-oxp/SNV";

export interface ResolvedPlace {
  /** Display name ("Barnard's Star", or the coordinates as typed). */
  name: string;
  ra: number;
  dec: number;
  kind: "coordinates" | "featured" | "backend" | "sesame";
  /** Featured target slug, when the name is one of the five. */
  slug?: string;
  raJ2000?: number;
  decJ2000?: number;
  pmra?: number;
  pmdec?: number;
  /** Plain sentence on where the position came from. */
  provenance: string;
}

export class ResolveError extends Error {
  constructor(
    message: string,
    readonly reason: "not-found" | "unavailable",
  ) {
    super(message);
  }
}

/** Extra names people type for the five targets (beyond the slug and display name). */
const EXTRA_ALIASES: Record<string, string[]> = {
  "barnards-star": ["Barnard", "Barnard's star", "GJ 699", "Gl 699", "V2500 Oph", "HIP 87937", "BD+04 3561a"],
  "eps-indi-b": ["Eps Indi B", "Epsilon Indi Ba", "Epsilon Indi Bb", "eps Ind B", "eps Ind Ba", "ε Indi B", "GJ 845 B"],
  "wise-0855": ["WISE 0855", "WISE 0855-0714", "WISE J085510.83-071442.5", "W0855", "WISE J0855-0714"],
  "rw-aur": ["RW Aur", "RW Aurigae", "RW Aur A"],
  "r-dra": ["R Dra", "R Draconis"],
};

/** Where a featured target's astrometry comes from, when it is not Gaia DR3 (see lib/targets.ts). */
const FEATURED_ASTROMETRY: Record<string, string> = {
  "wise-0855": "Kirkpatrick et al. 2021 (Spitzer)",
};

function aliasKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[−–—]/g, "-")
    .replace(/ε/g, "eps")
    .replace(/epsilon/g, "eps")
    .replace(/[^a-z0-9]/g, "");
}

const ALIAS_INDEX = new Map<string, FeaturedTarget>();
for (const target of FEATURED_TARGETS) {
  for (const name of [target.slug, target.name, ...(EXTRA_ALIASES[target.slug] ?? [])]) {
    ALIAS_INDEX.set(aliasKey(name), target);
  }
}

export function findFeaturedByName(text: string): FeaturedTarget | undefined {
  return ALIAS_INDEX.get(aliasKey(text));
}

/** Featured targets whose current position lies within `radiusDeg` of a point. */
export function featuredNear(ra: number, dec: number, radiusDeg: number): FeaturedTarget[] {
  const r = Math.PI / 180;
  return FEATURED_TARGETS.filter((t) => {
    const c =
      Math.sin(dec * r) * Math.sin(t.dec * r) + Math.cos(dec * r) * Math.cos(t.dec * r) * Math.cos((ra - t.ra) * r);
    return Math.acos(Math.min(1, Math.max(-1, c))) / r <= radiusDeg;
  });
}

function text(el: Element | null | undefined, tag: string): string | undefined {
  const value = el?.getElementsByTagName(tag)[0]?.textContent?.trim();
  return value ? value : undefined;
}

async function resolveWithBackend(query: string, signal?: AbortSignal): Promise<ResolvedPlace> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}/api/resolve?q=${encodeURIComponent(query)}`, { signal });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new ResolveError("The name service could not be reached.", "unavailable");
  }
  if (res.status === 404) throw new ResolveError(`No object called “${query}” was found.`, "not-found");
  if (!res.ok) throw new ResolveError(`The name service answered HTTP ${res.status}.`, "unavailable");
  const body = (await res.json()) as {
    name?: string;
    ra: number;
    dec: number;
    ra_j2000?: number;
    dec_j2000?: number;
    pmra?: number;
    pmdec?: number;
    resolver?: string;
    target_key?: string | null;
  };
  return {
    name: body.name ?? query,
    ra: body.ra,
    dec: body.dec,
    kind: "backend",
    slug: body.target_key ?? undefined,
    raJ2000: body.ra_j2000,
    decJ2000: body.dec_j2000,
    pmra: body.pmra,
    pmdec: body.pmdec,
    provenance: `Resolved by ${body.resolver ?? "the Planet X Hunter backend"}, moved to today with its proper motion.`,
  };
}

async function resolveWithSesame(query: string, signal?: AbortSignal): Promise<ResolvedPlace> {
  let res: Response;
  try {
    res = await fetch(`${SESAME_MIRROR}?${encodeURIComponent(query)}`, { signal });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new ResolveError("The Sesame name service (CfA mirror) could not be reached.", "unavailable");
  }
  if (!res.ok) throw new ResolveError(`The Sesame name service answered HTTP ${res.status}.`, "unavailable");
  const xml = new DOMParser().parseFromString(await res.text(), "text/xml");
  const resolver = [...xml.getElementsByTagName("Resolver")].find((r) => text(r, "jradeg") && text(r, "jdedeg"));
  if (!resolver) throw new ResolveError(`No object called “${query}” was found.`, "not-found");
  const raJ2000 = Number(text(resolver, "jradeg"));
  const decJ2000 = Number(text(resolver, "jdedeg"));
  const pm = resolver.getElementsByTagName("pm")[0];
  const pmra = Number(text(pm, "pmRA") ?? 0);
  const pmdec = Number(text(pm, "pmDE") ?? 0);
  const hasPm = Number.isFinite(pmra) && Number.isFinite(pmdec) && (pmra !== 0 || pmdec !== 0);
  const now = hasPm
    ? propagate({ ra: raJ2000, dec: decJ2000, pmra, pmdec }, 2000, mjdToEpoch(mjdNow()))
    : { ra: raJ2000, dec: decJ2000 };
  const service = resolver.getAttribute("name")?.split(/[=(]/)[1]?.trim() || "Sesame";
  return {
    name: text(resolver, "oname") ?? query,
    ra: now.ra,
    dec: now.dec,
    kind: "sesame",
    raJ2000,
    decJ2000,
    pmra: hasPm ? pmra : undefined,
    pmdec: hasPm ? pmdec : undefined,
    provenance: hasPm
      ? `J2000 position from ${service} via Sesame (CfA mirror), moved to today with its proper motion.`
      : `Position from ${service} via Sesame (CfA mirror).`,
  };
}

export async function resolveQuery(query: string, signal?: AbortSignal): Promise<ResolvedPlace> {
  const trimmed = query.trim();
  if (!trimmed) throw new ResolveError("Type a name or coordinates.", "not-found");

  const coords = parseCoordinates(trimmed);
  if (coords) {
    return { name: trimmed, ...coords, kind: "coordinates", provenance: "Coordinates as typed (ICRS)." };
  }

  const featured = findFeaturedByName(trimmed);
  if (featured) {
    return {
      name: featured.name,
      ra: featured.ra,
      dec: featured.dec,
      kind: "featured",
      slug: featured.slug,
      provenance: `Featured target: position today, from ${FEATURED_ASTROMETRY[featured.slug] ?? "Gaia DR3"} moved with its proper motion and parallax.`,
    };
  }

  return API_URL ? resolveWithBackend(trimmed, signal) : resolveWithSesame(trimmed, signal);
}
