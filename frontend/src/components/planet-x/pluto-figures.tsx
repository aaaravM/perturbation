"use client";
// The measured-data figures of the Planet X page, drawn like the How it works figures: inline SVG
// at the figure's real width (so labels keep their size on a phone), animated in once with
// transform and opacity, and simply there with reduced motion.

import * as React from "react";
import type { SpectrumData } from "@/lib/planet-x";
import { FADE, GROW_Y, RISE, delay } from "@/components/how-it-works/motion-classes";
import { Reveal, useWidth } from "@/components/how-it-works/reveal";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/* 1. From the Planet X telescope to SPHEREx                           */
/* ------------------------------------------------------------------ */

export function DiscoveryTimeline({ items }: { items: { when: string; what: string; now?: boolean }[] }) {
  return (
    <Reveal as="ol" className="grid max-w-4xl grid-cols-1 gap-x-8 gap-y-5 sm:grid-cols-2 lg:grid-cols-5">
      {items.map((it, i) => (
        <li
          key={it.when}
          className={cn("flex flex-col gap-1.5 border-t pt-4", it.now ? "border-accent/70" : "border-hair-strong", RISE)}
          style={delay(i, 90)}
        >
          <p className="text-ui text-fg">{it.when}</p>
          <p className="text-meta text-pretty text-fg-dim">{it.what}</p>
        </li>
      ))}
    </Reveal>
  );
}

/* ------------------------------------------------------------------ */
/* 3. Pluto's spectrum against sunlight                                */
/* ------------------------------------------------------------------ */

