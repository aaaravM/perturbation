"use client";
// What the mover network sees, find by find, from the published survey list
// (/discoveries/candidates.json): the stamp it was shown, its four probabilities, how sure it is and
// whether the find passed the false-alarm check (in words, then the numbers), the signal, what was
// measured, the catalogue match and a way into the Lab. "What the AI saw" on a find above opens it
// here. Nothing is shown that the list does not contain.

import * as React from "react";
import Link from "next/link";
import { ArrowUpRightIcon, ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { Term } from "@/components/ui/term";
import {
  CLASS_LABEL,
  CLASS_NAMES,
  daysBetween,
  fieldName,
  formatDay,
  formatQ,
  percent,
  probPercent,
  type Candidate,
  type Discoveries,
} from "@/lib/discoveries";
import { capital } from "@/components/how-it-works/model-results";
import { useEffectiveReducedMotion } from "@/lib/preferences";
import { cn } from "@/lib/utils";
import { ROLE_WORDS, SPLIT_MODEL, fieldRole } from "./field-split";
import { SHOW_FIND, candidateTitle, measuredWords, passes, sureWords } from "./finds";
import { Pending, useCandidates } from "./results";
import { StampPanel } from "./stamp";

/**
 * The null set behind every p-value of realbogus_v1 (docs/validation/movers.md): 425 real candidates
 * from the 8 validation fields, each scored in its 8 orientations. p = (1 + #{null >= s}) / (3,400 + 1).
 */
export const NULL_SCORES = 3400;
export const NULL_SPOTS = 425;

/** How many of the null scores were at least as high, read back from a p-value; null if it does not fit. */
export function nullAtLeast(p: number | null, model: string | null): number | null {
  if (p === null || model !== SPLIT_MODEL) return null;
  const x = p * (NULL_SCORES + 1);
  const k = Math.round(x);
  return k >= 1 && Math.abs(x - k) < 0.05 ? k - 1 : null;
}

/**
 * The 21 x 21 pixels the network reads, inside the published 64 x 64 panel (a 2x view of 32 x 32
 * pixels, columns x - 16 to x + 15, north up): columns 6 to 26 and rows 5 to 25 of the 32.
 */
const NETWORK_WINDOW = { left: "18.75%", top: "15.625%", size: "65.625%" };

/** Clear examples first: the most certain mover and variable that pass the test, then the rest by q. */
function ordered(list: Candidate[], alpha: number): Candidate[] {
  const pass = list.filter((c) => passes(c, alpha));
  const best = (kind: "mover" | "variable") =>
    pass.filter((c) => c.kind === kind).sort((a, b) => b.probs[kind] - a.probs[kind])[0];
  const first = [best("mover"), best("variable")].filter((c): c is Candidate => !!c);
  return [...first, ...list.filter((c) => !first.includes(c))];
}

export function NetworkExamples() {
  const load = useCandidates();
  if (load.state !== "ok") return <Pending load={load} what="candidate list" />;
  if (load.data.candidates.length === 0) {
    return <p className="text-ui text-fg-faint">The survey has not listed any candidates yet.</p>;
  }
  return <Examples data={load.data} />;
}

function Examples({ data }: { data: Discoveries }) {
  const alpha = data.fdr.alpha ?? 0.05;
  const list = React.useMemo(() => ordered(data.candidates, alpha), [data.candidates, alpha]);
  const [index, setIndex] = React.useState(0);
  const [jump, setJump] = React.useState(0);
  const reduce = useEffectiveReducedMotion();
  const exampleRef = React.useRef<HTMLDivElement>(null);
  const c = list[Math.min(index, list.length - 1)];
  const passing = list.filter((x) => passes(x, alpha));
  const rest = list.filter((x) => !passes(x, alpha));
  const step = (d: number) => setIndex((i) => (i + d + list.length) % list.length);
  const trained = passing.length > 0 && passing.every((x) => fieldRole(data.model.name, x.field) === "train");

  // "What the AI saw" on a find above: show it here.
  React.useEffect(() => {
    const show = (e: Event) => {
      const i = list.findIndex((x) => x.id === (e as CustomEvent<string>).detail);
      if (i < 0) return;
      setIndex(i);
      setJump((n) => n + 1);
    };
    window.addEventListener(SHOW_FIND, show);
    return () => window.removeEventListener(SHOW_FIND, show);
  }, [list]);
  // Once it is drawn, bring it into view and move focus to its title.
  React.useEffect(() => {
    if (!jump) return;
    const el = exampleRef.current;
    if (!el) return;
    el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
    el.querySelector<HTMLElement>("#ai-example-title")?.focus({ preventScroll: true });
  }, [jump, reduce]);

  return (
    <div className="flex flex-col gap-8" data-testid="ai-examples">
      <p className="measure text-body text-pretty text-fg-dim" data-testid="ai-survey-line">
        Pick any of the {list.length} finds, or step through them, to see the stamp the network was given and everything it said.
      </p>
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap gap-x-10 gap-y-4">
          <Picker title="Passed the false-alarm check" items={passing} list={list} current={c} data={data} onPick={setIndex} />
          <Picker title="Did not pass" items={rest} list={list} current={c} data={data} onPick={setIndex} />
        </div>
        <div className="flex items-center gap-1">
          <StepButton label="Previous example" onClick={() => step(-1)}>
            <ChevronLeftIcon aria-hidden className="size-4" />
          </StepButton>
          <p className="min-w-[7.5rem] text-center text-meta text-fg-dim" aria-live="polite" data-testid="ai-example-count">
            Example <span className="readout text-fg">{list.indexOf(c) + 1}</span> of <span className="readout">{list.length}</span>
          </p>
          <StepButton label="Next example" onClick={() => step(1)}>
            <ChevronRightIcon aria-hidden className="size-4" />
          </StepButton>
        </div>
      </div>

      <div ref={exampleRef} className="scroll-mt-24">
        <Example key={c.id} c={c} data={data} alpha={alpha} />
      </div>

      {trained && (
        <p className="measure text-meta text-pretty text-fg-dim" data-testid="ai-trained-note">
          {passing.length === 1
            ? "The candidate that passes is in a field the network trained on, and it saw that field’s real candidates while it learned. It shows"
            : `${passing.length === 2 ? "Both candidates" : `All ${passing.length} candidates`} that pass are in fields the network trained on, and it saw their real candidates while it learned. They show`}{" "}
          the whole chain working, not how well it does on sky it has never seen; the test-field numbers in the next section measure
          that.
        </p>
      )}
    </div>
  );
}

function StepButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="grid size-11 place-items-center rounded-[10px] text-fg-dim transition-colors hover:bg-white/[0.05] hover:text-fg"
    >
      {children}
    </button>
  );
}

