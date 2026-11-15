"use client";
// Landing illustration: a blink comparator. Two simulated "plates" of the same star field
// alternate; one star has moved between them. An orange ring draws itself around it and a fine
// path traces the shift, then the next cycle picks another star. This is an illustration of the
// method (Clyde Tombaugh found Pluto this way in 1930), not SPHEREx data.
//
// Rendering: canvas 2D. Static stars are prerendered into three depth layers (parallax on
// pointer move); only the candidate movers are drawn per frame. The SVG annotation is driven
// from the same clock so ring, path and plate flips stay in sync, and it follows the movers'
// parallax layer. Honours prefers-reduced-motion (static annotated plate, no parallax), can be
// paused or flipped by hand, and stops drawing when off screen.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { PauseIcon, PlayIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  MOVER_LAYER,
  createField,
  drawStar,
  makeGrain,
  makeSprites,
  renderLayers,
  type Mover,
} from "@/components/landing/star-field";

type Plate = "A" | "B";

/** Seeded so the field is identical on every load (18 Feb 1930: Pluto spotted on the blink). */
const SEED = 19300218;

// Timeline, in ms. Ten plates per cycle (A B A B ...), so every cycle starts on plate A and the
// switch to a new mover is invisible.
const PLATE_MS = 1000;
const PLATES_PER_CYCLE = 10;
const CYCLE_MS = PLATE_MS * PLATES_PER_CYCLE;
const RING_START = 3150;
const RING_MS = 1100;
const PATH_START = 3750;
const PATH_MS = 800;
const TICKS_START = 4350;
const TICKS_MS = 500;
const FADE_START = 8350;
const FADE_MS = 900;
/** Reduced motion: plate B with the annotation fully drawn. */
const STATIC_T = 5500;

const PARALLAX_PX = 7;
const LAYER_DEPTH = [0.22, 0.55, 1] as const;
const PAD = 10;
const PARALLAX_TAU_MS = 240;
const RING_GAP = 15;

