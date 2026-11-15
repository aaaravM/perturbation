"use client";
// Step 6: how well the automatic search works, read at run time from the published results
// (/discoveries/candidates.json and /models/specclass.json), so the page always shows the numbers
// of the models the site actually uses. Anything missing says so instead of showing a number.

import * as React from "react";
import { cn } from "@/lib/utils";
import { FactTable, ForScientists } from "./shell";
import { RISE, delay } from "./motion-classes";
import { Reveal } from "./reveal";

interface MoverResults {
  model?: { name?: string; trained_on?: string; metrics?: Record<string, number | undefined> };
  fdr?: { method?: string; alpha?: number };
  survey?: { n_fields?: number; area_deg2?: number; detectors?: string[] };
  candidates?: { q_value?: number; match?: { status?: string } | null }[];
  targets?: {
    name: string;
    expected?: string;
    found?: boolean;
    q_target?: number | null;
    catalog_pm_arcsec_yr?: number | null;
    candidate?: { kind?: string; motion?: { pm_arcsec_yr?: number; pm_err_arcsec_yr?: number } | null } | null;
  }[];
}

interface SpecResults {
  model?: string;
  classes?: { key: string; name: string }[];
  test_accuracy?: number;
  test_accuracy_ci90?: [number, number];
  test_macro_f1?: number;
  n_train?: number;
  n_test?: number;
  n_test_by_class?: Record<string, number>;
  test_recall_by_class?: Record<string, number>;
  confusion_matrix?: number[][];
  confusion_order?: string[];
  unusual?: { threshold_p?: number; test_fraction_flagged?: number };
  split?: string;
  data?: string;
}

type Load<T> = { state: "loading" } | { state: "ok"; data: T } | { state: "missing" };

