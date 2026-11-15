"use client";
// "Watch it move": a small blink comparator made of the bundle's own PNG frames. Then vs Now
// (WISE about 2010 against SPHEREx today) plays first, then SPHEREx's visits on the best
// detector. All frames are stacked and decoded once, so a flip is an instant cut, as on a real
// blink comparator. Orange ticks mark where the catalogue (Gaia proper motion) puts the object on
// each date. Pauses itself for reduced motion; frames can be stepped by hand.

import { useEffect, useMemo, useRef, useState } from "react";
import { PauseIcon, PlayIcon } from "lucide-react";
import type { FieldManifest } from "@/lib/manifest";
import { cn } from "@/lib/utils";
import { Term } from "@/components/ui/term";
import { blinkFrames, catalogPosition, skyToFrame } from "@/components/sky-panel/bundle-frames";

const SPEEDS = [
  { id: "slow", label: "Slow", ms: 1200 },
  { id: "normal", label: "Normal", ms: 700 },
  { id: "fast", label: "Fast", ms: 340 },
] as const;
type SpeedId = (typeof SPEEDS)[number]["id"];

/** Who predicts the position: Gaia for most targets, Spitzer astrometry for WISE 0855. */
function catalogueName(m: FieldManifest): string {
  const src = m.target?.astrometry?.source ?? "";
  if (m.source === "fixture" || /fixture|synthetic/i.test(src)) return "the fixture’s synthetic motion";
  if (/gaia/i.test(src)) return "the Gaia catalogue";
  if (/kirkpatrick|spitzer/i.test(src)) return "Spitzer measurements (Kirkpatrick et al. 2021)";
  return src ? `the catalogue (${src})` : "the catalogue";
}

/** Full Moon: about 31 arcminutes across. */
function moonComparison(fovArcmin: number) {
  const r = fovArcmin / 31;
  if (r > 0.27 && r < 0.4) return "about a third of the width of the full Moon";
  if (r >= 0.4 && r < 0.6) return "about half the width of the full Moon";
  if (r >= 0.9 && r < 1.1) return "about the width of the full Moon";
  return `${r.toFixed(1)} times the width of the full Moon`;
}

