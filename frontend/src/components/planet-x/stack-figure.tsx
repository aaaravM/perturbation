"use client";
// Shift-and-stack on Pluto, from the prepared bundle. Bright case: the same exposures added up
// on the stars (Pluto smears into a row of dots) and on Pluto's motion (Pluto is one point, the
// stars become trails). Faint case: difference images, where the sky that did not change is
// subtracted, so a single exposure, a stack on the stars and a stack on Pluto's motion can be
// compared at the same contrast. Orange ticks sit just below where Pluto is, so they cover nothing.

import * as React from "react";
import { ArrowUpIcon } from "lucide-react";
import type { StackSet } from "@/lib/planet-x";
import { LiquidGlass } from "@/components/ui/liquid-glass";
import { FADE, RISE, delay } from "@/components/how-it-works/motion-classes";
import { Reveal } from "@/components/how-it-works/reveal";
import { cn } from "@/lib/utils";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const longDate = (iso: string) => {
  const d = new Date(`${iso}T00:00:00Z`);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};

/** A square window onto a stack image: [x0, y0, size] in image pixels. */
type Crop = [number, number, number];

interface PanelSpec {
  key: string;
  src: string;
  label: string;
  /** Where Pluto is, in image pixels. */
  marks: [number, number][];
  readout: React.ReactNode;
  note: string;
  alt: string;
}

export function StackFigure({ bright, faint }: { bright: StackSet; faint: StackSet }) {
  const full: Crop = [0, 0, bright.gridPx];
  // The faint stacks are shown around their middle, where all of Pluto's positions lie.
  const fx = Math.max(0, Math.floor(Math.min(...faint.dots.map((d) => d.px[0])) - 1));
  const fs = faint.gridPx - 2 * fx;
  const faintCrop: Crop = [fx, fx, fs];

  const brightPanels: PanelSpec[] = [
    {
      key: "bright-stars",
      src: bright.starsUrl,
      label: "On the stars",
      marks: bright.dots.map((d) => d.px),
      readout: null,
      note: `Pluto smears into a row of ${bright.dots.length} dots, one per observation`,
      alt: `${bright.n} SPHEREx exposures added up with the stars lined up: the stars are sharp points, and Pluto is a faint row of ${bright.dots.length} dots along its path.`,
    },
    {
      key: "bright-pluto",
      src: bright.plutoUrl,
      label: "On Pluto’s motion",
      marks: [bright.plutoPx],
      readout: null,
      note: "Pluto is one sharp point; the stars become dotted trails",
      alt: `The same ${bright.n} exposures shifted to follow Pluto: Pluto is one sharp point in the middle and every star is drawn out into a dotted trail.`,
    },
  ];

  const sigma = faint.diff.sigma;
  const dotSnr = faint.dots.map((d) => d.snr);
  const faintPanels: PanelSpec[] = [
    {
      key: "faint-single",
      src: faint.diff.single,
      label: "One exposure",
      marks: [faint.plutoPx],
      readout: <>S/N {(faint.singleSnr ?? faint.snrSingleMedian).toFixed(1)}</>,
      note: "Pluto barely stands out from the noise",
      alt: "One SPHEREx exposure at 4.4 to 4.9 micrometres with the unchanging sky subtracted: at Pluto's position there is only a faint, uncertain spot in the noise.",
    },
    {
      key: "faint-stars",
      src: faint.diff.stars,
      label: "On the stars",
      marks: faint.dots.map((d) => d.px),
      readout: (
        <>
          S/N {fmtSigned(Math.min(...dotSnr))} to {fmtSigned(Math.max(...dotSnr))}
        </>
      ),
      note: `Spread over ${faint.dots.length} spots, Pluto disappears`,
      alt: `${faint.n} exposures stacked on the stars, with the unchanging sky subtracted: noise only. Pluto's light is spread over ${faint.dots.length} positions and none of them stands out.`,
    },
    {
      key: "faint-pluto",
      src: faint.diff.pluto,
      label: "On Pluto’s motion",
      marks: [faint.plutoPx],
      readout: <>S/N {faint.snrStack.toFixed(1)}</>,
      note: "Pluto’s light piles up in one place",
      alt: `The same ${faint.n} exposures stacked along Pluto's motion: a clear spot in the middle, Pluto, at ${faint.snrStack.toFixed(1)} times the noise.`,
    },
  ];

  return (
    <div className="flex flex-col gap-12" data-testid="stack-figure">
      <Reveal as="figure" className="max-w-[44rem]">
        <div className="grid grid-cols-2 gap-3 sm:gap-4">
          {brightPanels.map((p, i) => (
            <Panel key={p.key} spec={p} grid={bright.gridPx} pixelArcsec={bright.pixelArcsec} crop={full} i={i} />
          ))}
        </div>
        <figcaption className="mt-4 flex max-w-2xl flex-col gap-1 text-meta text-pretty text-fg-dim">
          <span>
            Bright: {bright.n} exposures from {bright.observations} observations over {bright.spanDays.toFixed(1)} days, {longDate(bright.first)} to{" "}
            {longDate(bright.last)}, detector D{bright.detector} at {bright.um[0].toFixed(2)}–{bright.um[1].toFixed(2)} µm. Pluto moved{" "}
            {Math.round(bright.trailArcsec)}″ in that time. Each panel is {((bright.gridPx * bright.pixelArcsec) / 60).toFixed(1)} arcminutes
            across, north up; the orange ticks sit just below Pluto.
          </span>
        </figcaption>
      </Reveal>

      <Reveal as="figure" className="max-w-[44rem]">
        <div className="grid grid-cols-3 gap-2 sm:gap-4">
          {faintPanels.map((p, i) => (
            <Panel key={p.key} spec={p} grid={faint.gridPx} pixelArcsec={faint.pixelArcsec} crop={faintCrop} i={i} compact />
          ))}
        </div>
        <figcaption className="mt-4 flex max-w-2xl flex-col gap-1 text-meta text-pretty text-fg-dim">
          <span>
            Faint: {faint.n} exposures from {faint.observations} observations over {faint.spanDays.toFixed(1)} days, {longDate(faint.first)} to{" "}
            {longDate(faint.last)}, detector D{faint.detector} at {faint.um[0].toFixed(2)}–{faint.um[1].toFixed(2)} µm. The sky that did not change is subtracted, so grey is zero; each image runs from −{sigma}σ (black) to +{sigma}σ
            (white). Shown: the central {((fs * faint.pixelArcsec) / 60).toFixed(1)} arcminutes, with the orange ticks below Pluto’s
            positions; hatched pixels have no usable data.
          </span>
          <span className="text-fg-faint">Source: SPHEREx Data Release 1 images; the Pluto bundle built for this page.</span>
        </figcaption>
      </Reveal>
    </div>
  );
}

