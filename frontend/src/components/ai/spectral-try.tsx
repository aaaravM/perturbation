"use client";
// Try the spectral classifier on the live API: a name or coordinates goes through the Lab's resolver
// (lib/lab-resolve.ts: typed coordinates, the five challenge targets, else /api/resolve), then
// /api/spectrum/quick reads the SPHEREx DR1 quick-look spectrum there and returns the classifier's
// answer. Its probabilities, caveats or its reason for declining are shown word for word. A slow or
// failed call says so and offers a retry; nothing is ever filled in.

import * as React from "react";
import Link from "next/link";
import { ArrowUpRightIcon, LoaderCircleIcon, RotateCwIcon } from "lucide-react";
import { QuickSpectrum } from "@/components/sky-panel/quick-spectrum";
import { ResolveError, resolveQuery, type ResolvedPlace } from "@/lib/lab-resolve";
import { API_URL } from "@/lib/manifest";
import { useEffectiveReducedMotion } from "@/lib/preferences";
import type { QuickSpectrum as QuickSpectrumData } from "@/lib/sky-live";
import { CLASS_NAMES, classSentence, parseClassification, type SpectralClassification } from "@/lib/spectral-class";
import { cn } from "@/lib/utils";

export const PRESETS = [
  { query: "3C 273", note: "a quasar" },
  { query: "Epsilon Indi B", note: "a pair of brown dwarfs" },
  { query: "Barnard's Star", note: "a bright red dwarf" },
] as const;

/** After this long the status says the archive is slow; after the second, the call is given up. */
const SLOW_MS = 6000;
const TIMEOUT_MS = 45000;

type Raw = Record<string, unknown>;

interface Answer {
  place: ResolvedPlace;
  spectrum: QuickSpectrumData | null;
  /** The classifier's answer; null when the response carries none. */
  cls: SpectralClassification | null;
  /** The quick look's own note on its data. */
  note: string | null;
  /** The cube has no data at this position (HTTP 404). */
  empty: boolean;
}

type Phase =
  | { s: "idle" }
  | { s: "busy"; query: string; place: ResolvedPlace | null; slow: boolean }
  | { s: "done"; query: string; answer: Answer }
  | { s: "error"; query: string; message: string; retry: boolean };

class HttpProblem extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

const fin = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** The quick look's spectrum, in the shape the Sky panel's chart draws (as lib/sky-live.ts reads it). */
function parseSpectrum(o: Raw): QuickSpectrumData | null {
  if (!Array.isArray(o.wl_um) || !Array.isArray(o.flux_ujy)) return null;
  const wl = (o.wl_um as unknown[]).map((v) => fin(v) ?? Number.NaN);
  const flux = (o.flux_ujy as unknown[]).map(fin);
  const err = Array.isArray(o.err_ujy) ? (o.err_ujy as unknown[]).map(fin) : flux.map(() => null);
  if (!flux.some((f) => f !== null)) return null;
  return {
    wl,
    flux,
    err,
    label: typeof o.label === "string" && o.label.trim() ? o.label : "SPHEREx DR1 quick-look spectrum",
    // The chart adds the pixel size after the label; the API's label usually names it already.
    pixelArcsec: typeof o.label === "string" && /arcsec/.test(o.label) ? null : fin(o.pixel_arcsec),
    classification: null,
  };
}

async function readSpectrum(place: ResolvedPlace, signal: AbortSignal): Promise<Answer> {
  const res = await fetch(`${API_URL}/api/spectrum/quick?ra=${place.ra.toFixed(5)}&dec=${place.dec.toFixed(5)}`, { signal });
  if (res.status === 404) return { place, spectrum: null, cls: null, note: null, empty: true };
  if (!res.ok) throw new HttpProblem(res.status);
  const body = (await res.json()) as Raw;
  return {
    place,
    spectrum: parseSpectrum(body),
    cls: parseClassification(body.classification),
    note: typeof body.notes === "string" && body.notes.trim() ? body.notes : null,
    empty: false,
  };
}

