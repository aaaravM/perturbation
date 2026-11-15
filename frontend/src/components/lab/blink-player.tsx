"use client";
// The blink player: mode tabs (Epochs, Then vs Now, Difference), detector picker with each
// detector's wavelength range, Path and Flags layers, play/pause (Space), step (Left/Right),
// time per frame (150-1200 ms, default 500 as in WiseView) and the dated scrubber.

import { Fragment, useRef, type KeyboardEvent } from "react";
import { ChevronLeftIcon, ChevronRightIcon, PauseIcon, PlayIcon } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { Label } from "radix-ui";
import type { DetectorKey, FieldManifest } from "@/lib/manifest";
import type { BlinkFrame } from "@/lib/lab-field";
import { DETECTOR_KEYS, availableDetectors, detectorRange, differenceDetectors } from "@/lib/lab-field";
import type { LabDetector, LabMode } from "@/lib/lab-state";
import { cn } from "@/lib/utils";
import { Kbd } from "@/components/ui/kbd";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { BlinkScrubber } from "@/components/lab/blink-scrubber";
import { DIVERGING_GRADIENT } from "@/components/lab/diverging";

const MODES: { value: LabMode; label: string; hint: string }[] = [
  { value: "epochs", label: "Epochs", hint: "One co-added image per visit, per detector" },
  { value: "then-now", label: "Then vs Now", hint: "WISE about 2010 against SPHEREx today" },
  { value: "difference", label: "Difference", hint: "Last epoch minus first, in units of the noise" },
];

export const SPEED_MIN = 150;
export const SPEED_MAX = 1200;
export const SPEED_DEFAULT = 500;

function fmtWl(v: number) {
  return v.toFixed(2);
}

export interface BlinkPlayerProps {
  manifest: FieldManifest;
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
  showPath: boolean;
  showFlags: boolean;
  hasPath: boolean;
  zoomedOut: boolean;
  onMode: (mode: LabMode) => void;
  onDet: (det: LabDetector) => void;
  onTogglePlay: () => void;
  onStep: (delta: 1 | -1) => void;
  onSeek: (index: number) => void;
  onSpeed: (ms: number) => void;
  onShowPath: (on: boolean) => void;
  onShowFlags: (on: boolean) => void;
  onZoomToField: () => void;
  /** Opens the detail panel when it is closed. */
  onDetails?: () => void;
  /** A plain note about what is shown (replaces the hint line), e.g. why a prepared field is on screen. */
  note?: string | null;
}

/** Instrument strings from the backend use "um"; show the micro sign. */
const micro = (text: string) => text.replace(/(\d)\s?um\b/g, "$1 µm");

