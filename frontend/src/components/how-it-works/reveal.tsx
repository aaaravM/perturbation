"use client";
// A container that animates its figure in once, when it first scrolls into view (see
// motion-classes.ts), and a hook that measures a figure's width so SVG text stays at its real size.

import * as React from "react";
import { useEffectiveReducedMotion } from "@/lib/preferences";
import { cn } from "@/lib/utils";

type RevealState = "idle" | "hidden" | "shown";

export function Reveal({
  as: Tag = "div",
  className,
  children,
  ...rest
}: React.HTMLAttributes<HTMLElement> & { as?: "div" | "figure" | "section" | "ol" | "ul" }) {
  const ref = React.useRef<HTMLElement>(null);
  const reduce = useEffectiveReducedMotion();
  const [state, setState] = React.useState<RevealState>("idle");

  React.useEffect(() => {
    const el = ref.current;
    if (!el || reduce || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setState("shown");
          io.disconnect();
        } else {
          // Below the fold at first: hide it now, show it when it arrives.
          setState((s) => (s === "idle" ? "hidden" : s));
        }
      },
      { rootMargin: "0px 0px -12% 0px", threshold: 0.15 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [reduce]);

  const Comp = Tag as React.ElementType;
  return (
    <Comp ref={ref} data-reveal={reduce ? "idle" : state} className={cn("group/reveal", className)} {...rest}>
      {children}
    </Comp>
  );
}

/** Width of an element in CSS pixels, kept up to date. `fallback` until it is measured. */
export function useWidth<T extends HTMLElement>(fallback: number) {
  const ref = React.useRef<T>(null);
  const [width, setWidth] = React.useState(fallback);
  React.useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => {
      const w = Math.round(entry.contentRect.width);
      if (w > 0) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}
