import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { Term } from "@/components/ui/term";
import { IndexedArticle, InlineIndex } from "@/components/how-it-works/section-index";
import { FactTable, FigureCaption, ForScientists, Prose, RepoLink } from "@/components/how-it-works/shell";
import { PlutoBlink } from "@/components/planet-x/pluto-blink";
import { BrightnessLadder, DiscoveryTimeline, PlutoSpectrum } from "@/components/planet-x/pluto-figures";
import { StackFigure } from "@/components/planet-x/stack-figure";
import { loadPlanetX } from "@/lib/planet-x";

export const metadata: Metadata = {
  title: "The first Planet X",
  description:
    "Pluto, found in 1930 in the search for Planet X, seen again in NASA SPHEREx images: the blink, its methane-ice spectrum, stacking along its orbit, and whether SPHEREx could find a new Planet X.",
};

const SECTIONS = [
  { id: "first", label: "The first Planet X" },
  { id: "spherex", label: "Pluto in SPHEREx" },
  { id: "spectrum", label: "Its infrared spectrum" },
  { id: "stacking", label: "Stacking along an orbit" },
  { id: "new", label: "A new Planet X?" },
  { id: "data", label: "Data and references" },
] as const;

const REPORT = "docs/validation/pluto.md";
const LINK = "text-fg underline decoration-hair-strong underline-offset-4 transition-colors hover:decoration-accent";
const LOWELL = "https://lowell.edu/campus/pluto-discovery-telescope/";
const HORIZONS = "https://ssd.jpl.nasa.gov/horizons/";
const IRSA_SPHEREX = "https://irsa.ipac.caltech.edu/Missions/spherex.html";
const S3_COPY = "https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2025-04-25 03:08" and "2025-05-01 09:15" to "25 Apr to 1 May 2025". */
const span = (a: string, b: string) => {
  const p = (s: string) => s.split(" ")[0].split("-").map(Number);
  const [y1, m1, d1] = p(a);
  const [y2, m2, d2] = p(b);
  return `${d1} ${MONTHS[m1 - 1]}${y1 === y2 ? "" : ` ${y1}`} to ${d2} ${MONTHS[m2 - 1]} ${y2}`;
};
const signed = (v: number, d = 2) => (v < 0 ? `−${Math.abs(v).toFixed(d)}` : `+${v.toFixed(d)}`);
const pct = (v: number, d = 0) => `${signed(v * 100, d)}%`;
const n = (v: number) => v.toLocaleString("en-US");
const WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
/** Small counts in words, as in the rest of the prose. */
const count = (v: number) => WORDS[v] ?? n(v);

