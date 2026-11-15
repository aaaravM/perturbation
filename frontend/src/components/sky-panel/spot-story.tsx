"use client";
// Panel content for a clicked spot of empty sky. Everything is specific to that spot: its
// coordinates (equatorial and galactic), the constellation, where it is in plain words, the
// catalogue stars nearest to it, how crowded the sky is there, and what SPHEREx has seen there
// (visits and the quick-look spectrum), with the way into the Lab.

import Link from "next/link";
import { ArrowRightIcon } from "lucide-react";
import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Term } from "@/components/ui/term";
import { bestMonth, describePlace, formatDecDms, formatDeg, formatRaHms, toGalactic } from "@/lib/sky-coords";
import { useLiveObject } from "@/lib/sky-live";
import {
  constellationName,
  countBrighter,
  countWithin,
  getStar,
  nearestStars,
  starTitle,
  type Catalogue,
} from "@/lib/stars";
import { CoverageView, Fact, LiveNote, Rise, Roll, Section, Stagger } from "@/components/sky-panel/panel-bits";
import { QuickSpectrum } from "@/components/sky-panel/quick-spectrum";
import { labHrefFor } from "@/components/sky-panel/star-story";

const DENSITY_RADIUS = 5; // deg
const DENSITY_VMAX = 8;

function formatSep(deg: number): string {
  if (deg < 1 / 60) return "under 1′";
  if (deg < 1) return `${Math.round(deg * 60)}′`;
  return `${deg.toFixed(1)}°`;
}

export function useSpotFacts(catalogue: Catalogue | null, ra: number, dec: number) {
  return useMemo(() => {
    if (!catalogue) return null;
    const near = nearestStars(catalogue, ra, dec, 6, { vmax: 9.5, maxRadius: 16 })
      .map((n) => ({ ...n, star: getStar(catalogue, n.id)! }))
      .filter((n) => n.star);
    // Constellation from the catalogue stars around the spot (each star knows its IAU constellation).
    const votes = new Map<string, number>();
    for (const n of nearestStars(catalogue, ra, dec, 9, { vmax: 11, maxRadius: 8 })) {
      const s = getStar(catalogue, n.id);
      if (s?.con) votes.set(s.con, (votes.get(s.con) ?? 0) + 1 / (0.2 + n.sep));
    }
    const con = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const named = nearestStars(catalogue, ra, dec, 40, { vmax: 4.5, maxRadius: 25 })
      .map((n) => ({ ...n, star: getStar(catalogue, n.id)! }))
      .find((n) => n.star?.names?.name);
    const count = countWithin(catalogue, ra, dec, DENSITY_RADIUS, DENSITY_VMAX);
    const total = countBrighter(catalogue, DENSITY_VMAX);
    const capSqDeg = 2 * Math.PI * (1 - Math.cos((DENSITY_RADIUS * Math.PI) / 180)) * (180 / Math.PI) ** 2;
    const expected = (total * capSqDeg) / 41253;
    return { near, con, named, count, ratio: expected > 0 ? count / expected : null, capSqDeg };
  }, [catalogue, ra, dec]);
}

