"use client";
// One candidate on /discoveries: a card in the list (its stamp blinking between the earlier and the
// later co-add, beside the difference) and a detail sheet with the large panels, the four class
// probabilities and every measured value. Nothing is shown that the list does not contain.

import * as React from "react";
import Link from "next/link";
import { ArrowUpRightIcon, PauseIcon, PlayIcon } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Term } from "@/components/ui/term";
import { useEffectiveReducedMotion, useMediaQuery } from "@/lib/preferences";
import {
  CLASS_LABEL,
  CLASS_NAMES,
  brightnessWords,
  compass,
  daysBetween,
  formatDay,
  formatQ,
  percent,
  probPercent,
  type Candidate,
} from "@/lib/discoveries";
import { cn } from "@/lib/utils";
import { BlinkPanels, PhaseText, StampPanel, useBlinkClock, type StampSource } from "./stamp";

const stampOf = (c: Candidate): StampSource | null => (c.stamp ? { type: "strip", src: c.stamp } : null);

export const candidateTitle = (c: Candidate) => (c.kind === "mover" ? "Possible mover" : "Possible brightness change");

/** "3.66 ± 0.43″ a year, towards the south-west". */
export function motionWords(c: Candidate): string | null {
  const m = c.motion;
  if (!m) return null;
  const err = m.pm_err_arcsec_yr !== null ? ` ± ${m.pm_err_arcsec_yr.toFixed(2)}` : "";
  const dir = m.pa_deg !== null ? `, towards the ${compass(m.pa_deg)}` : "";
  return `${m.pm_arcsec_yr.toFixed(2)}${err}″ a year${dir}`;
}

function MatchLine({ c, className }: { c: Candidate; className?: string }) {
  const m = c.match;
  if (m.status === "known") {
    return (
      <p className={cn("text-meta text-pretty text-fg-dim", className)}>
        Known: <span className="text-fg">{m.name ?? m.id ?? "a catalogued source"}</span>
        {m.catalog && <> in {m.catalog}</>}
        {m.sep_arcsec !== null && <>, {m.sep_arcsec.toFixed(1)}″ away</>}
      </p>
    );
  }
  return (
    <p className={cn("text-meta text-pretty text-fg-dim", className)}>
      <span className="text-accent">New:</span> no catalogued source close enough
    </p>
  );
}

function Figure({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-micro text-fg-faint">{label}</dt>
      <dd className="readout mt-0.5 text-ui text-fg" title={hint}>
        {value}
      </dd>
    </div>
  );
}

// ---------------------------------------------------------------------------------- card

