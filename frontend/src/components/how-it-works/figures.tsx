"use client";
// The measured-data diagrams of the How it works page, drawn as inline SVG at the figure's real
// width (so labels keep their size on a phone) and animated in once with transform and opacity.

import * as React from "react";
import type { SpectrumData, TimelineEpoch, TrackPoint } from "@/lib/how-it-works";
import { cn } from "@/lib/utils";
import { FADE, GROW_X, GROW_Y, RISE, delay } from "./motion-classes";
import { Reveal, useWidth } from "./reveal";

/* ------------------------------------------------------------------ */
/* Header: one object in SPHEREx's 102 colours                         */
/* ------------------------------------------------------------------ */

export function SpectrumBarcode({ wl, mjy }: { wl: number[]; mjy: (number | null)[] }) {
  const max = Math.max(...mjy.map((v) => v ?? 0));
  if (!(max > 0)) return null;
  return (
    <Reveal
      role="img"
      aria-label={`Epsilon Indi B measured in SPHEREx's 102 colours, from ${wl[0].toFixed(2)} to ${wl.at(-1)!.toFixed(2)} micrometres: six detectors of 17 channels each. Its brightness rises and falls, with deep dips where water and methane absorb.`}
      className="flex flex-col gap-2"
    >
      <div className="flex h-20 items-end gap-px sm:h-28 sm:gap-[3px]">
        {mjy.map((v, i) => (
          <span
            key={i}
            className={cn(
              "min-w-0 flex-1 rounded-t-[1.5px]",
              v === null ? "bg-hair-strong" : "bg-fg/55",
              GROW_Y,
            )}
            style={{ height: v === null ? "2px" : `${Math.max(2, (Math.max(0, v) / max) * 100)}%`, ...delay(i, 7, 80) }}
          />
        ))}
      </div>
      <div className="flex gap-px sm:gap-[3px]">
        {["D1", "D2", "D3", "D4", "D5", "D6"].map((d, i) => (
          <span
            key={d}
            className={cn("min-w-0 flex-[17] border-t border-hair-strong pt-1.5 text-micro text-fg-faint", FADE)}
            style={delay(i, 90, 500)}
          >
            {d}
          </span>
        ))}
      </div>
    </Reveal>
  );
}

/* ------------------------------------------------------------------ */
/* 1. The six detectors on a wavelength axis                           */
/* ------------------------------------------------------------------ */

const AXIS_UM: [number, number] = [0.35, 5.1];
const pctUm = (um: number) => ((um - AXIS_UM[0]) / (AXIS_UM[1] - AXIS_UM[0])) * 100;
const fmtUm = (um: number) => um.toFixed(2);

export function DetectorDiagram({
  detectors,
}: {
  detectors: readonly { key: string; lo: number; hi: number }[];
}) {
  return (
    <Reveal
      role="img"
      aria-label="SPHEREx's six detectors span 0.75 to 5.0 micrometres, all beyond the 0.4 to 0.7 micrometres the eye sees. Each detector records 17 strips of colour."
      className="grid grid-cols-[5rem_minmax(0,1fr)] items-center gap-x-4 gap-y-2.5 sm:grid-cols-[6.5rem_minmax(0,1fr)]"
    >
      <RowLabel name="Your eyes" range="0.40–0.70" />
      <div className="relative h-7">
        <span aria-hidden className="absolute inset-x-0 top-1/2 h-px bg-hair" />
        <span
          className={cn("absolute inset-y-1 rounded-[3px] opacity-80", GROW_X)}
          style={{
            left: `${pctUm(0.4)}%`,
            width: `${pctUm(0.7) - pctUm(0.4)}%`,
            background: "linear-gradient(90deg,#6c5ba3,#4f78b4,#4f9a78,#bfae55,#c77b4e,#a9504c)",
          }}
        />
      </div>
      {detectors.map((d, i) => (
        <React.Fragment key={d.key}>
          <RowLabel name={d.key} range={`${fmtUm(d.lo)}–${fmtUm(d.hi)}`} accent={d.key === "D6"} />
          <div className="relative h-7">
            <span aria-hidden className="absolute inset-x-0 top-1/2 h-px bg-hair" />
            <svg
              aria-hidden
              viewBox="0 0 17 1"
              preserveAspectRatio="none"
              className={cn("absolute inset-y-1 h-5", GROW_X, d.key === "D6" ? "text-accent" : "text-fg/60")}
              style={{ left: `${pctUm(d.lo)}%`, width: `${pctUm(d.hi) - pctUm(d.lo)}%`, ...delay(i, 80, 120) }}
            >
              {Array.from({ length: 17 }, (_, c) => (
                <rect key={c} x={c + 0.1} y={0} width={0.8} height={1} fill="currentColor" opacity={0.55 + 0.45 * (c / 16)} />
              ))}
            </svg>
          </div>
        </React.Fragment>
      ))}
      <span className="self-start pt-2.5 text-right text-micro text-fg-faint">µm</span>
      <div className={cn("relative h-8 border-t border-hair-strong", FADE)} style={delay(0, 0, 500)}>
        {[0.5, 1, 2, 3, 4, 5].map((um) => (
          <span key={um} className="absolute top-0 -translate-x-1/2 text-center" style={{ left: `${pctUm(um)}%` }}>
            <span aria-hidden className="mx-auto block h-1.5 w-px bg-hair-strong" />
            <span className="readout block pt-1 text-micro text-fg-faint">{um}</span>
          </span>
        ))}
      </div>
    </Reveal>
  );
}