export function BlinkPlayer(props: BlinkPlayerProps) {
  const {
    manifest,
    mode,
    det,
    frames,
    current,
    playing,
    speed,
    loopCount,
    loaded,
    ready,
    failed,
    showPath,
    showFlags,
    hasPath,
    zoomedOut,
  } = props;
  const reduce = useReducedMotion();
  const frame = frames[current] ?? null;
  const total = frames.length;
  const canPlay = ready && total > 1 && !zoomedOut;
  const flagsAvailable = frames.some((f) => f.flags);
  const progress = total ? loaded / total : 0;

  return (
    <section
      aria-label="Blink player"
      data-testid="blink-player"
      data-mode={mode}
      data-ready={ready || undefined}
      className="panel relative flex flex-col gap-3 overflow-hidden px-3.5 pt-2.5 pb-3 sm:px-4"
    >
      {/* preload progress along the top edge */}
      <motion.span
        aria-hidden
        className="absolute inset-x-0 top-0 h-px origin-left bg-fg-dim"
        initial={false}
        animate={{ scaleX: ready ? 1 : progress, opacity: ready ? 0 : 1 }}
        transition={{ duration: reduce ? 0 : 0.35, ease: [0.16, 1, 0.3, 1] }}
      />

      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <ModeTabs mode={mode} onMode={props.onMode} manifest={manifest} />
        <div className="flex items-center gap-4">
          {props.onDetails && (
            <button
              type="button"
              onClick={props.onDetails}
              data-testid="open-details"
              className="text-meta text-fg underline decoration-hair-strong underline-offset-4 transition-colors hover:decoration-fg"
            >
              Details
            </button>
          )}
          <LayerSwitch
            id="layer-path"
            label="Path"
            checked={showPath}
            disabled={!hasPath}
            hint={hasPath ? "The object's track across the epochs" : "No motion measured for this field"}
            onChange={props.onShowPath}
          />
          <LayerSwitch
            id="layer-flags"
            label="Flags"
            checked={showFlags && flagsAvailable}
            disabled={!flagsAvailable}
            hint={
              flagsAvailable
                ? "Pixels flagged in the official SPHEREx masks"
                : "Flags exist for single-detector epochs only"
            }
            onChange={props.onShowFlags}
          />
        </div>
      </div>

      {mode === "then-now" ? (
        <ThenNowRow frames={frames} />
      ) : (
        <DetectorPicker manifest={manifest} mode={mode} det={det} onDet={props.onDet} />
      )}

      {zoomedOut ? (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-hair pt-3">
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
        <div className="flex flex-col gap-2.5 border-t border-hair pt-2.5">
          <DifferenceSummary frame={frame} ready={ready} loaded={loaded} total={total} />
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            {frame?.diverging && <DifferenceLegend limits={frame.diverging.limits} />}
            {props.note && <p className="text-micro text-pretty text-fg-dim" data-testid="blink-note">{props.note}</p>}
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2 border-t border-hair pt-2.5">
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
                    className="grid size-9 place-items-center rounded-md border border-hair-strong text-fg transition-colors hover:bg-ink-3 disabled:opacity-40"
                  >
                    {playing && canPlay ? (
                      <PauseIcon className="size-4" aria-hidden />
                    ) : (
                      <PlayIcon className="size-4 translate-x-px" aria-hidden />
                    )}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">
                  {playing ? "Pause" : "Play"} <Kbd>Space</Kbd>
                </TooltipContent>
              </Tooltip>
              <StepButton dir={-1} disabled={!ready || total < 2} onStep={props.onStep} />
              <StepButton dir={1} disabled={!ready || total < 2} onStep={props.onStep} />
            </div>

            <BlinkScrubber frames={frames} current={current} loopCount={loopCount} onSeek={props.onSeek} disabled={!ready} />

            <FrameReadout frame={frame} index={current} total={total} ready={ready} loaded={loaded} failed={failed} />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            {props.note ? (
              <p className="min-w-0 flex-1 basis-80 text-micro text-pretty text-fg-dim" data-testid="blink-note">
                {props.note}
              </p>
            ) : showFlags && frame?.flags ? (
              <FlagsLegend legend={frame.flags.legend} />
            ) : (
              <p className="hidden text-micro text-fg-faint sm:block">
                {mode === "then-now"
                  ? "Same patch, years apart. Fast stars have visibly moved."
                  : "Stars stay put; anything that jumps between frames moved or changed."}
              </p>
            )}
            <div className="flex w-full items-center gap-3 sm:w-auto">
              <Label.Root htmlFor="blink-speed" className="text-micro whitespace-nowrap text-fg-dim">
                Time per frame
              </Label.Root>
              <Slider
                id="blink-speed"
                min={SPEED_MIN}
                max={SPEED_MAX}
                step={50}
                value={[speed]}
                onValueChange={([v]) => props.onSpeed(v)}
                aria-label="Time per frame"
                aria-valuetext={`${speed} milliseconds per frame`}
                className="w-full sm:w-28 [&_[data-slot=slider-range]]:bg-fg-dim [&_[data-slot=slider-thumb]]:border-fg [&_[data-slot=slider-thumb]]:bg-ink"
              />
              <span className="readout w-16 shrink-0 text-right text-micro whitespace-nowrap text-fg-dim">{speed} ms</span>
            </div>
          </div>
        </div>
      )}
    </section>
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
          className="grid size-8 place-items-center rounded-md text-fg-dim transition-colors hover:bg-ink-3 hover:text-fg disabled:opacity-40"
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
      <p className="w-36 shrink-0 text-right text-micro text-fg-dim sm:w-44" aria-live="polite" data-testid="blink-loading">
        Loading frames <span className="readout">{loaded}</span> of <span className="readout">{total}</span>
      </p>
    );
  }
  return (
    <div className="flex w-36 shrink-0 flex-col items-end text-right sm:w-44" aria-live="off">
      <p className="readout truncate text-meta text-fg" data-testid="frame-label">
        {frame ? [frame.label, frame.detail.length <= 4 ? frame.detail : null].filter(Boolean).join(" · ") : "–"}
      </p>
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

function ModeTabs({ mode, onMode, manifest }: { mode: LabMode; onMode: (m: LabMode) => void; manifest: FieldManifest }) {
  const reduce = useReducedMotion();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const enabled = (m: LabMode) =>
    m === "epochs"
      ? availableDetectors(manifest).length > 0
      : m === "then-now"
        ? manifest.frames.then_vs_now.length > 1
        : manifest.frames.difference.length > 0;
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
    <div role="tablist" aria-label="Blink mode" className="flex items-center gap-4" onKeyDown={onKeyDown}>
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
              "relative py-1 text-ui text-fg-dim transition-colors duration-200 hover:text-fg disabled:opacity-35 disabled:hover:text-fg-dim",
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
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
      <div role="radiogroup" aria-label="Detector" className="flex items-center gap-0.5" onKeyDown={onKeyDown}>
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
              aria-label={d === "rgb" ? "Colour composite" : `Detector ${d.slice(1)}, ${fmtWl(lo)} to ${fmtWl(hi)} micrometres`}
              onClick={() => onDet(d)}
              className={cn(
                "relative rounded-sm px-2 py-1 text-meta text-fg-dim transition-colors duration-200 hover:text-fg disabled:opacity-30 disabled:hover:text-fg-dim",
                active && "text-fg",
              )}
            >
              {d === "rgb" ? "Colour" : d}
              {active && (
                <motion.span
                  layoutId="lab-det-underline"
                  aria-hidden
                  className="absolute inset-x-2 -bottom-px h-px bg-accent"
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
              {fmtWl(range[0])}–{fmtWl(range[1])}
            </span>{" "}
            µm
          </>
        ) : det === "rgb" ? (
          <>False colour: {channels ? channels.split("/").join(", ") : "D6, D3, D1"} as red, green, blue</>
        ) : null}
      </p>
    </div>
  );
}