export function SpectralTry() {
  const [query, setQuery] = React.useState("");
  const [phase, setPhase] = React.useState<Phase>({ s: "idle" });
  const ctlRef = React.useRef<AbortController | null>(null);
  const timers = React.useRef<number[]>([]);
  const reduce = useEffectiveReducedMotion();

  const clearTimers = () => {
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current = [];
  };

  React.useEffect(
    () => () => {
      ctlRef.current?.abort();
      timers.current.forEach((t) => window.clearTimeout(t));
    },
    [],
  );

  const run = async (raw: string) => {
    const q = raw.trim();
    ctlRef.current?.abort();
    clearTimers();
    if (!q) {
      setPhase({ s: "error", query: q, message: "Type a name or coordinates first.", retry: false });
      return;
    }
    if (!API_URL) {
      setPhase({ s: "error", query: q, message: "The live classifier is not connected on this copy of the site.", retry: false });
      return;
    }
    const ctl = new AbortController();
    ctlRef.current = ctl;
    const mine = () => ctlRef.current === ctl;
    let timedOut = false;
    timers.current.push(
      window.setTimeout(() => mine() && setPhase((p) => (p.s === "busy" ? { ...p, slow: true } : p)), SLOW_MS),
      window.setTimeout(() => {
        timedOut = true;
        ctl.abort();
      }, TIMEOUT_MS),
    );
    setPhase({ s: "busy", query: q, place: null, slow: false });
    try {
      const place = await resolveQuery(q, ctl.signal);
      if (!mine()) return;
      setPhase((p) => (p.s === "busy" ? { ...p, place } : p));
      const answer = await readSpectrum(place, ctl.signal);
      if (!mine()) return;
      setPhase({ s: "done", query: q, answer });
    } catch (err) {
      if (!mine()) return;
      if (timedOut) {
        setPhase({
          s: "error",
          query: q,
          message: `No answer after ${TIMEOUT_MS / 1000} seconds. NASA’s archive can be slow; try again in a moment.`,
          retry: true,
        });
      } else if (err instanceof ResolveError) {
        setPhase({ s: "error", query: q, message: err.message, retry: err.reason === "unavailable" });
      } else if (err instanceof HttpProblem) {
        setPhase({ s: "error", query: q, message: `The spectrum service answered HTTP ${err.status}.`, retry: true });
      } else {
        setPhase({ s: "error", query: q, message: "The spectrum service could not be reached.", retry: true });
      }
    } finally {
      if (mine()) clearTimers();
    }
  };

  const pick = (q: string) => {
    setQuery(q);
    void run(q);
  };

  const busy = phase.s === "busy";
  const current = phase.s === "idle" ? null : phase.query;

  return (
    <div className="flex flex-col gap-6" data-testid="ai-spec-try">
      <div className="flex max-w-2xl flex-col gap-3">
        <form
          role="search"
          aria-label="Classify the spectrum of an object"
          onSubmit={(e) => {
            e.preventDefault();
            void run(query);
          }}
          className="flex flex-col gap-2"
        >
          <label htmlFor="ai-spec-query" className="text-ui text-fg">
            A name or coordinates
          </label>
          <div className="flex gap-2">
            <input
              id="ai-spec-query"
              data-testid="ai-spec-input"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="A name, or RA and Dec"
              autoComplete="off"
              spellCheck={false}
              className="h-11 min-w-0 flex-1 rounded-md border border-hair-strong bg-ink/80 px-3 text-body text-fg transition-colors outline-none placeholder:text-fg-faint focus-visible:border-accent sm:text-ui"
            />
            <button
              type="submit"
              disabled={busy}
              className="inline-flex h-11 shrink-0 items-center gap-2 rounded-md bg-fg px-5 text-ui font-medium text-ink transition-colors hover:bg-fg/85 disabled:opacity-60"
            >
              {busy && <LoaderCircleIcon aria-hidden className="size-4 animate-spin reduced:animate-none" />}
              Classify
            </button>
          </div>
        </form>
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Examples">
          <span className="mr-1 text-meta text-fg-faint">Or try</span>
          {PRESETS.map((p) => (
            <button
              key={p.query}
              type="button"
              onClick={() => pick(p.query)}
              aria-pressed={current === p.query}
              data-testid="ai-spec-preset"
              className={cn(
                "inline-flex h-11 items-center gap-1.5 rounded-md border px-3 text-meta transition-colors",
                current === p.query ? "border-accent text-fg" : "border-hair text-fg-dim hover:border-hair-strong hover:text-fg",
              )}
            >
              <span className="text-fg">{p.query}</span>
              <span className="text-fg-faint">{p.note}</span>
            </button>
          ))}
        </div>
        <Status phase={phase} onRetry={() => current !== null && run(current)} />
      </div>

      {phase.s === "done" && <Result key={phase.query} answer={phase.answer} reduce={reduce} />}
    </div>
  );
}

