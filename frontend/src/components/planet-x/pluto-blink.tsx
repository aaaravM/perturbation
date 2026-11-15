"use client";
// Pluto blinking in real SPHEREx images, two ways: with the stars held still (Pluto walks past
// them) and following Pluto (the stars stream past it). The blink is an instant cut, as on
// Tombaugh's blink comparator, and pauses off screen. With reduced motion the frames start side by
// side instead, and the blink plays only when asked. An orange ring marks where JPL Horizons
// predicts Pluto in each frame; it can be switched off to see the bare images.

import * as React from "react";
import { ArrowUpIcon, PauseIcon, PlayIcon } from "lucide-react";
import type { BlinkFrame, BlinkSet } from "@/lib/planet-x";
import { useEffectiveReducedMotion } from "@/lib/preferences";
import { LiquidGlass } from "@/components/ui/liquid-glass";
import { RISE, delay } from "@/components/how-it-works/motion-classes";
import { Reveal } from "@/components/how-it-works/reveal";
import { cn } from "@/lib/utils";

const BLINK_MS = 800;
const SCALE_ARCSEC = 60;
/** Ring diameter in image pixels (6.15″ each): wide enough to leave Pluto's own dot clear. */
const RING_PX = 5;

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** "2026-04-25 05:43" to "25 Apr, 05:43". */
const shortStamp = (utc: string) => {
  const [d, t] = utc.split(" ");
  const [, m, day] = d.split("-").map(Number);
  return `${day} ${MONTHS[m - 1].slice(0, 3)}, ${t}`;
};
/** "2026-04-25 05:43" to "25 April 2026". */
const longDate = (utc: string) => {
  const [y, m, day] = utc.split(" ")[0].split("-").map(Number);
  return `${day} ${MONTHS[m - 1]} ${y}`;
};

type View = "blink" | "strip";

