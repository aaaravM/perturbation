import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowRightIcon } from "lucide-react";
import { CopyCitation, SkyBackdrop } from "@/components/about/about-parts";
import { RISE } from "@/components/how-it-works/motion-classes";
import { Reveal } from "@/components/how-it-works/reveal";
import { LiquidGlass } from "@/components/ui/liquid-glass";
import { REPO_URL } from "@/lib/site";

export const metadata: Metadata = {
  title: "About",
  description:
    "This site in plain words: the challenge it answers, team Ninth Vanguard, data credits and licences, and how to cite the data.",
};

const SITE_URL = "https://perturbation.earth";
const IRSA_SPHEREX = "https://irsa.ipac.caltech.edu/Missions/spherex.html";
const GAIA_CREDITS = "https://gea.esac.esa.int/archive/documentation/credits.html";

const SITE_CITATION = `Team Ninth Vanguard (2026). Perturbation: a public explorer of the changing infrared sky seen by SPHEREx. ${SITE_URL} (source code: ${REPO_URL}).`;

const LINK =
  "text-fg underline decoration-hair-strong underline-offset-4 transition-colors hover:decoration-accent";

const DATA_CREDITS: { what: string; credit: ReactNode; terms: string }[] = [
  {
    what: "SPHEREx images and spectral cube",
    credit: (
      <>
        NASA/JPL-Caltech, served by the NASA/IPAC Infrared Science Archive (IRSA): Data Release 1 images{" "}
        <span className="readout">doi:10.26131/IRSA678</span>, the DR1 spectral cube{" "}
        <span className="readout">doi:10.26131/IRSA679</span>, and Quick Release 3
      </>
    ),
    terms: "NASA public data",
  },
  { what: "AllWISE images (Then vs Now)", credit: "NASA/JPL-Caltech/UCLA, via IRSA", terms: "NASA public data" },
  { what: "Gaia DR3 positions, motions and distances", credit: "ESA/Gaia/DPAC", terms: "Public; credit ESA/Gaia/DPAC" },
  { what: "CatWISE2020 neighbours and survey matches", credit: "CatWISE team, via IRSA", terms: "NASA public data" },
  { what: "SIMBAD object types", credit: "CDS, Strasbourg, via its CfA mirror", terms: "Public; credit CDS" },
  {
    what: "Stars on the Sky globe",
    credit: "ESA Hipparcos: the Hipparcos Catalogue (ESA 1997) and its new reduction (van Leeuwen 2007), via VizieR, CDS",
    terms: "Public; credit ESA and CDS",
  },
  {
    what: "Star names and constellation figures",
    credit: "d3-celestial by Olaf Frohn, collecting the IAU star names",
    terms: "BSD-3-Clause",
  },
  { what: "Constellation boundaries", credit: "IAU boundaries (Roman 1987), via astropy", terms: "BSD-3-Clause (astropy)" },
  { what: "WISE 0855−0714 motion", credit: "Kirkpatrick et al. 2021, ApJS 253, 7", terms: "Published paper" },
  {
    what: "Pluto’s predicted positions (Planet X page)",
    credit: "JPL Horizons, NASA/JPL-Caltech Solar System Dynamics",
    terms: "Public; credit NASA/JPL",
  },
  { what: "Lab sky viewer", credit: "Aladin Lite, CDS, Strasbourg", terms: "LGPL-3.0" },
];

const SOFTWARE_CREDITS: { what: string; terms: string }[] = [
  { what: "shadcn/ui and Radix UI", terms: "MIT" },
  { what: "Cult UI text animation and Watermelon UI tabs", terms: "MIT" },
  { what: "Skiper UI, free tier", terms: "Free with attribution" },
  { what: "IBM Plex Sans and IBM Plex Mono", terms: "SIL Open Font License 1.1" },
  { what: "three.js, React Three Fiber, drei, Motion, Lenis, Recharts and the other libraries", terms: "MIT, ISC or Apache-2.0" },
  { what: "Perturbation’s own code", terms: "Apache-2.0" },
];

function AboutSection({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <Reveal
      as="section"
      id={id}
      aria-labelledby={`${id}-title`}
      className="grid scroll-mt-24 grid-cols-1 gap-5 border-t border-hair py-12 sm:py-14 md:grid-cols-[13rem_minmax(0,1fr)] md:gap-10 lg:grid-cols-[17rem_minmax(0,1fr)]"
    >
      <h2 id={`${id}-title`} className={`text-heading text-balance text-fg ${RISE}`}>
        {title}
      </h2>
      <div className={`flex min-w-0 max-w-3xl flex-col gap-5 text-body text-pretty text-fg-dim ${RISE}`} style={{ transitionDelay: "80ms" }}>
        {children}
      </div>
    </Reveal>
  );
}

