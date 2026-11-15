"use client";
// Scenes 2 to 4 of the home page story, each drawn on a square "plate" of real SPHEREx frames and
// driven by one progress value p (0 to 1): scroll on wide screens and phones, a fixed value when
// motion is reduced. Everything moves by transform and opacity; frames flip by opacity.
//   DetectorsScene: Barnard's Star's patch through the six detectors, and the 102 bands they record.
//   BlinkScene:     the August 2025, March 2026 and August 2026 visits, with a glass loupe that
//                   follows the star and a ruler of how far it has moved.
//   SubtractScene:  a glass wiper reveals the difference image.

import * as React from "react";
import NumberFlow from "@number-flow/react";
import { motion, useMotionValueEvent, useSpring, useTransform, type MotionValue } from "motion/react";
import { LiquidGlass } from "@/components/ui/liquid-glass";
import { cn } from "@/lib/utils";
import { BANDS_PER_DETECTOR, DETECTORS, DIFFERENCE, VISITS } from "./story-data";
import { easeInOut, easeOut, mix, smooth, span } from "./story-math";

const MotionGlass = motion.create(LiquidGlass);

/** A frame at plate size, real pixels kept square. */
function Frame({ src, className, style }: { src: string; className?: string; style?: React.ComponentProps<typeof motion.img>["style"] }) {
  return (
    <motion.img
      src={src}
      alt=""
      draggable={false}
      decoding="async"
      className={cn("absolute top-0 left-0 size-full max-w-none select-none [image-rendering:pixelated]", className)}
      style={style}
    />
  );
}

/** The current value of a discrete function of p, as React state (it changes a few times per pass). */
function useStep(p: MotionValue<number>, step: (v: number) => number) {
  const [value, setValue] = React.useState(() => step(p.get()));
  useMotionValueEvent(p, "change", (v) => {
    const next = step(v);
    setValue((prev) => (prev === next ? prev : next));
  });
  return value;
}

// ------------------------------------------------------------------------------- detectors

const LOG_MIN = Math.log(0.746);
const LOG_MAX = Math.log(5.01);
const xOfWl = (wl: number) => (Math.log(wl) - LOG_MIN) / (LOG_MAX - LOG_MIN);

/** Band centres, evenly spaced in log wavelength within each detector (constant resolving power). */
const BAND_X = DETECTORS.map((d) =>
  Array.from({ length: BANDS_PER_DETECTOR }, (_, k) =>
    xOfWl(d.wl[0] * (d.wl[1] / d.wl[0]) ** ((k + 0.5) / BANDS_PER_DETECTOR)),
  ),
);

const litFor = (v: number) => (v < 0.24 ? 0 : Math.min(6, Math.floor(span(v, 0.24, 0.8) * 6) + 1));

export function DetectorsScene({ p, size, animate }: { p: MotionValue<number>; size: number; animate: boolean }) {
  const lit = useStep(p, litFor);
  const sweeping = useStep(p, (v) => (v >= 0.24 && v < 0.8 ? 1 : 0));
  const g = size * 0.025;
  const t = (size - 2 * g) / 3;
  const top = (size - (2 * t + g)) / 2 - size * 0.045;
  const scaleTop = top + 2 * t + g + size * 0.04;

  return (
    <div className="absolute inset-0">
      {DETECTORS.map((d, i) => (
        <DetectorTile
          key={d.key}
          p={p}
          i={i}
          size={size}
          tile={t}
          cx={t / 2 + (i % 3) * (t + g)}
          cy={top + t / 2 + Math.floor(i / 3) * (t + g)}
          active={sweeping === 1 && lit === i + 1}
        />
      ))}
      <div className="absolute inset-x-0" style={{ top: scaleTop }}>
        <BandScale lit={lit} width={size} />
        <div className="mt-2 flex items-baseline justify-between gap-3 text-micro text-fg-faint">
          <span className="readout">0.75–5.0 µm</span>
          <span className={cn("readout text-fg transition-opacity duration-300", lit === 0 && "opacity-0")}>
            <NumberFlow value={lit * BANDS_PER_DETECTOR} animated={animate} locales="en-US" /> colours
          </span>
        </div>
      </div>
    </div>
  );
}

