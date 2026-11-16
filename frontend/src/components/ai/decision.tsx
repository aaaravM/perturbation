"use client";
// How the mover network decides: its layers, from the 4 x 21 x 21 stamp to four calibrated
// probabilities (architecture in backend/src/pxh/ml/realbogus.py), and what it learned from and how
// well it does, read from the "model" block of /discoveries/candidates.json and formatted as How it
// works does. The statistics of the false-alarm check are in their own closed fold (statistics.tsx).

import type { ReactNode } from "react";
import { pct } from "@/components/how-it-works/model-results";
import { RISE, delay } from "@/components/how-it-works/motion-classes";
import { Reveal } from "@/components/how-it-works/reveal";
import { FactTable, ForScientists, RepoLink } from "@/components/how-it-works/shell";
import { cn } from "@/lib/utils";
import { Pending, useCandidates } from "./results";

interface Stage {
  title: string;
  dims: string;
  text: ReactNode;
  glyph: ReactNode;
}

/** A stack of feature maps: `n` squares of side `s`, each offset by `d`, ending at (x, y). */
function Stack({ n, s, d, x, y, front }: { n: number; s: number; d: number; x: number; y: number; front?: ReactNode }) {
  return (
    <g>
      {Array.from({ length: n }, (_, i) => {
        const k = n - 1 - i;
        return (
          <rect
            key={i}
            x={x - k * d}
            y={y - s + k * d - (n - 1) * d}
            width={s}
            height={s}
            rx={1.5}
            className="fill-ink-2 stroke-current"
            strokeWidth={1.1}
          />
        );
      })}
      {front}
    </g>
  );
}

const Arrow = ({ x1, x2, y }: { x1: number; x2: number; y: number }) => (
  <g className="stroke-fg-faint" strokeWidth={1.1} fill="none">
    <line x1={x1} x2={x2} y1={y} y2={y} />
    <path d={`M${x2 - 3} ${y - 3} L${x2} ${y} L${x2 - 3} ${y + 3}`} />
  </g>
);

const NETWORK: Stage[] = [
  {
    title: "The stamp",
    dims: "4 × 21 × 21",
    text: "Four layers of 21 × 21 pixels: the earlier and later co-adds, their S/N difference, and a mask of bad pixels.",
    glyph: (
      <Stack
        n={4}
        s={30}
        d={4}
        x={46}
        y={44}
        front={
          <>
            <circle cx={56} cy={13} r={3.2} className="fill-ink stroke-current" strokeWidth={1.1} />
            <circle cx={64} cy={21} r={3.2} className="fill-fg" />
          </>
        }
      />
    ),
  },
  {
    title: "Two convolutions, then pooling",
    dims: "16 × 21 × 21 → 16 × 10 × 10",
    text: "16 small 3 × 3 filters slide over the stamp, twice. Pooling keeps the strongest value in each 2 × 2 block.",
    glyph: (
      <>
        <Stack n={5} s={26} d={3} x={26} y={44} />
        <Arrow x1={55} x2={64} y={26} />
        <Stack n={5} s={14} d={3} x={78} y={38} />
      </>
    ),
  },
  {
    title: "Two more, then pooling",
    dims: "32 × 10 × 10 → 32 × 5 × 5",
    text: "32 filters, twice, on the smaller maps, which pooling halves again.",
    glyph: (
      <>
        <Stack n={6} s={14} d={3} x={30} y={42} />
        <Arrow x1={47} x2={56} y={26} />
        <Stack n={6} s={9} d={3} x={76} y={38} />
      </>
    ),
  },
  {
    title: "One more convolution",
    dims: "64 × 5 × 5",
    text: "64 filters. Each of its 64 maps is now a 5 × 5 summary of the stamp.",
    glyph: <Stack n={7} s={9} d={3} x={56} y={40} />,
  },
  {
    title: "Summary and two dense layers",
    dims: "128 → 64 → 4",
    text: "The mean and the largest value of each map make 128 numbers; two dense layers turn them into four.",
    glyph: (
      <>
        {[
          { x: 20, n: 9 },
          { x: 46, n: 6 },
          { x: 72, n: 4 },
        ].map((col) =>
          Array.from({ length: col.n }, (_, i) => (
            <circle key={`${col.x}-${i}`} cx={col.x} cy={24 + (i - (col.n - 1) / 2) * 4.6} r={1.6} className="fill-current" />
          )),
        )}
        <Arrow x1={26} x2={38} y={24} />
        <Arrow x1={52} x2={64} y={24} />
      </>
    ),
  },
  {
    title: "Calibrated probabilities",
    dims: "softmax(z ÷ 1.30)",
    text: "The four numbers are divided by a temperature fitted on the validation fields, then turned into four probabilities that add up to 100%.",
    glyph: (
      <>
        {[38, 14, 7, 4].map((h, i) => (
          <rect key={i} x={20 + i * 15} y={44 - h} width={10} height={h} rx={1} className={i === 0 ? "fill-accent" : "fill-current"} />
        ))}
      </>
    ),
  },
];

