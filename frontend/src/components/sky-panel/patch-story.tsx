"use client";
// Panel content for any clicked point of the globe: where it is, what kind of sky it is (from its
// distance to the plane of the Milky Way), the nearest featured object, how often SPHEREx has
// looked there (only when the live service is configured and answers), and the way into the Lab.

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRightIcon } from "lucide-react";
import { API_URL } from "@/lib/manifest";
import type { FeaturedTarget } from "@/lib/targets";
import { Button } from "@/components/ui/button";
import { angularDistance, formatDec, formatRa, galacticLatitude } from "@/components/globe/globe-math";
import { labHref } from "@/components/sky-panel/target-story";

function describe(b: number): string {
  const a = Math.abs(b);
  if (a < 8)
    return "It lies in the plane of the Milky Way, where stars and dust crowd together and glow brightly in the infrared.";
  if (a < 25) return "It lies close to the Milky Way, so the view is still rich in stars.";
  return "It lies well away from the plane of the Milky Way, so we look out of our galaxy through fewer stars and less dust.";
}

type Visits =
  | { state: "off" }
  | { state: "loading" }
  | { state: "ok"; epochs: number; exposures: number | null }
  | { state: "error" };

function useVisits(ra: number, dec: number): Visits {
  const [result, setResult] = useState<{ key: string; value: Visits }>({
    key: "",
    value: { state: "loading" },
  });
  const key = `${ra.toFixed(4)},${dec.toFixed(4)}`;
  useEffect(() => {
    if (!API_URL) return;
    const controller = new AbortController();
    const url = `${API_URL}/api/field/summary?ra=${ra.toFixed(5)}&dec=${dec.toFixed(5)}&fov=10`;
    fetch(url, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { epochs?: unknown; n_exposures?: unknown };
        const epochs = Array.isArray(body.epochs) ? body.epochs.length : Number(body.epochs);
        if (!Number.isFinite(epochs)) throw new Error("bad response");
        const exposures = Number(body.n_exposures);
        setResult({
          key,
          value: { state: "ok", epochs, exposures: Number.isFinite(exposures) ? exposures : null },
        });
      })
      .catch(() => {
        if (!controller.signal.aborted) setResult({ key, value: { state: "error" } });
      });
    return () => controller.abort();
  }, [ra, dec, key]);
  if (!API_URL) return { state: "off" };
  return result.key === key ? result.value : { state: "loading" };
}

export function PatchStory({
  ra,
  dec,
  headingId,
  targets,
  onSelect,
}: {
  ra: number;
  dec: number;
  headingId: string;
  targets: FeaturedTarget[];
  onSelect: (slug: string) => void;
}) {
  const b = galacticLatitude(ra, dec);
  const nearest = targets
    .map((t) => ({ t, d: angularDistance(ra, dec, t.ra, t.dec) }))
    .sort((x, y) => x.d - y.d)[0];
  const visits = useVisits(ra, dec);

  return (
    <article className="flex flex-col gap-5" data-testid="patch-story">
      <header className="flex flex-col gap-1.5">
        <h2 id={headingId} tabIndex={-1} className="text-title text-fg outline-none">
          This patch of sky
        </h2>
      </header>

      <dl className="grid grid-cols-2 gap-x-4">
        <div className="flex flex-col gap-0.5">
          <dt className="text-micro text-fg-faint">Right ascension</dt>
          <dd className="readout text-lead text-fg" data-testid="patch-ra">
            {formatRa(ra, 3)}
          </dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-micro text-fg-faint">Declination</dt>
          <dd className="readout text-lead text-fg" data-testid="patch-dec">
            {formatDec(dec, 3)}
          </dd>
        </div>
      </dl>

      <p className="text-body text-pretty text-fg-dim">
        {describe(b)} SPHEREx maps the whole sky every six months, so this spot has been photographed in all
        102 of its infrared colours more than once.
      </p>

      <p className="text-meta text-pretty text-fg-faint" aria-live="polite">
        {visits.state === "ok" &&
          `Our live service counts ${visits.epochs} SPHEREx ${visits.epochs === 1 ? "visit" : "visits"} within 5 arcminutes of here${
            visits.exposures ? `, ${visits.exposures} exposures in all` : ""
          }.`}
        {visits.state === "loading" && "Counting SPHEREx visits here"}
        {visits.state === "error" &&
          "Our live service did not answer, so visits here cannot be counted right now."}
        {visits.state === "off" &&
          "Visit counts for any spot will appear here once our live service is connected."}
      </p>

      {nearest && (
        <p className="text-meta text-pretty text-fg-dim">
          The nearest of the five featured objects is{" "}
          <button
            type="button"
            onClick={() => onSelect(nearest.t.slug)}
            className="text-fg underline decoration-hair-strong underline-offset-4 hover:decoration-fg-dim"
          >
            {nearest.t.name}
          </button>
          , <span className="readout">{nearest.d < 10 ? nearest.d.toFixed(1) : Math.round(nearest.d)}°</span>{" "}
          away.
        </p>
      )}

      <section className="flex flex-col gap-3 border-t border-hair pt-5">
        <p className="text-meta text-pretty text-fg-dim">
          The Lab shows this spot up close, at every SPHEREx wavelength and next to older infrared surveys.
        </p>
        <div>
          <Button asChild size="lg" className="h-10 gap-2 rounded-md px-4">
            <Link href={labHref(null, ra, dec)} data-testid="look-closer">
              Look closer in the Lab
              <ArrowRightIcon aria-hidden />
            </Link>
          </Button>
        </div>
      </section>
    </article>
  );
}