function DetectorTile({
  p,
  i,
  size,
  tile,
  cx,
  cy,
  active,
}: {
  p: MotionValue<number>;
  i: number;
  size: number;
  tile: number;
  cx: number;
  cy: number;
  active: boolean;
}) {
  const d = DETECTORS[i];
  // 0: all six stacked at full plate size (only D6 shows); 1: spread into the grid.
  const k = useTransform(p, (v) => easeOut(span(v, 0, 0.22)) * (1 - easeInOut(span(v, 0.86, 1))));
  const x = useTransform(k, (v) => mix(size / 2, cx, v) - tile / 2);
  const y = useTransform(k, (v) => mix(size / 2, cy, v) - tile / 2);
  const scale = useTransform(k, (v) => mix(size / tile, 1, v));
  const opacity = useTransform(k, (v) => (i === 5 ? 1 : smooth(v * 1.8)));
  const labels = useTransform(k, (v) => smooth((v - 0.82) / 0.18));
  return (
    <motion.div className="absolute top-0 left-0 origin-center" style={{ x, y, scale, opacity, width: tile, height: tile, zIndex: i === 5 ? 6 : i }}>
      <Frame src={d.src} />
      <motion.div style={{ opacity: labels }} className="absolute inset-x-0 bottom-0 bg-linear-to-t from-black/75 to-transparent px-2 pt-6 pb-1.5">
        <span className="readout text-micro text-fg">{d.key}</span>
        {tile >= 150 && (
          <span className="readout ml-2 text-micro text-fg-dim">
            {d.wl[0].toFixed(2)}–{d.wl[1].toFixed(2)} µm
          </span>
        )}
      </motion.div>
      <motion.div
        style={{ opacity: labels }}
        className={cn("absolute inset-0 ring-1 ring-white/15 ring-inset", active && "ring-2 ring-accent")}
      />
    </motion.div>
  );
}

function BandScale({ lit, width }: { lit: number; width: number }) {
  const h = 14;
  return (
    <svg width={width} height={h + 16} viewBox={`0 0 ${width} ${h + 16}`} className="block overflow-visible" aria-hidden>
      <line x1={0} x2={width} y1={h + 0.5} y2={h + 0.5} stroke="var(--hair-strong)" />
      {BAND_X.map((xs, di) => (
        <g key={di}>
          {xs.map((x, k) => (
            <line key={k} x1={x * width} x2={x * width} y1={2} y2={h} stroke="var(--fg-faint)" strokeOpacity={0.55} />
          ))}
          <g className="transition-opacity duration-300" opacity={lit > di ? 1 : 0}>
            {xs.map((x, k) => (
              <line key={k} x1={x * width} x2={x * width} y1={0} y2={h} stroke="var(--accent)" strokeWidth={1.25} />
            ))}
          </g>
          <text
            x={((xs[0] + xs[xs.length - 1]) / 2) * width}
            y={h + 13}
            textAnchor="middle"
            className={cn("readout fill-fg-faint text-micro", lit > di && "fill-fg-dim")}
          >
            {DETECTORS[di].key}
          </text>
        </g>
      ))}
    </svg>
  );
}

// ----------------------------------------------------------------------------------- blink

/** Which visit shows at p: forward through the year, then a few flips between the first and last. */
const VISIT_STEPS: readonly [number, number][] = [
  [0.18, 0],
  [0.36, 1],
  [0.52, 2],
  [0.62, 0],
  [0.72, 2],
  [0.82, 0],
  [Infinity, 2],
];
const visitFor = (v: number) => VISIT_STEPS.find(([end]) => v < end)![1];

/** Loupe magnification, on top of the plate's own. */
const MAG = 2;
/** The star's bright core, in frame pixels (radius). */
const CORE = 4.4;