function useJson<T>(url: string): Load<T> {
  const [load, setLoad] = React.useState<Load<T>>({ state: "loading" });
  React.useEffect(() => {
    let alive = true;
    fetch(url, { cache: "no-cache" })
      .then((r) => (r.ok ? (r.json() as Promise<T>) : Promise.reject(new Error(String(r.status)))))
      .then((data) => alive && setLoad({ state: "ok", data }))
      .catch(() => alive && setLoad({ state: "missing" }));
    return () => {
      alive = false;
    };
  }, [url]);
  return load;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const pct = (v: unknown) => (isNum(v) ? `${Math.round(v * 100)}%` : null);
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const plural = (name: string) => (name.endsWith("y") ? `${name.slice(0, -1)}ies` : `${name}s`);
const fmt = (v: number, d = 0) => v.toLocaleString("en-GB", { maximumFractionDigits: d, minimumFractionDigits: d });

const MEASURING = "Being measured";

export function ModelResults() {
  const movers = useJson<MoverResults>("/discoveries/candidates.json");
  const spec = useJson<SpecResults>("/models/specclass.json");
  return (
    <div className="flex flex-col gap-12">
      <MoverBlock load={movers} />
      <SpecBlock load={spec} />
    </div>
  );
}

function Stat({ value, children, i }: { value: string | null; children: React.ReactNode; i: number }) {
  return (
    <div className={cn("flex flex-col gap-1.5 border-t border-hair pt-3", RISE)} style={delay(i, 70)}>
      <span className={cn(value ? "readout text-title text-fg" : "text-lead text-fg-faint")}>{value ?? MEASURING}</span>
      <span className="text-meta text-pretty text-fg-dim">{children}</span>
    </div>
  );
}

function Pending({ load, what }: { load: Load<unknown>; what: string }) {
  return (
    <p className="text-ui text-fg-faint" role="status">
      {load.state === "loading"
        ? `Reading the latest ${what} results…`
        : `${MEASURING}: the ${what} results are not published on this site yet.`}
    </p>
  );
}

function MoverBlock({ load }: { load: Load<MoverResults> }) {
  return (
    <div className="flex flex-col gap-5">
      <h3 className="text-lead text-fg">The mover finder</h3>
      {load.state !== "ok" ? <Pending load={load} what="mover finder" /> : <MoverResultsView r={load.data} />}
    </div>
  );
}

function MoverResultsView({ r }: { r: MoverResults }) {
  const m = r.model?.metrics ?? {};
  const alpha = r.fdr?.alpha;
  const reported = isNum(alpha) ? (r.candidates ?? []).filter((c) => isNum(c.q_value) && c.q_value <= alpha) : [];
  const known = reported.filter((c) => c.match?.status === "known").length;
  const falseAlarms = isNum(m.false_alarms_per_deg2_q05) ? fmt(m.false_alarms_per_deg2_q05, 1) : null;

  return (
    <>
      <Reveal className="grid grid-cols-1 gap-x-8 gap-y-6 sm:grid-cols-2 xl:grid-cols-4">
        <Stat i={0} value={pct(m.mover_completeness_shift_ge_1px_snr10)}>
          of clear movers are found when they shift at least one pixel between visits
        </Stat>
        <Stat i={1} value={pct(m.mover_completeness_snr10)}>
          of clear movers are found over all the speeds tested, slow ones included
        </Stat>
        <Stat i={2} value={pct(m.variable_completeness_snr10)}>
          of clear brightness changes are found
        </Stat>
        <Stat i={3} value={falseAlarms}>
          false alarms per square degree on test patches of sky
          {isNum(m.false_alarms_per_deg2_q05_upper95) && <> (at most {fmt(m.false_alarms_per_deg2_q05_upper95, 1)}, 95% limit)</>}
        </Stat>
      </Reveal>
      <p className="measure text-meta text-pretty text-fg-dim">
        “Clear” means the source stands at least 10 times above the noise in each visit. These are fake sources planted in real
        test images the network never trained on.
        {isNum(alpha) && r.candidates && (
          <>
            {" "}
            In the survey of {isNum(r.survey?.n_fields) ? fmt(r.survey.n_fields) : "the"} patches of sky
            {isNum(r.survey?.area_deg2) && <>, {fmt(r.survey.area_deg2, 2)} square degrees in all,</>}{" "}
            {reported.length === 0
              ? "no candidate passes the test yet."
              : `${reported.length} candidate${reported.length === 1 ? " passes" : "s pass"} the ${pct(alpha)} test${
                  known === reported.length ? `, ${reported.length === 1 ? "an object" : "all objects"} already known` : ""
                }.`}
          </>
        )}
      </p>

      {r.targets && r.targets.length > 0 && <TargetsList targets={r.targets} alpha={alpha} />}

      <ForScientists>
        <FactTable
          rows={[
            ["Model", r.model?.name ?? MEASURING],
            ["Training data", r.model?.trained_on ?? MEASURING],
            ["Test accuracy (image stamps)", pct(m.test_accuracy) ?? MEASURING],
            ["False-discovery control", r.fdr?.method ? `${r.fdr.method}; α = ${r.fdr.alpha ?? "?"}` : MEASURING],
            [
              "False alarms, held-out fields",
              isNum(m.false_alarms_per_deg2_q05) && isNum(m.false_alarms_area_deg2)
                ? `${fmt(m.false_alarms_per_deg2_q05)} per deg² at q ≤ ${alpha ?? 0.05} over ${fmt(m.false_alarms_area_deg2, 3)} deg²${
                    isNum(m.false_alarms_per_deg2_q05_upper95) ? ` (95% upper limit ${fmt(m.false_alarms_per_deg2_q05_upper95, 1)})` : ""
                  }`
                : MEASURING,
            ],
            [
              "Survey",
              r.survey
                ? `${r.survey.n_fields ?? "?"} fields, ${isNum(r.survey.area_deg2) ? fmt(r.survey.area_deg2, 3) : "?"} deg², detectors ${(r.survey.detectors ?? []).join(", ")}`
                : MEASURING,
            ],
          ]}
        />
        <p className="text-meta text-fg-faint">
          Read from /discoveries/candidates.json as this page loads. The full validation, with completeness against S/N and
          speed, is in docs/validation/movers.md.
        </p>
      </ForScientists>
    </>
  );
}

function TargetsList({ targets, alpha }: { targets: NonNullable<MoverResults["targets"]>; alpha?: number }) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-ui text-fg">The five challenge stars, searched at their known positions</p>
      <Reveal as="ul" className="flex max-w-3xl flex-col">
        {targets.map((t, i) => {
          const motion = t.candidate?.motion;
          const detail = t.found
            ? `Found as a ${t.candidate?.kind ?? t.expected ?? "candidate"}${
                isNum(motion?.pm_arcsec_yr)
                  ? `, moving ${motion.pm_arcsec_yr.toFixed(2)}${isNum(motion.pm_err_arcsec_yr) ? ` ± ${motion.pm_err_arcsec_yr.toFixed(2)}` : ""}″ a year${
                      isNum(t.catalog_pm_arcsec_yr) ? ` (catalogue: ${t.catalog_pm_arcsec_yr.toFixed(2)})` : ""
                    }`
                  : ""
              }`
            : `Not found${isNum(t.q_target) && isNum(alpha) && t.q_target <= alpha * 1.2 ? ": it just misses the cut" : ""}`;
          return (
            <li
              key={t.name}
              className={cn("flex flex-col gap-0.5 border-b border-hair py-2.5 sm:flex-row sm:items-baseline sm:gap-6", RISE)}
              style={delay(i, 60)}
            >
              <span className="text-ui text-fg sm:w-44 sm:shrink-0">{t.name}</span>
              <span className={cn("text-meta", t.found ? "text-fg-dim" : "text-fg-faint")}>{detail}</span>
            </li>
          );
        })}
      </Reveal>
      <p className="measure text-meta text-pretty text-fg-faint">
        Barnard’s Star, RW Aurigae and R Draconis overflow the detector in nearly every image (357 of 358, 306 of 335 and
        842 of 842), which the finder is not built for. The careful measurements of step 4 are the reliable ones for them.
      </p>
    </div>
  );
}

