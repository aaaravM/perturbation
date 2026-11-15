"use client";
// The workbench timeline under the viewer: which frames are blinked (mode and detector), the
// transport (play, step, time per frame, hard blink or crossfade, compare), and every epoch on a
// real time axis with one lane per detector showing how many exposures went into it.

import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ChevronLeftIcon, ChevronRightIcon, PauseIcon, PlayIcon } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { DetectorKey, FieldManifest } from "@/lib/manifest";
import type { BlinkFrame, FieldState } from "@/lib/lab-field";
import { DETECTOR_KEYS, availableDetectors, detectorRange, differenceDetectors } from "@/lib/lab-field";
import type { LabDetector, LabMode } from "@/lib/lab-state";
import { formatDay, mjdToDate } from "@/lib/lab-coords";
import { cn } from "@/lib/utils";
import { Kbd } from "@/components/ui/kbd";
import { Slider } from "@/components/ui/slider";
import { Term } from "@/components/ui/term";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DIVERGING_GRADIENT } from "@/components/lab/diverging";
import { Seg } from "@/components/lab/workbench-ui";

export const SPEED_MIN = 150;
export const SPEED_MAX = 1200;
export const SPEED_DEFAULT = 500;

export type BlinkStyle = "hard" | "fade";
export type CompareMode = "off" | "wipe" | "split";

const MODES: { value: LabMode; label: string; hint: string }[] = [
  { value: "epochs", label: "Epochs", hint: "One co-added image per visit, per detector" },
  { value: "then-now", label: "Then vs Now", hint: "WISE about 2010 against SPHEREx today" },
  { value: "difference", label: "Difference", hint: "Last epoch minus first, in units of the noise" },
];

const micro = (text: string) => text.replace(/(\d)\s?um\b/g, "$1 µm");

export interface TimelineProps {
  field: FieldState;
  manifest: FieldManifest | null;
  mode: LabMode;
  det: LabDetector | null;
  frames: BlinkFrame[];
  current: number;
  playing: boolean;
  speed: number;
  loopCount: number;
  loaded: number;
  ready: boolean;
  failed: number;
  zoomedOut: boolean;
  blinkStyle: BlinkStyle;
  compare: CompareMode;
  compareA: number;
  note: string | null;
  onMode: (mode: LabMode) => void;
  onDet: (det: LabDetector) => void;
  onTogglePlay: () => void;
  onStep: (delta: 1 | -1) => void;
  onSeek: (index: number) => void;
  onSpeed: (ms: number) => void;
  onBlinkStyle: (s: BlinkStyle) => void;
  onCompare: (c: CompareMode) => void;
  onCompareA: (index: number) => void;
  onZoomToField: () => void;
  /** Phones: opens the analysis tab. */
  onDetails?: () => void;
}

