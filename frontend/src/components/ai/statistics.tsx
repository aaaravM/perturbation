"use client";
// The statistics behind the false-alarm check, in one fold that starts closed: the score, the
// conformal p-value against the validation fields' null set, the Benjamini-Hochberg q-value within
// each field, and the false alarms measured on the test fields with their 95% upper limit (the
// "model" and "fdr" blocks of /discoveries/candidates.json; backend/src/pxh/ml/fdr.py;
// docs/validation/movers.md). A link to #statistics opens it.

import * as React from "react";
import { ChevronRightIcon } from "lucide-react";
import { fmt, isNum } from "@/components/how-it-works/model-results";
import { RepoLink } from "@/components/how-it-works/shell";
import { cn } from "@/lib/utils";
import { NULL_SCORES, NULL_SPOTS } from "./network-examples";
import { useCandidates } from "./results";

const thousands = (n: number) => n.toLocaleString("en-GB");

export function Statistics() {
  const ref = React.useRef<HTMLDetailsElement>(null);
  const load = useCandidates();
  const data = load.state === "ok" ? load.data : null;
  const m = data?.model.metrics ?? {};
  const alpha = data?.fdr.alpha ?? 0.05;

  // Arriving at #statistics, from a link on this page or another, opens the fold.
  React.useEffect(() => {
    const open = () => {
      if (window.location.hash === "#statistics" && ref.current) ref.current.open = true;
    };
    open();
    window.addEventListener("hashchange", open);
    return () => window.removeEventListener("hashchange", open);
  }, []);

  return (
    <details
      ref={ref}
      id="statistics"
      data-testid="ai-statistics"
      className="group max-w-3xl scroll-mt-24 rounded-[14px] border border-hair bg-ink-2/60 open:bg-ink-2"
    >
      <summary
        className={cn(
          "flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-[14px] px-4 text-ui text-fg-dim transition-colors",
          "hover:text-fg [&::-webkit-details-marker]:hidden",
        )}
      >
        <ChevronRightIcon
          aria-hidden
          className="size-4 shrink-0 transition-transform duration-300 ease-out-expo group-open:rotate-90 reduced:transition-none"
        />
        The statistics behind the false-alarm check
      </summary>
      <div className="flex flex-col gap-5 border-t border-hair px-4 pt-4 pb-5 group-open:animate-in group-open:fade-in-0 group-open:slide-in-from-top-1 reduced:animate-none">
        <dl className="flex flex-col gap-4">
          <Item term="Score">
            P(mover) + P(variable), the network’s calibrated chance that the spot is a real change. On the real sky, ordinary spots
            far outnumber real changes, so a high score alone is not enough.
          </Item>
          <Item term="Conformal p-value">
            The share of ordinary spots that scored at least as high: p = (1 + k) ÷ ({thousands(NULL_SCORES)} + 1), where k of{" "}
            {thousands(NULL_SCORES)} null scores are at least the candidate’s. The null set is {NULL_SPOTS} real candidates from the 8
            validation fields, with any near a known fast-moving or variable star removed, each turned 8 ways. The smallest
            possible p is 1 ÷ {thousands(NULL_SCORES + 1)}.
          </Item>
          <Item term="Benjamini–Hochberg q-value">
            Each p-value adjusted for the number of candidates searched in the same field, since one field is one search, as in the
            Lab. Reporting everything at q ≤ {alpha} keeps the expected share of false alarms in a field’s list at{" "}
            {Math.round(alpha * 100)}% or less.
          </Item>
          <Item term="False alarms measured">
            {isNum(m.false_alarms_per_deg2_q05) ? (
              <span data-testid="ai-false-alarms">
                {m.false_alarms_per_deg2_q05.toLocaleString("en-GB", { maximumFractionDigits: 1 })} per square degree at q ≤ {alpha} on the held-out test fields, outside the known
                object at each centre
                {isNum(m.false_alarms_area_deg2) && <> ({fmt(m.false_alarms_area_deg2, 3)} square degrees, searched with nothing added)</>}
                {isNum(m.false_alarms_per_deg2_q05_upper95) && (
                  <>; with that little sky, the 95% upper limit is {fmt(m.false_alarms_per_deg2_q05_upper95, 1)} per square degree</>
                )}
                .
              </span>
            ) : load.state === "loading" ? (
              "Reading the published results…"
            ) : (
              "Not published with this list."
            )}
          </Item>
        </dl>
        <p className="text-meta text-pretty text-fg-faint">
          Source: <RepoLink path="backend/src/pxh/ml/fdr.py">fdr.py</RepoLink> and the{" "}
          <RepoLink path="docs/validation/movers.md">mover validation report</RepoLink>.
        </p>
      </div>
    </details>
  );
}

function Item({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-ui text-fg">{term}</dt>
      <dd className="text-meta text-pretty text-fg-dim">{children}</dd>
    </div>
  );
}
