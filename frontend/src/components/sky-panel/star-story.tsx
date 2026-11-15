"use client";
// Panel content for one catalogue star: its names, where it is, how bright, what colour and
// temperature, what kind of star (spectral type, in plain words), how far and how fast it moves,
// then live data (Gaia DR3, SIMBAD, SPHEREx coverage and its quick-look spectrum). Every number
// says where it comes from; nothing is filled in when a source has no answer.

import Link from "next/link";
import { ArrowRightIcon, CheckIcon, LinkIcon, OrbitIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Term } from "@/components/ui/term";
import { FEATURED_TARGETS } from "@/lib/targets";
import { formatDecDms, formatRaHms } from "@/lib/sky-coords";
import { useLiveObject } from "@/lib/sky-live";
import {
  LY_PER_PC,
  angularSeparation,
  constellationName,
  distancePc,
  properMotion,
  spectralMeaning,
  starDesignations,
  starTitle,
  type Catalogue,
  type Star,
} from "@/lib/stars";
import { CoverageView, Fact, LiveNote, Rise, Roll, Section, Stagger } from "@/components/sky-panel/panel-bits";
import { QuickSpectrum } from "@/components/sky-panel/quick-spectrum";

/** Lab link for a position: a 10-arcminute field, as the API builds by default. */
export function labHrefFor(ra: number, dec: number): string {
  const q = new URLSearchParams({ ra: ra.toFixed(5), dec: dec.toFixed(5), fov: (10 / 60).toFixed(4) });
  return `/explore?${q.toString()}`;
}

function colourWord(teff: number | null): string | null {
  if (teff === null) return null;
  if (teff > 25000) return "Blue";
  if (teff > 10000) return "Blue-white";
  if (teff > 7500) return "White";
  if (teff > 6000) return "Yellow-white";
  if (teff > 5200) return "Yellow";
  if (teff > 3700) return "Orange";
  return "Red";
}

function brightnessWords(v: number): string {
  if (v < 1.5) return "One of the brightest stars in the night sky.";
  if (v < 4) return "Easy to see by eye, even from a town.";
  if (v < 6) return "Visible by eye under a dark sky.";
  if (v < 8.5) return "Too faint for the eye; binoculars show it.";
  return "Needs a telescope.";
}

const COMPASS = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];

