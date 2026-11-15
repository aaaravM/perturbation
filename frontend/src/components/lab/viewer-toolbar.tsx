"use client";
// The viewer's toolbar: inspect, ruler and aperture tools; RA/Dec grid and crosshair; display
// stretch with min/max cuts over a live histogram of the frame on screen; colour map; zoom.

import { CircleDashedIcon, CrosshairIcon, Grid3x3Icon, MousePointer2Icon, RulerIcon, ScanIcon, SlidersHorizontalIcon } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Slider } from "@/components/ui/slider";
import { Term } from "@/components/ui/term";
import { FovControl } from "@/components/lab/fov-control";
import { COLORMAPS, DEFAULT_DISPLAY, STRETCHES, isDefaultDisplay, type DisplaySettings } from "@/components/lab/display";
import { Seg, ToolButton } from "@/components/lab/workbench-ui";
import { cn } from "@/lib/utils";

export type Tool = "inspect" | "ruler" | "aperture";

export function ViewerToolbar({
  tool,
  onTool,
  grid,
  onGrid,
  crosshair,
  onCrosshair,
  display,
  onDisplay,
  histogram,
  fov,
  onFov,
  onZoomToField,
  hasField,
}: {
  tool: Tool;
  onTool: (tool: Tool) => void;
  grid: boolean;
  onGrid: (on: boolean) => void;
  crosshair: boolean;
  onCrosshair: (on: boolean) => void;
  display: DisplaySettings;
  onDisplay: (d: DisplaySettings) => void;
  histogram: number[] | null;
  fov: number;
  onFov: (fov: number) => void;
  onZoomToField: () => void;
  hasField: boolean;
}) {
  return (
    <div
      role="toolbar"
      aria-label="Viewer tools"
      data-testid="viewer-toolbar"
      className="flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-b border-hair px-2 [scrollbar-width:none]"
    >
      <ToolButton label="Inspect: click a star" shortcut="V" pressed={tool === "inspect"} onClick={() => onTool("inspect")} testId="tool-inspect">
        <MousePointer2Icon className="size-3.5" aria-hidden />
      </ToolButton>
      <ToolButton label="Ruler: distance and position angle" shortcut="R" pressed={tool === "ruler"} onClick={() => onTool("ruler")} testId="tool-ruler">
        <RulerIcon className="size-3.5" aria-hidden />
      </ToolButton>
      <ToolButton label="Aperture: circle statistics" shortcut="A" pressed={tool === "aperture"} onClick={() => onTool("aperture")} testId="tool-aperture">
        <CircleDashedIcon className="size-3.5" aria-hidden />
      </ToolButton>
      <span aria-hidden className="mx-1 h-4 w-px bg-hair" />
      <ToolButton label="RA/Dec grid" shortcut="G" pressed={grid} onClick={() => onGrid(!grid)} testId="tool-grid">
        <Grid3x3Icon className="size-3.5" aria-hidden />
      </ToolButton>
      <ToolButton label="Crosshair" shortcut="X" pressed={crosshair} onClick={() => onCrosshair(!crosshair)} testId="tool-crosshair">
        <CrosshairIcon className="size-3.5" aria-hidden />
      </ToolButton>
      <span aria-hidden className="mx-1 h-4 w-px bg-hair" />
      <StretchPopover display={display} onDisplay={onDisplay} histogram={histogram} disabled={!hasField} />
      <div className="ml-auto flex shrink-0 items-center gap-1 pl-2">
        <ToolButton label="Zoom to the field" shortcut="F" disabled={!hasField} onClick={onZoomToField} testId="tool-zoom-field">
          <ScanIcon className="size-3.5" aria-hidden />
        </ToolButton>
        <FovControl fov={fov} onChange={onFov} />
      </div>
    </div>
  );
}

