"use client";
// Panel content for one of the five featured objects, in plain language: what it is, the blink
// ("Watch it move"), a simplified spectrum ("What SPHEREx sees"), where the data comes from, and
// the way into the Lab. Text comes from lib/targets.ts; images and numbers from the bundle only.

import Link from "next/link";
import { ArrowRightIcon } from "lucide-react";
import type { FieldManifest } from "@/lib/manifest";
import type { FeaturedTarget } from "@/lib/targets";
import { Button } from "@/components/ui/button";
import { Term } from "@/components/ui/term";
import type { GlossaryKey } from "@/lib/glossary";
import { formatDec, formatRa } from "@/components/globe/globe-math";
import { Rise, Section, Stagger } from "@/components/sky-panel/panel-bits";
import { MiniBlink } from "@/components/sky-panel/mini-blink";
import { SpectrumSketch } from "@/components/sky-panel/spectrum-sketch";
import { useBundle } from "@/components/sky-panel/use-bundle";

export const KIND_LABEL: Record<FeaturedTarget["kind"], string> = {
  "high-pm-star": "Nearby red dwarf",
  "brown-dwarf": "Brown dwarf",
  "young-variable": "Young variable star",
  "mira-variable": "Pulsating red giant",
  "bright-star": "Bright star",
};

/** Field of view (deg) for "Look closer in the Lab": the all-sky map near its native detail. */
const PATCH_LAB_FOV = 1.5;

/**
 * Lab link. A featured object needs only its slug: the Lab frames its prepared images itself
 * (an explicit fov would first open the Lab at that width, then jump). A patch opens the Lab's
 * all-sky map centred on it.
 */
export function labHref(slug: string | null, ra: number, dec: number): string {
  const q = new URLSearchParams();
  if (slug) {
    q.set("target", slug);
  } else {
    q.set("ra", ra.toFixed(4));
    q.set("dec", dec.toFixed(4));
    q.set("fov", String(PATCH_LAB_FOV));
  }
  return `/explore?${q.toString()}`;
}

const DATE = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});
function formatDate(iso: string | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  return Number.isNaN(d.getTime()) ? null : DATE.format(d);
}

function collectionName(c: string): string {
  const m = /^spherex_(dr|qr)(\d+)/i.exec(c);
  if (!m) return c;
  return m[1].toLowerCase() === "dr" ? `Data Release ${m[2]}` : `Quick Release ${m[2]}`;
}

