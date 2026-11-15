"use client";
// Motion compass: measured proper motion (accent, with its 1-sigma error ellipse) against the
// catalogue value (grey, dashed), drawn as on the sky: north up, east to the left.

import { motion, useReducedMotion } from "motion/react";

export function MotionCompass({
  measured,
  catalog,
}: {
  measured: { pmra: number; pmdec: number; pmra_err: number; pmdec_err: number } | null;
  catalog: { pmra: number; pmdec: number } | null;
}) {
  const reduce = useReducedMotion();
  const size = 132;
  const c = size / 2;
  const radius = 48;
  const longest = Math.max(
    1,
    measured ? Math.hypot(measured.pmra, measured.pmdec) : 0,
    catalog ? Math.hypot(catalog.pmra, catalog.pmdec) : 0,
  );
  const s = radius / longest;
  // East is left on the sky: +pmra (east) goes to -x.
  const tip = (pmra: number, pmdec: number) => ({ x: c - pmra * s, y: c - pmdec * s });
  const draw = (delay: number) =>
    reduce
      ? { initial: false as const, animate: { pathLength: 1, opacity: 1 } }
      : {
          initial: { pathLength: 0, opacity: 0 },
          animate: { pathLength: 1, opacity: 1 },
          transition: { duration: 0.9, delay, ease: [0.16, 1, 0.3, 1] as const },
        };
  const arrowHead = (from: { x: number; y: number }, to: { x: number; y: number }) => {
    const a = Math.atan2(to.y - from.y, to.x - from.x);
    const l = 6;
    const p1 = { x: to.x - l * Math.cos(a - 0.45), y: to.y - l * Math.sin(a - 0.45) };
    const p2 = { x: to.x - l * Math.cos(a + 0.45), y: to.y - l * Math.sin(a + 0.45) };
    return `M${p1.x},${p1.y} L${to.x},${to.y} L${p2.x},${p2.y}`;
  };
  const m = measured ? tip(measured.pmra, measured.pmdec) : null;
  const k = catalog ? tip(catalog.pmra, catalog.pmdec) : null;
  const origin = { x: c, y: c };

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label="Proper motion on the sky, north up and east left: measured in orange, catalogue in grey"
      className="shrink-0"
    >
      <circle cx={c} cy={c} r={radius} fill="none" stroke="var(--hair-strong)" />
      <circle cx={c} cy={c} r={radius / 2} fill="none" stroke="var(--hair)" />
      <line x1={c} y1={c - radius - 6} x2={c} y2={c + radius + 6} stroke="var(--hair)" />
      <line x1={c - radius - 6} y1={c} x2={c + radius + 6} y2={c} stroke="var(--hair)" />
      <text x={c} y={9} textAnchor="middle" className="fill-fg-faint text-[10px]">
        N
      </text>
      <text x={4} y={c + 3.5} className="fill-fg-faint text-[10px]">
        E
      </text>
      {k && (
        <g>
          <motion.path
            d={`M${c},${c} L${k.x},${k.y}`}
            stroke="var(--fg-dim)"
            strokeWidth={1.25}
            strokeDasharray="3 3"
            fill="none"
            {...draw(0.05)}
          />
          <motion.path d={arrowHead(origin, k)} stroke="var(--fg-dim)" strokeWidth={1.25} fill="none" {...draw(0.4)} />
        </g>
      )}
      {m && measured && (
        <g>
          <motion.ellipse
            cx={m.x}
            cy={m.y}
            rx={Math.max(measured.pmra_err * s, 1.5)}
            ry={Math.max(measured.pmdec_err * s, 1.5)}
            fill="var(--accent-faint)"
            stroke="var(--accent-muted)"
            strokeWidth={1}
            initial={reduce ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.5, delay: 0.75 }}
          />
          <motion.path d={`M${c},${c} L${m.x},${m.y}`} stroke="var(--accent)" strokeWidth={1.75} fill="none" {...draw(0.25)} />
          <motion.path d={arrowHead(origin, m)} stroke="var(--accent)" strokeWidth={1.75} fill="none" {...draw(0.6)} />
        </g>
      )}
      <circle cx={c} cy={c} r={2} fill="var(--fg)" />
    </svg>
  );
}