export function StarStory({
  star,
  catalogue,
  headingId,
  reducedMotion,
  inSpace,
  onFly3D,
  onSelectTarget,
  shareUrl,
}: {
  star: Star;
  catalogue: Catalogue;
  headingId: string;
  reducedMotion: boolean;
  inSpace: boolean;
  onFly3D: () => void;
  onSelectTarget: (slug: string) => void;
  shareUrl: string;
}) {
  const live = useLiveObject("star", star.ra, star.dec, {
    vmag: star.vmag,
    hip: star.hip,
    pmra: star.pmra,
    pmdec: star.pmdec,
  });
  const [copied, setCopied] = useState(false);
  const title = starTitle(star);
  const other = starDesignations(star);
  const con = constellationName(star.con);
  const pc = distancePc(star.plx);
  const ly = pc ? pc * LY_PER_PC : null;
  const reliable = star.plx !== null && star.plx >= 1;
  const pm = properMotion(star.pmra, star.pmdec);
  const colour = colourWord(star.teff);
  const meaning = spectralMeaning(star.sp);
  const target = FEATURED_TARGETS.find((t) => angularSeparation(t.ra, t.dec, star.ra, star.dec) < 60 / 3600);
  const rank = catalogue.collections?.brightest.indexOf(star.id) ?? -1;
  const basic = catalogue.source === "basic";
  const swatch = `rgb(${star.rgb[0]} ${star.rgb[1]} ${star.rgb[2]})`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <article className="flex flex-col gap-5" data-testid="star-story" data-hip={star.hip ?? ""}>
      <Stagger reducedMotion={reducedMotion} className="flex flex-col gap-5">
        <Rise>
          <header className="flex items-start gap-4">
            <span
              aria-hidden
              className="mt-1.5 size-9 shrink-0 rounded-full"
              style={{
                background: `radial-gradient(circle at 50% 50%, ${swatch} 0 38%, transparent 72%)`,
              }}
            />
            <div className="flex min-w-0 flex-col gap-1">
              <h2 id={headingId} tabIndex={-1} className="text-title text-balance text-fg outline-none">
                {title}
              </h2>
              <p className="text-meta text-pretty text-fg-dim" data-testid="star-designations">
                {other.length ? other.join(" · ") : basic ? "Hipparcos catalogue star" : "No other designation"}
                {con ? (
                  <>
                    {" · in "}
                    <Term k="constellation" mark={false}>
                      {con}
                    </Term>
                  </>
                ) : null}
              </p>
            </div>
          </header>
        </Rise>

        {target ? (
          <Rise>
            <button
              type="button"
              onClick={() => onSelectTarget(target.slug)}
              className="group flex w-full items-center justify-between gap-3 rounded-md border border-accent-muted bg-accent-faint px-3.5 py-2.5 text-left transition-colors hover:border-accent"
            >
              <span className="flex flex-col">
                <span className="text-ui font-medium text-fg">One of the five challenge targets</span>
                <span className="text-meta text-fg-dim">See its SPHEREx images, blink and spectrum</span>
              </span>
              <ArrowRightIcon aria-hidden className="size-4 text-accent transition-transform group-hover:translate-x-0.5" />
            </button>
          </Rise>
        ) : null}

        <Rise>
          <dl className="grid grid-cols-2 gap-x-5 gap-y-4">
            <Fact
              label={<Term k="magnitude">Brightness</Term>}
              sub={rank >= 0 && rank < 30 ? `The ${ordinal(rank + 1)} brightest star in the catalogue.` : brightnessWords(star.vmag)}
              testId="fact-magnitude"
            >
              <span className="text-fg-dim">V </span>
              <Roll value={star.vmag} digits={2} reducedMotion={reducedMotion} />
            </Fact>
            <Fact
              label={<Term k="colourIndex">Colour</Term>}
              sub={
                star.teff ? (
                  <>
                    About <Roll value={Math.round(star.teff / 10) * 10} digits={0} reducedMotion={reducedMotion} /> K at
                    its surface, from its colour
                  </>
                ) : (
                  "No colour measured"
                )
              }
            >
              {colour ?? "Unknown"}
              {star.bv !== null ? (
                <span className="readout ml-1.5 text-fg-dim">B−V {star.bv.toFixed(2).replace("-", "−")}</span>
              ) : null}
            </Fact>
            <Fact
              label={
                <>
                  Distance from <Term k="parallax">parallax</Term>
                </>
              }
              sub={
                ly && reliable ? (
                  <>
                    <Roll value={pc!} digits={pc! < 10 ? 2 : 1} reducedMotion={reducedMotion} />{" "}
                    <Term k="parsec" mark={false}>
                      parsecs
                    </Term>
                    {ly < 3000 ? (
                      <>
                        . The light you see left it around <span className="readout">{lightYear(ly)}</span>.
                      </>
                    ) : null}
                  </>
                ) : basic ? (
                  "Distances arrive with the full Hipparcos catalogue."
                ) : (
                  "Too far for Hipparcos to measure well."
                )
              }
              className="col-span-2"
              testId="fact-distance"
            >
              {ly && reliable ? (
                <>
                  <Roll value={ly} digits={ly < 100 ? 1 : 0} reducedMotion={reducedMotion} />{" "}
                  <Term k="lightYear" mark={false}>
                    light-years
                  </Term>
                </>
              ) : (
                <span className="text-fg-dim">Unknown</span>
              )}
            </Fact>
            {pm ? (
              <Fact
                label={<Term k="properMotion" />}
                sub={motionWords(pm.total, pm.pa)}
                className="col-span-2"
                testId="fact-motion"
              >
                <span className="flex items-center gap-3">
                  <MotionArrow pa={pm.pa} reducedMotion={reducedMotion} />
                  <span>
                    <Roll value={pm.total} digits={pm.total < 1 ? 3 : 2} reducedMotion={reducedMotion} />
                    <span className="readout">″</span> a year,{" "}
                    <Term k="positionAngle" mark={false}>
                      towards
                    </Term>{" "}
                    {COMPASS[Math.round(pm.pa / 45) % 8]}
                  </span>
                </span>
              </Fact>
            ) : null}
            {star.sp ? (
              <Fact label={<Term k="spectralType" />} sub={meaning} className="col-span-2" testId="fact-spectral">
                <span className="readout">{star.sp}</span>
              </Fact>
            ) : null}
            <Fact
              label={
                <>
                  Position (<Term k="rightAscension" mark={false}>RA</Term>,{" "}
                  <Term k="declination" mark={false}>Dec</Term>) in {catalogue.epoch.toFixed(1)}
                </>
              }
              className="col-span-2"
            >
              <span className="readout text-meta text-fg-dim">
                {formatRaHms(star.ra)} {formatDecDms(star.dec)}
              </span>
            </Fact>
          </dl>
        </Rise>

        <Rise>
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild size="lg" className="h-9 gap-2 rounded-md px-3.5">
              <Link href={labHrefFor(star.ra, star.dec)} data-testid="see-in-spherex">
                See it in SPHEREx
                <ArrowRightIcon aria-hidden />
              </Link>
            </Button>
            {!inSpace && reliable ? (
              <Button variant="outline" size="lg" className="h-9 gap-2 rounded-md px-3" onClick={onFly3D} data-testid="fly-3d">
                <OrbitIcon aria-hidden />
                Fly to it in 3D
              </Button>
            ) : null}
            <Button variant="ghost" size="lg" className="h-9 gap-1.5 rounded-md px-2.5 text-fg-dim" onClick={copy}>
              {copied ? <CheckIcon aria-hidden /> : <LinkIcon aria-hidden />}
              {copied ? "Copied" : "Copy link"}
            </Button>
          </div>
        </Rise>

        <Section title={<Term k="gaia">Gaia DR3</Term>} source="ESA Gaia, via IRSA" testId="live-gaia">
          {live.gaia.state === "ok" ? (
            <dl className="grid grid-cols-2 gap-x-5 gap-y-3">
              {live.gaia.value.hint ? (
                <p className="col-span-2 text-meta text-pretty text-fg-dim">{live.gaia.value.hint}</p>
              ) : null}
              <Fact label="Source" className="col-span-2">
                <span className="readout text-meta break-all text-fg-dim">Gaia DR3 {live.gaia.value.sourceId}</span>
              </Fact>
              {live.gaia.value.g !== null ? (
                <Fact label="G magnitude">
                  <span className="readout">{live.gaia.value.g.toFixed(2)}</span>
                </Fact>
              ) : null}
              {live.gaia.value.bpRp !== null ? (
                <Fact label="BP−RP colour">
                  <span className="readout">{live.gaia.value.bpRp.toFixed(2)}</span>
                </Fact>
              ) : null}
              {live.gaia.value.parallax !== null ? (
                <Fact
                  label={<Term k="parallax" mark={false}>Parallax</Term>}
                  sub={
                    live.gaia.value.distanceLy !== null
                      ? `${formatLyShort(live.gaia.value.distanceLy)} light-years`
                      : live.gaia.value.parallax > 0 &&
                          live.gaia.value.parallaxError !== null &&
                          live.gaia.value.parallax / live.gaia.value.parallaxError >= 5
                        ? `${formatLyShort((1000 / live.gaia.value.parallax) * LY_PER_PC)} light-years`
                        : "Too uncertain for a distance"
                  }
                >
                  <span className="readout">
                    {live.gaia.value.parallax.toFixed(2)}
                    {live.gaia.value.parallaxError !== null ? ` ± ${live.gaia.value.parallaxError.toFixed(2)}` : ""} mas
                  </span>
                </Fact>
              ) : null}
              {live.gaia.value.rv !== null ? (
                <Fact label="Speed towards us" sub={live.gaia.value.rv < 0 ? "Coming closer" : "Moving away"}>
                  <span className="readout">{Math.abs(live.gaia.value.rv).toFixed(1)} km/s</span>
                </Fact>
              ) : null}
              {live.gaia.value.teff !== null ? (
                <Fact label="Temperature (Gaia)">
                  <span className="readout">{Math.round(live.gaia.value.teff).toLocaleString("en-US")} K</span>
                </Fact>
              ) : null}
            </dl>
          ) : (
            <LiveNote live={live.gaia} what="Gaia DR3 details" />
          )}
        </Section>

        <Section title="SIMBAD" source="CDS, Strasbourg" testId="live-simbad">
          {live.simbad.state === "ok" ? (
            <dl className="grid grid-cols-2 gap-x-5 gap-y-3">
              <Fact label="Name in SIMBAD" sub={live.simbad.value.name && live.simbad.value.name !== live.simbad.value.id ? live.simbad.value.id : undefined}>
                {live.simbad.value.url ? (
                  <a href={live.simbad.value.url} target="_blank" rel="noreferrer" className="underline decoration-hair-strong underline-offset-[3px] hover:decoration-fg">
                    {live.simbad.value.name ?? live.simbad.value.id}
                  </a>
                ) : (
                  (live.simbad.value.name ?? live.simbad.value.id)
                )}
              </Fact>
              {live.simbad.value.type || live.simbad.value.typeLabel ? (
                <Fact label="Object type" className="col-span-2">
                  {live.simbad.value.typeLabel ?? live.simbad.value.type}
                </Fact>
              ) : null}
              {live.simbad.value.spType ? (
                <Fact label={<Term k="spectralType" mark={false}>Spectral type</Term>}>
                  <span className="readout">{live.simbad.value.spType}</span>
                </Fact>
              ) : null}
            </dl>
          ) : (
            <LiveNote live={live.simbad} what="SIMBAD details" />
          )}
        </Section>

        <Section
          title={
            <>
              What <Term k="spherex" /> has seen here
            </>
          }
          source="SPHEREx DR1 and QR3, IRSA"
          testId="live-coverage"
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
          <p className="border-t border-hair pt-4 text-micro text-pretty text-fg-faint" data-testid="star-sources">
            {basic
              ? "Position, brightness and colour: Hipparcos stars via d3-celestial (Olaf Frohn). Temperature estimated from B−V."
              : `Names, brightness, colour, distance and motion: ${catalogue.credits || "Hipparcos catalogue (ESA), new reduction by van Leeuwen (2007)"}. Positions moved to ${catalogue.epoch.toFixed(1)} with the proper motion; temperature estimated from B−V.`}
          </p>
        </Rise>
      </Stagger>
    </article>
  );
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