export function Timeline(props: TimelineProps) {
  const { field, manifest, mode, det, frames, current, playing, ready, loaded, zoomedOut } = props;
  const reduce = useReducedMotion();
  const total = frames.length;
  const frame = frames[current] ?? null;
  const canPlay = ready && total > 1 && !zoomedOut && props.compare === "off";
  const progress = total ? loaded / total : 0;

  if (!manifest) {
    return <TimelineIdle field={field} />;
  }

  return (
    <section
      aria-label="Blink player"
      data-testid="blink-player"
      data-mode={mode}
      data-ready={ready || undefined}
      className="relative flex shrink-0 flex-col gap-2 border-t border-hair bg-ink-2 px-3 pt-2 pb-2.5"
    >
      <motion.span
        aria-hidden
        className="absolute inset-x-0 top-0 h-px origin-left bg-accent"
        initial={false}
        animate={{ scaleX: ready ? 1 : progress, opacity: ready ? 0 : 1 }}
        transition={{ duration: reduce ? 0 : 0.35, ease: [0.16, 1, 0.3, 1] }}
      />

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <ModeTabs mode={mode} onMode={props.onMode} manifest={manifest} />
        <span aria-hidden className="hidden h-4 w-px bg-hair sm:block" />
        {mode === "then-now" ? (
          <ThenNowRow frames={frames} />
        ) : (
          <DetectorPicker manifest={manifest} mode={mode} det={det} onDet={props.onDet} />
        )}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {props.onDetails && (
            <button
              type="button"
              onClick={props.onDetails}
              data-testid="open-details"
              className="h-6 rounded-md border border-hair px-2 text-micro text-fg transition-colors hover:bg-white/[0.06]"
            >
              Details
            </button>
          )}
          {mode !== "difference" && (
            <Seg
              label="Blink style"
              value={props.blinkStyle}
              onChange={props.onBlinkStyle}
              layoutId="blink-style"
              testIdPrefix="blink-style"
              options={[
                { value: "hard", label: "Blink", title: "Hard cut between frames" },
                { value: "fade", label: "Crossfade", title: "A soft fade between frames" },
              ]}
            />
          )}
          {mode !== "difference" && total > 1 && (
            <Seg
              label="Compare two frames"
              value={props.compare}
              onChange={props.onCompare}
              layoutId="compare-mode"
              testIdPrefix="compare"
              options={[
                { value: "off", label: "Single" },
                { value: "wipe", label: "Wipe", title: "Drag a divider across two frames" },
                { value: "split", label: "Split", title: "Two frames side by side" },
              ]}
            />
          )}
        </div>
      </div>

      {zoomedOut ? (
        <div className="flex flex-wrap items-center justify-between gap-2 py-1">
          <p className="text-meta text-fg-dim">Zoomed out past 30′: frames are hidden and only the all-sky map shows.</p>
          <button
            type="button"
            onClick={props.onZoomToField}
            className="text-meta text-fg underline decoration-hair-strong underline-offset-4 transition-colors hover:decoration-fg"
          >
            Zoom to the field
          </button>
        </div>
      ) : mode === "difference" ? (
        <DifferenceRow frame={frame} ready={ready} loaded={loaded} total={total} note={props.note} />
      ) : (
        <>
          <div className="flex items-center gap-2 sm:gap-3">
            <div className="flex items-center gap-0.5">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={props.onTogglePlay}
                    disabled={!canPlay}
                    aria-label={playing ? "Pause" : "Play"}
                    aria-keyshortcuts="Space"
                    data-testid="blink-play"
                    data-playing={playing && canPlay ? "true" : "false"}
                    className="grid size-8 place-items-center rounded-md border border-hair-strong text-fg transition-colors hover:bg-ink-3 disabled:opacity-40"
                  >
                    {playing && canPlay ? <PauseIcon className="size-4" aria-hidden /> : <PlayIcon className="size-4 translate-x-px" aria-hidden />}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">
                  {playing ? "Pause" : "Play"} <Kbd>Space</Kbd>
                </TooltipContent>
              </Tooltip>
              <StepButton dir={-1} disabled={!ready || total < 2} onStep={props.onStep} />
              <StepButton dir={1} disabled={!ready || total < 2} onStep={props.onStep} />
            </div>
            <TimeAxis {...props} />
            <FrameReadout frame={frame} index={current} total={total} ready={ready} loaded={loaded} failed={props.failed} />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5">
            <Caption mode={mode} compare={props.compare} note={props.note} frames={frames} compareA={props.compareA} current={current} onCompareA={props.onCompareA} />
            <div className="flex w-full items-center gap-2.5 sm:w-auto">
              <label htmlFor="blink-speed" className="text-micro whitespace-nowrap text-fg-dim">
                Time per frame
              </label>
              <Slider
                id="blink-speed"
                min={SPEED_MIN}
                max={SPEED_MAX}
                step={50}
                value={[props.speed]}
                onValueChange={([v]) => props.onSpeed(v)}
                aria-label="Time per frame"
                aria-valuetext={`${props.speed} milliseconds per frame`}
                className="w-full sm:w-28 [&_[data-slot=slider-range]]:bg-fg-dim [&_[data-slot=slider-thumb]]:border-fg [&_[data-slot=slider-thumb]]:bg-ink"
              />
              <span className="readout w-14 shrink-0 text-right text-micro whitespace-nowrap text-fg-dim">{props.speed} ms</span>
            </div>
          </div>
        </>
      )}
    </section>
  );
}

