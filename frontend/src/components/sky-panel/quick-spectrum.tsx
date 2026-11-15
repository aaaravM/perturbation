"use client";
// A small chart of the SPHEREx DR1 quick-look spectrum at one position (/api/spectrum/quick):
// each of the 102 channels as a dot, joined detector by detector, on a wavelength axis from 0.75
// to 5 microns. Masked channels are left out, never filled in.

import { motion } from "motion/react";
import type { QuickSpectrum as QuickSpectrumData } from "@/lib/sky-live";

const W = 360;
const H = 132;
const PAD = { l: 8, r: 8, t: 18, b: 22 };
const WL_MIN = 0.7;
const WL_MAX = 5.05;
/** SPHEREx detector edges (microns), for joining the dots one detector at a time. */
const DETECTOR_EDGES = [0.75, 1.11, 1.64, 2.42, 3.82, 4.42, 5.0];

export function QuickSpectrum({ data, reducedMotion }: { data: QuickSpectrumData; reducedMotion: boolean }) {
  const pts = data.wl
    .map((wl, i) => ({ wl, f: data.flux[i] }))
    .filter((p): p is { wl: number; f: number } => Number.isFinite(p.wl) && p.f !== null && Number.isFinite(p.f));
  if (pts.length < 3) return null;
  const positive = pts.filter((p) => p.f > 0);
  const useLog = positive.length > pts.length * 0.8 && Math.max(...positive.map((p) => p.f)) / Math.min(...positive.map((p) => p.f)) > 40;
  const vals = useLog ? positive.map((p) => Math.log10(p.f)) : pts.map((p) => p.f);
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  if (!useLog) lo = Math.min(0, lo);
  if (hi - lo < 1e-9) hi = lo + 1;
  const padY = (hi - lo) * 0.08;
  lo -= useLog ? padY : 0;
  hi += padY;
  const x = (wl: number) => PAD.l + ((wl - WL_MIN) / (WL_MAX - WL_MIN)) * (W - PAD.l - PAD.r);
  const y = (f: number) => {
    const v = useLog ? Math.log10(Math.max(f, 1e-12)) : f;
    return H - PAD.b - ((v - lo) / (hi - lo)) * (H - PAD.t - PAD.b);
  };
  const shown = useLog ? positive : pts;
  const segments: string[] = [];
  for (let d = 0; d < DETECTOR_EDGES.length - 1; d++) {
    const seg = shown.filter((p) => p.wl >= DETECTOR_EDGES[d] && p.wl < DETECTOR_EDGES[d + 1] + (d === 5 ? 0.1 : 0));
    if (seg.length < 2) continue;
    segments.push(seg.map((p, i) => `${i ? "L" : "M"}${x(p.wl).toFixed(1)},${y(p.f).toFixed(1)}`).join(""));
  }
  const peak = shown.reduce((a, b) => (b.f > a.f ? b : a), shown[0]);

  return (
    <figure className="flex flex-col gap-2" data-testid="quick-spectrum">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`SPHEREx quick-look spectrum: ${shown.length} channels between 0.75 and 5 microns, brightest near ${peak.wl.toFixed(2)} microns.`}
        className="w-full overflow-visible"
      >
        <text x={PAD.l} y={9} className="fill-fg-faint text-[10px]">
          Brightness{useLog ? " (log scale)" : ""}
        </text>
        <text x={W - PAD.r} y={9} textAnchor="end" className="fill-fg-faint text-[10px]">
          Wavelength, µm
        </text>
        <line x1={PAD.l} x2={W - PAD.r} y1={H - PAD.b} y2={H - PAD.b} stroke="var(--hair-strong)" />
        {[1, 2, 3, 4, 5].map((wl) => (
          <g key={wl}>
            <line x1={x(wl)} x2={x(wl)} y1={H - PAD.b} y2={H - PAD.b + 4} stroke="var(--hair-strong)" />
            <text x={x(wl)} y={H - 6} textAnchor="middle" className="readout fill-fg-faint text-[10px]">
              {wl}
            </text>
          </g>
        ))}
        {segments.map((d, i) => (
          <motion.path
            key={i}
            d={d}
            fill="none"
            stroke="var(--fg-dim)"
            strokeWidth={1.1}
            strokeLinejoin="round"
            initial={reducedMotion ? false : { pathLength: 0, opacity: 0 }}
            animate={{ pathLength: 1, opacity: 1 }}
            transition={{ duration: 0.7, delay: 0.1 + i * 0.09, ease: [0.65, 0, 0.35, 1] }}
          />
        ))}
        {shown.map((p, i) => (
          <motion.circle
            key={i}
            cx={x(p.wl)}
            cy={y(p.f)}
            r={1.45}
            fill="var(--fg)"
            initial={reducedMotion ? false : { opacity: 0 }}
            animate={{ opacity: 0.85 }}
            transition={{ duration: 0.3, delay: 0.15 + (p.wl / WL_MAX) * 0.7 }}
          />
        ))}
        <line
          x1={x(peak.wl)}
          x2={x(peak.wl)}
          y1={PAD.t}
          y2={H - PAD.b}
          stroke="var(--accent-muted)"
          strokeDasharray="2 3"
          strokeWidth={0.9}
        />
      </svg>
      <figcaption className="text-micro text-pretty text-fg-faint">
        {data.label}
        {data.pixelArcsec ? (
          <>
            , <span className="readout">{data.pixelArcsec.toFixed(1)}″</span> pixels
          </>
        ) : null}
        . Each dot is one of SPHEREx&rsquo;s 102 colours; gaps are channels with no usable
        data. Brightest near <span className="readout text-fg-dim">{peak.wl.toFixed(2)} µm</span>.
      </figcaption>
    </figure>
  );
}