export default function AboutPage() {
  return (
    <>
      <section className="relative -mt-(--nav-h) overflow-hidden">
        <SkyBackdrop src="/textures/spherex-sky-rgb-2k.webp" />
        <div className="relative mx-auto w-full max-w-7xl px-4 pt-[calc(var(--nav-h)+6rem)] pb-14 sm:px-6 sm:pt-[calc(var(--nav-h)+10rem)] sm:pb-20">
          <LiquidGlass as="div" variant="regular" radius={24} className="max-w-xl p-6 sm:p-8">
            <h1 className="text-title text-balance text-fg">About Perturbation</h1>
            <p className="mt-4 text-lead text-pretty text-(--fg-glass-dim)">
              A free website for exploring the sky as NASA’s SPHEREx telescope sees it, and for watching it change.
            </p>
          </LiquidGlass>
          <p className="mt-5 text-micro text-fg-dim">Behind: the SPHEREx all-sky map from Data Release 1 (Caltech/IPAC/NASA, IRSA).</p>
        </div>
      </section>

      <div className="mx-auto w-full max-w-7xl px-4 pb-28 sm:px-6">
        <AboutSection id="project" title="The project in plain words">
          <p>
            SPHEREx photographs the whole sky in infrared light, the colours just past red that our eyes cannot see, and comes
            back to every part of it about every six months. Flipping between its visits shows stars that move and stars that
            brighten or fade. This site makes that open to anyone.
          </p>
          <p>
            There are two ways in. The Sky is a globe of the whole sky to spin and explore. The Lab is a workbench for any patch
            of sky, with every visit, the differences between them, spectra and the measurements behind them. An automatic
            search looks for moving and changing stars, and the AI page shows what it has found.
          </p>
          <p>Every number on the site comes from real data, and says where it comes from.</p>
          <ul className="flex flex-col border-t border-hair">
            {[
              { href: "/sky", label: "Explore the Sky globe" },
              { href: "/explore", label: "Open the Lab" },
              { href: "/ai#finds", label: "See what the search has found" },
              { href: "/how-it-works", label: "Read how it works" },
            ].map((l) => (
              <li key={l.href} className="border-b border-hair">
                <Link
                  href={l.href}
                  className="group flex min-h-11 items-center justify-between gap-4 text-ui text-fg transition-colors hover:text-accent-strong"
                >
                  {l.label}
                  <ArrowRightIcon
                    aria-hidden
                    className="size-4 text-fg-faint transition-transform duration-300 ease-out-expo group-hover:translate-x-1 group-hover:text-accent-strong reduced:transition-none"
                  />
                </Link>
              </li>
            ))}
          </ul>
        </AboutSection>

        <AboutSection id="demo" title="The 30-second demo">
          <p>
            Team Ninth Vanguard shows the site in half a minute: the challenge, the Lab blinking Barnard’s Star, what the AI
            sees, the 3D star map, and the find checker that could come next.
          </p>
          <video
            controls
            preload="metadata"
            playsInline
            poster="/demo-poster.webp"
            aria-label="The 30-second Perturbation demo, with voice-over"
            className="aspect-video w-full rounded-lg border border-hair bg-ink-2"
          >
            <source src="/demo.mp4" type="video/mp4" />
            <track kind="captions" src="/demo.vtt" srcLang="en" label="English" />
          </video>
        </AboutSection>

        <AboutSection id="challenge" title="The challenge">
          <p>
            Perturbation is an entry to the NASA Space Apps Challenge 2026, for the challenge “Planet X and SPHEREx”. It asks
            for a public tool to explore SPHEREx images and see the sky change over time: blinking between visits, subtracting
            them, reading spectra, and testing it all on five known stars that move or vary.
          </p>
          <p>
            About a century ago, astronomers hunted for an unseen planet beyond Neptune, known as Planet X. Clyde Tombaugh found
            Pluto in 1930 by blinking two photographs of the same stars, the idea this site uses with SPHEREx’s infrared maps.
            No new planet is claimed here: the site shows what the data can and cannot reveal.
          </p>
        </AboutSection>

        <AboutSection id="team" title="The team">
          <p>
            Perturbation is made by team Ninth Vanguard. All of the work, from the
            first checks of the SPHEREx data to this page, is in the{" "}
            <a href={REPO_URL} className={LINK}>
              public repository
            </a>
            .
          </p>
        </AboutSection>

        <AboutSection id="credits" title="Data credits and licences">
          <p>The data and software this site is built on, and the terms they come with.</p>
          <CreditTable
            caption="Data"
            rows={DATA_CREDITS.map((d) => [d.what, d.credit, d.terms])}
            head={["Data", "Credit", "Terms"]}
          />
          <CreditTable
            caption="Software and type"
            rows={SOFTWARE_CREDITS.map((s) => [s.what, s.terms])}
            head={["Software and type", "Licence"]}
          />
          <p className="text-meta text-fg-faint">
            The full list, with versions and sources, is in{" "}
            <a href={`${REPO_URL}/blob/main/frontend/CREDITS.md`} className={LINK}>
              frontend/CREDITS.md
            </a>
            .
          </p>
        </AboutSection>

        <AboutSection id="cite" title="How to cite the data">
          <p>If you use what you find here, please credit the missions and catalogues behind it.</p>
          <ul className="flex flex-col gap-3 text-ui">
            <CiteItem name="SPHEREx">
              SPHEREx Data Release 1 images, <span className="readout">doi:10.26131/IRSA678</span>; the DR1 spectral cube,{" "}
              <span className="readout">doi:10.26131/IRSA679</span>; and Quick Release 3, all from the NASA/IPAC Infrared Science
              Archive. The{" "}
              <a href={IRSA_SPHEREX} className={LINK}>
                SPHEREx pages at IRSA
              </a>{" "}
              give the mission’s preferred acknowledgement.
            </CiteItem>
            <CiteItem name="Gaia DR3">
              Gaia Collaboration, Vallenari et al. 2023, A&amp;A 674, A1; see{" "}
              <a href={GAIA_CREDITS} className={LINK}>
                ESA’s Gaia credits
              </a>
              .
            </CiteItem>
            <CiteItem name="Hipparcos">van Leeuwen 2007, A&amp;A 474, 653.</CiteItem>
            <CiteItem name="WISE 0855−0714 motion">Kirkpatrick et al. 2021, ApJS 253, 7.</CiteItem>
          </ul>
          <div className="flex flex-col gap-4 rounded-[18px] border border-hair bg-ink-2 p-5">
            <p className="text-meta text-fg-faint">To cite this site</p>
            <p className="text-ui text-pretty break-words text-fg">{SITE_CITATION}</p>
            <CopyCitation text={SITE_CITATION} />
          </div>
        </AboutSection>

        <AboutSection id="contact" title="Source and contact">
          <p>
            The code is open source under the Apache-2.0 licence, at{" "}
            <a href={REPO_URL} className={LINK}>
              github.com/aaaravM/perturbation
            </a>
            .
          </p>
          <p>
            Questions, corrections or ideas are welcome:{" "}
            <a href={`${REPO_URL}/issues`} className={LINK}>
              open an issue on GitHub
            </a>
            .
          </p>
        </AboutSection>
      </div>
    </>
  );
}