const REDUCED_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeReduced(onChange: () => void) {
  const media = window.matchMedia(REDUCED_QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}
const getReduced = () => window.matchMedia(REDUCED_QUERY).matches;
const getReducedServer = () => false;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const progress = (t: number, start: number, duration: number) => clamp01((t - start) / duration);
const easeOutExpo = (v: number) => (v >= 1 ? 1 : 1 - Math.pow(2, -10 * v));
const easeInOutCubic = (v: number) => (v < 0.5 ? 4 * v * v * v : 1 - Math.pow(-2 * v + 2, 3) / 2);

function annotationAt(t: number) {
  const ringP = progress(t, RING_START, RING_MS);
  return {
    ring: easeInOutCubic(ringP),
    ringScale: 1 + 0.45 * (1 - easeOutExpo(progress(t, RING_START, RING_MS + 250))),
    path: easeInOutCubic(progress(t, PATH_START, PATH_MS)),
    ticks: easeOutExpo(progress(t, TICKS_START, TICKS_MS)),
    opacity: Math.min(
      progress(t, RING_START, 220),
      1 - easeInOutCubic(progress(t, FADE_START, FADE_MS)),
    ),
  };
}

interface ControlsState {
  playing: boolean;
  manualPlate: Plate | null;
  reduced: boolean;
}

export function BlinkComparator({ className }: { className?: string }) {
  const frameRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<SVGGElement>(null);
  const ringRef = useRef<SVGCircleElement>(null);
  const pathRef = useRef<SVGLineElement>(null);
  const headRef = useRef<SVGPathElement>(null);
  const ghostRef = useRef<SVGCircleElement>(null);
  const ticksRef = useRef<SVGGElement>(null);

  const reduced = useSyncExternalStore(subscribeReduced, getReduced, getReducedServer);
  const [userPlaying, setUserPlaying] = useState<boolean | null>(null);
  const [manualPlate, setManualPlate] = useState<Plate | null>(null);
  const [plate, setPlate] = useState<Plate>("A");
  const playing = userPlaying ?? !reduced;

  const elapsedRef = useRef(0);
  const controlsRef = useRef<ControlsState>({ playing, manualPlate, reduced });
  useEffect(() => {
    controlsRef.current = { playing, manualPlate, reduced };
  }, [playing, manualPlate, reduced]);

  useEffect(() => {
    const frame = frameRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!frame || !canvas || !ctx) return;

    const field = createField(SEED);
    const sprites = makeSprites();
    const grain = [makeGrain(SEED + 1), makeGrain(SEED + 2)].map((g) => ctx.createPattern(g, "repeat"));
    const fine = window.matchMedia("(pointer: fine)");

    let width = 0;
    let height = 0;
    let dpr = 1;
    let layers: HTMLCanvasElement[] = [];
    let raf = 0;
    let last = performance.now();
    let visible = true;
    let disposed = false;
    let dirty = true;
    let shownPlate: Plate = "A";
    let moverIndex = -1;
    let geometryKey = "";
    const pointer = { tx: 0, ty: 0, x: 0, y: 0 };

    if (window.matchMedia(REDUCED_QUERY).matches) elapsedRef.current = STATIC_T;

    const moverAt = (cycle: number): Mover => field.movers[cycle % field.movers.length];

    const placeAnnotation = (m: Mover) => {
      const ax = m.x * width;
      const ay = m.y * height;
      const bx = ax + m.dx;
      const by = ay + m.dy;
      const d = Math.hypot(m.dx, m.dy);
      const ux = m.dx / d;
      const uy = m.dy / d;
      const cx = (ax + bx) / 2;
      const cy = (ay + by) / 2;
      const r = d / 2 + RING_GAP;
      const ring = ringRef.current;
      const path = pathRef.current;
      const head = headRef.current;
      const ghost = ghostRef.current;
      const ticks = ticksRef.current;
      if (!ring || !path || !head || !ghost || !ticks) return;
      ring.setAttribute("cx", cx.toFixed(2));
      ring.setAttribute("cy", cy.toFixed(2));
      ring.dataset.r = r.toFixed(2);
      ring.setAttribute("transform", `rotate(-118 ${cx.toFixed(2)} ${cy.toFixed(2)})`);
      const x1 = ax + ux * 4.75;
      const y1 = ay + uy * 4.75;
      const x2 = bx - ux * 3.25;
      const y2 = by - uy * 3.25;
      path.setAttribute("x1", x1.toFixed(2));
      path.setAttribute("y1", y1.toFixed(2));
      path.setAttribute("x2", x2.toFixed(2));
      path.setAttribute("y2", y2.toFixed(2));
      const a = Math.atan2(uy, ux);
      const hl = 3.4;
      const p1 = [x2 - hl * Math.cos(a - 0.55), y2 - hl * Math.sin(a - 0.55)];
      const p2 = [x2 - hl * Math.cos(a + 0.55), y2 - hl * Math.sin(a + 0.55)];
      head.setAttribute(
        "d",
        `M${p1[0].toFixed(2)} ${p1[1].toFixed(2)}L${x2.toFixed(2)} ${y2.toFixed(2)}L${p2[0].toFixed(2)} ${p2[1].toFixed(2)}`,
      );
      ghost.setAttribute("cx", ax.toFixed(2));
      ghost.setAttribute("cy", ay.toFixed(2));
      // Finder-chart ticks pointing in from the west and the north.
      const [west, north] = Array.from(ticks.children) as SVGLineElement[];
      west.setAttribute("x1", (cx - r - 10).toFixed(2));
      west.setAttribute("x2", (cx - r - 4).toFixed(2));
      west.setAttribute("y1", cy.toFixed(2));
      west.setAttribute("y2", cy.toFixed(2));
      north.setAttribute("x1", cx.toFixed(2));
      north.setAttribute("x2", cx.toFixed(2));
      north.setAttribute("y1", (cy - r - 10).toFixed(2));
      north.setAttribute("y2", (cy - r - 4).toFixed(2));
    };

    const updateAnnotation = (t: number) => {
      const ring = ringRef.current;
      const overlay = overlayRef.current;
      if (!ring || !overlay) return;
      const a = annotationAt(t);
      overlay.setAttribute("opacity", a.opacity.toFixed(3));
      ring.setAttribute("r", (Number(ring.dataset.r ?? 0) * a.ringScale).toFixed(2));
      // A fully drawn ring drops the dash: Chrome leaves a hairline gap at the seam otherwise.
      ring.setAttribute("stroke-dasharray", a.ring >= 0.999 ? "none" : "1 1");
      ring.setAttribute("stroke-dashoffset", (1 - a.ring).toFixed(4));
      pathRef.current?.setAttribute("stroke-dashoffset", (1 - a.path).toFixed(4));
      pathRef.current?.setAttribute("opacity", a.path > 0 ? "1" : "0");
      headRef.current?.setAttribute("opacity", clamp01((a.path - 0.85) / 0.15).toFixed(3));
      ghostRef.current?.setAttribute("opacity", a.path.toFixed(3));
      ticksRef.current?.setAttribute("opacity", a.ticks.toFixed(3));
    };

    const draw = (plateNow: Plate, mover: number) => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
      ctx.fillStyle = "#030303";
      ctx.fillRect(0, 0, width, height);
      ctx.globalCompositeOperation = "lighter";
      layers.forEach((layer, i) => {
        const ox = -pointer.x * PARALLAX_PX * LAYER_DEPTH[i];
        const oy = -pointer.y * PARALLAX_PX * LAYER_DEPTH[i];
        ctx.globalAlpha = 1;
        ctx.drawImage(layer, -PAD + ox, -PAD + oy, width + PAD * 2, height + PAD * 2);
      });
      const mox = -pointer.x * PARALLAX_PX * LAYER_DEPTH[MOVER_LAYER];
      const moy = -pointer.y * PARALLAX_PX * LAYER_DEPTH[MOVER_LAYER];
      field.movers.forEach((m, i) => {
        const shifted = i === mover && plateNow === "B";
        const x = m.x * width + (shifted ? m.dx : 0) + mox;
        const y = m.y * height + (shifted ? m.dy : 0) + moy;
        drawStar(ctx, sprites, m.lum, m.tint, x, y);
      });
      const pattern = grain[plateNow === "A" ? 0 : 1];
      if (pattern) {
        ctx.globalAlpha = 0.55;
        ctx.fillStyle = pattern;
        ctx.fillRect(0, 0, width, height);
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
      overlayRef.current?.setAttribute("transform", `translate(${mox.toFixed(2)} ${moy.toFixed(2)})`);
    };

    const tick = (now: number) => {
      raf = 0;
      if (disposed || !visible || width === 0) return;
      // rAF timestamps can precede the performance.now() taken in start(): clamp to >= 0.
      const dt = Math.max(0, Math.min(100, now - last));
      last = now;
      const { playing: isPlaying, manualPlate: manual, reduced: isReduced } = controlsRef.current;
      if (isPlaying) elapsedRef.current += dt;

      const elapsed = Math.max(0, elapsedRef.current);
      const cycle = Math.floor(elapsed / CYCLE_MS);
      const t = elapsed - cycle * CYCLE_MS;
      const timelinePlate: Plate = Math.floor(t / PLATE_MS) % 2 === 0 ? "A" : "B";
      const plateNow = manual ?? timelinePlate;
      const mover = cycle % field.movers.length;

      // Parallax: eased towards the pointer target; off for reduced motion and coarse pointers.
      const wantParallax = !isReduced && fine.matches;
      const tx = wantParallax ? pointer.tx : 0;
      const ty = wantParallax ? pointer.ty : 0;
      const k = 1 - Math.exp(-dt / PARALLAX_TAU_MS);
      const nx = pointer.x + (tx - pointer.x) * k;
      const ny = pointer.y + (ty - pointer.y) * k;
      if (Math.abs(nx - pointer.x) > 1e-4 || Math.abs(ny - pointer.y) > 1e-4) {
        pointer.x = nx;
        pointer.y = ny;
        dirty = true;
      }

      const key = `${mover}:${width}x${height}`;
      if (key !== geometryKey) {
        geometryKey = key;
        placeAnnotation(moverAt(cycle));
      }
      if (plateNow !== shownPlate || mover !== moverIndex) dirty = true;
      if (dirty) {
        draw(plateNow, mover);
        dirty = false;
      }
      updateAnnotation(t);
      if (plateNow !== shownPlate) setPlate(plateNow);
      shownPlate = plateNow;
      moverIndex = mover;
      raf = requestAnimationFrame(tick);
    };

    const start = () => {
      if (raf || disposed) return;
      last = performance.now();
      raf = requestAnimationFrame(tick);
    };

    const resize = () => {
      const rect = frame.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return;
      width = rect.width;
      height = rect.height;
      dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      layers = renderLayers(field, sprites, width, height, dpr, PAD);
      dirty = true;
      geometryKey = "";
      start();
    };

    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerType !== "mouse" && event.pointerType !== "pen") return;
      const rect = frame.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      pointer.tx = Math.max(-1, Math.min(1, (event.clientX - cx) / (window.innerWidth / 2)));
      pointer.ty = Math.max(-1, Math.min(1, (event.clientY - cy) / (window.innerHeight / 2)));
    };
    const onPointerLeave = () => {
      pointer.tx = 0;
      pointer.ty = 0;
    };

    const ro = new ResizeObserver(resize);
    ro.observe(frame);
    const io = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? true;
      if (visible) start();
    });
    io.observe(frame);
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    document.documentElement.addEventListener("pointerleave", onPointerLeave);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      window.removeEventListener("pointermove", onPointerMove);
      document.documentElement.removeEventListener("pointerleave", onPointerLeave);
      layers = [];
    };
  }, []);

  const togglePlaying = useCallback(() => {
    if (playing) {
      setUserPlaying(false);
      return;
    }
    if (reduced && elapsedRef.current < STATIC_T) elapsedRef.current = STATIC_T;
    setManualPlate(null);
    setUserPlaying(true);
  }, [playing, reduced]);

  const showPlate = useCallback((next: Plate) => {
    setUserPlaying(false);
    setManualPlate(next);
  }, []);

  return (
    <figure
      data-testid="blink-hero"
      className={cn("grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-[1fr_auto]", className)}
    >
      <div
        ref={frameRef}
        role="img"
        aria-label="Animated illustration: two simulated plates of the same star field alternate. One star shifts between them and is circled."
        className="relative aspect-[4/3] w-full overflow-hidden rounded-md border border-hair bg-[#030303] sm:col-span-2 sm:aspect-[3/2] lg:aspect-[4/3]"
      >
        <canvas ref={canvasRef} aria-hidden className="absolute inset-0 size-full" />
        {/* Soft vignette, as on a photographic plate. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(120%_95%_at_50%_45%,transparent_55%,rgb(0_0_0/0.55)_100%)]"
        />
        <svg aria-hidden className="pointer-events-none absolute inset-0 size-full overflow-visible">
          <g ref={overlayRef} opacity={0}>
            <circle
              ref={ghostRef}
              r={3.75}
              fill="none"
              stroke="var(--accent-muted)"
              strokeWidth={1}
              opacity={0}
            />
            <line
              ref={pathRef}
              stroke="var(--accent)"
              strokeWidth={1}
              pathLength={1}
              strokeDasharray="1 1"
              strokeDashoffset={1}
              opacity={0}
            />
            <path
              ref={headRef}
              fill="none"
              stroke="var(--accent)"
              strokeWidth={1}
              strokeLinecap="round"
              strokeLinejoin="round"
              opacity={0}
            />
            <circle
              ref={ringRef}
              fill="none"
              stroke="var(--accent)"
              strokeWidth={1.25}
              pathLength={1}
              strokeDasharray="1 1"
              strokeDashoffset={1}
            />
            <g ref={ticksRef} stroke="var(--accent)" strokeWidth={1.25} strokeLinecap="round" opacity={0}>
              <line />
              <line />
            </g>
          </g>
        </svg>

        {/* Registration marks in the plate corners. */}
        <span aria-hidden className="pointer-events-none absolute top-2.5 left-2.5 size-3 border-t border-l border-hair-strong" />
        <span aria-hidden className="pointer-events-none absolute top-2.5 right-2.5 size-3 border-t border-r border-hair-strong" />
        <span aria-hidden className="pointer-events-none absolute bottom-2.5 left-2.5 size-3 border-b border-l border-hair-strong" />
        <span aria-hidden className="pointer-events-none absolute right-2.5 bottom-2.5 size-3 border-r border-b border-hair-strong" />

        <div className="pointer-events-none absolute top-3.5 left-4 flex items-baseline gap-2.5 rounded-[3px] bg-[#030303]/80 px-1.5 py-0.5 text-micro">
          <span className="font-medium text-fg">Plate {plate}</span>
          <span className="readout text-fg-dim">{plate === "A" ? "day 0" : "day 6"}</span>
        </div>
      </div>

      <div
        role="group"
        aria-label="Blink controls"
        className="flex items-center gap-2 sm:col-start-2 sm:row-start-2 sm:justify-end"
      >
        <div className="inline-flex rounded-md border border-hair p-0.5">
          {(["A", "B"] as const).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => showPlate(p)}
              aria-pressed={plate === p}
              // Plain string, not cn(): cn would treat text-micro as a colour and drop one. No
              // colour transition: the control flips as crisply as the plates do.
              className={`h-7 min-w-8 rounded-[4px] px-2 text-micro font-medium ${
                plate === p ? "bg-white/[0.08] text-fg" : "text-fg-dim hover:text-fg"
              }`}
            >
              <span className="sr-only">Show plate </span>
              {p}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={togglePlaying}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-hair px-2.5 text-micro text-fg-dim transition-colors duration-200 hover:border-hair-strong hover:text-fg"
        >
          {playing ? (
            <PauseIcon aria-hidden className="size-3.5" />
          ) : (
            <PlayIcon aria-hidden className="size-3.5" />
          )}
          {playing ? "Pause" : "Play"}
          <span className="sr-only"> the blink</span>
        </button>
      </div>

      <figcaption className="text-meta text-pretty text-fg-dim sm:col-start-1 sm:row-start-2 sm:max-w-[52ch]">
        <span className="text-fg">Illustration:</span> a simulated star field blinking between two
        plates taken days apart, the method Clyde Tombaugh used to find Pluto in 1930. Not SPHEREx
        data.
      </figcaption>
    </figure>
  );
}