/** Before a field is loaded: what the timeline is for, or the live build's progress. */
function TimelineIdle({ field }: { field: FieldState }) {
  const reduce = useReducedMotion();
  const live = field.status === "loading" && field.what === "live";
  const stage = field.status === "loading" ? field.progress?.stage : undefined;
  const steps = [
    { key: "search", label: "Finding SPHEREx images" },
    { key: "coadd", label: "Co-adding each epoch" },
  ];
  const at = stage === "coadd" ? 1 : 0;
  return (
    <section
      aria-label="Blink player"
      data-testid="timeline-idle"
      className="relative flex shrink-0 flex-col gap-1.5 overflow-hidden border-t border-hair bg-ink-2 px-3 py-2.5"
    >
      {live ? (
        <>
          <div className="flex items-center justify-between gap-3">
            <p className="text-meta text-fg" aria-live="polite">
              Building this patch live: {steps[at].label.toLowerCase()}
              {field.status === "loading" && field.coverage ? (
                <span className="text-fg-dim">
                  {" "}
                  · <span className="readout">{field.coverage.epochs}</span> epochs,{" "}
                  <span className="readout">{field.coverage.images}</span> images
                </span>
              ) : null}
            </p>
            <span className="readout text-micro text-fg-faint">step {at + 1} of 2</span>
          </div>
          <div className="relative h-1 overflow-hidden rounded-full bg-hair" role="progressbar" aria-label="Live build progress" aria-valuemin={0} aria-valuemax={2} aria-valuenow={at + 1} data-testid="build-progress">
            <motion.span
              className="absolute inset-y-0 left-0 rounded-full bg-accent"
              initial={false}
              animate={{ width: at === 0 ? "38%" : "82%" }}
              transition={{ duration: reduce ? 0 : 1.2, ease: [0.16, 1, 0.3, 1] }}
            />
            {!reduce && (
              <motion.span
                aria-hidden
                className="absolute inset-y-0 w-24 bg-gradient-to-r from-transparent via-white/25 to-transparent"
                animate={{ x: ["-6rem", "40rem"] }}
                transition={{ duration: 1.6, repeat: Infinity, ease: "linear" }}
              />
            )}
          </div>
          <p className="text-micro text-fg-faint">
            Frames are co-added from the SPHEREx images at IRSA on demand, one detector per request. This takes
            about 5 to 30 seconds.
          </p>
        </>
      ) : (
        <p className="text-meta text-fg-dim">
          The timeline shows each SPHEREx <Term k="epoch">epoch</Term> of a field on a real time axis. Pick a target or
          search a position, then press play to <Term k="blink">blink</Term> the frames.
        </p>
      )}
    </section>
  );
}

function Caption({
  mode,
  compare,
  note,
  frames,
  compareA,
  current,
  onCompareA,
}: {
  mode: LabMode;
  compare: CompareMode;
  note: string | null;
  frames: BlinkFrame[];
  compareA: number;
  current: number;
  onCompareA: (i: number) => void;
}) {
  if (note) {
    return (
      <p className="min-w-0 flex-1 basis-80 text-micro text-pretty text-fg-dim" data-testid="blink-note">
        {note}
      </p>
    );
  }
  if (compare !== "off" && frames.length > 1) {
    return (
      <div className="flex min-w-0 flex-1 basis-80 flex-wrap items-center gap-x-2 gap-y-1 text-micro text-fg-dim" data-testid="compare-caption">
        <label htmlFor="compare-a">Compare</label>
        <select
          id="compare-a"
          value={compareA}
          onChange={(e) => onCompareA(Number(e.target.value))}
          className="readout h-6 rounded-[5px] border border-hair bg-ink px-1.5 text-micro text-fg outline-none focus-visible:border-accent"
        >
          {frames.map((f, i) => (
            <option key={f.key} value={i}>
              {f.label}
              {f.detail && f.detail.length <= 4 ? ` · ${f.detail}` : ""}
            </option>
          ))}
        </select>
        <span>
          with <span className="readout text-fg">{frames[current]?.label}</span> (pick it on the timeline).{" "}
          {compare === "wipe" ? "Drag the divider across the field." : "Your pointer is mirrored in both."}
        </span>
      </div>
    );
  }
  return (
    <p className="min-w-0 flex-1 basis-80 text-micro text-pretty text-fg-dim" data-testid="blink-caption">
      {mode === "then-now" ? (
        <>Same patch about 15 years apart. Fast stars have visibly moved; look for a dot that jumps.</>
      ) : (
        <>
          What to look for: stars stay put; anything that jumps between frames moved, and anything that brightens or
          fades changed. <span className="text-fg-faint">Dashed ticks are partial epochs.</span>
        </>
      )}
    </p>
  );
}

