"use client";
// Lenis smooth scrolling on content pages only. Never on /explore (the sky viewer owns the wheel
// and touch gestures there; its host also carries data-lenis-prevent), and never when motion is
// reduced (the Motion setting, or the system setting when that is "system").

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import Lenis from "lenis";
import { useEffectiveReducedMotion } from "@/lib/preferences";

const NO_SMOOTH_SCROLL = ["/explore"];

export function SmoothScroll() {
  const pathname = usePathname() ?? "/";
  const enabled = !NO_SMOOTH_SCROLL.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  const reduce = useEffectiveReducedMotion();
  const lastPath = useRef<string | null>(null);

  useEffect(() => {
    // A new page starts at the top; a settings change on the same page keeps its place.
    const newPage = lastPath.current !== pathname;
    lastPath.current = pathname;
    if (!enabled || reduce) return;
    const lenis = new Lenis({ autoRaf: true, duration: 1.05, anchors: true });
    if (newPage) {
      // ...unless the address names a section (/about#cite): then start there.
      const id = decodeURIComponent(window.location.hash.slice(1));
      const section = id ? document.getElementById(id) : null;
      lenis.scrollTo(section ?? 0, { immediate: true });
    }
    return () => lenis.destroy();
  }, [enabled, pathname, reduce]);

  return null;
}
