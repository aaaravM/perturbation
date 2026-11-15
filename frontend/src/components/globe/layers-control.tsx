"use client";
// The globe's layer control: a small popover from the view toolbar. The SPHEREx map (false
// colour or one colour, and how strongly it shows), then what is drawn over it: catalogue stars,
// constellations, star names, the RA/Dec grid and the five featured objects.

import { CheckIcon, Layers2Icon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Slider } from "@/components/ui/slider";
import type { GlobeView, SkyLayerToggles } from "@/components/globe/sky-globe";

const ROWS: { id: keyof SkyLayerToggles; label: string; note: string }[] = [
  { id: "stars", label: "Stars", note: "Catalogue stars as white dots" },
  { id: "constellations", label: "Constellations", note: "Figures and names" },
  { id: "names", label: "Star names", note: "The brightest stars" },
  { id: "grid", label: "Grid", note: "Right ascension and declination" },
  { id: "markers", label: "Featured objects", note: "The five on the list" },
];

export function LayersControl({
  layers,
  onLayersChange,
  view,
  onViewChange,
  imagery,
  onImageryChange,
}: {
  layers: SkyLayerToggles;
  onLayersChange: (next: SkyLayerToggles) => void;
  view: GlobeView;
  onViewChange: (v: GlobeView) => void;
  imagery: number;
  onImageryChange: (v: number) => void;
}) {
  const percent = Math.round(imagery * 100);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex h-7 items-center gap-1.5 rounded-[4px] px-2 text-micro font-medium text-fg-dim transition-colors hover:bg-white/[0.06] hover:text-fg data-[state=open]:bg-white/[0.08] data-[state=open]:text-fg [&_svg]:size-3.5"
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
        className="w-[17.5rem] gap-0 border border-hair bg-[#0c0c0b] p-0 shadow-[0_18px_44px_-16px_rgb(0_0_0/0.9)] ring-0"
        data-testid="layers-panel"
      >
        <section aria-labelledby="layers-map" className="flex flex-col gap-3 px-3.5 pt-3.5 pb-3">
          <h3 id="layers-map" className="text-micro text-fg-faint">
            SPHEREx map
          </h3>
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
              <span id="imagery-label" className="text-ui text-fg">
                Imagery
              </span>
              <span className="readout text-micro text-fg-dim">{percent}%</span>
            </div>
            <Slider
              min={0}
              max={100}
              step={5}
              value={[percent]}
              onValueChange={([v]) => onImageryChange(v / 100)}
              aria-label="SPHEREx imagery opacity"
              aria-valuetext={`${percent} percent`}
            />
          </div>
        </section>
        <section aria-labelledby="layers-over" className="border-t border-hair px-1.5 pt-2.5 pb-1.5">
          <h3 id="layers-over" className="px-2 pb-1 text-micro text-fg-faint">
            On the globe
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
                      <span className={cn("text-ui transition-colors", on ? "text-fg" : "text-fg-dim")}>
                        {row.label}
                      </span>
                      <span className="text-micro text-fg-faint">{row.note}</span>
                    </span>
                    <span
                      aria-hidden
                      className={cn(
                        "grid size-4 shrink-0 place-items-center rounded-[4px] border transition-colors",
                        on ? "border-fg/70 bg-white/[0.06] text-fg" : "border-hair-strong text-transparent",
                      )}
                    >
                      <CheckIcon className="size-3" strokeWidth={2.25} />
                    </span>
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
