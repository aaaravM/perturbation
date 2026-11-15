"use client";
// Small windows onto SPHEREx images for the Discoveries and Help pages.
// A source is either a candidate's stamp (one PNG strip of three 64 x 64 panels: earlier co-add,
// later co-add, S/N difference; public/discoveries/README.md) or three frames from a prepared
// challenge bundle, cropped around a point. Panels are drawn pixel for pixel, never smoothed.
//
// Blinking: the panels of a "blink" are stacked, and the later one shows while an ancestor with the
// class group/blink has data-phase="1". useBlinkClock flips that attribute on a timer without a React
// render, so every stamp inside one container flips together and a long list stays cheap.

import * as React from "react";
import Image from "next/image";
import { PauseIcon, PlayIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export type StampSource =
  | { type: "strip"; src: string }
  | {
      type: "frames";
      /** Earlier, later and difference frames, all the same size. */
      src: readonly [string, string, string];
      /** Frame size in pixels (square). */
      grid: number;
      /** Centre of the crop, in frame pixels from the top-left. */
      cx: number;
      cy: number;
      /** Width of the crop in frame pixels. */
      window: number;
    };

export type Panel = 0 | 1 | 2;

const PIXELATED = "[image-rendering:pixelated]";

/** One panel of a source, filling a square box. */
export function StampPanel({
  source,
  panel,
  className,
  style,
}: {
  source: StampSource;
  panel: Panel;
  className?: string;
  style?: React.CSSProperties;
}) {
  let img: React.ReactNode;
  if (source.type === "strip") {
    img = (
      <Image
        src={source.src}
        alt=""
        width={192}
        height={64}
        unoptimized
        loading="eager"
        draggable={false}
        className={cn("absolute top-0 h-full max-w-none select-none", PIXELATED)}
        style={{ width: "300%", left: `${-panel * 100}%` }}
      />
    );
  } else {
    const scale = (source.grid / source.window) * 100;
    const left = ((source.window / 2 - (source.cx + 0.5)) / source.window) * 100;
    const top = ((source.window / 2 - (source.cy + 0.5)) / source.window) * 100;
    img = (
      <Image
        src={source.src[panel]}
        alt=""
        width={source.grid}
        height={source.grid}
        unoptimized
        loading="eager"
        draggable={false}
        className={cn("absolute max-w-none select-none", PIXELATED)}
        style={{ width: `${scale}%`, height: `${scale}%`, left: `${left}%`, top: `${top}%` }}
      />
    );
  }
  return (
    <div aria-hidden className={cn("relative aspect-square overflow-hidden bg-black", className)} style={style}>
      {img}
    </div>
  );
}

/**
 * The earlier and later panels stacked; the later one shows while the nearest group/blink ancestor
 * has data-phase="1" (see useBlinkClock).
 */
export function BlinkPanels({ source, className }: { source: StampSource; className?: string }) {
  return (
    <div aria-hidden className={cn("relative aspect-square overflow-hidden bg-black", className)}>
      <StampPanel source={source} panel={0} className="absolute inset-0" />
      <StampPanel
        source={source}
        panel={1}
        className="absolute inset-0 opacity-0 group-data-[phase=1]/blink:opacity-100"
      />
    </div>
  );
}

/** Text that shows only in one phase of the blink. */
export function PhaseText({ phase, children, className }: { phase: 0 | 1; children: React.ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        phase === 0
          ? "group-data-[phase=1]/blink:hidden"
          : "hidden group-data-[phase=1]/blink:inline",
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Pause or play a group of blinking images: anything that blinks by itself can be stopped. */
export function BlinkToggle({
  paused,
  onToggle,
  className,
  testId,
}: {
  paused: boolean;
  onToggle: () => void;
  className?: string;
  testId?: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onToggle}
      aria-pressed={paused}
      className={cn(
        "inline-flex h-9 items-center gap-1.5 rounded-[8px] px-2 text-meta text-fg-dim transition-colors hover:bg-white/[0.05] hover:text-fg",
        className,
      )}
    >
      {paused ? <PlayIcon aria-hidden className="size-3.5" /> : <PauseIcon aria-hidden className="size-3.5" />}
      {paused ? "Play the blinks" : "Pause the blinks"}
    </button>
  );
}

/**
 * Flip data-phase on the returned element every `ms` while `playing`. Put the ref on an element with
 * the class group/blink. `flip` steps once by hand (for a paused blink); `reset` shows the earlier panel.
 */
export function useBlinkClock<T extends HTMLElement>(ms: number, playing: boolean) {
  const ref = React.useRef<T>(null);
  const flip = React.useCallback(() => {
    const el = ref.current;
    if (el) el.dataset.phase = el.dataset.phase === "1" ? "0" : "1";
  }, []);
  const reset = React.useCallback(() => {
    const el = ref.current;
    if (el) el.dataset.phase = "0";
  }, []);
  React.useEffect(() => {
    if (!playing) return;
    const id = window.setInterval(flip, ms);
    return () => window.clearInterval(id);
  }, [ms, playing, flip]);
  return { ref, flip, reset };
}