function StepButton({ dir, disabled, onStep }: { dir: 1 | -1; disabled: boolean; onStep: (d: 1 | -1) => void }) {
  const label = dir < 0 ? "Previous frame" : "Next frame";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => onStep(dir)}
          disabled={disabled}
          aria-label={label}
          aria-keyshortcuts={dir < 0 ? "ArrowLeft" : "ArrowRight"}
          data-testid={dir < 0 ? "blink-prev" : "blink-next"}
          className="grid size-7 place-items-center rounded-md text-fg-dim transition-colors hover:bg-ink-3 hover:text-fg disabled:opacity-40"
        >
          {dir < 0 ? <ChevronLeftIcon className="size-4" aria-hidden /> : <ChevronRightIcon className="size-4" aria-hidden />}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">
        {label} <Kbd>{dir < 0 ? "←" : "→"}</Kbd>
      </TooltipContent>
    </Tooltip>
  );
}

function FrameReadout({
  frame,
  index,
  total,
  ready,
  loaded,
  failed,
}: {
  frame: BlinkFrame | null;
  index: number;
  total: number;
  ready: boolean;
  loaded: number;
  failed: number;
}) {
  if (!ready) {
    return (
      <p className="w-32 shrink-0 text-right text-micro text-fg-dim sm:w-40" aria-live="polite" data-testid="blink-loading">
        Loading frames <span className="readout">{loaded}</span> of <span className="readout">{total}</span>
      </p>
    );
  }
  return (
    <div className="flex w-32 shrink-0 flex-col items-end text-right sm:w-40" aria-live="off">
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.p
          key={frame?.key ?? "none"}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.16 }}
          className="readout truncate text-meta text-fg"
          data-testid="frame-label"
        >
          {frame ? [frame.label, frame.detail.length <= 4 ? frame.detail : null].filter(Boolean).join(" · ") : "–"}
        </motion.p>
      </AnimatePresence>
      <p className="truncate text-micro text-fg-faint">
        {frame?.partial ? "Partial epoch · " : ""}
        <span className="readout" data-testid="frame-counter">
          {index + 1} / {total}
        </span>
        {failed ? ` · ${failed} failed` : ""}
      </p>
    </div>
  );
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Epochs and frames on a real time axis. The frame row holds one tick per frame (the current one
 * in the accent); below it, one lane per detector marks every epoch with exposures in it, its
 * height growing with the number of exposures. Month ticks run along the bottom.
 */
