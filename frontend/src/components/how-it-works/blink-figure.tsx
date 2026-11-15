"use client";
// Step 3: Barnard's Star blinking between two real SPHEREx visits, next to their difference
// image. Both are the centre of the prepared bundle's frames, enlarged with square pixels. The
// blink is an instant cut, as on a blink comparator; it pauses off screen and does not start by
// itself when motion is reduced.

import * as React from "react";
import { ArrowUpIcon, PauseIcon, PlayIcon } from "lucide-react";
import type { BlinkData } from "@/lib/how-it-works";
import { useEffectiveReducedMotion } from "@/lib/preferences";
import { LiquidGlass } from "@/components/ui/liquid-glass";
import { cn } from "@/lib/utils";
import { RISE, delay } from "./motion-classes";
import { Reveal } from "./reveal";

const BLINK_MS = 900;
const SCALE_ARCSEC = 30;

export function BlinkFigure({ data }: { data: BlinkData }) {
  const reduce = useEffectiveReducedMotion();
  const [userPlaying, setUserPlaying] = React.useState<boolean | null>(null);
  const [after, setAfter] = React.useState(false);
  const [onScreen, setOnScreen] = React.useState(false);
  const box = React.useRef<HTMLDivElement>(null);
  const playing = userPlaying ?? !reduce;

  React.useEffect(() => {
    const el = box.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setOnScreen(e.isIntersecting), { threshold: 0.2 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  React.useEffect(() => {
    if (!playing || !onScreen) return;
    const id = window.setInterval(() => setAfter((v) => !v), BLINK_MS);
    return () => window.clearInterval(id);
  }, [playing, onScreen]);

  const crop = Math.round(data.gridPx / 3);
  const cropArcmin = ((crop * data.pixelArcsec) / 60).toFixed(1);
  const scaleBar = `${((SCALE_ARCSEC / data.pixelArcsec / crop) * 100).toFixed(2)}%`;
  const shown = after ? data.after : data.before;

  const pick = (toAfter: boolean) => {
    setUserPlaying(false);
    setAfter(toAfter);
  };

  return (
    <Reveal as="figure" className="max-w-[40rem]">
      <div ref={box} className="grid grid-cols-2 gap-3 sm:gap-4">
        <Panel
          className={RISE}
          label={shown.label}
          scaleBar={scaleBar}
          ariaLabel={`Barnard's Star in ${shown.label}`}
        >
          <Frame src={data.before.url} />
          <Frame src={data.after.url} hidden={!after} />
        </Panel>
        <Panel
          className={RISE}
          style={delay(1, 120)}
          label="Difference"
          scaleBar={scaleBar}
          ariaLabel={`Difference image: ${data.after.label} minus ${data.before.label}. A dark spot where the star was and a bright spot where it is now.`}
        >
          <Frame src={data.difference.url} />
        </Panel>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setUserPlaying(!playing)}
          aria-pressed={playing}
          className="inline-flex h-9 items-center gap-2 rounded-[10px] border border-hair-strong px-3 text-ui text-fg transition-colors hover:bg-ink-3"
        >
          {playing ? <PauseIcon aria-hidden className="size-4" /> : <PlayIcon aria-hidden className="size-4" />}
          {playing ? "Pause" : "Blink"}
        </button>
        <div role="group" aria-label="Show one visit" className="inline-flex h-9 rounded-[10px] border border-hair p-0.5">
          {[
            { v: false, label: data.before.label },
            { v: true, label: data.after.label },
          ].map((o) => (
            <button
              key={o.label}
              type="button"
              aria-pressed={!playing && after === o.v}
              onClick={() => pick(o.v)}
              className={cn(
                "rounded-[8px] px-3 text-ui transition-colors",
                !playing && after === o.v ? "bg-ink-3 text-fg" : "text-fg-dim hover:text-fg",
              )}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>

      <ul className="mt-4 grid gap-1.5 text-meta text-fg-dim sm:grid-cols-3 sm:gap-4">
        <Swatch tone="bg-black">Dark: where it was in {data.before.label}</Swatch>
        <Swatch tone="bg-white">Bright: where it is in {data.after.label}</Swatch>
        <Swatch tone="bg-[#808080]">Grey: nothing changed</Swatch>
      </ul>

      <figcaption className="mt-4 flex max-w-2xl flex-col gap-1 text-meta text-pretty text-fg-dim">
        <span>
          Barnard’s Star at {data.band[0].toFixed(1)}–{data.band[1].toFixed(1)} µm (detector D6).{" "}
          {data.before.n === data.after.n
            ? `Each visit is a stack of ${data.before.n} exposures`
            : `The visits are stacks of ${data.before.n} and ${data.after.n} exposures`}
          ; shown is the central {cropArcmin} arcminutes of the field, north up.
        </span>
        <span className="text-fg-faint">Source: the prepared Barnard’s Star bundle, SPHEREx DR1 and QR3.</span>
      </figcaption>
    </Reveal>
  );
}

function Panel({
  children,
  label,
  scaleBar,
  ariaLabel,
  className,
  style,
}: {
  children: React.ReactNode;
  label: string;
  scaleBar: string;
  ariaLabel: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <div className={cn("flex flex-col", className)} style={style}>
      <div role="img" aria-label={ariaLabel} className="relative aspect-square overflow-hidden rounded-[16px] border border-hair bg-black">
        {children}
        <LiquidGlass variant="thin" radius={10} className="absolute top-2 left-2 px-2.5 py-1 text-meta text-fg">
          {label}
        </LiquidGlass>
        <span className="absolute top-2.5 right-2.5 flex flex-col items-center text-micro text-fg/80" aria-hidden>
          <ArrowUpIcon className="size-3.5" />N
        </span>
        <span className="absolute bottom-2.5 left-2.5 flex flex-col gap-1 text-micro text-fg/80" aria-hidden style={{ width: scaleBar }}>
          <span className="readout whitespace-nowrap">{SCALE_ARCSEC}″</span>
          <span className="h-0.5 w-full rounded-full bg-fg/80" />
        </span>
      </div>
    </div>
  );
}

function Frame({ src, hidden }: { src: string; hidden?: boolean }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      draggable={false}
      className={cn(
        "absolute top-[-100%] left-[-100%] w-[300%] max-w-none select-none [image-rendering:pixelated]",
        hidden && "opacity-0",
      )}
    />
  );
}

function Swatch({ tone, children }: { tone: string; children: React.ReactNode }) {
  return (
    <li className="flex items-center gap-2">
      <span aria-hidden className={cn("size-3 shrink-0 rounded-[3px] border border-hair-strong", tone)} />
      {children}
    </li>
  );
}