export function BlinkScene({ p, size, animate }: { p: MotionValue<number>; size: number; animate: boolean }) {
  const shown = useStep(p, visitFor);
  const seenLast = useStep(p, (v) => (v >= VISIT_STEPS[1][0] ? 1 : 0));
  const s = size / 99;
  const loupe = Math.round(Math.min(196, Math.max(120, size * 0.3)));
  const radius = Math.round(loupe * 0.3);
  const first = VISITS[0];
  const last = VISITS[2];
  // The loupe sweeps in from the upper left and settles between the first and last positions, so
  // the star visibly jumps inside it.
  const home = { x: ((first.x + last.x) / 2) * s, y: ((first.y + last.y) / 2) * s };
  const from = { x: size * 0.2, y: size * 0.18 };
  const travel = useTransform(p, (v) => easeOut(span(v, 0, 0.15)));
  const lx = useTransform(travel, (t) => mix(from.x, home.x, t));
  const ly = useTransform(travel, (t) => mix(from.y, home.y, t));
  const moved = useSpring(0, { stiffness: 140, damping: 24 });

  React.useEffect(() => {
    if (animate) moved.set(VISITS[shown].moved);
    else moved.jump(VISITS[shown].moved);
  }, [shown, animate, moved]);

  const show = useTransform(p, (v) => smooth(span(v, 0, 0.06)));
  const lensScale = useTransform(show, (v) => mix(0.86, 1, v));
  const boxX = useTransform(lx, (v) => v - loupe / 2);
  const boxY = useTransform(ly, (v) => v - loupe / 2);
  const innerX = useTransform(lx, (v) => loupe / 2 - v * MAG);
  const innerY = useTransform(ly, (v) => loupe / 2 - v * MAG);
  const fill = useTransform(moved, (v) => Math.min(1, v / 12));
  const readout = Math.round(VISITS[shown].moved * 10) / 10;

  // Marks inside the loupe, in its magnified space: where the star sat in August 2025 (left) and
  // August 2026 (right), and a bracket between the two heights.
  const k = s * MAG;
  const r = CORE * k;
  const a = { x: first.x * k, y: first.y * k };
  const b = { x: last.x * k, y: last.y * k };

  return (
    <div className="absolute inset-0">
      {VISITS.map((v, i) => (
        <Frame key={v.label} src={v.src} style={{ opacity: shown === i ? 1 : 0 }} />
      ))}

      {/* The loupe: the same frames enlarged inside, with clear glass over them. */}
      <motion.div className="absolute top-0 left-0" style={{ x: boxX, y: boxY, width: loupe, height: loupe }}>
        <motion.div className="absolute inset-0 overflow-hidden bg-ink" style={{ borderRadius: radius, opacity: show, scale: lensScale }}>
          <motion.div className="absolute top-0 left-0" style={{ x: innerX, y: innerY, width: size * MAG, height: size * MAG }}>
            {/* A harder stretch inside the loupe, so the saturated core reads as a disc and its step shows. */}
            <div className="absolute inset-0 [filter:brightness(0.7)_contrast(2.2)]">
              {VISITS.map((v, i) => (
                <Frame key={v.label} src={v.src} style={{ opacity: shown === i ? 1 : 0 }} />
              ))}
            </div>
            <span className="absolute h-[1.5px] w-3.5 bg-white/75" style={{ left: a.x - r - 18, top: a.y }} />
            <span
              className={cn("absolute h-[1.5px] w-3.5 bg-accent transition-opacity duration-300", !seenLast && "opacity-0")}
              style={{ left: b.x + r + 4, top: b.y }}
            />
            <span
              className={cn("absolute w-[1.5px] bg-accent/70 transition-opacity duration-300", !seenLast && "opacity-0")}
              style={{ left: b.x + r + 22, top: b.y, height: a.y - b.y }}
            />
          </motion.div>
        </motion.div>
        <MotionGlass variant="clear" radius={radius} className="absolute inset-0" style={{ opacity: show, scale: lensScale }} />
      </motion.div>

      {/* Below the plate: the visits, and how far the star has moved since the first. */}
      <div className="absolute inset-x-0 top-full pt-4">
        <div className="flex items-baseline justify-between gap-3">
          <ol className="flex gap-4 text-micro">
            {VISITS.map((v, i) => (
              <li key={v.label} className={cn("readout transition-colors duration-200", shown === i ? "text-fg" : "text-fg-faint")}>
                {v.label}
              </li>
            ))}
          </ol>
          <span className="text-meta text-fg-dim">
            <NumberFlow
              value={readout}
              animated={animate}
              locales="en-US"
              format={{ minimumFractionDigits: 1, maximumFractionDigits: 1 }}
              className="readout text-fg"
              suffix="″"
            />{" "}
            moved
          </span>
        </div>
        <div className="relative mt-2.5 h-3">
          <div className="absolute inset-x-0 top-1.5 h-px bg-hair-strong" />
          {Array.from({ length: 13 }, (_, k) => (
            <span key={k} className={cn("absolute top-0 w-px bg-hair-strong", k % 5 === 0 ? "h-3" : "top-1 h-1.5")} style={{ left: `${(k / 12) * 100}%` }} />
          ))}
          <motion.div className="absolute inset-x-0 top-1 h-1 origin-left rounded-[1px] bg-accent" style={{ scaleX: fill }} />
        </div>
        <div className="readout relative mt-1 h-4 text-micro text-fg-faint">
          {[0, 5, 10].map((k) => (
            <span key={k} className={cn("absolute top-0", k > 0 && "-translate-x-1/2")} style={{ left: `${(k / 12) * 100}%` }}>
              {k}″
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

// -------------------------------------------------------------------------------- subtract

export function SubtractScene({ p, size }: { p: MotionValue<number>; size: number }) {
  const wiper = Math.round(Math.min(46, Math.max(28, size * 0.07)));
  const edge = useTransform(p, (v) => size * easeInOut(span(v, 0.1, 0.72)));
  const clipX = useTransform(edge, (e) => e - size);
  const imageX = useTransform(edge, (e) => size - e);
  const wiperX = useTransform(edge, (e) => e - wiper / 2);
  const wiperOpacity = useTransform(p, (v) => smooth(span(v, 0.05, 0.12)) * (1 - smooth(span(v, 0.74, 0.82))));
  const notes = useTransform(p, (v) => smooth(span(v, 0.76, 0.86)));
  const s = size / 99;
  const was = VISITS[0];
  const is = VISITS[2];

  return (
    <div className="absolute inset-0">
      <Frame src={VISITS[2].src} />
      {/* The difference, revealed from the left by moving a mask and the image against it. */}
      <div className="absolute inset-0 overflow-hidden">
        <motion.div className="absolute inset-0 overflow-hidden" style={{ x: clipX }}>
          <motion.div className="absolute inset-0" style={{ x: imageX }}>
            <Frame src={DIFFERENCE.src} />
          </motion.div>
        </motion.div>
      </div>
      <motion.div className="absolute top-[-18px] left-0" style={{ x: wiperX, width: wiper, height: size + 36 }}>
        <MotionGlass variant="clear" radius={wiper / 2} className="size-full" style={{ opacity: wiperOpacity }} />
      </motion.div>

      {/* Where it was and where it is. */}
      <motion.div style={{ opacity: notes }} className="pointer-events-none absolute inset-0">
        <Note x={was.x * s} y={was.y * s} dy={size * 0.11} text="Aug 2025: it was here" />
        <Note x={is.x * s} y={is.y * s} dy={-size * 0.11} text="Aug 2026: it is here" />
      </motion.div>

      <p className="absolute inset-x-0 top-full pt-4 text-micro text-fg-faint">
        <span className="readout">D6, 4.4–5.0 µm.</span> {DIFFERENCE.label}: grey is no change.
      </p>
    </div>
  );
}

function Note({ x, y, dy, text }: { x: number; y: number; dy: number; text: string }) {
  const dx = Math.abs(dy) * 1.1;
  return (
    <div className="absolute top-0 left-0" style={{ transform: `translate(${x}px, ${y}px)` }}>
      <svg className="absolute top-0 left-0 overflow-visible" width={1} height={1} aria-hidden>
        <polyline points={`6,${Math.sign(dy) * 6} ${dx},${dy} ${dx + 18},${dy}`} fill="none" stroke="var(--ink)" strokeWidth={1.25} />
      </svg>
      <span className="absolute text-meta font-medium whitespace-nowrap text-ink" style={{ left: dx + 24, top: dy, transform: "translateY(-50%)" }}>
        {text}
      </span>
    </div>
  );
}