export function MiniBlink({
  manifest,
  manifestUrl,
  watchFor,
  reducedMotion,
}: {
  manifest: FieldManifest;
  manifestUrl: string;
  watchFor: string;
  reducedMotion: boolean;
}) {
  const { frames } = useMemo(() => blinkFrames(manifest, manifestUrl), [manifest, manifestUrl]);
  const [index, setIndex] = useState(0);
  const [userPlaying, setUserPlaying] = useState<boolean | null>(null);
  const [speed, setSpeed] = useState<SpeedId>("normal");
  const [loaded, setLoaded] = useState<Record<string, "ok" | "error">>({});
  const [showTicks, setShowTicks] = useState(true);
  const playing = userPlaying ?? !reducedMotion;

  const usable = frames.filter((f) => loaded[f.key] !== "error");
  const ready = frames.length > 0 && frames.some((f) => loaded[f.key] === "ok");
  const allFailed = frames.length > 0 && usable.length === 0;
  const current = usable.length ? usable[Math.min(index, usable.length - 1)] : null;
  const ms = SPEEDS.find((s) => s.id === speed)!.ms;

  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  useEffect(() => {
    if (!playing || !ready || usable.length < 2) return;
    timer.current = setInterval(() => setIndex((i) => (i + 1) % usable.length), ms);
    return () => clearInterval(timer.current);
  }, [playing, ready, usable.length, ms]);

  const tick = useMemo(() => {
    if (!current) return null;
    const p = catalogPosition(manifest, current.mjd);
    return p ? skyToFrame(manifest, p.ra, p.dec) : null;
  }, [manifest, current]);

  if (frames.length === 0) {
    return <p className="text-ui text-fg-dim">This bundle has no images to compare yet.</p>;
  }

  const step = (to: number) => {
    setUserPlaying(false);
    setIndex(((to % usable.length) + usable.length) % usable.length);
  };
  const groups: { id: "then-now" | "visits"; label: string }[] = [
    { id: "then-now", label: "Then and now" },
    { id: "visits", label: "SPHEREx visits" },
  ];

  return (
    <figure className="flex flex-col gap-3" data-testid="mini-blink">
      <div
        role="img"
        aria-label={
          current
            ? `Frame ${usable.indexOf(current) + 1} of ${usable.length}: ${current.label}, ${current.detail}${current.partial ? ", partial visit" : ""}.`
            : "Images loading"
        }
        className="relative aspect-square w-full overflow-hidden rounded-md border border-hair bg-[#030303]"
      >
        {frames.map((f) => (
          // Plain images: these are the data frames themselves, shown pixel for pixel.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={f.key}
            src={f.src}
            alt=""
            draggable={false}
            onLoad={() => setLoaded((s) => ({ ...s, [f.key]: "ok" }))}
            onError={() => setLoaded((s) => ({ ...s, [f.key]: "error" }))}
            className="absolute inset-0 size-full object-contain [image-rendering:pixelated]"
            style={{ opacity: current?.key === f.key ? 1 : 0 }}
          />
        ))}

        {!ready && !allFailed && (
          <div className="absolute inset-0 animate-pulse bg-white/[0.03]" aria-hidden />
        )}
        {allFailed && (
          <p className="absolute inset-0 grid place-items-center p-6 text-center text-ui text-fg-dim">
            The images did not load. Try again in a moment.
          </p>
        )}

        {showTicks && tick && tick.x > 0 && tick.x < 1 && tick.y > 0 && tick.y < 1 && (
          <svg aria-hidden viewBox="0 0 100 100" className="pointer-events-none absolute inset-0 size-full">
            <g
              stroke="var(--accent)"
              strokeWidth={0.9}
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            >
              <line
                x1={tick.x * 100 - 9}
                y1={tick.y * 100}
                x2={tick.x * 100 - 4.5}
                y2={tick.y * 100}
                vectorEffect="non-scaling-stroke"
              />
              <line
                x1={tick.x * 100}
                y1={tick.y * 100 - 9}
                x2={tick.x * 100}
                y2={tick.y * 100 - 4.5}
                vectorEffect="non-scaling-stroke"
              />
            </g>
          </svg>
        )}

        {current && (
          <div className="pointer-events-none absolute top-2.5 left-2.5 flex flex-col rounded-[3px] bg-[#030303]/82 px-1.5 py-1 text-micro">
            <span className="font-medium text-fg">{current.label}</span>
            <span className="text-fg-dim">{current.detail}</span>
            {current.partial && <span className="text-fg-faint">Partial visit</span>}
          </div>
        )}

        {/* Finder-chart compass: north up, east left. */}
        <svg
          aria-hidden
          viewBox="0 0 40 40"
          className="pointer-events-none absolute top-2 right-2 size-10 text-fg-dim"
        >
          <g stroke="currentColor" strokeWidth={1} fill="none" strokeLinecap="round">
            <path d="M30 30 V12 M27.5 15 L30 12 L32.5 15" />
            <path d="M30 30 H12 M15 27.5 L12 30 L15 32.5" />
          </g>
          <text x="30" y="8" textAnchor="middle" fontSize="7.5" fill="currentColor">
            N
          </text>
          <text x="6" y="32.6" textAnchor="middle" fontSize="7.5" fill="currentColor">
            E
          </text>
        </svg>
      </div>

      <div role="group" aria-label="Blink controls" className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setUserPlaying(!playing)}
          disabled={usable.length < 2}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-hair px-2.5 text-micro text-fg-dim transition-colors duration-200 hover:border-hair-strong hover:text-fg disabled:opacity-40"
        >
          {playing ? (
            <PauseIcon aria-hidden className="size-3.5" />
          ) : (
            <PlayIcon aria-hidden className="size-3.5" />
          )}
          {playing ? "Pause" : "Play"}
        </button>
        <div
          role="radiogroup"
          aria-label="Blink speed"
          className="inline-flex rounded-md border border-hair p-0.5"
        >
          {SPEEDS.map((s) => (
            <button
              key={s.id}
              type="button"
              role="radio"
              aria-checked={speed === s.id}
              onClick={() => setSpeed(s.id)}
              className={`h-7 rounded-[4px] px-2 text-micro font-medium ${
                speed === s.id ? "bg-white/[0.08] text-fg" : "text-fg-dim hover:text-fg"
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
        <span className="readout ml-auto text-micro text-fg-faint" aria-hidden>
          {current ? usable.indexOf(current) + 1 : 0}/{usable.length}
        </span>
      </div>

      <div className="flex flex-col gap-2">
        {groups.map((g) => {
          const items = usable.filter((f) => f.group === g.id);
          if (!items.length) return null;
          return (
            <div key={g.id} className="grid grid-cols-[6.25rem_1fr] items-start gap-x-2">
              <span className="pt-1.5 text-micro text-fg-faint">{g.label}</span>
              <div className="-ml-1.5 flex flex-wrap gap-0.5">
                {items.map((f) => {
                  const i = usable.indexOf(f);
                  const active = current?.key === f.key;
                  return (
                    <button
                      key={f.key}
                      type="button"
                      aria-pressed={active}
                      aria-label={`Show ${f.label}, ${f.detail}`}
                      onClick={() => step(i)}
                      className={cn(
                        "relative h-7 rounded-[4px] px-1.5 text-micro text-fg-dim hover:text-fg",
                        active && "text-fg",
                        f.partial && "text-fg-faint",
                      )}
                    >
                      {f.label}
                      <span
                        aria-hidden
                        className={cn(
                          "absolute inset-x-1.5 bottom-0.5 h-px",
                          active ? "bg-accent" : "bg-transparent",
                        )}
                      />
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      <figcaption className="flex flex-col gap-2 text-meta text-pretty text-fg-dim">
        <p>
          <span className="text-fg">What to look for: </span>
          {watchFor}
        </p>
        <p className="text-fg-faint">
          Each image is {Math.round(manifest.fov_arcmin)} <Term k="arcminute">arcminutes</Term> across,{" "}
          {moonComparison(manifest.fov_arcmin)}. North is up, east is left.
          {tick && (
            <>
              {" "}
              The orange ticks mark where {catalogueName(manifest)} puts the object on each date.{" "}
              <button
                type="button"
                onClick={() => setShowTicks((v) => !v)}
                aria-pressed={!showTicks}
                className="text-fg-dim underline decoration-hair-strong underline-offset-4 hover:text-fg"
              >
                {showTicks ? "Hide the ticks" : "Show the ticks"}
              </button>
            </>
          )}
        </p>
      </figcaption>
    </figure>
  );
}