/** Behind the difference images: hatching, so a pixel with no usable data cannot pass for a dark one. */
const NO_DATA = "bg-[repeating-linear-gradient(135deg,#4a2a1c_0_2px,#1a100b_2px_5px)]";

const fmtSigned = (v: number) => (v < 0 ? `−${Math.abs(v).toFixed(1)}` : v.toFixed(1));

function Panel({
  spec,
  grid,
  pixelArcsec,
  crop,
  i,
  compact,
}: {
  spec: PanelSpec;
  grid: number;
  pixelArcsec: number;
  crop: Crop;
  i: number;
  compact?: boolean;
}) {
  const [x0, y0, size] = crop;
  const pct = (v: number) => `${(v / size) * 100}%`;
  return (
    <div className={cn("flex min-w-0 flex-col", RISE)} style={delay(i, 120)} data-testid={spec.key}>
      <div
        role="img"
        aria-label={spec.alt}
        className={cn("relative aspect-square overflow-hidden rounded-[14px] border border-hair", compact ? NO_DATA : "bg-black")}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={spec.src}
          alt=""
          draggable={false}
          className="absolute max-w-none select-none [image-rendering:pixelated]"
          style={{ left: pct(-x0), top: pct(-y0), width: pct(grid), height: pct(grid) }}
        />
        {spec.marks.map(([x, y], k) => (
          <span
            key={k}
            aria-hidden
            data-mark
            className={cn("pointer-events-none absolute h-[1.5px] -translate-x-1/2 rounded-full bg-accent", FADE)}
            style={{ left: pct(x + 0.5 - x0), top: pct(y + 0.5 + 2.6 - y0), width: pct(1.8), ...delay(k, 40, 400) }}
          />
        ))}
        {!compact && (
          <LiquidGlass variant="thin" radius={10} className="absolute top-2 left-2 px-2.5 py-1 text-meta whitespace-nowrap text-fg">
            {spec.label}
          </LiquidGlass>
        )}
        {!compact && (
          <span className="absolute top-2.5 right-2.5 flex flex-col items-center text-micro text-fg/80" aria-hidden>
            <ArrowUpIcon className="size-3.5" />N
          </span>
        )}
        {!compact && (
          <span
            className="absolute bottom-2.5 left-2.5 flex flex-col gap-1 text-micro text-fg/80"
            aria-hidden
            style={{ width: pct(60 / pixelArcsec) }}
          >
            <span className="readout whitespace-nowrap">1′</span>
            <span className="h-0.5 w-full rounded-full bg-fg/80" />
          </span>
        )}
      </div>
      {compact && <p className="mt-2.5 text-ui text-fg">{spec.label}</p>}
      {spec.readout && <p className="readout text-micro text-fg sm:text-meta">{spec.readout}</p>}
      <p className={cn("text-meta text-pretty text-fg-dim", !compact && "mt-3")}>{spec.note}</p>
    </div>
  );
}
