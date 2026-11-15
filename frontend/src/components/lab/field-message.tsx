"use client";
// What the bottom bar says while a field loads, when it is not available, or when it failed.
// Honest and specific: live fields need the backend; prepared bundles may not exist yet.

import { motion, useReducedMotion } from "motion/react";
import { LoaderCircleIcon } from "lucide-react";
import type { FieldState } from "@/lib/lab-field";
import type { FeaturedTarget } from "@/lib/targets";
import { Button } from "@/components/ui/button";

const STAGES: Record<string, string> = {
  search: "Finding SPHEREx images",
  read: "Reading pixels from IRSA",
  coadd: "Co-adding each epoch",
  render: "Rendering frames",
};

export function FieldMessage({
  field,
  title,
  suggestions,
  onWatchTarget,
  onRetry,
  onShowSky,
}: {
  field: Extract<FieldState, { status: "loading" | "unavailable" | "error" }>;
  title: string;
  suggestions: FeaturedTarget[];
  onWatchTarget: (slug: string) => void;
  onRetry: () => void;
  onShowSky: () => void;
}) {
  const reduce = useReducedMotion();
  return (
    <section
      aria-label="Field status"
      data-testid="field-message"
      data-state={field.status}
      className="panel relative flex flex-col gap-2.5 overflow-hidden px-4 pt-3.5 pb-4"
    >
      {field.status === "loading" && (
        <>
          <div className="flex items-center gap-2.5">
            <LoaderCircleIcon className="size-4 animate-spin text-fg-dim" aria-hidden />
            <p className="text-ui text-fg" aria-live="polite">
              {field.progress ? (STAGES[field.progress.stage] ?? field.progress.stage) : `Loading ${title}`}
            </p>
            {field.progress && field.progress.total > 0 && (
              <span className="readout ml-auto text-micro text-fg-dim">
                {field.progress.done} / {field.progress.total}
              </span>
            )}
          </div>
          {(field.coverage || field.progress?.stage === "coadd") && (
            <p className="text-micro text-fg-dim">
              {field.coverage && (
                <>
                  SPHEREx has <span className="readout">{field.coverage.epochs}</span> epochs here (
                  <span className="readout">{field.coverage.exposures}</span> exposures).{" "}
                </>
              )}
              {field.progress?.stage === "coadd" && "The frames are built from IRSA on demand, which can take a minute."}
            </p>
          )}
          <div
            className="relative h-px w-full overflow-hidden bg-hair-strong"
            role="progressbar"
            aria-label="Field progress"
            aria-valuemin={0}
            aria-valuemax={field.progress?.total || undefined}
            aria-valuenow={field.progress?.done}
          >
            {field.progress && field.progress.total > 0 ? (
              <motion.span
                className="absolute inset-y-0 left-0 w-full origin-left bg-fg"
                initial={false}
                animate={{ scaleX: field.progress.done / field.progress.total }}
                transition={{ duration: reduce ? 0 : 0.4, ease: [0.16, 1, 0.3, 1] }}
              />
            ) : (
              !reduce && (
                <motion.span
                  className="absolute inset-y-0 w-1/3 bg-fg-dim"
                  animate={{ left: ["-33%", "100%"] }}
                  transition={{ duration: 1.3, repeat: Infinity, ease: [0.76, 0, 0.24, 1] }}
                />
              )
            )}
          </div>
        </>
      )}

      {field.status === "unavailable" && (
        <>
          <p className="text-ui text-fg">{field.reason === "no-backend" ? "Live fields are not connected yet" : "Not available yet"}</p>
          <p className="measure text-meta text-fg-dim">{field.message}</p>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pt-0.5">
            {suggestions.map((t) => (
              <button
                key={t.slug}
                type="button"
                onClick={() => onWatchTarget(t.slug)}
                className="text-meta text-fg underline decoration-hair-strong underline-offset-4 transition-colors hover:decoration-accent"
              >
                {t.name} is in this field: watch its prepared frames
              </button>
            ))}
            <button
              type="button"
              onClick={onShowSky}
              className="text-meta text-fg-dim underline decoration-hair underline-offset-4 transition-colors hover:text-fg"
            >
              Browse the all-sky map instead
            </button>
          </div>
        </>
      )}

      {field.status === "error" && (
        <>
          <p className="text-ui text-fg">The frames did not load</p>
          <p className="measure text-meta text-fg-dim">{field.message}</p>
          <div className="flex gap-3 pt-1">
            {field.retryable && (
              <Button variant="outline" size="sm" onClick={onRetry} className="border-hair-strong">
                Try again
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={onShowSky} className="text-fg-dim">
              Browse the all-sky map
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
