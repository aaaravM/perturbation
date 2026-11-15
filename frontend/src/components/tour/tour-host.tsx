"use client";
// Where a tool hosts its guided tour: the Tour button, the once-only offer on a first visit, the
// tour=1 link that starts it directly, and the tour itself. The offer is quiet: a small glass note
// that never blocks the page, shown at most once per tool (Settings can turn it off or replay a
// tour). When a tour ends or is skipped, the Lab goes back to the mode, detector, layers and blink
// it had before the tour changed them.

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { parseAsInteger, useQueryState, useQueryStates } from "nuqs";
import { RouteIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LiquidGlass } from "@/components/ui/liquid-glass";
import { labParsers, labUrlOptions } from "@/lib/lab-state";
import { prefersReducedMotionNow, useEffectiveReducedMotion, usePreference } from "@/lib/preferences";
import { endTour, markTourSeen, mountTourHost, startTour, tourSeen, useActiveTour, type TourId } from "@/lib/tour";
import { clickElement } from "@/components/tour/tour-actions";
import { TourOverlay } from "@/components/tour/tour-overlay";
import { cn } from "@/lib/utils";

const OFFER_DELAY_MS = 1600;
const OFFER_TEXT: Record<TourId, string> = {
  sky: "New here? Take a one-minute tour of the Sky globe.",
  lab: "New here? Take a one-minute tour of the Lab.",
};

// ------------------------------------------------------------------------------- buttons

/** Sky: a small group beside the view controls, drawn like them. */
export function SkyTourButton() {
  return (
    <div className="inline-flex items-center rounded-md border border-hair bg-ink/80 p-0.5">
      <button
        type="button"
        data-tour-button="sky"
        data-testid="tour-button"
        title="A guided tour of the Sky globe"
        onClick={(e) => startTour("sky", e.currentTarget)}
        className="inline-flex h-7 items-center gap-1.5 rounded-[4px] px-2 text-micro font-medium text-fg-dim transition-colors hover:bg-white/[0.06] hover:text-fg [&_svg]:size-3.5"
      >
        <RouteIcon aria-hidden />
        <span className="max-sm:sr-only">Tour</span>
      </button>
    </div>
  );
}

/** Lab: in the session bar, drawn like its "On the sky globe" link. */
export function LabTourButton() {
  return (
    <button
      type="button"
      data-tour-button="lab"
      data-testid="tour-button"
      title="A guided tour of the Lab"
      onClick={(e) => startTour("lab", e.currentTarget)}
      className="mr-1 inline-flex h-7 items-center gap-1.5 rounded-[5px] px-2 text-micro text-fg-dim transition-colors duration-150 hover:bg-white/[0.06] hover:text-fg"
    >
      <RouteIcon className="size-3.5" aria-hidden />
      <span className="max-sm:sr-only">Tour</span>
    </button>
  );
}

// ------------------------------------------------------------------------------- hosts

export function SkyTourHost({ offerClassName }: { offerClassName?: string }) {
  return <TourHost id="sky" offerClassName={offerClassName} />;
}

/** The Lab's host also puts the Lab back as it was before the tour. */
export function LabTourHost({ offerClassName }: { offerClassName?: string }) {
  const [lab, setLab] = useQueryStates(
    { mode: labParsers.mode, det: labParsers.det, layers: labParsers.layers },
    labUrlOptions,
  );
  const before = useRef<{ mode: typeof lab.mode; det: typeof lab.det; layers: typeof lab.layers; playing: boolean } | null>(null);
  const labRef = useRef(lab);
  useEffect(() => {
    labRef.current = lab;
  });
  const onBegin = useCallback(() => {
    const now = labRef.current;
    before.current = {
      mode: now.mode,
      det: now.det,
      layers: now.layers,
      playing: document.querySelector<HTMLElement>("[data-testid=blink-play]")?.dataset.playing === "true",
    };
  }, []);
  const onEnd = useCallback(() => {
    const b = before.current;
    before.current = null;
    if (!b) return;
    void setLab({ mode: b.mode, det: b.det, layers: b.layers });
    if (!b.playing || prefersReducedMotionNow()) return;
    // The blink plays again once the frames of the restored mode are on screen.
    let tries = 0;
    const resume = () => {
      const play = document.querySelector<HTMLElement>("[data-testid=blink-play]");
      if (play && play.dataset.playing === "false" && !play.hasAttribute("disabled")) clickElement(play);
      else if (tries++ < 20 && (!play || play.hasAttribute("disabled"))) window.setTimeout(resume, 150);
    };
    window.setTimeout(resume, 400);
  }, [setLab]);
  return <TourHost id="lab" offerClassName={offerClassName} onBegin={onBegin} onEnd={onEnd} />;
}

