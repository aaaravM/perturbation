"use client";
// Live previews on the Settings page, both on real SPHEREx data.
// GlassPreview: the top bar's glass and a clear lens over the SPHEREx all-sky map near the centre
//   of the Milky Way. It follows the Glass setting as you change it; the lens follows the pointer
//   (or a tap) so the bending at its rim is easy to see.
// BlinkPreview: Barnard's Star in the prepared Lab field (SPHEREx D6), Aug 2025 against Aug 2026,
//   blinking at the chosen speed. The centre of the 99-pixel frame is enlarged 4 times, so the
//   star's 10-arcsecond step in that year shows as a visible jump.

import * as React from "react";
import Image from "next/image";
import { motion, useSpring } from "motion/react";
import { PauseIcon, PlayIcon } from "lucide-react";
import { LiquidGlass } from "@/components/ui/liquid-glass";
import { useEffectiveReducedMotion } from "@/lib/preferences";

// --------------------------------------------------------------------------------- glass

const SKY_TEXTURE = "/textures/spherex-sky-rgb-2k.webp";
const LENS = 104;
const LENS_REST = { right: 36, top: 84 };
const LENS_SPRING = { stiffness: 260, damping: 26, mass: 0.6 };

export function GlassPreview() {
  const reduce = useEffectiveReducedMotion();
  const box = React.useRef<HTMLDivElement>(null);
  const x = useSpring(0, LENS_SPRING);
  const y = useSpring(0, LENS_SPRING);

  const moveTo = (clientX: number, clientY: number) => {
    const el = box.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const restLeft = r.width - LENS_REST.right - LENS;
    const px = Math.min(Math.max(clientX - r.left - LENS / 2, 8), r.width - LENS - 8);
    const py = Math.min(Math.max(clientY - r.top - LENS / 2, 8), r.height - LENS - 8);
    const dx = px - restLeft;
    const dy = py - LENS_REST.top;
    if (reduce) {
      x.jump(dx);
      y.jump(dy);
    } else {
      x.set(dx);
      y.set(dy);
    }
  };

  return (
    <figure className="flex flex-col gap-2.5">
      <div
        ref={box}
        aria-hidden
        data-testid="glass-preview"
        className="relative h-56 touch-pan-y overflow-hidden rounded-[22px] border border-hair bg-ink-2 select-none sm:h-60"
        onPointerMove={(e) => {
          if (e.pointerType !== "touch") moveTo(e.clientX, e.clientY);
        }}
        onPointerDown={(e) => moveTo(e.clientX, e.clientY)}
        onPointerLeave={(e) => {
          if (e.pointerType === "touch") return;
          if (reduce) {
            x.jump(0);
            y.jump(0);
          } else {
            x.set(0);
            y.set(0);
          }
        }}
      >
        {/* The sky drifts slowly (transform only) so the glass has something to bend. */}
        <motion.div
          className="absolute -inset-[10%]"
          style={{
            backgroundImage: `url(${SKY_TEXTURE})`,
            backgroundSize: "300% auto",
            backgroundPosition: "84% 70%",
          }}
          animate={reduce ? { x: "0%", y: "0%" } : { x: ["0%", "-5%"], y: ["0%", "-3%"] }}
          transition={reduce ? { duration: 0 } : { duration: 40, repeat: Infinity, repeatType: "mirror", ease: "easeInOut" }}
        />
        <LiquidGlass interactive className="absolute inset-x-3 top-3 flex h-12 items-center justify-between gap-4 px-4">
          <span className="truncate text-ui font-medium text-fg">Planet X Hunter</span>
          <span className="flex shrink-0 items-center gap-4 text-ui text-(--fg-glass-dim)">
            <span className="text-fg">Sky</span>
            <span>Lab</span>
            <span className="hidden sm:inline">Discoveries</span>
          </span>
        </LiquidGlass>
        <motion.div
          className="absolute"
          style={{ x, y, right: LENS_REST.right, top: LENS_REST.top, width: LENS, height: LENS }}
        >
          <LiquidGlass variant="clear" radius={28} className="size-full" />
        </motion.div>
      </div>
      <figcaption className="text-micro text-pretty text-fg-faint">
        The SPHEREx all-sky map near the centre of the Milky Way (SPHEREx DR1, Caltech/IPAC/NASA; IRSA). Point or tap
        to move the lens.
      </figcaption>
    </figure>
  );
}

// --------------------------------------------------------------------------------- blink

const BLINK_FRAMES = [
  { src: "/bundles/barnards-star/frames/D6_E0.png", label: "Aug 2025" },
  { src: "/bundles/barnards-star/frames/D6_E4.png", label: "Aug 2026" },
] as const;

export function BlinkPreview({ ms }: { ms: number }) {
  const reduce = useEffectiveReducedMotion();
  // Plays by itself unless motion is reduced; the button overrides either way.
  const [choice, setChoice] = React.useState<boolean | null>(null);
  const playing = choice ?? !reduce;
  const [second, setSecond] = React.useState(false);

  React.useEffect(() => {
    if (!playing) return;
    const id = window.setInterval(() => setSecond((s) => !s), ms);
    return () => window.clearInterval(id);
  }, [playing, ms]);

  const frame = BLINK_FRAMES[second ? 1 : 0];
  return (
    <div className="flex items-center gap-4" data-testid="blink-preview">
      <div className="relative size-24 shrink-0 overflow-hidden rounded-[12px] border border-hair bg-black">
        {BLINK_FRAMES.map((f, i) => (
          <Image
            key={f.src}
            src={f.src}
            alt=""
            width={99}
            height={99}
            unoptimized
            className="absolute inset-0 size-full scale-[4] [image-rendering:pixelated]"
            style={{ opacity: (i === 1) === second ? 1 : 0 }}
          />
        ))}
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <p className="text-meta text-fg-dim">
          Barnard&rsquo;s Star in SPHEREx, <span className="readout text-fg">{frame.label}</span>
        </p>
        <p className="text-micro text-pretty text-fg-faint">
          The middle of the Lab&rsquo;s prepared field, enlarged. It moves about 10 arcseconds in the year.
        </p>
        <button
          type="button"
          onClick={() => setChoice(!playing)}
          aria-pressed={playing}
          className="-ml-2 inline-flex h-9 w-fit items-center gap-1.5 rounded-[8px] px-2 text-meta text-fg-dim transition-colors hover:bg-white/[0.05] hover:text-fg"
        >
          {playing ? <PauseIcon aria-hidden className="size-3.5" /> : <PlayIcon aria-hidden className="size-3.5" />}
          {playing ? "Pause preview" : "Play preview"}
        </button>
      </div>
    </div>
  );
}
