"use client";
// Small building blocks of the Lab workbench: tool buttons with a shortcut hint, segmented
// controls, pane headings and the hairline resize handles between panes.

import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { motion, useReducedMotion } from "motion/react";
import { PanelBottomIcon, PanelLeftIcon, PanelRightIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Kbd } from "@/components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/** The Lab's small square icon buttons: the tools, and the actions in the session bar. */
const ICON_BUTTON =
  "relative grid size-7 shrink-0 place-items-center rounded-[5px] text-fg-dim transition-colors duration-150 hover:bg-white/[0.06] hover:text-fg disabled:pointer-events-none disabled:opacity-35";

export function ToolButton({
  label,
  shortcut,
  pressed,
  disabled,
  onClick,
  children,
  testId,
  className,
}: {
  label: string;
  shortcut?: string;
  pressed?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
  testId?: string;
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          aria-pressed={pressed}
          aria-keyshortcuts={shortcut}
          disabled={disabled}
          onClick={onClick}
          data-testid={testId}
          data-active={pressed ? "true" : undefined}
          className={cn(ICON_BUTTON, pressed && "bg-white/[0.07] text-fg", className)}
        >
          {children}
          {pressed && <span aria-hidden className="absolute inset-x-1.5 -bottom-px h-px bg-accent" />}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {label}
        {shortcut ? <Kbd className="ml-1.5">{shortcut}</Kbd> : null}
      </TooltipContent>
    </Tooltip>
  );
}

export type PaneSide = "left" | "bottom" | "right";

const PANE_ICON = { left: PanelLeftIcon, bottom: PanelBottomIcon, right: PanelRightIcon } as const;
/** The pane's part of each icon, filled while the pane is shown. */
const PANE_FILL: Record<PaneSide, string> = {
  left: "M5 3h4v18H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z",
  bottom: "M3 15h18v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  right: "M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4z",
};

/**
 * Shows or hides one pane, like the layout buttons at the top right of VS Code: the pane's part
 * of the icon is filled while it is shown, and outlined while it is hidden. The name stays the
 * same and aria-pressed says whether the pane is shown; the tooltip says what a click does.
 */
export function PaneToggle({
  side,
  label,
  shown,
  controls,
  shortcut,
  keyShortcuts,
  onToggle,
  testId,
}: {
  side: PaneSide;
  /** The pane's name in sentence case, such as "Data pane". */
  label: string;
  shown: boolean;
  /** Id of the pane. */
  controls: string;
  /** As shown in the tooltip, such as "Ctrl B". */
  shortcut: string;
  /** For aria-keyshortcuts, such as "Control+B Meta+B". */
  keyShortcuts: string;
  onToggle: () => void;
  testId: string;
}) {
  const Icon = PANE_ICON[side];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          aria-pressed={shown}
          aria-controls={controls}
          aria-keyshortcuts={keyShortcuts}
          onClick={onToggle}
          data-testid={testId}
          className={ICON_BUTTON}
        >
          <Icon className="size-3.5" aria-hidden>
            {shown && <path d={PANE_FILL[side]} fill="currentColor" stroke="none" />}
          </Icon>
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {shown ? "Hide" : "Show"} the {label.toLowerCase()}
        <Kbd className="ml-1.5">{shortcut}</Kbd>
      </TooltipContent>
    </Tooltip>
  );
}

