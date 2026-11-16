// Two process diagrams: the automatic search (step 6) and where the data and code live (step 8).
// Each stage has a small inline-SVG drawing; the stages rise into view one after another.

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { RISE, delay } from "./motion-classes";
import { Reveal } from "./reveal";

interface Stage {
  title: string;
  text: ReactNode;
  glyph: ReactNode;
}

function StageList({ stages, label, cols }: { stages: Stage[]; label: string; cols: string }) {
  return (
    <Reveal as="ol" aria-label={label} className={cn("grid grid-cols-1 gap-3", cols)}>
      {stages.map((s, i) => (
        <li
          key={s.title}
          className={cn("relative flex gap-4 rounded-[14px] border border-hair bg-ink-2 p-4 sm:flex-col sm:gap-3", RISE)}
          style={delay(i, 110)}
        >
          <svg aria-hidden viewBox="0 0 48 32" className="h-8 w-12 shrink-0 text-fg-dim">
            {s.glyph}
          </svg>
          <div className="flex min-w-0 flex-col gap-1">
            <p className="text-ui text-fg">
              <span className="readout mr-2 text-fg-faint">{i + 1}</span>
              {s.title}
            </p>
            <p className="text-meta text-pretty text-fg-dim">{s.text}</p>
          </div>
        </li>
      ))}
    </Reveal>
  );
}

const SEARCH: Stage[] = [
  {
    title: "Subtract",
    text: "A later visit minus an earlier one, in units of the noise.",
    glyph: (
      <>
        <rect x="2" y="6" width="16" height="16" rx="2" className="fill-none stroke-current" strokeWidth="1.5" />
        <line x1="21" x2="27" y1="14" y2="14" className="stroke-current" strokeWidth="1.5" />
        <rect x="30" y="6" width="16" height="16" rx="2" className="fill-none stroke-current" strokeWidth="1.5" />
        <circle cx="10" cy="17" r="2.5" className="fill-current" />
        <circle cx="38" cy="11" r="2.5" className="fill-current" />
      </>
    ),
  },
  {
    title: "Find spots",
    text: "A dark and a bright spot together is a mover; a single spot is a change in brightness.",
    glyph: (
      <>
        <rect x="8" y="2" width="28" height="28" rx="3" className="fill-none stroke-current" strokeWidth="1.5" />
        <circle cx="22" cy="10" r="4" className="fill-fg" />
        <circle cx="22" cy="21" r="4" className="fill-ink stroke-current" strokeWidth="1.5" />
      </>
    ),
  },
  {
    title: "Score",
    text: "A small neural network rates each spot: mover, variable, artifact or nothing.",
    glyph: (
      <>
        <rect x="6" y="6" width="7" height="22" rx="1" className="fill-accent" />
        <rect x="16" y="16" width="7" height="12" rx="1" className="fill-current" />
        <rect x="26" y="22" width="7" height="6" rx="1" className="fill-current" />
        <rect x="36" y="25" width="7" height="3" rx="1" className="fill-current" />
      </>
    ),
  },
  {
    title: "Test against chance",
    text: "Each score is compared with scores of ordinary spots from other patches of sky.",
    glyph: (
      <>
        <path d="M2 28 C 10 28, 12 6, 20 6 S 30 26, 46 27" className="fill-none stroke-current" strokeWidth="1.5" />
        <line x1="34" x2="34" y1="2" y2="30" strokeDasharray="2 3" className="stroke-accent" strokeWidth="1.5" />
      </>
    ),
  },
  {
    title: "Report",
    text: "The AI page lists the finds and whether each passed this test.",
    glyph: (
      <>
        {[7, 15, 23].map((y, i) => (
          <g key={y}>
            <rect x="6" y={y - 2} width="4" height="4" rx="1" className={i === 0 ? "fill-accent" : "fill-current"} />
            <line x1="14" x2={i === 2 ? 30 : 42} y1={y} y2={y} className="stroke-current" strokeWidth="1.5" />
          </g>
        ))}
      </>
    ),
  },
];

export function SearchFlow() {
  return <StageList stages={SEARCH} label="How the automatic search works" cols="sm:grid-cols-2 xl:grid-cols-5" />;
}

const DATA: Stage[] = [
  {
    title: "The SPHEREx archive",
    text: "NASA/IPAC’s Infrared Science Archive (IRSA) serves every SPHEREx image, about 65 MB each.",
    glyph: (
      <>
        {[4, 12, 20].map((y) => (
          <rect key={y} x="10" y={y} width="28" height="6" rx="1.5" className="fill-none stroke-current" strokeWidth="1.5" />
        ))}
      </>
    ),
  },
  {
    title: "Only the bytes needed",
    text: "The backend reads just the pixels around a target: 0.5 to 0.8 MB per image.",
    glyph: (
      <>
        <rect x="4" y="4" width="24" height="24" rx="2" className="fill-none stroke-current" strokeWidth="1.5" />
        <rect x="12" y="12" width="8" height="8" className="fill-accent" />
        <line x1="31" x2="44" y1="16" y2="16" className="stroke-current" strokeWidth="1.5" />
        <path d="M40 12 L44 16 L40 20" className="fill-none stroke-current" strokeWidth="1.5" />
      </>
    ),
  },
  {
    title: "Stack, subtract, measure",
    text: "Python code stacks each visit, makes the differences, fits positions, brightness and spectra.",
    glyph: (
      <>
        <rect x="10" y="4" width="22" height="16" rx="2" className="fill-none stroke-current" strokeWidth="1.5" />
        <rect x="14" y="9" width="22" height="16" rx="2" className="fill-ink stroke-current" strokeWidth="1.5" />
        <rect x="18" y="14" width="22" height="16" rx="2" className="fill-ink stroke-current" strokeWidth="1.5" />
      </>
    ),
  },
  {
    title: "This website",
    text: "The Sky globe and the Lab ask the API, and the five challenge stars ship with the site.",
    glyph: (
      <>
        <rect x="4" y="4" width="40" height="24" rx="3" className="fill-none stroke-current" strokeWidth="1.5" />
        <circle cx="24" cy="16" r="7" className="fill-none stroke-accent" strokeWidth="1.5" />
      </>
    ),
  },
];

export function DataFlow() {
  return <StageList stages={DATA} label="Where the data comes from and where it goes" cols="sm:grid-cols-2 xl:grid-cols-4" />;
}
