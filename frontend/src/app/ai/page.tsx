import type { Metadata } from "next";
import type { ReactNode } from "react";
import { DecisionDiagram, MoverFacts } from "@/components/ai/decision";
import { Finds } from "@/components/ai/finds";
import { Limits } from "@/components/ai/limits";
import { NetworkExamples } from "@/components/ai/network-examples";
import { SpectralCard } from "@/components/ai/spectral-card";
import { SpectralTry } from "@/components/ai/spectral-try";
import { Statistics } from "@/components/ai/statistics";
import { IndexedArticle, InlineIndex } from "@/components/how-it-works/section-index";
import { Prose } from "@/components/how-it-works/shell";
import { Term } from "@/components/ui/term";

export const metadata: Metadata = {
  title: "What the AI does",
  description:
    "What the site’s two small neural networks found in SPHEREx images and how they work: every find with its pictures and how sure the AI is, what the network sees, how it decides, a live spectral classifier to try, and their limits.",
};

const SECTIONS = [
  { id: "finds", label: "What it found" },
  { id: "sees", label: "What the network sees" },
  { id: "decides", label: "How it decides" },
  { id: "try", label: "Try the spectral classifier" },
  { id: "limits", label: "What it cannot do" },
] as const;

const LINK = "text-fg underline decoration-hair-strong underline-offset-4 transition-colors hover:decoration-accent";

const PARTS = [
  {
    href: "#finds",
    title: "What it found",
    text: "Every change the AI kept from the survey, with its pictures, how sure the AI is and whether a catalogue already knows it.",
  },
  {
    href: "#sees",
    title: "The mover finder",
    text: "A small convolutional network looks at each spot that changed between two visits and calls it a mover, a brightness change, an imaging artifact or nothing.",
  },
  {
    href: "#try",
    title: "The spectral classifier",
    text: "A second network reads an object’s spectrum in SPHEREx’s 102 colours and names the closest of seven kinds, or declines when the data are too poor.",
  },
] as const;

export default function AiPage() {
  return (
    <div className="mx-auto w-full max-w-7xl px-4 pt-16 pb-28 sm:px-6 sm:pt-24">
      <header className="max-w-3xl">
        <h1 className="text-title text-balance text-fg sm:text-display">What the AI does</h1>
        <p className="mt-5 max-w-2xl text-lead text-pretty text-fg-dim">
          Two small <Term k="neuralNetwork">neural networks</Term>, trained on real SPHEREx images and spectra: one looks for
          anything that moved or changed brightness between visits, the other reads an object’s spectrum. This page shows what the
          first one found in the survey, and how both work. There is no chatbot or language model: the trained weights run with
          NumPy inside the site’s API, and every result here links back to the data it came from.
        </p>
      </header>

      <ul className="mt-12 grid max-w-5xl grid-cols-1 gap-x-10 gap-y-6 md:grid-cols-3" aria-label="The three parts">
        {PARTS.map((p) => (
          <li key={p.href} className="flex flex-col gap-1.5 border-t border-hair pt-4">
            <a href={p.href} className={`text-ui ${LINK} self-start`}>
              {p.title}
            </a>
            <p className="text-meta text-pretty text-fg-dim">{p.text}</p>
          </li>
        ))}
      </ul>

      <div className="max-w-3xl">
        <InlineIndex items={SECTIONS} />
      </div>

      <div className="mt-14 lg:mt-20">
        <IndexedArticle items={SECTIONS}>
          <Section id="finds" title="What it found">
            <Prose>
              <p>
                The search compared SPHEREx pictures of the same patches of sky taken months apart, flagged every spot that changed,
                and had the AI judge each one. These are the finds it kept. Each is a candidate: worth a closer look, not yet a
                discovery.
              </p>
            </Prose>
            <Finds />
          </Section>

          <Section id="sees" title="What the network sees">
            <Prose>
              <p>
                The mover finder subtracts an earlier picture of a patch of sky from a later one and looks for spots that changed.
                For each spot, the network gets a small stamp of pixels and says how much it looks like a mover, a change in
                brightness, an imaging artifact or nothing at all.
              </p>
            </Prose>
            <NetworkExamples />
          </Section>

          <Section id="decides" title="How it decides">
            <Prose>
              <p>
                The network is small: five layers of 3 × 3 filters and two dense layers, 43,812 numbers learned from examples. It
                does not have the last word. Its score is compared with the scores of ordinary spots, and a find is reported only
                if it passes the false-alarm check.
              </p>
            </Prose>
            <DecisionDiagram />
            <MoverFacts />
            <Statistics />
          </Section>

          <Section id="try" title="Try the spectral classifier">
            <Prose>
              <p>
                The second network reads a spectrum: how bright an object is in each of SPHEREx’s 102 colours, from 0.75 to 5
                micrometres. It says which of seven kinds of object the spectrum looks most like, and it declines when the data are
                too poor to say.
              </p>
              <p>
                Type a name or coordinates, or pick an example. The site’s API reads the spectrum from the SPHEREx archive and runs
                the network while you wait.
              </p>
            </Prose>
            <SpectralTry />
            <SpectralCard />
          </Section>

          <Section id="limits" title="What it cannot do">
            <Prose>
              <p>Both networks are small and learned from a limited set of examples. These are the limits we measured.</p>
            </Prose>
            <Limits />
          </Section>
        </IndexedArticle>
      </div>
    </div>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-24 border-t border-hair pt-12 sm:pt-14">
      <h2 id={`${id}-title`} className="text-heading text-balance text-fg">
        {title}
      </h2>
      <div className="mt-5 flex flex-col gap-8">{children}</div>
    </section>
  );
}
