"use client";

// A technical word with a plain-language explanation: a dotted underline and a small "?". The
// explanation opens on hover (after a short delay), on keyboard focus, or on a tap; moving away,
// Escape, or a tap anywhere else closes it, and the pointer can rest on the explanation itself
// (WCAG 1.4.13). It renders in a layer above everything on the page (the nav, panels, sheets and
// the Aladin viewer), stays inside the viewport, flips side when it has to, and never activates
// the row or button the word sits in. Which words get one: the rule at the top of lib/glossary.ts.
// Usage: <Term k="properMotion" /> or <Term k="parallax">parallaxes</Term>
//
// Radix Tooltip provides the layer, positioning, Escape and outside-tap handling and the screen
// reader description. Its own hover and focus handling is switched off (each handler below calls
// preventDefault, which Radix's composed handlers respect): its hover grace area could leave one
// explanation stuck open and stop the next word's from opening.

import * as React from "react";
import { Tooltip as TooltipPrimitive } from "radix-ui";

import { GLOSSARY, type GlossaryKey } from "@/lib/glossary";
import { cn } from "@/lib/utils";

/** Hover this long before an explanation opens, so passing the pointer over text stays calm. */
const OPEN_DELAY_MS = 200;
/** Time to move the pointer from the word onto its explanation before it closes. */
const CLOSE_DELAY_MS = 160;
/** Just after one explanation closes, the next opens at once, for reading several in a row. */
const SKIP_DELAY_MS = 400;
/** Radix's event: an open tooltip closes when another one opens. */
const TOOLTIP_OPEN = "tooltip.open";
/** Keeps explanations clear of the screen edges; the top also clears the site nav. */
const COLLISION_PADDING = { top: 60, right: 12, bottom: 12, left: 12 };
/** Above the nav, panels, sheets and Aladin Lite (whose own layers go up to 10001). */
const LAYER = 10_100;

const openTerms = new Set<string>();
let lastClosedAt = Number.NEGATIVE_INFINITY;

export interface TermProps {
  k: GlossaryKey;
  children?: React.ReactNode;
  className?: string;
  /** Show the small question mark after the word (default true). The Settings page can hide them all. */
  mark?: boolean;
}

interface TermState {
  open: boolean;
  overWord: boolean;
  overTip: boolean;
  /** Focused from the keyboard. */
  keyboard: boolean;
  /** Opened by a tap: stays open until the next tap, or a tap elsewhere. */
  pinned: boolean;
  /** Closed with Escape: stays closed until the pointer and focus leave. */
  dismissed: boolean;
  /** During a pointerdown on the word. */
  pressing: boolean;
  pressType: string | null;
  openTimer: number;
  closeTimer: number;
}