function lightYear(ly: number): string {
  const year = Math.round(2026 - ly);
  if (year > 0) return String(year);
  return `${Math.abs(year).toLocaleString("en-US")} BC`;
}

function formatLyShort(ly: number): string {
  if (ly < 100) return ly.toFixed(1);
  return Math.round(ly).toLocaleString("en-US");
}

function motionWords(total: number, pa: number): string {
  const per1000 = (total * 1000) / 60; // arcmin in 1,000 years
  const moon = 31;
  if (per1000 >= moon)
    return `In 1,000 years it shifts by ${Math.round(per1000)}′, ${per1000 / moon >= 2 ? `${(per1000 / moon).toFixed(0)} times` : "more than"} the width of the full Moon.`;
  if (per1000 >= 1) return `In 1,000 years it shifts by ${per1000.toFixed(0)}′ (the full Moon is about 31′ across).`;
  return `It drifts ${Math.round(pa) % 360}° east of north, too slowly to see by eye for many thousands of years.`;
}

/** Direction of motion on the sky, north up and east to the left (as seen from Earth). */
function MotionArrow({ pa, reducedMotion }: { pa: number; reducedMotion: boolean }) {
  // The arrow draws itself in the direction of motion when it first appears.
  const [drawn, setDrawn] = useState(reducedMotion);
  useEffect(() => {
    const id = requestAnimationFrame(() => setDrawn(true));
    return () => cancelAnimationFrame(id);
  }, []);
  const r = (pa * Math.PI) / 180;
  const dx = -Math.sin(r);
  const dy = -Math.cos(r);
  return (
    <svg viewBox="-16 -16 32 32" className="size-8 shrink-0 overflow-visible" aria-hidden>
      <circle r={13} fill="none" stroke="var(--hair-strong)" />
      <text y={-15.5} textAnchor="middle" className="fill-fg-faint text-[6px]">
        N
      </text>
      <text x={-17} y={2} textAnchor="end" className="fill-fg-faint text-[6px]">
        E
      </text>
      <line
        x1={-dx * 9}
        y1={-dy * 9}
        x2={dx * 9}
        y2={dy * 9}
        stroke="var(--accent)"
        strokeWidth={1.4}
        strokeLinecap="round"
        pathLength={1}
        strokeDasharray="1 1"
        style={{
          strokeDashoffset: drawn ? 0 : 1,
          transition: reducedMotion ? "none" : "stroke-dashoffset 700ms cubic-bezier(0.65, 0, 0.35, 1) 250ms",
        }}
      />
      <path
        d={`M${dx * 9},${dy * 9} L${dx * 4.5 - dy * 3.2},${dy * 4.5 + dx * 3.2} M${dx * 9},${dy * 9} L${dx * 4.5 + dy * 3.2},${dy * 4.5 - dx * 3.2}`}
        stroke="var(--accent)"
        strokeWidth={1.4}
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}
