"use client";
// What the AI found: every candidate the survey lists (/discoveries/candidates.json, checked by
// lib/discoveries.ts), each with its stamp blinking between the two visits beside the difference, the
// kind of change, how sure the network is in plain words, whether it passed the false-alarm check,
// the catalogue match and a way into the Lab; then the known objects the search found again. Nothing
// is shown that the list does not contain. "What the AI saw" opens the same find in the next section.

import * as React from "react";
import Link from "next/link";
import { ArrowUpRightIcon } from "lucide-react";
import { useEffectiveReducedMotion, usePreference } from "@/lib/preferences";
import {
  brightnessWords,
  byConfidence,
  compass,
  displayName,
  fieldName,
  formatDay,
  percent,
  type Candidate,
  type Discoveries,
} from "@/lib/discoveries";
import { Skeleton, SkeletonRegion, SkeletonText } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { fieldRole } from "./field-split";
import { FoundAgain } from "./found-again";
import { Pending, useCandidates } from "./results";
import { BlinkPanels, BlinkToggle, PhaseText, StampPanel, useBlinkClock, type StampSource } from "./stamp";

export const candidateTitle = (c: Candidate) => (c.kind === "mover" ? "Possible mover" : "Possible brightness change");

/** "3.66 ± 0.43″ a year, towards the south-west". */
export function motionWords(c: Candidate): string | null {
  const m = c.motion;
  if (!m) return null;
  const err = m.pm_err_arcsec_yr !== null ? ` ± ${m.pm_err_arcsec_yr.toFixed(2)}` : "";
  const dir = m.pa_deg !== null ? `, towards the ${compass(m.pa_deg)}` : "";
  return `${m.pm_arcsec_yr.toFixed(2)}${err}″ a year${dir}`;
}

/**
 * What was measured, in a sentence: the motion, the brightness change, or that neither could be.
 * In plain words a change under 3σ is "within the noise"; `withSigma` adds the σ figure for the network view.
 */
export function measuredWords(c: Candidate, withSigma = false): string {
  const motion = motionWords(c);
  if (motion) return `Moves ${motion}`;
  if (c.variability) {
    const s = c.variability.sigma;
    if (s === null) return brightnessWords(c.variability);
    if (withSigma) return `${brightnessWords(c.variability)}, at ${s.toFixed(1)}σ`;
    return `${brightnessWords(c.variability)}${s < 3 ? ", within the noise of the measurement" : ""}`;
  }
  return c.kind === "mover" ? "Its motion could not be measured" : "The size of the change could not be measured";
}

/**
 * How sure the network is that a spot is a real change (its calibrated score, P(mover) + P(variable)),
 * in words. The bands are stated on the page next to the list.
 */
export function sureWords(score: number): string {
  if (score >= 0.9) return "Very sure";
  if (score >= 0.6) return "Fairly sure";
  if (score >= 0.4) return "Unsure";
  return "Doubtful";
}

/** Passes the false-alarm check: q at or below the list's false-discovery rate. */
export const passes = (c: Candidate, alpha: number) => c.q_value <= alpha + 1e-12;

/** Ask "What the network sees" to show one find; it scrolls to it and moves focus there. */
export const SHOW_FIND = "ai:show-find";
const showFind = (id: string) => window.dispatchEvent(new CustomEvent<string>(SHOW_FIND, { detail: id }));

