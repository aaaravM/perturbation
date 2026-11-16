// The Sky globe while its scripts load (the page's Suspense fallback and sky/loading.tsx): the
// same layout as the sky experience, as quiet blocks. From 1024 px the introduction and the star
// lists stand in the left column and the globe sits in the space to their right; below that the
// introduction and the search sit on top, with the globe in the space under them. The view
// controls wait in the lower right corner. Words become blocks; the globe is a dark disc where the
// sphere will be drawn, the size the globe gives it.

import { Skeleton, SkeletonRegion, SkeletonText } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

function Bar({ w, className }: { w: string; className?: string }) {
  return <Skeleton className={cn("h-2.5 shrink-0 rounded-[3px]", className)} style={{ width: w }} />;
}

/**
 * The globe's disc: centred in the space the interface leaves free, as wide as the globe draws its
 * sphere there (84 % of that height, 90 % of its width, whichever is less).
 */
export function GlobeDisc({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <div aria-hidden className={cn("pointer-events-none flex items-center justify-center [container-type:size]", className)} style={style}>
      <Skeleton className="size-[min(84cqh,90cqw)] shrink-0 rounded-full bg-ink-2" />
    </div>
  );
}

const TARGET_ROWS = [
  ["6.4rem", "5.4rem", "12.4rem"],
  ["6.1rem", "5.6rem", "13.2rem"],
  ["7.6rem", "5.2rem", "10.4rem"],
  ["5.4rem", "6rem", "13.6rem"],
  ["5.6rem", "3.4rem", "14.4rem"],
];

function Intro({ compact = false }: { compact?: boolean }) {
  if (compact) {
    return (
      <div aria-hidden className="flex flex-col text-heading">
        <Skeleton className="my-[0.14lh] h-[0.72lh] w-[min(100%,15rem)] rounded-[4px]" />
      </div>
    );
  }
  return (
    <div aria-hidden className="flex flex-col gap-2.5">
      <div className="flex flex-col text-title">
        <Skeleton className="my-[0.14lh] h-[0.72lh] w-[10.5rem] rounded-[4px]" />
        <Skeleton className="my-[0.14lh] h-[0.72lh] w-[13.75rem] rounded-[4px]" />
      </div>
      <SkeletonText lines={4} className="text-ui" last="34%" />
    </div>
  );
}

function Search() {
  return (
    <div className="flex h-10 shrink-0 items-center gap-2 rounded-md border border-hair px-3">
      <Skeleton className="size-4 shrink-0 rounded-full" />
      <Bar w="min(100%, 15rem)" className="h-3" />
    </div>
  );
}

function Controls() {
  return (
    <div aria-hidden className="absolute right-3 bottom-4 z-10 flex items-center gap-2 lg:right-8 lg:bottom-6">
      <div className="hidden h-[30px] items-center gap-2 px-2 xl:flex">
        <Bar w="2.4rem" />
        <Bar w="11rem" />
      </div>
      <Skeleton className="hidden h-[34px] w-[4.1rem] rounded-md sm:block" />
      <div className="flex h-[34px] items-center gap-1 rounded-md border border-hair p-0.5">
        <Skeleton className="h-7 w-[3.6rem] rounded-[4px]" />
        <span className="flex h-7 w-[4.4rem] items-center justify-center">
          <Bar w="3.4rem" />
        </span>
      </div>
      <div className="flex h-[34px] items-center gap-1 rounded-md border border-hair p-0.5 pr-1.5">
        <span className="flex h-7 items-center gap-1.5 px-2">
          <Skeleton className="size-3.5 rounded-[3px]" />
          <Bar w="2.4rem" />
        </span>
        <span className="mx-1 h-4 w-px bg-hair-strong" />
        {[0, 1, 2].map((i) => (
          <span key={i} className="grid size-7 place-items-center">
            <Skeleton className="size-3.5 rounded-[3px]" />
          </span>
        ))}
      </div>
    </div>
  );
}

export function SkySkeleton() {
  return (
    <SkeletonRegion label="Loading the sky" className="absolute inset-0">
      {/* Wide screens: the column on the left, the globe in the space to its right. */}
      <div className="absolute top-7 bottom-6 left-8 hidden w-[20rem] flex-col gap-6 lg:flex xl:left-10">
        <Intro />
        <div className="flex min-h-0 flex-1 flex-col gap-3">
          <Search />
          <div className="flex h-9 shrink-0 items-center gap-5 border-b border-hair px-2.5">
            {["4rem", "3.3rem", "3.9rem", "3.3rem"].map((w, i) => (
              <Bar key={i} w={w} />
            ))}
          </div>
          <div className="flex flex-col pt-1">
            {TARGET_ROWS.map(([name, stat, line], i) => (
              <div key={i} className="flex items-start gap-3 py-2.5 pr-2 pl-3">
                <Skeleton className="mt-[5px] size-[9px] shrink-0 rotate-45 rounded-[1px]" />
                <div className="flex min-w-0 flex-1 flex-col gap-[9px] pt-[5px]">
                  <div className="flex items-center justify-between gap-2">
                    <Bar w={name} className="h-3" />
                    <Bar w={stat} />
                  </div>
                  <Bar w={line} className="mb-[3px]" />
                </div>
              </div>
            ))}
          </div>
          <Bar w="11rem" className="mt-[2.1rem]" />
        </div>
      </div>
      <GlobeDisc className="absolute inset-y-0 right-0 left-[360px] hidden lg:flex" />

      {/* Smaller screens: the introduction and the search on top, the globe below them. */}
      <div className="absolute inset-0 flex flex-col pt-3 pb-14 lg:hidden">
        <div className="mx-3 flex shrink-0 flex-col gap-2 sm:mx-5">
          <Intro compact />
          <div className="flex flex-col gap-3 rounded-lg border border-hair p-2">
            <Search />
            <div className="flex h-8 items-center justify-between px-1">
              <Bar w="5.2rem" />
              <Skeleton className="size-3 rounded-[3px]" />
            </div>
            <Bar w="10rem" className="mb-[3px]" />
          </div>
        </div>
        <GlobeDisc className="min-h-0 flex-1" />
      </div>

      <Controls />
    </SkeletonRegion>
  );
}
