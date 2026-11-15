"use client";
// What kind of object a SPHEREx quick-look spectrum looks like, as the backend's spectral classifier
// (specclass-v1) reads it: one plain sentence, the three most likely classes as small bars, and a note
// when the spectrum is unusual. Shared by the Sky star panel and the Lab's Spectrum tab.

import { Term } from "@/components/ui/term";
import { CLASS_NAMES, type SpectralClassification } from "@/lib/spectral-class";
import { cn } from "@/lib/utils";

/** A probability as a whole percentage, never rounded up to a certain 100% or down to an impossible 0%. */
function percent(p: number): string {
  if (p >= 0.995) return ">99%";
  if (p < 0.005) return "<1%";
  return `${Math.round(p * 100)}%`;
}

function capitalise(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function ClassName({ name, label }: { name: string; label: string }) {
  if (label === "brown_dwarf") return <Term k="brownDwarf">{name}</Term>;
  return <>{name}</>;
}

function pValueText(p: number): string {
  if (p < 0.001) return "under 0.001";
  return p.toFixed(p < 0.01 ? 3 : 2);
}

/** How the network's answer compares with what the catalogues already say about a known object. */
function CatalogueNote({ c, catalogue, testId }: { c: SpectralClassification; catalogue: { name: string; label: string }; testId: string }) {
  const listed = CLASS_NAMES[catalogue.label] ?? catalogue.label;
  const agrees = c.label === catalogue.label;
  return (
    <p className="text-micro text-pretty text-fg-dim" data-testid={`${testId}-catalogue`} data-agrees={agrees}>
      {agrees
        ? `This matches the catalogues, which list ${catalogue.name} as a ${listed}.`
        : `Catalogues list ${catalogue.name} as a ${listed}, so the network is wrong here.${
            catalogue.label === "brown_dwarf" ? " It learned from only a few dozen brown dwarf spectra." : ""
          }`}
    </p>
  );
}

export function SpectralClassView({
  c,
  className,
  testId = "spectral-class",
  catalogue = null,
}: {
  c: SpectralClassification;
  className?: string;
  testId?: string;
  /** What the catalogues say the object is (a class key), for the challenge targets. */
  catalogue?: { name: string; label: string } | null;
}) {
  if (c.status !== "ok" || !c.label || !c.labelText) {
    return (
      <p className={cn("text-micro text-pretty text-fg-faint", className)} data-testid={`${testId}-none`}>
        No class from this spectrum. {c.reason}
      </p>
    );
  }
  const top = c.probs.slice(0, 3);
  const confidence = c.confidence ?? top[0]?.p ?? 0;
  const pct = confidence >= 0.995 ? "over 99%" : percent(confidence);
  return (
    <div className={cn("flex flex-col gap-2.5", className)} data-testid={testId} data-class={c.label}>
      <p className="text-meta text-pretty text-fg">
        From its SPHEREx spectrum, this looks most like a{" "}
        <ClassName name={c.labelText} label={c.label} /> (<span className="readout">{pct}</span> confidence).
      </p>
      <ul className="flex flex-col gap-1.5" aria-label="The three most likely kinds of object">
        {top.map((p, i) => (
          <li key={p.key} className="grid grid-cols-[minmax(0,9rem)_1fr_2.5rem] items-center gap-2.5 text-micro">
            <span className={cn("truncate", i === 0 ? "text-fg" : "text-fg-dim")}>{capitalise(p.name)}</span>
            <span className="h-1.5 overflow-hidden rounded-[2px] bg-hair" aria-hidden>
              <span
                className="block h-full rounded-[2px]"
                style={{ width: `${Math.max(1.5, p.p * 100)}%`, background: i === 0 ? "var(--accent)" : "var(--fg-faint)" }}
              />
            </span>
            <span className="readout text-right text-fg-dim">{percent(p.p)}</span>
          </li>
        ))}
      </ul>
      {c.anomaly?.unusual ? (
        <p className="border-l border-hair-strong pl-2.5 text-micro text-pretty text-fg-dim" data-testid={`${testId}-unusual`}>
          Unusual spectrum: fewer than 1 in 100 ordinary spectra differ this much from what the network learned (p ={" "}
          <span className="readout">{pValueText(c.anomaly.pValue)}</span>). It may be a rare kind of object, or a problem
          with the measurement, such as a neighbour blended into the 12.9″ pixels.
        </p>
      ) : null}
      {catalogue ? <CatalogueNote c={c} catalogue={catalogue} testId={testId} /> : null}
      {c.caveats.map((note) => (
        <p key={note} className="text-micro text-pretty text-fg-faint">
          {note}
        </p>
      ))}
      <p className="text-micro text-pretty text-fg-faint">
        Read by a small neural network trained on SPHEREx spectra of stars, galaxies and quasars that SIMBAD and Gaia
        have already classified. Close neighbours and very bright stars can mislead it.
      </p>
    </div>
  );
}