function Picker({
  title,
  items,
  list,
  current,
  data,
  onPick,
}: {
  title: string;
  items: Candidate[];
  list: Candidate[];
  current: Candidate;
  data: Discoveries;
  onPick: (i: number) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <p className="text-micro text-fg-faint">
        {title} (<span className="readout">{items.length}</span>)
      </p>
      <ul className="flex flex-wrap gap-1.5" aria-label={title}>
        {items.map((c) => {
          const i = list.indexOf(c);
          const on = c.id === current.id;
          return (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => onPick(i)}
                aria-current={on ? "true" : undefined}
                aria-label={`Example ${i + 1}: ${candidateTitle(c).toLowerCase()} in the ${fieldName(data, c.field)} field`}
                data-testid="ai-pick"
                className={cn(
                  "relative block size-11 overflow-hidden rounded-[8px] bg-black ring-1 transition-[opacity,box-shadow] duration-200",
                  on ? "ring-accent" : "opacity-60 ring-hair hover:opacity-100",
                )}
              >
                {c.stamp ? (
                  <StampPanel source={{ type: "strip", src: c.stamp }} panel={2} className="absolute inset-0" />
                ) : (
                  <span aria-hidden className="readout text-micro text-fg-faint">
                    {i + 1}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const PANELS = [
  { label: "Earlier co-add", date: 0 },
  { label: "Later co-add", date: 1 },
  { label: "S/N difference", date: null },
] as const;

function Example({ c, data, alpha }: { c: Candidate; data: Discoveries; alpha: number }) {
  return (
    <article
      aria-labelledby="ai-example-title"
      data-testid="ai-example"
      data-id={c.id}
      className="grid grid-cols-1 gap-x-10 gap-y-8 animate-in fade-in-0 duration-300 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] reduced:animate-none"
    >
      <figure className="flex min-w-0 flex-col gap-3">
        {c.stamp ? (
          <div className="grid grid-cols-3 gap-2">
            {PANELS.map((p, i) => (
              <div key={p.label} className="flex min-w-0 flex-col gap-1.5">
                <div className="relative">
                  <StampPanel source={{ type: "strip", src: c.stamp! }} panel={i as 0 | 1 | 2} className="rounded-[10px]" />
                  <span
                    aria-hidden
                    data-testid="ai-network-window"
                    className="pointer-events-none absolute border border-accent/70"
                    style={{ left: NETWORK_WINDOW.left, top: NETWORK_WINDOW.top, width: NETWORK_WINDOW.size, height: NETWORK_WINDOW.size }}
                  />
                </div>
                <span className="text-micro text-fg-dim">
                  {p.label}
                  {p.date !== null && c.epochs && <span className="readout block text-fg-faint">{formatDay(c.epochs[p.date])}</span>}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="grid aspect-[3/1] place-items-center rounded-[10px] bg-ink-3 text-meta text-fg-faint">No stamp</div>
        )}
        <figcaption className="flex flex-col gap-1.5 text-micro text-pretty text-fg-faint">
          <span>
            The first three of the four layers the network reads: two <Term k="coadd">co-adds</Term>, each one visit’s pictures
            stacked, and their <Term k="difference">difference</Term>, 32 × 32 pixels around the candidate (3.3 arcminutes),
            north up and east left. In the difference, white is brighter later and black fainter later, or where a source used to
            be.
          </span>
          <span>
            The network reads the 21 × 21 pixels inside the orange square, scaled by their noise, and a fourth layer that is not
            drawn here: a mask of pixels that are missing, overflowed or off the image.
          </span>
        </figcaption>
      </figure>

      <div className="flex min-w-0 flex-col gap-6">
        <div className="flex flex-col gap-1">
          <h3 id="ai-example-title" tabIndex={-1} className="text-lead text-fg outline-none">
            {candidateTitle(c)}
          </h3>
          <p className="text-meta text-pretty text-fg-dim">
            In the {fieldName(data, c.field)} field
            {(() => {
              const role = fieldRole(data.model.name, c.field);
              return role ? `, ${ROLE_WORDS[role]}` : "";
            })()}
            . Candidate <span className="readout">{c.id}</span>
          </p>
        </div>

        <section aria-labelledby="ai-probs-title" className="flex flex-col gap-3">
          <h4 id="ai-probs-title" className="text-ui text-fg">
            What the network says
          </h4>
          <ul className="flex flex-col gap-2.5" data-testid="ai-probs">
            {CLASS_NAMES.map((name) => {
              const p = c.probs[name];
              const top = CLASS_NAMES.every((other) => c.probs[other] <= p);
              return (
                <li key={name} data-class={name} className="grid grid-cols-[8.5rem_minmax(0,1fr)_3.5rem] items-center gap-3">
                  <span className={cn("text-meta", top ? "text-fg" : "text-fg-dim")}>{CLASS_LABEL[name]}</span>
                  <span aria-hidden className="h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
                    <span
                      className={cn("block h-full origin-left rounded-full", top ? "bg-accent" : "bg-fg-faint")}
                      style={{ transform: `scaleX(${Math.max(p, 0.004)})` }}
                    />
                  </span>
                  <span className="readout text-right text-meta text-fg">{probPercent(p)}</span>
                </li>
              );
            })}
          </ul>
        </section>

        <dl data-testid="ai-readout">
          <Row label="How sure">
            {sureWords(c.score)} it is a real change, <span className="readout">{percent(c.score)}</span>
          </Row>
          <Row label="False-alarm check">
            <span data-testid="ai-check">{passes(c, alpha) ? "Passed" : "Not passed"}</span>
            <span className="text-fg-dim">
              . {checkWords(c.p_value, data.model.name)} (q-value <span className="readout">{formatQ(c.q_value)}</span>
              {c.p_value !== null && (
                <>
                  , p-value <span className="readout">{formatQ(c.p_value)}</span>
                </>
              )}
              ).
            </span>
          </Row>
          <Row label="Signal / noise">
            {c.snr !== null ? (
              <>
                <span className="readout">{c.snr.toFixed(1)}</span>
                <span className="text-fg-dim"> times the noise in the difference image</span>
              </>
            ) : (
              <span className="text-fg-dim">Not measured</span>
            )}
          </Row>
          <Row label="Measured">
            <span className="text-fg-dim">{measuredWords(c, true)}</span>
          </Row>
          {c.epochs && (
            <Row label="Compared">
              {formatDay(c.epochs[0])} and {formatDay(c.epochs[1])}
              <span className="text-fg-dim">, {daysBetween(c.epochs)} days apart</span>
            </Row>
          )}
          {c.detectors.length > 0 && <Row label="Seen in">{c.detectors.join(", ")}</Row>}
          <Row label="Position">
            <span className="readout">
              {c.ra.toFixed(5)}°, {c.dec >= 0 ? "+" : "−"}
              {Math.abs(c.dec).toFixed(5)}°
            </span>
            <span className="text-fg-dim"> (RA, Dec)</span>
          </Row>
          <Row label="Catalogue">
            {c.match.status === "known" ? (
              <>
                {c.match.name ?? c.match.id}
                {c.match.catalog && <span className="text-fg-dim"> in {c.match.catalog}</span>}
                {c.match.sep_arcsec !== null && <span className="text-fg-dim">, {c.match.sep_arcsec.toFixed(2)}″ away</span>}
                {c.kind === "mover" && c.match.catalog_pm_arcsec_yr !== null && (
                  <span className="text-fg-dim">
                    ; it moves <span className="readout">{c.match.catalog_pm_arcsec_yr.toFixed(2)}″</span> a year there
                  </span>
                )}
              </>
            ) : (
              <span className="text-fg-dim">No match in Gaia DR3, CatWISE2020 or SIMBAD</span>
            )}
          </Row>
        </dl>

        <div>
          <Link
            href={c.lab_url}
            data-testid="ai-open-lab"
            className="inline-flex h-11 items-center gap-2 rounded-md bg-fg px-5 text-ui font-medium text-ink transition-colors hover:bg-fg/85"
          >
            Open in the Lab
            <ArrowUpRightIcon aria-hidden className="size-4" />
          </Link>
        </div>
      </div>
    </article>
  );
}

function Row({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[8.5rem_minmax(0,1fr)] gap-3 border-b border-hair py-2.5 last:border-b-0">
      <dt className="text-meta text-fg-dim">{label}</dt>
      <dd className="text-meta text-pretty text-fg">{children}</dd>
    </div>
  );
}

const thousands = (n: number) => n.toLocaleString("en-GB");

/** The p-value in words: how many of the ordinary spots' scores were at least this high. */
function checkWords(p: number | null, model: string | null): string {
  if (p === null) return "Its p-value was not recorded";
  const k = nullAtLeast(p, model);
  if (k === null) return "Compared with the scores of ordinary spots in other fields";
  if (k === 0) return `None of the ${thousands(NULL_SCORES)} ordinary spots’ scores was this high`;
  return `${capital(thousands(k))} of the ${thousands(NULL_SCORES)} ordinary spots’ scores ${k === 1 ? "was" : "were"} at least this high`;
}
