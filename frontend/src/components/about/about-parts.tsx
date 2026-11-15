"use client";
// About page pieces that need the browser: the SPHEREx all-sky map behind the title, which drifts
// a little as the page scrolls (transform only, still when motion is reduced), and the citation
// with a copy button.

import * as React from "react";
import { motion, useScroll, useTransform } from "motion/react";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useEffectiveReducedMotion } from "@/lib/preferences";

/** The map is plate carrée with RA increasing to the right; at 88% 62% a narrow screen shows the Milky Way from the galactic centre up to Cygnus. */
export function SkyBackdrop({ src }: { src: string }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const reduce = useEffectiveReducedMotion();
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start start", "end start"] });
  const y = useTransform(scrollYProgress, [0, 1], ["0%", "18%"]);
  const scale = useTransform(scrollYProgress, [0, 1], [1.06, 1.14]);
  return (
    <div ref={ref} aria-hidden className="absolute inset-0 overflow-hidden">
      <motion.img
        src={src}
        alt=""
        decoding="async"
        fetchPriority="high"
        draggable={false}
        className="absolute inset-0 size-full object-cover object-[88%_62%] opacity-90 select-none"
        style={reduce ? { scale: 1.06 } : { y, scale }}
      />
      <div className="absolute inset-0 bg-[linear-gradient(to_bottom,rgb(5_5_5/0.35),rgb(5_5_5/0.15)_40%,var(--ink))]" />
    </div>
  );
}

export function CopyCitation({ text }: { text: string }) {
  const [copied, setCopied] = React.useState(false);
  React.useEffect(() => {
    if (!copied) return;
    const id = window.setTimeout(() => setCopied(false), 1800);
    return () => window.clearTimeout(id);
  }, [copied]);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard?.writeText(text).then(
          () => setCopied(true),
          () => setCopied(false),
        );
      }}
      className="inline-flex h-9 items-center gap-2 self-start rounded-[10px] border border-hair-strong px-3 text-ui text-fg transition-colors hover:bg-ink-3"
    >
      {copied ? <CheckIcon aria-hidden className="size-4 text-accent" /> : <CopyIcon aria-hidden className="size-4" />}
      <span aria-live="polite">{copied ? "Copied" : "Copy citation"}</span>
    </button>
  );
}
