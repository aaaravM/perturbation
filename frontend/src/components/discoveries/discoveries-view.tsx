"use client";
// /discoveries: the automatic search's candidate list. The page reads
// public/discoveries/candidates.json on load, checks every entry (lib/discoveries.ts), and lets the
// reader choose how many false alarms to accept (a false-discovery rate that filters by q-value),
// what kind of change to show and how to sort. With no list yet, it says the search is still running.

import * as React from "react";
import Link from "next/link";
import { RotateCcwIcon } from "lucide-react";
import { LiquidGlass } from "@/components/ui/liquid-glass";
import { Term } from "@/components/ui/term";
import { Choice, type ChoiceOption } from "@/components/settings/controls";
import { useEffectiveReducedMotion, usePreference } from "@/lib/preferences";
import {
  DEFAULT_FDR,
  FDR_LEVELS,
  byConfidence,
  fieldName,
  formatRun,
  oneIn,
  percent,
  type Candidate,
  type Discoveries,
  type FdrLevel,
} from "@/lib/discoveries";
import { cn } from "@/lib/utils";
import { CandidateCard, CandidateSheet } from "./candidate";
import { FoundAgain, HowMade, SurveySummary } from "./sections";
import { BlinkToggle, useBlinkClock } from "./stamp";
import { useDiscoveries } from "./use-discoveries";

type KindFilter = "all" | "mover" | "variable";
type MatchFilter = "all" | "known" | "unknown";
type SortKey = "q" | "score" | "snr";

const FDR_OPTIONS: ChoiceOption<string>[] = FDR_LEVELS.map((a) => ({
  value: String(a),
  label: percent(a),
  hint: `about ${oneIn(a)} may be false alarms`,
}));
const KIND_OPTIONS: ChoiceOption<KindFilter>[] = [
  { value: "all", label: "All" },
  { value: "mover", label: "Moves" },
  { value: "variable", label: "Changes brightness" },
];
const MATCH_OPTIONS: ChoiceOption<MatchFilter>[] = [
  { value: "all", label: "All" },
  { value: "known", label: "Known", hint: "in Gaia DR3, CatWISE2020 or SIMBAD" },
  { value: "unknown", label: "New", hint: "no catalogued source close enough" },
];
const SORT_OPTIONS: ChoiceOption<SortKey>[] = [
  { value: "q", label: "q-value", hint: "fewest likely false alarms first" },
  { value: "score", label: "Confidence", hint: "highest calibrated confidence first" },
  { value: "snr", label: "Signal", hint: "strongest signal in the difference image first" },
];

const SORTERS: Record<SortKey, (a: Candidate, b: Candidate) => number> = {
  q: byConfidence,
  score: (a, b) => b.score - a.score || byConfidence(a, b),
  snr: (a, b) => (b.snr ?? 0) - (a.snr ?? 0) || byConfidence(a, b),
};

export function DiscoveriesView() {
  const state = useDiscoveries();
  const data = state.status === "ready" ? state.data : null;
  const hasCandidates = (data?.candidates.length ?? 0) > 0;

  return (
    <div className="mx-auto w-full max-w-6xl px-4 pt-16 pb-28 sm:px-6 sm:pt-24">
      <header className="max-w-3xl">
        <p className="text-ui text-fg-dim">Discoveries</p>
        <h1 className="mt-3 text-title text-balance text-fg">Candidate movers and variables</h1>
        <p className="mt-4 max-w-[60ch] text-lead text-pretty text-fg-dim">
          An automatic search of SPHEREx images for anything that moved or changed brightness between visits. Every
          entry is a <Term k="candidate">candidate</Term>: worth a closer look, not yet a discovery.
        </p>
        <p data-testid="discoveries-status" data-state={state.status === "ready" && !hasCandidates ? "empty" : state.status} className="mt-4 text-meta text-fg-faint">
          {state.status === "loading" && "Loading the latest list…"}
          {state.status === "ready" &&
            (data?.generated ? `Search run ${formatRun(data.generated)}` : "Search run time not recorded") +
              (data?.model.name ? `. Model ${data.model.name}.` : ".")}
          {state.status === "missing" && "No list has been published yet."}
          {state.status === "error" && "The list could not be loaded."}
        </p>
      </header>

      {state.status === "loading" && <LoadingBlock />}
      {state.status === "error" && <ErrorBlock message={state.message} onRetry={state.retry} />}
      {(state.status === "missing" || (data && !hasCandidates)) && <StillRunning />}

      {data && <SurveySummary data={data} />}
      {data && hasCandidates && <CandidateList data={data} />}
      {data && !hasCandidates && <FoundAgainStatic data={data} />}
      {state.status !== "loading" && <HowMade data={data} />}

      <Credits dropped={data?.dropped ?? 0} />
    </div>
  );
}

