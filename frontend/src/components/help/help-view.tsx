"use client";
// /help: why people help the search, three real examples, the review queue and the answers kept in
// this browser. The queue reads the same candidate list as /discoveries; with no candidates yet it is
// practice on the three examples.

import * as React from "react";
import Link from "next/link";
import { ArrowUpRightIcon, DownloadIcon, Trash2Icon } from "lucide-react";
import { Term } from "@/components/ui/term";
import { useEffectiveReducedMotion, usePreference } from "@/lib/preferences";
import { clearVotes, downloadText, useVotes, votesToCsv, votesToJson } from "@/lib/votes";
import { ANSWER_LABEL } from "@/lib/votes";
import { BlinkPanels, BlinkToggle, PhaseText, StampPanel, useBlinkClock } from "@/components/discoveries/stamp";
import { useDiscoveries } from "@/components/discoveries/use-discoveries";
import { EXAMPLES } from "./examples";
import { ReviewQueue, buildQueue } from "./review-queue";

export function HelpView() {
  const state = useDiscoveries();
  const data = state.status === "ready" ? state.data : null;
  const queue = React.useMemo(() => buildQueue(data), [data]);

  return (
    <div className="mx-auto w-full max-w-6xl px-4 pt-16 pb-28 sm:px-6 sm:pt-24">
      <header className="max-w-3xl">
        <p className="text-ui text-fg-dim">Help the search</p>
        <h1 className="mt-3 text-title text-balance text-fg">Review candidates with us</h1>
        <p className="mt-4 max-w-[60ch] text-lead text-pretty text-fg-dim">
          A computer finds the changes; people are still the best judges of which ones are real. Look at each{" "}
          <Term k="blink">blink</Term> and say what you see: it takes a few seconds an image.
        </p>
      </header>

      <WhyHelp />

      <section aria-labelledby="queue-heading" className="mt-20">
        <h2 id="queue-heading" className="text-heading text-fg">
          {queue.mode === "practice" ? "Practise first" : "The review queue"}
        </h2>
        <QueueIntro status={state.status} mode={queue.mode} count={queue.items.length} />
        {state.status === "loading" ? (
          <div aria-hidden className="mt-6 h-[28rem] animate-pulse rounded-[28px] bg-white/[0.03] reduced:animate-none" />
        ) : (
          <ReviewQueue
            key={`${queue.mode}-${queue.items.length}`}
            items={queue.items}
            mode={queue.mode}
            run={data?.generated ?? null}
          />
        )}
      </section>

      <YourAnswers />
    </div>
  );
}

function QueueIntro({ status, mode, count }: { status: string; mode: "review" | "practice"; count: number }) {
  if (status === "loading") return <p className="mt-2 text-ui text-fg-dim">Loading the latest candidates…</p>;
  if (mode === "practice") {
    return (
      <p data-testid="queue-intro" className="mt-2 max-w-[64ch] text-ui text-pretty text-fg-dim">
        {status === "error"
          ? "The list of candidates could not be loaded just now, so there is nothing new to review."
          : "The automatic search is still running, so there is nothing new to review yet."}{" "}
        Practise on the three examples above in the meantime: each answer is known, and you will see why.
      </p>
    );
  }
  return (
    <p data-testid="queue-intro" className="mt-2 max-w-[64ch] text-ui text-pretty text-fg-dim">
      {count} images: every <Term k="candidate">candidate</Term> the search kept, most promising first, with a known object as every
      fifth one so you can see how you are doing. Nobody knows the answers to the others yet.
    </p>
  );
}

// ----------------------------------------------------------------------------- why help