function Status({ phase, onRetry }: { phase: Phase; onRetry: () => void }) {
  return (
    <div role="status" aria-live="polite" data-testid="ai-spec-status" data-state={phase.s} className="min-h-5 text-meta text-pretty">
      {phase.s === "idle" && (
        <p className="text-fg-faint">The answer comes from the live API: it reads the spectrum and runs the network as you ask.</p>
      )}
      {phase.s === "busy" && (
        <p className="text-fg-dim">
          {phase.place
            ? `Reading the SPHEREx spectrum at ${phase.place.name} and running the classifier…`
            : `Finding “${phase.query}”…`}
          {phase.slow && (
            <span className="text-fg-faint">
              {" "}
              This is taking a while: NASA’s archive can be slow. Waiting up to {TIMEOUT_MS / 1000} seconds.
            </span>
          )}
        </p>
      )}
      {phase.s === "error" && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <p className="text-fg-dim" data-testid="ai-spec-error">
            {phase.message}
          </p>
          {phase.retry && (
            <button
              type="button"
              onClick={onRetry}
              className="inline-flex h-9 items-center gap-1.5 rounded-[8px] px-2 text-meta text-fg transition-colors hover:bg-white/[0.05]"
            >
              <RotateCwIcon aria-hidden className="size-3.5" />
              Try again
            </button>
          )}
        </div>
      )}
      {phase.s === "done" && (
        <p className="text-fg-faint">
          Answered by the live API for {phase.answer.place.name}.
        </p>
      )}
    </div>
  );
}

/** A probability as a whole percentage, never rounded to a certain 100% or an impossible 0% (as the Sky panel shows it). */
function share(p: number): string {
  if (p >= 0.995) return ">99%";
  if (p < 0.005) return "<1%";
  return `${Math.round(p * 100)}%`;
}

const signedDeg = (v: number) => `${v < 0 ? "−" : "+"}${Math.abs(v).toFixed(5)}°`;

function Result({ answer, reduce }: { answer: Answer; reduce: boolean }) {
  const { place, spectrum, cls, note, empty } = answer;
  const lab = place.slug
    ? `/explore?target=${place.slug}`
    : `/explore?ra=${place.ra.toFixed(5)}&dec=${place.dec.toFixed(5)}&fov=0.1667`;
  return (
    <div
      data-testid="ai-spec-result"
      data-status={cls?.status ?? (empty ? "empty" : "missing")}
      className="flex flex-col gap-6 border-t border-hair pt-6 animate-in fade-in-0 duration-300 reduced:animate-none"
    >
      <div className="flex flex-col gap-1">
        <h3 className="text-lead text-fg">{place.name}</h3>
        <p className="text-meta text-pretty text-fg-dim">
          Read at RA <span className="readout">{place.ra.toFixed(5)}°</span>, Dec <span className="readout">{signedDeg(place.dec)}</span>.{" "}
          {place.provenance}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-x-10 gap-y-8 md:grid-cols-2">
        <div className="flex max-w-[30rem] min-w-0 flex-col gap-2">
          {spectrum ? (
            <QuickSpectrum data={spectrum} reducedMotion={reduce} />
          ) : (
            <p className="text-meta text-fg-faint">
              {empty ? "The DR1 spectral cube has no data at this position." : "This answer carries no spectrum to draw."}
            </p>
          )}
          {note && <p className="text-micro text-pretty text-fg-faint">From the API: {note}</p>}
        </div>

        <div className="min-w-0">
          {cls?.status === "ok" ? (
            <Verdict c={cls} />
          ) : cls?.status === "none" ? (
            <section aria-labelledby="ai-spec-declined" className="flex flex-col gap-3">
              <h4 id="ai-spec-declined" className="text-ui text-fg">
                The classifier declines
              </h4>
              <p className="border-l border-hair-strong pl-3 text-meta text-pretty text-fg" data-testid="ai-spec-reason">
                {cls.reason}
              </p>
              <p className="text-micro text-fg-faint">Its reason, word for word, as the API gave it.</p>
            </section>
          ) : (
            <p className="text-meta text-fg-faint">
              {empty ? "With no spectrum, there is nothing to classify." : "This answer carries no classification."}
            </p>
          )}
        </div>
      </div>

      <div>
        <Link
          href={lab}
          className="inline-flex h-11 items-center gap-2 rounded-md border border-hair-strong px-4 text-ui text-fg transition-colors hover:bg-white/[0.05]"
        >
          Open {place.name} in the Lab
          <ArrowUpRightIcon aria-hidden className="size-4 text-fg-dim" />
        </Link>
      </div>
    </div>
  );
}

