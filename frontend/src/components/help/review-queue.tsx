"use client";
// The review queue on /help: one candidate at a time, blinking large, with four answers (keys 1 to 4).
// Every fifth item is a known object (a challenge target tested at its known position, or one of the
// three bundle examples) whose answer is known, so a reviewer gets feedback and a running score, and
// the votes on real candidates can later be weighed by how often each reviewer got the checks right.
// With no candidates yet, the queue is practice on the three examples.

import * as React from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowRightIcon, CheckIcon, PauseIcon, PlayIcon, RotateCcwIcon, XIcon } from "lucide-react";
import { LiquidGlass } from "@/components/ui/liquid-glass";
import { Kbd } from "@/components/ui/kbd";
import { Choice, type ChoiceOption } from "@/components/settings/controls";
import { useEffectiveReducedMotion } from "@/lib/preferences";
import { fieldName, formatDay, percent, type Candidate, type Discoveries } from "@/lib/discoveries";
import { ANSWERS, ANSWER_LABEL, submitVote, type Answer, type VoteSource } from "@/lib/votes";
import { cn } from "@/lib/utils";
import { BlinkPanels, PhaseText, StampPanel, useBlinkClock, type StampSource } from "@/components/discoveries/stamp";
import { EXAMPLES, type ReviewExample } from "./examples";

export interface QueueItem {
  /** Unique within the queue. */
  key: string;
  /** The id the vote is stored under. */
  id: string;
  source: VoteSource;
  stamp: StampSource;
  dates: [string, string] | null;
  /** Checks and practice: the known answer, the object's name and why. */
  expected?: Answer;
  name?: string;
  why?: string;
  /** What the model called it, shown after an answer. */
  model?: { kind: "mover" | "variable"; score: number };
  /** For candidates: the field it is in. */
  field?: string;
}

const CHECK_EVERY = 5;

const kindAnswer = (k: "mover" | "variable"): Answer => (k === "mover" ? "moves" : "brightness");

function exampleItem(e: ReviewExample, source: VoteSource, n = 0): QueueItem {
  return {
    key: `${source}-${e.id}-${n}`,
    id: e.id,
    source,
    stamp: e.source,
    dates: e.dates,
    expected: e.answer,
    name: e.name,
    why: e.why,
  };
}

function candidateItem(c: Candidate, data: Discoveries): QueueItem | null {
  if (!c.stamp) return null;
  return {
    key: `candidate-${c.id}`,
    id: c.id,
    source: "candidate",
    stamp: { type: "strip", src: c.stamp },
    dates: c.epochs ? [formatDay(c.epochs[0]), formatDay(c.epochs[1])] : null,
    model: { kind: c.kind, score: c.score },
    field: fieldName(data, c.field),
  };
}

/** The queue: every candidate with a stamp, best first, with a known object as every fifth item. */
export function buildQueue(data: Discoveries | null): { items: QueueItem[]; mode: "review" | "practice" } {
  const candidates = (data?.candidates ?? []).map((c) => candidateItem(c, data!)).filter((i): i is QueueItem => i !== null);
  if (!data || candidates.length === 0) {
    return { items: EXAMPLES.map((e) => exampleItem(e, "practice")), mode: "practice" };
  }
  const checks: ((n: number) => QueueItem)[] = [
    ...data.targets
      .filter((t) => t.candidate?.stamp && t.expected)
      .map((t) => (n: number): QueueItem => {
        const c = t.candidate!;
        const known =
          t.expected === "mover"
            ? `${t.name} is known to move${t.catalog_pm_arcsec_yr !== null ? ` ${t.catalog_pm_arcsec_yr.toFixed(1)} arcseconds a year` : ""}.`
            : `${t.name} is known to change brightness.`;
        return {
          key: `check-${c.id}-${n}`,
          id: c.id,
          source: "check",
          stamp: { type: "strip", src: c.stamp! },
          dates: c.epochs ? [formatDay(c.epochs[0]), formatDay(c.epochs[1])] : null,
          expected: kindAnswer(t.expected!),
          name: t.name,
          why: known,
          model: { kind: c.kind, score: c.score },
        };
      }),
    ...EXAMPLES.map((e) => (n: number) => exampleItem(e, "check", n)),
  ];
  const items: QueueItem[] = [];
  let used = 0;
  for (const c of candidates) {
    if ((items.length + 1) % CHECK_EVERY === 0) {
      items.push(checks[used % checks.length](Math.floor(used / checks.length)));
      used += 1;
    }
    items.push(c);
  }
  return { items, mode: "review" };
}

// ------------------------------------------------------------------------------- viewer

const SPEEDS: ChoiceOption<string>[] = [
  { value: "900", label: "Slow" },
  { value: "500", label: "Normal" },
  { value: "250", label: "Fast" },
];

