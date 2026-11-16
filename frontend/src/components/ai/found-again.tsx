"use client";
// The known objects the search found again, under the AI page's finds: the five challenge targets
// tested at their known positions (the "targets" block of /discoveries/candidates.json), and known
// fast-moving stars the search picked up on its own. Plain words first; a q-value appears only to say
// by how much a target missed the false-alarm check.

import { CheckIcon } from "lucide-react";
import { type Candidate, type Discoveries, type TargetCheck } from "@/lib/discoveries";
import { cn } from "@/lib/utils";
import { BlinkPanels, StampPanel } from "./stamp";

interface FoundItem {
  key: string;
  name: string;
  outcome: "found" | "missed" | "absent";
  verdict: string;
  detail: string;
  candidate: Candidate | null;
}

const kindWord = (k: "mover" | "variable") => (k === "mover" ? "a mover" : "a brightness change");

const NUMBER_WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

function fromTarget(t: TargetCheck, alpha: number): FoundItem {
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
        ? ` Moves ${c.motion.pm_arcsec_yr.toFixed(1)}″ a year; the catalogue says ${t.catalog_pm_arcsec_yr.toFixed(1)}″.`
        : "";
    return {
      key: `t-${t.field}`,
      name: t.name,
      outcome: "found",
      verdict: `Found again as ${kindWord(t.expected)}`,
      detail: `Passed the false-alarm check at its known position${sep}.${pm}`,
      candidate: c,
    };
  }
  const missedCheck = t.q_target > alpha + 1e-12;
  // Within a fifth of the cut-off reads as "just missed"; the q-value itself is in the network view.
  const missed = t.q_target <= alpha * 1.2 + 1e-12 ? "just missed" : "did not pass";
  const detail =
    t.expected && c.kind !== t.expected
      ? `The change seen there${sep}${sep ? "," : ""} looked more like ${kindWord(c.kind)}${missedCheck ? ` and ${missed} the false-alarm check` : ""}.`
      : `A change was seen there${sep}, but it ${missed} the false-alarm check.`;
  return { key: `t-${t.field}`, name: t.name, outcome: "missed", verdict: "Not passed", detail, candidate: c };
}

function fromKnownMover(c: Candidate, alpha: number): FoundItem {
  const pm = c.motion ? `Moves ${c.motion.pm_arcsec_yr.toFixed(1)}″ a year` : "Moves";
  const cat = c.match.catalog_pm_arcsec_yr !== null ? `; the catalogue says ${c.match.catalog_pm_arcsec_yr.toFixed(1)}″` : "";
  const pass = c.q_value <= alpha + 1e-12;
  return {
    key: `c-${c.id}`,
    name: c.match.name ?? c.match.id ?? "Known star",
    outcome: pass ? "found" : "missed",
    verdict: pass ? "Found again as a mover" : "Not passed",
    detail: `${pm}${cat}. The search picked it up on its own${pass ? " and it passed the false-alarm check" : ", but it did not pass the false-alarm check"}.`,
    candidate: c,
  };
}

export function foundAgainItems(data: Discoveries, alpha: number): FoundItem[] {
  const targets = data.targets.map((t) => fromTarget(t, alpha));
  const order = { found: 0, missed: 1, absent: 2 } as const;
  targets.sort((a, b) => order[a.outcome] - order[b.outcome]);
  const movers = data.candidates
    .filter((c) => c.kind === "mover" && c.match.status === "known" && c.match.catalog_pm_arcsec_yr !== null)
    .map((c) => fromKnownMover(c, alpha));
  return [...movers, ...targets];
}

/** Sits inside the finds' group/blink container, so its stamps blink with theirs. */
export function FoundAgain({ data, reduce, alpha }: { data: Discoveries; reduce: boolean; alpha: number }) {
  const items = foundAgainItems(data, alpha);
  if (items.length === 0) return null;
  const found = items.filter((i) => i.outcome === "found").length;
  const n = data.targets.length;
  return (
    <section aria-labelledby="found-again-title" id="found-again" data-testid="found-again" className="scroll-mt-24">
      <h3 id="found-again-title" className="text-lead text-fg">
        Known objects found again
      </h3>
      <p className="measure mt-1.5 text-meta text-pretty text-fg-dim">
        A search that misses what is already known cannot be trusted with anything new.
        {n > 0 && <> The {NUMBER_WORDS[n] ?? n} challenge targets were tested where catalogues say they are; </>}
        {n === 0 && " "}known fast-moving stars that the search picked up by itself are here too.{" "}
        <span className="text-fg" data-testid="found-again-count">
          {found} of {items.length} found again.
        </span>
      </p>
      <ul className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
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
            <h4 className="mt-2.5 px-0.5 text-ui font-medium text-fg">{item.name}</h4>
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