function StretchPopover({
  display,
  onDisplay,
  histogram,
  disabled,
}: {
  display: DisplaySettings;
  onDisplay: (d: DisplaySettings) => void;
  histogram: number[] | null;
  disabled: boolean;
}) {
  const custom = !isDefaultDisplay(display);
  const cmap = COLORMAPS.find((c) => c.value === display.colormap) ?? COLORMAPS[0];
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          data-testid="tool-stretch"
          className={cn(
            "inline-flex h-7 shrink-0 items-center gap-2 rounded-[5px] px-2 text-micro text-fg-dim transition-colors hover:bg-white/[0.06] hover:text-fg disabled:pointer-events-none disabled:opacity-35",
            custom && "text-fg",
          )}
        >
          <SlidersHorizontalIcon className="size-3.5" aria-hidden />
          <span className="sr-only">Display stretch and colour map: </span>
          <span>{STRETCHES.find((s) => s.value === display.stretch)?.label}</span>
          <span aria-hidden className="block h-2 w-8 rounded-[2px] ring-1 ring-hair" style={{ background: cmap.css }} />
          {custom && <span className="text-fg-faint">custom</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 border-hair-strong bg-popover p-3" data-testid="stretch-panel">
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-ui text-fg">Display</p>
            <button
              type="button"
              onClick={() => onDisplay(DEFAULT_DISPLAY)}
              disabled={!custom}
              className="text-micro text-fg-dim underline decoration-hair-strong underline-offset-4 hover:text-fg disabled:opacity-40"
            >
              Reset
            </button>
          </div>
          <Histogram bins={histogram} lo={display.lo} hi={display.hi} />
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between text-micro text-fg-dim">
              <span>Cuts (display level)</span>
              <span className="readout text-fg">
                {display.lo}–{display.hi}
              </span>
            </div>
            <Slider
              min={0}
              max={255}
              step={1}
              minStepsBetweenThumbs={8}
              value={[display.lo, display.hi]}
              onValueChange={([lo, hi]) => onDisplay({ ...display, lo, hi })}
              aria-label="Minimum and maximum cut"
              className="[&_[data-slot=slider-range]]:bg-fg-dim [&_[data-slot=slider-thumb]]:border-fg [&_[data-slot=slider-thumb]]:bg-ink"
            />
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-micro text-fg-dim">
              <Term k="stretch" />
            </span>
            <Seg label="Stretch" value={display.stretch} options={STRETCHES} onChange={(stretch) => onDisplay({ ...display, stretch })} layoutId="stretch-seg" testIdPrefix="stretch" />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-micro text-fg-dim">Colour map</span>
            <div role="radiogroup" aria-label="Colour map" className="grid grid-cols-4 gap-1.5">
              {COLORMAPS.map((c) => (
                <button
                  key={c.value}
                  type="button"
                  role="radio"
                  aria-checked={display.colormap === c.value}
                  onClick={() => onDisplay({ ...display, colormap: c.value })}
                  className={cn(
                    "flex flex-col items-start gap-1 rounded-[5px] p-1 text-micro text-fg-dim ring-1 ring-hair transition-colors hover:text-fg",
                    display.colormap === c.value && "text-fg ring-accent",
                  )}
                >
                  <span aria-hidden className="block h-2 w-full rounded-[2px]" style={{ background: c.css }} />
                  {c.label}
                </button>
              ))}
            </div>
          </div>
          <p className="text-micro text-pretty text-fg-faint">
            Changes how the frames look, not the data. Every epoch gets the same setting, so
            brightness changes stay real. Colour composites keep their colours.
          </p>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function Histogram({ bins, lo, hi }: { bins: number[] | null; lo: number; hi: number }) {
  const w = 248;
  const h = 56;
  if (!bins) {
    return <div className="grid h-14 place-items-center rounded-[4px] bg-ink-3 text-micro text-fg-faint">No frame on screen</div>;
  }
  const logs = bins.map((c) => Math.log10(1 + c));
  const max = Math.max(...logs, 1e-9);
  const bw = w / bins.length;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-14 w-full" role="img" aria-label="Histogram of display levels in the frame on screen (log counts)" data-testid="stretch-histogram">
      <rect x={(lo / 255) * w} y={0} width={Math.max(0, ((hi - lo) / 255) * w)} height={h} fill="var(--accent-faint)" />
      {logs.map((v, i) => (
        <rect key={i} x={i * bw + 0.5} y={h - (v / max) * (h - 4)} width={Math.max(0.5, bw - 1)} height={(v / max) * (h - 4)} fill="var(--fg-dim)" opacity={0.8} />
      ))}
      <line x1={(lo / 255) * w} x2={(lo / 255) * w} y1={0} y2={h} stroke="var(--accent)" strokeWidth={1} />
      <line x1={(hi / 255) * w} x2={(hi / 255) * w} y1={0} y2={h} stroke="var(--accent)" strokeWidth={1} />
    </svg>
  );
}
