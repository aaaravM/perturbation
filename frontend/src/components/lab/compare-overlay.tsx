"use client";
// Compare two frames of the same field: a wipe (frame A under frame B, with a divider you drag
// across the field, both pinned to the sky as you pan and zoom) or a split (the two frames side
// by side at the same scale, with the pointer mirrored in both).

import { useEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import type { AladinSession } from "@/components/sky/aladin-session";
import { extra } from "@/components/sky/aladin-extra";
import { pixelToWorld, type TanGrid } from "@/lib/lab-wcs";
import { offsetArcsec } from "@/lib/lab-coords";
import type { SkyView } from "@/components/sky/aladin-view";
import type { BlinkFrame } from "@/lib/lab-field";
import type { CompareMode } from "@/components/lab/timeline";

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

function useFootprint(session: AladinSession | null, grid: TanGrid | null, view: SkyView): Rect | null {
  const [rect, setRect] = useState<Rect | null>(null);
  // The viewer can change size while the view stays put (a Lab pane shown or hidden).
  const [size, setSize] = useState("");
  useEffect(() => {
    const host = session?.host;
    if (!host || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setSize(`${host.clientWidth}x${host.clientHeight}`));
    observer.observe(host);
    return () => observer.disconnect();
  }, [session]);
  useEffect(() => {
    if (!session || !grid) return;
    const { aladin } = extra(session);
    const id = requestAnimationFrame(() => {
      // Analytic placement (north up, east left, small field): Aladin's world2pix returns
      // nothing for points outside the canvas, and the field's corners often are.
      const w = session.host.clientWidth;
      const h = session.host.clientHeight;
      const [fovX] = aladin.getFov();
      const [ra, dec] = aladin.getRaDec();
      if (!w || !h || !Number.isFinite(fovX) || fovX <= 0) return;
      const pxPerDeg = w / fovX;
      const centre = pixelToWorld(grid, (grid.width + 1) / 2, (grid.height + 1) / 2);
      const o = offsetArcsec({ ra, dec }, centre);
      const cx = w / 2 - (o.east / 3600) * pxPerDeg;
      const cy = h / 2 - (o.north / 3600) * pxPerDeg;
      const halfW = ((grid.width * Math.abs(grid.cd11)) / 2) * pxPerDeg;
      const halfH = ((grid.height * Math.abs(grid.cd22)) / 2) * pxPerDeg;
      setRect({ left: cx - halfW, top: cy - halfH, width: 2 * halfW, height: 2 * halfH });
    });
    return () => cancelAnimationFrame(id);
  }, [session, grid, view.ra, view.dec, view.fov, size]);
  return session && grid ? rect : null;
}

export function CompareOverlay({
  mode,
  session,
  grid,
  view,
  a,
  b,
  urlA,
  urlB,
}: {
  mode: CompareMode;
  session: AladinSession | null;
  grid: TanGrid | null;
  view: SkyView;
  a: BlinkFrame | null;
  b: BlinkFrame | null;
  urlA: string | null;
  urlB: string | null;
}) {
  if (mode === "off" || !a || !b || !urlA || !urlB) return null;
  return mode === "wipe" ? (
    <Wipe session={session} grid={grid} view={view} a={a} b={b} urlA={urlA} urlB={urlB} />
  ) : (
    <Split a={a} b={b} urlA={urlA} urlB={urlB} />
  );
}

function Wipe({
  session,
  grid,
  view,
  a,
  b,
  urlA,
  urlB,
}: {
  session: AladinSession | null;
  grid: TanGrid | null;
  view: SkyView;
  a: BlinkFrame;
  b: BlinkFrame;
  urlA: string;
  urlB: string;
}) {
  const reduce = useReducedMotion();
  const rect = useFootprint(session, grid, view);
  const hostRef = useRef<HTMLDivElement>(null);
  const [split, setSplit] = useState<number | null>(null);
  const dragging = useRef(false);
  const x = split ?? (rect ? rect.left + rect.width / 2 : 0);
  const clip = rect ? Math.min(Math.max(x - rect.left, 0), rect.width) : 0;

  const move = (clientX: number) => {
    const box = hostRef.current?.getBoundingClientRect();
    if (!box) return;
    setSplit(Math.min(Math.max(clientX - box.left, 0), box.width));
  };

  return (
    <div ref={hostRef} className="pointer-events-none absolute inset-0 z-10 overflow-hidden" data-testid="compare-wipe">
      {rect && (
        <motion.div
          initial={reduce ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.25 }}
          className="absolute"
          style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={urlA} alt={`Frame A: ${a.label}`} className="absolute inset-0 size-full [image-rendering:pixelated]" draggable={false} />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={urlB}
            alt={`Frame B: ${b.label}`}
            className="absolute inset-0 size-full [image-rendering:pixelated]"
            style={{ clipPath: `inset(0 0 0 ${clip}px)` }}
            draggable={false}
          />
        </motion.div>
      )}
      <div
        role="slider"
        tabIndex={0}
        aria-label="Wipe divider between the two frames"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={rect && rect.width ? Math.round((clip / rect.width) * 100) : 50}
        aria-valuetext={`${a.label} on the left, ${b.label} on the right`}
        data-testid="wipe-divider"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          dragging.current = true;
          move(e.clientX);
        }}
        onPointerMove={(e) => dragging.current && move(e.clientX)}
        onPointerUp={() => (dragging.current = false)}
        onPointerCancel={() => (dragging.current = false)}
        onKeyDown={(e) => {
          if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
          e.preventDefault();
          e.stopPropagation();
          setSplit(x + (e.key === "ArrowLeft" ? -12 : 12));
        }}
        className="pointer-events-auto absolute inset-y-0 z-10 -ml-3 w-6 cursor-ew-resize outline-none focus-visible:[&>span]:bg-accent"
        style={{ left: x }}
      >
        <span aria-hidden className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-fg/80" />
        <span aria-hidden className="absolute top-1/2 left-1/2 grid h-7 w-4 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-[4px] border border-hair-strong bg-ink">
          <span className="h-3 w-px bg-fg-dim" />
        </span>
      </div>
      <div className="absolute top-2 flex -translate-x-full flex-col items-end pr-3 text-right" style={{ left: x }}>
        <span className="text-micro text-fg-dim">A</span>
        <span className="readout text-meta text-fg">{a.label}</span>
      </div>
      <div className="absolute top-2 flex flex-col pl-3" style={{ left: x }}>
        <span className="text-micro text-fg-dim">B</span>
        <span className="readout text-meta text-fg">{b.label}</span>
      </div>
    </div>
  );
}

