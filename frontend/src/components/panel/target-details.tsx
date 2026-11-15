"use client";
// Panel content for a selected target: what it is, where it is now (and was in J2000), where the
// data came from, measured vs catalogue motion, spectrum, light curve, checks, warnings, links.

import { CheckIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import type { FieldManifest, TargetKind } from "@/lib/manifest";
import type { FeaturedTarget } from "@/lib/targets";
import {
  formatDay,
  formatDecDms,
  formatDeg,
  formatRaHms,
  mjdToEpoch,
  propagate,
  separationDeg,
} from "@/lib/lab-coords";
import { Skeleton } from "@/components/ui/skeleton";
import { PanelSection, Row, Rows } from "@/components/panel/detail-panel";
import { MotionCompass } from "@/components/panel/motion-compass";
import { SpectrumChart } from "@/components/panel/spectrum-chart";
import { LightCurveChart } from "@/components/panel/lightcurve-chart";
import { defaultLinks, LinkList } from "@/components/panel/links";

export const KIND_LABEL: Record<TargetKind, string> = {
  "high-pm-star": "High proper-motion star",
  "brown-dwarf": "Brown dwarf",
  "young-variable": "Young variable star",
  "mira-variable": "Mira variable",
  "bright-star": "Bright star",
};

const VERDICT_LABEL = { pass: "Agrees with the catalogue", partial: "Partly agrees", fail: "Does not agree" } as const;

export function TargetDetails({
  featured,
  manifest,
  loading,
  focusDetector,
  currentMjd,
}: {
  featured: FeaturedTarget | null;
  manifest: FieldManifest | null;
  loading: boolean;
  /** 1..6: detector in the blink player (for the light curve). */
  focusDetector: number;
  currentMjd: number | null;
}) {
  const target = manifest?.target ?? null;
  const fixture = manifest?.source === "fixture";
  const name = featured?.name ?? target?.name ?? "Selected field";
  const kind = featured?.kind ?? target?.kind;
  const epochLabel = (index: number) => manifest?.epochs.find((e) => e.index === index)?.label ?? `epoch ${index}`;

  // Positions: now (field centre epoch) and J2000, from the manifest's astrometry when present.
  const astro = target?.astrometry;
  const nowMjd = manifest?.center.epoch_mjd ?? null;
  const now = astro && nowMjd ? propagate(astro, astro.ref_epoch, mjdToEpoch(nowMjd)) : featured ? { ra: featured.ra, dec: featured.dec } : null;
  const j2000 = astro ? propagate(astro, astro.ref_epoch, 2000) : null;
  const moved = now && j2000 ? separationDeg(now, j2000) * 60 : null;
  const motion = manifest?.motion ?? null;

  return (
    <div className="flex flex-col pb-4" data-testid="target-details">
      <header className="flex flex-col gap-1.5 px-5 pt-5 pr-12 pb-4">
        {kind && <p className="text-meta text-fg-dim">{KIND_LABEL[kind]}</p>}
        <h2 className="text-heading text-fg" data-testid="panel-title">
          {name}
        </h2>
        {featured && <p className="text-ui text-fg-dim">{featured.tagline}</p>}
      </header>

      {fixture && (
        <p className="mx-5 mb-4 border-l-2 border-fg-faint pl-3 text-micro text-fg-dim" data-testid="panel-fixture-note">
          The numbers and charts below come from the development fixture. They are synthetic and say nothing about{" "}
          {featured?.name ?? "this object"}.
        </p>
      )}

      {featured && <p className="px-5 pb-4 text-meta text-pretty text-fg-dim">{featured.summary}</p>}

      <PanelSection title="Position" aside={nowMjd ? <span className="readout">Epoch {mjdToEpoch(nowMjd).toFixed(2)}</span> : null}>
        {now ? (
          <Rows>
            <Row label="Now">
              <span className="readout block">
                {formatRaHms(now.ra)} {formatDecDms(now.dec)}
              </span>
              <span className="readout block text-fg-dim">
                {formatDeg(now.ra)} {formatDeg(now.dec, 5, true)}
              </span>
            </Row>
            {j2000 && (
              <Row label="J2000">
                <span className="readout block text-fg-dim">
                  {formatRaHms(j2000.ra)} {formatDecDms(j2000.dec)}
                </span>
              </Row>
            )}
            {moved !== null && moved > 0.05 && (
              <Row label="Since 2000">
                Moved <span className="readout">{moved.toFixed(2)}′</span> across the sky
              </Row>
            )}
            {astro && (
              <Row label="Astrometry">
                <span className="text-fg-dim">{astro.source}</span>
              </Row>
            )}
          </Rows>
        ) : (
          <Skeleton className="h-10 w-full bg-ink-3" />
        )}
      </PanelSection>

      {loading && !manifest && (
        <div className="flex flex-col gap-3 border-t border-hair px-5 py-4">
          <Skeleton className="h-4 w-32 bg-ink-3" />
          <Skeleton className="h-36 w-full bg-ink-3" />
        </div>
      )}

      {manifest && (
        <>
          <PanelSection title="Motion" testId="panel-motion" aside={motion?.verdict ? VERDICT_LABEL[motion.verdict] : null}>
            {motion?.fit || motion?.catalog ? (
              <div className="flex flex-col gap-3">
                <div className="flex items-center gap-5">
                  <MotionCompass measured={motion.fit} catalog={motion.catalog} />
                  <dl className="flex min-w-0 flex-col gap-3 text-meta">
                    {motion.fit && (
                      <div>
                        <dt className="text-fg-dim">Measured</dt>
                        <dd className="readout whitespace-nowrap text-accent">
                          {motion.fit.total_arcsec_yr.toFixed(2)} ± {motion.fit.total_err.toFixed(2)}″/yr
                        </dd>
                        <dd className="readout text-fg-dim">PA {motion.fit.pa_deg.toFixed(1)}°</dd>
                      </div>
                    )}
                    {motion.catalog && (
                      <div>
                        <dt className="text-fg-dim">{motion.catalog.source}</dt>
                        <dd className="readout whitespace-nowrap text-fg">{motion.catalog.total_arcsec_yr.toFixed(2)}″/yr</dd>
                        <dd className="readout text-fg-dim">PA {motion.catalog.pa_deg.toFixed(1)}°</dd>
                      </div>
                    )}
                  </dl>
                </div>
                {motion.fit && (
                  <table className="w-full text-meta">
                    <caption className="sr-only">Proper motion components in milliarcseconds per year</caption>
                    <thead>
                      <tr className="text-left text-micro text-fg-faint">
                        <th scope="col" className="pb-1 font-normal">
                          mas/yr
                        </th>
                        <th scope="col" className="pb-1 text-right font-normal">
                          μα cos δ
                        </th>
                        <th scope="col" className="pb-1 text-right font-normal">
                          μδ
                        </th>
                      </tr>
                    </thead>
                    <tbody className="readout">
                      <tr>
                        <th scope="row" className="py-0.5 text-left font-sans font-normal text-fg-dim">
                          Measured
                        </th>
                        <td className="text-right text-fg">
                          {motion.fit.pmra.toFixed(0)} ± {motion.fit.pmra_err.toFixed(0)}
                        </td>
                        <td className="text-right text-fg">
                          {motion.fit.pmdec.toFixed(0)} ± {motion.fit.pmdec_err.toFixed(0)}
                        </td>
                      </tr>
                      {motion.catalog && (
                        <tr>
                          <th scope="row" className="py-0.5 text-left font-sans font-normal text-fg-dim">
                            Catalogue
                          </th>
                          <td className="text-right text-fg-dim">{motion.catalog.pmra.toFixed(0)}</td>
                          <td className="text-right text-fg-dim">{motion.catalog.pmdec.toFixed(0)}</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                )}
                <p className="text-meta text-fg">{motion.verdict_text}</p>
                <p className="text-micro text-fg-faint">Method: {motion.method}</p>
              </div>
            ) : (
              <p className="text-meta text-fg-dim">No motion was measured for this field.</p>
            )}
          </PanelSection>

          <PanelSection title="Spectrum" testId="panel-spectrum">
            {manifest.spectrum && manifest.spectrum.points.length > 0 ? (
              <>
                <SpectrumChart spectrum={manifest.spectrum} epochLabel={epochLabel} />
                {manifest.spectrum.notes.map((note) => (
                  <p key={note} className="text-micro text-fg-faint">
                    {note}
                  </p>
                ))}
              </>
            ) : (
              <p className="text-meta text-fg-dim">No spectrum was measured for this field.</p>
            )}
          </PanelSection>

          <PanelSection title="Brightness over time" testId="panel-lightcurve">
            {manifest.lightcurve && manifest.lightcurve.epoch_photometry.length > 0 ? (
              <>
                <LightCurveChart lightcurve={manifest.lightcurve} detector={focusDetector} currentMjd={currentMjd} />
                {manifest.lightcurve.variability && (
                  <p className="text-meta text-fg-dim">
                    {manifest.lightcurve.variability.significant ? "Significant variability: " : "No significant variability: "}
                    largest change <span className="readout text-fg">{manifest.lightcurve.variability.max_delta_mag.toFixed(2)}</span> mag,
                    χ²/dof <span className="readout text-fg">{manifest.lightcurve.variability.chi2_dof.toFixed(1)}</span>.
                  </p>
                )}
              </>
            ) : (
              <p className="text-meta text-fg-dim">No epoch photometry for this field.</p>
            )}
          </PanelSection>

          {(manifest.checks.length > 0 || manifest.warnings.length > 0) && (
            <PanelSection title="Checks and warnings" testId="panel-checks">
              {manifest.checks.length > 0 && (
                <ul className="flex flex-col gap-1.5">
                  {manifest.checks.map((check) => (
                    <li key={check.name} className="grid grid-cols-[1rem_1fr] gap-x-2 text-meta">
                      {check.pass ? (
                        <CheckIcon className="mt-0.5 size-3.5 text-fg-dim" aria-label="Passed" />
                      ) : (
                        <XIcon className="mt-0.5 size-3.5 text-destructive" aria-label="Failed" />
                      )}
                      <span className="text-fg">
                        {check.name}
                        <span className="readout block text-micro text-fg-dim">{check.value}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {manifest.warnings.length > 0 && (
                <ul className="flex flex-col gap-1.5">
                  {manifest.warnings.map((warning) => (
                    <li key={warning} className="grid grid-cols-[1rem_1fr] gap-x-2 text-meta text-fg-dim">
                      <TriangleAlertIcon className="mt-0.5 size-3.5 text-fg-faint" aria-hidden />
                      {warning}
                    </li>
                  ))}
                </ul>
              )}
            </PanelSection>
          )}

          <PanelSection title="Data" testId="panel-provenance">
            <Rows>
              <Row label="Collections">
                <span className="readout">{manifest.release.collections.join(", ")}</span>
              </Row>
              <Row label="File tags">
                <span className="readout break-words text-fg-dim">{manifest.release.file_tags.join(", ")}</span>
              </Row>
              <Row label="Latest image">
                <span className="readout">{manifest.release.latest_obs}</span>
              </Row>
              <Row label="Epochs">
                {manifest.epochs.length}
                {manifest.epochs.some((e) => !e.full) ? `, ${manifest.epochs.filter((e) => !e.full).length} partial` : ""}
              </Row>
              <Row label="Grid">
                <span className="readout">
                  {manifest.grid.width} × {manifest.grid.height} px, {manifest.grid.pixscale_arcsec}″
                </span>
              </Row>
              <Row label="Built">
                <span className="readout text-fg-dim">{formatBuilt(manifest.generated_at)}</span>
              </Row>
            </Rows>
            {manifest.render?.note && <p className="text-micro text-fg-faint">Display: {manifest.render.note}</p>}
            <p className="text-micro text-fg-faint">
              {manifest.credits} Sky viewer: Aladin Lite (CDS).
            </p>
          </PanelSection>
        </>
      )}

      <PanelSection title="Look it up elsewhere">
        <LinkList
          links={
            manifest?.links.length
              ? manifest.links
              : now
                ? defaultLinks(now.ra, now.dec, fixture ? null : (target?.simbad_id ?? featured?.name ?? null))
                : []
          }
        />
      </PanelSection>
    </div>
  );
}

function formatBuilt(iso: string) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return `${formatDay(t / 86_400_000 + 40587)}, ${new Date(t).toISOString().slice(11, 16)} UTC`;
}