function LayerSwitch({
  id,
  label,
  checked,
  disabled,
  hint,
  onChange,
}: {
  id: string;
  label: string;
  checked: boolean;
  disabled?: boolean;
  hint: string;
  onChange: (on: boolean) => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className={cn("flex items-center gap-2", disabled && "opacity-45")}>
          <Label.Root htmlFor={id} className="cursor-pointer text-meta text-fg-dim">
            {label}
          </Label.Root>
          <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} data-testid={id} />
        </div>
      </TooltipTrigger>
      <TooltipContent side="top">{hint}</TooltipContent>
    </Tooltip>
  );
}

/** Then vs Now: what is compared with what, and how far apart in time. Same height as the detector row. */
function ThenNowRow({ frames }: { frames: BlinkFrame[] }) {
  if (frames.length < 2) return null;
  const years = (frames[frames.length - 1].mjd - frames[0].mjd) / 365.25;
  return (
    <div className="flex min-h-[27px] flex-wrap items-center justify-between gap-x-4 gap-y-1" data-testid="then-now-row">
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

/** Difference mode shows one image, so instead of a timeline: which epochs, and how to read it. */
function DifferenceSummary({
  frame,
  ready,
  loaded,
  total,
}: {
  frame: BlinkFrame | null;
  ready: boolean;
  loaded: number;
  total: number;
}) {
  if (!frame) return null;
  const compare = frame.compare;
  return (
    <div className="flex items-start justify-between gap-4">
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
          Each pixel is its change divided by its noise (σ). Noise alone rarely reaches ±5σ.
          {frame.partial ? " One of the two epochs is partial, so edges may be missing." : ""}
        </p>
      </div>
      {!ready && (
        <p className="shrink-0 text-micro text-fg-dim" aria-live="polite" data-testid="blink-loading">
          Loading <span className="readout">{loaded}</span> of <span className="readout">{total}</span>
        </p>
      )}
    </div>
  );
}

function DifferenceLegend({ limits }: { limits: [number, number] }) {
  return (
    <div className="flex items-center gap-3" data-testid="difference-legend">
      <span className="text-micro text-fg-dim">Brighter first</span>
      <div className="flex flex-col gap-0.5">
        <span aria-hidden className="block h-2 w-32 rounded-[2px] sm:w-40" style={{ background: DIVERGING_GRADIENT }} />
        <span className="readout flex justify-between text-micro text-fg-faint">
          <span>{limits[0]}σ</span>
          <span>0</span>
          <span>+{limits[1]}σ</span>
        </span>
      </div>
      <span className="text-micro text-fg-dim">Brighter last</span>
    </div>
  );
}

function FlagsLegend({ legend }: { legend: Record<string, string> }) {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1" aria-label="Flag colours">
      {Object.entries(legend).map(([name, color]) => (
        <li key={name} className="flex items-center gap-1.5 text-micro text-fg-dim">
          <span aria-hidden className="block size-2.5 rounded-[2px]" style={{ backgroundColor: color }} />
          {name.charAt(0).toUpperCase() + name.slice(1)}
        </li>
      ))}
    </ul>
  );
}