function Split({ a, b, urlA, urlB }: { a: BlinkFrame; b: BlinkFrame; urlA: string; urlB: string }) {
  const reduce = useReducedMotion();
  const [pt, setPt] = useState<{ u: number; v: number } | null>(null);
  const panel = (frame: BlinkFrame, url: string, side: "A" | "B") => (
    <figure className="relative flex min-h-0 min-w-0 flex-col items-center justify-center gap-2 p-3">
      <div
        className="relative aspect-square max-h-full w-full max-w-full overflow-hidden rounded-[4px] ring-1 ring-hair"
        onPointerMove={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          setPt({ u: (e.clientX - box.left) / box.width, v: (e.clientY - box.top) / box.height });
        }}
        onPointerLeave={() => setPt(null)}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={url} alt={`Frame ${side}: ${frame.label}`} className="absolute inset-0 size-full [image-rendering:pixelated]" draggable={false} />
        {pt && (
          <>
            <span aria-hidden className="pointer-events-none absolute inset-x-0 h-px bg-accent/70" style={{ top: `${pt.v * 100}%` }} />
            <span aria-hidden className="pointer-events-none absolute inset-y-0 w-px bg-accent/70" style={{ left: `${pt.u * 100}%` }} />
          </>
        )}
      </div>
      <figcaption className="text-micro text-fg-dim">
        <span className="text-fg-faint">{side}</span> <span className="readout text-fg">{frame.label}</span>
        {frame.detail && frame.detail.length <= 4 ? <span className="readout"> · {frame.detail}</span> : null}
      </figcaption>
    </figure>
  );
  return (
    <motion.div
      initial={reduce ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.25 }}
      className="absolute inset-0 z-10 grid grid-cols-2 bg-ink"
      data-testid="compare-split"
    >
      {panel(a, urlA, "A")}
      <span aria-hidden className="absolute inset-y-3 left-1/2 w-px bg-hair" />
      {panel(b, urlB, "B")}
    </motion.div>
  );
}
