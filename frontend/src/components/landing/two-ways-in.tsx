"use client";
// The end of the home page story: the two ways into the tool, on glass over the SPHEREx sky.
// Sky: the globe of 117,955 stars. Lab: the frames themselves, here Barnard's Star blinking
// between August 2025 and August 2026 (real D6 frames, enlarged).

import * as React from "react";
import Link from "next/link";
import { ArrowRightIcon } from "lucide-react";
import { motion, useInView } from "motion/react";
import { LiquidGlass } from "@/components/ui/liquid-glass";
import { cn } from "@/lib/utils";
import { GLOBE_STILL, SKY_STAR_COUNT, SKY_TEXTURE, VISITS } from "./story-data";

const MotionGlass = motion.create(LiquidGlass);

export const TWO_WAYS_ID = "two-ways-in";

export function TwoWaysIn({ animate }: { animate: boolean }) {
  return (
    <section id={TWO_WAYS_ID} aria-labelledby="two-ways-title" className="relative isolate scroll-mt-4 overflow-hidden py-24 sm:py-32">
      {/* The SPHEREx map behind the glass: something real for it to bend. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={SKY_TEXTURE.small}
        alt=""
        aria-hidden
        loading="lazy"
        decoding="async"
        className="absolute inset-0 -z-10 size-full object-cover object-[74%_62%] opacity-60 [mask-image:linear-gradient(to_bottom,transparent,black_22%,black_70%,transparent)]"
      />
      <div className="mx-auto w-full max-w-6xl px-4 sm:px-6">
        <h2 id="two-ways-title" className="text-title text-balance text-fg">
          Two ways in.
        </h2>
        <p className="measure mt-4 text-lead text-pretty text-fg-dim">The same SPHEREx data, for a quick look or a close one.</p>

        <div className="mt-10 grid gap-5 md:grid-cols-2">
          <WayCard
            animate={animate}
            index={0}
            title="Sky"
            href="/sky"
            cta="Open the sky globe"
            text={`Spin the globe, click any of ${SKY_STAR_COUNT.toLocaleString("en-US")} stars, and fly out through 3D space to see how far away they are.`}
            preview={<SkyPreview />}
          />
          <WayCard
            animate={animate}
            index={1}
            title="Lab"
            href="/explore?target=barnards-star"
            cta="Open the Lab"
            text="Blink the frames, measure how things move and change, and export what you find. Five targets are ready to open."
            preview={<LabPreview animate={animate} />}
          />
        </div>

        <p className="mt-10 text-body text-fg-dim">
          Or read about{" "}
          <Link href="/discoveries" className="text-fg underline decoration-hair-strong underline-offset-4 transition-colors hover:decoration-fg">
            what the search has found
          </Link>{" "}
          and{" "}
          <Link href="/how-it-works" className="text-fg underline decoration-hair-strong underline-offset-4 transition-colors hover:decoration-fg">
            how it works
          </Link>
          .
        </p>
      </div>
    </section>
  );
}

function WayCard({
  animate,
  index,
  title,
  text,
  href,
  cta,
  preview,
}: {
  animate: boolean;
  index: number;
  title: string;
  text: string;
  href: string;
  cta: string;
  preview: React.ReactNode;
}) {
  const ref = React.useRef<HTMLElement>(null);
  const seen = useInView(ref, { amount: 0.25, once: true });
  const shown = !animate || seen;
  return (
    <MotionGlass
      ref={ref}
      as="article"
      variant="regular"
      radius={28}
      interactive
      className="group relative flex flex-col p-3"
      initial={false}
      animate={shown ? { opacity: 1, y: 0 } : { opacity: 0, y: 40 }}
      transition={{ duration: shown ? 0.8 : 0, delay: shown ? index * 0.1 : 0, ease: [0.16, 1, 0.3, 1] }}
    >
      <div className="relative aspect-[16/10] overflow-hidden rounded-2xl bg-ink">{preview}</div>
      <div className="flex flex-1 flex-col px-3 pt-5 pb-3">
        <h3 className="text-heading text-fg">{title}</h3>
        <p className="mt-2 text-body text-pretty text-(--fg-glass-dim)">{text}</p>
        <Link
          href={href}
          className="mt-6 inline-flex items-center gap-2 self-start rounded-sm text-ui font-medium text-fg after:absolute after:inset-0 after:rounded-[28px] focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-accent"
        >
          {cta}
          <ArrowRightIcon aria-hidden className="size-4 transition-transform duration-300 group-hover:translate-x-0.5" />
        </Link>
      </div>
    </MotionGlass>
  );
}

function SkyPreview() {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={GLOBE_STILL}
      alt="The SPHEREx all-sky map on a globe, the Milky Way running across it"
      loading="lazy"
      decoding="async"
      className="absolute top-[7%] left-1/2 w-[104%] max-w-none -translate-x-1/2 transition-transform duration-700 ease-out group-hover:scale-[1.03]"
    />
  );
}

/** The frame is 99 pixels; about 46 of them fill the preview's width. */
const ZOOM = 99 / 46;
const CENTRE = { x: 49.45, y: 49.5 };

function LabPreview({ animate }: { animate: boolean }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { amount: 0.4 });
  const [later, setLater] = React.useState(true);
  React.useEffect(() => {
    if (!animate || !inView) return;
    const id = window.setInterval(() => setLater((v) => !v), 700);
    return () => window.clearInterval(id);
  }, [animate, inView]);
  const shown = animate ? (later ? VISITS[2] : VISITS[0]) : VISITS[2];
  // Positions as fractions of the preview (16:10).
  const at = (x: number, y: number) => ({
    left: `${50 + ((x - CENTRE.x) / 99) * ZOOM * 100}%`,
    top: `${50 + ((y - CENTRE.y) / 99) * ZOOM * 160}%`,
  });
  return (
    <div ref={ref} className="absolute inset-0" role="img" aria-label="Barnard's Star in SPHEREx images from August 2025 and August 2026, enlarged: it jumps north between them.">
      {[VISITS[0], VISITS[2]].map((v) => (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={v.label}
          src={v.src}
          alt=""
          loading="lazy"
          decoding="async"
          className={cn("absolute max-w-none [image-rendering:pixelated]", shown === v ? "opacity-100" : "opacity-0")}
          style={{ width: `${ZOOM * 100}%`, ...at(0, 0) }}
        />
      ))}
      <span
        className="absolute aspect-square w-[11%] -translate-1/2 rounded-full border border-dashed border-white/55"
        style={at(VISITS[0].x, VISITS[0].y)}
      />
      <span className="readout absolute right-3 bottom-2.5 text-micro text-fg">{shown.label}</span>
    </div>
  );
}
