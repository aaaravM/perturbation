// The Lab while its scripts load (the page's Suspense fallback and explore/loading.tsx): the same
// panes as the workbench (session bar, data pane, viewer with its toolbar and readouts, blink
// player, analysis pane), at the same sizes, as quiet blocks. Three panes from 900 px and the
// phone tabs below, in CSS, as the workbench does in script. The blink player and the analysis
// pane take the shape of a target's field when the address names one (see LabSkeletonScript),
// and the visitor's own pane layout is followed, so nothing moves when the Lab arrives.

import { Skeleton, SkeletonRegion } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { LabSkeletonScript } from "./lab-skeleton-script";

/** A line of text as a block: `h` is the text's x-height band, `w` its length. */
function Bar({ w, className }: { w: string; className?: string }) {
  return <Skeleton className={cn("h-2.5 shrink-0 rounded-[3px]", className)} style={{ width: w }} />;
}

/** A 28 px icon button with its 14 px glyph. */
function IconSlot({ className }: { className?: string }) {
  return (
    <span aria-hidden className={cn("grid size-7 shrink-0 place-items-center", className)}>
      <Skeleton className="size-3.5 rounded-[3px]" />
    </span>
  );
}

function Rule({ className }: { className?: string }) {
  return <span aria-hidden className={cn("mx-1 h-4 w-px shrink-0 bg-hair", className)} />;
}

const TARGET = "group-data-[field=target]/lab:flex";
const IDLE = "group-data-[field=target]/lab:hidden";

function SessionBar() {
  return (
    <div aria-hidden className="flex h-9 shrink-0 items-center gap-3 border-b border-hair bg-ink-2 px-3">
      <div className="flex min-w-0 items-center gap-2">
        <Bar w="4.75rem" />
        <Bar w="8.75rem" className="max-[420px]:w-16!" />
        <Bar w="13rem" className="hidden md:block" />
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-0.5">
        <span className="mr-1 inline-flex h-7 items-center gap-1.5 px-2">
          <Skeleton className="size-3.5 rounded-[3px]" />
          <Bar w="5.6rem" className="hidden sm:block" />
        </span>
        <span className="mr-1 inline-flex h-7 items-center gap-1.5 px-2">
          <Skeleton className="size-3.5 rounded-[3px]" />
          <Bar w="1.6rem" className="hidden sm:block" />
        </span>
        <IconSlot />
        <IconSlot />
        <IconSlot />
        <IconSlot />
        <span className="hidden items-center gap-0.5 min-[900px]:flex">
          <Rule />
          <IconSlot />
          <IconSlot />
          <IconSlot />
        </span>
      </div>
    </div>
  );
}

