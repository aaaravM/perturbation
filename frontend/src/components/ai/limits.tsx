"use client";
// What the two networks miss or cannot do, in plain words. Every number is read from the same files
// as the rest of the page (candidates.json and specclass.json), so a new model run updates it; the
// fixed facts come from docs/validation and the live checks described on this page.

import type { ReactNode } from "react";
import Link from "next/link";
import { capital, isNum, pct } from "@/components/how-it-works/model-results";
import { Term } from "@/components/ui/term";
import { passes } from "./finds";
import { NULL_SCORES } from "./network-examples";
import { useCandidates, useSpecCard } from "./results";

export const VALIDATION_URL = "https://github.com/aaaravM/perturbation/tree/main/docs/validation";

const LINK = "text-fg underline decoration-hair-strong underline-offset-4 transition-colors hover:decoration-accent";

const plural = (name: string) => (name.endsWith("y") ? `${name.slice(0, -1)}ies` : `${name}s`);

/** "a, b and c" */
const list = (items: string[]) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

export function Limits() {
  const movers = useCandidates();
  const spec = useSpecCard();
  const m = movers.state === "ok" ? movers.data.model.metrics : {};
  const alpha = movers.state === "ok" ? (movers.data.fdr.alpha ?? 0.05) : 0.05;
  const reported = movers.state === "ok" ? movers.data.candidates.filter((c) => passes(c, alpha)) : [];
  const known = reported.filter((c) => c.match.status === "known").length;
  const s = spec.state === "ok" ? spec.data : null;
  const names = new Map((s?.classes ?? []).map((c) => [c.key, c.name]));
  const thin = Object.entries(s?.n_test_by_class ?? {})
    .filter(([, n]) => isNum(n) && n < 30)
    .map(([k, n]) => `${n} ${plural(names.get(k) ?? k.replace(/_/g, " "))}`);
  const recall = Object.entries(s?.test_recall_by_class ?? {}).filter(([k]) => (s?.n_test_by_class?.[k] ?? 0) >= 30);
  const weakest = recall.length ? recall.reduce((a, b) => (b[1] < a[1] ? b : a)) : null;
  const ci = s?.test_accuracy_ci90;

  const items: { title: string; text: ReactNode }[] = [
    {
      title: "Slow movers are mostly missed",
      text: (
        <>
          {pct(m.mover_completeness_snr10) && pct(m.mover_completeness_shift_ge_1px_snr10)
            ? `Of clear movers, it finds ${pct(m.mover_completeness_snr10)} over all the speeds tested, against ${pct(m.mover_completeness_shift_ge_1px_snr10)} of those that shift at least a pixel. `
            : ""}
          A pixel is 6.15″ wide, so a star moving 1″ a year shifts a sixth of a pixel in a year and leaves almost nothing in the
          difference.
        </>
      ),
    },
    {
      title: "Very bright stars are out of reach",
      text: (
        <>
          Stars that <Term k="saturated">saturate</Term> the detector are masked, so the finder sees only their wings: it does not
          find Barnard’s Star, RW Aurigae or R Draconis. The spectral cube is blank at their centres, so the spectral classifier
          declines rather than guess, as it does for Barnard’s Star (try it above).
        </>
      ),
    },
    {
      title: "Spectral classes are a best guess",
      text: s ? (
        <>
          {pct(s.test_accuracy)} of test spectra get the catalogue’s class
          {ci && isNum(ci[0]) && isNum(ci[1]) ? ` (${pct(ci[0])} to ${pct(ci[1])} across sky tiles)` : ""}
          {isNum(s.test_accuracy) && s.test_accuracy < 1 ? `, so about 1 in ${Math.round(1 / (1 - s.test_accuracy))} is wrong` : ""}.
          {weakest && names.get(weakest[0]) ? ` It does worst on ${plural(names.get(weakest[0])!)}: ${pct(weakest[1])} right.` : ""}
        </>
      ) : (
        "Its accuracy is in the model card above."
      ),
    },
    {
      title: "Rare kinds are thinly tested",
      text: thin.length
        ? `Its test set holds only ${list(thin)}, so its shares for those kinds are uncertain.`
        : "Some kinds have few test spectra, so their shares are uncertain.",
    },
    {
      title: "Neighbours blend",
      text: "The quick-look spectrum comes from pixels 12.9″ wide, so the light of a close neighbour can mix in and mislead the classifier.",
    },
    {
      title: "Few fields to compare against",
      text: `The false-alarm check compares each score with ${NULL_SCORES.toLocaleString("en-GB")} ordinary scores from 8 validation fields. A field has about 60 candidates, so the first one reported must beat nearly all of them, and weaker real changes are left out.`,
    },
    {
      title: "A candidate is not a discovery",
      text:
        movers.state === "ok"
          ? `${capital(reported.length === 0 ? "no find passes" : `${reported.length} find${reported.length === 1 ? " passes" : "s pass"}`)} the false-alarm check${
              reported.length > 0 && known === reported.length
                ? `, ${reported.length === 1 ? "an object" : reported.length === 2 ? "both objects" : "all objects"} already known`
                : ""
            }. Anything flagged stays a candidate until other data confirm it.`
          : "Anything flagged stays a candidate until other data confirm it.",
    },
  ];

  return (
    <div className="flex flex-col gap-8" data-testid="ai-limits">
      <ul className="grid max-w-4xl grid-cols-1 gap-x-10 gap-y-6 md:grid-cols-2">
        {items.map((l) => (
          <li key={l.title} className="flex flex-col gap-1.5 border-t border-hair pt-4">
            <p className="text-ui text-fg">{l.title}</p>
            <p className="text-meta text-pretty text-fg-dim">{l.text}</p>
          </li>
        ))}
      </ul>
      <p className="measure text-body text-pretty text-fg-dim">
        More on each: <Link href="/how-it-works#search" className={LINK}>how the search works</Link>, the{" "}
        <a href="#finds" className={LINK}>finds above</a>, and the{" "}
        <a href={VALIDATION_URL} className={LINK}>
          validation reports on GitHub
        </a>
        .
      </p>
    </div>
  );
}