const LONG_MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
/** "2025-05-07" to "May 2025". */
const monthYear = (iso: string) => {
  const [y, m] = iso.split("-").map(Number);
  return `${LONG_MONTHS[m - 1] ?? "?"} ${y}`;
};
/** "2026-11-15T07:09:45Z" to "15 November 2026" (UTC). */
const runDay = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : `${d.getUTCDate()} ${LONG_MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};

const count = (n: number) => n.toLocaleString("en-GB");

export function Finds() {
  const load = useCandidates();
  if (load.state === "loading") return <FindsSkeleton />;
  if (load.state !== "ok") return <Pending load={load} what="candidate list" />;
  if (load.data.candidates.length === 0) {
    return <p className="text-ui text-fg-faint">The survey has not listed any candidates yet.</p>;
  }
  return <FindsList data={load.data} />;
}

/** Lines of text as blocks: `phone` lines below 640 px, `wide` from there, where the column is wider. */
function LinesSkeleton({ phone, wide, className, last }: { phone: number; wide: number; className: string; last?: string }) {
  return (
    <>
      <SkeletonText lines={phone} last={last} className={cn(className, "sm:hidden")} />
      <SkeletonText lines={wide} last={last} className={cn(className, "hidden sm:flex")} />
    </>
  );
}

/** While the candidate list loads: the lines above the finds and the first cards, as blocks in their places. */
function FindsSkeleton() {
  return (
    <SkeletonRegion label="Loading the finds" className="flex flex-col gap-10">
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <LinesSkeleton phone={5} wide={4} className="measure text-body" />
          <LinesSkeleton phone={6} wide={4} className="measure text-meta" last="40%" />
        </div>
        <div className="measure flex flex-col gap-1.5">
          <LinesSkeleton phone={7} wide={4} className="text-meta" last="70%" />
          <LinesSkeleton phone={4} wide={2} className="text-meta" />
          <LinesSkeleton phone={3} wide={2} className="text-meta" last="40%" />
        </div>
        <div aria-hidden className="-ml-2 flex h-9 items-center gap-1.5 self-start px-2 reduced:hidden">
          <Skeleton className="size-3.5 rounded-[3px]" />
          <Skeleton className="h-2.5 w-24 rounded-[3px]" />
        </div>
      </div>
      <div>
        <SkeletonText lines={1} className="w-[min(100%,16rem)] text-lead" />
        <LinesSkeleton phone={5} wide={3} className="measure mt-1.5 text-meta" />
        <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <FindCardSkeleton key={i} />
          ))}
        </div>
      </div>
    </SkeletonRegion>
  );
}

/** One find's card as blocks: the pictures, the dates, the name, the two readings, the measurement and the two links. */
function FindCardSkeleton() {
  return (
    <div aria-hidden className="flex w-full min-w-0 flex-col rounded-[18px] border border-hair bg-ink-2 p-3">
      <Skeleton className="aspect-[2/1] w-full rounded-[12px] reduced:aspect-[3/1]" />
      <SkeletonText lines={1} className="mt-1.5 w-1/3 text-micro" />
      <div className="mt-3 flex flex-col gap-1 px-1">
        <SkeletonText lines={1} className="w-4/5 text-ui" />
        <SkeletonText lines={1} className="w-3/5 text-meta" />
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 px-1">
        {[0, 1].map((i) => (
          <div key={i} className="flex min-w-0 flex-col">
            <SkeletonText lines={1} className="w-4/5 text-micro" />
            <SkeletonText lines={1} className="mt-0.5 w-3/5 text-ui" />
          </div>
        ))}
      </div>
      <SkeletonText lines={2} className="mt-2 px-1 text-meta" />
      <div className="mt-auto flex items-center gap-1 pt-3">
        <span className="flex h-9 items-center px-2">
          <Skeleton className="h-2.5 w-24 rounded-[3px]" />
        </span>
        <span className="ml-auto flex h-9 items-center px-2">
          <Skeleton className="h-2.5 w-24 rounded-[3px]" />
        </span>
      </div>
    </div>
  );
}

const FIELD_KIND_WORDS: Record<string, [string, string]> = {
  target: ["challenge target", "challenge targets"],
  "known-mover": ["known fast-moving star", "known fast-moving stars"],
  "brown-dwarf": ["known brown dwarf", "known brown dwarfs"],
  variable: ["known variable star", "known variable stars"],
  control: ["control patch where nothing is expected", "control patches where nothing is expected"],
};

/** "a, b and c". */
const listWords = (parts: string[]) =>
  parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;

/** What the patches are centred on, counted from the list's fields: "5 challenge targets, ... and 10 control patches". */
function fieldMix(data: Discoveries): string | null {
  const counts = new Map<string, number>();
  for (const f of data.fields) counts.set(f.kind, (counts.get(f.kind) ?? 0) + 1);
  const parts: string[] = [];
  for (const [kind, [one, many]] of Object.entries(FIELD_KIND_WORDS)) {
    const n = counts.get(kind);
    if (n) parts.push(`${count(n)} ${n === 1 ? one : many}`);
    counts.delete(kind);
  }
  const other = [...counts.values()].reduce((a, b) => a + b, 0);
  if (other) parts.push(`${count(other)} other ${other === 1 ? "patch" : "patches"}`);
  return parts.length > 0 ? listWords(parts) : null;
}

/** A few lines on what was searched, where, when, and how much was flagged and kept. */
function Scope({ data }: { data: Discoveries }) {
  const days = [...data.candidates, ...data.targets.flatMap((t) => (t.candidate ? [t.candidate] : []))]
    .flatMap((c) => c.epochs ?? [])
    .sort();
  const flagged = data.fields.reduce((sum, f) => sum + (f.n_candidates ?? 0), 0);
  const nFields = data.survey.n_fields ?? (data.fields.length || null);
  const area = data.survey.area_deg2;
  const run = data.generated ? runDay(data.generated) : null;
  const mix = fieldMix(data);
  const { detectors, epochs_median: visits } = data.survey;
  return (
    <div className="flex flex-col gap-2">
      <p className="measure text-body text-pretty text-fg-dim" data-testid="ai-scope">
        {nFields !== null && (
          <>
            The search covered {count(nFields)} patches of sky{area !== null && <>, {area.toFixed(2)} square degrees in all</>}
            {days.length > 1 && (
              <>
                , comparing SPHEREx visits from {monthYear(days[0])} to {monthYear(days[days.length - 1])}
              </>
            )}
            {run && <>; it ran on {run}</>}.{" "}
          </>
        )}
        {flagged > 0
          ? `Of the ${count(flagged)} changes the finder flagged, the AI kept the ${count(data.candidates.length)} below.`
          : `The AI kept the ${count(data.candidates.length)} below.`}
      </p>
      {(mix || detectors.length > 0 || visits !== null) && (
        <p className="measure text-meta text-pretty text-fg-dim" data-testid="ai-scope-fields">
          {mix && <>The patches are centred on {mix}. </>}
          {detectors.length > 0 && (
            <>
              The search used detectors {listWords(detectors)}, the longest-wavelength ones, where cold brown dwarfs shine
              brightest
            </>
          )}
          {visits !== null && (
            <>
              {detectors.length > 0 ? ", and a typical patch was visited " : "A typical patch was visited "}
              {count(visits)} times
            </>
          )}
          {(detectors.length > 0 || visits !== null) && "."}
        </p>
      )}
    </div>
  );
}

function FindsList({ data }: { data: Discoveries }) {
  const reduce = useEffectiveReducedMotion();
  const blinkMs = usePreference("labBlinkMs");
  const [paused, setPaused] = React.useState(false);
  const { ref } = useBlinkClock<HTMLDivElement>(blinkMs, !paused && !reduce);
  const alpha = data.fdr.alpha ?? 0.05;
  const sorted = React.useMemo(() => [...data.candidates].sort(byConfidence), [data.candidates]);
  const passed = sorted.filter((c) => passes(c, alpha));
  const weaker = sorted.filter((c) => !passes(c, alpha));
  const known = passed.filter((c) => c.match.status === "known").length;

  // The field most of the weaker finds share, if one does.
  const byField = new Map<string, number>();
  for (const c of weaker) byField.set(c.field, (byField.get(c.field) ?? 0) + 1);
  const [crowded, crowdedN] = [...byField.entries()].sort((a, b) => b[1] - a[1])[0] ?? ["", 0];

  // Finds in fields the network trained on show the chain working, not how it does on unseen sky.
  const trained = passed.length > 0 && passed.every((c) => fieldRole(data.model.name, c.field) === "train");
  const passedNote =
    passed.length === 0
      ? null
      : (known === passed.length
          ? `${passed.length === 1 ? "It is an object" : passed.length === 2 ? "Both are objects" : `All ${passed.length} are objects`} already in catalogues, so nothing new has passed.`
          : `${known === 0 ? "None" : count(known)} ${known === 1 ? "is" : "are"} already in catalogues; ${count(passed.length - known)} ${passed.length - known === 1 ? "is" : "are"} new.`) +
        (trained
          ? ` ${passed.length === 1 ? "It is in a field" : "They are in fields"} the network trained on, so ${passed.length === 1 ? "it shows" : "they show"} the search working rather than how it does on sky it has never seen.`
          : "");

  return (
    <div ref={ref} className="group/blink flex flex-col gap-10" data-testid="ai-finds">
      <div className="flex flex-col gap-4">
        <Scope data={data} />
        <div className="measure flex flex-col gap-1.5 text-meta text-pretty text-fg-dim">
          <p>
            <span className="text-fg">How sure the AI is</span> comes from the network’s score for a real change rather than an artifact or
            nothing: very sure from 90%, fairly sure from 60%, unsure from 40%, doubtful below. Ordinary spots in other fields can
            score as high, so a high score alone does not make a find; only the false-alarm check decides what is reported.
          </p>
          <p>
            <span className="text-fg">The false-alarm check</span> asks whether the spot stands out from ordinary spots in other
            fields; the search reports only the finds that pass it. The statistics are under{" "}
            <a href="#statistics" className="text-fg underline decoration-hair-strong underline-offset-4 transition-colors hover:decoration-accent">
              How it decides
            </a>
            .
          </p>
          <p>
            <span className="text-fg">Known</span> means Gaia DR3, CatWISE2020 or SIMBAD lists a source within 6″ (moving the
            same way, for a mover); <span className="text-fg">new</span> means none is close enough.
          </p>
        </div>
        {!reduce && (
          <BlinkToggle paused={paused} onToggle={() => setPaused((p) => !p)} className="-ml-2 self-start" testId="ai-blink-toggle" />
        )}
      </div>

      <Group
        id="finds-passed"
        title="Passed the false-alarm check"
        note={passedNote}
        items={passed}
        data={data}
        alpha={alpha}
        reduce={reduce}
      />
      <Group
        id="finds-weaker"
        title="Worth a look, but did not pass"
        note={`The AI flagged these too, but they do not stand out enough from ordinary spots to pass. They are here so you can judge them yourself.${
          crowdedN >= 3 && crowdedN * 2 > weaker.length
            ? ` ${count(crowdedN)} of them are in the ${fieldName(data, crowded)} field.`
            : ""
        }`}
        items={weaker}
        data={data}
        alpha={alpha}
        reduce={reduce}
      />

      <FoundAgain data={data} reduce={reduce} alpha={alpha} />

      <footer className="measure flex flex-col gap-2 border-t border-hair pt-5 text-micro text-pretty text-fg-faint">
        <p>
          Every find is unconfirmed. Known objects are the easiest to trust; bright stars that fill the detector can leave marks
          that look like changes, so check the pictures and open the Lab.
        </p>
        {data.dropped > 0 && (
          <p data-testid="ai-dropped-note">
            {data.dropped === 1 ? "One entry" : `${count(data.dropped)} entries`} in the list file had missing or impossible values
            and {data.dropped === 1 ? "is" : "are"} not shown.
          </p>
        )}
        <p>
          Data: SPHEREx (NASA/JPL-Caltech) from IRSA, DR1 and Quick Release 3; Gaia DR3 (ESA/Gaia/DPAC); CatWISE2020; SIMBAD
          (CDS).
        </p>
      </footer>
    </div>
  );
}

function Group({
  id,
  title,
  note,
  items,
  data,
  alpha,
  reduce,
}: {
  id: string;
  title: string;
  note: string | null;
  items: Candidate[];
  data: Discoveries;
  alpha: number;
  reduce: boolean;
}) {
  if (items.length === 0) return null;
  return (
    <section aria-labelledby={`${id}-title`} id={id} className="scroll-mt-24" data-testid={id}>
      <h3 id={`${id}-title`} className="text-lead text-fg">
        {title} <span className="readout text-fg-dim">{count(items.length)}</span>
      </h3>
      {note && <p className="measure mt-1.5 text-meta text-pretty text-fg-dim">{note}</p>}
      <ul className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((c) => (
          <li key={c.id} className="flex min-w-0">
            <FindCard c={c} field={fieldName(data, c.field)} pass={passes(c, alpha)} reduce={reduce} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function MatchLine({ c }: { c: Candidate }) {
  const m = c.match;
  if (m.status === "known") {
    return (
      <p className="text-meta text-pretty text-fg-dim">
        Known: <span className="text-fg">{displayName(m.name ?? m.id ?? "a catalogued source")}</span>
        {m.catalog && <> in {m.catalog}</>}
        {m.sep_arcsec !== null && <>, {m.sep_arcsec.toFixed(1)}″ away</>}
      </p>
    );
  }
  return (
    <p className="text-meta text-pretty text-fg-dim">
      <span className="text-accent">New:</span> no catalogued source close enough
    </p>
  );
}

function FindCard({ c, field, pass, reduce }: { c: Candidate; field: string; pass: boolean; reduce: boolean }) {
  const source: StampSource | null = c.stamp ? { type: "strip", src: c.stamp } : null;
  const title = candidateTitle(c);
  return (
    <article
      data-testid="ai-find"
      data-id={c.id}
      data-kind={c.kind}
      data-match={c.match.status}
      data-pass={pass ? "yes" : "no"}
      className="flex w-full min-w-0 flex-col rounded-[18px] border border-hair bg-ink-2 p-3 transition-colors duration-200 hover:border-hair-strong"
    >
      {source ? (
        <button
          type="button"
          onClick={() => showFind(c.id)}
          aria-label={`${title} in the ${field} field: see what the AI saw`}
          className="block w-full overflow-hidden rounded-[12px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {reduce ? (
            <span className="grid grid-cols-3 gap-1">
              <StampPanel source={source} panel={0} />
              <StampPanel source={source} panel={1} />
              <StampPanel source={source} panel={2} />
            </span>
          ) : (
            <span className="grid grid-cols-2 gap-1">
              <BlinkPanels source={source} />
              <StampPanel source={source} panel={2} />
            </span>
          )}
        </button>
      ) : (
        <div className="grid aspect-[2/1] place-items-center rounded-[12px] bg-ink-3 text-meta text-fg-faint">No stamp</div>
      )}
      {source && c.epochs && (
        <p aria-hidden className={cn("mt-1.5 grid gap-1 text-micro text-fg-faint", reduce ? "grid-cols-3" : "grid-cols-2")}>
          {reduce ? (
            <>
              <span>{formatDay(c.epochs[0])}</span>
              <span>{formatDay(c.epochs[1])}</span>
            </>
          ) : (
            <span className="readout">
              <PhaseText phase={0}>{formatDay(c.epochs[0])}</PhaseText>
              <PhaseText phase={1}>{formatDay(c.epochs[1])}</PhaseText>
            </span>
          )}
          <span>Difference</span>
        </p>
      )}

      <div className="mt-3 flex flex-col gap-1 px-1">
        <h4 className="text-ui font-medium text-fg">
          {title}
          <span className="font-normal text-fg-dim"> in the {field} field</span>
        </h4>
        <MatchLine c={c} />
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-2 px-1">
        <div className="min-w-0">
          <dt className="text-micro text-fg-faint">How sure the AI is</dt>
          <dd className="mt-0.5 text-ui text-fg" data-testid="ai-find-sure">
            {sureWords(c.score)}, <span className="readout">{percent(c.score)}</span>
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-micro text-fg-faint">False-alarm check</dt>
          <dd className={cn("mt-0.5 text-ui", pass ? "text-fg" : "text-fg-dim")} data-testid="ai-find-check">
            {pass ? "Passed" : "Not passed"}
          </dd>
        </div>
      </dl>

      <p className="mt-2 px-1 text-meta text-pretty text-fg-dim">{measuredWords(c)}.</p>

      <div className="mt-auto flex flex-wrap items-center gap-1 pt-3">
        <button
          type="button"
          onClick={() => showFind(c.id)}
          data-testid="ai-find-show"
          className="inline-flex h-9 items-center rounded-[8px] px-2 text-meta text-fg-dim transition-colors hover:bg-white/[0.05] hover:text-fg"
        >
          What the AI saw
        </button>
        <Link
          href={c.lab_url}
          data-testid="ai-find-lab"
          className="ml-auto inline-flex h-9 items-center gap-1 rounded-[8px] px-2 text-meta text-fg transition-colors hover:bg-white/[0.05]"
        >
          Open in the Lab
          <ArrowUpRightIcon aria-hidden className="size-3.5 text-fg-dim" />
        </Link>
      </div>
    </article>
  );
}