function DataPane() {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-hair px-3 pt-3 pb-2.5">
        <div className="flex flex-col gap-2.5">
          <Skeleton className="h-10 w-full rounded-md border border-hair-strong bg-transparent" />
          <div className="flex flex-col gap-1.5 py-0.5">
            <Bar w="92%" />
            <Bar w="48%" />
          </div>
          <div className="flex flex-col gap-[17px] py-1">
            {[
              ["5.2rem", "5.6rem"],
              ["6.1rem", "4.6rem"],
              ["4.4rem"],
            ].map((row, i) => (
              <div key={i} className="flex gap-4">
                {row.map((w, j) => (
                  <Bar key={j} w={w} className="h-3" />
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <div className="border-b border-hair pb-2">
          <div className="flex h-8 items-center justify-between px-3">
            <Bar w="2.6rem" />
            <Bar w="4rem" className={cn("hidden", TARGET)} />
          </div>
          <div className={cn("flex flex-col gap-1.5 px-3 pb-2", IDLE)}>
            <Bar w="94%" />
            <Bar w="70%" />
          </div>
          <div className={cn("hidden flex-col", TARGET)}>
            <Bar w="62%" className="mx-3 mb-3" />
            {Array.from({ length: 7 }, (_, i) => (
              <div key={i} className="flex h-[33px] items-center gap-3 border-t border-hair px-3 first:h-6 first:border-t-0">
                <Bar w="3.2rem" />
                <Bar w="2.4rem" className="ml-auto" />
                <Bar w="2.6rem" />
                <Bar w="1rem" />
              </div>
            ))}
          </div>
        </div>
        <div className="pb-3">
          <div className="flex h-8 items-center px-3">
            <Bar w="2.4rem" />
          </div>
          {[true, false, true, false, false, false, true].map((slider, i) => (
            <div key={i} className="flex items-center gap-2 px-3 py-1.5">
              <IconSlot className="size-6" />
              <div className="flex min-w-0 flex-1 flex-col gap-1.5 py-0.5">
                <Bar w={`${58 + ((i * 17) % 30)}%`} className="h-3" />
                <Bar w={`${74 + ((i * 11) % 22)}%`} />
              </div>
              {slider ? <Skeleton className="h-1 w-[4.5rem] shrink-0 rounded-full" /> : <span className="w-[4.5rem] shrink-0" />}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ViewerToolbar() {
  return (
    <div aria-hidden className="flex h-9 shrink-0 items-center gap-1 overflow-hidden border-b border-hair px-2">
      <IconSlot />
      <IconSlot />
      <IconSlot />
      <Rule />
      <IconSlot />
      <IconSlot />
      <Rule />
      <span className="inline-flex h-7 shrink-0 items-center gap-2 px-2">
        <Skeleton className="size-3.5 rounded-[3px]" />
        <Bar w="2.4rem" />
        <Skeleton className="h-2 w-8 rounded-[2px]" />
      </span>
      <div className="ml-auto flex shrink-0 items-center gap-1 pl-2">
        <IconSlot />
        <Bar w="1.9rem" className="ml-1" />
        <IconSlot />
        <Bar w="1.6rem" className="mx-2" />
        <IconSlot />
      </div>
    </div>
  );
}

function StatusBar() {
  return (
    <div aria-hidden className="flex min-h-8 shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-t border-hair bg-ink-2 px-3 py-1">
      {["11.75rem", "11.75rem", "1.9rem", "2.6rem", "2.6rem", "1.2rem", "3.4rem", "2.9rem"].map((w, i) => (
        <span key={i} className="flex h-4 items-center" style={{ width: w }}>
          <Bar w={i < 2 ? "1.4rem" : "100%"} />
        </span>
      ))}
    </div>
  );
}

/** The blink player: a sentence before a field is chosen, the whole player for a target. */
function Player() {
  return (
    <div aria-hidden className="shrink-0 border-t border-hair bg-ink-2">
      <div className={cn("flex flex-col gap-1.5 px-3 py-[13px]", IDLE)}>
        <Bar w="96%" className="h-3" />
        <Bar w="38%" className="h-3 mt-[7px]" />
      </div>
      <div className={cn("hidden h-[220px] flex-col gap-2 px-3 pt-2 pb-2.5", TARGET)}>
        <div className="flex h-7 items-center gap-3">
          <Bar w="2.8rem" className="h-3" />
          <Bar w="4.6rem" className="h-3" />
          <Bar w="4.4rem" className="h-3" />
          <Rule className="mx-0" />
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <Bar key={i} w="1rem" />
          ))}
          <Bar w="2.4rem" />
        </div>
        <div className="flex h-7 items-center justify-end gap-2">
          <Skeleton className="h-7 w-[7.4rem] rounded-md" />
          <Skeleton className="h-7 w-[8.9rem] rounded-md" />
        </div>
        <div className="flex min-h-0 flex-1 items-center gap-3">
          <Skeleton className="size-8 shrink-0 rounded-md" />
          <IconSlot />
          <IconSlot />
          <div className="flex min-w-0 flex-1 flex-col justify-center gap-3 px-2">
            <Skeleton className="h-9 w-full rounded-[4px] opacity-60" />
            <div className="flex justify-between">
              {[0, 1, 2, 3, 4].map((i) => (
                <Bar key={i} w="1.6rem" />
              ))}
            </div>
          </div>
          <Bar w="6.4rem" className="hidden sm:block" />
        </div>
        <div className="flex items-end justify-between gap-6">
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Bar w="96%" />
            <Bar w="58%" />
          </div>
          <div className="hidden items-center gap-3 sm:flex">
            <Bar w="5rem" />
            <Skeleton className="h-1 w-24 rounded-full" />
            <Bar w="2.6rem" />
          </div>
        </div>
      </div>
    </div>
  );
}

function AnalysisPane() {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div aria-hidden className="flex h-9 shrink-0 items-center gap-1 border-b border-hair pr-1 pl-2">
        <div className="flex min-w-0 flex-1 items-center gap-3 overflow-hidden px-1.5">
          {["2.4rem", "3.6rem", "4.3rem", "2.9rem", "1.8rem", "4.6rem"].map((w, i) => (
            <Bar key={i} w={w} />
          ))}
        </div>
        <IconSlot className={cn("hidden", "group-data-[field=target]/lab:grid")} />
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-5 pt-7">
        <div className={cn("flex flex-col", IDLE)}>
          <Skeleton className="size-4 rounded-[4px]" />
          <Bar w="62%" className="mt-[18px] h-3.5" />
          <div className="mt-5 flex flex-col gap-[9px]">
            <Bar w="96%" />
            <Bar w="100%" />
            <Bar w="92%" />
            <Bar w="58%" />
          </div>
        </div>
        <div className={cn("hidden flex-col", TARGET)}>
          <Bar w="9.5rem" />
          <Skeleton className="mt-[18px] h-5 w-[min(100%,12rem)] rounded-[4px]" />
          <Bar w="13rem" className="mt-[15px] h-3" />
          <div className="mt-6 flex flex-col gap-[9px]">
            <Bar w="98%" />
            <Bar w="100%" />
            <Bar w="96%" />
            <Bar w="48%" />
          </div>
          <Bar w="8.8rem" className="mt-7 h-3" />
        </div>
        <div className={cn("-mx-5 mt-7 hidden flex-col border-t border-hair px-5 pt-6", TARGET)}>
          <div className="flex justify-between">
            <Bar w="3.6rem" className="h-3" />
            <Bar w="5.4rem" />
          </div>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="mt-[15px] flex gap-6">
              <Bar w="4.4rem" />
              <Bar w={`${46 + ((i * 13) % 20)}%`} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * The whole Lab as blocks. `detect` adds the small script that reads the address and the stored
 * layout before the first paint; it is for the server-rendered fallback, where it runs as the page
 * is parsed (on a client render it is left out: a client-rendered script would not run).
 */
export function LabSkeleton({ detect = false }: { detect?: boolean }) {
  return (
    <SkeletonRegion
      label="Loading the Lab"
      data-field="idle"
      className="group/lab absolute inset-0 flex flex-col bg-ink [--lab-l:280px] [--lab-r:404px]"
    >
      {detect && <LabSkeletonScript />}
      <SessionBar />
      {/* Phones: the three pane tabs, the viewer underneath. */}
      <div aria-hidden className="grid h-9 shrink-0 grid-cols-3 border-b border-hair bg-ink-2 min-[900px]:hidden">
        {["1.9rem", "2.6rem", "3.4rem"].map((w, i) => (
          <span key={i} className="flex items-center justify-center">
            <Bar w={w} />
          </span>
        ))}
      </div>
      <div className="flex min-h-0 flex-1">
        <div
          data-pane="data"
          className="hidden min-h-0 w-(--lab-l) shrink-0 flex-col bg-ink-2 min-[900px]:flex group-data-[data=off]/lab:hidden!"
        >
          <DataPane />
        </div>
        <span aria-hidden className="hidden w-px shrink-0 bg-hair min-[900px]:block group-data-[data=off]/lab:hidden!" />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <ViewerToolbar />
          <div className="min-h-0 flex-1" />
          <StatusBar />
          <div className="group-data-[player=off]/lab:min-[900px]:hidden">
            <Player />
          </div>
        </div>
        <span aria-hidden className="hidden w-px shrink-0 bg-hair min-[900px]:block group-data-[analysis=off]/lab:hidden!" />
        <div
          data-pane="analysis"
          className="hidden min-h-0 w-(--lab-r) shrink-0 flex-col bg-ink-2 min-[900px]:flex group-data-[analysis=off]/lab:hidden!"
        >
          <AnalysisPane />
        </div>
      </div>
    </SkeletonRegion>
  );
}
