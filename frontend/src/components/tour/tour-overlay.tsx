"use client";
// A guided tour on screen. Everything dims except the control being explained, which sits in a
// softly rounded cutout; a glass card beside it says what the control does and explains one word;
// the tour's pointer glides over and uses the control for real. The cutout and the card glide from
// step to step and follow their control when the window resizes or a pane scrolls. On phones the
// card docks at the bottom (at the top when the control is down there).
//
// Keys: Enter or Right arrow for the next step, Left arrow back, Esc closes. Focus moves to the card
// on every step, and steps are announced politely to screen readers. Reduced motion: nothing glides
// and the pointer has no press ring; each action happens at once.

import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { motion } from "motion/react";
import { Button } from "@/components/ui/button";
import { LiquidGlass } from "@/components/ui/liquid-glass";
import { prefersReducedMotionNow, useEffectiveReducedMotion } from "@/lib/preferences";
import { buildTour, type Rect, type TourStep } from "@/lib/tour-steps";
import { currentTourStep, noteTourStep, type TourId } from "@/lib/tour";
import { Aborted, TourCursor, runActs, runCleanup, sleep, type Pt } from "@/components/tour/tour-actions";

const Z = 2147482000;
/** Below this width the card is a sheet docked at the bottom (or top) of the screen. */
const SHEET_BELOW = 640;
const DIM = "rgb(3 3 3 / 0.64)";

type Shape = "rect" | "circle";
interface Box extends Rect {
  r: number;
}

function padded(r: Rect, shape: Shape): Box {
  if (shape === "circle") return { ...r, r: r.w / 2 };
  const p = 6;
  return { x: r.x - p, y: r.y - p, w: r.w + 2 * p, h: r.h + 2 * p, r: 10 };
}

/** The card beside the anchor, on the side with room; fully on screen. */
function placeCard(anchor: Rect | null, spot: Rect | null, cw: number, ch: number, vw: number, vh: number): Pt {
  const m = 12;
  if (vw < SHEET_BELOW) {
    // A sheet: at the bottom, unless what it explains is down there.
    const bottom = vh - ch - 8;
    const a = spot ?? anchor;
    if (a && a.y + a.h > bottom + 8 && a.y + a.h / 2 > vh * 0.5 && a.y > ch + 16) return { x: 8, y: 8 };
    return { x: 8, y: Math.max(8, bottom) };
  }
  if (!anchor) return { x: (vw - cw) / 2, y: Math.max(m, (vh - ch) / 2) };
  const gap = 18;
  const cy = Math.min(Math.max(anchor.y + anchor.h / 2 - ch / 2, m), vh - ch - m);
  const cx = Math.min(Math.max(anchor.x + anchor.w / 2 - cw / 2, m), vw - cw - m);
  const options: Pt[] = [];
  if (anchor.x + anchor.w + gap + cw <= vw - m) options.push({ x: anchor.x + anchor.w + gap, y: cy });
  if (anchor.x - gap - cw >= m) options.push({ x: anchor.x - gap - cw, y: cy });
  if (anchor.y + anchor.h + gap + ch <= vh - m) options.push({ x: cx, y: anchor.y + anchor.h + gap });
  if (anchor.y - gap - ch >= m) options.push({ x: cx, y: anchor.y - gap - ch });
  if (options.length) return options[0];
  // Too big to sit beside: over its lower right corner, inside the screen.
  return { x: vw - cw - m - 8, y: vh - ch - m - 8 };
}