function TimeAxis(props: TimelineProps) {
  const { manifest, frames, current, mode, det, ready, loopCount, onSeek } = props;
  const reduce = useReducedMotion();
  const [ref, width] = useWidth<HTMLDivElement>();
  const epochs = useMemo(() => manifest?.epochs ?? [], [manifest]);
  const span = useMemo(() => {
    const mjds = [...frames.map((f) => f.mjd), ...(mode === "then-now" ? [] : epochs.flatMap((e) => [isoMjd(e.start), isoMjd(e.end) + 1]))];
    if (!mjds.length) return { t0: 0, t1: 1 };
    const lo = Math.min(...mjds);
    const hi = Math.max(...mjds);
    const pad = Math.max(8, (hi - lo) * 0.04);
    return { t0: lo - pad, t1: hi + pad };
  }, [frames, epochs, mode]);
  const x = (mjd: number) => (mjd - span.t0) / (span.t1 - span.t0 || 1);
  const showLanes = mode === "epochs" && epochs.length > 0;
  const activeDet = det && det !== "rgb" ? (det as DetectorKey) : null;
  const ticks = useMemo(() => monthTicks(span.t0, span.t1, width), [span, width]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Home") onSeek(0);
    else if (event.key === "End") onSeek(frames.length - 1);
    else return;
    event.preventDefault();
  };

  return (
    <div className="relative flex min-w-0 flex-1 flex-col" data-testid="blink-scrubber" onKeyDown={onKeyDown}>
      <div ref={ref} role="group" aria-label="Frames by date" className="relative h-7">
        <span aria-hidden className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-hair-strong" />
        {!reduce && loopCount > 0 && (
          <motion.span
            key={loopCount}
            aria-hidden
            initial={{ scaleX: 1, opacity: 0.55 }}
            animate={{ scaleX: 0, opacity: 0 }}
            transition={{ duration: 0.55, ease: [0.16, 1, 0.3, 1] }}
            className="absolute inset-x-0 top-1/2 h-px origin-left -translate-y-1/2 bg-accent"
            data-testid="loop-cue"
          />
        )}
        {frames.map((frame, i) => {
          const isCurrent = i === current;
          const label = `${[frame.label, frame.detail].filter(Boolean).join(" · ")}${frame.partial ? ", partial epoch" : ""}`;
          return (
            <Tooltip key={frame.key}>
              <TooltipTrigger asChild>
                <motion.button
                  type="button"
                  disabled={!ready}
                  onClick={() => onSeek(i)}
                  aria-label={label}
                  aria-current={isCurrent ? "true" : undefined}
                  data-testid="scrubber-tick"
                  data-partial={frame.partial || undefined}
                  initial={reduce ? false : { opacity: 0, scaleY: 0.2 }}
                  animate={{ opacity: 1, scaleY: 1 }}
                  transition={{ delay: reduce ? 0 : i * 0.035, duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
                  className="group absolute top-0 flex h-7 w-5 -translate-x-1/2 items-center justify-center rounded-sm disabled:cursor-default"
                  style={{ left: `${x(frame.mjd) * 100}%` }}
                >
                  <span
                    aria-hidden
                    className={cn(
                      "block w-px transition-[height,background-color] duration-300",
                      frame.partial ? "h-3 bg-[repeating-linear-gradient(180deg,var(--fg-dim)_0_2px,transparent_2px_4px)]" : "h-3.5 bg-fg-dim",
                      !isCurrent && "group-hover:h-5 group-hover:bg-fg",
                    )}
                  />
                  {isCurrent && (
                    <motion.span
                      layoutId="timeline-current"
                      aria-hidden
                      className="absolute top-1/2 left-1/2 h-5 w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent"
                      transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 640, damping: 44, mass: 0.6 }}
                    />
                  )}
                </motion.button>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-64 text-left leading-snug">
                <span className="readout">{[frame.label, frame.detail].filter(Boolean).join(" · ")}</span>
                {frame.epoch ? `, ${frame.epoch.n_exposures} exposures, ${formatDay(frame.mjd)}` : `, ${formatDay(frame.mjd)}`}
                {frame.partial && (
                  <span className="mt-0.5 block">
                    Partial epoch: the survey scan covered only part of this field. Edges may be missing and noise is higher.
                  </span>
                )}
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>

      {showLanes && (
        <div className="relative mt-0.5 hidden flex-col gap-px sm:flex" data-testid="detector-lanes" aria-label="Exposures per detector and epoch" role="img">
          {DETECTOR_KEYS.map((d) => (
            <div key={d} className="relative h-1.5" title={d}>
              <span aria-hidden className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-hair/60" />
              {epochs.map((e) => {
                const n = e.detectors[d.slice(1) as "1"] ?? 0;
                if (!n) return null;
                const a = x(isoMjd(e.start));
                const b = x(isoMjd(e.end) + 1);
                return (
                  <span
                    key={e.index}
                    aria-hidden
                    title={`${d}, ${e.label}: ${n} exposures`}
                    className={cn("absolute top-0.5 h-0.5 rounded-[1px]", d === activeDet ? "bg-accent" : "bg-fg-dim")}
                    style={{ left: `${a * 100}%`, width: `max(3px, ${(b - a) * 100}%)`, opacity: (e.full ? 1 : 0.5) * Math.min(1, 0.3 + n / 25) }}
                  />
                );
              })}
            </div>
          ))}
        </div>
      )}

      <div aria-hidden className="relative mt-1 h-4" data-testid="scrubber-labels">
        {ticks.map((t) => (
          <span
            key={t.mjd}
            data-testid="scrubber-label"
            className={cn("readout absolute top-0 -translate-x-1/2 text-micro leading-none whitespace-nowrap", t.year ? "text-fg-dim" : "text-fg-faint")}
            style={{ left: `${x(t.mjd) * 100}%` }}
          >
            {t.label}
          </span>
        ))}
      </div>
    </div>
  );
}

const isoMjd = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 86_400_000 + 40587;

function monthTicks(t0: number, t1: number, width: number): { mjd: number; label: string; year: boolean }[] {
  if (width <= 0 || t1 <= t0) return [];
  const start = mjdToDate(t0);
  const days = t1 - t0;
  const pxPerDay = width / days;
  // Month labels need ~44 px; fall back to quarters, then years.
  const step = pxPerDay * 30 >= 46 ? 1 : pxPerDay * 91 >= 46 ? 3 : 12;
  const out: { mjd: number; label: string; year: boolean }[] = [];
  let y = start.getUTCFullYear();
  let m = start.getUTCMonth() + 1;
  if (m > 11) {
    m = 0;
    y += 1;
  }
  m = Math.ceil(m / step) * step;
  for (let guard = 0; guard < 400; guard++) {
    if (m > 11) {
      y += Math.floor(m / 12);
      m %= 12;
    }
    const mjd = Date.UTC(y, m, 1) / 86_400_000 + 40587;
    if (mjd > t1) break;
    if (mjd >= t0) out.push({ mjd, label: m === 0 || step === 12 ? String(y) : MONTHS[m], year: m === 0 });
    m += step;
  }
  // Keep labels apart: drop any that would touch the previous one.
  const kept: typeof out = [];
  for (const t of out) {
    const prev = kept[kept.length - 1];
    if (!prev || (t.mjd - prev.mjd) * pxPerDay >= 40) kept.push(t);
  }
  return kept;
}

function ModeTabs({ mode, onMode, manifest }: { mode: LabMode; onMode: (m: LabMode) => void; manifest: FieldManifest }) {
  const reduce = useReducedMotion();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const enabled = (m: LabMode) =>
    m === "epochs" ? availableDetectors(manifest).length > 0 : m === "then-now" ? manifest.frames.then_vs_now.length > 1 : manifest.frames.difference.length > 0;
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const usable = MODES.filter((m) => enabled(m.value));
    const i = usable.findIndex((m) => m.value === mode);
    const next = usable[(i + (event.key === "ArrowRight" ? 1 : usable.length - 1)) % usable.length];
    onMode(next.value);
    refs.current[MODES.findIndex((m) => m.value === next.value)]?.focus();
  };
  return (
    <div role="tablist" aria-label="Blink mode" className="flex items-center gap-3.5" onKeyDown={onKeyDown}>
      {MODES.map((m, i) => {
        const active = m.value === mode;
        const ok = enabled(m.value);
        return (
          <button
            key={m.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            disabled={!ok}
            title={ok ? m.hint : "Not available for this field"}
            data-testid={`mode-${m.value}`}
            onClick={() => onMode(m.value)}
            className={cn(
              "relative py-1 text-meta text-fg-dim transition-colors duration-200 hover:text-fg disabled:opacity-35 disabled:hover:text-fg-dim",
              active && "text-fg",
            )}
          >
            {m.label}
            {active && (
              <motion.span
                layoutId="lab-mode-underline"
                aria-hidden
                className="absolute inset-x-0 -bottom-0.5 h-0.5 rounded-full bg-accent"
                transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 520, damping: 40 }}
              />
            )}
          </button>
        );
      })}
    </div>
  );
}

function DetectorPicker({
  manifest,
  mode,
  det,
  onDet,
}: {
  manifest: FieldManifest;
  mode: LabMode;
  det: LabDetector | null;
  onDet: (d: LabDetector) => void;
}) {
  const reduce = useReducedMotion();
  const options: LabDetector[] = mode === "difference" ? differenceDetectors(manifest) : availableDetectors(manifest);
  const all: LabDetector[] = mode === "difference" ? DETECTOR_KEYS : [...DETECTOR_KEYS, "rgb"];
  const range = det && det !== "rgb" ? detectorRange(manifest, det as DetectorKey) : null;
  const channels = manifest.frames.epoch.rgb?.[0]?.channels;
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    if (!det) return;
    const i = options.indexOf(det);
    const next = options[(i + (event.key === "ArrowRight" ? 1 : options.length - 1)) % options.length];
    onDet(next);
    (event.currentTarget.querySelector(`[data-det="${next}"]`) as HTMLButtonElement | null)?.focus();
  };
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <div role="radiogroup" aria-label="Detector" className="flex items-center" onKeyDown={onKeyDown}>
        {all.map((d) => {
          const active = d === det;
          const ok = options.includes(d);
          const [lo, hi] = d === "rgb" ? [0, 0] : detectorRange(manifest, d as DetectorKey);
          return (
            <button
              key={d}
              type="button"
              role="radio"
              aria-checked={active}
              tabIndex={active ? 0 : -1}
              disabled={!ok}
              data-det={d}
              data-testid={`det-${d}`}
              aria-label={d === "rgb" ? "Colour composite" : `Detector ${d.slice(1)}, ${lo.toFixed(2)} to ${hi.toFixed(2)} micrometres`}
              onClick={() => onDet(d)}
              className={cn(
                "relative rounded-sm px-1.5 py-1 text-micro text-fg-dim transition-colors duration-200 hover:text-fg disabled:opacity-30 disabled:hover:text-fg-dim",
                active && "text-fg",
              )}
            >
              {d === "rgb" ? "Colour" : d}
              {active && (
                <motion.span
                  layoutId="lab-det-underline"
                  aria-hidden
                  className="absolute inset-x-1.5 -bottom-px h-px bg-accent"
                  transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 560, damping: 42 }}
                />
              )}
            </button>
          );
        })}
      </div>
      <p className="text-micro text-fg-dim" data-testid="det-range">
        {range ? (
          <>
            <span className="readout text-fg">
              {range[0].toFixed(2)}–{range[1].toFixed(2)}
            </span>{" "}
            <Term k="micron">µm</Term>
          </>
        ) : det === "rgb" ? (
          <>
            <Term k="falseColour">False colour</Term>: {channels ? channels.split("/").join(", ") : "D6, D3, D1"}
          </>
        ) : null}
      </p>
    </div>
  );
}

