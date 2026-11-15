"use client";
// The parts of /discoveries around the list: the survey summary, the known objects the search found
// again (the five challenge targets tested at their known positions, and known fast-moving stars it
// picked up on its own) and how the list is made, with the model's measured numbers.

import * as React from "react";
import Link from "next/link";
import { ArrowRightIcon, CheckIcon } from "lucide-react";
import {
  formatQ,
  percent,
  type Candidate,
  type Discoveries,
  type TargetCheck,
} from "@/lib/discoveries";
import { cn } from "@/lib/utils";
import { BlinkPanels, StampPanel } from "./stamp";

// -------------------------------------------------------------------------------- survey

const FIELD_KIND_WORDS: Record<string, [string, string]> = {
  target: ["challenge target", "challenge targets"],
  "known-mover": ["known fast-moving star", "known fast-moving stars"],
  "brown-dwarf": ["known brown dwarf", "known brown dwarfs"],
  variable: ["known variable star", "known variable stars"],
  control: ["control field where nothing is expected", "control fields where nothing is expected"],
};

function listWords(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

export function fieldMix(data: Discoveries): string | null {
  if (data.fields.length === 0) return null;
  const counts = new Map<string, number>();
  for (const f of data.fields) counts.set(f.kind, (counts.get(f.kind) ?? 0) + 1);
  const parts: string[] = [];
  for (const [kind, [one, many]] of Object.entries(FIELD_KIND_WORDS)) {
    const n = counts.get(kind);
    if (n) parts.push(`${n} ${n === 1 ? one : many}`);
    counts.delete(kind);
  }
  const other = [...counts.values()].reduce((a, b) => a + b, 0);
  if (other) parts.push(`${other} other ${other === 1 ? "field" : "fields"}`);
  return `Fields centred on ${listWords(parts)}.`;
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="min-w-0 border-t border-hair pt-3">
      <dd className="readout text-heading text-fg">{value}</dd>
      <dt className="mt-1 text-meta text-pretty text-fg-dim">{label}</dt>
    </div>
  );
}

export function SurveySummary({ data }: { data: Discoveries }) {
  const flagged = data.fields.reduce((sum, f) => sum + (f.n_candidates ?? 0), 0);
  const nFields = data.survey.n_fields ?? (data.fields.length || null);
  const area = data.survey.area_deg2;
  // The full Moon covers about 0.21 square degrees.
  const moons = area !== null ? Math.round(area / 0.21) : 0;
  const stats: { value: string; label: string }[] = [];
  if (nFields !== null) stats.push({ value: nFields.toLocaleString("en-GB"), label: "SPHEREx fields searched" });
  if (area !== null)
    stats.push({
      value: area.toFixed(2),
      label: moons >= 2 ? `square degrees of sky, about ${moons} full Moons` : "square degrees of sky",
    });
  if (flagged > 0) stats.push({ value: flagged.toLocaleString("en-GB"), label: "changes the finder flagged" });
  stats.push({ value: data.candidates.length.toLocaleString("en-GB"), label: "candidates kept for this list" });

  const mix = fieldMix(data);
  return (
    <section aria-label="Survey summary" data-testid="survey-summary" className="mt-12">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-6 md:grid-cols-4">
        {stats.map((s) => (
          <Stat key={s.label} value={s.value} label={s.label} />
        ))}
      </dl>
      {(mix || data.survey.detectors.length > 0 || data.survey.epochs_median !== null) && (
        <p className="mt-5 max-w-[68ch] text-meta text-pretty text-fg-faint">
          {mix}
          {data.survey.detectors.length > 0 && (
            <> Searched in detectors {listWords(data.survey.detectors)}, the longest-wavelength ones, where cold brown dwarfs shine brightest.</>
          )}
          {data.survey.epochs_median !== null && (
            <> A typical field was visited {data.survey.epochs_median.toLocaleString("en-GB")} times.</>
          )}
        </p>
      )}
    </section>
  );
}

// ------------------------------------------------------------------------- found again

interface FoundItem {
  key: string;
  name: string;
  outcome: "found" | "missed" | "absent";
  verdict: string;
  detail: string;
  candidate: Candidate | null;
}

const kindWord = (k: "mover" | "variable") => (k === "mover" ? "a mover" : "a brightness change");