export default async function PlanetXPage() {
  const d = await loadPlanetX();
  const a = d.astrometry;
  const pub = d.published;
  const p9 = pub.planet_nine.linder_mordasini_2016;
  const deep = pub.spherex_depth_ab.four_surveys["0.75-3.8 um"];
  const tooFaint = deep.map((m) => Math.round(10 ** (0.4 * (p9.W1_ab - m)))).sort((x, y) => x - y);
  const magBelow = deep.map((m) => (p9.W1_ab - m).toFixed(1)).sort();
  const depths = d.spectrum.bands.map((b) => Math.round(b.depth * 100));
  const cleanUm = [Math.min(...d.spectrum.points.map((p) => p.um)), Math.max(...d.spectrum.points.map((p) => p.um))];
  const bin = (um: number) => d.spectrum.bins.reduce((best, b) => (Math.abs(b.um - um) < Math.abs(best.um - um) ? b : best));
  const geo = d.geometry.cases;
  const far = geo[0];
  const dotSnr = d.bright.dots.map((x) => x.snr);
  const faintDotSnr = d.faint.dots.map((x) => x.snr);
  const elong = d.visits.flatMap((v) => v.solar_elongation_deg);
  const dist = d.visits.flatMap((v) => v.distance_au);
  const p9vRange = pub.planet_nine.brown_batygin_2016_v;
  const farWeek = far.within_visit_arcsec["7_days"].map(Math.round);
  const farWeekPx = Math.round(far.within_visit_px["7_days"][1]);
  const elongDeg = d.geometry.elongation_deg.map(Math.round);
  const moved = d.visits.map((v) => v.pluto_moved_arcsec);
  const plutoMoved = [Math.min(...moved), Math.max(...moved)].map(Math.round);

  return (
    <div className="mx-auto w-full max-w-7xl px-4 pt-16 pb-28 sm:px-6 sm:pt-24">
      <header className="max-w-3xl">
        <h1 className="text-title text-balance text-fg sm:text-display">The first Planet X</h1>
        <p className="mt-5 max-w-2xl text-lead text-pretty text-fg-dim">
          In 1930 Clyde Tombaugh found Pluto by flipping between two photographs of the same stars and spotting the one dot that
          had moved. Pluto turns up in {d.images} SPHEREx images from 2025 and 2026. Here is the same search in SPHEREx’s infrared
          pictures, and what it would take to find another Planet X.
        </p>
      </header>
      <div className="max-w-3xl">
        <InlineIndex items={SECTIONS} />
      </div>

      <div className="mt-14 lg:mt-20">
        <IndexedArticle items={SECTIONS}>
          <Section id="first" title="Pluto was the first Planet X">
            <Prose>
              <p>
                Lowell Observatory in Arizona built a telescope in 1928 and 1929 for one job: the search for “Planet X”, the ninth
                planet that Percival Lowell believed lay beyond Neptune. Clyde Tombaugh, an observatory assistant, photographed
                the sky with it one patch at a time.
              </p>
              <p>
                Two of his photographic plates, taken six days apart in January 1930, showed the same stars. On 18 February,
                flipping between them on a blink comparator, he saw one faint dot jump while the stars held still. It was Pluto,
                the first Planet X to be found, though it turned out to be tiny: about 0.2% of Earth’s mass. The search for
                another one has gone on ever since.
              </p>
            </Prose>
            <figure className="max-w-4xl">
              <DiscoveryTimeline
                items={[
                  { when: "1928 to 1929", what: "Lowell Observatory builds a telescope for the search for Planet X." },
                  {
                    when: `${longDay(pub.tombaugh.plates[0])} and ${longDay(pub.tombaugh.plates[1])}`,
                    what: "Tombaugh photographs the same patch of sky twice, six days apart.",
                  },
                  { when: longDay(pub.tombaugh.found_on_blink_comparator), what: "Blinking the two plates, he sees one dot move: Pluto." },
                  { when: longDay(pub.tombaugh.announced), what: "The discovery is announced." },
                  {
                    when: `${monthYear(d.visits[0].start_utc)} to ${monthYear(d.visits.at(-1)!.end_utc)}`,
                    what: `SPHEREx catches Pluto in ${d.images} images, in ${count(d.visits.length)} visits.`,
                    now: true,
                  },
                ]}
              />
              <FigureCaption
                source={
                  <>
                    <a href={LOWELL} className={LINK}>
                      Lowell Observatory
                    </a>
                    ; Tombaugh 1946; the SPHEREx images found for this page.
                  </>
                }
              >
                From the Planet X telescope to SPHEREx.
              </FigureCaption>
            </figure>
          </Section>

          <Section id="spherex" title="Pluto in SPHEREx">
            <Prose>
              <p>
                SPHEREx does not aim at Pluto: it maps the whole sky, strip by strip. To find Pluto in its pictures, we took the path
                NASA JPL predicts for Pluto and checked {n(d.observationsScanned)} SPHEREx observations from the weeks when Pluto was
                in view. Pluto falls on a detector in {d.images} images, from {count(d.visits.length)} visits between April 2025 and
                October 2026, while it was about {Math.round((Math.min(...dist) + Math.max(...dist)) / 2)} times as far from us as the Sun.
              </p>
              <p>
                Here is Tombaugh’s blink again, with SPHEREx pictures from April and May 2026, in two ways. Hold the stars still, and
                Pluto walks past them: {Math.round(d.skyFixed.movedArcsec)} <Term k="arcsecond">arcseconds</Term> in{" "}
                {d.skyFixed.spanDays.toFixed(1)} days. Follow Pluto instead, and the stars stream past it.
              </p>
            </Prose>
            <PlutoBlink skyFixed={d.skyFixed} tracked={d.tracked} />
            <Prose>
              <p>
                The ring is where JPL predicts Pluto; the dot inside it is what SPHEREx saw. In the {a.n} best measurements, the
                two agree to about {Math.max(a.rms_east_arcsec, a.rms_north_arcsec).toFixed(1)} arcseconds in each direction, a
                thirtieth of a SPHEREx pixel.
              </p>
              <p>
                And the dot is Pluto, not a star: pictures of the same sky taken while Pluto was elsewhere hold almost nothing at that
                spot, a median of {pct(d.staticSky.fraction_of_pluto.median, 1)} of Pluto’s light.
              </p>
            </Prose>
            <ForScientists>
              <FactTable
                label="SPHEREx visits"
                head={["Visit", "Dates (UTC)", "Release", "Images (exposures)", "Clean", "Wavelengths", "Pluto moved"]}
                rows={d.visits.map((v) => [
                  v.visit + 1,
                  <span key="d" className="readout">
                    {span(v.start_utc, v.end_utc)}
                  </span>,
                  v.collections.map((c) => c.replace("spherex_", "").toUpperCase()).join(", "),
                  <span key="i" className="readout">
                    {v.n_images} ({v.n_exposures})
                  </span>,
                  <span key="c" className="readout">
                    {v.n_clean}
                  </span>,
                  <span key="w" className="readout">
                    {v.wavelength_um[0].toFixed(2)}–{v.wavelength_um[1].toFixed(2)} µm
                  </span>,
                  <span key="m" className="readout">
                    {Math.round(v.pluto_moved_arcsec)}″
                  </span>,
                ])}
              />
              <p>
                IRSA’s image search returned HTTP 502 on 15 November 2026, so the images were found in the FITS headers of the public
                S3 copy of SPHEREx Level-2 data: {n(d.observationsScanned)} observations in the half-week folders where Pluto’s solar
                elongation was 80 to 140°. Pluto’s JPL Horizons position ({d.ephemeris}) at each exposure’s MJD-AVG is moved from the
                geocentre to SPHEREx (at most 0.17″) and must land on the detector through the file’s own TAN-SIP WCS. The {d.images}{" "}
                images are {d.exposures} exposures, each read by two detectors behind a beam splitter, at solar elongations{" "}
                {Math.min(...elong).toFixed(1)}–{Math.max(...elong).toFixed(1)}°; the PSF FWHM is{" "}
                {d.psfFwhm.min.toFixed(1)}–{d.psfFwhm.max.toFixed(1)}″.
              </p>
              <p>
                Positions, clean measurements fitted at S/N ≥ 20 (n = {a.n}), measured minus JPL: median {signed(a.median_east_arcsec, 3)}″
                east and {signed(a.median_north_arcsec, 3)}″ north; weighted mean {signed(a.wmean_east_arcsec, 3)} ±{" "}
                {a.wmean_east_err_arcsec.toFixed(3)}″ and {signed(a.wmean_north_arcsec, 3)} ± {a.wmean_north_err_arcsec.toFixed(3)}″; rms{" "}
                {a.rms_east_arcsec.toFixed(2)}″ and {a.rms_north_arcsec.toFixed(2)}″; 90% within {a.total_offset_arcsec.p90.toFixed(2)}″,
                largest {a.total_offset_arcsec.max.toFixed(2)}″. The formal errors (median {a.median_formal_err_arcsec.toFixed(3)}″) are
                too small by a factor of about {Math.sqrt((a.chi2_red_east + a.chi2_red_north) / 2).toFixed(1)} (reduced χ² {a.chi2_red_east.toFixed(1)}{" "}
                east, {a.chi2_red_north.toFixed(1)} north).
              </p>
              <p>
                Static sky: in the {d.staticSky.n_images_with_template} images with another image of the same detector taken while Pluto
                was at least 40″ away, the flux at Pluto’s position is {pct(d.staticSky.fraction_of_pluto.median, 1)} of Pluto’s
                (median; 10th to 90th percentile {pct(d.staticSky.fraction_of_pluto.p10, 1)} to {pct(d.staticSky.fraction_of_pluto.p90, 1)}
                ); {d.staticSky.n_blended} blends are left out of the clean set. The pipeline’s OUTLIER flag marks Pluto itself:
                keeping those pixels changes its flux by a median factor of{" "}
                {d.outlier.flux_ratio_kept_over_masked.median.toFixed(3)} (10th to 90th percentile{" "}
                {d.outlier.flux_ratio_kept_over_masked.p10.toFixed(3)}–{d.outlier.flux_ratio_kept_over_masked.p90.toFixed(3)}, n ={" "}
                {d.outlier.n}), so it is cleared within 2.5 pixels of the prediction and every other flag stays masked.
              </p>
              <FactTable
                label="Blink frames"
                head={["Blink frame (UTC)", "Wavelength", "S/N", "Measured − JPL (east, north)"]}
                rows={d.tracked.frames.map((f) => [
                  <span key="t" className="readout">
                    {f.date}
                  </span>,
                  <span key="w" className="readout">
                    {f.um.toFixed(3)} µm
                  </span>,
                  <span key="s" className="readout">
                    {f.snr.toFixed(1)}
                  </span>,
                  <span key="o" className="readout">
                    {f.offE === null || f.offN === null ? "–" : `${signed(f.offE)}″, ${signed(f.offN)}″`}
                  </span>,
                ])}
              />
              <p className="text-meta text-fg-faint">
                Source: <RepoLink path={REPORT}>Pluto validation report</RepoLink>, sections 1 to 4.
              </p>
            </ForScientists>
          </Section>

          <Section id="spectrum" title="Its infrared spectrum">
            <Prose>
              <p>
                Each SPHEREx picture sees Pluto through a slightly different colour, so its {d.spectrum.points.length} clean measurements
                add up to a spectrum from {cleanUm[0].toFixed(2)} to {cleanUm[1].toFixed(2)} micrometres.
              </p>
              <p>
                Pluto shines with reflected sunlight, so the way to read its spectrum is against sunlight. Where Pluto is darker,
                something on its surface swallows that light. Three wide dips match methane ice, which takes {depths[0]}%, {depths[1]}%
                and {depths[2]}% of the light in them, compared with the neighbouring colours. Methane was first found on Pluto in
                1976, by comparing its brightness at 1.55 and 1.73 micrometres, across the first of these dips.
              </p>
            </Prose>
            <figure className="max-w-4xl">
              <PlutoSpectrum data={d.spectrum} />
              <FigureCaption source="SPHEREx Data Release 1 and Quick Release 3 images, measured for this page.">
                Pluto and its moon Charon, too close together to separate. Each dot is one exposure; the dashed line stands in for sunlight (a 5772 K
                blackbody) matched to Pluto below 1 µm. Shaded: the methane-ice bands, with how much light each dip takes.
              </FigureCaption>
            </figure>
            <Prose>
              <p>
                SPHEREx’s colours are broad, each about 1 to 3% of its wavelength wide, so this spectrum shows the big methane dips but
                not their fine detail: the separate methane bands at 2.2 and 2.3 micrometres in New Horizons spectra (Protopapa et al.
                2017) blur into one dip here, and a weaker band at 0.89 micrometres is at most a{" "}
                {Math.round((1 - bin(0.87).refl) * 100)}% dip.
              </p>
            </Prose>
            <ForScientists>
              <FactTable
                label="Methane-ice bands"
                head={["Band", "In the band", "Continuum", "Depth", "Significance", "References"]}
                rows={d.spectrum.bands.map((b) => [
                  <span key="b" className="readout whitespace-nowrap">
                    {b.lo.toFixed(2)}–{b.hi.toFixed(2)} µm
                  </span>,
                  <span key="i" className="readout">
                    {b.reflIn.toFixed(b.reflIn < 0.1 ? 3 : 2)}
                  </span>,
                  <span key="c" className="readout whitespace-nowrap">
                    {b.reflCont.toFixed(2)} at {b.cont[0].toFixed(2)}–{b.cont[1].toFixed(2)} µm
                  </span>,
                  <span key="d" className="readout whitespace-nowrap">
                    {b.depth.toFixed(2)} ± {b.depthErr.toFixed(b.depthErr < 0.0195 ? 3 : 2)}
                  </span>,
                  <span key="s" className="readout">
                    {b.sigma.toFixed(0)}σ
                  </span>,
                  citations(b.refs),
                ])}
              />
              <p>
                The spectrum averages the clean measurements in {d.spectrum.bins.length} logarithmic bins (inverse-variance means,
                errors scaled up by the square root of the reduced χ² where the points scatter more than their errors). Each bin is
                divided by a 5772 K blackbody, the IAU nominal solar temperature and a rough stand-in for the solar spectrum, scaled to
                Pluto below 1 µm; “In the band” and “Continuum” are that ratio. Only dips far larger than the difference between a
                blackbody and the real Sun are marked.
              </p>
              <p>
                Not marked: the {bin(1.36).um.toFixed(2)} µm bin ({bin(1.36).refl.toFixed(2)} ± {bin(1.36).reflErr.toFixed(2)}) is not
                identified in the references used; the {bin(2.92).um.toFixed(2)} µm bin ({bin(2.92).refl.toFixed(2)} ±{" "}
                {bin(2.92).reflErr.toFixed(2)}) scatters strongly (reduced χ² {bin(2.92).chi2.toFixed(1)}); and the 0.89 µm methane band
                reported by Protopapa et al. 2017 is at most a {Math.round((1 - bin(0.87).refl) * 100)}% dip ({bin(0.87).refl.toFixed(2)} ±{" "}
                {bin(0.87).reflErr.toFixed(3)} at {bin(0.87).um.toFixed(2)} µm).
              </p>
              <p>
                Pluto with Charon is AB {d.plutoAb.median.toFixed(2)} below 1 µm (median of {d.plutoAb.n} clean measurements). Charon
                orbits {n(pub.pluto_system.charon_distance_km)} km from Pluto, at most about 0.8″ at 35 au, well inside one pixel.
                Pluto turns once every {pub.pluto_system.rotation_period_days.toFixed(3)} days and the bins combine dates, so some
                scatter more than their errors.
              </p>
              <p className="text-meta text-fg-faint">
                Source: <RepoLink path={REPORT}>Pluto validation report</RepoLink>, section 3.
              </p>
            </ForScientists>
          </Section>

          <Section id="stacking" title="Stacking along an orbit">
            <Prose>
              <p>
                Pluto is bright enough to see in a single picture. A new Planet X would not be. Searches for one add many pictures
                together, each shifted so that a planet on a guessed orbit lands on the same spot every time: its light piles up while
                the noise averages away. Shifted the wrong way, the light spreads out and vanishes.
              </p>
              <p>Here is the method on Pluto, whose orbit is known.</p>
            </Prose>
            <StackFigure bright={d.bright} faint={d.faint} />
            <Prose>
              <p>
                In the second figure, at {d.faint.um[0].toFixed(1)} to {d.faint.um[1].toFixed(1)} micrometres, Pluto is over ten times
                fainter than in the blink. In a single picture it stands only {d.faint.snrSingleMedian.toFixed(1)} times above the noise, a{" "}
                <Term k="sigma">signal-to-noise</Term> ratio (S/N) too low to be sure of. Stacked along its motion, {d.faint.n} pictures
                lift it to {d.faint.snrStack.toFixed(1)}. Stacked on the stars, its light is spread over {d.faint.dots.length} spots and
                none of them stands out.
              </p>
              <p>
                A search for an unknown planet does not know the orbit, so it repeats the stack for many guessed orbits and follows up
                the ones where something piles up.
              </p>
            </Prose>
            <ForScientists>
              <p>
                The S/N comes from difference images: the static sky, the per-pixel median of all the star-aligned frames, is
                subtracted from every frame; the S/N is an aperture flux (radius 2 pixels, background annulus 4 to 7 pixels) over the
                scatter of 200 random apertures in the same image. The co-adds are inverse-variance weighted.
              </p>
              <p>
                Faint run: median single-frame S/N {d.faint.snrSingleMedian.toFixed(1)} ({d.faint.nSingleMeasured} of {d.faint.n} frames
                measurable); stacked on Pluto’s motion {d.faint.snrStack.toFixed(1)}, against {d.faint.snrSqrtN.toFixed(1)} expected from
                √N for the {d.faint.nSingleMeasured} measurable frames; stacked on the stars, the {d.faint.dots.length} positions have S/N {signed(Math.min(...faintDotSnr), 1)} to{" "}
                {signed(Math.max(...faintDotSnr), 1)}.
              </p>
              <p>
                Bright run: on the stars, the {d.bright.dots.length} dots have S/N {Math.min(...dotSnr).toFixed(1)} to{" "}
                {Math.max(...dotSnr).toFixed(1)}. Pluto is bright here (median single-frame S/N {d.bright.snrSingleMedian.toFixed(0)}), and
                the stacked S/N ({d.bright.snrStack.toFixed(0)}) is limited by the residuals of stars that change brightness from frame
                to frame, each frame being at a different wavelength, not by noise.
              </p>
              <p className="text-meta text-fg-faint">
                Source: <RepoLink path={REPORT}>Pluto validation report</RepoLink>, section 4.
              </p>
            </ForScientists>
          </Section>

          <Section id="new" title="Could SPHEREx find a new Planet X?">
            <Prose>
              <p>
                Today’s best-known candidate is Planet Nine, a predicted planet of about 6 times Earth’s mass that never comes closer
                to the Sun than about 300 au, 300 times Earth’s distance (Brown &amp; Batygin 2021). Two numbers stand in the way.
              </p>
              <p>
                The first is brightness. In 2016, Brown and Batygin expected it at <Term k="magnitude">magnitude</Term> {p9vRange[0]} to{" "}
                {p9vRange[1]} in visible light. In infrared, a model of a 10-Earth-mass planet at 700 au comes out at{" "}
                {p9.W1_ab.toFixed(1)} at 3.4 micrometres (Linder &amp; Mordasini 2016). Even after all four of its surveys, SPHEREx
                reaches {deep[0]} to {deep[1]} there: such a planet would be {tooFaint[0]} to {tooFaint[1]} times too faint.
              </p>
            </Prose>
            <figure className="max-w-3xl">
              <BrightnessLadder
                limit={deep[1]}
                rows={[
                  { label: "Pluto, with Charon", note: "measured here, below 1 µm", value: Number(d.plutoAb.median.toFixed(1)) },
                  {
                    label: "One SPHEREx exposure reaches",
                    note: "measured here at Pluto’s position, 0.75–3.8 µm",
                    value: Number(d.depth["0.75-3.8 um"].median.toFixed(1)),
                  },
                  { label: "All four SPHEREx surveys reach", note: "Bock et al. 2026, 0.75–3.8 µm", value: [deep[0], deep[1]] },
                  {
                    label: "Planet Nine, if 10 Earth masses at 700 au",
                    note: "a model at 3.4 µm (Linder & Mordasini 2016)",
                    value: Number(p9.W1_ab.toFixed(1)),
                    accent: true,
                  },
                ]}
              />
              <FigureCaption source="the Pluto measurements on this page; Bock et al. 2026; Linder & Mordasini 2016.">
                Brightness on the astronomers’ magnitude scale, where larger numbers are fainter: every 2.5
                magnitudes is a factor of ten.
              </FigureCaption>
            </figure>
            <Prose>
              <p>
                The second is motion. SPHEREx sees each patch of sky for a few days to a few weeks, about every six months. In a
                week, a planet {far.distance_au} au away moves {farWeek[0]} to {farWeek[1]} arcseconds, depending on how far from the Sun
                SPHEREx is looking (it saw Pluto {elongDeg[0]} to {elongDeg[1]}° from the Sun): at most about {count(farWeekPx)} of SPHEREx’s{" "}
                {d.geometry.pixel_arcsec}-arcsecond pixels, against the {plutoMoved[0]} to {plutoMoved[1]} arcseconds that Pluto, at{" "}
                {Math.round((Math.min(...dist) + Math.max(...dist)) / 2)} au, moved within each visit. Between visits it jumps by
                minutes of arc, as Earth’s own trip around the Sun shifts our view, so the two dots are hard to connect without
                knowing the orbit.
              </p>
            </Prose>
            <figure className="max-w-3xl">
              <FactTable
                label="How far a distant planet moves"
                head={["Distance from the Sun", "In a 7-day visit", "Between visits six months apart"]}
                rows={geo.map((c) => [
                  `${n(c.distance_au)} au`,
                  <span key="w" className="flex flex-col">
                    <span className="readout">
                      {Math.round(c.within_visit_arcsec["7_days"][0])}–{Math.round(c.within_visit_arcsec["7_days"][1])}″
                    </span>
                    <span className="text-fg-faint">up to {Math.round(c.within_visit_px["7_days"][1])} pixels</span>
                  </span>,
                  <span key="b" className="flex flex-col">
                    <span className="readout">
                      {n(Math.round(c.shift_between_visits_arcsec[0]))}–{n(Math.round(c.shift_between_visits_arcsec[1]))}″
                    </span>
                    <span className="text-fg-faint">
                      {Math.round(c.shift_between_visits_px[0])} to {Math.round(c.shift_between_visits_px[1])} pixels
                    </span>
                  </span>,
                ])}
              />
              <FigureCaption source={<RepoLink path="scripts/pluto_planetx_facts.py">scripts/pluto_planetx_facts.py</RepoLink>}>
                For circular orbits in the plane of Earth’s, seen {elongDeg[0]} to {elongDeg[1]}° from the Sun within a visit and at
                right angles to the Sun between visits.
              </FigureCaption>
            </figure>
            <Prose>
              <p>
                Searches for Planet Nine use visible-light surveys instead. Zwicky Transient Facility data ruled out{" "}
                {Math.round(pub.planet_nine.brown_batygin_2022_ztf_ruled_out_fraction * 100)}% of the predicted possibilities (Brown
                &amp; Batygin 2022); with Pan-STARRS and the Dark Energy Survey added, 78%, and much of the rest is fainter than
                magnitude 21 (Brown, Holman &amp; Batygin 2024).
              </p>
              <p>
                What SPHEREx can catch is nearer things that move fast. The brown dwarf WISE 0855−0714, at{" "}
                {pub.wise_0855.temperature_k[0]} to {pub.wise_0855.temperature_k[1]} K one of the coldest known, is{" "}
                {pub.wise_0855.distance_pc} parsecs away, about 7 light-years, and was found because it moves{" "}
                {pub.wise_0855.proper_motion_arcsec_per_yr} arcseconds a year in WISE images (Luhman 2014). This site’s mover finder
                picks it up in SPHEREx too. Watch{" "}
                <Link href="/explore?target=wise-0855" className={LINK}>
                  WISE 0855−0714
                </Link>{" "}
                or the brown-dwarf pair{" "}
                <Link href="/explore?target=eps-indi-b" className={LINK}>
                  Epsilon Indi B
                </Link>{" "}
                move in the Lab, or see{" "}
                <Link href="/ai#finds" className={LINK}>
                  what the search has found
                </Link>
                .
              </p>
            </Prose>
            <ForScientists>
              <p>
                Measured single-exposure 5σ depth at Pluto’s position: {d.depth["0.75-3.8 um"].median.toFixed(2)} AB at 0.75–3.8 µm
                (10th to 90th percentile {d.depth["0.75-3.8 um"].p10.toFixed(2)}–{d.depth["0.75-3.8 um"].p90.toFixed(2)},{" "}
                {d.depth["0.75-3.8 um"].n} images) and {d.depth["3.8-5.0 um"].median.toFixed(2)} AB at 3.8–5.0 µm (
                {d.depth["3.8-5.0 um"].p10.toFixed(2)}–{d.depth["3.8-5.0 um"].p90.toFixed(2)}, {d.depth["3.8-5.0 um"].n}). Crill et al.
                2025 give {pub.spherex_depth_ab.single_visit["0.75-3.8 um"].join("–")} and{" "}
                {pub.spherex_depth_ab.single_visit["3.8-5.0 um"].join("–")} AB for a single visit; Bock et al. 2026 give{" "}
                {deep.join("–")} and {pub.spherex_depth_ab.four_surveys["3.8-5.0 um"].join("–")} AB after four surveys. The measured
                depth is shallower than the published one at short wavelengths; the causes were not separated: Pluto lies 3.5 to 4.3°
                from the ecliptic, where zodiacal light is brightest, random positions at Galactic latitude −29 to −32° include faint
                stars, and the estimator is forced photometry at random positions, not the mission’s sensitivity model.
              </p>
              <p>
                Linder &amp; Mordasini 2016 give V = {p9.V} and W1 = W2 = {p9.W1_vega} (Vega) for 10 Earth masses at 700 au. With the
                WISE Vega-to-AB offsets (+2.699 for W1, +3.339 for W2) that is {p9.W1_ab.toFixed(1)} AB at 3.4 µm and{" "}
                {p9.W2_ab.toFixed(1)} AB at 4.6 µm: {magBelow[0]} to {magBelow[1]} magnitudes below the four-survey depth at 3.4 µm.
              </p>
              <p>
                The motion table assumes circular, coplanar, prograde orbits and Earth at 1 au. Within a visit it gives the shortest
                and longest track over every 7-day window seen {d.geometry.elongation_deg[0].toFixed(1)} to{" "}
                {d.geometry.elongation_deg[1].toFixed(1)}° from the Sun, the range of the Pluto images; a track’s length is the largest
                separation between two of its positions, as for Pluto in each visit. The track is shortest near 90°, where Earth moves
                almost along the line of sight and the planet’s apparent motion stops and reverses, and longest at the far end of the
                range. Between visits, at right angles to the
                Sun half a year apart, the shift is mostly parallax, about 2 au divided by the distance in radians ({n(Math.round(far.shift_between_visits_arcsec[0]))}{" "}
                to {n(Math.round(far.shift_between_visits_arcsec[1]))}″ at {far.distance_au} au).
              </p>
              <p className="text-meta text-fg-faint">
                Source: <RepoLink path={REPORT}>Pluto validation report</RepoLink>, sections 3 and 5.
              </p>
            </ForScientists>
          </Section>

          <Section id="data" title="Data and references">
            <Prose>
              <p>Everything on this page comes from public data, and the code and the full report are in the repository.</p>
            </Prose>
            <dl className="grid max-w-4xl grid-cols-1 gap-x-10 sm:grid-cols-2">
              {[
                {
                  term: "SPHEREx images",
                  href: IRSA_SPHEREX,
                  label: "NASA/JPL-Caltech, IRSA",
                  note: "Data Release 1 (doi:10.26131/IRSA678) and Quick Release 3, read from IRSA’s public copy on Amazon S3",
                },
                {
                  term: "Pluto’s predicted positions",
                  href: HORIZONS,
                  label: "JPL Horizons",
                  note: `NASA JPL Solar System Dynamics: target 999, ephemeris ${d.ephemeris}`,
                },
                {
                  term: "The method and every number",
                  href: `https://github.com/aaaravM/perturbation/blob/main/${REPORT}`,
                  label: REPORT,
                  note: "How the images were found and measured, and what went wrong",
                },
                {
                  term: "The measurements",
                  href: `https://github.com/aaaravM/perturbation/tree/main/scripts`,
                  label: "scripts/pluto_*.py",
                  note: "Scan, measure and build the bundle this page reads (public/planet-x/pluto.json)",
                },
                {
                  term: "The S3 copy",
                  href: S3_COPY,
                  label: "nasa-irsa-spherex",
                  note: "Used because IRSA’s search services were returning errors",
                },
                { term: "The Planet X telescope", href: LOWELL, label: "Lowell Observatory", note: "The Pluto Discovery Telescope" },
              ].map((x) => (
                <div key={x.term} className="flex flex-col gap-0.5 border-b border-hair py-3">
                  <dt className="text-meta text-fg-faint">{x.term}</dt>
                  <dd className="text-ui">
                    <a href={x.href} className={LINK}>
                      {x.label}
                    </a>
                    <span className="block text-meta text-fg-dim">{x.note}</span>
                  </dd>
                </div>
              ))}
            </dl>
            <div className="max-w-3xl">
              <h3 className="text-ui text-fg">References</h3>
              <ul className="mt-3 flex flex-col gap-2 text-meta text-pretty text-fg-dim">
                {REFERENCES.map((r) => (
                  <li key={r.text}>
                    {r.text}
                    {r.doi && (
                      <>
                        {" "}
                        <a
                          href={`https://doi.org/${r.doi}`}
                          className="readout text-fg-dim underline decoration-hair-strong underline-offset-4 transition-colors hover:text-fg hover:decoration-accent"
                        >
                          doi:{r.doi}
                        </a>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          </Section>
        </IndexedArticle>
      </div>
    </div>
  );
}

/** A section of the page: a hairline, a heading and its content (as How it works, without step numbers). */
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

const LONG_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** "Cruikshank, Pilcher & Morrison 1976 found methane ...; Grundy, Schmitt & Quirico 2002 (lab ...)" to the citations alone. */
function citations(refs: string) {
  return refs
    .split(";")
    .map((r) => r.trim().match(/^.*?\d{4}/)?.[0] ?? r.trim())
    .join("; ");
}

/** "1930-02-18" to "18 February 1930". */
function longDay(iso: string) {
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${LONG_MONTHS[m - 1]} ${y}`;
}
/** "2025-04-25 03:08" to "April 2025". */
function monthYear(utc: string) {
  const [y, m] = utc.split("-").map(Number);
  return `${LONG_MONTHS[m - 1]} ${y}`;
}

/** From docs/validation/pluto.md; the DOIs were checked when the report was written. */
const REFERENCES: { text: string; doi?: string }[] = [
  { text: "Bock, J. J., et al. 2026, ApJ, 999, 139.", doi: "10.3847/1538-4357/ae2be2" },
  { text: "Brown, M. E. & Batygin, K. 2016, ApJL, 824, L23.", doi: "10.3847/2041-8205/824/2/L23" },
  { text: "Brown, M. E. & Batygin, K. 2021, AJ, 162, 219.", doi: "10.3847/1538-3881/ac2056" },
  { text: "Brown, M. E. & Batygin, K. 2022, AJ, 163, 102.", doi: "10.3847/1538-3881/ac32dd" },
  { text: "Brown, M. E., Holman, M. J. & Batygin, K. 2024, AJ, 167, 146.", doi: "10.3847/1538-3881/ad24e9" },
  { text: "Crill, B. P., et al. 2025, ApJS, 281, 10.", doi: "10.3847/1538-4365/ae04cc" },
  { text: "Cruikshank, D. P., Pilcher, C. B. & Morrison, D. 1976, Science, 194, 835.", doi: "10.1126/science.194.4267.835" },
  { text: "Explanatory Supplement to the WISE All-Sky Data Release Products, section IV.4.h (Vega to AB offsets)." },
  { text: "Grundy, W. M., Schmitt, B. & Quirico, E. 2002, Icarus, 155, 486.", doi: "10.1006/icar.2001.6726" },
  { text: "IAU 2015 Resolution B3 (nominal solar effective temperature, 5772 K)." },
  { text: "Linder, E. F. & Mordasini, C. 2016, A&A, 589, A134 (arXiv:1602.07465)." },
  { text: "Luhman, K. L. 2014, ApJL, 786, L18.", doi: "10.1088/2041-8205/786/2/L18" },
  { text: "NASA Space Science Data Coordinated Archive, Pluto fact sheet (mass, rotation period, Charon’s distance)." },
  { text: "Olkin, C. B., et al. 2007, AJ, 133, 420.", doi: "10.1086/509616" },
  { text: "Protopapa, S., et al. 2017, Icarus, 287, 218.", doi: "10.1016/j.icarus.2016.11.028" },
  {
    text: "Tombaugh, C. W. 1946, Astronomical Society of the Pacific Leaflet No. 209; Lowell Observatory archives (the plates of 23 and 29 January 1930, the blink comparator on 18 February, the announcement on 13 March).",
  },
];