function Stages({ stages, label, cols }: { stages: Stage[]; label: string; cols: string }) {
  return (
    <Reveal as="ol" aria-label={label} className={cn("grid grid-cols-1 gap-3", cols)}>
      {stages.map((s, i) => (
        <li
          key={s.title}
          className={cn("flex gap-4 rounded-[14px] border border-hair bg-ink-2 p-4 sm:flex-col sm:gap-3", RISE)}
          style={delay(i, 90)}
        >
          <svg aria-hidden viewBox="0 0 96 48" className="h-12 w-24 shrink-0 text-fg-dim">
            {s.glyph}
          </svg>
          <div className="flex min-w-0 flex-col gap-1">
            <p className="text-ui text-fg">
              <span className="readout mr-2 text-fg-faint">{i + 1}</span>
              {s.title}
            </p>
            <p className="readout text-micro text-fg-faint">{s.dims}</p>
            <p className="text-meta text-pretty text-fg-dim">{s.text}</p>
          </div>
        </li>
      ))}
    </Reveal>
  );
}

/** The network's layers, as a numbered row of drawings. */
export function DecisionDiagram() {
  return (
    <figure className="flex flex-col gap-6" data-testid="ai-diagram">
      <div className="flex flex-col gap-3">
        <p className="text-ui text-fg">The network</p>
        <Stages stages={NETWORK} label="The network's layers, from stamp to probabilities" cols="sm:grid-cols-2 xl:grid-cols-3" />
      </div>
      <figcaption className="max-w-2xl text-meta text-pretty text-fg-faint">
        Every convolution uses 3 × 3 filters followed by a ReLU, which keeps positive values and sets the rest to zero. The
        trained weights, 43,812 numbers, run with NumPy inside the site’s API. Source:{" "}
        <RepoLink path="backend/src/pxh/ml/realbogus.py">realbogus.py</RepoLink>.
      </figcaption>
    </figure>
  );
}

function Stat({ value, children, i }: { value: string | null; children: ReactNode; i: number }) {
  return (
    <div className={cn("flex flex-col gap-1.5 border-t border-hair pt-3", RISE)} style={delay(i, 70)}>
      <span className={cn(value ? "readout text-title text-fg" : "text-lead text-fg-faint")}>{value ?? "Being measured"}</span>
      <span className="text-meta text-pretty text-fg-dim">{children}</span>
    </div>
  );
}

/** What the mover network learned from and how well it does, from candidates.json's "model" block. */
export function MoverFacts() {
  const load = useCandidates();
  if (load.state !== "ok") return <Pending load={load} what="mover network’s results" />;
  const { model } = load.data;
  const m = model.metrics;
  return (
    <div className="flex flex-col gap-6" data-testid="ai-mover-facts">
      {model.trained_on && (
        <div className="measure flex flex-col gap-1.5">
          <p className="text-ui text-fg">What it learned from</p>
          <p className="text-body text-pretty text-fg-dim" data-testid="ai-trained-on">
            {model.trained_on}
          </p>
        </div>
      )}
      <Reveal className="grid grid-cols-1 gap-x-8 gap-y-6 sm:grid-cols-2 xl:grid-cols-4">
        <Stat i={0} value={pct(m.test_accuracy)}>
          of stamps from the test fields get the right one of the four classes
        </Stat>
        <Stat i={1} value={pct(m.mover_completeness_shift_ge_1px_snr10)}>
          of clear movers are reported when they shift at least one pixel between visits
        </Stat>
        <Stat i={2} value={pct(m.mover_completeness_snr10)}>
          of clear movers are reported over all the speeds tested, slow ones included
        </Stat>
        <Stat i={3} value={pct(m.variable_completeness_snr10)}>
          of clear brightness changes are reported
        </Stat>
      </Reveal>
      <p className="measure text-meta text-pretty text-fg-dim">
        “Clear” means the source stands at least 10 times above the noise in each visit, and “reported” means it passes the
        false-alarm check. These are fake sources planted in the
        real images of test fields the network never trained on, so the right answer is known.
      </p>
      <ForScientists>
        <FactTable
          label="The mover network"
          rows={[
            ["Model", model.name ?? "Being measured"],
            [
              "Layers",
              "conv 3×3 4→16, 16→16, max-pool 2; 16→32, 32→32, max-pool 2; 32→64 (ReLU, padding 1); global mean and max pool (128); dense 64 (ReLU; dropout 0.3 in training); dense 4",
            ],
            [
              "Input",
              "Co-adds: asinh((I − stamp median) × √weight ÷ 5), 0 where invalid. Difference: asinh(S/N ÷ 5), S/N rescaled by the image’s robust scatter. Mask: 1 where either visit is invalid or saturated, or off the grid.",
            ],
            ["Calibration", "Temperature scaling on the validation stamps: T = 1.30; expected calibration error 0.028 before, 0.013 after"],
            ["Training", "PyTorch on CPU: 30 epochs (best 25), class-balanced batches of 256, the 8 rotations and reflections of each stamp"],
          ]}
        />
        <p className="text-meta text-fg-faint">
          The model block is read from /discoveries/candidates.json as this page loads; the rest is from the weights file. Source:{" "}
          <RepoLink path="docs/validation/movers.md">mover validation report</RepoLink>.
        </p>
      </ForScientists>
    </div>
  );
}
