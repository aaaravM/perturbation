// Skeletons of the content pages, shown while a page loads (each route's loading.tsx). Each one
// keeps its page's grid, column widths and spacing, so the page takes the same place when it
// arrives. Blocks only: no words, no spinner, no accent. Each one waits 0.4 s before it shows
// (.skeleton-wait in globals.css), so a page that is already in the file never flashes it.

import { Skeleton, SkeletonRegion, SkeletonText } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/** One line of a heading, in that heading's own type style. */
function HeadingBlock({ className, width }: { className: string; width: string }) {
  return (
    <div aria-hidden className={cn("flex flex-col", className)}>
      <Skeleton className="my-[0.14lh] h-[0.72lh] max-w-full rounded-[4px]" style={{ width }} />
    </div>
  );
}

/** The "On this page" column beside the sections (wide screens) and the list under the title. */
function IndexColumn({ items }: { items: number }) {
  return (
    <div className="hidden lg:block">
      <div className="sticky top-28">
        <div className="mb-3 pl-4 text-meta">
          <SkeletonText lines={1} className="w-20" />
        </div>
        <div className="relative">
          <span aria-hidden className="absolute top-1 bottom-1 left-0 w-px bg-hair-strong" />
          <div className="flex flex-col">
            {Array.from({ length: items }, (_, i) => (
              <div key={i} className="flex min-h-9 items-center gap-3 py-1.5 pl-4">
                <Skeleton className="h-2.5 w-2.5 shrink-0 rounded-[2px]" />
                <Skeleton className="h-2.5 rounded-[3px]" style={{ width: `${62 + ((i * 37) % 34)}%` }} />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function InlineIndex({ items }: { items: number }) {
  return (
    <div className="mt-8 lg:hidden">
      <div className="grid grid-cols-1 gap-x-6 border-t border-hair sm:grid-cols-2">
        {Array.from({ length: items }, (_, i) => (
          <div key={i} className="flex min-h-11 items-center gap-3 border-b border-hair">
            <Skeleton className="h-3 w-2.5 shrink-0 rounded-[2px]" />
            <Skeleton className="h-3 rounded-[3px]" style={{ width: `${44 + ((i * 29) % 30)}%` }} />
          </div>
        ))}
      </div>
    </div>
  );
}

/** A section as the article pages set it: hairline, heading, prose, then a figure. */
function SectionBlock({ figure = "aspect-[16/7]" }: { figure?: string }) {
  return (
    <div className="border-t border-hair pt-12 sm:pt-14">
      <HeadingBlock className="text-heading" width="min(100%, 16rem)" />
      <div className="mt-5 flex flex-col gap-8">
        <div className="measure flex flex-col gap-4 text-body">
          <SkeletonText lines={4} />
          <SkeletonText lines={3} last="48%" />
        </div>
        <Skeleton className={cn("w-full max-w-4xl rounded-lg", figure)} />
      </div>
    </div>
  );
}

/**
 * The article pages (the AI page, Planet X, How it works): a title and introduction, then the
 * sections beside their index. `intro` is what sits between the introduction and the sections.
 */
export function ArticleSkeleton({
  titleWidth,
  leadLines,
  phoneLeadLines = leadLines,
  sections,
  intro,
}: {
  titleWidth: string;
  /** Lines of the introduction from 640 px, and below that, where the column is narrower. */
  leadLines: number;
  phoneLeadLines?: number;
  sections: number;
  intro?: React.ReactNode;
}) {
  return (
    <SkeletonRegion className="skeleton-wait mx-auto w-full max-w-7xl px-4 pt-16 pb-28 sm:px-6 sm:pt-24">
      <div className="max-w-3xl">
        <HeadingBlock className="text-title sm:text-display" width={titleWidth} />
        <SkeletonText lines={phoneLeadLines} className="mt-5 max-w-2xl text-lead sm:hidden" />
        <SkeletonText lines={leadLines} className="mt-5 hidden max-w-2xl text-lead sm:flex" />
      </div>
      {intro}
      <div className="max-w-3xl">
        <InlineIndex items={sections} />
      </div>
      <div className="mt-14 lg:mt-20">
        <div className="lg:grid lg:grid-cols-[12rem_minmax(0,1fr)] lg:gap-14 xl:gap-20">
          <IndexColumn items={sections} />
          <div className="flex min-w-0 flex-col gap-16">
            <SectionBlock />
            <SectionBlock figure="aspect-[16/9]" />
          </div>
        </div>
      </div>
    </SkeletonRegion>
  );
}

/** The AI page's three parts under its introduction. */
export function AiPartsSkeleton() {
  return (
    <div className="mt-12 grid max-w-5xl grid-cols-1 gap-x-10 gap-y-6 md:grid-cols-3">
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex flex-col gap-1.5 border-t border-hair pt-4">
          <SkeletonText lines={1} className="w-36 text-ui" />
          <SkeletonText lines={3} className="text-meta" last="70%" />
        </div>
      ))}
    </div>
  );
}

/** How it works: the spectrum barcode and its caption under the introduction. */
export function BarcodeSkeleton() {
  return (
    <div className="mt-12 sm:mt-16">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-20 w-full rounded-[4px] sm:h-28" />
        <div className="flex gap-px sm:gap-[3px]">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="min-w-0 flex-1 border-t border-hair-strong pt-1.5 text-micro">
              <SkeletonText lines={1} className="w-8" />
            </div>
          ))}
        </div>
      </div>
      <SkeletonText lines={2} className="mt-3 max-w-2xl text-meta" />
    </div>
  );
}

