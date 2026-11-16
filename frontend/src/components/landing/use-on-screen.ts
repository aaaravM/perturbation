// Whether an element is on screen, for the home page's glass cards, which fade and rise in as they
// arrive. Pass the element itself, kept in state by a callback ref (ref={setNode}), so whichever
// element is attached, whenever it is attached, is the one observed.
//
// Why not motion's useInView(ref): a glass card (motion.create(LiquidGlass)) hands its element to
// the ref only on LiquidGlass's own second render, after the card's first commit. useInView reads
// ref.current once in an effect and looks again only when the card itself re-renders. On a fresh
// load it does (the preferences become ready after hydration); after a client-side navigation
// nothing re-renders it, so no observer was ever attached and the card stayed invisible.
//
// It also fails open: with `failOpen` set (pass it while the element starts hidden), until the
// observer has reported on this element, an element that has been on screen for a moment counts as
// in view anyway. No element at all, after that moment, also counts as in view.

import * as React from "react";

/** How long an element must be on screen, with no report from the observer, before it shows (ms). */
const FAIL_OPEN_MS = 600;
const CHECK_MS = 200;

export interface OnScreenOptions {
  /** Fraction of the element that must be on screen, 0 to 1 (as motion's useInView). */
  amount: number;
  /** Stay true once seen. */
  once?: boolean;
  /** Never leave it hidden if the observer does not report (see above). */
  failOpen?: boolean;
}

export function useOnScreen(node: Element | null, { amount, once = false, failOpen = false }: OnScreenOptions): boolean {
  const [onScreen, setOnScreen] = React.useState(false);
  /** The element the observer last reported on. */
  const reported = React.useRef<Element | null>(null);

  React.useEffect(() => {
    if (!node || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        reported.current = node;
        const entry = entries[entries.length - 1];
        if (entry.isIntersecting) {
          setOnScreen(true);
          if (once) io.disconnect();
        } else if (!once) {
          setOnScreen(false);
        }
      },
      { threshold: amount },
    );
    io.observe(node);
    return () => io.disconnect();
  }, [node, amount, once]);

  React.useEffect(() => {
    if (!failOpen || onScreen) return;
    const start = performance.now();
    let since = 0;
    const id = window.setInterval(() => {
      // The observer is watching this very element: it decides.
      if (node && reported.current === node) return window.clearInterval(id);
      const now = performance.now();
      const visible = node ? isOnScreen(node, amount) : now - start >= FAIL_OPEN_MS;
      if (!visible) {
        since = 0;
        return;
      }
      if (!since) since = now;
      if (now - since >= FAIL_OPEN_MS) setOnScreen(true);
    }, CHECK_MS);
    return () => window.clearInterval(id);
  }, [failOpen, onScreen, node, amount]);

  return onScreen;
}

/** At least `amount` of the element is inside the viewport (of the viewport, for a taller element). */
function isOnScreen(el: Element, amount: number): boolean {
  const r = el.getBoundingClientRect();
  const w = Math.min(r.right, window.innerWidth) - Math.max(r.left, 0);
  const h = Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0);
  if (w <= 0 || h <= 0) return false;
  return w * h >= amount * Math.min(r.width * r.height, window.innerWidth * window.innerHeight);
}