function TourHost({
  id,
  offerClassName,
  onBegin,
  onEnd,
}: {
  id: TourId;
  offerClassName?: string;
  onBegin?: () => void;
  onEnd?: () => void;
}) {
  const active = useActiveTour();
  const [tourParam, setTourParam] = useQueryState("tour", parseAsInteger.withOptions({ history: "replace", scroll: false }));
  const offerOn = usePreference("tourOffer");
  const reduced = useEffectiveReducedMotion();
  const [offer, setOffer] = useState(false);

  // ?tour=1 starts the tour at once; the address then drops it, so a reload does not restart it.
  const fromLink = useRef(tourParam === 1);
  useEffect(() => {
    if (tourParam === null) return;
    if (tourParam === 1) startTour(id, null);
    void setTourParam(null);
  }, [tourParam, id, setTourParam]);

  // The first visit: one quiet offer, a moment after arrival, never again once shown.
  useEffect(() => {
    if (!offerOn || fromLink.current || tourSeen(id)) return;
    const t = window.setTimeout(() => {
      if (tourSeen(id)) return;
      markTourSeen(id);
      setOffer(true);
    }, OFFER_DELAY_MS);
    return () => window.clearTimeout(t);
  }, [offerOn, id]);
  const showOffer = offer && offerOn && active === null;

  // Leaving the tool (a link, the back button) ends its tour, so it does not wait for the next visit.
  useEffect(() => mountTourHost(id), [id]);

  const close = useCallback(() => {
    onEnd?.();
    endTour();
  }, [onEnd]);

  return (
    <>
      <AnimatePresence>
        {showOffer && (
          <motion.div
            key="offer"
            initial={reduced ? false : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduced ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, y: 6, transition: { duration: 0.2 } }}
            transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
            className={cn("pointer-events-none", offerClassName)}
          >
            <Offer
              text={OFFER_TEXT[id]}
              onStart={(from) => {
                setOffer(false);
                startTour(id, from);
              }}
              onDismiss={() => {
                setOffer(false);
                requestAnimationFrame(() =>
                  document.querySelector<HTMLElement>(`[data-tour-button="${id}"]`)?.focus({ preventScroll: true }),
                );
              }}
            />
          </motion.div>
        )}
      </AnimatePresence>
      <p className="sr-only" aria-live="polite">
        {showOffer ? OFFER_TEXT[id] : ""}
      </p>
      <AnimatePresence>{active === id && <TourOverlay key="tour" tour={id} onClose={close} onBegin={onBegin} />}</AnimatePresence>
    </>
  );
}

function Offer({ text, onStart, onDismiss }: { text: string; onStart: (from: HTMLElement | null) => void; onDismiss: () => void }): ReactNode {
  return (
    <LiquidGlass
      as="section"
      variant="regular"
      radius={16}
      refraction={false}
      aria-label="Guided tour"
      data-testid="tour-offer"
      className="pointer-events-auto flex w-full flex-col gap-3 p-4 sm:w-[19rem]"
    >
      <p className="text-ui text-pretty text-fg">{text}</p>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          className="h-8 px-3"
          onClick={() => onStart(document.querySelector<HTMLElement>("[data-tour-button]"))}
          data-testid="tour-offer-start"
        >
          Start tour
        </Button>
        <Button variant="ghost" size="sm" className="h-8 px-3 text-(--fg-glass-dim)" onClick={onDismiss} data-testid="tour-offer-dismiss">
          Not now
        </Button>
      </div>
    </LiquidGlass>
  );
}