export function Term({ k, children, className, mark = true }: TermProps) {
  const entry = GLOSSARY[k];
  const id = React.useId();
  const [open, setOpen] = React.useState(false);
  const wordRef = React.useRef<HTMLButtonElement>(null);
  const state = React.useRef<TermState>({
    open: false,
    overWord: false,
    overTip: false,
    keyboard: false,
    pinned: false,
    dismissed: false,
    pressing: false,
    pressType: null,
    openTimer: 0,
    closeTimer: 0,
  });

  const control = React.useMemo(() => {
    const clearTimers = () => {
      window.clearTimeout(state.current.openTimer);
      window.clearTimeout(state.current.closeTimer);
    };
    const hide = () => {
      clearTimers();
      const s = state.current;
      s.pinned = false;
      if (!s.open) return;
      s.open = false;
      openTerms.delete(id);
      lastClosedAt = performance.now();
      setOpen(false);
    };
    const show = () => {
      clearTimers();
      const s = state.current;
      if (s.open) return;
      // Any other explanation (or tooltip) closes first: one at a time.
      document.dispatchEvent(new CustomEvent(TOOLTIP_OPEN));
      s.open = true;
      openTerms.add(id);
      setOpen(true);
    };
    const showSoon = () => {
      const s = state.current;
      window.clearTimeout(s.closeTimer);
      if (s.open || s.dismissed) return;
      window.clearTimeout(s.openTimer);
      const reading = openTerms.size > 0 || performance.now() - lastClosedAt < SKIP_DELAY_MS;
      if (reading) show();
      else s.openTimer = window.setTimeout(show, OPEN_DELAY_MS);
    };
    const hideSoon = () => {
      const s = state.current;
      window.clearTimeout(s.openTimer);
      if (!s.open || s.pinned || s.keyboard) return;
      window.clearTimeout(s.closeTimer);
      s.closeTimer = window.setTimeout(() => {
        const now = state.current;
        if (!now.overWord && !now.overTip && !now.keyboard && !now.pinned) hide();
      }, CLOSE_DELAY_MS);
    };
    return { hide, show, showSoon, hideSoon };
  }, [id]);

  React.useEffect(() => {
    const s = state.current;
    return () => {
      window.clearTimeout(s.openTimer);
      window.clearTimeout(s.closeTimer);
      if (s.open) {
        s.open = false;
        openTerms.delete(id);
        lastClosedAt = performance.now();
      }
    };
  }, [id]);

  return (
    <TooltipPrimitive.Root
      open={open}
      disableHoverableContent
      onOpenChange={(next) => {
        // Radix only ever asks to close here (Escape, a tap elsewhere, another tooltip opening, the
        // page scrolling under it). A press on the word itself is left to its click.
        if (!next && !state.current.pressing) control.hide();
      }}
    >
      <TooltipPrimitive.Trigger asChild>
        <button
          ref={wordRef}
          type="button"
          data-term={k}
          data-open={open ? "" : undefined}
          className={cn(
            "pointer-events-auto inline cursor-help touch-manipulation whitespace-nowrap rounded-[2px] border-0 bg-transparent p-0 text-inherit [font:inherit]",
            "underline decoration-dotted decoration-[1.5px] underline-offset-[3px] [text-decoration-color:color-mix(in_srgb,currentColor_58%,transparent)]",
            "transition-[text-decoration-color] duration-200 hover:[text-decoration-color:var(--accent)]",
            "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--accent)]",
            open && "[text-decoration-color:var(--accent)]",
            className,
          )}
          onPointerEnter={(event) => {
            if (event.pointerType === "touch") return;
            state.current.overWord = true;
            control.showSoon();
          }}
          onPointerMove={(event) => {
            // Radix would open on pointer move; hover is handled on enter and leave instead.
            event.preventDefault();
          }}
          onPointerLeave={(event) => {
            event.preventDefault();
            if (event.pointerType === "touch") return;
            const s = state.current;
            s.overWord = false;
            if (!s.keyboard) s.dismissed = false;
            control.hideSoon();
          }}
          onPointerDown={(event) => {
            // Radix closes an open tooltip on any press; the click decides instead.
            const s = state.current;
            s.pressing = true;
            s.pressType = event.pointerType;
            queueMicrotask(() => {
              state.current.pressing = false;
            });
          }}
          onClick={(event) => {
            // Never let the click reach a row, link or button the word sits in.
            event.preventDefault();
            event.stopPropagation();
            const s = state.current;
            const type = s.pressType;
            s.pressType = null;
            s.dismissed = false;
            if (event.detail === 0 || type === null) {
              // Enter or Space: toggle.
              if (s.open) control.hide();
              else control.show();
            } else if (type === "mouse") {
              // Hover may still be waiting: a click opens it now; it closes when the pointer leaves.
              control.show();
            } else if (s.open && s.pinned) {
              // Touch and pen: a tap opens it, a second tap closes it.
              control.hide();
            } else {
              control.show();
              s.pinned = true;
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") event.stopPropagation();
          }}
          onFocus={(event) => {
            event.preventDefault();
            let fromKeyboard = true;
            try {
              fromKeyboard = event.currentTarget.matches(":focus-visible");
            } catch {
              // An engine without :focus-visible: treat any focus as keyboard focus.
            }
            if (!fromKeyboard) return;
            const s = state.current;
            s.keyboard = true;
            if (!s.dismissed) control.show();
          }}
          onBlur={(event) => {
            event.preventDefault();
            const s = state.current;
            s.keyboard = false;
            s.dismissed = false;
            if (!s.pinned && !s.overWord && !s.overTip) control.hide();
          }}
        >
          {children ?? entry.term}
          {mark ? (
            <sup
              aria-hidden
              data-term-mark=""
              className="ml-px select-none align-super text-[0.66em] leading-none font-medium opacity-70"
            >
              ?
            </sup>
          ) : null}
        </button>
      </TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          data-slot="tooltip-content"
          data-term-tip={k}
          side="top"
          align="center"
          sideOffset={6}
          collisionPadding={COLLISION_PADDING}
          sticky="partial"
          hideWhenDetached
          style={{ zIndex: LAYER }}
          onEscapeKeyDown={(event) => {
            // Escape closes only the explanation, not the panel or selection behind it.
            event.stopPropagation();
            state.current.dismissed = true;
          }}
          onPointerDownOutside={(event) => {
            // A tap on the word itself is handled by its click.
            const target = event.target;
            if (target instanceof Node && wordRef.current?.contains(target)) event.preventDefault();
          }}
          onPointerEnter={(event) => {
            if (event.pointerType === "touch") return;
            state.current.overTip = true;
            window.clearTimeout(state.current.closeTimer);
          }}
          onPointerLeave={(event) => {
            if (event.pointerType === "touch") return;
            state.current.overTip = false;
            control.hideSoon();
          }}
          className={cn(
            "pointer-events-auto w-max max-w-[min(19rem,calc(100vw-24px))] origin-(--radix-tooltip-content-transform-origin) whitespace-normal rounded-md bg-foreground px-3 py-2 text-left text-background",
            "shadow-[0_12px_32px_-14px_rgb(0_0_0/0.85)] outline-none",
            "duration-150 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-[state=delayed-open]:zoom-in-95 data-[state=instant-open]:animate-in data-[state=instant-open]:fade-in-0",
            "motion-reduce:animate-none in-[[data-motion=reduce]]:animate-none",
          )}
        >
          <span className="block text-[13px] leading-tight font-medium">{entry.term}</span>
          <span className="mt-1 block text-[12.5px] leading-snug font-normal opacity-85">{entry.short}</span>
          <TooltipPrimitive.Arrow width={10} height={5} className="fill-foreground" />
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}
