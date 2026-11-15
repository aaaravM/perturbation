"use client";
// The globe's layer control: a small popover from the view toolbar. First the SPHEREx all-sky
// map (off by default: the globe is just the stars), with its colours and strength once it is on;
// then what can be drawn with the stars: constellations, star names, the grid and the five
// challenge targets.

import { CheckIcon, Layers2Icon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Slider } from "@/components/ui/slider";
import type { GlobeView, SkyLayerToggles } from "@/components/globe/sky-globe";

const ROWS: { id: Exclude<keyof SkyLayerToggles, "spherex">; label: string; note: string }[] = [
  { id: "constellations", label: "Constellations", note: "Stick figures and names" },
  { id: "names", label: "Star names", note: "The brightest stars" },
  { id: "grid", label: "Grid", note: "Right ascension and declination" },
  { id: "markers", label: "Challenge targets", note: "The five, as small diamonds" },
];

function Check({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-4 shrink-0 place-items-center rounded-[4px] border transition-colors",
        on ? "border-fg/70 bg-white/[0.06] text-fg" : "border-hair-strong text-transparent",
      )}
    >
      <CheckIcon className="size-3" strokeWidth={2.25} />
    </span>
  );
}

export function LayersControl({
  layers,
  onLayersChange,
  view,
  onViewChange,
  imagery,
  onImageryChange,
  disabled = false,
}: {
  layers: SkyLayerToggles;
  onLayersChange: (next: SkyLayerToggles) => void;
  view: GlobeView;
  onViewChange: (v: GlobeView) => void;
  imagery: number;
  onImageryChange: (v: number) => void;
  disabled?: boolean;
}) {
  const percent = Math.round(imagery * 100);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className="inline-flex h-7 items-center gap-1.5 rounded-[4px] px-2 text-micro font-medium text-fg-dim transition-colors hover:bg-white/[0.06] hover:text-fg disabled:opacity-40 data-[state=open]:bg-white/[0.08] data-[state=open]:text-fg [&_svg]:size-3.5"
          data-testid="layers-button"
        >
          <Layers2Icon aria-hidden />
          Layers
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={10}
        collisionPadding={12}
        className="w-[18rem] gap-0 border border-hair bg-[#0c0c0b] p-0 shadow-[0_18px_44px_-16px_rgb(0_0_0/0.9)] ring-0"
        data-testid="layers-panel"
      >
        <section aria-labelledby="layers-map" className="flex flex-col gap-3 px-1.5 pt-1.5 pb-3">
          <h3 id="layers-map" className="sr-only">
            SPHEREx map
          </h3>
          {/* The switch covers the whole row (its ::after), so the row toggles anywhere; the
              explanation sits above it and outside the button, so controls are never nested. */}
          <div className="relative flex w-full items-center gap-3 rounded-[5px] px-2 py-2 transition-colors hover:bg-white/[0.04]">
            <span className="flex min-w-0 flex-1 flex-col">
              <span id="layer-spherex-label" className={cn("text-ui", layers.spherex ? "text-fg" : "text-fg-dim")}>
                SPHEREx infrared map
              </span>
              <span id="layer-spherex-note" className="text-micro text-pretty text-fg-faint">
                The whole sky in false colour, Data Release 1
              </span>
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={layers.spherex}
              aria-labelledby="layer-spherex-label"
              aria-describedby="layer-spherex-note"
              onClick={() => onLayersChange({ ...layers, spherex: !layers.spherex })}
              className="rounded-[4px] outline-none after:absolute after:inset-0 after:rounded-[5px] after:content-[''] focus-visible:after:outline-2 focus-visible:after:outline-offset-0 focus-visible:after:outline-accent focus-visible:after:outline-solid"
              data-testid="layer-spherex"
            >
              <Check on={layers.spherex} />
            </button>
          </div>
          {layers.spherex ? (
            <div className="flex flex-col gap-3 px-2">
              <div role="radiogroup" aria-label="Map colours" className="grid grid-cols-2 rounded-md border border-hair p-0.5">
                {(
                  [
                    { id: "colour", label: "False colour" },
                    { id: "mono", label: "1.25 µm" },
                  ] as const
                ).map((v) => (
                  <button
                    key={v.id}
                    type="button"
                    role="radio"
                    aria-checked={view === v.id}
                    onClick={() => onViewChange(v.id)}
                    className={cn(
                      "h-7 rounded-[4px] text-micro font-medium transition-colors",
                      view === v.id ? "bg-white/[0.08] text-fg" : "text-fg-dim hover:text-fg",
                    )}
                  >
                    {v.label}
                  </button>
                ))}
              </div>
              <div className="flex flex-col gap-2">
                <div className="flex items-baseline justify-between">
                  <span className="text-ui text-fg">Strength</span>
                  <span className="readout text-micro text-fg-dim">{percent}%</span>
                </div>
                <Slider
                  min={10}
                  max={100}
                  step={5}
                  value={[percent]}
                  onValueChange={([v]) => onImageryChange(v / 100)}
                  aria-label="SPHEREx map strength"
                  aria-valuetext={`${percent} percent`}
                />
              </div>
            </div>
          ) : null}
        </section>
        <section aria-labelledby="layers-over" className="border-t border-hair px-1.5 pt-2.5 pb-1.5">
          <h3 id="layers-over" className="px-2 pb-1 text-micro text-fg-faint">
            With the stars
          </h3>
          <ul>
            {ROWS.map((row) => {
              const on = layers[row.id];
              return (
                <li key={row.id}>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={on}
                    onClick={() => onLayersChange({ ...layers, [row.id]: !on })}
                    className="group flex w-full items-center gap-3 rounded-[5px] px-2 py-1.5 text-left transition-colors hover:bg-white/[0.04]"
                  >
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className={cn("text-ui transition-colors", on ? "text-fg" : "text-fg-dim")}>{row.label}</span>
                      <span className="text-micro text-fg-faint">{row.note}</span>
                    </span>
                    <Check on={on} />
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      </PopoverContent>
    </Popover>
  );
}
