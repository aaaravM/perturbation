"use client";
// The globe of the home page story. At rest it turns slowly (the still image until WebGL is ready);
// "dive" (0 to 1) turns it to Barnard's Star and zooms in about 500 times, until the real SPHEREx
// frame of that patch fills the plate; "horizon" (0 to 1) brings it back as a vast globe low on the
// stage for the results. Everything that moves with the globe (the marker, the growing frame) is
// placed in the same animation frame as the WebGL draw, by transform only. Frames are drawn on
// demand: on scroll, and while the idle turn is visible; never off screen or in a hidden tab.

import * as React from "react";
import { useMotionValueEvent, type MotionValue } from "motion/react";
import { cn } from "@/lib/utils";
import { createGlobeRenderer, galacticToIcrs, project, viewBasis, type GlobeRenderer, type GlobeView } from "./globe-gl";
import { FIELD, GLOBE_STILL, HERO_VIEW, SKY_TEXTURE, VISITS } from "./story-data";
import { easeInOut, mix, smooth } from "./story-math";

/** Degrees per second of the idle turn. */
const IDLE_TURN = 1.1;
const wrap180 = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;

interface Box {
  cx: number;
  cy: number;
  /** Radius (rest) or side (plate). */
  s: number;
}

export interface StoryGlobeProps {
  /** stage: the canvas fills the stage and dives into plateRef; plate: the canvas is the plate. */
  mode: "stage" | "plate";
  dive: MotionValue<number>;
  horizon?: MotionValue<number>;
  /** 1 hides the globe and the frame (the next scenes cover the plate). */
  exit?: MotionValue<number>;
  /** Run WebGL. False: the still image only (server render, reduced motion, hidden layout). */
  active: boolean;
  /** Hold the idle turn (reduced motion). */
  still?: boolean;
  plateRef?: React.RefObject<HTMLElement | null>;
  /** Where the globe sits at rest (classes for the still image). */
  restClassName: string;
  /** Show Barnard's Star's marker on the still (the static story). */
  markStill?: boolean;
  className?: string;
}

