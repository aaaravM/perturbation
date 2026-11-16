"use client";
// Scene 5 of the home page story: three measured results on glass cards. Each number counts up when
// its card comes into view (and again on the next pass); the value a screen reader hears is the
// final one, always. Values and sources: story-data.ts (docs/phase1 summaries, data-findings).

import * as React from "react";
import NumberFlow from "@number-flow/react";
import { motion } from "motion/react";
import { LiquidGlass } from "@/components/ui/liquid-glass";
import { Term } from "@/components/ui/term";
import { RESULTS, type Result } from "./story-data";
import { useOnScreen } from "./use-on-screen";

const MotionGlass = motion.create(LiquidGlass);

/** What each number means, in a few plain words; the explained words sit here, not on the numbers. */
const CAPTIONS: Record<string, React.ReactNode> = {
  barnard: <>a year, ± 0.12″: the fastest march across the sky of any star</>,
  "wise-0855": (
    <>
      <Term k="sigma">signal-to-noise</Term> of its 7.98 ± 0.77″ shift in a year. One of the coldest known brown dwarfs.
    </>
  ),
  "rw-aur": (
    <>
      <Term k="magnitude">magnitudes</Term> fainter after one year, ± 0.04, for this young star
    </>
  ),
};

export function ResultCards({ animate }: { animate: boolean }) {
  return (
    <ul className="grid gap-4 md:grid-cols-3 md:gap-5">
      {RESULTS.map((r, i) => (
        <ResultCard key={r.key} result={r} index={i} animate={animate} />
      ))}
    </ul>
  );
}

function ResultCard({ result: r, index, animate }: { result: Result; index: number; animate: boolean }) {
  // The card's element as state: a glass card's element arrives after its first commit (see use-on-screen).
  const [node, setNode] = React.useState<HTMLElement | null>(null);
  const inView = useOnScreen(node, { amount: 0.55, failOpen: animate });
  const near = useOnScreen(node, { amount: 0.2, failOpen: animate });
  const value = !animate || inView ? r.value : 0;
  const shown = !animate || near;
  return (
    <MotionGlass
      as="li"
      ref={setNode}
      variant="regular"
      radius={24}
      className="flex min-h-[15.5rem] flex-col p-6"
      initial={false}
      animate={shown ? { opacity: 1, y: 0 } : { opacity: 0, y: 36 }}
      transition={{ duration: shown ? 0.7 : 0.3, delay: shown ? index * 0.09 : 0, ease: [0.16, 1, 0.3, 1] }}
    >
      <h3 className="text-ui font-medium text-fg">{r.name}</h3>
      <p className="mt-4 text-[3.25rem] leading-none font-medium tracking-[-0.03em] text-fg tabular-nums">
        <span className="sr-only">{r.spoken}</span>
        <NumberFlow
          aria-hidden
          value={value}
          animated={animate}
          locales="en-US"
          format={{ minimumFractionDigits: r.digits, maximumFractionDigits: r.digits }}
          suffix={r.suffix}
        />
      </p>
      <p className="mt-3 text-meta text-pretty text-(--fg-glass-dim)">{CAPTIONS[r.key]}</p>
      <p className="mt-auto pt-5 text-micro text-pretty text-(--fg-glass-dim)">{r.source}</p>
    </MotionGlass>
  );
}