function Viewer({
  item,
  playing,
  ms,
  difference,
  reduce,
  onStep,
}: {
  item: QueueItem;
  playing: boolean;
  ms: number;
  difference: boolean;
  reduce: boolean;
  onStep: () => void;
}) {
  const { ref, flip, reset } = useBlinkClock<HTMLDivElement>(ms, playing && !difference && !reduce);
  // A new item starts on its earlier image.
  React.useEffect(() => reset(), [item.key, reset]);
  const [d0, d1] = item.dates ?? ["Earlier", "Later"];

  return (
    <div ref={ref} className="group/blink relative" data-testid="review-viewer" data-view={difference ? "difference" : reduce ? "side-by-side" : "blink"}>
      {difference ? (
        <StampPanel source={item.stamp} panel={2} className="rounded-[22px]" />
      ) : reduce ? (
        <div className="grid grid-cols-2 gap-1.5">
          <StampPanel source={item.stamp} panel={0} className="rounded-l-[22px]" />
          <StampPanel source={item.stamp} panel={1} className="rounded-r-[22px]" />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => (playing ? onStep() : flip())}
          aria-label={playing ? "Pause the blink" : "Show the other image"}
          className="block w-full overflow-hidden rounded-[22px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <BlinkPanels source={item.stamp} />
        </button>
      )}

      <LiquidGlass
        variant="thin"
        radius={10}
        aria-hidden
        className="pointer-events-none absolute top-3 left-3 px-2.5 py-1.5 text-meta text-fg"
      >
        {difference ? (
          "Difference: later minus earlier"
        ) : reduce ? (
          <span className="readout">
            {d0} | {d1}
          </span>
        ) : (
          <span className="readout">
            <PhaseText phase={0}>{d0}</PhaseText>
            <PhaseText phase={1}>{d1}</PhaseText>
          </span>
        )}
      </LiquidGlass>
    </div>
  );
}

// -------------------------------------------------------------------------------- queue

interface Feedback {
  item: QueueItem;
  answer: Answer;
  correct: boolean | null;
}