export function PlutoBlink({ skyFixed, tracked }: { skyFixed: BlinkSet; tracked: BlinkSet }) {
  const reduce = useEffectiveReducedMotion();
  const [userView, setUserView] = React.useState<View | null>(null);
  const [paused, setPaused] = React.useState(false);
  const [ring, setRing] = React.useState(true);
  const [tick, setTick] = React.useState(0);
  const [onScreen, setOnScreen] = React.useState(false);
  const box = React.useRef<HTMLDivElement>(null);
  const view: View = userView ?? (reduce ? "strip" : "blink");
  const playing = view === "blink" && !paused;

  React.useEffect(() => {
    const el = box.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setOnScreen(e.isIntersecting), { threshold: 0.2 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  React.useEffect(() => {
    if (!playing || !onScreen) return;
    const id = window.setInterval(() => setTick((t) => t + 1), BLINK_MS);
    return () => window.clearInterval(id);
  }, [playing, onScreen]);

  const pickView = (v: View) => {
    setUserView(v);
    if (v === "blink") setPaused(false);
  };

  const sets = [
    {
      key: "sky-fixed",
      set: skyFixed,
      title: "Stars held still",
      note: `Pluto moves ${Math.round(skyFixed.movedArcsec)}″ in ${skyFixed.spanDays.toFixed(1)} days`,
      label: `${skyFixed.frames.length} SPHEREx images from ${longDate(skyFixed.frames[0].date)} to ${longDate(skyFixed.frames.at(-1)!.date)}, with the stars held still: Pluto moves ${Math.round(skyFixed.movedArcsec)} arcseconds towards the lower left, east and south.`,
    },
    {
      key: "tracked",
      set: tracked,
      title: "Following Pluto",
      note: `The stars stream ${Math.round(tracked.movedArcsec)}″ past in ${tracked.spanDays.toFixed(1)} days`,
      label: `${tracked.frames.length} SPHEREx images from ${longDate(tracked.frames[0].date)} to ${longDate(tracked.frames.at(-1)!.date)}, centred on Pluto: Pluto stays in the middle while the stars stream ${Math.round(tracked.movedArcsec)} arcseconds past it.`,
    },
  ];

  return (
    <Reveal as="figure" className="max-w-[44rem]" data-testid="pluto-blink" data-view={view} data-playing={playing}>
      <div ref={box}>
        {view === "blink" ? (
          <div className="grid grid-cols-2 gap-3 sm:gap-4">
            {sets.map((s, i) => {
              const frame = s.set.frames[tick % s.set.frames.length];
              return (
                <div key={s.key} className={cn("flex flex-col", RISE)} style={delay(i, 120)} data-testid={`blink-${s.key}`}>
                  <Sky set={s.set} ariaLabel={s.label} className="rounded-[16px]">
                    {s.set.frames.map((f) => (
                      <Frame key={f.url} src={f.url} hidden={f !== frame} />
                    ))}
                    {ring && <Ring frame={frame} grid={s.set.gridPx} />}
                    <LiquidGlass variant="thin" radius={10} className="absolute top-2 left-2 px-2.5 py-1 text-meta whitespace-nowrap text-fg">
                      {shortStamp(frame.date)}
                    </LiquidGlass>
                    <Compass />
                    <ScaleBar set={s.set} />
                  </Sky>
                  <p className="mt-3 text-ui text-fg">{s.title}</p>
                  <p className="text-meta text-pretty text-fg-dim">{s.note}</p>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="flex flex-col gap-6">
            {sets.map((s) => (
              <div key={s.key} data-testid={`strip-${s.key}`}>
                <p className="text-ui text-fg">
                  {s.title} <span className="text-fg-dim">· {s.note}</span>
                </p>
                <ol aria-label={s.label} className="mt-2 grid grid-cols-3 gap-2 sm:gap-3">
                  {s.set.frames.map((f) => (
                    <li key={f.url} className="flex flex-col">
                      <Sky set={s.set} ariaLabel={`${s.title}: ${shortStamp(f.date)} UTC`} className="rounded-[12px]">
                        <Frame src={f.url} />
                        {ring && <Ring frame={f} grid={s.set.gridPx} />}
                      </Sky>
                      <span className="readout mt-1.5 text-micro text-fg-dim">{shortStamp(f.date)}</span>
                    </li>
                  ))}
                </ol>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <div role="group" aria-label="View" className="inline-flex h-9 rounded-[10px] border border-hair p-0.5">
          {(
            [
              { v: "blink", label: "Blink" },
              { v: "strip", label: "Side by side" },
            ] as const
          ).map((o) => (
            <button
              key={o.v}
              type="button"
              aria-pressed={view === o.v}
              onClick={() => pickView(o.v)}
              className={cn(
                "rounded-[8px] px-3 text-ui transition-colors",
                view === o.v ? "bg-ink-3 text-fg" : "text-fg-dim hover:text-fg",
              )}
            >
              {o.label}
            </button>
          ))}
        </div>
        {view === "blink" && (
          <button
            type="button"
            onClick={() => setPaused((p) => !p)}
            data-testid="blink-pause"
            className="inline-flex h-9 items-center gap-2 rounded-[10px] border border-hair-strong px-3 text-ui text-fg transition-colors hover:bg-ink-3"
          >
            {playing ? <PauseIcon aria-hidden className="size-4" /> : <PlayIcon aria-hidden className="size-4" />}
            {playing ? "Pause" : "Play"}
          </button>
        )}
        <button
          type="button"
          onClick={() => setRing((r) => !r)}
          aria-pressed={ring}
          className={cn(
            "inline-flex h-9 items-center gap-2 rounded-[10px] border px-3 text-ui transition-colors",
            ring ? "border-hair-strong text-fg hover:bg-ink-3" : "border-hair text-fg-dim hover:text-fg",
          )}
        >
          <span aria-hidden className={cn("size-3.5 rounded-full border-[1.5px]", ring ? "border-accent" : "border-fg-faint")} />
          JPL’s prediction
        </button>
      </div>

      <figcaption className="mt-4 flex max-w-2xl flex-col gap-1 text-meta text-pretty text-fg-dim">
        <span>
          Pluto in SPHEREx images from detector D{tracked.detector}, at {minUm(tracked.frames)}–{maxUm(tracked.frames)} µm, from{" "}
          {longDate(tracked.frames[0].date)} to {longDate(tracked.frames.at(-1)!.date)}. Each picture is one exposure of a{" "}
          {((tracked.gridPx * tracked.pixelArcsec) / 60).toFixed(0)}-arcminute patch of sky, north up and east to the left. The orange ring is
          where NASA JPL’s Horizons system predicts Pluto at that moment.
        </span>
        <span className="text-fg-faint">Source: SPHEREx Data Release 1 images; JPL Horizons; the Pluto bundle built for this page.</span>
      </figcaption>
    </Reveal>
  );
}

const minUm = (f: BlinkFrame[]) => Math.min(...f.map((x) => x.um)).toFixed(2);
const maxUm = (f: BlinkFrame[]) => Math.max(...f.map((x) => x.um)).toFixed(2);

function Sky({
  set,
  ariaLabel,
  className,
  children,
}: {
  set: BlinkSet;
  ariaLabel: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      role="img"
      aria-label={ariaLabel}
      data-grid={set.gridPx}
      className={cn("relative aspect-square overflow-hidden border border-hair bg-black", className)}
    >
      {children}
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
      className={cn("absolute inset-0 size-full max-w-none select-none [image-rendering:pixelated]", hidden && "opacity-0")}
    />
  );
}

/** A ring around JPL's predicted position (pixel centres sit at (i + 0.5) / grid). */
function Ring({ frame, grid }: { frame: BlinkFrame; grid: number }) {
  const [x, y] = frame.px;
  return (
    <span
      aria-hidden
      data-ring
      className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-full border-[1.5px] border-accent"
      style={{
        left: `${((x + 0.5) / grid) * 100}%`,
        top: `${((y + 0.5) / grid) * 100}%`,
        width: `${(RING_PX / grid) * 100}%`,
        height: `${(RING_PX / grid) * 100}%`,
      }}
    />
  );
}

function Compass() {
  return (
    <span className="absolute top-2.5 right-2.5 flex flex-col items-center text-micro text-fg/80" aria-hidden>
      <ArrowUpIcon className="size-3.5" />N
    </span>
  );
}

function ScaleBar({ set }: { set: BlinkSet }) {
  const width = `${((SCALE_ARCSEC / set.pixelArcsec / set.gridPx) * 100).toFixed(2)}%`;
  return (
    <span className="absolute bottom-2.5 left-2.5 flex flex-col gap-1 text-micro text-fg/80" aria-hidden style={{ width }}>
      <span className="readout whitespace-nowrap">1′</span>
      <span className="h-0.5 w-full rounded-full bg-fg/80" />
    </span>
  );
}
