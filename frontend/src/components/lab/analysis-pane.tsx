"use client";
// The workbench's right "Analysis" pane. Tabs: Object (who or what is selected, from the
// catalogues), Spectrum, Light curve, Motion, Data (the photometry table, with CSV) and
// Provenance (release, file tags, flags, checks, links). The pane is docked: it never closes on
// pan or zoom, keeps its own scroll, and animates between objects.

import { useMemo, useState, type ReactNode } from "react";
import { ArrowDownIcon, ArrowUpIcon, CheckIcon, DownloadIcon, MousePointerClickIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { DetectorKey, FieldManifest } from "@/lib/manifest";
import type { FeaturedTarget } from "@/lib/targets";
import type { GaiaSource } from "@/lib/lab-catalog";
import { downloadText, toCsv } from "@/lib/lab-catalog";
import { DETECTOR_KEYS } from "@/lib/lab-field";
import { formatDay, mjdToEpoch, offsetArcsec, propagate } from "@/lib/lab-coords";
import { cn } from "@/lib/utils";
import { Term } from "@/components/ui/term";
import { SpectralClassView } from "@/components/panel/spectral-class";
import { catalogueClass, useSpectralClass } from "@/lib/spectral-class";
import { TargetDetails } from "@/components/panel/target-details";
import { PositionDetails } from "@/components/panel/position-details";
import { StarDetails } from "@/components/panel/star-details";
import { SpectrumChart } from "@/components/panel/spectrum-chart";
import { LightCurveChart } from "@/components/panel/lightcurve-chart";
import { MotionCompass } from "@/components/panel/motion-compass";
import { LinkList, defaultLinks } from "@/components/panel/links";

export type AnalysisTab = "object" | "spectrum" | "lightcurve" | "motion" | "data" | "provenance";

export const ANALYSIS_TABS: { value: AnalysisTab; label: string }[] = [
  { value: "object", label: "Object" },
  { value: "spectrum", label: "Spectrum" },
  { value: "lightcurve", label: "Light curve" },
  { value: "motion", label: "Motion" },
  { value: "data", label: "Data" },
  { value: "provenance", label: "Provenance" },
];

export type Selection =
  | { kind: "target" }
  | { kind: "star"; source: GaiaSource; epoch: number; via: string }
  | { kind: "position"; ra: number; dec: number }
  | null;

export interface AnalysisPaneProps {
  selection: Selection;
  tab: AnalysisTab;
  onTab: (tab: AnalysisTab) => void;
  featured: FeaturedTarget | null;
  manifest: FieldManifest | null;
  loading: boolean;
  focusDetector: number;
  currentMjd: number | null;
  watchFieldArcmin: number;
  onWatchPosition: (ra: number, dec: number) => void;
  onWatchStar: (source: GaiaSource) => void;
  onPickTarget: (slug: string) => void;
  onClose: () => void;
  /** Phones: the close button returns to the viewer. */
  closeLabel?: string;
  fieldTitle: string;
  hint: boolean;
}

export function AnalysisPane(props: AnalysisPaneProps) {
  const { selection, tab, onTab, manifest } = props;
  const reduce = useReducedMotion();
  const contentKey =
    selection?.kind === "star"
      ? `star:${selection.source.id}`
      : selection?.kind === "position"
        ? `pos:${selection.ra},${selection.dec}`
        : selection?.kind === "target"
          ? `target:${props.featured?.slug ?? manifest?.generated_at ?? ""}`
          : "none";

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="detail-panel" aria-label="Analysis" role="region" data-detail-panel>
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-hair pr-1 pl-2">
        <div role="tablist" aria-label="Analysis" className="flex min-w-0 flex-1 items-center overflow-x-auto [mask-image:linear-gradient(to_right,black_calc(100%-16px),transparent)] pr-3 [scrollbar-width:none]">
          {ANALYSIS_TABS.map((t) => {
            const active = t.value === tab;
            return (
              <button
                key={t.value}
                type="button"
                role="tab"
                id={`analysis-tab-${t.value}`}
                aria-selected={active}
                aria-controls="analysis-panel"
                tabIndex={active ? 0 : -1}
                data-testid={`analysis-tab-${t.value}`}
                onClick={() => onTab(t.value)}
                onKeyDown={(e) => {
                  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
                  e.preventDefault();
                  const i = ANALYSIS_TABS.findIndex((x) => x.value === tab);
                  const next = ANALYSIS_TABS[(i + (e.key === "ArrowRight" ? 1 : ANALYSIS_TABS.length - 1)) % ANALYSIS_TABS.length];
                  onTab(next.value);
                  document.getElementById(`analysis-tab-${next.value}`)?.focus();
                }}
                className={cn(
                  "relative h-7 shrink-0 rounded-[5px] px-1.5 text-micro whitespace-nowrap text-fg-dim transition-colors duration-150 hover:text-fg",
                  active && "text-fg",
                )}
              >
                {active && (
                  <motion.span
                    aria-hidden
                    layoutId="analysis-tab"
                    className="absolute inset-0 rounded-[5px] bg-white/[0.07]"
                    transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 560, damping: 42, mass: 0.6 }}
                  />
                )}
                <span className="relative">{t.label}</span>
              </button>
            );
          })}
        </div>
        {selection && (
          <button
            type="button"
            onClick={props.onClose}
            aria-label={props.closeLabel ?? "Clear the selection"}
            aria-keyshortcuts="Escape"
            data-testid="panel-close"
            className="grid size-7 shrink-0 place-items-center rounded-[5px] text-fg-dim transition-colors hover:bg-white/[0.06] hover:text-fg"
          >
            <XIcon className="size-4" aria-hidden />
          </button>
        )}
      </div>
      <div
        id="analysis-panel"
        role="tabpanel"
        aria-labelledby={`analysis-tab-${tab}`}
        data-lenis-prevent
        className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain"
      >
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={`${tab}|${contentKey}`}
            initial={reduce ? false : { opacity: 0, x: 14 }}
            animate={{ opacity: 1, x: 0 }}
            exit={reduce ? undefined : { opacity: 0, x: -10 }}
            transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
            className="min-h-full"
            data-testid="panel-focus-target"
            tabIndex={-1}
          >
            <TabContent {...props} />
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}