function fromTarget(t: TargetCheck): FoundItem {
  const c = t.candidate;
  if (!c || t.q_target === null) {
    return {
      key: `t-${t.field}`,
      name: t.name,
      outcome: "absent",
      verdict: "Not found",
      detail: `No candidate within ${t.radius_arcsec ?? 30}″ of where it should be.`,
      candidate: null,
    };
  }
  const sep = t.sep_arcsec !== null ? `, ${t.sep_arcsec.toFixed(1)}″ from where it should be` : "";
  if (t.found && t.expected) {
    const pm =
      c.motion && t.catalog_pm_arcsec_yr !== null
        ? ` Moves ${c.motion.pm_arcsec_yr.toFixed(1)}″ a year; catalogue ${t.catalog_pm_arcsec_yr.toFixed(1)}″.`
        : "";
    return {
      key: `t-${t.field}`,
      name: t.name,
      outcome: "found",
      verdict: `Found again as ${kindWord(t.expected)}`,
      detail: `q ${formatQ(t.q_target)} at its known position${sep}.${pm}`,
      candidate: c,
    };
  }
  const why =
    t.expected && c.kind !== t.expected
      ? `The change there looked more like ${kindWord(c.kind)}`
      : "A change was seen there, but not with enough certainty";
  return {
    key: `t-${t.field}`,
    name: t.name,
    outcome: "missed",
    verdict: "Not passed",
    detail: `${why} (q ${formatQ(t.q_target)}, needs 0.05 or less)${sep}.`,
    candidate: c,
  };
}

function fromKnownMover(c: Candidate): FoundItem {
  const pm = c.motion ? `Moves ${c.motion.pm_arcsec_yr.toFixed(1)}″ a year` : "Moves";
  const cat = c.match.catalog_pm_arcsec_yr !== null ? `; catalogue ${c.match.catalog_pm_arcsec_yr.toFixed(1)}″` : "";
  return {
    key: `c-${c.id}`,
    name: c.match.name ?? c.match.id ?? "Known star",
    outcome: "found",
    verdict: "Found again as a mover",
    detail: `${pm}${cat}. Picked up by the search on its own, q ${formatQ(c.q_value)}.`,
    candidate: c,
  };
}

export function foundAgainItems(data: Discoveries): FoundItem[] {
  const targets = data.targets.map(fromTarget);
  const order = { found: 0, missed: 1, absent: 2 } as const;
  targets.sort((a, b) => order[a.outcome] - order[b.outcome]);
  const movers = data.candidates
    .filter((c) => c.kind === "mover" && c.match.status === "known" && c.match.catalog_pm_arcsec_yr !== null)
    .map(fromKnownMover);
  return [...movers, ...targets];
}

