import type { Metadata } from "next";
import Link from "next/link";
import { Term } from "@/components/ui/term";
import { BlinkFigure } from "@/components/how-it-works/blink-figure";
import { DataFlow, SearchFlow } from "@/components/how-it-works/flows";
import { DetectorDiagram, EpochTimeline, MotionPlot, SpectrumBarcode, SpectrumPlot } from "@/components/how-it-works/figures";
import { ModelResults } from "@/components/how-it-works/model-results";
import { IndexedArticle, InlineIndex } from "@/components/how-it-works/section-index";
import { FactTable, FigureCaption, ForScientists, HowSection, Prose, RepoLink } from "@/components/how-it-works/shell";
import { ValidationTable } from "@/components/how-it-works/validation-table";
import { DETECTOR_TABLE, VALIDATION_ROWS, loadHowData } from "@/lib/how-it-works";
import { REPO_URL } from "@/lib/site";

export const metadata: Metadata = {
  title: "How it works",
  description:
    "From SPHEREx exposures to a star you can watch move, in eight steps, with the measured results and the limits of the search.",
};

const STEPS = [
  { id: "sees", label: "What SPHEREx sees" },
  { id: "visits", label: "From exposures to visits" },
  { id: "blink", label: "Blink and difference" },
  { id: "measure", label: "Measuring motion and brightness" },
  { id: "spectra", label: "Spectra" },
  { id: "search", label: "The automatic search" },
  { id: "limits", label: "Limits and honesty" },
  { id: "data", label: "Data and code" },
] as const;

const API_URL = "https://planet-x-hunter-api.vercel.app";
const IRSA_SPHEREX = "https://irsa.ipac.caltech.edu/Missions/spherex.html";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const longDate = (iso: string) => {
  const d = new Date(`${iso}T00:00:00Z`);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};