// ---------------------------------------------------------------------------------- list

function CandidateList({ data }: { data: Discoveries }) {
  const reduce = useEffectiveReducedMotion();
  const blinkMs = usePreference("labBlinkMs");
  const [alpha, setAlpha] = React.useState<FdrLevel>(DEFAULT_FDR);
  const [kind, setKind] = React.useState<KindFilter>("all");
  const [match, setMatch] = React.useState<MatchFilter>("all");
  const [sort, setSort] = React.useState<SortKey>("q");
  const [paused, setPaused] = React.useState(false);
  const [openId, setOpenId] = React.useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = React.useState(false);
  const { ref } = useBlinkClock<HTMLDivElement>(blinkMs, !paused && !reduce);

  const passing = React.useMemo(() => data.candidates.filter((c) => c.q_value <= alpha + 1e-12), [data, alpha]);
  const shown = React.useMemo(
    () =>
      passing
        .filter((c) => kind === "all" || c.kind === kind)
        .filter((c) => match === "all" || c.match.status === match)
        .sort(SORTERS[sort]),
    [passing, kind, match, sort],
  );
  const filtered = kind !== "all" || match !== "all";
  const loosest = FDR_LEVELS[FDR_LEVELS.length - 1];
  const opened = data.candidates.find((c) => c.id === openId) ?? null;

  const open = React.useCallback((id: string) => {
    setOpenId(id);
    setSheetOpen(true);
  }, []);

  return (
    <div ref={ref} className="group/blink" data-testid="candidate-list">
      <section aria-labelledby="reading-title" className="mt-16 grid gap-8 lg:grid-cols-2 lg:gap-16">
        <div>
          <h2 id="reading-title" className="text-heading text-fg">
            How to read the list
          </h2>
          <p className="mt-3 text-ui text-pretty text-fg-dim">
            A small neural network looks at every change the search flags and says how likely it is to be a mover, a
            brightness change, an artifact or nothing at all. Its chance that the change is real is shown as a{" "}
            <Term k="calibratedConfidence">calibrated confidence</Term>.
          </p>
        </div>
        <div className="lg:pt-10">
          <p className="text-ui text-pretty text-fg-dim">
            Testing thousands of changes means a few will look real by chance. A candidate&rsquo;s{" "}
            <Term k="qValue" /> is the smallest <Term k="falseDiscoveryRate">false-discovery rate</Term> at which it
            would still be kept. Choose the rate below: a lower one shows fewer candidates and fewer false alarms.
          </p>
        </div>
      </section>

      <LiquidGlass
        as="section"
        variant="regular"
        radius={22}
        refraction={false}
        aria-label="Choose what to show"
        className="mt-8 flex flex-col gap-5 p-4 sm:p-5"
      >
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <p id="fdr-label" className="text-ui font-medium text-fg">
              False alarms accepted
            </p>
            <Choice
              value={String(alpha)}
              options={FDR_OPTIONS}
              onChange={(v) => setAlpha(Number(v) as FdrLevel)}
              labelledBy="fdr-label"
              testId="fdr-choice"
            />
          </div>
          <p data-testid="fdr-meaning" className="text-meta text-pretty text-(--fg-glass-dim)">
            Showing candidates with q ≤ {alpha}: in each field, at most about {oneIn(alpha)} of them is expected to be a
            false alarm.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-x-6 gap-y-4">
          <ControlGroup id="kind-label" label="What changed">
            <Choice value={kind} options={KIND_OPTIONS} onChange={setKind} labelledBy="kind-label" testId="kind-filter" />
          </ControlGroup>
          <ControlGroup id="match-label" label="Catalogues">
            <Choice value={match} options={MATCH_OPTIONS} onChange={setMatch} labelledBy="match-label" testId="match-filter" />
          </ControlGroup>
          <ControlGroup id="sort-label" label="Sort by">
            <Choice value={sort} options={SORT_OPTIONS} onChange={setSort} labelledBy="sort-label" testId="sort-choice" />
          </ControlGroup>
        </div>
      </LiquidGlass>

      <div className="mt-8 flex flex-wrap items-center justify-between gap-3">
        <p data-testid="result-count" aria-live="polite" className="text-ui text-fg-dim">
          Showing <span className="readout text-fg">{shown.length}</span> of{" "}
          <span className="readout text-fg">{data.candidates.length}</span> candidates
          {filtered && (
            <button
              type="button"
              onClick={() => {
                setKind("all");
                setMatch("all");
              }}
              className="ml-2 inline-flex h-9 items-center gap-1 rounded-[8px] px-2 text-meta text-fg-dim transition-colors hover:bg-white/[0.05] hover:text-fg"
            >
              <RotateCcwIcon aria-hidden className="size-3.5" />
              Show all kinds
            </button>
          )}
        </p>
        {!reduce && (
          <BlinkToggle paused={paused} onToggle={() => setPaused((p) => !p)} className="-mr-2" testId="blink-toggle" />
        )}
      </div>

      {shown.length > 0 ? (
        <ul className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3" data-testid="candidate-grid">
          {shown.map((c) => (
            <li key={c.id} className="flex min-w-0">
              <CandidateCard c={c} field={fieldName(data, c.field)} reduce={reduce} onOpen={open} />
            </li>
          ))}
        </ul>
      ) : (
        <div data-testid="no-results" className="mt-4 rounded-[18px] border border-dashed border-hair-strong px-5 py-8">
          <p className="text-ui text-fg">
            {passing.length === 0
              ? `No candidate has a q-value of ${alpha} or less.`
              : "No candidate of this kind passes at this rate."}
          </p>
          <p className="mt-1 text-meta text-pretty text-fg-dim">
            {alpha < loosest
              ? "Accepting more false alarms shows more of the list."
              : "Every candidate in the list has been checked against these filters."}
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            {alpha < loosest && (
              <button
                type="button"
                onClick={() => setAlpha(loosest)}
                className="inline-flex h-9 items-center rounded-[8px] border border-hair-strong px-3 text-meta text-fg transition-colors hover:bg-white/[0.05]"
              >
                Accept up to {percent(loosest)}
              </button>
            )}
            {filtered && (
              <button
                type="button"
                onClick={() => {
                  setKind("all");
                  setMatch("all");
                }}
                className="inline-flex h-9 items-center rounded-[8px] px-3 text-meta text-fg-dim transition-colors hover:bg-white/[0.05] hover:text-fg"
              >
                Show all kinds
              </button>
            )}
          </div>
        </div>
      )}

      <FoundAgain data={data} reduce={reduce} />

      <CandidateSheet
        c={opened}
        open={sheetOpen}
        field={opened ? fieldName(data, opened.field) : ""}
        onClose={() => setSheetOpen(false)}
      />
    </div>
  );
}

