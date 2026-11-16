"use client";
// The home page: the hero, then the story of how the site finds things that move, told with
// real SPHEREx data and scrubbed by scroll.
//
// Wide screens: one stage stays pinned while five text beats scroll past it, each pausing in the
// middle while its scene plays: the globe dives into Barnard's Star's patch, the patch splits into
// the six detectors, the visits flip under a glass loupe, a glass wiper subtracts them, and the
// results arrive on glass cards over the Milky Way. The text is real content in reading order;
// the stage is one labelled image.
// Phones: the same scenes stacked, each played by its own pass through the screen (no pinning).
// Reduced motion (the Motion setting, else the system): the same stack, held still, fading in.
// Both layouts are rendered and CSS shows one (no layout shift); only the one in use runs WebGL.

import * as React from "react";
import Link from "next/link";
import { ArrowRightIcon } from "lucide-react";
import { motion, useMotionValue, useScroll, useTransform, type MotionValue } from "motion/react";
import { Button } from "@/components/ui/button";
import { Term } from "@/components/ui/term";
import { useEffectiveReducedMotion, useMediaQuery, usePreferencesReady } from "@/lib/preferences";
import { cn } from "@/lib/utils";
import { StoryGlobe } from "./story-globe";
import { BlinkScene, DetectorsScene, SubtractScene } from "./story-scenes";
import { ResultCards } from "./story-results";
import { GLOBE_STILL, VISITS } from "./story-data";
import { smooth, span } from "./story-math";
import { TWO_WAYS_ID, TwoWaysIn } from "./two-ways-in";

const BARNARD_HREF = "/explore?target=barnards-star";
const SKIP_HREF = `#${TWO_WAYS_ID}`;

interface Beat {
  title: string;
  body: React.ReactNode;
  /** Scroll length on wide screens, in viewport heights. */
  vh: number;
  /** The scene's progress when held still (reduced motion). */
  still: number;
}

const BEATS: readonly Beat[] = [
  {
    title: "SPHEREx photographs the whole sky every six months.",
    body: "NASA’s infrared space telescope sweeps every direction twice a year. This globe is its real all-sky map.",
    vh: 1.7,
    still: 0,
  },
  {
    title: "In 102 colours of infrared.",
    body: "Six detectors split the light into 102 narrow bands. Here is one small patch of sky, around Barnard’s Star, through each of them. Where its centre shows dark, the star is too bright to measure.",
    vh: 1.4,
    still: 0.82,
  },
  {
    title: "Flip between visits, and nearby things jump.",
    body: (
      <>
        Barnard&rsquo;s Star moved 10.4 <Term k="arcsecond">arcseconds</Term> north in a year. We measure 10.55&nbsp;±&nbsp;0.12
        a year; Gaia measured 10.41.
      </>
    ),
    vh: 1.7,
    still: 0.47,
  },
  {
    title: "Subtract, and only change remains.",
    body: (
      <>
        Take one visit from another to get a <Term k="difference">difference image</Term>. Still stars cancel out; Barnard&rsquo;s
        Star shows dark where it was, bright where it is.
      </>
    ),
    vh: 1.3,
    still: 0.95,
  },
];

const RESULTS_BEAT = {
  title: "Then measure it.",
  body: "Every number here was measured by this project from SPHEREx images.",
  vh: 1.5,
};

// Wide-screen timeline, in viewport heights of scroll. Block tops: the hero, four beats, results.
const BLOCK_TOPS = [0, 1, ...BEATS.map((_, i) => 1 + BEATS.slice(0, i + 1).reduce((a, b) => a + b.vh, 0))];
const TRACK_VH = BLOCK_TOPS[BLOCK_TOPS.length - 1] + RESULTS_BEAT.vh;
const RANGE_VH = TRACK_VH - 1;
/** Each scene plays from just before its text arrives until just before the next one's. */
const LEAD = 0.6;
const SCENES: [number, number][] = [
  ...BEATS.map((_, i): [number, number] => [BLOCK_TOPS[i + 1] - LEAD, BLOCK_TOPS[i + 2] - LEAD]),
  [BLOCK_TOPS[BEATS.length + 1] - LEAD, RANGE_VH],
];

