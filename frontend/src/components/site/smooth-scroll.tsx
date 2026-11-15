"use client";
// Lenis smooth scrolling on content pages only. Never on /explore (the sky viewer owns the wheel
// and touch gestures there; its host also carries data-lenis-prevent), and never when the user
// prefers reduced motion.

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import Lenis from "lenis";

const NO_SMOOTH_SCROLL = ["/explore"];

export function SmoothScroll() {
  const pathname = usePathname() ?? "/";
  const enabled = !NO_SMOOTH_SCROLL.some((p) => pathname === p || pathname.startsWith(`${p}/`));

  useEffect(() => {
    if (!enabled) return;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (media.matches) return;

    const lenis = new Lenis({ autoRaf: true, duration: 1.05, anchors: true });
    lenis.scrollTo(0, { immediate: true });
    return () => lenis.destroy();
  }, [enabled, pathname]);

  return null;
}