function ControlGroup({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <p id={id} className="text-meta text-(--fg-glass-dim)">
        {label}
      </p>
      {children}
    </div>
  );
}

/** The known-objects strip when there is no candidate list, blinking on its own clock. */
function FoundAgainStatic({ data }: { data: Discoveries }) {
  const reduce = useEffectiveReducedMotion();
  const blinkMs = usePreference("labBlinkMs");
  const [paused, setPaused] = React.useState(false);
  const { ref } = useBlinkClock<HTMLDivElement>(blinkMs, !paused && !reduce);
  return (
    <div ref={ref} className="group/blink">
      <FoundAgain data={data} reduce={reduce} />
      {!reduce && data.targets.length > 0 && (
        <BlinkToggle paused={paused} onToggle={() => setPaused((p) => !p)} className="mt-3 -ml-2" />
      )}
    </div>
  );
}

// -------------------------------------------------------------------------------- states

function LoadingBlock() {
  return (
    <div aria-hidden className="mt-12 grid grid-cols-2 gap-6 md:grid-cols-4">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="h-20 animate-pulse rounded-[12px] bg-white/[0.03] reduced:animate-none" />
      ))}
    </div>
  );
}

function ErrorBlock({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="alert" className="mt-12 max-w-2xl rounded-[18px] border border-hair-strong px-5 py-6">
      <p className="text-ui text-fg">The candidate list could not be loaded.</p>
      <p className="mt-1 text-meta text-fg-dim">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-4 inline-flex h-9 items-center gap-1.5 rounded-[8px] border border-hair-strong px-3 text-meta text-fg transition-colors hover:bg-white/[0.05]"
      >
        <RotateCcwIcon aria-hidden className="size-3.5" />
        Try again
      </button>
    </div>
  );
}