function useElementWidth(ref: React.RefObject<HTMLElement | null>) {
  const [width, setWidth] = React.useState(0);
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.round(el.getBoundingClientRect().width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}

export function HomeStory() {
  const ready = usePreferencesReady();
  const reduce = useEffectiveReducedMotion();
  const wide = useMediaQuery("(min-width: 64rem)");
  const stage = ready && !reduce && wide;
  const scroll = ready && !reduce && !wide;

  return (
    <>
      <div className="hidden lg:block reduced:hidden" data-story="stage">
        <StageStory active={stage} />
      </div>
      <div className="overflow-x-clip lg:hidden reduced:block" data-story="stack">
        <StackedStory animate={scroll} />
      </div>
      <TwoWaysIn animate={ready && !reduce} />
    </>
  );
}

// ------------------------------------------------------------------------------------ hero

function HeroCopy({ id, skip = true }: { id: string; skip?: boolean }) {
  return (
    <div className="pointer-events-auto flex flex-col items-start">
      <h1 id={id} className="text-display text-balance text-fg">
        Perturbation
      </h1>
      <p className="mt-3 text-title text-balance text-fg">Watch the sky move.</p>
      <p className="measure mt-6 text-lead text-pretty text-fg-dim">
        This site lets anyone flip between NASA SPHEREx&rsquo;s infrared maps of the sky and catch stars, brown dwarfs and
        even Pluto in motion.
      </p>
      <div className="mt-9 flex flex-wrap items-center gap-3">
        <Button asChild size="lg" className="h-11 gap-2 rounded-md px-5">
          <Link href={BARNARD_HREF}>
            Try Barnard&rsquo;s Star
            <ArrowRightIcon aria-hidden />
          </Link>
        </Button>
        <Button
          asChild
          size="lg"
          variant="ghost"
          className="h-11 rounded-md border-hair-strong bg-ink/40 px-5 text-fg-dim backdrop-blur-sm hover:text-fg"
        >
          <Link href="/sky">Explore the sky globe</Link>
        </Button>
      </div>
      {skip && (
        <p className="mt-10 text-meta text-fg-faint">
          Scroll for the story, or{" "}
          <a href={SKIP_HREF} className="rounded-sm text-fg-dim underline decoration-hair-strong underline-offset-4 hover:text-fg">
            skip the story
          </a>
          .
        </p>
      )}
    </div>
  );
}

// ----------------------------------------------------------------------------- wide stage

function StageStory({ active }: { active: boolean }) {
  const track = React.useRef<HTMLDivElement>(null);
  const plate = React.useRef<HTMLDivElement>(null);
  const size = useElementWidth(plate);
  const { scrollYProgress } = useScroll({ target: track, offset: ["start start", "end end"] });
  const at = useTransform(scrollYProgress, (v) => v * RANGE_VH);

  const s1 = useTransform(at, (v) => span(v, ...SCENES[0]));
  const s2 = useTransform(at, (v) => span(v, ...SCENES[1]));
  const s3 = useTransform(at, (v) => span(v, ...SCENES[2]));
  const s4 = useTransform(at, (v) => span(v, ...SCENES[3]));
  const s5 = useTransform(at, (v) => span(v, ...SCENES[4]));
  const globeExit = useTransform(at, (v): number => (v >= SCENES[1][0] && v < SCENES[4][0] ? 1 : 0));
  const horizon = useTransform(at, (v) => (v >= SCENES[4][0] ? Math.max(0.0001, span(v, ...SCENES[4])) : 0));
  const caption = useTransform(at, (v) => 1 - smooth(span(v, 0.25, 0.65)));
  const scrim = useTransform(at, (v) => smooth(span(v, 0.45, 0.9)) * (1 - smooth(span(v, 1.5, 1.8))));
  const chrome = useTransform(at, (v) => smooth(span(v, 0.6, 0.9)) * (1 - smooth(span(v, RANGE_VH - 0.25, RANGE_VH))));
  const chromeVisibility = useTransform(chrome, (v) => (v > 0.02 ? "visible" : "hidden"));
  /** As the story ends the stage's lower edge melts into the page, so no hard seam scrolls past. */
  const settle = useTransform(at, (v) => smooth(span(v, RANGE_VH - 0.5, RANGE_VH - 0.05)));

  const l2 = useLayer(at, SCENES[1][0], SCENES[2][0]);
  const l3 = useLayer(at, SCENES[2][0], SCENES[3][0]);
  const l4Fade = useTransform(at, (v) => (v >= SCENES[3][0] ? 1 - smooth(span(v, SCENES[4][0] - 0.1, SCENES[4][0] + 0.12)) : 0));
  const l4Visibility = useTransform(l4Fade, (v) => (v > 0.001 ? "visible" : "hidden"));

  return (
    <div ref={track} className="relative -mt-(--nav-h)" style={{ height: `${TRACK_VH * 100}svh` }}>
      {/* The hero comes first in reading order; the stage is pinned under it from the top. */}
      <section aria-labelledby="hero-stage" className="pointer-events-none relative z-10 flex h-svh items-center">
        <div className="ml-[max(1.5rem,6vw)] w-[min(34rem,36vw)] pt-(--nav-h)">
          <HeroCopy id="hero-stage" skip={false} />
        </div>
      </section>

      <div className="sticky top-0 -mt-[100svh] h-svh overflow-hidden">
        <div
          role="img"
          aria-label="Real SPHEREx data, scrubbed by scroll: the all-sky map on a globe, zooming into Barnard's Star; the same patch through six detectors; three visits over a year, with the star jumping north; and the difference image, where only the star's change remains."
          className="absolute inset-0"
        >
          <StoryGlobe
            mode="stage"
            dive={s1}
            horizon={horizon}
            exit={globeExit}
            active={active}
            plateRef={plate}
            restClassName="[--gr:min(46svh,28vw)] size-[calc(var(--gr)*2)] left-[calc(71%-var(--gr))] top-[calc(54%-var(--gr))]"
          />
          <div
            ref={plate}
            className="absolute [--plate:min(68svh,42vw)] size-(--plate) left-[calc(69%-var(--plate)/2)] top-[calc(47%-var(--plate)/2)]"
          >
            {size > 0 && (
              <>
                <motion.div className="absolute inset-0" style={l2}>
                  <DetectorsScene p={s2} size={size} animate={active} />
                </motion.div>
                <motion.div className="absolute inset-0" style={l3}>
                  <BlinkScene p={s3} size={size} animate={active} />
                </motion.div>
                <motion.div className="absolute inset-0" style={{ opacity: l4Fade, visibility: l4Visibility }}>
                  <SubtractScene p={s4} size={size} />
                </motion.div>
              </>
            )}
          </div>
          {/* Keeps the words legible over the bright Milky Way while the globe fills the stage. */}
          <motion.div style={{ opacity: scrim }} className="absolute inset-y-0 left-0 w-[62%] bg-linear-to-r from-ink/85 via-ink/50 to-transparent" />
          <motion.p style={{ opacity: caption }} className="absolute right-6 bottom-5 max-w-[15rem] text-right text-micro text-fg-faint">
            SPHEREx all-sky map, data release 1. Caltech/IPAC/NASA, IRSA.
          </motion.p>
          <motion.div
            style={{ opacity: settle }}
            className="pointer-events-none absolute inset-x-0 bottom-0 h-[34svh] bg-linear-to-t from-ink via-ink/70 to-transparent"
          />
        </div>

        <motion.div style={{ opacity: chrome, visibility: chromeVisibility }}>
          <ProgressRail parts={[s1, s2, s3, s4, s5]} />
        </motion.div>
        {/* On screen for the whole story, and next to the words in the tab order. */}
        <a
          href={SKIP_HREF}
          className="absolute bottom-5 left-7 z-20 rounded-sm text-meta text-fg-dim underline decoration-hair-strong underline-offset-4 transition-colors hover:text-fg"
        >
          Skip the story
        </a>
      </div>

      {/* The words, in reading order, scrolling over the stage. */}
      <div className="pointer-events-none relative z-10">
        {BEATS.map((beat, i) => (
          <StageBeat key={beat.title} beat={beat} index={i} at={at} />
        ))}
        <section aria-labelledby="beat-stage-5" className="relative" style={{ height: `${RESULTS_BEAT.vh * 100}svh` }}>
          <div className="sticky top-0 flex h-svh flex-col justify-center px-[max(1.5rem,6vw)] pt-[calc(var(--nav-h)+2rem)]">
            <div className="pointer-events-auto mx-auto w-full max-w-6xl">
              <h2 id="beat-stage-5" className="text-title text-balance text-fg">
                {RESULTS_BEAT.title}
              </h2>
              <p className="measure mt-3 mb-8 text-lead text-pretty text-fg-dim">{RESULTS_BEAT.body}</p>
              <ResultCards animate={active} />
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

/** A scene layer shown only inside [a, b) of the timeline (the next one starts on the same image). */
function useLayer(at: MotionValue<number>, a: number, b: number) {
  const opacity = useTransform(at, (v) => (v >= a && v < b ? 1 : 0));
  const visibility = useTransform(at, (v) => (v >= a && v < b ? "visible" : "hidden"));
  return { opacity, visibility };
}

function StageBeat({ beat, index, at }: { beat: Beat; index: number; at: MotionValue<number> }) {
  const top = BLOCK_TOPS[index + 1];
  const opacity = useTransform(at, (v) => smooth(span(v, top - 0.5, top - 0.08)) * (1 - smooth(span(v, top + beat.vh - 0.92, top + beat.vh - 0.5))));
  const id = `beat-stage-${index + 1}`;
  return (
    <section aria-labelledby={id} className="relative" style={{ height: `${beat.vh * 100}svh` }}>
      <div className="sticky top-0 flex h-svh items-center">
        <motion.div style={{ opacity }} className="pointer-events-auto ml-[max(1.5rem,6vw)] w-[min(30rem,34vw)]">
          <h2 id={id} className="text-title text-balance text-fg">
            {beat.title}
          </h2>
          <p className="mt-5 text-lead text-pretty text-fg-dim">{beat.body}</p>
        </motion.div>
      </div>
    </section>
  );
}

function ProgressRail({ parts }: { parts: MotionValue<number>[] }) {
  return (
    <div aria-hidden className="absolute top-1/2 left-7 flex -translate-y-1/2 flex-col gap-1.5">
      {parts.map((part, i) => (
        <span key={i} className="relative h-8 w-0.5 overflow-hidden rounded-[1px] bg-hair-strong">
          <motion.span className="absolute inset-0 origin-top bg-accent" style={{ scaleY: part }} />
        </span>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------------- stacked (phones)

function StackedStory({ animate }: { animate: boolean }) {
  return (
    <>
      <section aria-labelledby="hero-stack" className="relative -mt-(--nav-h) overflow-hidden pt-[calc(var(--nav-h)+2.5rem)]">
        <div className="mx-auto grid w-full max-w-6xl items-center gap-x-16 gap-y-6 px-4 sm:px-6 lg:min-h-svh lg:grid-cols-[5fr_6fr]">
          <HeroCopy id="hero-stack" />
          <div className="relative mx-auto aspect-square w-[112%] max-w-[40rem] lg:w-full">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={GLOBE_STILL}
              alt="The SPHEREx all-sky map on a globe, the Milky Way running across it"
              decoding="async"
              className="absolute inset-0 size-full"
            />
          </div>
        </div>
      </section>

      {BEATS.map((beat, i) => (
        <StackedBeat key={beat.title} beat={beat} index={i} animate={animate} />
      ))}

      <section aria-labelledby="beat-stack-5" className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6 lg:py-24">
        <h2 id="beat-stack-5" className="text-title text-balance text-fg">
          {RESULTS_BEAT.title}
        </h2>
        <p className="measure mt-3 mb-8 text-lead text-pretty text-fg-dim">{RESULTS_BEAT.body}</p>
        <ResultCards animate={animate} />
      </section>
    </>
  );
}

function StackedBeat({ beat, index, animate }: { beat: Beat; index: number; animate: boolean }) {
  const plate = React.useRef<HTMLDivElement>(null);
  const size = useElementWidth(plate);
  const { scrollYProgress } = useScroll({ target: plate, offset: ["start 0.85", "end 0.3"] });
  const fixed = useMotionValue(beat.still);
  // On phones the globe starts already turning towards Barnard's Star (the hero shows it at rest).
  const dive = useTransform(scrollYProgress, (v) => 0.18 + 0.82 * v);
  const p = animate ? scrollYProgress : fixed;
  const id = `beat-stack-${index + 1}`;
  return (
    <section
      aria-labelledby={id}
      className="mx-auto grid w-full max-w-6xl gap-x-16 gap-y-8 px-4 py-14 sm:px-6 lg:grid-cols-[5fr_6fr] lg:items-center lg:py-20"
    >
      <div>
        <h2 id={id} className="text-title text-balance text-fg">
          {beat.title}
        </h2>
        <p className="mt-4 text-lead text-pretty text-fg-dim">{beat.body}</p>
      </div>
      <div className={cn((index > 0 || !animate) && "pb-20")}>
        <div
          ref={plate}
          role="img"
          aria-label={STACK_ALT[index]}
          className={cn("relative mx-auto aspect-square w-full max-w-[34rem]", index === 0 && animate && "overflow-hidden")}
        >
          {index === 0 ? (
            animate ? (
              <StoryGlobe mode="plate" dive={dive} active restClassName="inset-[4%] size-[92%]" />
            ) : (
              <StillPatch />
            )
          ) : size > 0 ? (
            index === 1 ? (
              <DetectorsScene p={p} size={size} animate={animate} />
            ) : index === 2 ? (
              <BlinkScene p={p} size={size} animate={animate} />
            ) : (
              <SubtractScene p={p} size={size} />
            )
          ) : null}
        </div>
      </div>
    </section>
  );
}

/** The end of the dive, held still: the patch around Barnard's Star. */
function StillPatch() {
  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={VISITS[0].src} alt="" className="absolute inset-0 size-full [image-rendering:pixelated]" />
      <p className="absolute inset-x-0 top-full pt-3 text-micro text-fg-faint">
        Around Barnard&rsquo;s Star: a patch a third as wide as the full Moon. SPHEREx D6, 4.4–5.0 µm, Aug 2025.
      </p>
    </>
  );
}

const STACK_ALT = [
  "The SPHEREx all-sky map on a globe, with Barnard's Star marked; scrolling zooms into its patch of sky.",
  "Barnard's Star's patch of sky in SPHEREx's six detectors, from 0.75 to 5 microns, and the 102 bands they record.",
  "Barnard's Star in SPHEREx images from August 2025, March 2026 and August 2026, under a magnifier: it moves north by 10.4 arcseconds.",
  "The difference between the August 2026 and August 2025 images: grey everywhere except a dark and a bright spot where Barnard's Star was and is.",
];
