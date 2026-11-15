"use client";
// Live readouts under the viewer: the pointer's RA/Dec (sexagesimal and decimal) and galactic
// l, b; the display level and flags of the frame on screen under the pointer; the frame's
// wavelength range, the field of view and the epoch on screen.

import type { ReactNode } from "react";
import { formatDecDms, formatDeg, formatFov, formatRaHms } from "@/lib/lab-coords";
import { pngPixelAt, toGalactic, type TanGrid } from "@/lib/lab-wcs";
import { levelAt } from "@/components/lab/display";
import { useCursor, type CursorStore } from "@/components/lab/cursor-store";
import { Term } from "@/components/ui/term";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : null;
}

/** Which flag colours of the legend are set at a pixel of the flags overlay. */
function flagsAt(img: ImageData, col: number, row: number, legend: Record<string, string>): string[] {
  const i = (row * img.width + col) * 4;
  if (img.data[i + 3] < 24) return [];
  const px = [img.data[i], img.data[i + 1], img.data[i + 2]];
  const hits = Object.entries(legend)
    .map(([name, hex]) => ({ name, rgb: hexToRgb(hex) }))
    .filter((e): e is { name: string; rgb: [number, number, number] } => e.rgb !== null)
    .map((e) => ({ name: e.name, d: Math.hypot(px[0] - e.rgb[0], px[1] - e.rgb[1], px[2] - e.rgb[2]) }))
    .sort((a, b) => a.d - b.d);
  return hits.length && hits[0].d < 60 ? [hits[0].name] : ["flagged"];
}

export function StatusBar({
  cursor,
  grid,
  frameRaw,
  flags,
  frameLabel,
  wavelength,
  fov,
  measurement,
}: {
  cursor: CursorStore;
  grid: TanGrid | null;
  frameRaw: ImageData | null;
  flags: { image: ImageData; legend: Record<string, string> } | null;
  frameLabel: string | null;
  wavelength: string | null;
  fov: number;
  measurement: ReactNode;
}) {
  const c = useCursor(cursor);
  const gal = c ? toGalactic(c.ra, c.dec) : null;
  const px = c && grid ? pngPixelAt(grid, c.ra, c.dec) : null;
  const level = px && frameRaw ? levelAt(frameRaw, px.col, px.row) : null;
  const flagged = px && flags ? flagsAt(flags.image, px.col, px.row, flags.legend) : null;

  // Wrapped rows sit 8px apart so the explained labels keep a 24px touch circle each (WCAG 2.5.8).
  return (
    <div
      className="flex min-h-8 shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-t border-hair bg-ink-2 px-3 py-1 text-micro"
      data-testid="status-bar"
      aria-label="Readouts"
    >
      <Cell label={<Term k="rightAscension" mark={false}>RA</Term>} wide testId="readout-ra">
        {c ? (
          <>
            {formatRaHms(c.ra, 2)} <span className="text-fg-faint">{formatDeg(c.ra, 5)}</span>
          </>
        ) : (
          "–"
        )}
      </Cell>
      <Cell label={<Term k="declination" mark={false}>Dec</Term>} wide testId="readout-dec">
        {c ? (
          <>
            {formatDecDms(c.dec, 1)} <span className="text-fg-faint">{formatDeg(c.dec, 5, true)}</span>
          </>
        ) : (
          "–"
        )}
      </Cell>
      <Cell label={<Term k="galactic" mark={false}>l, b</Term>} testId="readout-galactic">
        {gal ? `${gal.l.toFixed(3)}°, ${gal.b >= 0 ? "+" : "−"}${Math.abs(gal.b).toFixed(3)}°` : "–"}
      </Cell>
      <Tooltip>
        <TooltipTrigger asChild>
          <span tabIndex={0} className="rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-accent">
            <Cell label="Level" testId="readout-level">
              {level !== null ? `${level}/255` : "–"}
            </Cell>
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-72 text-left">
          The brightness of the frame on screen under the pointer, as a display level from 0 to 255 (one shared
          stretch per detector). Calibrated values in MJy/sr live in the SPHEREx FITS images at IRSA.
        </TooltipContent>
      </Tooltip>
      <Cell label="Flags" testId="readout-flags">
        <span className={cn(flagged && flagged.length > 0 && "text-accent")}>
          {!flags ? (grid ? "n/a" : "–") : !px ? "–" : flagged && flagged.length ? flagged.join(", ") : "none"}
        </span>
      </Cell>
      <span aria-hidden className="hidden h-3 w-px bg-hair lg:block" />
      <Cell label="λ" testId="readout-wavelength">
        {wavelength ?? "–"}
      </Cell>
      <Cell label="FoV" testId="readout-fov">
        {formatFov(fov)}
      </Cell>
      <Cell label={<Term k="epoch" mark={false}>Epoch</Term>} testId="readout-epoch">
        {frameLabel ?? "–"}
      </Cell>
      {measurement && <div className="ml-auto flex items-center gap-3 text-fg" data-testid="readout-measurement">{measurement}</div>}
    </div>
  );
}

function Cell({ label, children, wide, testId }: { label: ReactNode; children: ReactNode; wide?: boolean; testId?: string }) {
  return (
    <span className={cn("inline-flex min-w-0 items-baseline gap-1.5 whitespace-nowrap", wide && "min-w-[11.75rem]")} data-testid={testId}>
      <span className="text-fg-faint">{label}</span>
      <span className="readout text-fg">{children}</span>
    </span>
  );
}