export function CandidateCard({
  c,
  field,
  reduce,
  onOpen,
}: {
  c: Candidate;
  field: string;
  reduce: boolean;
  onOpen: (id: string) => void;
}) {
  const source = stampOf(c);
  const motion = motionWords(c);
  const title = candidateTitle(c);
  return (
    <article
      data-testid="candidate-card"
      data-id={c.id}
      data-q={c.q_value}
      data-kind={c.kind}
      data-match={c.match.status}
      className="flex w-full min-w-0 flex-col rounded-[18px] border border-hair bg-ink-2 p-3 transition-colors duration-200 hover:border-hair-strong"
    >
      {source ? (
        <button
          type="button"
          onClick={() => onOpen(c.id)}
          aria-label={`${title} in the ${field} field: show the large images and details`}
          className="block w-full overflow-hidden rounded-[12px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {reduce ? (
            <span className="grid grid-cols-3 gap-1">
              <StampPanel source={source} panel={0} />
              <StampPanel source={source} panel={1} />
              <StampPanel source={source} panel={2} />
            </span>
          ) : (
            <span className="grid grid-cols-2 gap-1">
              <BlinkPanels source={source} />
              <StampPanel source={source} panel={2} />
            </span>
          )}
        </button>
      ) : (
        <div className="grid aspect-[2/1] place-items-center rounded-[12px] bg-ink-3 text-meta text-fg-faint">No stamp</div>
      )}
      {source && c.epochs && (
        <p aria-hidden className={cn("mt-1.5 grid gap-1 text-micro text-fg-faint", reduce ? "grid-cols-3" : "grid-cols-2")}>
          {reduce ? (
            <>
              <span>{formatDay(c.epochs[0])}</span>
              <span>{formatDay(c.epochs[1])}</span>
            </>
          ) : (
            <span className="readout">
              <PhaseText phase={0}>{formatDay(c.epochs[0])}</PhaseText>
              <PhaseText phase={1}>{formatDay(c.epochs[1])}</PhaseText>
            </span>
          )}
          <span>Difference</span>
        </p>
      )}

      <div className="mt-3 flex flex-col gap-1 px-1">
        <h3 className="text-ui font-medium text-fg">
          {title}
          <span className="font-normal text-fg-dim"> in the {field} field</span>
        </h3>
        <MatchLine c={c} />
      </div>

      <dl className="mt-3 grid grid-cols-3 gap-2 px-1">
        <Figure label="Confidence" value={percent(c.score)} />
        <Figure label="q-value" value={formatQ(c.q_value)} />
        <Figure label="Signal / noise" value={c.snr !== null ? c.snr.toFixed(1) : "–"} />
      </dl>

      <p className="mt-2 px-1 text-meta text-pretty text-fg-dim">
        {motion
          ? `Moves ${motion}.`
          : c.variability
            ? `${brightnessWords(c.variability)}.`
            : c.kind === "mover"
              ? "Its motion could not be measured."
              : "The size of the change could not be measured."}
      </p>

      <div className="mt-auto flex flex-wrap items-center gap-1 pt-3">
        <button
          type="button"
          onClick={() => onOpen(c.id)}
          className="inline-flex h-9 items-center rounded-[8px] px-2 text-meta text-fg-dim transition-colors hover:bg-white/[0.05] hover:text-fg"
        >
          Details
        </button>
        <Link
          href={c.lab_url}
          className="ml-auto inline-flex h-9 items-center gap-1 rounded-[8px] px-2 text-meta text-fg transition-colors hover:bg-white/[0.05]"
        >
          Open in the Lab
          <ArrowUpRightIcon aria-hidden className="size-3.5 text-fg-dim" />
        </Link>
      </div>
    </article>
  );
}

// --------------------------------------------------------------------------------- sheet

function Row({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[9.5rem_minmax(0,1fr)] gap-3 border-b border-hair py-2.5 last:border-b-0">
      <dt className="text-meta text-fg-dim">{label}</dt>
      <dd className="text-meta text-pretty text-fg">{children}</dd>
    </div>
  );
}

function BigBlink({ source, epochs }: { source: StampSource; epochs: [string, string] | null }) {
  const [playing, setPlaying] = React.useState(true);
  const { ref, flip } = useBlinkClock<HTMLDivElement>(600, playing);
  return (
    <div ref={ref} className="group/blink">
      <button
        type="button"
        onClick={() => (playing ? setPlaying(false) : flip())}
        aria-label={playing ? "Pause the blink" : "Show the other image"}
        className="block w-full overflow-hidden rounded-[14px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <BlinkPanels source={source} />
      </button>
      <div className="mt-2 flex items-center justify-between gap-3">
        <p className="text-meta text-fg-dim">
          <PhaseText phase={0}>
            Earlier{epochs && <>, <span className="readout text-fg">{formatDay(epochs[0])}</span></>}
          </PhaseText>
          <PhaseText phase={1}>
            Later{epochs && <>, <span className="readout text-fg">{formatDay(epochs[1])}</span></>}
          </PhaseText>
        </p>
        <button
          type="button"
          onClick={() => setPlaying((p) => !p)}
          aria-pressed={!playing}
          className="-mr-2 inline-flex h-9 items-center gap-1.5 rounded-[8px] px-2 text-meta text-fg-dim transition-colors hover:bg-white/[0.05] hover:text-fg"
        >
          {playing ? <PauseIcon aria-hidden className="size-3.5" /> : <PlayIcon aria-hidden className="size-3.5" />}
          {playing ? "Pause" : "Blink"}
        </button>
      </div>
    </div>
  );
}

