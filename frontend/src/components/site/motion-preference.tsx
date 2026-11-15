"use client";
// Root MotionConfig that follows the Motion setting: "reduce" turns off transform and layout
// animation in every motion/react component, "full" keeps it on even when the system asks for
// less, and "system" (the default) leaves the choice to prefers-reduced-motion as before.
// Components that branch on motion themselves should use useEffectiveReducedMotion() from
// lib/preferences, which reads the same setting.

import { MotionConfig } from "motion/react";
import { usePreference } from "@/lib/preferences";

export function MotionPreference({ children }: { children: React.ReactNode }) {
  const motion = usePreference("motion");
  return (
    <MotionConfig reducedMotion={motion === "reduce" ? "always" : motion === "full" ? "never" : "user"}>
      {children}
    </MotionConfig>
  );
}
