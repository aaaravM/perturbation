// Labelled placeholder for routes that are not built yet. Project rule: placeholder content
// must say so (quietly, in one muted line), and every instance is replaced before submission.

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** One small muted line, e.g. "Placeholder. Built in Phase 3." */
export function PlaceholderNote({ phase, className }: { phase: string; className?: string }) {
  return (
    <p data-placeholder className={cn("text-meta text-fg-faint", className)}>
      Placeholder. Built in Phase {phase}.
    </p>
  );
}

export function PagePlaceholder({
  phase,
  kicker,
  title,
  children,
}: {
  phase: string;
  kicker: string;
  title: string;
  children?: ReactNode;
}) {
  return (
    <section className="flex flex-1">
      <div className="mx-auto flex w-full max-w-7xl flex-col px-4 pt-20 pb-24 sm:px-6 sm:pt-28 md:pt-36">
        <p className="text-ui text-fg-dim">{kicker}</p>
        <h1 className="mt-3 max-w-[22ch] text-title text-balance text-fg">{title}</h1>
        {children && (
          <div className="measure mt-5 flex flex-col gap-4 text-lead text-pretty text-fg-dim">
            {children}
          </div>
        )}
        <div className="mt-10 max-w-3xl border-t border-hair pt-4">
          <PlaceholderNote phase={phase} />
        </div>
      </div>
    </section>
  );
}