/** About: the glass card over the sky picture, then sections with their title beside the text. */
export function AboutSkeleton() {
  return (
    <SkeletonRegion className="skeleton-wait flex flex-col">
      <div className="relative -mt-(--nav-h) overflow-hidden">
        <div className="relative mx-auto w-full max-w-7xl px-4 pt-[calc(var(--nav-h)+6rem)] pb-14 sm:px-6 sm:pt-[calc(var(--nav-h)+10rem)] sm:pb-20">
          <div className="max-w-xl rounded-[24px] border border-hair p-6 sm:p-8">
            <HeadingBlock className="text-title" width="min(100%, 20rem)" />
            <SkeletonText lines={3} className="mt-4 text-lead sm:hidden" last="40%" />
            <SkeletonText lines={2} className="mt-4 hidden text-lead sm:flex" />
          </div>
          <SkeletonText lines={2} className="mt-5 text-micro sm:hidden" last="45%" />
          <SkeletonText lines={1} className="mt-5 hidden w-[min(100%,26rem)] text-micro sm:flex" />
        </div>
      </div>
      <div className="mx-auto w-full max-w-7xl px-4 pb-28 sm:px-6">
        {[4, 3, 3].map((lines, i) => (
          <div
            key={i}
            className="grid grid-cols-1 gap-5 border-t border-hair py-12 sm:py-14 md:grid-cols-[13rem_minmax(0,1fr)] md:gap-10 lg:grid-cols-[17rem_minmax(0,1fr)]"
          >
            <HeadingBlock className="text-heading" width="min(100%, 13rem)" />
            <div className="flex max-w-3xl min-w-0 flex-col gap-5 text-body">
              <SkeletonText lines={lines} />
              <SkeletonText lines={lines - 1} last="54%" />
            </div>
          </div>
        ))}
      </div>
    </SkeletonRegion>
  );
}

/**
 * One Settings row as SettingRow sets it: the label and its description, the control beside them
 * from 640 px and under them on phones, and for the Glass row its preview picture and caption.
 */
function SettingRowBlock({
  lines,
  phoneLines,
  control,
  preview = false,
}: {
  lines: number;
  phoneLines: number;
  /** Size of the control's block: a choice of three, or a switch. */
  control: string;
  preview?: boolean;
}) {
  return (
    <div className="border-b border-hair py-5 last:border-b-0">
      <div className="grid gap-x-10 gap-y-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
        <div className="min-w-0">
          <SkeletonText lines={1} className="w-32 text-ui" />
          <SkeletonText lines={phoneLines} className="mt-1 max-w-[56ch] text-meta sm:hidden" last="58%" />
          <SkeletonText lines={lines} className="mt-1 hidden max-w-[56ch] text-meta sm:flex" last="58%" />
        </div>
        <div className="flex min-w-0 sm:justify-end">
          <Skeleton className={cn("shrink-0", control)} />
        </div>
      </div>
      {preview && (
        <div className="mt-4 flex flex-col gap-2.5">
          <Skeleton className="h-56 w-full rounded-[22px] sm:h-60" />
          <SkeletonText lines={3} className="text-micro sm:hidden" last="40%" />
          <SkeletonText lines={1} className="hidden text-micro sm:flex" />
        </div>
      )}
    </div>
  );
}

const CHOICE = "h-10 w-40 rounded-[11px]";
const SWITCH = "h-5 w-8 rounded-[6px]";

/**
 * Settings: the title, the section list beside the sections, and the sections as SettingsSection
 * sets them: Appearance with the glass preview under its first row, then the Sky globe's rows.
 */
