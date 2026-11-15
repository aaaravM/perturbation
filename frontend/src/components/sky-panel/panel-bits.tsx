"use client";
// Small building blocks shared by the Sky panels: sections with their data source, fact rows,
// numbers that roll into place, live-data states and the SPHEREx coverage timeline.

import { useEffect, useState, type ReactNode } from "react";
import NumberFlow from "@number-flow/react";
import { motion, type Variants } from "motion/react";
import { cn } from "@/lib/utils";
import { Term } from "@/components/ui/term";
import type { Coverage, Live } from "@/lib/sky-live";

const EASE = [0.16, 1, 0.3, 1] as const;

export const staggerParent: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.045, delayChildren: 0.06 } },
};
export const staggerChild: Variants = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: 0.45, ease: EASE } },
};

/** A block of content that rises into place after the one before it. */
export function Rise({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <motion.div variants={staggerChild} className={className}>
      {children}
    </motion.div>
  );
}

export function Stagger({
  children,
  reducedMotion,
  className,
}: {
  children: ReactNode;
  reducedMotion: boolean;
  className?: string;
}) {
  return (
    <motion.div
      variants={staggerParent}
      initial={reducedMotion ? false : "hidden"}
      animate="show"
      className={className}
    >
      {children}
    </motion.div>
  );
}

export function Section({
  title,
  source,
  children,
  testId,
}: {
  title: ReactNode;
  source?: ReactNode;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <Rise>
      <section className="flex flex-col gap-3 border-t border-hair pt-4" data-testid={testId}>
        <header className="flex items-baseline justify-between gap-3">
          <h3 className="text-ui font-medium text-fg">{title}</h3>
          {source ? <p className="shrink-0 text-micro text-fg-faint">{source}</p> : null}
        </header>
        {children}
      </section>
    </Rise>
  );
}

export function Fact({
  label,
  children,
  sub,
  className,
  testId,
}: {
  label: ReactNode;
  children: ReactNode;
  sub?: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-0.5", className)} data-testid={testId}>
      <dt className="text-micro text-fg-faint">{label}</dt>
      <dd className="text-ui text-fg">{children}</dd>
      {sub ? <dd className="text-micro text-pretty text-fg-dim">{sub}</dd> : null}
    </div>
  );
}

/** A number that rolls up to its value when it first appears (or changes). */
export function Roll({
  value,
  digits = 1,
  reducedMotion,
  className,
  signed = false,
  grouping = true,
}: {
  value: number;
  digits?: number;
  reducedMotion: boolean;
  className?: string;
  signed?: boolean;
  grouping?: boolean;
}) {
  const [shown, setShown] = useState(reducedMotion ? value : 0);
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(value));
    return () => cancelAnimationFrame(id);
  }, [value]);
  return (
    <NumberFlow
      value={shown}
      className={cn("readout", className)}
      locales="en-US"
      format={{
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
        signDisplay: signed ? "exceptZero" : "auto",
        useGrouping: grouping,
      }}
      animated={!reducedMotion}
      aria-label={value.toFixed(digits)}
    />
  );
}

/** One line for a live-data part that is not (yet) there. */
export function LiveNote<T>({ live, what }: { live: Live<T>; what: string }) {
  if (live.state === "ok") return null;
  if (live.state === "loading")
    return (
      <p className="flex items-center gap-2 text-meta text-fg-faint" data-testid="live-loading">
        <span aria-hidden className="h-px w-10 animate-pulse bg-fg-faint" />
        Fetching {what}…
      </p>
    );
  if (live.state === "off")
    return (
      <p className="text-meta text-pretty text-fg-faint" data-testid="live-off">
        Live {what} come from the Planet X Hunter API, which is not connected on this copy of the site.
      </p>
    );
  return (
    <p className="text-meta text-pretty text-fg-faint" data-testid="live-none">
      {live.message || `No ${what} here.`}
    </p>
  );
}

/** When the page was loaded: the right end of the coverage time line. */
const PAGE_TIME = typeof window === "undefined" ? 0 : Date.now();

const MONTH = new Intl.DateTimeFormat("en-GB", { month: "short", year: "numeric", timeZone: "UTC" });
const DAY = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const parseDate = (s: string | null) => {
  if (!s) return null;
  const d = new Date(s.length === 10 ? `${s}T00:00:00Z` : s);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** SPHEREx visits as ticks on a time line from launch to today, then the dates. */
export function CoverageView({ coverage, reducedMotion }: { coverage: Coverage; reducedMotion: boolean }) {
  const epochs = coverage.epochs
    .map((e) => ({ ...e, s: parseDate(e.start), t: parseDate(e.end) ?? parseDate(e.start) }))
    .filter((e) => e.s);
  if (!coverage.nImages || !epochs.length) {
    return <p className="text-meta text-fg-dim">SPHEREx has no images of this spot yet.</p>;
  }
  const t0 = Date.UTC(2025, 2, 1);
  const t1 = Math.max(PAGE_TIME, ...epochs.map((e) => e.t!.getTime()));
  const x = (d: Date) => ((d.getTime() - t0) / (t1 - t0)) * 100;
  const first = epochs[0].s!;
  const last = epochs[epochs.length - 1].t!;
  return (
    <div className="flex flex-col gap-2.5" data-testid="coverage">
      <p className="text-ui text-fg">
        <span className="readout">{epochs.length}</span> {epochs.length === 1 ? "visit" : "visits"}
        {coverage.nExposures ? (
          <span className="text-fg-dim">
            {" "}
            · <span className="readout">{coverage.nExposures}</span> exposures
          </span>
        ) : null}
        <span className="text-fg-dim">
          {" "}
          · {MONTH.format(first)} to {MONTH.format(last)}
        </span>
      </p>
      <div className="relative h-7" aria-hidden>
        <div className="absolute inset-x-0 top-3 h-px bg-hair-strong" />
        {epochs.map((e, i) => (
          <motion.span
            key={i}
            className={cn("absolute top-1.5 h-3 w-px", e.full ? "bg-fg" : "bg-fg-faint")}
            style={{ left: `${x(e.s!)}%` }}
            initial={reducedMotion ? false : { scaleY: 0, opacity: 0 }}
            animate={{ scaleY: 1, opacity: 1 }}
            transition={{ duration: 0.35, delay: 0.1 + i * 0.05 }}
          />
        ))}
        <span className="readout absolute top-5 left-0 text-[10px] text-fg-faint">2025</span>
        <span className="readout absolute top-5 right-0 text-[10px] text-fg-faint">today</span>
      </div>
      <ul className="flex flex-col gap-0.5 text-meta text-fg-dim">
        {epochs.slice(0, 8).map((e, i) => (
          <li key={i} className="flex justify-between gap-3">
            <span>
              {e.survey ? <Term k="survey" mark={false}>{e.survey}</Term> : `Visit ${i + 1}`}
              {e.full ? null : <span className="text-fg-faint"> (partial)</span>}
            </span>
            <span className="readout text-fg-faint">
              {DAY.format(e.s!)}
              {e.t && e.t.getTime() !== e.s!.getTime() ? ` – ${DAY.format(e.t)}` : ""}
            </span>
          </li>
        ))}
        {epochs.length > 8 ? <li className="text-fg-faint">and {epochs.length - 8} more</li> : null}
      </ul>
      {coverage.deepField ? (
        <p className="text-micro text-fg-faint">
          This is a <Term k="deepField" />, so SPHEREx looks here almost every orbit.
        </p>
      ) : null}
    </div>
  );
}