function Verdict({ c }: { c: SpectralClassification }) {
  const byKey = new Map(c.probs.map((p) => [p.key, p.p]));
  const keys = [...Object.keys(CLASS_NAMES), ...c.probs.map((p) => p.key).filter((k) => !(k in CLASS_NAMES))];
  return (
    <section aria-labelledby="ai-spec-verdict" className="flex flex-col gap-3" data-class={c.label}>
      <h4 id="ai-spec-verdict" className="text-ui text-fg">
        What the classifier says
      </h4>
      <p className="text-meta text-pretty text-fg" data-testid="ai-spec-sentence">
        {classSentence(c)}
      </p>
      <ul className="flex flex-col gap-2" data-testid="ai-spec-probs" aria-label="Probability of each kind of object">
        {keys.map((k) => {
          const p = byKey.get(k) ?? 0;
          const top = k === c.label;
          const name = CLASS_NAMES[k] ?? k.replace(/_/g, " ");
          return (
            <li key={k} data-class={k} className="grid grid-cols-[minmax(0,9.5rem)_minmax(0,1fr)_3rem] items-center gap-3 text-meta">
              <span className={cn("truncate", top ? "text-fg" : "text-fg-dim")}>{name.charAt(0).toUpperCase() + name.slice(1)}</span>
              <span aria-hidden className="h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
                <span
                  className={cn("block h-full origin-left rounded-full", top ? "bg-accent" : "bg-fg-faint")}
                  style={{ transform: `scaleX(${Math.max(p, 0.004)})` }}
                />
              </span>
              <span className="readout text-right text-fg">{share(p)}</span>
            </li>
          );
        })}
      </ul>
      {c.anomaly?.unusual && (
        <p className="border-l border-hair-strong pl-3 text-micro text-pretty text-fg-dim" data-testid="ai-spec-unusual">
          Unusual spectrum: fewer than 1 in 100 ordinary spectra differ this much from what the network learned (p ={" "}
          <span className="readout">{c.anomaly.pValue < 0.001 ? "under 0.001" : c.anomaly.pValue.toFixed(c.anomaly.pValue < 0.01 ? 3 : 2)}</span>
          ). It may be a rare kind of object, or a problem with the measurement.
        </p>
      )}
      {c.caveats.length > 0 && (
        <ul className="flex flex-col gap-1.5" data-testid="ai-spec-caveats" aria-label="Caveats from the classifier">
          {c.caveats.map((note) => (
            <li key={note} className="text-micro text-pretty text-fg-faint">
              {note}
            </li>
          ))}
        </ul>
      )}
      {c.channelsUsed !== null && (
        <p className="text-micro text-fg-faint">
          It used <span className="readout">{c.channelsUsed}</span> channels of the spectrum.
        </p>
      )}
    </section>
  );
}
