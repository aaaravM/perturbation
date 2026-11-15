"use client";
// Right-hand detail panel over the sky. Slides in from the right on tablets and desktops and up
// from the bottom on phones. Not modal (the sky stays usable), so: Esc closes it (handled by the
// workspace), focus moves to its heading when the user opens it, and returns to where it came
// from when it closes.

import { useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { XIcon } from "lucide-react";

const DESKTOP_QUERY = "(min-width: 768px)";
function subscribe(onChange: () => void) {
  const media = window.matchMedia(DESKTOP_QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}
export function useIsDesktop() {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(DESKTOP_QUERY).matches,
    () => true,
  );
}

export const PANEL_WIDTH = 408;

export function DetailPanel({
  open,
  contentKey,
  focusRequest,
  label,
  onClose,
  children,
}: {
  open: boolean;
  /** Changes when the panel shows something else (target vs position). */
  contentKey: string;
  /** Bumped by user actions that open the panel; focus then moves into it. */
  focusRequest: number;
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const desktop = useIsDesktop();
  const reduce = useReducedMotion();
  const headingRef = useRef<HTMLDivElement>(null);
  const returnRef = useRef<HTMLElement | null>(null);

  // Remember where focus was when the user opened the panel, then move focus into it.
  const handledFocus = useRef(focusRequest);
  useEffect(() => {
    if (!open || focusRequest === handledFocus.current) return;
    handledFocus.current = focusRequest;
    const active = document.activeElement as HTMLElement | null;
    if (active && !active.closest("[data-detail-panel]")) returnRef.current = active;
    const t = window.setTimeout(() => headingRef.current?.focus({ preventScroll: true }), 60);
    return () => window.clearTimeout(t);
  }, [open, focusRequest, contentKey]);

  // On close, give focus back if it was inside the panel (which is still animating out): to
  // where it came from, else to the sky viewer, never to a button that is about to vanish.
  useEffect(() => {
    if (open) return;
    const active = document.activeElement as HTMLElement | null;
    const inside = !active || active === document.body || Boolean(active.closest?.("[data-detail-panel]"));
    const remembered = returnRef.current && document.contains(returnRef.current) ? returnRef.current : null;
    const back = remembered ?? document.querySelector<HTMLElement>("[data-testid=sky-viewer]");
    if (inside && back) back.focus({ preventScroll: true });
    returnRef.current = null;
  }, [open]);

  const spring = reduce ? { duration: 0 } : { type: "spring" as const, stiffness: 380, damping: 40, mass: 0.9 };

  return (
    <AnimatePresence>
      {open && (
        <motion.aside
          key="detail-panel"
          data-detail-panel
          data-testid="detail-panel"
          aria-label={label}
          data-lenis-prevent
          initial={desktop ? { x: PANEL_WIDTH + 24, opacity: 0.4 } : { y: "100%" }}
          animate={desktop ? { x: 0, opacity: 1 } : { y: 0 }}
          exit={desktop ? { x: PANEL_WIDTH + 24, opacity: 0 } : { y: "100%" }}
          transition={spring}
          // Phones: an opaque sheet, so the player underneath does not show through the text.
          style={desktop ? { width: PANEL_WIDTH } : { backgroundColor: "var(--ink-2)" }}
          className={
            desktop
              ? "panel absolute top-3 right-3 bottom-3 z-30 flex flex-col overflow-hidden rounded-lg shadow-[0_24px_60px_-20px_rgb(0_0_0/0.8)]"
              : "panel absolute inset-x-0 bottom-0 z-30 flex max-h-[68%] flex-col overflow-hidden rounded-t-xl rounded-b-none border-x-0 border-b-0"
          }
        >
          {!desktop && <span aria-hidden className="mx-auto mt-2 block h-1 w-9 rounded-full bg-hair-strong" />}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close panel"
            aria-keyshortcuts="Escape"
            data-testid="panel-close"
            className="absolute top-2.5 right-2.5 z-10 grid size-8 place-items-center rounded-md bg-ink-2 text-fg-dim transition-colors hover:bg-ink-3 hover:text-fg"
          >
            <XIcon className="size-4" aria-hidden />
          </button>
          {/* Content below the fold fades out at the bottom edge instead of being cut. Once
              scrolled, text also fades out under the close button instead of running beneath it. */}
          <div
            onScroll={(e) => {
              const el = e.currentTarget;
              const scrolled = el.scrollTop > 2;
              if ((el.dataset.scrolled === "true") !== scrolled) el.dataset.scrolled = String(scrolled);
            }}
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain [mask-image:linear-gradient(to_bottom,black_calc(100%_-_36px),transparent)] data-[scrolled=true]:[mask-image:linear-gradient(to_bottom,transparent_0,transparent_10px,black_52px,black_calc(100%_-_36px),transparent)]"
          >
            <motion.div
              key={contentKey}
              initial={reduce ? false : { opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
              className="pb-6"
            >
              <div ref={headingRef} tabIndex={-1} className="outline-none" data-testid="panel-focus-target">
                {children}
              </div>
            </motion.div>
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}

/** A titled block inside the panel. */
export function PanelSection({
  title,
  aside,
  children,
  testId,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <section className="flex flex-col gap-3 border-t border-hair px-5 py-4" data-testid={testId}>
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-ui font-medium text-fg">{title}</h3>
        {aside && <div className="text-micro text-fg-faint">{aside}</div>}
      </div>
      {children}
    </section>
  );
}

/** Two-column definition rows. */
export function Rows({ children }: { children: ReactNode }) {
  return <dl className="grid grid-cols-[minmax(6.5rem,auto)_1fr] gap-x-4 gap-y-1.5 text-meta">{children}</dl>;
}

export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-fg-dim">{label}</dt>
      <dd className="min-w-0 text-fg">{children}</dd>
    </>
  );
}
