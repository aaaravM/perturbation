"use client";
// "What SPHEREx sees": a friendly, honest picture of the object's spectrum. Every measured point
// from the bundle is drawn faintly; the line is a gently smoothed median through them (saturated
// points are shown hollow and left out). Linear axes, labelled, no invented data.

import { useMemo } from "react";
import { motion } from "motion/react";
import type { FieldManifest } from "@/lib/manifest";
import { spectrumSketch } from "@/components/sky-panel/bundle-frames";

const W = 360;
const H = 168;
const PAD = { l: 10, r: 10, t: 26, b: 26 };
const WL_MIN = 0.7;
const WL_MAX = 5.0;

function catmullRom(pts: { x: number; y: number }[]): string {
  if (pts.length < 2) return "";
  let d = `M${pts[0].x.toFixed(2)},${pts[0].y.toFixed(2)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += `C${c1x.toFixed(2)},${c1y.toFixed(2)} ${c2x.toFixed(2)},${c2y.toFixed(2)} ${p2.x.toFixed(2)},${p2.y.toFixed(2)}`;
  }
  return d;
}

export function SpectrumSketch({
  manifest,
  reducedMotion,
}: {
  manifest: FieldManifest;
  reducedMotion: boolean;
}) {
  const sketch = useMemo(() => spectrumSketch(manifest), [manifest]);

  if (!sketch) {
    return <p className="text-ui text-fg-dim">This bundle does not include a spectrum yet.</p>;
  }

  const good = sketch.points.filter((p) => !p.saturated);
  const top = Math.max(...(good.length ? good : sketch.points).map((p) => p.flux), 1e-9) * 1.12;
  const bottom = Math.min(0, ...good.map((p) => p.flux));
  const x = (wl: number) => PAD.l + ((wl - WL_MIN) / (WL_MAX - WL_MIN)) * (W - PAD.l - PAD.r);
  const y = (f: number) => {
    const v = Math.min(top, Math.max(bottom, f));
    return H - PAD.b - ((v - bottom) / (top - bottom)) * (H - PAD.t - PAD.b);
  };
  const line = catmullRom(sketch.curve.map((p) => ({ x: x(p.wl), y: y(p.flux) })));
  const area = line
    ? `${line}L${x(sketch.curve[sketch.curve.length - 1].wl).toFixed(2)},${y(bottom).toFixed(2)}L${x(sketch.curve[0].wl).toFixed(2)},${y(bottom).toFixed(2)}Z`
    : "";
  const anySaturated = sketch.points.some((p) => p.saturated);
  const peak = sketch.peakWl;

  return (
    <figure className="flex flex-col gap-2" data-testid="spectrum-sketch">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Spectrum from ${sketch.points.length} SPHEREx measurements between ${WL_MIN} and ${WL_MAX} microns${peak ? `, brightest near ${peak.toFixed(1)} microns` : ""}.`}
        className="w-full overflow-visible"
      >
        <defs>
          <linearGradient id="spectrum-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="var(--fg)" stopOpacity="0.1" />
            <stop offset="1" stopColor="var(--fg)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <text x={PAD.l} y={12} className="fill-fg-faint text-[10px]">
          Brightness
        </text>
        <line x1={PAD.l} x2={W - PAD.r} y1={y(bottom)} y2={y(bottom)} stroke="var(--hair-strong)" />
        {[1, 2, 3, 4, 5].map((wl) => (
          <g key={wl}>
            <line x1={x(wl)} x2={x(wl)} y1={y(bottom)} y2={y(bottom) + 4} stroke="var(--hair-strong)" />
            <text x={x(wl)} y={H - 8} textAnchor="middle" className="readout fill-fg-faint text-[10px]">
              {wl}
            </text>
          </g>
        ))}
        <text x={W - PAD.r} y={12} textAnchor="end" className="fill-fg-faint text-[10px]">
          Wavelength, microns
        </text>

        {area && <path d={area} fill="url(#spectrum-fill)" />}
        {sketch.points.map((p, i) =>
          p.saturated ? (
            <circle
              key={i}
              cx={x(p.wl)}
              cy={y(p.flux)}
              r={1.9}
              fill="none"
              stroke="var(--fg-faint)"
              strokeWidth={0.8}
            />
          ) : (
            <circle key={i} cx={x(p.wl)} cy={y(p.flux)} r={1.3} fill="var(--fg-dim)" fillOpacity={0.45} />
          ),
        )}
        {line && (
          <motion.path
            d={line}
            fill="none"
            stroke="var(--fg)"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            initial={reducedMotion ? false : { pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={{ duration: 1.1, ease: [0.65, 0, 0.35, 1], delay: 0.15 }}
          />
        )}
        {peak !== null && (
          <g>
            <line
              x1={x(peak)}
              x2={x(peak)}
              y1={PAD.t - 4}
              y2={y(bottom)}
              stroke="var(--fg-faint)"
              strokeDasharray="2 3"
              strokeWidth={0.8}
            />
          </g>
        )}
      </svg>
      <figcaption className="flex flex-col gap-1.5 text-meta text-pretty text-fg-dim">
        {peak !== null && (
          <p>
            <span className="text-fg">Brightest near </span>
            <span className="readout text-fg">{peak.toFixed(1)} µm</span>
            <span className="text-fg">.</span> All of this light is infrared, beyond the reddest light our
            eyes can see (about <span className="readout">0.7</span> µm). Cooler objects glow at longer
            wavelengths.
          </p>
        )}
        <p className="text-fg-faint">
          {sketch.source === "quicklook" && sketch.label ? `${sketch.label}. ` : ""}
          Dots are individual SPHEREx measurements; the line is a smoothed middle value through them.
          {anySaturated ? " Hollow dots were too bright for the detector and are left out of the line." : ""}
        </p>
      </figcaption>
    </figure>
  );
}