export function TourOverlay({
  tour,
  onClose,
  onBegin,
}: {
  tour: TourId;
  /** done: finished or skipped; the host restores the tool and returns focus. */
  onClose: () => void;
  /** The first step of the tour proper has begun (after any question). */
  onBegin?: () => void;
}) {
  const reduced = useEffectiveReducedMotion();
  const [steps, setSteps] = useState<TourStep[]>(() => buildTour(tour, { reduced: prefersReducedMotionNow() }));
  // A remounted tour carries on where it was.
  const [index, setIndex] = useState(() => Math.max(0, steps.findIndex((s) => s.id === currentTourStep())));
  const step = steps[index];
  const last = index === steps.length - 1;
  const titleId = useId();
  const bodyId = useId();

  const rootEl = useRef<HTMLDivElement>(null);
  const spotEl = useRef<HTMLDivElement>(null);
  const blockEls = useRef<(HTMLDivElement | null)[]>([]);
  const cardEl = useRef<HTMLElement>(null);
  const primaryEl = useRef<HTMLButtonElement>(null);
  const cursorEl = useRef<HTMLDivElement>(null);
  const arrowEl = useRef<HTMLDivElement>(null);
  const ringEl = useRef<HTMLSpanElement>(null);
  const phase = useRef(0);
  const dir = useRef<1 | -1>(1);
  const stepRef = useRef(step);
  const reducedRef = useRef(reduced);
  const begun = useRef(false);
  /** The running step: stopping it aborts its pointer and runs its clean-up, once. */
  const running = useRef<{ stop: () => void } | null>(null);
  useEffect(() => {
    stepRef.current = step;
    reducedRef.current = reduced;
  });

  const cursor = useRef<TourCursor | null>(null);
  useEffect(() => {
    // The tool fills the window; if the page was scrolled towards the footer, it comes back into view.
    if (window.scrollY > 0) window.scrollTo(0, 0);
    if (!cursorEl.current || !arrowEl.current || !ringEl.current) return;
    cursor.current = new TourCursor(
      cursorEl.current,
      arrowEl.current,
      ringEl.current,
      () => reducedRef.current,
      () => {
        const b = primaryEl.current?.getBoundingClientRect();
        return b ? { x: b.left + b.width / 2, y: b.top + b.height / 2 } : { x: window.innerWidth / 2, y: window.innerHeight - 80 };
      },
    );
  }, []);

  // ------------------------------------------------------------------ moving between steps
  const go = useCallback(
    (to: number) => {
      if (to < 0) return;
      if (to >= steps.length) {
        running.current?.stop();
        onClose();
        return;
      }
      dir.current = to >= index ? 1 : -1;
      setIndex(to);
    },
    [index, steps.length, onClose],
  );
  const next = useCallback(() => go(index + 1), [go, index]);
  const back = useCallback(() => go(index - 1), [go, index]);

  // Each step: arrive (setup), focus and announce, then the pointer's demonstration. Leaving runs
  // the step's clean-up, so nothing it opened stays open.
  useEffect(() => {
    const s = steps[index];
    if (s.skip?.()) {
      const to = index + dir.current;
      if (to >= 0 && to < steps.length) setIndex(to);
      else if (to >= steps.length) onClose();
      return;
    }
    phase.current = 0;
    noteTourStep(s.id);
    const ctl = new AbortController();
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      ctl.abort();
      if (s.cleanup?.length) window.setTimeout(() => runCleanup(s.cleanup), 0);
    };
    running.current = { stop };
    const c = cursor.current;
    cardEl.current?.focus({ preventScroll: true });
    // data-busy: the step is still arriving or its pointer is still at work.
    const busy = (b: boolean) => rootEl.current?.setAttribute("data-busy", String(b));
    busy(true);
    (async () => {
      if (!c) return;
      // Out of React's commit first (and after the last step's clean-up), then the step.
      await sleep(0, ctl.signal);
      const env = { cursor: c, signal: ctl.signal, setPhase: (p: number) => (phase.current = p) };
      if (!s.confirm) await runActs(s.setup, { ...env, instant: true });
      // The tour proper has begun (the tool is ready): the host notes what it will put back.
      if (!s.confirm && !begun.current) {
        begun.current = true;
        onBegin?.();
      }
      // Let the spotlight arrive before the pointer sets off.
      await sleep(reducedRef.current ? 50 : 420, ctl.signal);
      await runActs(s.actions, { ...env, instant: false });
      // Whatever the action focused (a search box, a panel heading), the card takes focus back.
      if (cardEl.current && !cardEl.current.contains(document.activeElement)) cardEl.current.focus({ preventScroll: true });
      busy(false);
      await sleep(reducedRef.current ? 700 : 1100, ctl.signal);
      c.hide();
    })().catch((err: unknown) => {
      if (err instanceof Aborted) return;
      // A control that misbehaves never strands the tour: the card stays usable.
      console.warn("Tour step", s.id, err);
      busy(false);
      c?.hide();
    });
    return stop;
    // One run per step; steps only shrink when the question is answered.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, steps]);

  const close = useCallback(() => {
    running.current?.stop();
    cursor.current?.hide();
    onClose();
  }, [onClose]);

  const answer = useCallback(
    async (yes: boolean) => {
      if (!yes) {
        close();
        return;
      }
      const c = cursor.current;
      const s = stepRef.current;
      if (c) {
        const ctl = new AbortController();
        try {
          await runActs(s.setup, { cursor: c, signal: ctl.signal, instant: true, setPhase: () => {} });
        } catch {
          // the tour goes on regardless
        }
      }
      setSteps((list) => list.filter((x) => x.id !== s.id));
      setIndex(0);
    },
    [close],
  );

  // Esc closes from anywhere; the arrows and Enter work when focus is on the card or nowhere.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close();
        return;
      }
      const active = document.activeElement;
      if (active && active !== document.body && active !== document.documentElement) return;
      if (e.key === "ArrowRight" || e.key === "Enter") {
        e.preventDefault();
        if (!stepRef.current.confirm) next();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        back();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [close, next, back]);

  const onCardKey = (e: KeyboardEvent<HTMLElement>) => {
    if (step.confirm) return;
    const onControl = (e.target as HTMLElement).closest("button, a") !== null;
    if (e.key === "ArrowRight" || (e.key === "Enter" && !onControl)) {
      e.preventDefault();
      e.stopPropagation();
      next();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      e.stopPropagation();
      back();
    }
  };

  // ------------------------------------------------------------------ spotlight and card, per frame
  useEffect(() => {
    let raf = 0;
    let prev = performance.now();
    let spot: Box | null = null;
    let card: Pt | null = null;
    // Styles are written only when they change, so an idle tour costs nothing to paint.
    const written = new WeakMap<HTMLElement, Record<string, string>>();
    const put = (el: HTMLElement, prop: "transform" | "width" | "height" | "borderRadius" | "borderColor", value: string) => {
      const was = written.get(el) ?? {};
      if (was[prop] === value) return;
      el.style[prop] = value;
      written.set(el, { ...was, [prop]: value });
    };
    const px = (v: number) => `${Math.round(v * 10) / 10}px`;
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - prev) / 1000);
      prev = now;
      const s = stepRef.current;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const p = phase.current;
      const raw = s.spot?.(p) ?? null;
      const shape: Shape = s.shape?.(p) ?? "rect";
      const want: Box = raw ? padded(raw, shape) : { x: vw / 2, y: vh / 2, w: 0, h: 0, r: 0 };
      if (!spot) spot = reducedRef.current ? want : { x: 0, y: 0, w: vw, h: vh, r: 0 };
      const k = reducedRef.current ? 1 : 1 - Math.exp(-dt / 0.085);
      spot = {
        x: spot.x + (want.x - spot.x) * k,
        y: spot.y + (want.y - spot.y) * k,
        w: spot.w + (want.w - spot.w) * k,
        h: spot.h + (want.h - spot.h) * k,
        r: spot.r + (want.r - spot.r) * k,
      };
      const el = spotEl.current;
      if (el) {
        put(el, "transform", `translate3d(${px(spot.x)}, ${px(spot.y)}, 0)`);
        put(el, "width", px(Math.max(0, spot.w)));
        put(el, "height", px(Math.max(0, spot.h)));
        put(el, "borderRadius", px(spot.r));
        put(el, "borderColor", spot.w > 8 && raw ? "rgb(240 136 90 / 0.38)" : "transparent");
      }
      // Clicks outside the cutout are held back; inside it the control works as usual.
      const hole = raw ? spot : { x: vw / 2, y: vh / 2, w: 0, h: 0 };
      const [top, bottom, left, right] = blockEls.current;
      const set = (b: HTMLDivElement | null | undefined, x: number, y: number, w: number, h: number) => {
        if (!b) return;
        put(b, "transform", `translate3d(${px(x)}, ${px(y)}, 0)`);
        put(b, "width", px(Math.max(0, w)));
        put(b, "height", px(Math.max(0, h)));
      };
      set(top, 0, 0, vw, hole.y);
      set(bottom, 0, hole.y + hole.h, vw, vh - hole.y - hole.h);
      set(left, 0, hole.y, hole.x, hole.h);
      set(right, hole.x + hole.w, hole.y, vw - hole.x - hole.w, hole.h);

      const c = cardEl.current;
      if (c) {
        const anchor = s.anchor?.() ?? raw;
        const target = placeCard(anchor, raw, c.offsetWidth, c.offsetHeight, vw, vh);
        if (!card || reducedRef.current) card = target;
        else card = { x: card.x + (target.x - card.x) * k, y: card.y + (target.y - card.y) * k };
        put(c, "transform", `translate3d(${Math.round(card.x)}px, ${Math.round(card.y)}px, 0)`);
        if (c.style.opacity !== "1") {
          c.style.opacity = "1";
          if (!c.contains(document.activeElement)) c.focus({ preventScroll: true });
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const count = useMemo(() => {
    const real = steps.filter((s) => !s.confirm);
    const at = real.indexOf(step);
    return at < 0 ? null : { at: at + 1, of: real.length };
  }, [steps, step]);

  if (typeof document === "undefined") return null;
  return createPortal(
    <motion.div
      ref={rootEl}
      data-testid="tour"
      data-busy="true"
      data-tour-id={tour}
      data-step={step.id}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: reduced ? 0 : 0.28, ease: [0.16, 1, 0.3, 1] }}
      className="fixed inset-0"
      style={{ zIndex: Z, pointerEvents: "none" }}
    >
      {/* The dim, with its cutout. */}
      <div
        ref={spotEl}
        aria-hidden
        data-testid="tour-spotlight"
        className="absolute top-0 left-0 border"
        style={{ boxShadow: `0 0 0 200vmax ${DIM}`, borderColor: "transparent", pointerEvents: "none" }}
      />
      {[0, 1, 2, 3].map((i) => (
        <div
          key={i}
          aria-hidden
          ref={(el) => {
            blockEls.current[i] = el;
          }}
          className="absolute top-0 left-0"
          style={{ pointerEvents: "auto" }}
        />
      ))}

      <LiquidGlass
        ref={cardEl}
        as="section"
        role="dialog"
        aria-modal="false"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        tabIndex={-1}
        variant="regular"
        radius={18}
        refraction={false}
        onKeyDown={onCardKey}
        data-testid="tour-card"
        className="absolute top-0 left-0 flex w-[calc(100vw-16px)] flex-col outline-none sm:w-[344px]"
        style={{ pointerEvents: "auto", opacity: 0 }}
      >
        <div className="flex items-center gap-3 px-5 pt-4">
          {count ? (
            <>
              <p className="shrink-0 text-micro text-(--fg-glass-dim)" data-testid="tour-count">
                {count.at} of {count.of}
              </p>
              <span aria-hidden className="relative h-px flex-1 overflow-hidden rounded-full bg-white/[0.12]">
                <span
                  className="absolute inset-y-0 left-0 bg-accent/80 transition-[width] duration-500 ease-out-expo reduced:transition-none"
                  style={{ width: `${(count.at / count.of) * 100}%` }}
                />
              </span>
            </>
          ) : (
            <p className="text-micro text-(--fg-glass-dim)">Guided tour</p>
          )}
        </div>
        <motion.div
          key={step.id}
          initial={reduced ? false : { opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.26, ease: [0.16, 1, 0.3, 1] }}
          className="flex flex-col gap-1.5 px-5 pt-3"
        >
          <h2 id={titleId} className="text-body font-medium text-fg">
            {step.title}
          </h2>
          <p id={bodyId} className="text-ui text-pretty text-(--fg-glass-dim)">
            {step.body}
          </p>
          {step.defs.length > 0 && (
            <dl className="mt-2.5 flex flex-col gap-2.5 border-t border-white/[0.1] pt-3" data-testid="tour-defs">
              {step.defs.map((d) => (
                <div key={d.term} className="flex flex-col gap-0.5">
                  <dt className="text-meta font-medium text-fg">{d.term}</dt>
                  <dd className="text-meta text-pretty text-(--fg-glass-dim)">{d.text}</dd>
                </div>
              ))}
            </dl>
          )}
        </motion.div>
        <div className="flex items-center gap-2 px-5 pt-4 pb-4">
          {step.confirm ? (
            <div className="ml-auto flex items-center gap-2">
              <Button variant="ghost" size="sm" className="h-8 px-3 text-(--fg-glass-dim)" onClick={() => void answer(false)}>
                {step.confirm.no}
              </Button>
              <Button ref={primaryEl} size="sm" className="h-8 px-3" onClick={() => void answer(true)} data-testid="tour-yes">
                {step.confirm.yes}
              </Button>
            </div>
          ) : (
            <>
              {!last && (
                <button
                  type="button"
                  onClick={close}
                  className="-ml-2 h-8 rounded-md px-2 text-meta text-(--fg-glass-dim) transition-colors hover:text-fg"
                  data-testid="tour-skip"
                >
                  Skip tour
                </button>
              )}
              <div className="ml-auto flex items-center gap-2">
                {index > 0 && (
                  <Button variant="ghost" size="sm" className="h-8 px-3 text-(--fg-glass-dim)" onClick={back} data-testid="tour-back">
                    Back
                  </Button>
                )}
                {last && step.next ? (
                  <>
                    <Button variant="outline" size="sm" className="h-8 border-hair-strong px-3" onClick={close} data-testid="tour-finish">
                      Finish
                    </Button>
                    <Button asChild size="sm" className="h-8 px-3">
                      <Link href={step.next.href} onClick={close} data-testid="tour-next-tour">
                        {step.next.label}
                      </Link>
                    </Button>
                  </>
                ) : (
                  <Button ref={primaryEl} size="sm" className="h-8 px-3" onClick={last ? close : next} data-testid="tour-next">
                    {last ? "Finish" : "Next"}
                  </Button>
                )}
              </div>
            </>
          )}
        </div>
      </LiquidGlass>

      {/* The tour's pointer. */}
      <div
        ref={cursorEl}
        aria-hidden
        data-testid="tour-cursor"
        className="absolute top-0 left-0 transition-opacity duration-300 reduced:transition-none"
        style={{ opacity: 0, transform: "translate3d(-100px, -100px, 0)", pointerEvents: "none" }}
      >
        <span ref={ringEl} className="absolute -top-4 -left-4 size-8 rounded-full border border-white/80 opacity-0" />
        <div ref={arrowEl} className="origin-top-left drop-shadow-[0_2px_4px_rgb(0_0_0/0.6)]">
          <svg width="20" height="25" viewBox="0 0 20 25" className="-translate-x-px -translate-y-px">
            <path
              d="M1.5 1.5 L1.5 19.6 L6.1 15.4 L9.3 22.6 L12.5 21.2 L9.4 14.1 L15.6 14.1 Z"
              fill="#f4f3ef"
              stroke="#050505"
              strokeWidth="1.3"
              strokeLinejoin="round"
            />
          </svg>
        </div>
      </div>

      <p className="sr-only" aria-live="polite" data-testid="tour-announce">
        {count ? `Step ${count.at} of ${count.of}: ${step.title}.` : step.title}
      </p>
    </motion.div>,
    document.body,
  );
}