/** `c` stays set while the sheet closes, so its content does not vanish as it slides out. */
export function CandidateSheet({
  c,
  open,
  field,
  onClose,
}: {
  c: Candidate | null;
  open: boolean;
  field: string;
  onClose: () => void;
}) {
  const wide = useMediaQuery("(min-width: 640px)");
  const reduce = useEffectiveReducedMotion();
  const k = c;

  return (
    <Sheet open={open && c !== null} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side={wide ? "right" : "bottom"}
        data-testid="candidate-sheet"
        className={cn(
          "gap-0 overflow-y-auto overscroll-contain border-hair bg-popover p-0",
          wide ? "w-full sm:max-w-[34rem]" : "max-h-[88dvh] rounded-t-[22px]",
        )}
      >
        {k && (
          <div className="flex flex-col px-5 pt-5 pb-8 sm:px-6">
            <SheetTitle className="pr-10 text-heading text-fg">{candidateTitle(k)}</SheetTitle>
            <SheetDescription className="mt-1 text-meta text-fg-dim">
              In the {field} field. Candidate <span className="readout">{k.id}</span>
            </SheetDescription>

            {k.stamp && (
              <div className="mt-5 flex flex-col gap-3">
                {!reduce && <BigBlink source={{ type: "strip", src: k.stamp }} epochs={k.epochs} />}
                <div className="grid grid-cols-3 gap-2">
                  {(["Earlier", "Later", "Difference"] as const).map((label, i) => (
                    <figure key={label} className="flex min-w-0 flex-col gap-1.5">
                      <StampPanel source={{ type: "strip", src: k.stamp! }} panel={i as 0 | 1 | 2} className="rounded-[10px]" />
                      <figcaption className="text-micro text-fg-dim">
                        {label}
                        {k.epochs && i < 2 && <span className="readout block text-fg-faint">{formatDay(k.epochs[i])}</span>}
                      </figcaption>
                    </figure>
                  ))}
                </div>
                <p className="text-micro text-pretty text-fg-faint">
                  3.3 arcminutes across, north up and east left. Both images share one brightness scale. In the difference,
                  white is brighter later and black fainter later or where the source used to be.
                </p>
              </div>
            )}

            <section aria-labelledby="sheet-probs" className="mt-6">
              <h3 id="sheet-probs" className="text-ui font-medium text-fg">
                What the model thinks it is
              </h3>
              <ul className="mt-3 flex flex-col gap-2.5" data-testid="class-probabilities">
                {CLASS_NAMES.map((name) => {
                  const p = k.probs[name];
                  const top = CLASS_NAMES.every((other) => k.probs[other] <= p);
                  return (
                    <li key={name} className="grid grid-cols-[8.5rem_minmax(0,1fr)_3.5rem] items-center gap-3">
                      <span className={cn("text-meta", top ? "text-fg" : "text-fg-dim")}>{CLASS_LABEL[name]}</span>
                      <span aria-hidden className="h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
                        <span
                          className={cn("block h-full origin-left rounded-full", top ? "bg-accent" : "bg-fg-faint")}
                          style={{ transform: `scaleX(${Math.max(p, 0.004)})` }}
                        />
                      </span>
                      <span className="readout text-right text-meta text-fg">{probPercent(p)}</span>
                    </li>
                  );
                })}
              </ul>
              <p className="mt-2 text-micro text-fg-faint">The four probabilities add up to 100%.</p>
            </section>

            <section aria-labelledby="sheet-measured" className="mt-6">
              <h3 id="sheet-measured" className="text-ui font-medium text-fg">
                Measured
              </h3>
              <dl className="mt-2">
                <Row label="Confidence">
                  <span className="readout">{percent(k.score)}</span>
                  <span className="text-fg-dim"> that it is real (mover or brightness change)</span>
                </Row>
                <Row label="q-value">
                  <span className="readout">{formatQ(k.q_value)}</span>
                  {k.p_value !== null && (
                    <span className="text-fg-dim">
                      {" "}
                      (p-value <span className="readout">{formatQ(k.p_value)}</span>), within its field
                    </span>
                  )}
                </Row>
                <Row label="Signal / noise">
                  {k.snr !== null ? <span className="readout">{k.snr.toFixed(1)}</span> : "Not measured"}
                  <span className="text-fg-dim"> in the difference image</span>
                </Row>
                {k.kind === "mover" && (
                  <Row label={<Term k="properMotion" />}>
                    {k.motion ? (
                      <>
                        <span className="readout">
                          {k.motion.pm_arcsec_yr.toFixed(2)}
                          {k.motion.pm_err_arcsec_yr !== null && ` ± ${k.motion.pm_err_arcsec_yr.toFixed(2)}`}″
                        </span>{" "}
                        a year
                        {k.motion.pa_deg !== null && (
                          <>
                            , towards <span className="readout">{k.motion.pa_deg.toFixed(0)}°</span> ({compass(k.motion.pa_deg)})
                          </>
                        )}
                        {k.motion.n_epochs !== null && <span className="text-fg-dim">, from {k.motion.n_epochs} visits</span>}
                      </>
                    ) : (
                      <span className="text-fg-dim">The position fit did not converge</span>
                    )}
                  </Row>
                )}
                {k.variability && (
                  <Row label="Brightness change">
                    <span className="readout">
                      {k.variability.delta_mag > 0 ? "+" : k.variability.delta_mag < 0 ? "−" : ""}
                      {Math.abs(k.variability.delta_mag).toFixed(2)}
                    </span>{" "}
                    <Term k="magnitude">mag</Term>
                    <span className="text-fg-dim">
                      {" "}
                      ({brightnessWords(k.variability).toLowerCase()}
                      {k.variability.sigma !== null && <>, {k.variability.sigma.toFixed(1)}σ</>})
                    </span>
                  </Row>
                )}
                {k.epochs && (
                  <Row label="Compared">
                    {formatDay(k.epochs[0])} and {formatDay(k.epochs[1])}
                    <span className="text-fg-dim">, {daysBetween(k.epochs)} days apart</span>
                  </Row>
                )}
                {k.detectors.length > 0 && <Row label="Seen in">{k.detectors.join(", ")}</Row>}
                <Row label="Position">
                  <span className="readout">
                    {k.ra.toFixed(5)}°, {k.dec >= 0 ? "+" : "−"}
                    {Math.abs(k.dec).toFixed(5)}°
                  </span>
                  <span className="text-fg-dim"> (RA, Dec)</span>
                </Row>
                <Row label="Catalogue">
                  {k.match.status === "known" ? (
                    <>
                      {k.match.name ?? k.match.id}
                      {k.match.catalog && <span className="text-fg-dim"> in {k.match.catalog}</span>}
                      {k.match.sep_arcsec !== null && <span className="text-fg-dim">, {k.match.sep_arcsec.toFixed(2)}″ away</span>}
                      {k.match.catalog_pm_arcsec_yr !== null && (
                        <span className="text-fg-dim">
                          ; catalogue motion <span className="readout">{k.match.catalog_pm_arcsec_yr.toFixed(2)}″</span> a year
                        </span>
                      )}
                    </>
                  ) : (
                    <span className="text-fg-dim">No match in Gaia DR3, CatWISE2020 or SIMBAD</span>
                  )}
                </Row>
              </dl>
            </section>

            <div className="mt-6 flex flex-wrap items-center gap-3">
              <Link
                href={k.lab_url}
                className="inline-flex h-11 items-center gap-2 rounded-md bg-fg px-5 text-ui font-medium text-ink transition-colors hover:bg-fg/85"
              >
                Open in the Lab
                <ArrowUpRightIcon aria-hidden className="size-4" />
              </Link>
              <p className="text-micro text-pretty text-fg-faint">
                Not confirmed. Check the images, and look at it in the Lab before trusting it.
              </p>
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