function SpecBlock({ load }: { load: Load<SpecResults> }) {
  return (
    <div className="flex flex-col gap-5">
      <h3 className="text-lead text-fg">The spectral classifier</h3>
      {load.state !== "ok" ? <Pending load={load} what="spectral classifier" /> : <SpecResultsView r={load.data} />}
    </div>
  );
}

function SpecResultsView({ r }: { r: SpecResults }) {
  const names = new Map((r.classes ?? []).map((c) => [c.key, c.name]));
  const ci = r.test_accuracy_ci90;
  const mixup = biggestMixup(r);
  const recall = r.test_recall_by_class ?? {};
  const order = r.confusion_order ?? Object.keys(recall);

  return (
    <>
      <Reveal className="grid grid-cols-1 gap-x-8 gap-y-6 sm:grid-cols-2 xl:grid-cols-4">
        <Stat i={0} value={pct(r.test_accuracy)}>
          of test spectra get the catalogue’s class
          {ci && isNum(ci[0]) && isNum(ci[1]) && (
            <>
              {" "}
              ({pct(ci[0])} to {pct(ci[1])} across test areas)
            </>
          )}
        </Stat>
        <Stat i={1} value={isNum(r.n_test) ? fmt(r.n_test) : null}>
          test spectra from parts of the sky it never trained on
        </Stat>
        <Stat i={2} value={isNum(r.unusual?.test_fraction_flagged) ? `${(r.unusual.test_fraction_flagged * 100).toFixed(1)}%` : null}>
          of ordinary spectra are flagged as unusual, so the flag stays rare
        </Stat>
        <Stat i={3} value={mixup ? pct(mixup.frac) : null}>
          {mixup ? `of ${plural(mixup.from)} were called ${plural(mixup.to)}: its biggest mix-up` : "biggest mix-up"}
        </Stat>
      </Reveal>

      {order.length > 0 && (
        <Reveal as="ul" className="flex max-w-xl flex-col gap-2" aria-label="Share of each kind of object it gets right">
          <li className="text-ui text-fg">Share of each kind it gets right</li>
          {order.map((k, i) => {
            const v = recall[k];
            const n = r.n_test_by_class?.[k];
            return (
              <li key={k} className="grid grid-cols-[9.5rem_minmax(0,1fr)_3rem] items-center gap-3 text-meta">
                <span className="truncate text-fg-dim">{capital(names.get(k) ?? k)}</span>
                <span className="relative h-2 overflow-hidden rounded-[2px] bg-ink-3">
                  {isNum(v) && (
                    <span
                      className={cn(
                        "absolute inset-y-0 left-0 origin-left bg-fg/70 transition-transform duration-[900ms] ease-out-expo",
                        "group-data-[reveal=hidden]/reveal:scale-x-0 group-data-[reveal=hidden]/reveal:duration-0",
                      )}
                      style={{ width: `${v * 100}%`, ...delay(i, 60, 100) }}
                    />
                  )}
                </span>
                <span className="readout text-right text-fg">
                  {pct(v) ?? "–"}
                  {isNum(n) && n < 30 && <span className="sr-only"> (only {n} test spectra)</span>}
                </span>
              </li>
            );
          })}
          <li className="text-micro text-fg-faint">Kinds with few test spectra (brown dwarfs, galaxies, quasars) have uncertain shares.</li>
        </Reveal>
      )}

      <ForScientists>
        <FactTable
          rows={[
            ["Model", r.model ?? MEASURING],
            ["Training and test spectra", isNum(r.n_train) && isNum(r.n_test) ? `${fmt(r.n_train)} train, ${fmt(r.n_test)} test` : MEASURING],
            ["Split", r.split ?? MEASURING],
            ["Labels", r.data ?? MEASURING],
            ["Test accuracy (90% interval over tiles)", isNum(r.test_accuracy) ? `${(r.test_accuracy * 100).toFixed(1)}%${ci ? ` (${(ci[0] * 100).toFixed(1)}–${(ci[1] * 100).toFixed(1)}%)` : ""}` : MEASURING],
            ["Macro F1", isNum(r.test_macro_f1) ? r.test_macro_f1.toFixed(3) : MEASURING],
            [
              "Unusual-spectrum flag",
              r.unusual && isNum(r.unusual.test_fraction_flagged)
                ? `conformal p < ${r.unusual.threshold_p ?? "?"}; fires on ${(r.unusual.test_fraction_flagged * 100).toFixed(2)}% of test spectra`
                : MEASURING,
            ],
          ]}
        />
        <p className="text-meta text-fg-faint">
          Read from /models/specclass.json as this page loads. Calibration, the confusion matrix and the unusual-spectrum tests
          are in docs/validation/spectra.md.
        </p>
      </ForScientists>
    </>
  );
}

/** The largest off-diagonal share of the confusion matrix, among classes with at least 30 test spectra. */
function biggestMixup(r: SpecResults): { from: string; to: string; frac: number } | null {
  const m = r.confusion_matrix;
  const order = r.confusion_order;
  if (!m || !order || m.length !== order.length) return null;
  const names = new Map((r.classes ?? []).map((c) => [c.key, c.name]));
  let best: { from: string; to: string; frac: number } | null = null;
  m.forEach((row, i) => {
    const total = row.reduce((s, v) => s + v, 0);
    if (total < 30) return;
    row.forEach((v, j) => {
      if (i === j) return;
      const frac = v / total;
      if (!best || frac > best.frac) best = { from: names.get(order[i]) ?? order[i], to: names.get(order[j]) ?? order[j], frac };
    });
  });
  return best;
}
