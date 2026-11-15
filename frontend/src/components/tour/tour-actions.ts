// What the tour's pointer does: glide along a gentle curve to a control, press it, and then use
// the control for real. A click is the full pointer, mouse and click sequence on the element; a
// drag sends the same pointer events a mouse drag would, so the Sky globe turns through its own
// handlers; typing sets the box's value one character at a time, as a keyboard would. With reduced
// motion nothing glides and there is no press ring: the pointer appears on the control and the
// action happens at once.

import { animate } from "motion/react";
import { find, type Rect, type TourAct, type TourSel } from "@/lib/tour-steps";

export interface Pt {
  x: number;
  y: number;
}

export class Aborted extends Error {
  constructor() {
    super("aborted");
  }
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Aborted());
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(new Aborted());
    };
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function waitFor<T>(get: () => T | null | undefined | false, timeout: number, signal: AbortSignal): Promise<T | null> {
  const end = performance.now() + timeout;
  for (;;) {
    const v = get();
    if (v) return v;
    if (performance.now() >= end) return null;
    await sleep(80, signal);
  }
}

/** An animation that stops when the signal aborts. */
async function play(controls: ReturnType<typeof animate>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    controls.stop();
    throw new Aborted();
  }
  const onAbort = () => controls.stop();
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    await controls;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  if (signal.aborted) throw new Aborted();
}

const pointIn = (r: Rect, at: [number, number] = [0.5, 0.5]): Pt => ({ x: r.x + r.w * at[0], y: r.y + r.h * at[1] });

function pointOf(el: Element, at?: [number, number]): Pt {
  const r = el.getBoundingClientRect();
  return pointIn({ x: r.left, y: r.top, w: r.width, h: r.height }, at);
}

// ------------------------------------------------------------------------------- events

function pointer(type: string, el: Element, p: Pt, buttons: number, id = 1) {
  el.dispatchEvent(
    new PointerEvent(type, {
      bubbles: type !== "pointerenter" && type !== "pointerleave",
      cancelable: true,
      composed: true,
      clientX: p.x,
      clientY: p.y,
      pointerId: id,
      pointerType: "mouse",
      isPrimary: true,
      button: type === "pointermove" ? -1 : 0,
      buttons,
      view: window,
    }),
  );
}

function mouse(type: string, el: Element, p: Pt, buttons: number) {
  el.dispatchEvent(
    new MouseEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: p.x, clientY: p.y, button: 0, buttons, view: window }),
  );
}

/** A full click on the element, without moving focus. */
export function clickElement(el: HTMLElement, at?: [number, number]) {
  const p = pointOf(el, at);
  pointer("pointerover", el, p, 0);
  pointer("pointerdown", el, p, 1);
  mouse("mousedown", el, p, 1);
  pointer("pointerup", el, p, 0);
  mouse("mouseup", el, p, 0);
  el.click();
}

const valueSetter = () => Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;