export function FoundAgain({ data, reduce }: { data: Discoveries; reduce: boolean }) {
  const items = foundAgainItems(data);
  if (items.length === 0) return null;
  const found = items.filter((i) => i.outcome === "found").length;
  return (
    <section aria-labelledby="found-again-title" data-testid="found-again" className="mt-20">
      <h2 id="found-again-title" className="text-heading text-fg">
        Known objects found again
      </h2>
      <p className="mt-2 max-w-[64ch] text-ui text-pretty text-fg-dim">
        A search that misses what is already known cannot be trusted with anything new. The five challenge targets were
        tested where catalogues say they are; known fast-moving stars that the search picked up by itself are here too.{" "}
        <span className="text-fg">
          {found} of {items.length} found again.
        </span>
      </p>
      <ul className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        {items.map((item) => (
          <li
            key={item.key}
            data-testid="found-item"
            data-outcome={item.outcome}
            className="flex min-w-0 flex-col rounded-[16px] border border-hair bg-ink-2 p-2.5"
          >
            {item.candidate?.stamp ? (
              reduce ? (
                <StampPanel source={{ type: "strip", src: item.candidate.stamp }} panel={2} className="rounded-[10px]" />
              ) : (
                <BlinkPanels source={{ type: "strip", src: item.candidate.stamp }} className="rounded-[10px]" />
              )
            ) : (
              <div className="grid aspect-square place-items-center rounded-[10px] bg-ink-3 p-3 text-center text-micro text-fg-faint">
                Nothing to show
              </div>
            )}
            <h3 className="mt-2.5 px-0.5 text-ui font-medium text-fg">{item.name}</h3>
            <p className={cn("px-0.5 text-meta", item.outcome === "found" ? "text-fg" : "text-fg-dim")}>
              {item.outcome === "found" && <CheckIcon aria-hidden className="mr-1 inline size-3.5 -translate-y-px text-accent" />}
              {item.verdict}
            </p>
            <p className="mt-1 px-0.5 text-micro text-pretty text-fg-faint">{item.detail}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------- the method

function Metric({ value, children }: { value: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 border-t border-hair pt-3">
      <dd className="readout text-heading text-fg">{value}</dd>
      <dt className="mt-1 text-meta text-pretty text-fg-dim">{children}</dt>
    </div>
  );
}

const STEPS = [
  {
    title: "Find",
    body: "In every field, the images of each visit are subtracted from the others. Spots that stand out at least five times above the noise are kept: a bright-and-dark pair is a possible mover, a single spot a possible change in brightness.",
  },
  {
    title: "Judge",
    body: "A small neural network looks at a cut-out of each one (earlier image, later image, difference and the bad-pixel mask) and gives four probabilities: mover, brightness change, artifact or nothing. It learned from fake objects hidden in real SPHEREx images and from real glitches.",
  },
  {
    title: "Count the false alarms",
    body: "Each score is compared with ordinary spots from fields the model never trained on, which gives its p-value. Within each field the p-values are then adjusted for how many spots were tested (the Benjamini-Hochberg method), which gives the q-value.",
  },
  {
    title: "Check the catalogues",
    body: "Every candidate is compared with Gaia DR3, CatWISE2020 and SIMBAD, with catalogue stars moved to the date of the images. A catalogued source within 6″ (moving the same way, for a mover) makes it known; anything else is new. A mover that sits on a bright star Gaia measured as still is dropped: it is left over from lining up the images.",
  },
] as const;

export function HowMade({ data }: { data: Discoveries | null }) {
  const m = data?.model.metrics ?? {};
  const hasMetrics = Object.keys(m).length > 0;
  return (
    <section aria-labelledby="how-made-title" className="mt-20 border-t border-hair pt-10">
      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:gap-16">
        <div>
          <h2 id="how-made-title" className="text-heading text-fg">
            How the list is made
          </h2>
          <ol className="mt-5 flex flex-col gap-5">
            {STEPS.map((s, i) => (
              <li key={s.title} className="grid grid-cols-[1.75rem_minmax(0,1fr)] gap-2">
                <span aria-hidden className="readout pt-0.5 text-meta text-fg-faint">
                  {i + 1}
                </span>
                <div>
                  <h3 className="text-ui font-medium text-fg">{s.title}</h3>
                  <p className="mt-1 text-ui text-pretty text-fg-dim">{s.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>

        <div>
          <h3 className="text-ui font-medium text-fg">How well the model does</h3>
          {data?.model.trained_on && <p className="mt-1 text-meta text-pretty text-fg-dim">{data.model.trained_on}</p>}
          {!hasMetrics && (
            <p className="mt-1 text-meta text-pretty text-fg-dim">
              Its measured accuracy, completeness and false-alarm rate are published with the list.
            </p>
          )}
          <dl className={cn("grid grid-cols-2 gap-x-6 gap-y-6", hasMetrics && "mt-5")}>
            {m.test_accuracy !== undefined && (
              <Metric value={percent(m.test_accuracy)}>of test cut-outs put in the right one of the four classes</Metric>
            )}
            {m.mover_completeness_shift_ge_1px_snr10 !== undefined && (
              <Metric value={percent(m.mover_completeness_shift_ge_1px_snr10)}>
                of hidden test movers found that shift at least one pixel (6.15″) between visits and stand at least ten
                times above the noise
                {m.mover_completeness_snr10 !== undefined && (
                  <> ({percent(m.mover_completeness_snr10)} of all test movers that bright)</>
                )}
              </Metric>
            )}
            {m.variable_completeness_snr10 !== undefined && (
              <Metric value={percent(m.variable_completeness_snr10)}>
                of hidden brightness changes found that stand at least ten times above the noise
              </Metric>
            )}
            {m.false_alarms_per_deg2_q05 !== undefined && (
              <Metric value={m.false_alarms_per_deg2_q05.toLocaleString("en-GB", { maximumFractionDigits: 1 })}>
                false alarms per square degree at q ≤ 0.05 in fields with nothing to find
                {m.false_alarms_area_deg2 !== undefined && <> ({m.false_alarms_area_deg2.toFixed(2)} square degrees searched</>}
                {m.false_alarms_per_deg2_q05_upper95 !== undefined && m.false_alarms_area_deg2 !== undefined && (
                  <>; at most {m.false_alarms_per_deg2_q05_upper95.toFixed(1)} with 95% confidence</>
                )}
                {m.false_alarms_area_deg2 !== undefined && <>)</>}
              </Metric>
            )}
          </dl>
          <p className="mt-6 text-meta text-pretty text-fg-dim">
            The model learned from fields of this same survey, so candidates in those fields were partly seen while it
            learned. The numbers above come only from separate test fields.
          </p>
          <Link
            href="/how-it-works"
            className="mt-6 inline-flex items-center gap-1.5 rounded-sm text-ui text-fg underline decoration-hair-strong underline-offset-4 transition-colors hover:decoration-fg-dim"
          >
            How sure are we?
            <ArrowRightIcon aria-hidden className="size-3.5" />
          </Link>
        </div>
      </div>
    </section>
  );
}