export function Provenance({ manifest, fixture }: { manifest: FieldManifest; fixture: boolean }) {
  const collections = manifest.release.collections.map(collectionName);
  const latest = formatDate(manifest.release.latest_obs);
  const prepared = formatDate(manifest.generated_at);
  if (fixture) {
    return (
      <p className="text-micro text-pretty text-fg-faint" data-testid="provenance">
        {manifest.credits || "Synthetic development fixture. Contains no SPHEREx data."}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-1 text-micro text-pretty text-fg-faint" data-testid="provenance">
      <p>
        SPHEREx {collections.length ? collections.join(" and ") : "data"} from IRSA at Caltech
        {latest ? (
          <>
            , latest image <span className="readout">{latest}</span>
          </>
        ) : null}
        {prepared ? (
          <>
            . Prepared <span className="readout">{prepared}</span>
          </>
        ) : null}
        .
      </p>
      {manifest.credits && <p>{manifest.credits}</p>}
    </div>
  );
}

export function FixtureBanner() {
  return (
    <div
      role="note"
      data-testid="fixture-banner"
      className="rounded-md border border-hair-strong bg-white/[0.05] px-3 py-2.5 text-ui font-medium text-fg"
    >
      Development fixture: not real data
      <p className="mt-0.5 text-micro font-normal text-fg-dim">
        Synthetic frames stand in until this object&rsquo;s SPHEREx bundle is ready. Production builds never
        show them.
      </p>
    </div>
  );
}

/** Plain-language explanations for the technical words in the curated facts. */
const FACT_VALUE_TERM: Record<string, GlossaryKey> = {
  "Red dwarf": "redDwarf",
  "Brown-dwarf binary": "brownDwarf",
  "T Tauri binary": "tTauri",
  "Mira variable": "mira",
};

function FactText({ text, k }: { text: string; k: GlossaryKey | undefined }) {
  return k ? <Term k={k}>{text}</Term> : <>{text}</>;
}

export function TargetStory({
  target,
  headingId,
  reducedMotion,
  next,
  onSelect,
}: {
  target: FeaturedTarget;
  headingId: string;
  reducedMotion: boolean;
  next: FeaturedTarget | null;
  onSelect: (slug: string) => void;
}) {
  const bundle = useBundle(target.slug);

  return (
    <article className="flex flex-col gap-5" data-testid="target-story" data-slug={target.slug}>
      <Stagger reducedMotion={reducedMotion} className="flex flex-col gap-5">
        <Rise>
          <header className="flex flex-col gap-1.5">
            <h2 id={headingId} tabIndex={-1} className="text-title text-balance text-fg outline-none">
              {target.name}
            </h2>
            <p className="text-lead text-pretty text-fg-dim">{target.tagline}</p>
          </header>
        </Rise>

        {bundle.status === "ready" && bundle.fixture && <FixtureBanner />}

        <Rise>
          <p className="text-body text-pretty text-fg-dim">{target.summary}</p>
        </Rise>

        <Rise>
          <dl className="grid grid-cols-3 gap-x-4 gap-y-3">
            {target.facts.map((f) => (
              <div key={f.label} className="flex flex-col gap-0.5">
                <dt className="text-micro text-fg-faint">
                  {f.label}
                </dt>
                <dd className="text-ui text-pretty text-fg">
                  <FactText text={f.value} k={FACT_VALUE_TERM[f.value]} />
                </dd>
              </div>
            ))}
          </dl>
        </Rise>

        {/* Movers move; variable stars change brightness in place. Say which. */}
        <Section
          title={
            target.kind === "young-variable" || target.kind === "mira-variable" ? "Watch it change" : "Watch it move"
          }
          source="SPHEREx DR1 and QR3, IRSA"
        >
          {bundle.status === "loading" && (
            <div className="flex flex-col gap-3" aria-busy>
              <div className="aspect-square w-full animate-pulse rounded-md border border-hair bg-white/[0.03]" />
              <p className="text-meta text-fg-faint">Loading the images</p>
            </div>
          )}
          {bundle.status === "missing" && (
            <div
              className="flex flex-col gap-2 rounded-md border border-hair px-4 py-4"
              data-testid="bundle-missing"
            >
              <p className="text-ui font-medium text-fg">Images for this object are being prepared</p>
              <p className="text-meta text-pretty text-fg-dim">
                Our pipeline is <Term k="coadd">co-adding</Term> SPHEREx exposures
                of this field visit by visit. Until it finishes, the Lab can already show the SPHEREx all-sky
                map around it.
              </p>
              <p className="text-meta text-pretty text-fg-faint">
                <span className="text-fg-dim">What to look for: </span>
                {target.watchFor}
              </p>
            </div>
          )}
          {bundle.status === "ready" && (
            <MiniBlink
              manifest={bundle.manifest}
              manifestUrl={bundle.manifestUrl}
              watchFor={target.watchFor}
              reducedMotion={reducedMotion}
            />
          )}
        </Section>

        <Section
          title={
            <>
              What SPHEREx sees
            </>
          }
          source="SPHEREx spectral images, IRSA"
        >
          {bundle.status === "ready" ? (
            <SpectrumSketch manifest={bundle.manifest} reducedMotion={reducedMotion} />
          ) : bundle.status === "missing" ? (
            <p className="text-meta text-pretty text-fg-dim">
              SPHEREx splits light into 102 infrared colours. This object&rsquo;s{" "}
              spectrum will appear here with its images.
            </p>
          ) : (
            <div className="h-36 w-full animate-pulse rounded-md bg-white/[0.03]" aria-hidden />
          )}
        </Section>

        <Rise>
          <section className="flex flex-col gap-4 border-t border-hair pt-4">
            <p className="text-micro text-fg-faint">
              Position on <span className="readout">14 Nov 2026</span>:{" "}
              RA{" "}
              <span className="readout text-fg-dim">{formatRa(target.ra, 4)}</span>,{" "}
              Dec{" "}
              <span className="readout text-fg-dim">{formatDec(target.dec, 4)}</span>
            </p>
            {bundle.status === "ready" && <Provenance manifest={bundle.manifest} fixture={bundle.fixture} />}
            <div className="flex flex-wrap items-center gap-3">
              <Button asChild size="lg" className="h-10 gap-2 rounded-md px-4">
                <Link href={labHref(target.slug, target.ra, target.dec)} data-testid="open-in-lab">
                  Open in the Lab
                  <ArrowRightIcon aria-hidden />
                </Link>
              </Button>
              {next && (
                <button
                  type="button"
                  onClick={() => onSelect(next.slug)}
                  className="inline-flex h-10 items-center gap-1.5 rounded-md px-2 text-ui text-fg-dim transition-colors hover:text-fg"
                >
                  Next: {next.name}
                </button>
              )}
            </div>
          </section>
        </Rise>
      </Stagger>
    </article>
  );
}