export default async function HowItWorksPage() {
  const data = await loadHowData();
  const full = data.epochs.filter((e) => e.full).length;

  return (
    <div className="mx-auto w-full max-w-7xl px-4 pt-16 pb-28 sm:px-6 sm:pt-24">
      <header className="max-w-3xl">
        <h1 className="text-title text-balance text-fg sm:text-display">How it works</h1>
        <p className="mt-5 max-w-2xl text-lead text-pretty text-fg-dim">
          From the pictures SPHEREx takes to a star you can watch move, in eight steps. Every number here was measured on real
          SPHEREx data, and each step has a folded layer for scientists with the methods behind it.
        </p>
      </header>
      {data.quicklook && (
        <figure className="mt-12 sm:mt-16">
          <SpectrumBarcode wl={data.quicklook.wl} mjy={data.quicklook.mjy} />
          <figcaption className="mt-3 max-w-2xl text-meta text-pretty text-fg-faint">
            Epsilon Indi B, a pair of brown dwarfs, in SPHEREx’s 102 colours: six detectors of 17 strips each. Bar heights are
            its brightness in each, from the DR1 quick-look; the dips are water and methane (step 5).
          </figcaption>
        </figure>
      )}
      <div className="max-w-3xl">
        <InlineIndex items={STEPS} />
      </div>

      <div className="mt-14 lg:mt-20">
        <IndexedArticle items={STEPS}>
          <HowSection id="sees" n={1} title="What SPHEREx sees">
            <Prose>
              <p>
                SPHEREx is a NASA space telescope that maps the whole sky in infrared light: the colours just past red, which our
                eyes cannot see. Cool, faint objects such as brown dwarfs give off most of their light there.
              </p>
              <p>
                Its camera has six detectors. Each sits behind a filter whose colour changes from one edge to the other, so a
                single picture holds 17 strips of slightly different colour. As the telescope steps across the sky, a star
                passes through every strip, and together the six detectors measure 102 colours between 0.75 and 5 micrometres
                (millionths of a metre).
              </p>
              <p>
                Each pixel covers 6.15 <Term k="arcsecond">arcseconds</Term> of sky, about a three-hundredth of the width of the
                full Moon.
              </p>
            </Prose>
            <figure className="max-w-3xl">
              <DetectorDiagram detectors={DETECTOR_TABLE} />
              <FigureCaption source="wavelength ranges read from the SPHEREx image files (Phase 1 report, section 3).">
                The six detectors on a scale of wavelength, beside the light our eyes see. Each bar is split into the 17 strips
                its filter passes. D6, in orange, is the detector in the blink of step 3.
              </FigureCaption>
            </figure>
            <ForScientists>
              <FactTable
                head={["Detector", "Wavelength (µm)", "Resolving power λ/Δλ"]}
                rows={DETECTOR_TABLE.map((d) => [
                  d.key,
                  <span key="w" className="readout">
                    {d.lo.toFixed(3)}–{d.hi.toFixed(3)}
                  </span>,
                  <span key="r" className="readout">
                    {d.r}
                  </span>,
                ])}
              />
              <p>
                Level-2 images are 2040 × 2040 pixels of 6.15″. Each 113.58 s exposure images the same spot on a short- and a
                long-wavelength detector at once (D1 + D4, D2 + D5 or D3 + D6), and the telescope steps by one channel, 11.8′,
                between exposures. A pixel’s wavelength comes from the WCS-WAVE table of its file, interpolated between control
                points; it matches an independent calculation for 358 exposures to better than 0.0002 of a channel width. The
                102 channels exist as separate images only in the Level-3 spectral cube (DR1, 12.9″ pixels).
              </p>
              <p className="text-meta text-fg-faint">
                Source: <RepoLink path="docs/data-findings.md">Phase 1 data report</RepoLink>, sections 3 and 5.
              </p>
            </ForScientists>
          </HowSection>

          <HowSection id="visits" n={2} title="From exposures to visits">
            <Prose>
              <p>
                SPHEREx comes back to the same patch of sky about every six months. Each visit lasts from a day to a few weeks;
                astronomers call it an <Term k="epoch">epoch</Term>. During a visit the telescope takes dozens of pictures of the
                spot, most of them through a different strip of colour.
              </p>
              <p>
                For every visit and detector, those pictures are stacked into one cleaner image. The faint glow of dust between
                the planets is subtracted, damaged pixels are left out, and the rest are averaged, with the least noisy pictures
                counting most. One stacked image per visit is what blinks in the Lab.
              </p>
              {data.epochs.length > 0 && <p>These are Barnard’s Star’s real visits.</p>}
            </Prose>
            {data.epochs.length > 0 && (
              <figure className="max-w-4xl">
                <EpochTimeline epochs={data.epochs} />
                <FigureCaption source="the prepared Barnard’s Star bundle, SPHEREx DR1 and QR3.">
                  Barnard’s Star from {longDate(data.span.first)} to {longDate(data.span.last)}: {data.epochs.length} visits and{" "}
                  {data.span.exposures} exposures. In the {full} full visits, in orange, every detector saw the star at least 12
                  times. Bar heights show the number of exposures.
                </FigureCaption>
              </figure>
            )}
            <ForScientists>
              {data.renderNote && (
                <p>
                  <span className="text-fg">How each frame is made.</span> {data.renderNote}
                </p>
              )}
              {data.epochs.length > 0 && (
                <FactTable
                  head={["Visit", "Dates", "Survey", "Orientation", "Exposures, D1–D6"]}
                  rows={data.epochs.map((e) => [
                    e.label,
                    <span key="d" className="readout">
                      {e.start} to {e.end}
                    </span>,
                    e.survey,
                    <span key="o" className="readout">
                      {e.pa}°
                    </span>,
                    <span key="n" className="readout">
                      {e.perDetector.join(" / ")}
                    </span>,
                  ])}
                />
              )}
              <p>
                A visit is a window of continuous coverage; it is full when every detector that saw the target did so at least
                12 times. Year 1 (DR1) and Year 2 (QR3) split at MJD 61174.52, on 14 May 2026. The image orientation flips by 180°
                between surveys: field stars shift by 0.11–0.25″ between opposite orientations and by under 0.08″ between the
                same.
              </p>
              <p className="text-meta text-fg-faint">
                Source: <RepoLink path="docs/data-findings.md">Phase 1 data report</RepoLink>, section 5.
              </p>
            </ForScientists>
          </HowSection>

          <HowSection id="blink" n={3} title="Blink and difference">
            <Prose>
              <p>
                The oldest way to find things that move is to flip between two pictures of the same stars taken at different
                times. Distant stars hold still; anything nearby that moved jumps. Clyde Tombaugh found Pluto like this in 1930.
              </p>
              <p>
                Subtracting one picture from the other makes it plainer still. In a{" "}
                <Term k="difference">difference image</Term>, everything that did not change cancels to grey, and a star that
                moved leaves a dark spot where it was and a bright spot where it is now.
              </p>
            </Prose>
            {data.blink && <BlinkFigure data={data.blink} />}
            <Prose>
              <p>
                Barnard’s Star, 6 light-years away, moved 10.36 arcseconds north between these two visits, as Gaia predicts to
                within 0.4%.
              </p>
            </Prose>
            <ForScientists>
              <p>
                The difference is the latest full visit minus the first (August 2026 minus August 2025), divided by its noise, so
                grey is zero and the display runs from −{data.blink?.difference.limit ?? 50}σ (black) to +
                {data.blink?.difference.limit ?? 50}σ (white). In D6 the dipole reaches S/N +222 at the star’s new position.
              </p>
              <p>
                The star’s core overflows the detector in 357 of 358 exposures. SPHEREx fits the slope of each pixel’s ramp of
                reads on board, so an overflowed pixel keeps a valid slope from its first reads: the stacks keep those pixels,
                with their variance, and flag them.
              </p>
              <p className="text-meta text-fg-faint">
                Source: <RepoLink path="docs/data-findings.md">Phase 1 data report</RepoLink>, sections 1 and 6.1.
              </p>
            </ForScientists>
          </HowSection>

          <HowSection id="measure" n={4} title="Measuring motion and brightness">
            <Prose>
              <p>
                To measure how far a star moved, the exact shape a star makes on the detector is fitted to every single
                exposure. That pins its position down to a small fraction of a pixel. A straight line through the positions,
                after removing the small yearly wobble caused by Earth’s orbit, gives its{" "}
                <Term k="properMotion">proper motion</Term>: how fast it drifts across the sky.
              </p>
              <p>
                The same fit measures how much light the star sent, so its brightness can be compared between visits at the
                same colour. RW Aurigae, a young star, faded by 0.86 <Term k="magnitude">magnitudes</Term> in a year at 3.8 to
                4.4 micrometres, to less than half its brightness.
              </p>
            </Prose>
            {data.track && (
              <figure className="max-w-4xl">
                <MotionPlot measured={data.track.measured} predicted={data.track.predicted} epochs={data.epochs} />
                <FigureCaption source="the prepared Barnard’s Star bundle (its motion fit and Gaia DR3).">
                  Barnard’s Star, in arcseconds north of where it started, at each visit. SPHEREx measures{" "}
                  {data.track.fit.speed.toFixed(2)} ± {data.track.fit.err.toFixed(2)}″ a year; {data.track.catalog.source}{" "}
                  predicts {data.track.catalog.speed.toFixed(2)}″ a year.
                </FigureCaption>
              </figure>
            )}
            <Prose>
              <p>
                Then the answers are checked against the best catalogues. The challenge named five test stars, and the pass
                marks were written down before the measurements ran. Not everything passed: a failure is in the table, and
                the other limits are in step 7.
              </p>
            </Prose>
            <figure>
              <ValidationTable rows={VALIDATION_ROWS} />
              <FigureCaption
                source={
                  <>
                    <RepoLink path="docs/data-findings.md">Phase 1 data report</RepoLink>, section 6; each star’s numbers are in
                    docs/phase1/&lt;star&gt;/summary.json.
                  </>
                }
              >
                The five test stars: what SPHEREx measured here, what the catalogues say, and how well they agree.
              </FigureCaption>
            </figure>
            <ForScientists>
              <p>
                Positions come from effective-PSF fits to each exposure on its original pixels (for Barnard’s Star D5 and D6,
                S/N ≥ 10, with a 100 mas floor), then a sigma-clipped linear fit with parallax removed.
              </p>
              <p>
                Barnard’s Star’s first visit (August to September 2025) sits 0.7 to 2.7″ east of the prediction in every
                detector, while field stars in the same stacks agree to 0.08″, so the bias belongs to the saturated star. We do
                not know its cause. Fitting visit means instead gives 10.39 ± 0.28″ a year toward 354.5°.
              </p>
              <p>
                RW Aurigae’s companion lies 1.52″ away at position angle 74°, unresolved in 6″ pixels, and the fitted “motion”
                points to 78°: likely, not proven. R Draconis is saturated in all 842 exposures; only a ring 8 to 12 pixels from
                its centre gives a clean light curve (839 exposures, 19σ).
              </p>
              <p>
                Photometry of saturated stars changes by 0.2 to 0.6 magnitudes between visits even for the steady Barnard’s
                Star, so only larger changes count.
              </p>
              <p className="text-meta text-fg-faint">
                Source: <RepoLink path="docs/data-findings.md">Phase 1 data report</RepoLink>, sections 6.1 to 6.6.
              </p>
            </ForScientists>
          </HowSection>

          <HowSection id="spectra" n={5} title="Spectra">
            <Prose>
              <p>
                Because each exposure sees a star through a different strip of colour, the hundreds of exposures from a year of
                visits add up to a spectrum: how bright the star is at each colour.
              </p>
              <p>
                A spectrum tells you what something is made of. Epsilon Indi B is a pair of brown dwarfs, objects too small to
                burn hydrogen like a star, about 12 light-years away. Water and methane in their cold atmospheres swallow whole
                bands of light: dips 80% and 76% deep, measured at 27 and 66 times their uncertainty.
              </p>
            </Prose>
            {data.spectrum && (
              <figure className="max-w-4xl">
                <SpectrumPlot data={data.spectrum} />
                <FigureCaption source="the prepared Epsilon Indi B bundle; band depths from the Phase 1 report.">
                  Epsilon Indi B. Each dot is one exposure ({data.spectrum.points.length.toLocaleString("en-GB")}, with{" "}
                  {data.spectrum.saturated} overflowed exposures left out); the line follows their middle values. Shaded: the
                  water and methane bands.
                </FigureCaption>
              </figure>
            )}
            <ForScientists>
              <p>
                Forced photometry at the catalogue position in each exposure: an effective-PSF fit, or a fit to the PSF wings
                when the core is saturated. Each flux is plotted at the exposure’s central wavelength.
              </p>
              <p>
                Band depths compare 1.36–1.48 µm and 3.20–3.40 µm with a continuum interpolated between 1.20–1.31 and 1.53–1.68
                µm, and between 2.05–2.25 and 3.95–4.15 µm (26.8σ and 65.6σ).
              </p>
              <p>
                Anywhere else on the sky, the Lab reads a quick-look spectrum from the DR1 spectral cube (12.9″ pixels). It blends
                close neighbours and reads too faint on bright stars: for Barnard’s Star, its complete channels give 0.26 times
                the single-exposure flux.
              </p>
              <p className="text-meta text-fg-faint">
                Source: <RepoLink path="docs/data-findings.md">Phase 1 data report</RepoLink>, sections 6.2 and 6.6.
              </p>
            </ForScientists>
          </HowSection>

          <HowSection id="search" n={6} title="The automatic search">
            <Prose>
              <p>Looking at every patch of sky by eye would take forever, so two small neural networks help.</p>
              <p>
                The mover finder looks for spots that changed in difference images. It learned from fake movers and fake
                brightness changes planted in real SPHEREx images, where the right answer is known, and it is tested on patches
                of sky it never saw.
              </p>
              <p>
                Its scores are calibrated, so a score of 80% means that about 80 in 100 such spots are real. A statistical test
                then sets the bar for the whole list: only candidates that keep the{" "}
                <Term k="falseDiscoveryRate">false-discovery rate</Term> at 5% are reported, so on average no more than 1 in 20
                of them should be a false alarm.
              </p>
              <p>
                The spectral classifier reads a spectrum and says what kind of object it looks most like, from hot stars to brown
                dwarfs, galaxies and quasars. It learned from real SPHEREx spectra of objects that catalogues had already
                classified.
              </p>
            </Prose>
            <SearchFlow />
            <ModelResults />
          </HowSection>

          <HowSection id="limits" n={7} title="Limits and honesty">
            <Prose>
              <p>Everything here was measured, and some of it did not work. These are the limits we know about.</p>
            </Prose>
            <ul className="grid max-w-4xl grid-cols-1 gap-x-10 gap-y-6 md:grid-cols-2">
              {LIMITS.map((l) => (
                <li key={l.title} className="flex flex-col gap-1.5 border-t border-hair pt-4">
                  <p className="text-ui text-fg">{l.title}</p>
                  <p className="text-meta text-pretty text-fg-dim">{l.text}</p>
                </li>
              ))}
            </ul>
          </HowSection>

          <HowSection id="data" n={8} title="Data and code">
            <Prose>
              <p>Everything is public: the images, the code and the reports behind every number on this page.</p>
            </Prose>
            <DataFlow />
            <dl className="grid max-w-4xl grid-cols-1 gap-x-10 sm:grid-cols-2">
              {[
                { term: "Source code", href: REPO_URL, label: "github.com/aaaravM/planet-x-hunter", note: "Apache-2.0 licence" },
                {
                  term: "Phase 1 data report",
                  href: `${REPO_URL}/blob/main/docs/data-findings.md`,
                  label: "docs/data-findings.md",
                  note: "The archive, the files and the five test stars",
                },
                {
                  term: "Validation of the search",
                  href: `${REPO_URL}/tree/main/docs/validation`,
                  label: "docs/validation",
                  note: "Mover finder and spectral classifier",
                },
                {
                  term: "API",
                  href: API_URL,
                  label: "planet-x-hunter-api.vercel.app",
                  note: "Its contract is in docs/api-contract.md",
                },
                { term: "SPHEREx at IRSA", href: IRSA_SPHEREX, label: "irsa.ipac.caltech.edu", note: "The images themselves" },
              ].map((d) => (
                <div key={d.term} className="flex flex-col gap-0.5 border-b border-hair py-3">
                  <dt className="text-meta text-fg-faint">{d.term}</dt>
                  <dd className="text-ui">
                    <a
                      href={d.href}
                      className="text-fg underline decoration-hair-strong underline-offset-4 transition-colors hover:decoration-accent"
                    >
                      {d.label}
                    </a>
                    <span className="block text-meta text-fg-dim">{d.note}</span>
                  </dd>
                </div>
              ))}
              <div className="flex flex-col gap-0.5 border-b border-hair py-3">
                <dt className="text-meta text-fg-faint">Credits and how to cite</dt>
                <dd className="text-ui">
                  <Link
                    href="/about#cite"
                    className="text-fg underline decoration-hair-strong underline-offset-4 transition-colors hover:decoration-accent"
                  >
                    About this project
                  </Link>
                  <span className="block text-meta text-fg-dim">Data credits, licences and citations</span>
                </dd>
              </div>
            </dl>
          </HowSection>
        </IndexedArticle>
      </div>
    </div>
  );
}