function TabContent(props: AnalysisPaneProps) {
  const { selection, tab, manifest } = props;
  if (tab === "object") return <ObjectTab {...props} />;
  if (!manifest) {
    return (
      <Empty>
        {props.loading ? "Loading the field…" : "Load a field (pick a target or search a position) to see its measurements here."}
      </Empty>
    );
  }
  const epochLabel = (index: number) => manifest.epochs.find((e) => e.index === index)?.label ?? `epoch ${index}`;
  if (tab === "spectrum") return <SpectrumTab manifest={manifest} epochLabel={epochLabel} starSelected={selection?.kind === "star"} selection={selection} />;
  if (tab === "lightcurve") return <LightCurveTab manifest={manifest} focusDetector={props.focusDetector} currentMjd={props.currentMjd} />;
  if (tab === "motion") return <MotionTab manifest={manifest} epochLabel={epochLabel} />;
  if (tab === "data") return <DataTab manifest={manifest} epochLabel={epochLabel} />;
  return <ProvenanceTab manifest={manifest} />;
}

function ObjectTab(props: AnalysisPaneProps) {
  const { selection, manifest } = props;
  if (selection?.kind === "star") {
    const inField = Boolean(manifest);
    return (
      <StarDetails
        source={selection.source}
        epoch={selection.epoch}
        via={selection.via}
        manifest={manifest}
        onWatch={() => props.onWatchStar(selection.source)}
        watchLabel={inField ? "Watch this star blink" : "Build this star's frames"}
      />
    );
  }
  if (selection?.kind === "position") {
    return (
      <PositionDetails
        ra={selection.ra}
        dec={selection.dec}
        watchFieldArcmin={props.watchFieldArcmin}
        onWatch={() => props.onWatchPosition(selection.ra, selection.dec)}
        onPickTarget={props.onPickTarget}
      />
    );
  }
  if (selection?.kind === "target") {
    return (
      <TargetDetails
        featured={props.featured}
        manifest={manifest}
        loading={props.loading}
        focusDetector={props.focusDetector}
        currentMjd={props.currentMjd}
      />
    );
  }
  return (
    <div className="flex flex-col gap-3 px-4 py-5" data-testid="analysis-empty">
      <MousePointerClickIcon className="size-5 text-fg-faint" aria-hidden />
      <p className="text-ui text-fg">Click any star to learn about it.</p>
      <p className="text-meta text-pretty text-fg-dim">
        Zoom in below 30′ and the <Term k="gaia">Gaia DR3</Term> stars in view appear as small circles. Clicking one
        shows its catalogue measurements, its SIMBAD entry, what SPHEREx has observed there
        and its spectrum. Clicking empty sky describes that position.
      </p>
      {manifest && (
        <p className="text-meta text-fg-dim">
          Loaded: <span className="text-fg">{props.fieldTitle}</span>, <span className="readout">{manifest.epochs.length}</span> epochs.
        </p>
      )}
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="px-4 py-5 text-meta text-pretty text-fg-dim">{children}</p>;
}

function Toolbar({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2 border-b border-hair px-4 py-2">{children}</div>;
}

function ExportButton({ label, onClick, testId }: { label: string; onClick: () => void; testId?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      className="inline-flex h-6 items-center gap-1.5 rounded-[5px] border border-hair px-2 text-micro text-fg-dim transition-colors hover:bg-white/[0.06] hover:text-fg"
    >
      <DownloadIcon className="size-3" aria-hidden />
      {label}
    </button>
  );
}

function slugOf(manifest: FieldManifest) {
  return (manifest.target?.key ?? `field-${manifest.center.ra.toFixed(3)}_${manifest.center.dec.toFixed(3)}`).replace(/[^a-z0-9_.-]+/gi, "-");
}

export function exportSpectrumCsv(manifest: FieldManifest) {
  const pts = manifest.spectrum?.points ?? [];
  downloadText(
    `${slugOf(manifest)}-spectrum.csv`,
    toCsv(
      ["wavelength_um", "bandwidth_um", "flux_ujy", "flux_err_ujy", "epoch", "detector", "saturated"],
      pts.map((p) => [p.wl_um, p.bw_um, p.flux_ujy, p.err_ujy, p.epoch, `D${p.detector}`, p.saturated]),
    ),
  );
}

export function exportPhotometryCsv(manifest: FieldManifest) {
  const rows = manifest.lightcurve?.epoch_photometry ?? [];
  downloadText(
    `${slugOf(manifest)}-photometry.csv`,
    toCsv(
      ["epoch", "detector", "mjd", "wavelength_um", "flux_ujy", "flux_err_ujy", "mag_ab", "saturated_fraction"],
      rows.map((p) => [p.epoch, `D${p.detector}`, p.mjd, p.wl_um, p.flux_ujy, p.err_ujy, p.mag_ab, p.saturated_frac]),
    ),
  );
}

export function exportPositionsCsv(manifest: FieldManifest) {
  const rows = manifest.motion?.epoch_positions ?? [];
  downloadText(
    `${slugOf(manifest)}-positions.csv`,
    toCsv(
      ["epoch", "mjd", "ra_deg", "dec_deg", "err_mas"],
      rows.map((p) => [p.epoch, p.mjd, p.ra, p.dec, p.err_mas]),
    ),
  );
}

/** Where the Spectrum tab's quick-look classification is read: the selected star or spot, else the target. */
interface ClassPoint {
  ra: number;
  dec: number;
  what: string;
  /** For the target: the class the catalogues give it, to compare with the network's answer. */
  catalogue: { name: string; label: string } | null;
}

function classificationPoint(selection: Selection, manifest: FieldManifest): ClassPoint | null {
  if (selection?.kind === "star") return { ra: selection.source.ra, dec: selection.source.dec, what: "the selected star", catalogue: null };
  if (selection?.kind === "position") return { ra: selection.ra, dec: selection.dec, what: "the selected position", catalogue: null };
  const t = manifest.target;
  const a = t?.astrometry;
  if (!t || !a) return null;
  // The DR1 cube is Year 1 of the survey: move the target there (about 2026.0), as /api/object does.
  const p = propagate({ ra: a.ra, dec: a.dec, pmra: a.pmra ?? 0, pmdec: a.pmdec ?? 0 }, a.ref_epoch, 2026.0);
  const listed = catalogueClass(t.kind);
  return { ...p, what: t.name, catalogue: listed ? { name: t.name, label: listed } : null };
}

function SpectrumClass({ point }: { point: ClassPoint | null }) {
  const cls = useSpectralClass(point);
  if (!point || cls.state === "idle") return null;
  return (
    <section className="flex flex-col gap-2 border-b border-hair px-3 py-3" data-testid="lab-spectral-class" aria-label="What kind of object">
      <h3 className="text-micro text-fg-faint">What kind of object, from the quick-look spectrum at {point.what}</h3>
      {cls.state === "loading" ? (
        <p className="text-micro text-fg-faint">Reading the quick-look spectrum…</p>
      ) : cls.state === "error" ? (
        <p className="text-micro text-fg-faint">{cls.message}</p>
      ) : cls.value ? (
        <SpectralClassView c={cls.value} testId="lab-class" catalogue={point.catalogue} />
      ) : (
        <p className="text-micro text-fg-faint">The DR1 cube has no data here, so there is no class.</p>
      )}
    </section>
  );
}

function SpectrumTab({
  manifest,
  epochLabel,
  starSelected,
  selection,
}: {
  manifest: FieldManifest;
  epochLabel: (i: number) => string;
  starSelected: boolean;
  selection: Selection;
}) {
  const spectrum = manifest.spectrum;
  const epochs = useMemo(() => [...new Set(spectrum?.points.map((p) => p.epoch) ?? [])].sort((a, b) => a - b), [spectrum]);
  const [only, setOnly] = useState<number | null>(null);
  const point = classificationPoint(selection, manifest);
  if (!spectrum || spectrum.points.length === 0) {
    return (
      <div className="flex flex-col" data-testid="tab-spectrum-empty">
        <SpectrumClass point={point} />
        <Empty>
          No spectrum was measured for this field{manifest.target ? "" : ": live fields carry frames only"}.
          {starSelected ? " The selected star's quick-look spectrum is in the Object tab." : " Click a star for its quick-look spectrum."}
        </Empty>
      </div>
    );
  }
  const shown = only === null ? spectrum : { ...spectrum, points: spectrum.points.filter((p) => p.epoch === only) };
  return (
    <div className="flex flex-col" data-testid="tab-spectrum">
      <SpectrumClass point={point} />
      <Toolbar>
        <span className="text-micro text-fg-faint">
          <Term k="epoch">Epoch</Term>
        </span>
        <div role="radiogroup" aria-label="Epochs shown" className="flex flex-wrap gap-1">
          {[null, ...epochs].map((e) => (
            <button
              key={e ?? "all"}
              type="button"
              role="radio"
              aria-checked={only === e}
              onClick={() => setOnly(e)}
              className={cn("h-6 rounded-[5px] px-2 text-micro text-fg-dim ring-1 ring-hair transition-colors hover:text-fg", only === e && "text-fg ring-accent")}
            >
              {e === null ? "All" : epochLabel(e)}
            </button>
          ))}
        </div>
        <div className="ml-auto">
          <ExportButton label="CSV" onClick={() => exportSpectrumCsv(manifest)} testId="export-spectrum" />
        </div>
      </Toolbar>
      <div className="flex flex-col gap-2 px-3 py-3">
        <SpectrumChart spectrum={shown} epochLabel={epochLabel} height={300} />
        <p className="text-micro text-fg-faint">
          Log wavelength axis, linear <Term k="flux">flux</Term>; bars are 1σ. Shaded bands
          are the six detectors. Hollow points are saturated.
        </p>
        {spectrum.notes.map((n) => (
          <p key={n} className="text-micro text-fg-faint">
            {n}
          </p>
        ))}
      </div>
    </div>
  );
}

function LightCurveTab({ manifest, focusDetector, currentMjd }: { manifest: FieldManifest; focusDetector: number; currentMjd: number | null }) {
  const lc = manifest.lightcurve;
  const [detector, setDetector] = useState(focusDetector);
  if (!lc || lc.epoch_photometry.length === 0) return <Empty>No epoch photometry for this field.</Empty>;
  const has = new Set(lc.epoch_photometry.map((p) => p.detector));
  return (
    <div className="flex flex-col" data-testid="tab-lightcurve">
      <Toolbar>
        <span className="text-micro text-fg-faint">
          Detector
        </span>
        <div role="radiogroup" aria-label="Detector in focus" className="flex gap-1">
          {DETECTOR_KEYS.map((d, i) => (
            <button
              key={d}
              type="button"
              role="radio"
              aria-checked={detector === i + 1}
              disabled={!has.has(i + 1)}
              onClick={() => setDetector(i + 1)}
              className={cn(
                "h-6 rounded-[5px] px-2 text-micro text-fg-dim ring-1 ring-hair transition-colors hover:text-fg disabled:opacity-35",
                detector === i + 1 && "text-fg ring-accent",
              )}
            >
              {d}
            </button>
          ))}
        </div>
        <div className="ml-auto">
          <ExportButton label="CSV" onClick={() => exportPhotometryCsv(manifest)} testId="export-photometry" />
        </div>
      </Toolbar>
      <div className="flex flex-col gap-2 px-3 py-3">
        <LightCurveChart lightcurve={lc} detector={detector} currentMjd={currentMjd} height={260} />
        {lc.variability && (
          <p className="text-meta text-fg-dim">
            {lc.variability.significant ? "Significant variability: " : "No significant variability: "}
            largest change <span className="readout text-fg">{lc.variability.max_delta_mag.toFixed(2)}</span>{" "}
            mag, χ²/dof <span className="readout text-fg">{lc.variability.chi2_dof.toFixed(1)}</span>.
          </p>
        )}
        <p className="text-micro text-fg-faint">
          <Term k="abMagnitude">AB magnitudes</Term>, brighter is up. Points only: nothing is known between visits.
        </p>
      </div>
    </div>
  );
}

function MotionTab({ manifest, epochLabel }: { manifest: FieldManifest; epochLabel: (i: number) => string }) {
  const motion = manifest.motion;
  const astro = manifest.target?.astrometry;
  if (!motion || (!motion.fit && !motion.catalog && motion.epoch_positions.length === 0)) {
    return <Empty>No motion was measured for this field.</Empty>;
  }
  const residuals = motion.epoch_positions.map((p) => {
    const predicted = astro ? propagate(astro, astro.ref_epoch, mjdToEpoch(p.mjd)) : null;
    const o = predicted ? offsetArcsec(predicted, p) : null;
    return { ...p, east: o ? o.east * 1000 : null, north: o ? o.north * 1000 : null };
  });
  return (
    <div className="flex flex-col" data-testid="tab-motion">
      <Toolbar>
        <span className="text-micro text-fg-dim">
          <Term k="properMotion" /> measured from the SPHEREx positions
        </span>
        <div className="ml-auto">
          <ExportButton label="Positions CSV" onClick={() => exportPositionsCsv(manifest)} testId="export-positions" />
        </div>
      </Toolbar>
      <div className="flex flex-col gap-4 px-4 py-3">
        {(motion.fit || motion.catalog) && (
          <div className="flex items-center gap-5">
            <MotionCompass measured={motion.fit} catalog={motion.catalog} />
            <dl className="flex min-w-0 flex-col gap-2.5 text-meta">
              {motion.fit && (
                <div>
                  <dt className="text-fg-dim">Measured</dt>
                  <dd className="readout text-accent">
                    {motion.fit.total_arcsec_yr.toFixed(3)} ± {motion.fit.total_err.toFixed(3)}″/yr
                  </dd>
                  <dd className="readout text-fg-dim">
                    <Term k="positionAngle">PA</Term> {motion.fit.pa_deg.toFixed(1)}°
                  </dd>
                </div>
              )}
              {motion.catalog && (
                <div>
                  <dt className="text-fg-dim">{motion.catalog.source}</dt>
                  <dd className="readout text-fg">{motion.catalog.total_arcsec_yr.toFixed(3)}″/yr</dd>
                  <dd className="readout text-fg-dim">PA {motion.catalog.pa_deg.toFixed(1)}°</dd>
                </div>
              )}
            </dl>
          </div>
        )}
        {motion.fit && (
          <table className="w-full text-meta" data-testid="motion-fit-table">
            <caption className="mb-1 text-left text-micro text-fg-faint">Fit, in milliarcseconds per year</caption>
            <thead>
              <tr className="text-left text-micro text-fg-faint">
                <th scope="col" className="pb-1 font-normal" />
                <th scope="col" className="pb-1 text-right font-normal">μα cos δ</th>
                <th scope="col" className="pb-1 text-right font-normal">μδ</th>
              </tr>
            </thead>
            <tbody className="readout">
              <tr>
                <th scope="row" className="py-0.5 text-left font-sans font-normal text-fg-dim">Measured</th>
                <td className="text-right text-fg">{motion.fit.pmra.toFixed(0)} ± {motion.fit.pmra_err.toFixed(0)}</td>
                <td className="text-right text-fg">{motion.fit.pmdec.toFixed(0)} ± {motion.fit.pmdec_err.toFixed(0)}</td>
              </tr>
              {motion.catalog && (
                <tr>
                  <th scope="row" className="py-0.5 text-left font-sans font-normal text-fg-dim">Catalogue</th>
                  <td className="text-right text-fg-dim">{motion.catalog.pmra.toFixed(0)}</td>
                  <td className="text-right text-fg-dim">{motion.catalog.pmdec.toFixed(0)}</td>
                </tr>
              )}
            </tbody>
          </table>
        )}
        {residuals.length > 0 && (
          <div className="flex flex-col gap-2">
            <ResidualPlot residuals={residuals} />
            <table className="w-full text-micro" data-testid="motion-residuals">
              <caption className="mb-1 text-left text-micro text-fg-faint">
                Measured position minus the catalogue position at that date (proper motion only, so parallax remains),
                in mas
              </caption>
              <thead className="text-fg-faint">
                <tr className="text-left">
                  <th scope="col" className="font-normal">Epoch</th>
                  <th scope="col" className="text-right font-normal">East</th>
                  <th scope="col" className="text-right font-normal">North</th>
                  <th scope="col" className="text-right font-normal">±</th>
                </tr>
              </thead>
              <tbody className="readout text-fg-dim">
                {residuals.map((r) => (
                  <tr key={r.epoch} className="border-t border-hair/60">
                    <td className="py-0.5 font-sans">{epochLabel(r.epoch)}</td>
                    <td className="text-right text-fg">{r.east === null ? "–" : r.east.toFixed(0)}</td>
                    <td className="text-right text-fg">{r.north === null ? "–" : r.north.toFixed(0)}</td>
                    <td className="text-right">{r.err_mas.toFixed(0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-meta text-fg">{motion.verdict_text}</p>
        <p className="text-micro text-fg-faint">Method: {motion.method}</p>
      </div>
    </div>
  );
}

/** Residuals on the sky (east left, north up) with 1-sigma circles. */
function ResidualPlot({ residuals }: { residuals: { epoch: number; east: number | null; north: number | null; err_mas: number }[] }) {
  const pts = residuals.filter((r) => r.east !== null && r.north !== null) as { epoch: number; east: number; north: number; err_mas: number }[];
  if (!pts.length) return null;
  const lim = Math.max(200, ...pts.map((p) => Math.max(Math.abs(p.east), Math.abs(p.north)) + p.err_mas)) * 1.15;
  const s = 70 / lim;
  return (
    <svg viewBox="-80 -80 160 160" className="mx-auto h-40 w-40" role="img" aria-label="Position residuals on the sky, north up and east left">
      <circle r={70} fill="none" stroke="var(--hair)" />
      <line x1={-74} x2={74} y1={0} y2={0} stroke="var(--hair)" />
      <line y1={-74} y2={74} x1={0} x2={0} stroke="var(--hair)" />
      <text x={0} y={-74} textAnchor="middle" fontSize={9} fill="var(--fg-faint)">N</text>
      <text x={-76} y={3} textAnchor="end" fontSize={9} fill="var(--fg-faint)">E</text>
      {pts.map((p) => (
        <g key={p.epoch} transform={`translate(${-p.east * s} ${-p.north * s})`}>
          <circle r={Math.max(1.5, p.err_mas * s)} fill="var(--accent-faint)" stroke="var(--accent-muted)" />
          <circle r={2} fill="var(--accent)" />
        </g>
      ))}
      <text x={74} y={76} textAnchor="end" fontSize={9} fill="var(--fg-faint)">±{Math.round(lim)} mas</text>
    </svg>
  );
}

type PhotKey = "epoch" | "detector" | "mjd" | "flux" | "mag";

function DataTab({ manifest, epochLabel }: { manifest: FieldManifest; epochLabel: (i: number) => string }) {
  const rows = useMemo(() => manifest.lightcurve?.epoch_photometry ?? [], [manifest]);
  const [sort, setSort] = useState<{ key: PhotKey; dir: 1 | -1 }>({ key: "mjd", dir: 1 });
  const sorted = useMemo(() => {
    const get = (p: (typeof rows)[number]) =>
      sort.key === "epoch" ? p.epoch : sort.key === "detector" ? p.detector : sort.key === "mjd" ? p.mjd : sort.key === "flux" ? p.flux_ujy : p.mag_ab;
    return [...rows].sort((a, b) => sort.dir * (get(a) - get(b)));
  }, [rows, sort]);
  const th = (key: PhotKey, label: ReactNode, right = false) => (
    <th scope="col" aria-sort={sort.key === key ? (sort.dir > 0 ? "ascending" : "descending") : "none"} className={cn("py-1 font-normal", right && "text-right")}>
      <button type="button" onClick={() => setSort((s) => ({ key, dir: s.key === key ? ((-s.dir) as 1 | -1) : 1 }))} className="inline-flex items-center gap-0.5 hover:text-fg">
        {label}
        {sort.key === key && (sort.dir > 0 ? <ArrowUpIcon className="size-3" aria-hidden /> : <ArrowDownIcon className="size-3" aria-hidden />)}
      </button>
    </th>
  );
  return (
    <div className="flex flex-col" data-testid="tab-data">
      <Toolbar>
        <span className="text-micro text-fg-dim">
          <span className="readout text-fg">{rows.length}</span> photometry points
        </span>
        <div className="ml-auto flex flex-wrap gap-1.5">
          <ExportButton label="Photometry" onClick={() => exportPhotometryCsv(manifest)} testId="export-photometry-data" />
          {manifest.spectrum?.points.length ? <ExportButton label="Spectrum" onClick={() => exportSpectrumCsv(manifest)} /> : null}
          {manifest.motion?.epoch_positions.length ? <ExportButton label="Positions" onClick={() => exportPositionsCsv(manifest)} /> : null}
        </div>
      </Toolbar>
      {rows.length === 0 ? (
        <Empty>No photometry for this field. Live fields carry frames only; the five prepared targets carry measurements.</Empty>
      ) : (
        <div className="px-3 py-2">
          <p className="pb-2 text-micro text-pretty text-fg-faint">
            One row per <Term k="epoch">epoch</Term> and detector: <Term k="flux">flux</Term> in
            microjanskys with its 1σ error, the same as an AB magnitude, and the share of the
            star&apos;s pixels that were saturated. Click a heading to sort.
          </p>
          <table className="w-full text-micro" data-testid="photometry-table">
            <caption className="sr-only">Epoch photometry: one row per epoch and detector</caption>
            <thead className="sticky top-0 bg-ink text-fg-faint">
              <tr className="border-b border-hair text-left">
                {th("epoch", "Epoch")}
                {th("detector", "Det.")}
                {th("mjd", "Date")}
                {th("flux", "Flux µJy", true)}
                {th("mag", "AB mag", true)}
                <th scope="col" className="py-1 text-right font-normal">
                  Sat.
                </th>
              </tr>
            </thead>
            <tbody className="readout">
              {sorted.map((p) => (
                <tr key={`${p.epoch}-${p.detector}`} className="border-b border-hair/50 text-fg-dim hover:bg-white/[0.03]">
                  <td className="py-0.5 font-sans">{epochLabel(p.epoch)}</td>
                  <td>D{p.detector}</td>
                  <td>{formatDay(p.mjd)}</td>
                  <td className="text-right text-fg">
                    {formatFlux(p.flux_ujy)} <span className="text-fg-faint">±{formatFlux(p.err_ujy)}</span>
                  </td>
                  <td className="text-right text-fg">{p.mag_ab.toFixed(3)}</td>
                  <td className="text-right">{Math.round(p.saturated_frac * 100)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function formatFlux(v: number) {
  if (Math.abs(v) >= 1e5) return v.toExponential(2);
  if (Math.abs(v) >= 100) return v.toFixed(0);
  return v.toFixed(1);
}

function ProvenanceTab({ manifest }: { manifest: FieldManifest }) {
  const flags = manifest.frames.flags;
  const legend = flags[0]?.legend ?? {};
  const links = manifest.links.length ? manifest.links : defaultLinks(manifest.center.ra, manifest.center.dec, manifest.target?.simbad_id ?? null);
  return (
    <div className="flex flex-col gap-0" data-testid="tab-provenance">
      <Block title="Data release">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-meta">
          <dt className="text-fg-dim">Collections</dt>
          <dd className="readout text-fg">{manifest.release.collections.join(", ")}</dd>
          <dt className="text-fg-dim">Latest image</dt>
          <dd className="readout text-fg">{manifest.release.latest_obs}</dd>
          {manifest.release.discovered_at && (
            <>
              <dt className="text-fg-dim">Checked</dt>
              <dd className="readout text-fg-dim">{manifest.release.discovered_at.replace("T", " ").replace("Z", " UTC")}</dd>
            </>
          )}
          <dt className="text-fg-dim">Source</dt>
          <dd className="text-fg">{manifest.source === "bundle" ? "Prepared bundle" : manifest.source === "live" ? "Built live by the backend" : "Development fixture (synthetic)"}</dd>
          <dt className="text-fg-dim">Grid</dt>
          <dd className="readout text-fg">
            {manifest.grid.width} × {manifest.grid.height} px, {manifest.grid.pixscale_arcsec}″/px
          </dd>
        </dl>
      </Block>
      <Block title="File tags">
        <p className="readout text-micro break-words text-fg-dim">{manifest.release.file_tags.join(", ") || "–"}</p>
      </Block>
      <Block title="Flags">
        <p className="text-meta text-fg-dim">
          <span className="readout text-fg">{flags.length}</span> flag overlays from the official SPHEREx pixel masks.
        </p>
        <ul className="flex flex-wrap gap-x-4 gap-y-1">
          {Object.entries(legend).map(([name, colour]) => (
            <li key={name} className="flex items-center gap-1.5 text-micro text-fg-dim">
              <span aria-hidden className="block size-2.5 rounded-[2px]" style={{ backgroundColor: colour }} />
              {name.charAt(0).toUpperCase() + name.slice(1)}
            </li>
          ))}
        </ul>
        {manifest.render?.note && <p className="text-micro text-fg-faint">{manifest.render.note}</p>}
      </Block>
      {(manifest.checks.length > 0 || manifest.warnings.length > 0) && (
        <Block title="Checks and warnings">
          <ul className="flex flex-col gap-1.5">
            {manifest.checks.map((c) => (
              <li key={c.name} className="grid grid-cols-[1rem_1fr] gap-x-2 text-meta">
                {c.pass ? <CheckIcon className="mt-0.5 size-3.5 text-fg-dim" aria-label="Passed" /> : <XIcon className="mt-0.5 size-3.5 text-destructive" aria-label="Failed" />}
                <span className="text-fg">
                  {c.name}
                  <span className="readout block text-micro text-fg-dim">{c.value}</span>
                </span>
              </li>
            ))}
            {manifest.warnings.map((w) => (
              <li key={w} className="grid grid-cols-[1rem_1fr] gap-x-2 text-meta text-fg-dim">
                <TriangleAlertIcon className="mt-0.5 size-3.5 text-fg-faint" aria-hidden />
                {w}
              </li>
            ))}
          </ul>
        </Block>
      )}
      <Block title="Credits and links">
        <p className="text-micro text-fg-faint">{manifest.credits} Sky viewer: Aladin Lite (CDS). Catalogues: Gaia DR3 via VizieR, SIMBAD (CfA mirrors).</p>
        <LinkList links={links} />
      </Block>
    </div>
  );
}

function Block({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2 border-b border-hair px-4 py-3">
      <h3 className="text-ui font-medium text-fg">{title}</h3>
      {children}
    </section>
  );
}

export type { DetectorKey };