function ThenNowRow({ frames }: { frames: BlinkFrame[] }) {
  if (frames.length < 2) return null;
  const years = (frames[frames.length - 1].mjd - frames[0].mjd) / 365.25;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1" data-testid="then-now-row">
      <p className="text-micro text-fg-dim">
        {frames.map((f, i) => (
          <Fragment key={f.key}>
            {i > 0 && " against "}
            <span className="text-fg">{micro(f.detail)}</span>
          </Fragment>
        ))}
      </p>
      <p className="text-micro text-fg-dim">
        <span className="readout text-fg">{years.toFixed(1)}</span> years apart
      </p>
    </div>
  );
}

function DifferenceRow({
  frame,
  ready,
  loaded,
  total,
  note,
}: {
  frame: BlinkFrame | null;
  ready: boolean;
  loaded: number;
  total: number;
  note: string | null;
}): ReactNode {
  if (!frame) return null;
  const compare = frame.compare;
  return (
    <div className="flex flex-col gap-2 py-0.5">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="text-ui text-fg" data-testid="frame-label">
            {compare ? (
              <>
                <span className="readout">{compare.last}</span> minus <span className="readout">{compare.first}</span>
              </>
            ) : (
              frame.label
            )}
          </p>
          <p className="text-micro text-pretty text-fg-faint">
            A <Term k="difference">difference image</Term>: each pixel is its change divided by its noise (
            <Term k="sigma">σ</Term>). Noise alone rarely reaches ±5σ. A mover leaves a dark and bright pair.
            {frame.partial ? " One of the two epochs is partial, so edges may be missing." : ""}
          </p>
        </div>
        {frame.diverging && (
          <div className="flex items-center gap-3" data-testid="difference-legend">
            <span className="text-micro text-fg-dim">Brighter first</span>
            <div className="flex flex-col gap-0.5">
              <span aria-hidden className="block h-2 w-32 rounded-[2px]" style={{ background: DIVERGING_GRADIENT }} />
              <span className="readout flex justify-between text-micro text-fg-faint">
                <span>{frame.diverging.limits[0]}σ</span>
                <span>0</span>
                <span>+{frame.diverging.limits[1]}σ</span>
              </span>
            </div>
            <span className="text-micro text-fg-dim">Brighter last</span>
          </div>
        )}
        {!ready && (
          <p className="shrink-0 text-micro text-fg-dim" aria-live="polite" data-testid="blink-loading">
            Loading <span className="readout">{loaded}</span> of <span className="readout">{total}</span>
          </p>
        )}
      </div>
      {note && (
        <p className="text-micro text-pretty text-fg-dim" data-testid="blink-note">
          {note}
        </p>
      )}
    </div>
  );
}
