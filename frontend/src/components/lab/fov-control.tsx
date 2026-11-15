"use client";
// Field of view: zoom in and out in fixed steps. Blink frames exist for fields up to 30 arcmin;
// wider views show the SPHEREx all-sky cube only, and the readout says so.

import { MinusIcon, PlusIcon } from "lucide-react";
import { formatFov } from "@/lib/lab-coords";
import { BLINK_FOV_MAX_DEG, FOV_STEPS_DEG, nextFovStep } from "@/lib/lab-state";
import { cn } from "@/lib/utils";

export function FovControl({ fov, onChange }: { fov: number; onChange: (fov: number) => void }) {
  const wide = fov > BLINK_FOV_MAX_DEG + 1e-6;
  const atMin = fov <= FOV_STEPS_DEG[0] + 1e-6;
  const atMax = fov >= FOV_STEPS_DEG[FOV_STEPS_DEG.length - 1] - 1e-6;
  return (
    <div className="flex items-center gap-1.5" data-testid="fov-control">
      <span className="text-micro text-fg-dim">Field</span>
      <button
        type="button"
        onClick={() => onChange(nextFovStep(fov, -1))}
        disabled={atMin}
        aria-label="Zoom in (smaller field)"
        className="grid size-6 place-items-center rounded-sm text-fg-dim transition-colors hover:bg-ink-3 hover:text-fg disabled:opacity-35"
      >
        <MinusIcon className="size-3.5" aria-hidden />
      </button>
      <output aria-live="polite" className="readout min-w-[3.25rem] text-center text-meta text-fg" data-testid="fov-readout">
        {formatFov(fov)}
      </output>
      <button
        type="button"
        onClick={() => onChange(nextFovStep(fov, 1))}
        disabled={atMax}
        aria-label="Zoom out (larger field)"
        className="grid size-6 place-items-center rounded-sm text-fg-dim transition-colors hover:bg-ink-3 hover:text-fg disabled:opacity-35"
      >
        <PlusIcon className="size-3.5" aria-hidden />
      </button>
      <span className={cn("ml-1 text-micro text-fg-faint transition-opacity", wide ? "opacity-100" : "opacity-0")}>
        {wide ? "All-sky map only" : ""}
      </span>
    </div>
  );
}
