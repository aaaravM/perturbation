"use client";
// Search box (names or coordinates) and quick picks for the five featured targets.

import { useRef, useState, type FormEvent } from "react";
import { CornerDownLeftIcon, LoaderCircleIcon, SearchIcon } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { FEATURED_TARGETS } from "@/lib/targets";
import { ResolveError, resolveQuery, type ResolvedPlace } from "@/lib/lab-resolve";
import { cn } from "@/lib/utils";

type SearchState =
  | { state: "idle" }
  | { state: "busy" }
  | { state: "done"; place: ResolvedPlace }
  | { state: "error"; message: string };

export function LabSearch({
  activeSlug,
  onPlace,
  onPickTarget,
}: {
  activeSlug: string | null;
  onPlace: (place: ResolvedPlace) => void;
  onPickTarget: (slug: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<SearchState>({ state: "idle" });
  const controllerRef = useRef<AbortController | null>(null);
  const reduce = useReducedMotion();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setStatus({ state: "busy" });
    try {
      const place = await resolveQuery(query, controller.signal);
      if (controller.signal.aborted) return;
      setStatus({ state: "done", place });
      onPlace(place);
    } catch (err) {
      if (controller.signal.aborted) return;
      setStatus({
        state: "error",
        message: err instanceof ResolveError ? err.message : "Search failed. Check the spelling or try coordinates.",
      });
    }
  };

  return (
    <div className="flex flex-col gap-2.5">
      <form role="search" onSubmit={submit} className="relative" aria-label="Find a place in the sky">
        <label htmlFor="lab-search" className="sr-only">
          Object name or coordinates
        </label>
        <SearchIcon aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-fg-faint" />
        <input
          id="lab-search"
          data-testid="lab-search"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            if (status.state === "error") setStatus({ state: "idle" });
          }}
          placeholder="Name or coordinates"
          autoComplete="off"
          spellCheck={false}
          aria-describedby="lab-search-hint"
          className="h-10 w-full rounded-md border border-hair-strong bg-ink/80 pr-10 pl-9 text-ui text-fg placeholder:text-fg-faint transition-colors outline-none focus-visible:border-accent focus-visible:outline-none"
        />
        <button
          type="submit"
          aria-label="Search"
          className="absolute top-1/2 right-1.5 grid size-7 -translate-y-1/2 place-items-center rounded-sm text-fg-faint transition-colors hover:text-fg"
        >
          {status.state === "busy" ? (
            <LoaderCircleIcon className="size-4 animate-spin" aria-hidden />
          ) : (
            <CornerDownLeftIcon className="size-4" aria-hidden />
          )}
        </button>
      </form>

      <p
        id="lab-search-hint"
        aria-live="polite"
        className={cn("min-h-4 text-micro text-fg-faint", status.state === "idle" && "hidden sm:block")}
        data-testid="lab-search-status"
      >
        {status.state === "idle" && (
          <span>
            For example <span className="readout text-fg-dim">GJ 699</span>,{" "}
            <span className="readout text-fg-dim">17 57 48 +04 41 36</span> or{" "}
            <span className="readout text-fg-dim">269.45 4.69</span>
          </span>
        )}
        {status.state === "busy" && "Looking it up…"}
        {status.state === "done" && (
          <>
            <span className="text-fg-dim">{status.place.name}.</span> {status.place.provenance}
          </>
        )}
        {status.state === "error" && <span className="text-destructive">{status.message}</span>}
      </p>

      <nav
        aria-label="Featured targets"
        className="-mx-1 flex gap-x-3.5 gap-y-1 overflow-x-auto px-1 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0"
      >
        {FEATURED_TARGETS.map((t) => {
          const active = t.slug === activeSlug;
          return (
            <button
              key={t.slug}
              type="button"
              data-testid={`quick-pick-${t.slug}`}
              aria-pressed={active}
              onClick={() => onPickTarget(t.slug)}
              title={t.tagline}
              className={cn(
                "relative py-0.5 text-meta whitespace-nowrap text-fg-dim transition-colors duration-200 hover:text-fg",
                active && "text-fg",
              )}
            >
              {t.name}
              {active && (
                <motion.span
                  layoutId="quick-pick-underline"
                  aria-hidden
                  className="absolute inset-x-0 -bottom-px h-px bg-accent"
                  transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 520, damping: 42 }}
                />
              )}
            </button>
          );
        })}
      </nav>
    </div>
  );
}