const LIMITS = [
  {
    title: "Bright stars overflow the detector",
    text: "Three of the five test stars do: Barnard’s Star in 357 of 358 exposures, RW Aurigae in 306 of 335 and R Draconis in all 842. Their positions still work, but their brightness wobbles by 0.2 to 0.6 magnitudes between visits even for a steady star, so only bigger changes are trusted.",
  },
  {
    title: "Faint things barely show",
    text: "WISE 0855−0714, one of the coldest brown dwarfs known, stands only 6 to 9 times above the noise in one visit when the noise is measured from the image itself. The aim was 10. Its motion is still clear, at 10 times its uncertainty.",
  },
  {
    title: "Close pairs fool the motion fit",
    text: "RW Aurigae seems to move 0.52″ a year, where Gaia says 0.03. Its companion, 1.5″ away, blends with it in SPHEREx’s 6″ pixels, and when one of the two fades the light centre shifts. That is the likely explanation, not a proven one.",
  },
  {
    title: "Slow movers are mostly invisible",
    text: "A pixel is 6.15″ wide and the visits span about a year, so a star moving 1″ a year shifts by a sixth of a pixel. The automatic search finds most fast movers and few slow ones (step 6).",
  },
  {
    title: "The quick-look spectrum is rough",
    text: "It comes from an all-sky map with 12.9″ pixels, so it blends neighbours, and it reads too faint on bright stars: by a factor of up to 5 on RW Aurigae.",
  },
  {
    title: "A candidate is not a discovery",
    text: "Anything the search flags stays a candidate until other data confirm it. The two classifiers can be wrong, and their numbers in step 6 say how often.",
  },
  {
    title: "The data are young",
    text: "This site uses SPHEREx Data Release 1 and Quick Release 3 as IRSA served them in November 2026. The five test fields have observations up to 2 October 2026.",
  },
] as const;
