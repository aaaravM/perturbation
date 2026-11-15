"use client";
// Soft page-enter transition. A template re-mounts on every navigation, so each page fades in.
// Opacity only: a transform here would sit above the sky viewer's canvas while it measures.

import { motion } from "motion/react";
import { useEffectiveReducedMotion } from "@/lib/preferences";

export default function Template({ children }: { children: React.ReactNode }) {
  const reduceMotion = useEffectiveReducedMotion();
  return (
    <motion.div
      className="flex flex-1 flex-col"
      initial={reduceMotion ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
    >
      {children}
    </motion.div>
  );
}
