"use client";
// SPHEREx wavelength picker. 102 cube frames = 6 detectors x 17 channels. Frames 0, 50 and 51
// cannot be shown (see src/lib/spherex.ts), so the slider snaps past them. Labels come from
// IRSA's spectral_channels.ecsv (FRAME, DETECTOR, SUBCHAN, WAVELENGTH, ...).

import { useEffect, useRef, useState } from "react";
import NumberFlow from "@number-flow/react";
import { InfoIcon } from "lucide-react";
import { Slider as SliderPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  BLANK_FRAMES,
  CHANNELS_PER_DETECTOR,
  DEPTH,
  DETECTORS,
  FIRST_FRAME,
  LAST_FRAME,
  UNLOADABLE_FRAMES,
  frameToDetector,
  isFrameAvailable,
  snapFrame,
  type SpectralChannel,
} from "@/lib/spherex";

const FRAMES = Array.from({ length: DEPTH }, (_, f) => f);

function wavelengthOf(channels: SpectralChannel[] | null, frame: number) {
  return channels?.find((c) => c.frame === frame)?.wavelength;
}

export function WavelengthSlider({
  frame,
  onFrameChange,
  channels,
  className,
}: {
  frame: number;
  onFrameChange: (frame: number) => void;
  /** null while loading; [] if the label table could not be fetched. */
  channels: SpectralChannel[] | null;
  className?: string;
}) {
  const channel = channels?.find((c) => c.frame === frame);
  const { detector, channel: subchannel } = channel ?? frameToDetector(frame);
  const wavelength = channel?.wavelength;
  const [skipped, setSkipped] = useState<number[] | null>(null);
  const skipTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(skipTimer.current), []);

  const handleChange = (requested: number) => {
    const next = snapFrame(requested, frame);
    if (next !== requested) {
      const gap = FRAMES.filter(
        (f) => !isFrameAvailable(f) && f >= Math.min(requested, next) && f <= Math.max(requested, next),
      );
      setSkipped(gap.length ? gap : [requested]);
      window.clearTimeout(skipTimer.current);
      skipTimer.current = window.setTimeout(() => setSkipped(null), 2600);
    }
    if (next !== frame) onFrameChange(next);
  };

  const wlText = wavelength !== undefined ? `${wavelength.toFixed(3)} micrometres` : "";
  const blankList = [...BLANK_FRAMES].map((f) => wavelengthOf(channels, f)?.toFixed(3) ?? "?");
  const frame0 = wavelengthOf(channels, 0)?.toFixed(3) ?? "0.753";
  const minWl = wavelengthOf(channels, 1);
  const maxWl = wavelengthOf(channels, LAST_FRAME);

  return (
    <div className={cn("flex flex-col gap-3", className)} data-testid="wavelength-control">
      <div className="flex items-end justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-micro text-fg-dim">Wavelength</span>
          <span className="flex items-baseline gap-2">
            <span
              className="readout text-heading leading-none font-normal text-fg"
              data-testid="wavelength-readout"
            >
              {wavelength !== undefined ? (
                <NumberFlow
                  value={wavelength}
                  format={{ minimumFractionDigits: 3, maximumFractionDigits: 3 }}
                  respectMotionPreference
                  transformTiming={{ duration: 450, easing: "cubic-bezier(0.16, 1, 0.3, 1)" }}
                  spinTiming={{ duration: 450, easing: "cubic-bezier(0.16, 1, 0.3, 1)" }}
                />
              ) : (
                <span className="text-fg-faint">{channels === null ? "…" : "n/a"}</span>
              )}
            </span>
            <span className="text-ui text-fg-dim">µm</span>
          </span>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-0.5 text-right">
          <span className="text-micro text-fg-dim">
            Detector {detector}, channel {subchannel}
          </span>
          <span className="readout text-micro text-fg-faint">
            Frame {frame} of {LAST_FRAME}
          </span>
        </div>
      </div>

      <div className="relative">
        {/* One cell per frame, grouped by detector. Unavailable frames are hatched. */}
        <div aria-hidden className="pointer-events-none absolute inset-x-0 top-1/2 flex h-3 -translate-y-1/2 gap-px">
          {FRAMES.map((f) => {
            const unavailable = !isFrameAvailable(f);
            const d = frameToDetector(f).detector;
            return (
              <span
                key={f}
                className={cn(
                  "flex-1 rounded-[1px] transition-colors duration-300",
                  unavailable
                    ? "bg-[repeating-linear-gradient(135deg,var(--fg-faint)_0_1px,transparent_1px_3px)] opacity-60"
                    : f === frame
                      ? "bg-accent"
                      : d === detector
                        ? "bg-fg/30"
                        : d % 2
                          ? "bg-fg/12"
                          : "bg-fg/18",
                )}
              />
            );
          })}
        </div>
        <SliderPrimitive.Root
          min={FIRST_FRAME}
          max={LAST_FRAME}
          step={1}
          value={[frame]}
          onValueChange={([value]) => handleChange(value)}
          className="relative flex h-8 w-full touch-none items-center select-none"
          data-testid="wavelength-slider"
        >
          <SliderPrimitive.Track className="relative h-8 grow bg-transparent">
            <SliderPrimitive.Range className="absolute h-full bg-transparent" />
          </SliderPrimitive.Track>
          <SliderPrimitive.Thumb
            aria-label="SPHEREx wavelength"
            aria-valuetext={`Frame ${frame}${wlText ? `, ${wlText}` : ""}, detector ${detector}, channel ${subchannel}`}
            className="block h-6 w-[11px] rounded-[3px] border-[1.5px] border-fg bg-transparent shadow-[0_0_0_1px_rgb(5_5_5/0.7)] transition-[border-color,box-shadow,transform] duration-200 outline-none hover:scale-y-110 focus-visible:border-accent focus-visible:shadow-[0_0_0_1px_rgb(5_5_5/0.7),0_0_0_4px_var(--accent-faint)] active:scale-y-110"
          />
        </SliderPrimitive.Root>
      </div>

      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1" aria-hidden>
          {Array.from({ length: DETECTORS }, (_, d) => (
            <span
              key={d}
              className={cn(
                "flex-1 text-micro text-fg-faint transition-colors duration-300",
                d + 1 === detector && "text-fg-dim",
              )}
              style={{ flexGrow: CHANNELS_PER_DETECTOR }}
            >
              D{d + 1}
            </span>
          ))}
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="-m-1 flex shrink-0 items-center gap-1 rounded-sm p-1 text-micro text-fg-faint transition-colors hover:text-fg-dim"
              aria-label="Why some wavelengths are unavailable"
            >
              <InfoIcon className="size-3.5" aria-hidden />
              <span className="hidden sm:inline">Gaps</span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" align="end" className="max-w-72 text-left leading-snug">
            Three of the 102 frames are skipped. Frames {[...BLANK_FRAMES].join(" and ")} (
            {blankList.join(" and ")} µm, where detector 3 hands over to detector 4) are blank in
            DR1. Frame {[...UNLOADABLE_FRAMES][0]} ({frame0} µm) cannot be opened by this version
            of the sky viewer.
          </TooltipContent>
        </Tooltip>
      </div>

      <p className="readout -mt-1 flex justify-between text-micro text-fg-faint">
        <span aria-hidden>{minWl !== undefined ? `${minWl.toFixed(2)} µm` : ""}</span>
        <span
          className={cn(
            "font-sans text-fg-dim transition-opacity duration-300",
            skipped ? "opacity-100" : "opacity-0",
          )}
          role="status"
        >
          {skipped ? `Skipped frame${skipped.length > 1 ? "s" : ""} ${skipped.join(", ")}: no data` : ""}
        </span>
        <span aria-hidden>{maxWl !== undefined ? `${maxWl.toFixed(2)} µm` : ""}</span>
      </p>
    </div>
  );
}