function RowLabel({ name, range, accent }: { name: string; range: string; accent?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col leading-tight">
      <span className={cn("text-ui", accent ? "text-accent" : "text-fg")}>{name}</span>
      <span className="readout truncate text-micro text-fg-faint">{range} µm</span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Shared time axis (visits of Barnard's Star)                         */
/* ------------------------------------------------------------------ */

const DAY = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function timeDomain(epochs: TimelineEpoch[]): [number, number] {
  const t0 = Math.min(...epochs.map((e) => Date.parse(e.start)));
  const t1 = Math.max(...epochs.map((e) => Date.parse(e.end)));
  return [t0 - 16 * DAY, t1 + 22 * DAY];
}

function monthTicks([t0, t1]: [number, number]) {
  const out: { t: number; label: string | null }[] = [];
  const d = new Date(t0);
  let y = d.getUTCFullYear();
  let m = d.getUTCMonth() + 1;
  for (;;) {
    if (m > 11) {
      m = 0;
      y += 1;
    }
    const t = Date.UTC(y, m, 1);
    if (t > t1) break;
    out.push({ t, label: m % 4 === 0 ? `${MONTHS[m]} ${y}` : null });
    m += 1;
  }
  return out;
}

function TimeAxis({ x, ticks, y }: { x: (t: number) => number; ticks: ReturnType<typeof monthTicks>; y: number }) {
  return (
    <g>
      <line x1={x(ticks[0]?.t ?? 0) - 12} x2={x(ticks.at(-1)?.t ?? 0) + 12} y1={y} y2={y} className="stroke-hair-strong" />
      {ticks.map((tk) => (
        <g key={tk.t}>
          <line x1={x(tk.t)} x2={x(tk.t)} y1={y} y2={y + (tk.label ? 6 : 3)} className="stroke-hair-strong" />
          {tk.label && (
            <text x={x(tk.t)} y={y + 19} textAnchor="middle" className="readout fill-fg-faint text-[11px]">
              {tk.label}
            </text>
          )}
        </g>
      ))}
    </g>
  );
}

/* ------------------------------------------------------------------ */
/* 2. Visits of Barnard's Star                                         */
/* ------------------------------------------------------------------ */

/** Year 1 (DR1) ends and Year 2 (QR3) begins on 14 May 2026 (data-findings §5.1). */
const YEAR_SPLIT = Date.UTC(2026, 4, 14);

export function EpochTimeline({ epochs }: { epochs: TimelineEpoch[] }) {
  const [ref, w] = useWidth<HTMLDivElement>(680);
  if (!epochs.length) return null;
  const H = 176;
  const top = 58;
  const base = H - 30;
  const dom = timeDomain(epochs);
  const pad = 14;
  const x = (t: number) => pad + ((t - dom[0]) / (dom[1] - dom[0])) * (w - 2 * pad);
  const maxN = Math.max(...epochs.map((e) => e.exposures));
  const ticks = monthTicks(dom);
  const split = x(YEAR_SPLIT);

  return (
    <div ref={ref}>
      <Reveal>
        <svg
          width="100%"
          height={H}
          viewBox={`0 0 ${w} ${H}`}
          role="img"
          aria-label={`Barnard's Star was observed in ${epochs.length} visits between ${epochs[0].label} and ${epochs.at(-1)!.label}; ${epochs.filter((e) => e.full).length} of them are full visits with dozens of exposures.`}
        >
          <g className={FADE} style={delay(0, 0, 200)}>
            <line x1={split} x2={split} y1={8} y2={base} strokeDasharray="2 4" className="stroke-hair-strong" />
            <text x={split - 8} y={18} textAnchor="end" className="fill-fg-faint text-[11px]">
              Year 1 · DR1
            </text>
            <text x={split + 8} y={18} className="fill-fg-faint text-[11px]">
              Year 2 · QR3
            </text>
          </g>
          {epochs.map((e, i) => {
            const x0 = x(Date.parse(e.start));
            const x1 = x(Date.parse(e.end) + DAY);
            const bw = Math.max(4, x1 - x0);
            const cx = (x0 + x1) / 2;
            const h = Math.max(3, (e.exposures / maxN) * (base - top));
            const lx = Math.min(Math.max(cx, 44), w - 44);
            return (
              <g key={e.index}>
                <rect
                  x={cx - bw / 2}
                  y={base - h}
                  width={bw}
                  height={h}
                  rx={1.5}
                  className={cn(GROW_Y, e.full ? "fill-accent" : "fill-fg-faint")}
                  style={delay(i, 90, 150)}
                />
                {e.full && (
                  <g className={FADE} style={delay(i, 90, 450)}>
                    <text x={lx} y={top - 22} textAnchor="middle" className="fill-fg text-[12px]">
                      {e.label}
                    </text>
                    <text x={lx} y={top - 8} textAnchor="middle" className="readout fill-fg-faint text-[11px]">
                      {e.exposures} exposures
                    </text>
                  </g>
                )}
              </g>
            );
          })}
          <TimeAxis x={x} ticks={ticks} y={base} />
        </svg>
      </Reveal>
      <Reveal as="ol" className="mt-5 grid grid-cols-1 gap-x-8 gap-y-0 text-meta sm:grid-cols-2 xl:grid-cols-3">
        {epochs.map((e, i) => (
          <li
            key={e.index}
            className={cn("flex items-baseline justify-between gap-4 border-b border-hair py-2", RISE)}
            style={delay(i, 50, 250)}
          >
            <span className="flex min-w-0 flex-col">
              <span className="text-fg">{e.label}</span>
              <span className="readout text-micro text-fg-faint">
                {shortDate(e.start)}
                {e.end !== e.start && `–${shortDate(e.end)}`}
              </span>
            </span>
            <span className="text-right text-fg-dim">
              <span className="readout">{e.exposures}</span> exposure{e.exposures === 1 ? "" : "s"}
              <span className="block text-micro text-fg-faint">{e.full ? "Full visit" : "Partial visit"}</span>
            </span>
          </li>
        ))}
      </Reveal>
    </div>
  );
}

const shortDate = (iso: string) => {
  const d = new Date(`${iso}T00:00:00Z`);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
};

/* ------------------------------------------------------------------ */
/* 4. Barnard's Star: measured positions against the Gaia prediction   */
/* ------------------------------------------------------------------ */

export function MotionPlot({
  measured,
  predicted,
  epochs,
}: {
  measured: TrackPoint[];
  predicted: { t: number; north: number }[];
  epochs: TimelineEpoch[];
}) {
  const [ref, w] = useWidth<HTMLDivElement>(680);
  if (!measured.length || !epochs.length) return null;
  const H = 236;
  const top = 18;
  const base = H - 30;
  const left = 40;
  const dom = timeDomain(epochs);
  const x = (t: number) => left + ((t - dom[0]) / (dom[1] - dom[0])) * (w - left - 14);
  const yMin = -2;
  const yMax = 12.5;
  const y = (v: number) => base - ((v - yMin) / (yMax - yMin)) * (base - top);
  const ticks = monthTicks(dom);
  const line = predicted.map((p) => `${x(p.t).toFixed(1)},${y(p.north).toFixed(1)}`).join(" ");

  return (
    <div ref={ref}>
      <Reveal>
        <svg
          width="100%"
          height={H}
          viewBox={`0 0 ${w} ${H}`}
          role="img"
          aria-label="Barnard's Star's position north of its starting point at each SPHEREx visit, rising about 10 arcseconds in a year, on top of the line Gaia predicts."
        >
          {[0, 5, 10].map((v) => (
            <g key={v} className={FADE}>
              <line x1={left} x2={w - 8} y1={y(v)} y2={y(v)} className="stroke-hair" />
              <text x={left - 8} y={y(v) + 4} textAnchor="end" className="readout fill-fg-faint text-[11px]">
                {v}″
              </text>
            </g>
          ))}
          <polyline
            points={line}
            fill="none"
            strokeWidth={1.5}
            strokeLinejoin="round"
            className={cn("stroke-fg-dim", FADE)}
            style={delay(0, 0, 150)}
          />
          {measured.map((p, i) => (
            <g key={p.t} className={RISE} style={delay(i, 90, 300)}>
              <line x1={x(p.t)} x2={x(p.t)} y1={y(p.north - p.err)} y2={y(p.north + p.err)} strokeWidth={1.5} className="stroke-accent" />
              <circle cx={x(p.t)} cy={y(p.north)} r={4} className="fill-ink stroke-accent" strokeWidth={1.75} />
            </g>
          ))}
          <TimeAxis x={x} ticks={ticks} y={base} />
        </svg>
      </Reveal>
      <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-meta text-fg-dim">
        <span className="inline-flex items-center gap-2">
          <svg aria-hidden width="14" height="14" viewBox="0 0 14 14">
            <circle cx="7" cy="7" r="4" className="fill-ink stroke-accent" strokeWidth="1.75" />
          </svg>
          Measured by SPHEREx at each visit, with its uncertainty
        </span>
        <span className="inline-flex items-center gap-2">
          <svg aria-hidden width="18" height="14" viewBox="0 0 18 14">
            <line x1="1" x2="17" y1="7" y2="7" strokeWidth="1.5" className="stroke-fg-dim" />
          </svg>
          Where Gaia predicts it
        </span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 5. Epsilon Indi B: one spectrum from hundreds of exposures          */
/* ------------------------------------------------------------------ */

const BANDS = [
  { name: "Water", depth: "80% deep", lo: 1.36, hi: 1.48 },
  { name: "Methane", depth: "76% deep", lo: 3.2, hi: 3.4 },
] as const;

export function SpectrumPlot({ data }: { data: SpectrumData }) {
  const [ref, w] = useWidth<HTMLDivElement>(680);
  const H = 268;
  const top = 40;
  const base = H - 30;
  const left = 40;
  const right = 12;
  const xDom: [number, number] = [0.7, 5.08];
  const yMax = Math.max(10, Math.ceil(Math.max(...data.points.map((p) => p.mjy)) / 10) * 10);
  const yMin = -0.04 * yMax;
  const x = (um: number) => left + ((um - xDom[0]) / (xDom[1] - xDom[0])) * (w - left - right);
  const y = (v: number) => base - ((v - yMin) / (yMax - yMin)) * (base - top);
  const line = data.median.map((p) => `${x(p.wl).toFixed(1)},${y(p.mjy).toFixed(1)}`).join(" ");
  const yTicks = Array.from({ length: Math.floor(yMax / 20) + 1 }, (_, i) => i * 20).filter((v) => v <= yMax);

  return (
    <div ref={ref}>
      <Reveal>
        <svg
          width="100%"
          height={H}
          viewBox={`0 0 ${w} ${H}`}
          role="img"
          aria-label="The infrared spectrum of Epsilon Indi B: brightness against wavelength from 0.75 to 5 micrometres, with deep dips where water absorbs near 1.4 micrometres and methane near 3.3 micrometres."
        >
          {BANDS.map((b, i) => (
            <g key={b.name}>
              <rect
                x={x(b.lo)}
                y={top}
                width={x(b.hi) - x(b.lo)}
                height={base - top}
                className={cn("fill-accent/15", GROW_Y)}
                style={delay(i, 120, 100)}
              />
              <g className={FADE} style={delay(i, 120, 500)}>
                <text x={(x(b.lo) + x(b.hi)) / 2} y={top - 22} textAnchor="middle" className="fill-fg text-[12px]">
                  {b.name}
                </text>
                <text x={(x(b.lo) + x(b.hi)) / 2} y={top - 8} textAnchor="middle" className="readout fill-fg-faint text-[11px]">
                  {b.depth}
                </text>
              </g>
            </g>
          ))}
          {yTicks.map((v) => (
            <g key={v}>
              <line x1={left} x2={w - right} y1={y(v)} y2={y(v)} className={v === 0 ? "stroke-hair-strong" : "stroke-hair"} />
              <text x={left - 8} y={y(v) + 4} textAnchor="end" className="readout fill-fg-faint text-[11px]">
                {v}
              </text>
            </g>
          ))}
          <g className={FADE} style={delay(0, 0, 250)}>
            {data.points.map((p, i) => (
              <circle key={i} cx={x(p.wl)} cy={y(p.mjy)} r={1.7} className="fill-fg/35" />
            ))}
          </g>
          <polyline
            points={line}
            fill="none"
            strokeWidth={1.75}
            strokeLinejoin="round"
            className={cn("stroke-fg", FADE)}
            style={delay(0, 0, 650)}
          />
          {[1, 2, 3, 4, 5].map((um) => (
            <g key={um}>
              <line x1={x(um)} x2={x(um)} y1={base} y2={base + 5} className="stroke-hair-strong" />
              <text x={x(um)} y={base + 19} textAnchor="middle" className="readout fill-fg-faint text-[11px]">
                {um} µm
              </text>
            </g>
          ))}
          <text x={left - 8} y={top - 22} textAnchor="end" className="fill-fg-faint text-[11px]">
            mJy
          </text>
        </svg>
      </Reveal>
    </div>
  );
}
