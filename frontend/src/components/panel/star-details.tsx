"use client";
// Object tab content for a clicked star: its Gaia DR3 measurements, what SIMBAD calls it, what
// SPHEREx has observed there and the quick-look spectrum from the DR1 cube. Every number names
// its catalogue; anything an archive does not answer is said plainly, never filled in.

import { useEffect, useState } from "react";
import { ArrowUpRightIcon, ScanSearchIcon } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import type { GaiaSource, ObjectSpot, QuickSpectrum, SimbadInfo, SpherexCoverage } from "@/lib/lab-catalog";
import { loadCoverage, loadObjectSpot, loadQuickSpectrum, parallaxDistanceLy, simbadForGaia, totalProperMotion } from "@/lib/lab-catalog";
import { API_URL, type FieldManifest } from "@/lib/manifest";
import { formatDecDms, formatDeg, formatRaHms, separationDeg } from "@/lib/lab-coords";
import { positionAngleDeg } from "@/lib/lab-wcs";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Term } from "@/components/ui/term";
import { SpectrumChart } from "@/components/panel/spectrum-chart";

type Async<T> = { state: "loading" } | { state: "ready"; value: T } | { state: "error"; message: string } | { state: "off" };

function useAsync<T>(key: string, enabled: boolean, load: (signal: AbortSignal) => Promise<T>): Async<T> {
  const [entry, setEntry] = useState<{ key: string; value: Async<T> }>({ key: "", value: { state: "loading" } });
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    load(controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setEntry({ key, value: { state: "ready", value } });
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setEntry({ key, value: { state: "error", message: err instanceof Error ? err.message : "unknown error" } });
      });
    return () => controller.abort();
    // `load` is keyed by `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled]);
  if (!enabled) return { state: "off" };
  return entry.key === key ? entry.value : { state: "loading" };
}

const stagger = (i: number, reduce: boolean | null) =>
  reduce
    ? {}
    : {
        initial: { opacity: 0, y: 8 },
        animate: { opacity: 1, y: 0 },
        transition: { delay: 0.05 + i * 0.06, duration: 0.42, ease: [0.16, 1, 0.3, 1] as const },
      };

/** Rough temperature class from Gaia's BP-RP colour (main-sequence, unreddened). */
function colourWord(bpRp: number | null): string | null {
  if (bpRp === null) return null;
  if (bpRp < 0.3) return "blue-white";
  if (bpRp < 0.8) return "white to yellow-white";
  if (bpRp < 1.2) return "yellow to orange";
  if (bpRp < 2.0) return "orange";
  return "red";
}

/** Gaia BP-RP to an sRGB swatch (approximate blackbody colour). */
export function bpRpColour(bpRp: number | null): string {
  if (bpRp === null) return "var(--fg-dim)";
  const t = Math.min(Math.max((bpRp + 0.3) / 3.3, 0), 1);
  const stops: [number, number, number][] = [
    [155, 176, 255],
    [202, 215, 255],
    [255, 244, 234],
    [255, 210, 161],
    [255, 163, 108],
    [255, 120, 80],
  ];
  const x = t * (stops.length - 1);
  const i = Math.min(Math.floor(x), stops.length - 2);
  const f = x - i;
  const c = stops[i].map((v, k) => Math.round(v + (stops[i + 1][k] - v) * f));
  return `rgb(${c[0]} ${c[1]} ${c[2]})`;
}