/** A compact radio group drawn as joined segments. Arrow keys move between options. */
export function Seg<T extends string>({
  label,
  value,
  options,
  onChange,
  layoutId,
  testIdPrefix,
  size = "sm",
}: {
  label: string;
  value: T;
  options: { value: T; label: ReactNode; disabled?: boolean; title?: string }[];
  onChange: (value: T) => void;
  layoutId: string;
  testIdPrefix?: string;
  size?: "sm" | "xs";
}) {
  const reduce = useReducedMotion();
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const usable = options.filter((o) => !o.disabled);
    const i = usable.findIndex((o) => o.value === value);
    const next = usable[(i + (event.key === "ArrowRight" ? 1 : usable.length - 1)) % usable.length];
    if (!next) return;
    onChange(next.value);
    (event.currentTarget.querySelector(`[data-value="${next.value}"]`) as HTMLButtonElement | null)?.focus();
  };
  return (
    <div
      role="radiogroup"
      aria-label={label}
      onKeyDown={onKeyDown}
      className="inline-flex shrink-0 items-center rounded-md border border-hair p-0.5"
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            disabled={o.disabled}
            title={o.title}
            data-value={o.value}
            data-testid={testIdPrefix ? `${testIdPrefix}-${o.value}` : undefined}
            onClick={() => onChange(o.value)}
            className={cn(
              "relative rounded-[4px] text-fg-dim transition-colors duration-150 hover:text-fg disabled:opacity-35 disabled:hover:text-fg-dim",
              size === "sm" ? "h-6 px-2 text-micro" : "h-5 px-1.5 text-micro",
              active && "text-fg",
            )}
          >
            {active && (
              <motion.span
                aria-hidden
                layoutId={layoutId}
                className="absolute inset-0 rounded-[4px] bg-white/[0.08]"
                transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 560, damping: 42, mass: 0.6 }}
              />
            )}
            <span className="relative">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}

export function PaneHeading({ children, aside, id }: { children: ReactNode; aside?: ReactNode; id?: string }) {
  return (
    <div className="flex h-8 shrink-0 items-center justify-between gap-2 px-3">
      <h2 id={id} className="text-micro font-medium text-fg-dim">
        {children}
      </h2>
      {aside}
    </div>
  );
}

function readSize(key: string, fallback: number) {
  try {
    const v = Number(window.localStorage.getItem(key));
    return Number.isFinite(v) && v > 0 ? v : fallback;
  } catch {
    return fallback;
  }
}

/** A pane width that the user can drag, remembered in this browser. */
export function usePaneSize(key: string, fallback: number, min: number, max: number) {
  const [size, setSize] = useState(fallback);
  useEffect(() => {
    // Read after hydration so the server and first client render agree.
    const id = window.requestAnimationFrame(() => {
      const stored = readSize(key, fallback);
      if (stored !== fallback) setSize(Math.min(max, Math.max(min, stored)));
    });
    return () => window.cancelAnimationFrame(id);
  }, [key, fallback, min, max]);
  const commit = useCallback(
    (next: number) => {
      const v = Math.round(Math.min(max, Math.max(min, next)));
      setSize(v);
      try {
        window.localStorage.setItem(key, String(v));
      } catch {
        // Private windows: the size just is not remembered.
      }
    },
    [key, min, max],
  );
  return [size, commit] as const;
}

/**
 * A vertical hairline between two panes. Drag it (or use the arrow keys while it has focus)
 * to resize; `side` says which pane grows when the handle moves right.
 */
export function ResizeHandle({
  label,
  value,
  min,
  max,
  onChange,
  side,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (next: number) => void;
  side: "left" | "right";
}) {
  const start = useRef<{ x: number; value: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const sign = side === "left" ? 1 : -1;
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        start.current = { x: e.clientX, value };
        setDragging(true);
      }}
      onPointerMove={(e) => {
        if (!start.current) return;
        onChange(start.current.value + sign * (e.clientX - start.current.x));
      }}
      onPointerUp={() => {
        start.current = null;
        setDragging(false);
      }}
      onPointerCancel={() => {
        start.current = null;
        setDragging(false);
      }}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") onChange(value - sign * 16);
        else if (e.key === "ArrowRight") onChange(value + sign * 16);
        else return;
        e.preventDefault();
      }}
      className="group relative z-10 w-px shrink-0 cursor-col-resize bg-hair outline-none"
    >
      <span
        aria-hidden
        className={cn(
          "absolute inset-y-0 -left-[3px] w-[7px] transition-colors duration-150 group-hover:bg-white/[0.06] group-focus-visible:bg-accent/40",
          dragging && "bg-accent/30",
        )}
      />
    </div>
  );
}

/** A labelled number in a dense grid of readouts. */
export function Readout({ label, children, className }: { label: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn("flex min-w-0 items-baseline gap-1.5", className)}>
      <span className="shrink-0 text-micro text-fg-faint">{label}</span>
      <span className="readout truncate text-micro text-fg">{children}</span>
    </div>
  );
}