export function ReviewQueue({
  items,
  mode,
  run,
}: {
  items: QueueItem[];
  mode: "review" | "practice";
  /** The candidate list run, stored with each vote. */
  run: string | null;
}) {
  const reduce = useEffectiveReducedMotion();
  const [index, setIndex] = React.useState(0);
  const [feedback, setFeedback] = React.useState<Feedback | null>(null);
  /** The last real candidate answered: candidates move straight on, with one quiet line about it. */
  const [saved, setSaved] = React.useState<Feedback | null>(null);
  const [score, setScore] = React.useState({ right: 0, total: 0 });
  const [playing, setPlaying] = React.useState(true);
  const [ms, setMs] = React.useState(500);
  const [difference, setDifference] = React.useState(false);
  const [inView, setInView] = React.useState(false);
  const box = React.useRef<HTMLElement>(null);
  /** The queue position last answered: an answer button still fading out cannot answer twice. */
  const answeredKey = React.useRef<string | null>(null);

  const item = items[index] ?? null;
  const done = index >= items.length;

  React.useEffect(() => {
    const el = box.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setInView(e.isIntersecting), { threshold: 0.3 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const answer = React.useCallback(
    (a: Answer) => {
      if (!item || feedback || answeredKey.current === item.key) return;
      answeredKey.current = item.key;
      const correct = item.expected ? item.expected === a : null;
      void submitVote({
        id: item.id,
        answer: a,
        source: item.source,
        at: new Date().toISOString(),
        ...(item.expected ? { expected: item.expected, correct: correct ?? false } : {}),
        ...(item.model ? { model: item.model.kind } : {}),
        ...(run ? { run } : {}),
      });
      if (item.expected) {
        setScore((s) => ({ right: s.right + (correct ? 1 : 0), total: s.total + 1 }));
        setFeedback({ item, answer: a, correct });
      } else {
        setSaved({ item, answer: a, correct: null });
        setDifference(false);
        setIndex((i) => i + 1);
      }
    },
    [item, feedback, run],
  );

  const next = React.useCallback(() => {
    setFeedback(null);
    setDifference(false);
    setIndex((i) => i + 1);
  }, []);

  const restart = () => {
    answeredKey.current = null;
    setIndex(0);
    setFeedback(null);
    setSaved(null);
    setScore({ right: 0, total: 0 });
    setDifference(false);
  };

  React.useEffect(() => {
    if (!inView || done) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']")) return;
      const onControl = !!t?.closest("button, a, [role='radio'], [role='switch']");
      if (!feedback && /^[1-4]$/.test(e.key)) {
        e.preventDefault();
        answer(ANSWERS[Number(e.key) - 1]);
      } else if (feedback && (e.key === "ArrowRight" || (e.key === "Enter" && !onControl))) {
        e.preventDefault();
        next();
      } else if ((e.key === "d" || e.key === "D") && !e.repeat) {
        e.preventDefault();
        setDifference((d) => !d);
      } else if (e.key === " " && !onControl && !reduce) {
        e.preventDefault();
        setPlaying((p) => !p);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [inView, done, feedback, answer, next, reduce]);

  const progress = items.length ? Math.min(index + (feedback ? 1 : 0), items.length) / items.length : 0;

  return (
    <section
      ref={box}
      aria-labelledby="queue-title"
      data-testid="review-queue"
      data-mode={mode}
      data-index={index}
      data-keys={inView && !done ? "on" : "off"}
      className="mt-6 rounded-[28px] border border-hair bg-ink-2 p-3 sm:p-5"
    >
      <h3 id="queue-title" className="sr-only">
        {mode === "practice" ? "Practice" : "Review queue"}
      </h3>
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 px-1">
        <p className="text-meta text-fg-dim" data-testid="queue-progress">
          {done ? (
            "Finished"
          ) : (
            <>
              {mode === "practice" ? "Example" : "Item"} <span className="readout text-fg">{index + 1}</span> of{" "}
              <span className="readout text-fg">{items.length}</span>
            </>
          )}
        </p>
        <p className="text-meta text-fg-dim" data-testid="queue-score" aria-live="polite">
          {score.total > 0 ? (
            <>
              {mode === "practice" ? "Right so far" : "Checks right"}:{" "}
              <span className="readout text-fg">
                {score.right} of {score.total}
              </span>
            </>
          ) : mode === "practice" ? (
            "Practice: every answer here is known"
          ) : (
            "One in five is a known object, as a check"
          )}
        </p>
      </div>
      <div aria-hidden className="mx-1 mt-3 h-1 overflow-hidden rounded-full bg-white/[0.06]">
        <div
          className="h-full origin-left rounded-full bg-accent transition-transform duration-500 ease-out-expo reduced:transition-none"
          style={{ transform: `scaleX(${progress})` }}
        />
      </div>

      {done ? (
        <Finished mode={mode} total={items.length} score={score} onRestart={restart} />
      ) : (
        item && (
          <div className="mt-4 grid gap-5 lg:grid-cols-[minmax(0,30rem)_minmax(0,1fr)] lg:gap-8">
            <div className="flex min-w-0 flex-col gap-3">
              <Viewer
                item={item}
                playing={playing}
                ms={ms}
                difference={difference}
                reduce={reduce}
                onStep={() => setPlaying(false)}
              />
              <div className="flex flex-wrap items-center gap-2">
                {!reduce && (
                  <>
                    <button
                      type="button"
                      data-testid="queue-play"
                      onClick={() => setPlaying((p) => !p)}
                      disabled={difference}
                      aria-pressed={!playing}
                      className="inline-flex h-11 items-center gap-1.5 rounded-[10px] px-3 text-meta text-fg-dim transition-colors hover:bg-white/[0.05] hover:text-fg disabled:opacity-40"
                    >
                      {playing ? <PauseIcon aria-hidden className="size-4" /> : <PlayIcon aria-hidden className="size-4" />}
                      {playing ? "Pause" : "Play"}
                    </button>
                    <p id="speed-label" className="sr-only">
                      Blink speed
                    </p>
                    <Choice value={String(ms)} options={SPEEDS} onChange={(v) => setMs(Number(v))} labelledBy="speed-label" testId="queue-speed" />
                  </>
                )}
                <button
                  type="button"
                  data-testid="queue-difference"
                  onClick={() => setDifference((d) => !d)}
                  aria-pressed={difference}
                  aria-keyshortcuts="D"
                  className={cn(
                    "ml-auto inline-flex h-11 items-center gap-2 rounded-[10px] border px-3 text-meta transition-colors",
                    difference ? "border-accent-muted bg-accent-faint text-fg" : "border-hair-strong text-fg-dim hover:text-fg",
                  )}
                >
                  Difference
                  <Kbd className="hidden sm:inline-flex">D</Kbd>
                </button>
              </div>
            </div>

            <div className="flex min-w-0 flex-col">
              <p className="text-heading text-fg">What do you see?</p>
              <p className="mt-1 text-meta text-pretty text-fg-dim">
                Look at the middle of the image. Press a number, or choose below.
              </p>

              <AnimatePresence mode="wait" initial={false}>
                {feedback ? (
                  <motion.div
                    key={`fb-${feedback.item.key}`}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.22 }}
                    className="mt-5"
                  >
                    <FeedbackPanel feedback={feedback} />
                    <button
                      // Focused as it appears, so Enter moves on.
                      ref={(el) => el?.focus({ preventScroll: true })}
                      type="button"
                      data-testid="queue-next"
                      onClick={next}
                      className="mt-5 inline-flex h-11 items-center gap-2 rounded-md bg-fg px-5 text-ui font-medium text-ink transition-colors hover:bg-fg/85"
                    >
                      {index + 1 >= items.length ? "Finish" : "Next"}
                      <ArrowRightIcon aria-hidden className="size-4" />
                    </button>
                  </motion.div>
                ) : (
                  <motion.div
                    // One key for every item: the buttons stay put from one candidate to the next.
                    key="answers"
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.22 }}
                    className="mt-5 grid grid-cols-2 gap-2"
                    role="group"
                    aria-label="Your answer"
                  >
                    {ANSWERS.map((a, i) => (
                      <button
                        key={a}
                        type="button"
                        data-testid={`answer-${a}`}
                        onClick={() => answer(a)}
                        aria-keyshortcuts={String(i + 1)}
                        className="flex min-h-14 items-center justify-between gap-3 rounded-[14px] border border-hair-strong px-4 py-3 text-left text-ui text-fg transition-colors duration-150 hover:border-fg-faint hover:bg-white/[0.04] active:translate-y-px"
                      >
                        {ANSWER_LABEL[a]}
                        <Kbd className="hidden shrink-0 sm:inline-flex">{i + 1}</Kbd>
                      </button>
                    ))}
                  </motion.div>
                )}
              </AnimatePresence>
              {!feedback && <SavedLine saved={saved} />}

              <p className="mt-auto pt-6 text-micro text-pretty text-fg-faint">
                Keys: 1 to 4 answer, D shows the difference, Space pauses, Enter goes on after a check.
              </p>
            </div>
          </div>
        )
      )}
    </section>
  );
}

/** One quiet line about the last real candidate answered. */
function SavedLine({ saved }: { saved: Feedback | null }) {
  const model = saved?.item.model;
  return (
    <p data-testid="queue-saved" aria-live="polite" className="mt-4 text-meta text-pretty text-fg-faint">
      {saved && (
        <>
          <CheckIcon aria-hidden className="mr-1.5 inline size-3.5 -translate-y-px text-accent" />
          Saved your answer for the last image: {ANSWER_LABEL[saved.answer].toLowerCase()}.
          {model && (
            <>
              {" "}
              The model said {ANSWER_LABEL[kindAnswer(model.kind)].toLowerCase()} ({percent(model.score)} sure it is real).
            </>
          )}
        </>
      )}
    </p>
  );
}

function FeedbackPanel({ feedback }: { feedback: Feedback }) {
  const { item, answer, correct } = feedback;
  return (
    <div data-testid="queue-feedback" data-result={correct ? "right" : "wrong"} role="status">
      <p className="flex items-center gap-2 text-ui text-fg">
        {correct ? <CheckIcon aria-hidden className="size-4 text-accent" /> : <XIcon aria-hidden className="size-4 text-fg-dim" />}
        {correct ? "Right." : "Not quite."}{" "}
        {item.source === "check" ? `That was a check: ${item.name}.` : item.name}
      </p>
      <p className="mt-2 text-meta text-pretty text-fg-dim">
        The answer is <span className="text-fg">{ANSWER_LABEL[item.expected!].toLowerCase()}</span>
        {!correct && <>; you said {ANSWER_LABEL[answer].toLowerCase()}</>}. {item.why}
      </p>
    </div>
  );
}

function Finished({
  mode,
  total,
  score,
  onRestart,
}: {
  mode: "review" | "practice";
  total: number;
  score: { right: number; total: number };
  onRestart: () => void;
}) {
  return (
    <div data-testid="queue-finished" className="px-1 py-8">
      <p className="text-heading text-fg">{mode === "practice" ? "Practice done." : "That is the whole list for now."}</p>
      <p className="mt-2 max-w-[56ch] text-ui text-pretty text-fg-dim">
        {mode === "practice"
          ? `You got ${score.right} of ${score.total} right. The real queue opens here as soon as the automatic search publishes its candidates.`
          : `You looked at ${total} images${score.total ? ` and got ${score.right} of ${score.total} checks right` : ""}. Your answers are saved in this browser, below.`}
      </p>
      <button
        type="button"
        onClick={onRestart}
        className="mt-5 inline-flex h-11 items-center gap-2 rounded-[10px] border border-hair-strong px-4 text-ui text-fg transition-colors hover:bg-white/[0.05]"
      >
        <RotateCcwIcon aria-hidden className="size-4" />
        Start again
      </button>
    </div>
  );
}