export function StarDetails({
  source,
  epoch,
  via,
  manifest,
  onWatch,
  watchLabel,
}: {
  source: GaiaSource;
  /** Epoch (Julian years) the shown position is for. */
  epoch: number;
  via: string;
  manifest: FieldManifest | null;
  onWatch: () => void;
  watchLabel: string;
}) {
  const reduce = useReducedMotion();
  const simbad = useAsync<SimbadInfo | null>(`simbad:${source.id}`, true, (signal) => simbadForGaia(source.id, signal));
  // One request to /api/object when the backend has it; otherwise the single endpoints.
  const spot = useAsync<ObjectSpot>(`obj:${source.id}`, Boolean(API_URL), (signal) => loadObjectSpot(source, epoch, signal));
  const fallback = spot.state === "error";
  const coverageAlone = useAsync<SpherexCoverage>(`cov:${source.id}`, fallback, (signal) => loadCoverage(source.ra, source.dec, signal));
  const spectrumAlone = useAsync<QuickSpectrum>(`spec:${source.id}`, fallback, (signal) => loadQuickSpectrum(source.ra, source.dec, signal));
  const coverage: Async<SpherexCoverage> =
    spot.state === "ready"
      ? spot.value.coverage
        ? { state: "ready", value: spot.value.coverage }
        : { state: "error", message: "the archive search did not finish" }
      : spot.state === "error"
        ? coverageAlone
        : spot;
  const spectrum: Async<QuickSpectrum> =
    spot.state === "ready"
      ? spot.value.spectrum
        ? { state: "ready", value: spot.value.spectrum }
        : { state: "error", message: "no DR1 cube data here" }
      : spot.state === "error"
        ? spectrumAlone
        : spot;
  const where = spot.state === "ready" ? spot.value.where : null;

  const pm = totalProperMotion(source);
  const pa = source.pmra !== null && source.pmdec !== null ? positionAngleDeg({ ra: 0, dec: 0 }, { ra: source.pmra / 3.6e6, dec: source.pmdec / 3.6e6 }) : null;
  const ly = parallaxDistanceLy(source.parallax, source.parallaxErr);
  const name = simbad.state === "ready" && simbad.value ? simbad.value.mainId : "Unnamed star";
  const inField = manifest ? separationDeg(manifest.center, source) * 60 <= manifest.fov_arcmin / 2 : false;
  const fieldCoverage = inField && manifest ? manifest.epochs : null;

  return (
    <div className="flex flex-col pb-4" data-testid="star-details" data-source-id={source.id}>
      <motion.header {...stagger(0, reduce)} className="flex flex-col gap-1.5 px-4 pt-4 pr-12 pb-3">
        <p className="flex items-center gap-2 text-meta text-fg-dim">
          <span aria-hidden className="size-2.5 shrink-0 rounded-[2px] ring-1 ring-white/20" style={{ backgroundColor: bpRpColour(source.bpRp) }} />
          {simbad.state === "ready" && simbad.value?.otypeText ? (
            <span className="first-letter:uppercase">{simbad.value.otypeText}</span>
          ) : (
            "Star in the Gaia catalogue"
          )}
        </p>
        <h2 className="text-heading text-fg" data-testid="panel-title">
          {simbad.state === "loading" ? <Skeleton className="h-7 w-48 bg-ink-3" /> : name}
        </h2>
        <p className="readout text-micro text-fg-faint">Gaia DR3 {source.id}</p>
        {simbad.state === "ready" && simbad.value && simbad.value.names.length > 0 && (
          <p className="text-micro text-fg-dim">Also {simbad.value.names.join(", ")}</p>
        )}
        {where?.constellation && (
          <p className="text-micro text-fg-dim" data-testid="star-where">
            In <Term k="constellation">{where.constellation}</Term>
            {where.sentence ? `. ${where.sentence}` : ""}
          </p>
        )}
      </motion.header>

      <motion.div {...stagger(1, reduce)} className="flex flex-col gap-2 px-4 pb-4">
        <Button variant="outline" onClick={onWatch} className="h-8 w-fit border-hair-strong text-meta" data-testid="watch-star">
          <ScanSearchIcon aria-hidden />
          {watchLabel}
        </Button>
      </motion.div>

      <Section i={2} title="Gaia DR3" aside={<span className="readout">epoch {epoch.toFixed(2)}</span>} testId="star-gaia">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-meta">
          <Dt>Position</Dt>
          <dd className="readout text-fg">
            {formatRaHms(source.ra, 2)} {formatDecDms(source.dec, 1)}
            <span className="block text-fg-faint">
              {formatDeg(source.ra, 5)} {formatDeg(source.dec, 5, true)}
            </span>
          </dd>
          <Dt>
            <Term k="magnitude">G magnitude</Term>
          </Dt>
          <dd className="readout text-fg">{source.g !== null ? source.g.toFixed(3) : "–"}</dd>
          <Dt>
            <Term k="colourIndex">BP − RP</Term>
          </Dt>
          <dd className="text-fg">
            <span className="readout">{source.bpRp !== null ? source.bpRp.toFixed(3) : "–"}</span>
            {colourWord(source.bpRp) && <span className="text-fg-dim"> · {colourWord(source.bpRp)}</span>}
          </dd>
          <Dt>
            <Term k="parallax" />
          </Dt>
          <dd className="text-fg">
            <span className="readout">
              {source.parallax !== null ? `${source.parallax.toFixed(3)}${source.parallaxErr !== null ? ` ± ${source.parallaxErr.toFixed(3)}` : ""} mas` : "–"}
            </span>
            {ly !== null && (
              <span className="block text-fg-dim">
                about <span className="readout text-fg">{ly < 100 ? ly.toFixed(1) : Math.round(ly).toLocaleString("en-US")}</span>{" "}
                <Term k="lightYear">light-years</Term> away
              </span>
            )}
          </dd>
          <Dt>
            <Term k="properMotion" />
          </Dt>
          <dd className="text-fg">
            <span className="readout">{pm !== null ? `${pm < 0.1 ? (pm * 1000).toFixed(1) + " mas/yr" : pm.toFixed(3) + "″/yr"}` : "–"}</span>
            {pa !== null && pm !== null && (
              <span className="text-fg-dim">
                {" "}
                towards <Term k="positionAngle">PA</Term> <span className="readout text-fg">{pa.toFixed(1)}°</span>
              </span>
            )}
            {source.pmra !== null && source.pmdec !== null && (
              <span className="readout block text-fg-faint">
                μα* {source.pmra.toFixed(2)}, μδ {source.pmdec.toFixed(2)} mas/yr
              </span>
            )}
          </dd>
          {source.rv !== null && (
            <>
              <Dt>Radial velocity</Dt>
              <dd className="readout text-fg">{source.rv.toFixed(2)} km/s</dd>
            </>
          )}
          {source.teff !== null && (
            <>
              <Dt>Temperature</Dt>
              <dd className="text-fg">
                <span className="readout">{Math.round(source.teff).toLocaleString("en-US")} K</span>
                <span className="text-fg-dim"> (GSP-Phot)</span>
              </dd>
            </>
          )}
          {source.ruwe !== null && (
            <>
              <Dt>RUWE</Dt>
              <dd className="text-fg">
                <span className="readout">{source.ruwe.toFixed(2)}</span>
                <span className="text-fg-dim">{source.ruwe > 1.4 ? " · the fit is poor; maybe a binary" : " · a clean single-star fit"}</span>
              </dd>
            </>
          )}
          {source.variable && source.variable !== "NOT_AVAILABLE" && (
            <>
              <Dt>
                <Term k="variableStar">Variability</Term>
              </Dt>
              <dd className="text-fg">{source.variable === "VARIABLE" ? "Flagged variable by Gaia" : source.variable.toLowerCase()}</dd>
            </>
          )}
        </dl>
        <p className="text-micro text-fg-faint">
          From {via}. Gaia measures positions for 2016.0; this one is moved to {epoch.toFixed(2)} with its proper motion.
        </p>
      </Section>

      <Section i={3} title="SIMBAD" testId="star-simbad">
        {simbad.state === "loading" && <Skeleton className="h-10 w-full bg-ink-3" />}
        {simbad.state === "error" && <p className="text-meta text-fg-dim">SIMBAD (CfA mirror) did not answer ({simbad.message}).</p>}
        {simbad.state === "ready" &&
          (simbad.value ? (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-meta">
              <Dt>Name</Dt>
              <dd className="text-fg">{simbad.value.mainId}</dd>
              <Dt>Type</Dt>
              <dd className="text-fg">
                {simbad.value.otypeText ?? "–"} {simbad.value.otype && <span className="readout text-fg-faint">({simbad.value.otype})</span>}
              </dd>
              {simbad.value.spType && (
                <>
                  <Dt>
                    <Term k="spectralType" />
                  </Dt>
                  <dd className="readout text-fg">{simbad.value.spType}</dd>
                </>
              )}
              <Dt>Entry</Dt>
              <dd>
                <a
                  href={simbad.value.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex items-center gap-1 text-fg-dim underline decoration-hair-strong underline-offset-4 hover:text-fg"
                >
                  Open in SIMBAD <ArrowUpRightIcon className="size-3" aria-hidden />
                </a>
              </dd>
            </dl>
          ) : (
            <p className="text-meta text-fg-dim">
              SIMBAD has no entry for this Gaia source: most faint stars have never been studied on their own.
            </p>
          ))}
      </Section>

      <Section i={4} title="SPHEREx here" testId="star-spherex">
        {fieldCoverage && (
          <p className="text-meta text-fg">
            In the loaded field: <span className="readout">{fieldCoverage.length}</span>{" "}
            <Term k="epoch">epochs</Term>, <span className="readout">{fieldCoverage.reduce((n, e) => n + e.n_exposures, 0)}</span>{" "}
            exposures across the six <Term k="detector">detectors</Term>.
          </p>
        )}
        {coverage.state === "off" && !fieldCoverage && (
          <p className="text-meta text-fg-dim" data-testid="coverage-off">
            Coverage for any point comes from the Planet X Hunter backend, which this page is not connected to.
          </p>
        )}
        {coverage.state === "loading" && <Skeleton className="h-9 w-full bg-ink-3" />}
        {coverage.state === "error" && <p className="text-meta text-fg-dim">The coverage search failed ({coverage.message}).</p>}
        {coverage.state === "ready" && (
          <CoverageRows coverage={coverage.value} />
        )}
      </Section>

      <Section i={5} title="Quick-look spectrum" testId="panel-quicklook">
        {spectrum.state === "off" && (
          <p className="text-meta text-fg-dim" data-testid="quicklook-off">
            The spectrum at any point is read from the SPHEREx DR1 all-sky cube by the Planet X Hunter backend. It is not
            connected to this page, so no spectrum is shown rather than a made-up one.
          </p>
        )}
        {spectrum.state === "loading" && (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-40 w-full bg-ink-3" />
            <p className="text-micro text-fg-faint">Reading 102 wavelengths from the DR1 cube…</p>
          </div>
        )}
        {spectrum.state === "error" && <p className="text-meta text-fg-dim">The quick-look spectrum could not be read ({spectrum.message}).</p>}
        {spectrum.state === "ready" && (
          <>
            <SpectrumChart
              spectrum={{
                points: [],
                quicklook: { wl_um: spectrum.value.wl_um, flux_ujy: spectrum.value.flux_ujy, label: spectrum.value.label },
                notes: [],
              }}
              epochLabel={() => ""}
            />
            <p className="text-micro text-fg-faint">
              SPHEREx DR1 cube, {spectrum.value.pixel_arcsec ? `${spectrum.value.pixel_arcsec.toFixed(1)}″` : "12.9″"} pixels: close
              neighbours blend into this <Term k="spectrum">spectrum</Term>.
            </p>
          </>
        )}
      </Section>
    </div>
  );
}

function CoverageRows({ coverage }: { coverage: SpherexCoverage }) {
  if (coverage.nImages === 0) return <p className="text-meta text-fg-dim">SPHEREx has not released any images of this point yet.</p>;
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-meta text-fg">
        <span className="readout">{coverage.nImages}</span> images in <span className="readout">{coverage.nEpochs}</span>{" "}
        <Term k="epoch">epochs</Term>
        {coverage.deepField ? (
          <>
            , in a <Term k="deepField">deep field</Term>
          </>
        ) : null}
        .
      </p>
      <div className="flex items-end gap-1" aria-label="Images per detector">
        {["D1", "D2", "D3", "D4", "D5", "D6"].map((d) => {
          const n = coverage.detectors[d] ?? 0;
          return (
            <div key={d} className="flex w-8 flex-col items-center gap-0.5">
              <span className="readout text-micro text-fg-dim">{n}</span>
              <span aria-hidden className="block w-full rounded-[1px] bg-fg-dim/60" style={{ height: Math.max(2, Math.min(24, Math.sqrt(n) * 4)) }} />
              <span className="text-micro text-fg-faint">{d}</span>
            </div>
          );
        })}
      </div>
      <p className="text-micro text-fg-faint">{coverage.collections.join(", ")} at IRSA</p>
    </div>
  );
}

function Dt({ children }: { children: React.ReactNode }) {
  return <dt className="text-fg-dim">{children}</dt>;
}

function Section({ i, title, aside, children, testId }: { i: number; title: string; aside?: React.ReactNode; children: React.ReactNode; testId?: string }) {
  const reduce = useReducedMotion();
  return (
    <motion.section {...stagger(i, reduce)} className="flex flex-col gap-2.5 border-t border-hair px-4 py-3.5" data-testid={testId}>
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-ui font-medium text-fg">{title}</h3>
        {aside && <div className="text-micro text-fg-faint">{aside}</div>}
      </div>
      {children}
    </motion.section>
  );
}
