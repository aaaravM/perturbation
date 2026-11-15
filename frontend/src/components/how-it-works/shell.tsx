// Building blocks of the long-form pages: a numbered section, plain prose, a figure with its
// source, and the folded "For scientists" layer (a native <details>, so it works without
// JavaScript, opens from the keyboard and is found by the browser's find-in-page).

import type { ReactNode } from "react";
import { ChevronRightIcon } from "lucide-react";
import { REPO_URL } from "@/lib/site";
import { cn } from "@/lib/utils";

export function HowSection({
  id,
  n,
  title,
  children,
}: {
  id: string;
  n: number;
  title: string;
  children: ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-24 border-t border-hair pt-12 sm:pt-14">
      <p className="text-meta text-fg-faint">
        Step <span className="readout">{n}</span>
      </p>
      <h2 id={`${id}-title`} className="mt-2 text-heading text-balance text-fg">
        {title}
      </h2>
      <div className="mt-5 flex flex-col gap-8">{children}</div>
    </section>
  );
}

export function Prose({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("measure flex flex-col gap-4 text-body text-pretty text-fg-dim", className)}>{children}</div>;
}

export function FigureCaption({ children, source }: { children: ReactNode; source?: ReactNode }) {
  return (
    <figcaption className="mt-4 flex max-w-2xl flex-col gap-1 text-meta text-pretty text-fg-dim">
      <span>{children}</span>
      {source && <span className="text-fg-faint">Source: {source}</span>}
    </figcaption>
  );
}

export function ForScientists({ children }: { children: ReactNode }) {
  return (
    <details className="group max-w-3xl rounded-[14px] border border-hair bg-ink-2/60 open:bg-ink-2">
      <summary
        className={cn(
          "flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-[14px] px-4 text-ui text-fg-dim transition-colors",
          "hover:text-fg [&::-webkit-details-marker]:hidden",
        )}
      >
        <ChevronRightIcon
          aria-hidden
          className="size-4 shrink-0 transition-transform duration-300 ease-out-expo group-open:rotate-90 reduced:transition-none"
        />
        For scientists
      </summary>
      <div className="flex flex-col gap-4 border-t border-hair px-4 pt-4 pb-5 text-ui text-pretty text-fg-dim group-open:animate-in group-open:fade-in-0 group-open:slide-in-from-top-1 reduced:animate-none">
        {children}
      </div>
    </details>
  );
}

/** A compact two-column table for the scientists' layer. */
export function FactTable({ rows, head, label = "Details" }: { rows: ReactNode[][]; head?: ReactNode[]; label?: string }) {
  return (
    // Focusable, so the table can be scrolled sideways from the keyboard on a narrow screen.
    <div role="region" aria-label={label} tabIndex={0} className="-mx-1 overflow-x-auto px-1 focus-visible:outline-offset-0">
      <table className="w-full min-w-[22rem] border-collapse text-left text-meta">
        {head && (
          <thead>
            <tr className="border-b border-hair text-fg-faint">
              {head.map((h, i) => (
                <th key={i} scope="col" className="py-2 pr-4 font-normal">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
        )}
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-hair last:border-b-0">
              {r.map((c, j) =>
                j === 0 ? (
                  <th key={j} scope="row" className="py-2 pr-4 align-top font-normal text-fg">
                    {c}
                  </th>
                ) : (
                  <td key={j} className="py-2 pr-4 align-top text-fg-dim">
                    {c}
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A link to a file in the public repository. */
export function RepoLink({ path, children }: { path: string; children: ReactNode }) {
  return (
    <a
      href={`${REPO_URL}/blob/main/${path}`}
      className="text-fg underline decoration-hair-strong underline-offset-4 transition-colors hover:decoration-accent"
    >
      {children}
    </a>
  );
}
