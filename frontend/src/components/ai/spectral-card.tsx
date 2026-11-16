"use client";
// The spectral classifier's model card, read from /models/specclass.json as this page loads and
// formatted as How it works formats it: what it is, its seven kinds, test accuracy with its 90%
// interval, macro F1, how many spectra it learned from and was tested on, and its share right per kind.

import type { ReactNode } from "react";
import { capital, fmt, isNum, pct } from "@/components/how-it-works/model-results";
import { RISE, delay } from "@/components/how-it-works/motion-classes";
import { Reveal } from "@/components/how-it-works/reveal";
import { RepoLink } from "@/components/how-it-works/shell";
import { cn } from "@/lib/utils";
import { Pending, useSpecCard } from "./results";

const tenths = (v: number) => `${(v * 100).toFixed(1)}%`;

function Stat({ value, children, i }: { value: string | null; children: ReactNode; i: number }) {
  return (
    <div className={cn("flex flex-col gap-1.5 border-t border-hair pt-3", RISE)} style={delay(i, 70)}>
      <span className={cn(value ? "readout text-title text-fg" : "text-lead text-fg-faint")}>{value ?? "Being measured"}</span>
      <span className="text-meta text-pretty text-fg-dim">{children}</span>
    </div>
  );
}

export function SpectralCard() {
  const load = useSpecCard();
  if (load.state !== "ok") return <Pending load={load} what="spectral classifier’s model card" />;
  const r = load.data;
  const ci = r.test_accuracy_ci90;
  const recall = r.test_recall_by_class ?? {};
  const counts = r.n_test_by_class ?? {};
  const classes = r.classes ?? [];

  return (
    <div className="flex flex-col gap-6" data-testid="ai-spec-card">
      <div className="measure flex flex-col gap-1.5">
        <h3 className="text-lead text-fg">The model card</h3>
        {r.description && <p className="text-body text-pretty text-fg-dim">{r.description.replace(/\bum\b/g, "µm")}</p>}
      </div>

      <Reveal className="grid grid-cols-1 gap-x-8 gap-y-6 sm:grid-cols-2 xl:grid-cols-4">
        <Stat i={0} value={isNum(r.test_accuracy) ? tenths(r.test_accuracy) : null}>
          of test spectra get the catalogue’s class
          {ci && isNum(ci[0]) && isNum(ci[1]) && (
            <>
              {" "}
              ({tenths(ci[0])} to {tenths(ci[1])}, the 90% interval across sky tiles)
            </>
          )}
        </Stat>
        <Stat i={1} value={isNum(r.test_macro_f1) ? r.test_macro_f1.toFixed(3) : null}>
          macro F1: how well it finds each kind without mislabelling others as it, the seven kinds counting equally (1 is perfect)
        </Stat>
        <Stat i={2} value={isNum(r.n_train) ? fmt(r.n_train) : null}>
          real SPHEREx spectra it learned from
        </Stat>
        <Stat i={3} value={isNum(r.n_test) ? fmt(r.n_test) : null}>
          test spectra from parts of the sky it never trained on
        </Stat>
      </Reveal>

      {classes.length > 0 && (
        <div role="region" aria-label="The seven kinds" tabIndex={0} className="-mx-1 max-w-3xl overflow-x-auto px-1 focus-visible:outline-offset-0">
          <table className="w-full min-w-[20rem] border-collapse text-left text-meta" data-testid="ai-spec-classes">
            <caption className="pb-2 text-left text-ui text-fg">The seven kinds, and how often it gets each right</caption>
            <thead>
              <tr className="border-b border-hair text-fg-faint">
                <th scope="col" className="py-2 pr-4 font-normal">
                  Kind
                </th>
                <th scope="col" className="py-2 pr-4 text-right font-normal">
                  Test spectra
                </th>
                <th scope="col" className="py-2 text-right font-normal">
                  Right
                </th>
              </tr>
            </thead>
            <tbody>
              {classes.map((c) => (
                <tr key={c.key} data-class={c.key} className="border-b border-hair last:border-b-0">
                  <th scope="row" className="py-2 pr-4 align-top font-normal text-fg">
                    {c.long ?? capital(c.name)}
                  </th>
                  <td className="readout py-2 pr-4 text-right align-top text-fg-dim">{isNum(counts[c.key]) ? fmt(counts[c.key]) : "–"}</td>
                  <td className="readout py-2 text-right align-top text-fg">{pct(recall[c.key]) ?? "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="measure text-meta text-pretty text-fg-faint">
        {[r.split, r.data].filter(Boolean).join(" ")} Kinds with few test spectra have uncertain shares. Read from
        /models/specclass.json as this page loads; calibration and the full confusion matrix are in the{" "}
        <RepoLink path="docs/validation/spectra.md">spectral classifier’s validation report</RepoLink>.
      </p>
    </div>
  );
}