export function StoryGlobe({
  mode,
  dive,
  horizon,
  exit,
  active,
  still = false,
  plateRef,
  restClassName,
  markStill = false,
  className,
}: StoryGlobeProps) {
  const box = React.useRef<HTMLDivElement>(null);
  const stillImg = React.useRef<HTMLImageElement>(null);
  const marker = React.useRef<HTMLDivElement>(null);
  const frame = React.useRef<HTMLDivElement>(null);
  const frameLabel = React.useRef<HTMLDivElement>(null);
  const request = React.useRef<() => void>(() => {});
  const [glReady, setGlReady] = React.useState(false);
  const [stillMark, setStillMark] = React.useState<{ x: number; y: number } | null>(null);

  // The still image's marker (no WebGL): Barnard's Star on the globe at rest.
  React.useEffect(() => {
    if (!markStill) return;
    const place = () => {
      const img = stillImg.current;
      const host = box.current;
      if (!img || !host) return;
      const r = img.getBoundingClientRect();
      const h = host.getBoundingClientRect();
      const view: GlobeView = { cx: r.left - h.left + r.width / 2, cy: r.top - h.top + r.height / 2, r: r.width / 2, ...HERO_VIEW, bright: 1 };
      setStillMark(project(view, FIELD.ra, FIELD.dec));
    };
    place();
    const ro = new ResizeObserver(place);
    if (box.current) ro.observe(box.current);
    return () => ro.disconnect();
  }, [markStill]);

  React.useEffect(() => {
    const host = box.current;
    if (!active || !host) return;
    // A fresh canvas (and WebGL context) per run: a context, once released, cannot be reused.
    const cv = document.createElement("canvas");
    cv.className = "absolute inset-0 size-full";
    cv.style.opacity = "0";
    host.insertBefore(cv, frame.current);
    const gl: GlobeRenderer | null = createGlobeRenderer(cv);
    if (!gl) {
      cv.remove();
      return;
    }

    let raf = 0;
    let onScreen = true;
    let width = 0;
    let height = 0;
    let rest: Box = { cx: 0, cy: 0, s: 1 };
    let plate: Box = { cx: 0, cy: 0, s: 1 };
    const t0 = performance.now();
    let cancelled = false;

    const measure = () => {
      const h = host.getBoundingClientRect();
      width = h.width;
      height = h.height;
      gl.resize(width, height, Math.min(window.devicePixelRatio || 1, mode === "stage" ? 1.5 : 2));
      const img = stillImg.current?.getBoundingClientRect();
      if (img && img.width) rest = { cx: img.left - h.left + img.width / 2, cy: img.top - h.top + img.height / 2, s: img.width / 2 };
      const p = mode === "plate" ? h : plateRef?.current?.getBoundingClientRect();
      if (p && p.width) plate = { cx: p.left - h.left + p.width / 2, cy: p.top - h.top + p.height / 2, s: p.width };
      if (frame.current) frame.current.style.width = frame.current.style.height = `${plate.s}px`;
    };

    const draw = (now: number): boolean => {
      const d = dive.get();
      const hz = horizon?.get() ?? 0;
      const gone = exit?.get() ?? 0;
      const turn = still ? 0 : ((now - t0) / 1000) * IDLE_TURN;
      let view: GlobeView;
      let alpha = 1;
      let field = 0;
      let markerAlpha = 0;
      let timed = false;

      if (hz > 0) {
        // The results: a vast globe low on the stage, the Milky Way along its rim.
        const r = Math.max(width, height) * 0.95;
        const centre = galacticToIcrs(mix(-28, 22, hz), 62);
        const base: GlobeView = { cx: width / 2, cy: height * 0.44 + r, r, ...centre, bright: 0.9 };
        const b = viewBasis(base.ra, base.dec);
        const g = galacticToIcrs(0, 0);
        const gr = [Math.cos(g.dec * (Math.PI / 180)) * Math.cos(g.ra * (Math.PI / 180)), Math.cos(g.dec * (Math.PI / 180)) * Math.sin(g.ra * (Math.PI / 180)), Math.sin(g.dec * (Math.PI / 180))];
        const x = gr[0] * b[0] + gr[1] * b[1] + gr[2] * b[2];
        const y = gr[0] * b[3] + gr[1] * b[4] + gr[2] * b[5];
        view = { ...base, roll: (Math.atan2(y, x) * 180) / Math.PI - 90 + mix(10, -10, hz) };
        alpha = smooth(hz / 0.18);
      } else {
        // Rest, then the dive. The view centre locks on the field by 40%; the zoom runs from 12%.
        const lock = easeInOut(d / 0.4);
        const move = easeInOut(d / 0.45);
        const zoom = easeInOut((d - 0.12) / 0.88);
        const idleRa = HERO_VIEW.ra - turn;
        const rEnd = plate.s / FIELD.widthRad;
        const r = rest.s * Math.exp(zoom * Math.log(Math.max(rEnd / rest.s, 1)));
        field = r * FIELD.widthRad;
        view = {
          cx: mix(rest.cx, plate.cx, move),
          cy: mix(rest.cy, plate.cy, move),
          r,
          ra: idleRa + wrap180(FIELD.ra - idleRa) * lock,
          dec: mix(HERO_VIEW.dec, FIELD.dec, lock),
          bright: 1 - 0.96 * smooth((field / plate.s - 0.04) / 0.3),
        };
        alpha = 1 - gone;
        markerAlpha = smooth((d - 0.04) / 0.08) * (1 - smooth((field - 18) / 40)) * (1 - gone);
        timed = !still && lock < 1 && alpha > 0;
      }

      if (alpha > 0.001) gl.draw(view);
      cv.style.opacity = String(alpha);
      if (stillImg.current) stillImg.current.style.opacity = gl.ready ? "0" : String((1 - smooth(d / 0.3)) * (hz > 0 ? 0 : 1));

      const m = marker.current;
      if (m) {
        const at = markerAlpha > 0.001 ? project(view, FIELD.ra, FIELD.dec) : null;
        m.style.opacity = at ? String(markerAlpha) : "0";
        if (at) m.style.transform = `translate3d(${at.x}px, ${at.y}px, 0)`;
      }
      const f = frame.current;
      const fl = frameLabel.current;
      if (f && fl) {
        const fa = hz > 0 ? 0 : smooth((field - 16) / 110) * (1 - gone);
        f.style.opacity = String(fa);
        f.style.visibility = fa > 0.001 ? "visible" : "hidden";
        const k = field / plate.s;
        f.style.transform = `translate3d(${plate.cx - plate.s / 2}px, ${plate.cy - plate.s / 2}px, 0) scale(${k})`;
        const la = fa * (1 - smooth((k - 0.45) / 0.3));
        fl.style.opacity = String(la);
        fl.style.transform = `translate3d(${plate.cx - field / 2}px, ${plate.cy - field / 2 - 8}px, 0) translateY(-100%)`;
      }
      return timed;
    };

    const tick = (now: number) => {
      raf = 0;
      const timed = draw(now);
      if (timed && onScreen && !document.hidden) raf = requestAnimationFrame(tick);
    };
    const schedule = () => {
      if (!raf && onScreen && !document.hidden) raf = requestAnimationFrame(tick);
    };
    request.current = schedule;

    const ro = new ResizeObserver(() => {
      measure();
      schedule();
    });
    ro.observe(host);
    const io = new IntersectionObserver(([e]) => {
      onScreen = e.isIntersecting;
      if (onScreen) schedule();
    });
    io.observe(host);
    const onVisibility = () => schedule();
    document.addEventListener("visibilitychange", onVisibility);

    const load = (src: string) =>
      new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image();
        img.decoding = "async";
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = src;
      });

    measure();
    load(SKY_TEXTURE.small)
      .then(async (img) => {
        if (cancelled) return;
        await img.decode?.().catch(() => {});
        gl.setTexture(img);
        setGlReady(true);
        schedule();
        // The sharper map for the zoom, once the page is idle (wide screens only).
        if (mode !== "stage" || gl.maxTexture < 4096) return;
        const idle = window.requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 1200));
        idle(() => {
          load(SKY_TEXTURE.large)
            .then((big) => {
              if (cancelled) return;
              gl.setTexture(big);
              schedule();
            })
            .catch(() => {});
        });
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      request.current = () => {};
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      gl.destroy();
      cv.remove();
      setGlReady(false);
    };
  }, [active, still, mode, dive, horizon, exit, plateRef]);

  useMotionValueEvent(dive, "change", () => request.current());
  useMotionValueEvent(horizon ?? dive, "change", () => request.current());
  useMotionValueEvent(exit ?? dive, "change", () => request.current());

  const first = VISITS[0];
  return (
    <div ref={box} aria-hidden className={cn("pointer-events-none absolute inset-0", className)} data-globe={glReady ? "ready" : "still"}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        ref={stillImg}
        src={GLOBE_STILL}
        alt=""
        decoding="async"
        fetchPriority={mode === "stage" ? "high" : "auto"}
        className={cn("absolute max-w-none transition-opacity duration-700", restClassName)}
      />

      {/* The patch, growing to fill the plate as the globe zooms in. */}
      <div ref={frame} className="invisible absolute top-0 left-0 origin-center opacity-0" style={{ willChange: "transform, opacity" }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={first.src} alt="" className="size-full [image-rendering:pixelated]" />
        <div className="absolute inset-0 ring-1 ring-white/25 ring-inset" />
      </div>
      <div ref={frameLabel} className="absolute top-0 left-0 text-micro whitespace-nowrap text-fg-dim opacity-0">
        Around Barnard&rsquo;s Star: a patch a third as wide as the full Moon
      </div>

      {/* Barnard's Star on the globe, while the globe turns towards it. */}
      <div ref={marker} className="absolute top-0 left-0 opacity-0" style={markStill && stillMark ? { opacity: 1, transform: `translate3d(${stillMark.x}px, ${stillMark.y}px, 0)` } : undefined}>
        <span className="absolute -top-3 -left-3 size-6 rounded-full border-[1.5px] border-accent" />
        <span className="absolute top-0 left-5 -translate-y-1/2 text-meta whitespace-nowrap text-fg">Barnard&rsquo;s Star</span>
      </div>
    </div>
  );
}
