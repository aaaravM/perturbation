"use client";
// Shown whenever the loaded manifest has source "fixture". Hatched edge = "not real", the same
// visual language as the unavailable frames in the wavelength slider.

import { motion, useReducedMotion } from "motion/react";

export function FixtureBanner({ standIn }: { standIn: string | null }) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      role="note"
      data-testid="fixture-banner"
      initial={reduce ? false : { opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
      className="panel pointer-events-auto flex max-w-[min(34rem,calc(100vw-1.5rem))] items-stretch overflow-hidden"
    >
      <span
        aria-hidden
        className="w-2 shrink-0 bg-[repeating-linear-gradient(135deg,var(--fg-dim)_0_1.5px,transparent_1.5px_5px)] opacity-70"
      />
      <div className="flex flex-col gap-0.5 px-3 py-2">
        <p className="text-ui font-medium text-fg">Development fixture: not real data</p>
        <p className="hidden text-micro text-fg-dim sm:block">
          Synthetic frames and numbers for building the Lab
          {standIn ? `, placed where ${standIn} is until its SPHEREx bundle is ready` : ""}. Never shown in the
          public build.
        </p>
      </div>
    </motion.div>
  );
}