/** Set a text box's value the way typing does, so React's onChange sees it. */
function setValue(input: HTMLInputElement, value: string) {
  valueSetter()?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function reveal(el: HTMLElement) {
  el.scrollIntoView({ block: "nearest", inline: "nearest" });
}

// ------------------------------------------------------------------------------- the pointer

/** The tour's pointer: an arrow and a press ring, positioned with transforms. */
export class TourCursor {
  pos: Pt | null = null;
  private bow = 1;

  constructor(
    private root: HTMLElement,
    private arrow: HTMLElement,
    private ring: HTMLElement,
    private reduced: () => boolean,
    /** Where the pointer first appears: by the card's main button. */
    private home: () => Pt,
  ) {}

  private place(p: Pt) {
    this.pos = p;
    this.root.style.transform = `translate3d(${p.x}px, ${p.y}px, 0)`;
  }

  show() {
    if (!this.pos) this.place(this.home());
    this.root.style.opacity = "1";
  }

  hide() {
    this.root.style.opacity = "0";
  }

  async glide(to: Pt, signal: AbortSignal) {
    this.show();
    const from = this.pos!;
    const d = Math.hypot(to.x - from.x, to.y - from.y);
    if (this.reduced() || d < 2) {
      this.place(to);
      return;
    }
    // A gentle arc, bowing to alternate sides, slower over longer distances.
    this.bow = -this.bow;
    const nx = -(to.y - from.y) / d;
    const ny = (to.x - from.x) / d;
    const b = Math.min(70, d * 0.14) * this.bow;
    const c1 = { x: from.x + (to.x - from.x) * 0.3 + nx * b, y: from.y + (to.y - from.y) * 0.3 + ny * b };
    const c2 = { x: from.x + (to.x - from.x) * 0.78 + nx * b * 0.5, y: from.y + (to.y - from.y) * 0.78 + ny * b * 0.5 };
    const duration = Math.min(1.05, Math.max(0.42, 0.3 + d / 1500));
    this.root.dataset.moving = "true";
    try {
      await play(
        animate(0, 1, {
          duration,
          ease: [0.45, 0.05, 0.22, 1],
          onUpdate: (t) => {
            const u = 1 - t;
            this.place({
              x: u * u * u * from.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * to.x,
              y: u * u * u * from.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * to.y,
            });
          },
        }),
        signal,
      );
      this.place(to);
    } finally {
      delete this.root.dataset.moving;
    }
  }

  /** The press: the arrow dips and a soft ring spreads from its tip. */
  async press(signal: AbortSignal, hold = false) {
    if (this.reduced()) return;
    animate(this.ring, { opacity: [0.7, 0], scale: [0.4, 1.5] }, { duration: 0.55, ease: [0.16, 1, 0.3, 1] });
    animate(this.arrow, { scale: hold ? 0.86 : [1, 0.84, 1] }, { duration: hold ? 0.12 : 0.3 });
    await sleep(hold ? 120 : 150, signal);
  }

  release() {
    if (this.reduced()) return;
    animate(this.arrow, { scale: 1 }, { duration: 0.18 });
  }

  /** Drag from one point to another through the element's own pointer handlers. */
  async drag(el: HTMLElement, from: Pt, to: Pt, ms: number, signal: AbortSignal) {
    // These pointers are not real ones, and capturing one throws: the element's capture calls are
    // made harmless for the length of the drag.
    const own = el as unknown as Record<string, unknown>;
    own.setPointerCapture = (id: number) => {
      try {
        Element.prototype.setPointerCapture.call(el, id);
      } catch {
        // not a real pointer
      }
    };
    own.releasePointerCapture = (id: number) => {
      try {
        Element.prototype.releasePointerCapture.call(el, id);
      } catch {
        // not a real pointer
      }
    };
    const id = 41;
    let at = from;
    let down = false;
    try {
      await this.glide(from, signal);
      await this.press(signal, true);
      pointer("pointerdown", el, from, 1, id);
      down = true;
      if (this.reduced()) {
        at = to;
        pointer("pointermove", el, to, 1, id);
      } else {
        this.root.dataset.moving = "true";
        await play(
          animate(0, 1, {
            duration: ms / 1000,
            ease: [0.42, 0, 0.3, 1],
            onUpdate: (t) => {
              at = { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
              this.place(at);
              pointer("pointermove", el, at, 1, id);
            },
          }),
          signal,
        );
      }
    } finally {
      delete this.root.dataset.moving;
      if (down) pointer("pointerup", el, at, 0, id);
      this.release();
      delete own.setPointerCapture;
      delete own.releasePointerCapture;
    }
  }

  async type(input: HTMLInputElement, text: string, signal: AbortSignal) {
    input.focus({ preventScroll: true });
    if (this.reduced()) {
      setValue(input, text);
      return;
    }
    setValue(input, "");
    for (let i = 1; i <= text.length; i++) {
      setValue(input, text.slice(0, i));
      const ch = text[i - 1];
      await sleep(65 + Math.random() * 75 + (ch === " " ? 70 : 0), signal);
    }
  }
}

// ------------------------------------------------------------------------------- running steps

export interface ActEnv {
  cursor: TourCursor;
  signal: AbortSignal;
  /** Setup: no pointer, nothing glides. */
  instant: boolean;
  setPhase: (phase: number) => void;
}

async function element(target: TourSel, timeout: number, signal: AbortSignal) {
  return waitFor(() => find(target), timeout, signal);
}

export async function runActs(acts: TourAct[] | undefined, env: ActEnv): Promise<void> {
  const { cursor, signal, instant } = env;
  for (const act of acts ?? []) {
    if (signal.aborted) throw new Aborted();
    switch (act.kind) {
      case "click": {
        const el = await element(act.target, act.timeout ?? 2500, signal);
        if (!el || (act.if && !act.if(el))) break;
        reveal(el);
        if (!instant) {
          await cursor.glide(pointOf(el, act.at), signal);
          await cursor.press(signal);
        }
        clickElement(el, act.at);
        await sleep(instant ? 60 : 220, signal);
        break;
      }
      case "point": {
        const el = await element(act.target, act.timeout ?? 2500, signal);
        if (!el || instant) break;
        reveal(el);
        await cursor.glide(pointOf(el, act.at), signal);
        await sleep(250, signal);
        break;
      }
      case "drag": {
        const el = await element(act.target, 4000, signal);
        const area = act.area();
        if (!el || !area || instant) break;
        await cursor.drag(el, pointIn(area, act.from), pointIn(area, act.to), act.ms ?? 1000, signal);
        await sleep(300, signal);
        break;
      }
      case "type": {
        if (act.if && !act.if()) break;
        const el = await element(act.target, 4000, signal);
        if (!(el instanceof HTMLInputElement)) break;
        reveal(el);
        if (instant) {
          setValue(el, act.text);
          break;
        }
        await cursor.glide(pointOf(el, [0.22, 0.5]), signal);
        await cursor.press(signal);
        await cursor.type(el, act.text, signal);
        await sleep(250, signal);
        break;
      }
      case "clear": {
        const el = find(act.target);
        if (el instanceof HTMLInputElement && el.value) setValue(el, "");
        break;
      }
      case "reveal": {
        const el = await element(act.target, 2500, signal);
        if (el) reveal(el);
        break;
      }
      case "wait":
        await sleep(act.ms, signal);
        break;
      case "until":
        await waitFor(act.test, act.timeout, signal);
        break;
      case "phase":
        env.setPhase(act.phase);
        break;
    }
  }
}

/** On leaving a step: its clean-up clicks, at once. */
export function runCleanup(acts: TourAct[] | undefined) {
  for (const act of acts ?? []) {
    if (act.kind === "click") {
      const el = find(act.target);
      if (el && (!act.if || act.if(el))) clickElement(el, act.at);
    } else if (act.kind === "clear") {
      const el = find(act.target);
      if (el instanceof HTMLInputElement && el.value) setValue(el, "");
    }
  }
}