function WhyHelp() {
  const reduce = useEffectiveReducedMotion();
  const ms = usePreference("labBlinkMs");
  const [paused, setPaused] = React.useState(false);
  const { ref } = useBlinkClock<HTMLDivElement>(Math.max(ms, 500), !paused && !reduce);
  return (
    <section aria-labelledby="why-title" className="mt-16 grid gap-10 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.6fr)] lg:gap-16">
      <div>
        <h2 id="why-title" className="text-heading text-fg">
          Why people help
        </h2>
        <p className="mt-3 text-ui text-pretty text-fg-dim">
          Clyde Tombaugh found Pluto in 1930 by flipping between two photographs of the same stars. Volunteers in NASA&rsquo;s
          Backyard Worlds project still do it with infrared maps, and have found cold brown dwarfs that automatic searches
          missed.
        </p>
        <p className="mt-3 text-ui text-pretty text-fg-dim">
          The search here is fast but literal. A person can tell at a glance whether a change looks like a star, or like a
          reflection, a streak or a speck of noise. Three real examples from SPHEREx:
        </p>
      </div>
      <div ref={ref} className="group/blink">
        <ul className="grid gap-4 sm:grid-cols-3">
          {EXAMPLES.map((e, i) => (
            <li key={e.id} data-testid="example" className="flex min-w-0 flex-col">
              {reduce ? (
                <div className="grid max-w-[20rem] grid-cols-3 gap-1 sm:max-w-none">
                  <StampPanel source={e.source} panel={0} className="rounded-l-[12px]" />
                  <StampPanel source={e.source} panel={1} />
                  <StampPanel source={e.source} panel={2} className="rounded-r-[12px]" />
                </div>
              ) : (
                <div className="grid max-w-[20rem] grid-cols-[minmax(0,3fr)_minmax(0,2fr)] items-end gap-1.5 sm:max-w-none sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
                  <BlinkPanels source={e.source} className="rounded-[14px]" />
                  <StampPanel source={e.source} panel={2} className="rounded-[10px]" />
                </div>
              )}
              <p aria-hidden className="readout mt-1.5 text-micro text-fg-faint">
                {reduce ? (
                  `${e.dates[0]} | ${e.dates[1]} | difference`
                ) : (
                  <>
                    <PhaseText phase={0}>{e.dates[0]}</PhaseText>
                    <PhaseText phase={1}>{e.dates[1]}</PhaseText>
                  </>
                )}
              </p>
              <h3 className="mt-3 text-ui font-medium text-fg">{e.name}</h3>
              <p className="text-meta text-accent">{ANSWER_LABEL[e.answer]}</p>
              <p className="mt-1.5 text-meta text-pretty text-fg-dim">
                {e.caption}{" "}
                {i === 0 && (
                  <>
                    The small square is the <Term k="difference">difference</Term>: later minus earlier.
                  </>
                )}
                {i === 2 && (
                  <>
                    Probably a reflection of a bright star nearby: an <Term k="artifact">artifact</Term>.
                  </>
                )}
              </p>
              <Link
                href={e.href}
                className="mt-2 inline-flex w-fit items-center gap-1 rounded-sm text-meta text-fg-dim underline decoration-hair-strong underline-offset-4 transition-colors hover:text-fg"
              >
                Open in the Lab
                <ArrowUpRightIcon aria-hidden className="size-3" />
              </Link>
            </li>
          ))}
        </ul>
        {!reduce && <BlinkToggle paused={paused} onToggle={() => setPaused((p) => !p)} className="mt-3 -ml-2" />}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------- your answers

function YourAnswers() {
  const votes = useVotes();
  const [confirming, setConfirming] = React.useState(false);
  const stamp = () => new Date().toISOString().slice(0, 10);
  const counts = {
    candidate: votes.filter((v) => v.source === "candidate").length,
    check: votes.filter((v) => v.source === "check").length,
    practice: votes.filter((v) => v.source === "practice").length,
  };
  const right = votes.filter((v) => v.source !== "candidate" && v.correct).length;
  const known = counts.check + counts.practice;

  return (
    <section aria-labelledby="answers-title" data-testid="your-answers" className="mt-20 border-t border-hair pt-10">
      <div className="grid gap-8 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.6fr)] lg:gap-16">
        <div>
          <h2 id="answers-title" className="text-heading text-fg">
            Your answers
          </h2>
          <p className="mt-3 text-ui text-pretty text-fg-dim">
            Shared vote collection is not switched on yet. Your answers stay in this browser only; nobody else can see them.
            Download them to keep a copy or to send them to the team.
          </p>
        </div>
        <div>
          <p data-testid="vote-count" className="text-ui text-fg">
            {votes.length === 0 ? (
              "No answers saved yet."
            ) : (
              <>
                <span className="readout">{counts.candidate}</span> candidate{counts.candidate === 1 ? "" : "s"} reviewed
                {known > 0 && (
                  <>
                    , <span className="readout">{right}</span> of <span className="readout">{known}</span> known objects right
                  </>
                )}
                .
              </>
            )}
          </p>
          <p className="mt-1 text-meta text-fg-faint">Saved as you answer. A new answer to the same image replaces the old one.</p>
          <div className="mt-5 flex flex-wrap items-center gap-2">
            <button
              type="button"
              data-testid="export-csv"
              disabled={votes.length === 0}
              onClick={() => downloadText(`planet-x-hunter-answers-${stamp()}.csv`, votesToCsv(votes), "text/csv")}
              className="inline-flex h-11 items-center gap-2 rounded-[10px] border border-hair-strong px-4 text-ui text-fg transition-colors hover:bg-white/[0.05] disabled:pointer-events-none disabled:text-fg-faint"
            >
              <DownloadIcon aria-hidden className="size-4" />
              Download CSV
            </button>
            <button
              type="button"
              data-testid="export-json"
              disabled={votes.length === 0}
              onClick={() => downloadText(`planet-x-hunter-answers-${stamp()}.json`, votesToJson(votes), "application/json")}
              className="inline-flex h-11 items-center gap-2 rounded-[10px] border border-hair-strong px-4 text-ui text-fg transition-colors hover:bg-white/[0.05] disabled:pointer-events-none disabled:text-fg-faint"
            >
              <DownloadIcon aria-hidden className="size-4" />
              Download JSON
            </button>
            {votes.length > 0 &&
              (confirming ? (
                <span className="flex items-center gap-1">
                  <button
                    type="button"
                    data-testid="clear-confirm"
                    onClick={() => {
                      clearVotes();
                      setConfirming(false);
                    }}
                    className="inline-flex h-11 items-center gap-2 rounded-[10px] px-3 text-ui text-destructive transition-colors hover:bg-destructive/10"
                  >
                    Delete {votes.length} answer{votes.length === 1 ? "" : "s"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirming(false)}
                    className="inline-flex h-11 items-center rounded-[10px] px-3 text-ui text-fg-dim transition-colors hover:text-fg"
                  >
                    Keep them
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  data-testid="clear-votes"
                  onClick={() => setConfirming(true)}
                  className="inline-flex h-11 items-center gap-2 rounded-[10px] px-3 text-ui text-fg-dim transition-colors hover:bg-white/[0.05] hover:text-fg"
                >
                  <Trash2Icon aria-hidden className="size-4" />
                  Clear
                </button>
              ))}
          </div>
        </div>
      </div>
    </section>
  );
}
