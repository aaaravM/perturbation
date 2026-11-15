"use client";
// Bottom bar when no blink field is loaded: the SPHEREx all-sky cube at any of its wavelengths,
// the AllWISE W2 comparison layer, and a nudge towards the featured targets in view.

import { Label } from "radix-ui";
import type { SpectralChannel } from "@/lib/spherex";
import type { FeaturedTarget } from "@/lib/targets";
import { cn } from "@/lib/utils";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { WavelengthSlider } from "@/components/sky/wavelength-slider";

export function ContextBar({
  frame,
  onFrame,
  channels,
  wise,
  wiseOpacity,
  onWise,
  onWiseOpacity,
  inView,
  onWatchTarget,
}: {
  frame: number;
  onFrame: (frame: number) => void;
  channels: SpectralChannel[] | null;
  wise: boolean;
  wiseOpacity: number;
  onWise: (on: boolean) => void;
  onWiseOpacity: (v: number) => void;
  inView: FeaturedTarget[];
  onWatchTarget: (slug: string) => void;
}) {
  return (
    <section aria-label="All-sky map" className="panel flex flex-col gap-3 px-4 pt-3 pb-3.5" data-testid="context-bar">
      {inView.length > 0 && (
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-hair pb-2.5">
          <p className="text-meta text-fg-dim">
            {inView.length === 1 ? `${inView[0].name} is in view.` : "Featured targets in view."} Prepared SPHEREx
            frames show how {inView.length === 1 ? "it" : "they"} moved or changed.
          </p>
          <div className="flex gap-3">
            {inView.map((t) => (
              <button
                key={t.slug}
                type="button"
                onClick={() => onWatchTarget(t.slug)}
                className="text-meta text-fg underline decoration-hair-strong underline-offset-4 transition-colors hover:decoration-accent"
              >
                Watch {t.name}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:gap-6">
        <WavelengthSlider frame={frame} onFrameChange={onFrame} channels={channels} className="min-w-0 flex-1" />
        <div className="hidden w-56 shrink-0 flex-col gap-3 border-l border-hair pl-5 md:flex">
          <WiseControls idSuffix="desktop" enabled={wise} opacity={wiseOpacity} onEnabled={onWise} onOpacity={onWiseOpacity} />
        </div>
        <div className="flex flex-col gap-3 border-t border-hair pt-3 md:hidden">
          <WiseControls idSuffix="mobile" enabled={wise} opacity={wiseOpacity} onEnabled={onWise} onOpacity={onWiseOpacity} />
        </div>
      </div>
    </section>
  );
}

export function WiseControls({
  enabled,
  opacity,
  onEnabled,
  onOpacity,
  idSuffix,
}: {
  enabled: boolean;
  opacity: number;
  onEnabled: (value: boolean) => void;
  onOpacity: (value: number) => void;
  idSuffix: string;
}) {
  const id = `allwise-toggle-${idSuffix}`;
  return (
    <>
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col">
          <Label.Root htmlFor={id} className="cursor-pointer text-ui text-fg">
            Compare with AllWISE
          </Label.Root>
          <span className="text-micro text-fg-faint">
            W2 band, <span className="readout">4.6</span> µm, 2010
          </span>
        </div>
        <Switch id={id} checked={enabled} onCheckedChange={onEnabled} data-testid={id} />
      </div>
      <div className={cn("flex items-center gap-3 transition-opacity duration-300", !enabled && "opacity-40")}>
        <span className="w-14 text-micro text-fg-dim">Opacity</span>
        <Slider
          min={0}
          max={1}
          step={0.05}
          value={[opacity]}
          disabled={!enabled}
          onValueChange={([value]) => onOpacity(value)}
          aria-label="AllWISE overlay opacity"
          className="flex-1"
        />
        <span className="readout w-9 text-right text-micro text-fg-dim">{Math.round(opacity * 100)}%</span>
      </div>
    </>
  );
}