export function SpotStory({
  ra,
  dec,
  catalogue,
  headingId,
  reducedMotion,
  onSelectStar,
  onHoverStar,
}: {
  ra: number;
  dec: number;
  catalogue: Catalogue | null;
  headingId: string;
  reducedMotion: boolean;
  onSelectStar: (id: number) => void;
  onHoverStar: (id: number | null) => void;
}) {
  const facts = useSpotFacts(catalogue, ra, dec);
  const live = useLiveObject("spot", ra, dec);
  const gal = toGalactic(ra, dec);
  const place = describePlace(ra, dec);
  // The constellation from the IAU boundaries (live service) when it has answered; until then,
  // from the catalogue stars around the spot.
  const liveSky = live.sky.state === "ok" ? live.sky.value : null;
  const exactCon = liveSky?.constellationName ?? constellationName(liveSky?.constellation);
  const conName = exactCon ?? constellationName(facts?.con);
  const named = facts?.named;
  const heading = conName
    ? named && named.sep < 0.05
      ? `${conName}, right by ${starTitle(named.star)}`
      : named && named.sep < 12
      ? `${conName}, ${formatSep(named.sep)} from ${starTitle(named.star)}`
      : `A patch of ${conName}`
    : named
      ? `${formatSep(named.sep)} from ${starTitle(named.star)}`
      : "A patch of sky";

  return (
    <article className="flex flex-col gap-5" data-testid="spot-story">
      <Stagger reducedMotion={reducedMotion} className="flex flex-col gap-5">
        <Rise>
          <header className="flex flex-col gap-1.5">
            <h2 id={headingId} tabIndex={-1} className="text-title text-balance text-fg outline-none" data-testid="spot-heading">
              {heading}
            </h2>
            <p className="text-meta text-fg-dim" data-testid="spot-constellation">
              {conName ? (
                <>
                  In the constellation {conName}
                  <span className="text-fg-faint">
                    {exactCon ? " (IAU boundaries)" : " (from the catalogue stars around it)"}
                  </span>
                </>
              ) : (
                "Constellation not known yet: the catalogue is still loading."
              )}
            </p>
          </header>
        </Rise>

        <Rise>
          <dl className="grid grid-cols-2 gap-x-5 gap-y-3">
            <Fact label={<Term k="rightAscension">Right ascension</Term>}>
              <span className="readout" data-testid="spot-ra" data-value={ra.toFixed(4)}>
                {formatRaHms(ra)}
              </span>
            </Fact>
            <Fact label={<Term k="declination">Declination</Term>}>
              <span className="readout" data-testid="spot-dec" data-value={dec.toFixed(4)}>
                {formatDecDms(dec)}
              </span>
            </Fact>
            <Fact label="Galactic longitude">
              <span className="readout">{formatDeg(gal.l, 2)}</span>
            </Fact>
            <Fact label="Galactic latitude">
              <span className="readout">{formatDeg(gal.b, 2, true)}</span>
            </Fact>
          </dl>
        </Rise>

        <Rise>
          <div className="flex flex-col gap-1.5 text-ui text-pretty text-fg-dim" data-testid="spot-place">
            {(liveSky?.where.length ? liveSky.where : place).map((p) => (
              <p key={p}>{p}</p>
            ))}
            <p>
              Highest in the sky at midnight in <span className="text-fg">{bestMonth(ra)}</span>.
            </p>
          </div>
        </Rise>

        <Section title="Nearest catalogue stars" source="Hipparcos" testId="spot-nearest">
          {facts?.near.length ? (
            <ul className="-mx-2 flex flex-col">
              {facts.near.map((n) => (
                <li key={n.id}>
                  <button
                    type="button"
                    onClick={() => onSelectStar(n.id)}
                    onPointerEnter={() => onHoverStar(n.id)}
                    onPointerLeave={() => onHoverStar(null)}
                    onFocus={() => onHoverStar(n.id)}
                    onBlur={() => onHoverStar(null)}
                    className="group flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-white/[0.04]"
                  >
                    <span
                      aria-hidden
                      className="size-2 shrink-0 rounded-full"
                      style={{ background: `rgb(${n.star.rgb.join(" ")})`, opacity: Math.max(0.35, Math.min(1, (9 - n.star.vmag) / 6)) }}
                    />
                    <span className="min-w-0 flex-1 truncate text-ui text-fg">{starTitle(n.star)}</span>
                    <span className="readout text-micro text-fg-faint">V {n.star.vmag.toFixed(1).replace("-", "−")}</span>
                    <span className="readout min-w-12 text-right text-micro whitespace-nowrap text-fg-dim">{formatSep(n.sep)}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-meta text-fg-faint">Loading the catalogue…</p>
          )}
        </Section>

        {facts ? (
          <Section title="How crowded the sky is here" source="Hipparcos" testId="spot-density">
            <p className="text-ui text-fg">
              <Roll value={facts.count} digits={0} reducedMotion={reducedMotion} /> stars brighter than{" "}
              <Term k="magnitude" mark={false}>magnitude</Term> <span className="readout">{DENSITY_VMAX}</span> within{" "}
              <span className="readout">{DENSITY_RADIUS}°</span>
            </p>
            {facts.ratio !== null ? (
              <div className="flex flex-col gap-1.5">
                <div className="relative h-1.5 overflow-hidden rounded-full bg-white/[0.06]" aria-hidden>
                  <span
                    className="absolute inset-y-0 left-0 rounded-full bg-fg-dim transition-[width] duration-700 ease-out-expo"
                    style={{ width: `${Math.min(100, (facts.ratio / 4) * 100)}%` }}
                  />
                  <span className="absolute inset-y-0 w-px bg-accent" style={{ left: "25%" }} />
                </div>
                <p className="text-micro text-fg-faint">
                  {facts.ratio >= 1.15
                    ? `${facts.ratio.toFixed(1)} times the average for the whole sky`
                    : facts.ratio <= 0.87
                      ? `${(1 / Math.max(facts.ratio, 0.01)).toFixed(1)} times sparser than the sky's average`
                      : "About the average for the whole sky"}{" "}
                  (the orange tick).
                </p>
              </div>
            ) : null}
          </Section>
        ) : null}

        {live.starsCount.state === "ok" || live.brightest.state === "ok" ? (
          <Section title="Gaia DR3" source="ESA Gaia, via IRSA" testId="spot-gaia">
            {live.starsCount.state === "ok" ? (
              <p className="text-ui text-pretty text-fg">
                {live.starsCount.value.method === "estimate" ? "About " : ""}
                <Roll value={live.starsCount.value.count} digits={0} reducedMotion={reducedMotion} /> stars down to{" "}
                magnitude{" "}
                <span className="readout">{live.starsCount.value.gLimit ?? 18}</span> within{" "}
                <span className="readout">{live.starsCount.value.radiusArcmin ?? 20}′</span>
                <span className="text-fg-dim">: far fainter stars than Hipparcos reaches.</span>
              </p>
            ) : null}
            {live.brightest.state === "ok" && live.brightest.value.stars.length ? (
              <ul className="flex flex-col gap-0.5 text-meta">
                {live.brightest.value.stars.slice(0, 5).map((b) => (
                  <li key={b.sourceId} className="flex items-baseline justify-between gap-3">
                    <span className="min-w-0 truncate text-fg-dim">
                      {b.name ?? `Gaia DR3 ${b.sourceId}`}
                      {b.typeLabel ? <span className="text-fg-faint"> · {b.typeLabel.split(":")[0]}</span> : null}
                    </span>
                    <span className="readout shrink-0 text-micro text-fg-faint">
                      {b.g !== null ? `G ${b.g.toFixed(1)}` : ""}
                      {b.sepArcmin !== null ? ` · ${b.sepArcmin.toFixed(1)}′` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
          </Section>
        ) : null}

        <Section
          title={
            <>
              What SPHEREx has seen here
            </>
          }
          source="SPHEREx DR1 and QR3, IRSA"
          testId="spot-coverage"
        >
          {live.coverage.state === "ok" ? (
            <CoverageView coverage={live.coverage.value} reducedMotion={reducedMotion} />
          ) : (
            <LiveNote live={live.coverage} what="SPHEREx visits" />
          )}
          {live.spectrum.state === "ok" ? (
            <QuickSpectrum data={live.spectrum.value} reducedMotion={reducedMotion} />
          ) : live.coverage.state === "ok" ? (
            <LiveNote live={live.spectrum} what="the quick-look spectrum" />
          ) : null}
        </Section>

        <Rise>
          <div className="flex flex-col gap-3 border-t border-hair pt-4">
            <Button asChild size="lg" className="h-9 w-fit gap-2 rounded-md px-3.5">
              <Link href={labHrefFor(ra, dec)} data-testid="watch-patch">
                Watch this patch in SPHEREx
                <ArrowRightIcon aria-hidden />
              </Link>
            </Button>
            <p className="text-micro text-pretty text-fg-faint">
              Opens a 10′ field here in the Lab, where SPHEREx images taken months apart can be{" "}
              <Term k="blink">blinked</Term>.
            </p>
          </div>
        </Rise>
      </Stagger>
    </article>
  );
}