export function SettingsSkeleton() {
  return (
    <SkeletonRegion className="skeleton-wait mx-auto w-full max-w-6xl px-4 pt-16 pb-28 sm:px-6 sm:pt-24">
      <div className="max-w-2xl">
        <HeadingBlock className="text-title" width="min(100%, 10rem)" />
        <SkeletonText lines={2} className="mt-3 text-lead sm:hidden" last="55%" />
        <SkeletonText lines={1} className="mt-3 hidden w-[min(100%,28rem)] text-lead sm:flex" />
      </div>
      <div className="mt-12 lg:grid lg:grid-cols-[11rem_minmax(0,1fr)] lg:gap-16 xl:gap-24">
        <div className="hidden lg:block">
          <div className="sticky top-28 flex flex-col gap-0.5">
            {Array.from({ length: 7 }, (_, i) => (
              <div key={i} className="relative flex h-9 items-center pl-3">
                <span aria-hidden className="absolute top-2 bottom-2 left-0 w-px bg-hair-strong" />
                <Skeleton className="h-2.5 rounded-[3px]" style={{ width: `${48 + ((i * 23) % 40)}%` }} />
              </div>
            ))}
          </div>
        </div>
        <div className="flex max-w-3xl min-w-0 flex-col gap-16">
          <div className="border-t border-hair pt-8">
            <HeadingBlock className="text-heading" width="min(100%, 9rem)" />
            <div className="mt-4 flex flex-col">
              <SettingRowBlock lines={2} phoneLines={3} control={CHOICE} preview />
              <SettingRowBlock lines={3} phoneLines={3} control="h-10 w-60 max-w-full rounded-[11px]" />
              <SettingRowBlock lines={2} phoneLines={3} control={SWITCH} />
            </div>
          </div>
          <div className="border-t border-hair pt-8">
            <HeadingBlock className="text-heading" width="min(100%, 7rem)" />
            <SkeletonText lines={2} className="mt-2 max-w-[60ch] text-meta sm:hidden" last="50%" />
            <SkeletonText lines={1} className="mt-2 hidden max-w-[60ch] text-meta sm:flex" />
            <div className="mt-4 flex flex-col">
              <SettingRowBlock lines={2} phoneLines={4} control={CHOICE} />
              <SettingRowBlock lines={2} phoneLines={2} control={CHOICE} />
              <SettingRowBlock lines={1} phoneLines={2} control={SWITCH} />
              <SettingRowBlock lines={1} phoneLines={2} control={SWITCH} />
            </div>
          </div>
        </div>
      </div>
    </SkeletonRegion>
  );
}

/** The hero's words and its two buttons, line for line (HeroCopy in the home story). */
function HeroCopyBlocks({ skip = false }: { skip?: boolean }) {
  return (
    <div className="flex flex-col items-start">
      <HeadingBlock className="w-full text-display" width="min(100%, 5.5em)" />
      <HeadingBlock className="mt-3 w-full text-title" width="min(100%, 9em)" />
      <SkeletonText lines={4} className="measure mt-6 w-full text-lead sm:hidden" last="56%" />
      <SkeletonText lines={3} className="measure mt-6 hidden w-full text-lead sm:flex" last="30%" />
      <div aria-hidden className="mt-9 flex flex-wrap items-center gap-3">
        <Skeleton className="h-11 w-[11.25rem] rounded-md" />
        <Skeleton className="h-11 w-[11.125rem] rounded-md" />
      </div>
      {skip && <SkeletonText lines={1} className="mt-10 w-[15rem] max-w-full text-meta" />}
    </div>
  );
}

/**
 * Home: the hero as the home story sets it. Wide screens with motion: the words on the left of the
 * full-height stage and the globe at its resting place; phones, tablets and reduced motion: the
 * words on top and the globe picture under them.
 */
export function HomeSkeleton() {
  return (
    <SkeletonRegion className="skeleton-wait relative -mt-(--nav-h) flex flex-col">
      <div className="relative hidden h-svh lg:block reduced:hidden">
        <div aria-hidden className="pointer-events-none absolute inset-0">
          <Skeleton className="absolute left-[calc(71%-var(--gr))] top-[calc(54%-var(--gr))] size-[calc(var(--gr)*2)] rounded-full bg-ink-2 [--gr:min(46svh,28vw)]" />
        </div>
        <div className="relative flex h-svh items-center">
          <div className="ml-[max(1.5rem,6vw)] w-[min(34rem,36vw)] pt-(--nav-h)">
            <HeroCopyBlocks />
          </div>
        </div>
      </div>
      <div className="overflow-x-clip pt-[calc(var(--nav-h)+2.5rem)] lg:hidden reduced:block">
        <div className="mx-auto grid w-full max-w-6xl items-center gap-x-16 gap-y-6 px-4 sm:px-6 lg:min-h-svh lg:grid-cols-[5fr_6fr]">
          <HeroCopyBlocks skip />
          <div aria-hidden className="relative mx-auto aspect-square w-[112%] max-w-[40rem] lg:w-full">
            <Skeleton className="absolute inset-0 rounded-full bg-ink-2" />
          </div>
        </div>
      </div>
    </SkeletonRegion>
  );
}