function CiteItem({ name, children }: { name: string; children: ReactNode }) {
  return (
    <li className="grid grid-cols-1 gap-1 border-b border-hair pb-3 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-4">
      <span className="text-fg">{name}</span>
      <span className="text-pretty text-fg-dim">{children}</span>
    </li>
  );
}

function CreditTable({ caption, head, rows }: { caption: string; head: string[]; rows: ReactNode[][] }) {
  return (
    <div className="-mx-1 overflow-x-auto px-1">
      <table className="w-full border-collapse text-left text-meta">
        <caption className="pb-1 text-left text-meta text-fg-faint sm:sr-only">{caption}</caption>
        <thead className="max-sm:sr-only">
          <tr className="border-b border-hair-strong text-fg-faint">
            {head.map((h) => (
              <th key={h} scope="col" className="py-2 pr-5 font-normal last:pr-0">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-hair max-sm:flex max-sm:flex-col max-sm:gap-0.5 max-sm:py-2.5">
              {r.map((c, j) =>
                j === 0 ? (
                  <th key={j} scope="row" className="py-2.5 pr-5 align-top text-ui font-normal text-fg max-sm:py-0">
                    {c}
                  </th>
                ) : (
                  <td
                    key={j}
                    className={`py-2.5 pr-5 align-top last:pr-0 max-sm:py-0 ${j === r.length - 1 ? "text-fg-faint" : "text-fg-dim"}`}
                  >
                    {c}
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
