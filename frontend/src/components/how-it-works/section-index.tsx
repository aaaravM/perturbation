"use client";
// The page's table of contents. On wide screens it stays beside the text: the step you are
// reading is marked, and a hairline fills as you scroll (scroll-linked, so it follows your own
// scrolling and is not an animation). On phones it is a plain list of links under the title.

import * as React from "react";
import { motion, useScroll, useSpring } from "motion/react";
import { useEffectiveReducedMotion } from "@/lib/preferences";
import { cn } from "@/lib/utils";

export interface IndexItem {
  id: string;
  label: string;
}

/** The steps column beside the page's sections; `children` are the sections themselves. */
export function IndexedArticle({ items, children }: { items: readonly IndexItem[]; children: React.ReactNode }) {
  const [active, setActive] = React.useState(items[0]?.id ?? "");
  const article = React.useRef<HTMLDivElement>(null);
  const reduce = useEffectiveReducedMotion();

  React.useEffect(() => {
    const els = items.map((s) => document.getElementById(s.id)).filter((e): e is HTMLElement => !!e);
    const tops = new Map<string, number>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) tops.set(e.target.id, e.isIntersecting ? e.boundingClientRect.top : Infinity);
        const shown = items.map((s) => s.id).filter((id) => (tops.get(id) ?? Infinity) !== Infinity);
        if (shown.length) setActive(shown[0]);
      },
      { rootMargin: "-96px 0px -55% 0px" },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [items]);

  const { scrollYProgress } = useScroll({ target: article, offset: ["start 0.4", "end 0.6"] });
  const smooth = useSpring(scrollYProgress, { stiffness: 220, damping: 40, mass: 0.4 });

  return (
    <div className="lg:grid lg:grid-cols-[12rem_minmax(0,1fr)] lg:gap-14 xl:gap-20">
      <nav aria-label="Steps on this page" className="hidden lg:block">
        <div className="sticky top-28">
          <p className="mb-3 pl-4 text-meta text-fg-faint">On this page</p>
          <div className="relative">
            <span aria-hidden className="absolute top-1 bottom-1 left-0 w-px bg-hair-strong" />
            <motion.span
              aria-hidden
              className="absolute top-1 bottom-1 left-0 w-px origin-top bg-accent"
              style={{ scaleY: reduce ? scrollYProgress : smooth }}
            />
            <ol className="flex flex-col">
              {items.map((s, i) => (
                <li key={s.id}>
                  <a
                    href={`#${s.id}`}
                    aria-current={active === s.id ? "true" : undefined}
                    className={cn(
                      "flex min-h-9 items-baseline gap-3 py-1.5 pl-4 text-meta transition-colors duration-200",
                      active === s.id ? "text-fg" : "text-fg-dim hover:text-fg",
                    )}
                  >
                    <span className="readout w-3 shrink-0 text-fg-faint">{i + 1}</span>
                    {s.label}
                  </a>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </nav>
      <div ref={article} className="flex min-w-0 flex-col gap-16">
        {children}
      </div>
    </div>
  );
}

/** The same list for phones and tablets, in the page header. */
export function InlineIndex({ items }: { items: readonly IndexItem[] }) {
  return (
    <nav aria-label="Steps on this page" className="mt-8 lg:hidden">
      <ol className="grid grid-cols-1 gap-x-6 border-t border-hair sm:grid-cols-2">
        {items.map((s, i) => (
          <li key={s.id} className="border-b border-hair">
            <a href={`#${s.id}`} className="flex min-h-11 items-center gap-3 text-ui text-fg-dim transition-colors hover:text-fg">
              <span className="readout w-3 shrink-0 text-fg-faint">{i + 1}</span>
              {s.label}
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}