export function PlutoSpectrum({ data }: { data: SpectrumData }) {
  const [ref, w] = useWidth<HTMLDivElement>(680);
  const H = 304;
  const top = 50;
  const base = H - 30;
  const left = 40;
  const right = 12;
  const xDom: [number, number] = [0.7, 5.08];
  const hi = Math.max(...data.points.map((p) => p.mjy + p.err));
  const yMax = Math.ceil(hi / 2) * 2;
  const yMin = -0.03 * yMax;
  const x = (um: number) => left + ((um - xDom[0]) / (xDom[1] - xDom[0])) * (w - left - right);
  const y = (v: number) => base - ((v - yMin) / (yMax - yMin)) * (base - top);
  const poly = (pts: [number, number][]) => pts.map(([a, b]) => `${x(a).toFixed(1)},${y(b).toFixed(1)}`).join(" ");
  const yTicks = Array.from({ length: yMax / 2 + 1 }, (_, i) => i * 2);
  const mid = (b: { lo: number; hi: number }) => (x(b.lo) + x(b.hi)) / 2;
  const first = data.bands[0];
  const last = data.bands.at(-1)!;

  return (
    <div ref={ref}>
      <Reveal>
        <svg
          width="100%"
          height={H}
          viewBox={`0 0 ${w} ${H}`}
          role="img"
          aria-label={`Pluto's infrared spectrum from SPHEREx, ${data.points.length} measurements from 0.75 to 5 micrometres. Pluto's brightness falls with wavelength like sunlight, but drops far below it in three methane-ice bands: by ${data.bands.map((b) => `${Math.round(b.depth * 100)}%`).join(", ")}.`}
        >
          {data.bands.map((b, i) => (
            <g key={b.lo}>
              <rect
                x={x(b.lo)}
                y={top}
                width={x(b.hi) - x(b.lo)}
                height={base - top}
                className={cn("fill-accent/15", GROW_Y)}
                style={delay(i, 120, 100)}
              />
              <text
                x={mid(b)}
                y={top - 8}
                textAnchor="middle"
                className={cn("readout fill-fg text-[11px]", FADE)}
                style={delay(i, 120, 500)}
              >
                {Math.round(b.depth * 100)}%
              </text>
            </g>
          ))}
          <g className={FADE} style={delay(0, 0, 400)}>
            <path
              d={`M${mid(first)},${top - 24} V${top - 30} H${mid(last)} V${top - 24}`}
              fill="none"
              strokeWidth={1}
              className="stroke-hair-strong"
            />
            {data.bands.slice(1, -1).map((b) => (
              <line key={b.lo} x1={mid(b)} x2={mid(b)} y1={top - 30} y2={top - 24} strokeWidth={1} className="stroke-hair-strong" />
            ))}
            <text x={(mid(first) + mid(last)) / 2} y={top - 36} textAnchor="middle" className="fill-fg text-[12px]">
              Methane ice
            </text>
          </g>
          {yTicks.map((v) => (
            <g key={v}>
              <line x1={left} x2={w - right} y1={y(v)} y2={y(v)} className={v === 0 ? "stroke-hair-strong" : "stroke-hair"} />
              <text x={left - 8} y={y(v) + 4} textAnchor="end" className="readout fill-fg-faint text-[11px]">
                {v}
              </text>
            </g>
          ))}
          <polyline
            points={poly(data.bins.map((b) => [b.um, b.sun]))}
            fill="none"
            strokeWidth={1.25}
            strokeDasharray="4 4"
            className={cn("stroke-fg-faint", FADE)}
            style={delay(0, 0, 200)}
          />
          <g className={FADE} style={delay(0, 0, 250)}>
            {data.points.map((p, i) => (
              <g key={i}>
                <line x1={x(p.um)} x2={x(p.um)} y1={y(p.mjy - p.err)} y2={y(p.mjy + p.err)} strokeWidth={1} className="stroke-fg/30" />
                <circle cx={x(p.um)} cy={y(p.mjy)} r={1.8} className="fill-fg/50" />
              </g>
            ))}
          </g>
          <polyline
            points={poly(data.bins.map((b) => [b.um, b.mjy]))}
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
          <text x={left - 8} y={top - 36} textAnchor="end" className="fill-fg-faint text-[11px]">
            mJy
          </text>
        </svg>
      </Reveal>
      <ul className="mt-3 flex flex-wrap gap-x-6 gap-y-1.5 text-meta text-fg-dim">
        <li className="inline-flex items-center gap-2">
          <svg aria-hidden width="10" height="14" viewBox="0 0 10 14">
            <line x1="5" x2="5" y1="1" y2="13" strokeWidth="1" className="stroke-fg/30" />
            <circle cx="5" cy="7" r="2.2" className="fill-fg/50" />
          </svg>
          One SPHEREx measurement, with its uncertainty
        </li>
        <li className="inline-flex items-center gap-2">
          <svg aria-hidden width="18" height="14" viewBox="0 0 18 14">
            <line x1="1" x2="17" y1="7" y2="7" strokeWidth="1.75" className="stroke-fg" />
          </svg>
          Their average in {data.bins.length} steps of wavelength
        </li>
        <li className="inline-flex items-center gap-2">
          <svg aria-hidden width="18" height="14" viewBox="0 0 18 14">
            <line x1="1" x2="17" y1="7" y2="7" strokeWidth="1.25" strokeDasharray="4 4" className="stroke-fg-faint" />
          </svg>
          Sunlight, matched to Pluto below 1 µm
        </li>
        <li className="inline-flex items-center gap-2">
          <span aria-hidden className="h-3 w-3.5 rounded-[3px] bg-accent/25" />
          Methane-ice bands, with how deep each dip is
        </li>
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 5. How faint is Planet Nine?                                        */
/* ------------------------------------------------------------------ */

export interface LadderRow {
  label: string;
  note: string;
  /** AB magnitude, or a range. */
  value: number | [number, number];
  accent?: boolean;
}

export function BrightnessLadder({ rows, limit }: { rows: LadderRow[]; limit: number }) {
  const [ref, w] = useWidth<HTMLDivElement>(680);
  const dom: [number, number] = [13, 24];
  const rowH = 58;
  const top = 26;
  const axisY = top + rows.length * rowH + 4;
  const H = axisY + 40;
  const x = (m: number) => 6 + ((m - dom[0]) / (dom[1] - dom[0])) * (w - 12);
  const ticks = [14, 16, 18, 20, 22, 24];

  return (
    <div ref={ref}>
      <Reveal>
        <svg
          width="100%"
          height={H}
          viewBox={`0 0 ${w} ${H}`}
          role="img"
          aria-label={`Brightness on the astronomers' magnitude scale, where larger numbers are fainter: ${rows
            .map((r) => `${r.label}, ${Array.isArray(r.value) ? `${r.value[0]} to ${r.value[1]}` : r.value.toFixed(1)}`)
            .join("; ")}. Everything fainter than ${limit} is beyond SPHEREx's reach.`}
        >
          <rect x={x(limit)} y={top - 22} width={w - x(limit)} height={axisY - top + 22} className={cn("fill-fg/[0.04]", FADE)} />
          <line
            x1={x(limit)}
            x2={x(limit)}
            y1={top - 22}
            y2={axisY}
            strokeDasharray="3 4"
            strokeWidth={1}
            className={cn("stroke-hair-strong", FADE)}
          />
          <text x={w - 6} y={top - 8} textAnchor="end" className={cn("fill-fg-faint text-[11px]", FADE)}>
            Too faint for SPHEREx
          </text>
          {rows.map((r, i) => {
            const y0 = top + i * rowH;
            const track = y0 + 38;
            const [a, b] = Array.isArray(r.value) ? r.value : [r.value, r.value];
            const text = Array.isArray(r.value) ? `${a.toFixed(1)}–${b.toFixed(1)}` : r.value.toFixed(1);
            const flip = x(b) > w - 52;
            return (
              <g key={r.label} className={RISE} style={delay(i, 110, 150)}>
                <text x={0} y={y0 + 10} className="fill-fg text-[12px]">
                  {r.label}
                </text>
                <text x={0} y={y0 + 24} className="fill-fg-faint text-[11px]">
                  {r.note}
                </text>
                <line x1={x(dom[0])} x2={x(dom[1])} y1={track} y2={track} className="stroke-hair" />
                {a === b ? (
                  <circle
                    cx={x(a)}
                    cy={track}
                    r={5}
                    strokeWidth={1.75}
                    className={r.accent ? "fill-accent/30 stroke-accent" : "fill-ink stroke-fg"}
                  />
                ) : (
                  <rect x={x(a) - 4} y={track - 5} width={x(b) - x(a) + 8} height={10} rx={5} strokeWidth={1.75} className="fill-ink stroke-fg" />
                )}
                <text
                  x={flip ? x(a) - 11 : x(b) + 11}
                  y={track + 4}
                  textAnchor={flip ? "end" : "start"}
                  className={cn("readout text-[11px]", r.accent ? "fill-fg" : "fill-fg-dim")}
                >
                  {text}
                </text>
              </g>
            );
          })}
          <line x1={x(dom[0])} x2={x(dom[1])} y1={axisY} y2={axisY} className="stroke-hair-strong" />
          {ticks.map((m) => (
            <g key={m}>
              <line x1={x(m)} x2={x(m)} y1={axisY} y2={axisY + 5} className="stroke-hair-strong" />
              <text x={x(m)} y={axisY + 18} textAnchor="middle" className="readout fill-fg-faint text-[11px]">
                {m}
              </text>
            </g>
          ))}
          <text x={0} y={axisY + 34} className="fill-fg-faint text-[11px]">
            ← Brighter
          </text>
          <text x={w / 2} y={axisY + 34} textAnchor="middle" className="fill-fg-faint text-[11px]">
            AB magnitude
          </text>
          <text x={w} y={axisY + 34} textAnchor="end" className="fill-fg-faint text-[11px]">
            Fainter →
          </text>
        </svg>
      </Reveal>
    </div>
  );
}