function StillRunning() {
  return (
    <section
      data-testid="still-running"
      aria-labelledby="still-running-title"
      className="mt-12 max-w-3xl rounded-[22px] border border-hair bg-ink-2 px-5 py-6 sm:px-7 sm:py-7"
    >
      <h2 id="still-running-title" className="text-heading text-fg">
        The automatic search is still running
      </h2>
      <p className="mt-3 text-ui text-pretty text-fg-dim">
        It compares SPHEREx images of dozens of fields taken months apart, has a model judge every change it finds, and
        keeps only those that pass a strict test for false alarms. When it finishes, its candidates appear here, each with
        its images and how sure we are. Nothing is listed until then.
      </p>
      <p className="mt-3 text-ui text-pretty text-fg-dim">
        Meanwhile you can{" "}
        <Link href="/help" className="text-fg underline decoration-hair-strong underline-offset-4 hover:decoration-fg-dim">
          practise spotting changes
        </Link>{" "}
        or blink the challenge targets{" "}
        <Link
          href="/explore?target=barnards-star"
          className="text-fg underline decoration-hair-strong underline-offset-4 hover:decoration-fg-dim"
        >
          in the Lab
        </Link>
        .
      </p>
    </section>
  );
}

function Credits({ dropped }: { dropped: number }) {
  return (
    <footer className={cn("mt-16 max-w-[72ch] border-t border-hair pt-5 text-micro text-pretty text-fg-faint")}>
      <p>
        Candidates are unconfirmed. Known objects are the easiest to trust; bright stars that fill the detector can leave
        marks that look like changes, so check the images and open the Lab.
      </p>
      {dropped > 0 && (
        <p className="mt-2" data-testid="dropped-note">
          {dropped === 1 ? "One entry" : `${dropped} entries`} in the list file had missing or impossible values and{" "}
          {dropped === 1 ? "is" : "are"} not shown.
        </p>
      )}
      <p className="mt-2">
        Data: SPHEREx (NASA/JPL-Caltech) from IRSA, DR1 and Quick Release 3; Gaia DR3 (ESA/Gaia/DPAC); CatWISE2020;
        SIMBAD (CDS).
      </p>
    </footer>
  );
}
