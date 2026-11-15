"use client";
// Time scrubber: one tick per frame, placed in proportion to its date so the real cadence shows
// (SPHEREx revisits a field about every six months). Each tick is labelled with its date and
// survey ("Aug 2025", "S2") wherever the labels fit; on narrow screens only the years at both
// ends are shown. Partial epochs are dashed and greyed, with a tooltip that says why. The current
// frame carries the accent; a faint sweep marks each restart of the loop.

import { useEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import type { BlinkFrame } from "@/lib/lab-field";
import { mjdToDate } from "@/lib/lab-coords";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/** Plex Mono advance at text-micro (12 px): 0.6 em. */
const CHAR_PX = 7.2;
const LABEL_GAP_PX = 10;

/** Positions in [0, 1] by date, with a minimum gap so close epochs stay clickable. */
function tickPositions(frames: BlinkFrame[]): number[] {
  if (frames.length === 0) return [];
  if (frames.length === 1) return [0.5];
  const mjds = frames.map((f) => f.mjd);
  const lo = Math.min(...mjds);
  const hi = Math.max(...mjds);
  const span = hi - lo || 1;
  const gap = Math.min(0.09, 0.8 / (frames.length - 1));
  const raw = mjds.map((m) => (m - lo) / span);
  for (let i = 1; i < raw.length; i++) raw[i] = Math.max(raw[i], raw[i - 1] + gap);
  const max = raw[raw.length - 1];
  return raw.map((x) => x / max);
}

/** Short survey tags (S1..S4) get a second label line; long instrument names do not. */
const surveyOf = (frame: BlinkFrame) => (frame.detail.length <= 4 ? frame.detail : "");

function frameTitle(frame: BlinkFrame) {
  return [frame.label, frame.detail].filter(Boolean).join(" · ");
}

interface PlacedLabel {
  index: number;
  left: number;
  width: number;
}

/**
 * Greedy label placement: keep a label when it clears the previous one; the last label always
 * wins its place. Returns null when not even the first and last labels fit.
 */
function placeLabels(frames: BlinkFrame[], positions: number[], width: number): PlacedLabel[] | null {
  if (width <= 0 || frames.length === 0) return null;
  const items = frames.map((f, i) => {
    const w = Math.max(f.label.length, surveyOf(f).length) * CHAR_PX + 2;
    const left = Math.min(Math.max(positions[i] * width - w / 2, 0), Math.max(0, width - w));
    return { index: i, left, width: w };
  });
  const kept: PlacedLabel[] = [];
  for (const item of items) {
    const prev = kept[kept.length - 1];
    if (!prev || item.left >= prev.left + prev.width + LABEL_GAP_PX) kept.push(item);
  }
  const last = items[items.length - 1];
  if (kept[kept.length - 1]?.index !== last.index) {
    while (kept.length && kept[kept.length - 1].left + kept[kept.length - 1].width + LABEL_GAP_PX > last.left) kept.pop();
    kept.push(last);
  }
  if (frames.length > 1 && (kept.length < 2 || kept[0].index !== 0)) return null;
  return kept;
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

export function BlinkScrubber({
  frames,
  current,
  loopCount,
  onSeek,
  disabled,
}: {
  frames: BlinkFrame[];
  current: number;
  loopCount: number;
  onSeek: (index: number) => void;
  disabled?: boolean;
}) {
  const reduce = useReducedMotion();
  const [trackRef, width] = useWidth<HTMLDivElement>();
  const positions = tickPositions(frames);
  const labels = placeLabels(frames, positions, width);
  const firstYear = frames.length ? mjdToDate(Math.min(...frames.map((f) => f.mjd))).getUTCFullYear() : null;
  const lastYear = frames.length ? mjdToDate(Math.max(...frames.map((f) => f.mjd))).getUTCFullYear() : null;
  const twoLines = labels?.some((l) => surveyOf(frames[l.index])) ?? false;

  return (
    <div className="relative flex min-w-0 flex-1 flex-col gap-0.5" data-testid="blink-scrubber">
      <div ref={trackRef} role="group" aria-label="Frames by date" className="relative h-8">
        {/* baseline */}
        <span aria-hidden className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-hair-strong" />
        {/* loop restart sweep */}
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
          const label = `${frameTitle(frame)}${frame.partial ? ", partial epoch" : ""}`;
          const tick = (
            <button
              type="button"
              disabled={disabled}
              onClick={() => onSeek(i)}
              aria-label={label}
              aria-current={isCurrent ? "true" : undefined}
              data-testid="scrubber-tick"
              data-partial={frame.partial || undefined}
              className="group absolute top-0 flex h-8 w-6 -translate-x-1/2 items-center justify-center rounded-sm disabled:cursor-default"
              style={{ left: `${positions[i] * 100}%` }}
            >
              <span
                aria-hidden
                className={cn(
                  "block w-px transition-[height,background-color,opacity] duration-300",
                  frame.partial
                    ? "h-3 bg-[repeating-linear-gradient(180deg,var(--fg-dim)_0_2px,transparent_2px_4px)] opacity-70"
                    : "h-3.5 bg-fg-dim",
                  !isCurrent && "group-hover:h-5 group-hover:bg-fg",
                )}
              />
              {isCurrent && (
                <motion.span
                  layoutId="scrubber-current"
                  aria-hidden
                  className="absolute top-1/2 left-1/2 h-6 w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent"
                  transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 640, damping: 44, mass: 0.6 }}
                />
              )}
            </button>
          );
          return (
            <Tooltip key={frame.key}>
              <TooltipTrigger asChild>{tick}</TooltipTrigger>
              <TooltipContent side="top" className="max-w-64 text-left leading-snug">
                <span className="readout">{frameTitle(frame)}</span>
                {frame.epoch ? `, ${frame.epoch.n_exposures} exposures` : ""}
                {frame.partial && (
                  <span className="mt-0.5 block">
                    Partial epoch: the survey scan covered only part of this field. Edges may be missing and noise is
                    higher.
                  </span>
                )}
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>

      {labels ? (
        <div aria-hidden className={cn("relative", twoLines ? "h-8" : "h-4")} data-testid="scrubber-labels">
          {labels.map(({ index, left, width: w }) => {
            const frame = frames[index];
            const survey = surveyOf(frame);
            return (
              <span
                key={frame.key}
                data-testid="scrubber-label"
                className={cn(
                  "readout absolute top-0 flex flex-col text-micro whitespace-nowrap transition-colors duration-300",
                  index === 0 ? "items-start" : index === frames.length - 1 ? "items-end" : "items-center",
                  index === current ? "text-fg" : frame.partial ? "text-fg-faint" : "text-fg-dim",
                )}
                style={{ left, width: w }}
              >
                <span>{frame.label}</span>
                {survey && <span className={index === current ? "text-fg-dim" : "text-fg-faint"}>{survey}</span>}
              </span>
            );
          })}
        </div>
      ) : (
        <div aria-hidden className="readout flex justify-between text-micro text-fg-faint">
          <span>{firstYear}</span>
          {lastYear !== firstYear && <span>{lastYear}</span>}
        </div>
      )}
    </div>
  );
}
