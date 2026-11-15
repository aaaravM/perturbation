"use client";
// The workbench's left "Data" pane: find a target or field, the epochs of the loaded field as a
// sortable table (each row expands into its exposures per detector), and the layer list with
// visibility and opacity.

import { Fragment, useMemo, useState } from "react";
import { ArrowDownIcon, ArrowUpIcon, ChevronRightIcon, EyeIcon, EyeOffIcon, ArrowUpRightIcon } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { DetectorKey, Epoch, FieldManifest } from "@/lib/manifest";
import type { BlinkFrame } from "@/lib/lab-field";
import { DETECTOR_BANDS, DETECTOR_KEYS } from "@/lib/lab-field";
import type { LabDetector, LabMode } from "@/lib/lab-state";
import type { ResolvedPlace } from "@/lib/lab-resolve";
import type { SpectralChannel } from "@/lib/spherex";
import { cn } from "@/lib/utils";
import { Slider } from "@/components/ui/slider";
import { Term } from "@/components/ui/term";
import { LabSearch } from "@/components/lab/lab-search";
import { WavelengthSlider } from "@/components/sky/wavelength-slider";
import { PaneHeading } from "@/components/lab/workbench-ui";

export type LayerId = "epochs" | "difference" | "wise" | "gaia" | "flags" | "path" | "cube";

export interface LayerRow {
  id: LayerId;
  visible: boolean;
  /** 0-1 when the layer has an opacity. */
  opacity?: number;
  disabled?: boolean;
  note?: string;
}

type SortKey = "date" | "exposures";

export function DataPane({
  activeSlug,
  onPlace,
  onPickTarget,
  manifest,
  frames,
  current,
  det,
  mode,
  onSeekEpoch,
  layers,
  onLayerVisible,
  onLayerOpacity,
  cubeFrame,
  onCubeFrame,
  channels,
  fieldLoading,
}: {
  activeSlug: string | null;
  onPlace: (place: ResolvedPlace) => void;
  onPickTarget: (slug: string) => void;
  manifest: FieldManifest | null;
  frames: BlinkFrame[];
  current: number;
  det: LabDetector | null;
  mode: LabMode;
  onSeekEpoch: (epochIndex: number) => void;
  layers: LayerRow[];
  onLayerVisible: (id: LayerId, on: boolean) => void;
  onLayerOpacity: (id: LayerId, v: number) => void;
  cubeFrame: number;
  onCubeFrame: (frame: number) => void;
  channels: SpectralChannel[] | null;
  fieldLoading: boolean;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="data-pane">
      <div className="shrink-0 border-b border-hair px-3 pt-3 pb-2.5">
        <LabSearch activeSlug={activeSlug} onPlace={onPlace} onPickTarget={onPickTarget} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain" data-lenis-prevent>
        <section aria-labelledby="epochs-heading" className="border-b border-hair pb-2">
          <PaneHeading
            id="epochs-heading"
            aside={
              manifest ? (
                <span className="readout text-micro text-fg-faint">
                  {manifest.epochs.length} · {manifest.epochs.reduce((n, e) => n + e.n_exposures, 0)} exp
                </span>
              ) : null
            }
          >
            <Term k="epoch">Epochs</Term>
          </PaneHeading>
          {manifest ? (
            <EpochTable
              manifest={manifest}
              frames={frames}
              current={current}
              det={det}
              mode={mode}
              onSeekEpoch={onSeekEpoch}
            />
          ) : (
            <p className="px-3 pb-2 text-micro text-pretty text-fg-faint">
              {fieldLoading
                ? "Reading the field…"
                : "Pick a target or search a position; its SPHEREx visits appear here, one row per epoch."}
            </p>
          )}
        </section>
        <section aria-labelledby="layers-heading" className="pb-3">
          <PaneHeading id="layers-heading">Layers</PaneHeading>
          <LayerList
            layers={layers}
            onVisible={onLayerVisible}
            onOpacity={onLayerOpacity}
            cube={
              !manifest ? (
                <WavelengthSlider frame={cubeFrame} onFrameChange={onCubeFrame} channels={channels} className="mt-2" />
              ) : null
            }
          />
        </section>
      </div>
    </div>
  );
}

function EpochTable({
  manifest,
  frames,
  current,
  det,
  mode,
  onSeekEpoch,
}: {
  manifest: FieldManifest;
  frames: BlinkFrame[];
  current: number;
  det: LabDetector | null;
  mode: LabMode;
  onSeekEpoch: (epochIndex: number) => void;
}) {
  const reduce = useReducedMotion();
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "date", dir: 1 });
  const [open, setOpen] = useState<number | null>(null);
  const rows = useMemo(() => {
    const list = [...manifest.epochs];
    list.sort((a, b) => sort.dir * (sort.key === "date" ? a.mjd_mid - b.mjd_mid : a.n_exposures - b.n_exposures));
    return list;
  }, [manifest.epochs, sort]);
  const shownEpoch = mode === "epochs" ? (frames[current]?.epoch?.index ?? null) : null;
  const withFrames = new Set(frames.map((f) => f.epoch?.index).filter((i): i is number => i !== undefined));
  const detKey = det && det !== "rgb" ? (det as DetectorKey) : null;

  const header = (key: SortKey, label: string, className?: string) => {
    const active = sort.key === key;
    return (
      <th scope="col" aria-sort={active ? (sort.dir > 0 ? "ascending" : "descending") : "none"} className={cn("py-1 font-normal", className)}>
        <button
          type="button"
          onClick={() => setSort((s) => ({ key, dir: s.key === key ? ((-s.dir) as 1 | -1) : 1 }))}
          className={cn("inline-flex items-center gap-0.5 hover:text-fg", active && "text-fg-dim")}
        >
          {label}
          {active && (sort.dir > 0 ? <ArrowUpIcon className="size-3" aria-hidden /> : <ArrowDownIcon className="size-3" aria-hidden />)}
        </button>
      </th>
    );
  };

  const band = detKey ? (manifest.frames.epoch[detKey]?.find((f) => f.wl_um)?.wl_um ?? DETECTOR_BANDS[detKey]) : null;
  return (
    <>
    {band && (
      <p className="px-3 pb-1.5 text-micro text-fg-faint" data-testid="epoch-band">
        Frames shown: {detKey}, <span className="readout text-fg-dim">{band[0].toFixed(2)}–{band[1].toFixed(2)} µm</span>
      </p>
    )}
    <table className="w-full table-fixed border-collapse text-micro" data-testid="epoch-table">
      <caption className="sr-only">SPHEREx epochs of this field. Choose a row to show that epoch.</caption>
      <colgroup>
        <col className="w-5" />
        <col />
        <col className="w-[4.6rem]" />
        <col className="w-[3.4rem]" />
        <col className="w-9" />
      </colgroup>
      <thead className="text-fg-faint">
        <tr className="border-b border-hair text-left">
          <th scope="col" className="py-1 font-normal">
            <span className="sr-only">Expand</span>
          </th>
          {header("date", "Date")}
          <th scope="col" className="py-1 font-normal">
            <Term k="survey" mark={false}>
              Survey
            </Term>
          </th>
          <th scope="col" className="py-1 font-normal">
            <Term k="detector" mark={false}>
              Det.
            </Term>
          </th>
          {header("exposures", "Exp.", "pr-3 text-right")}
        </tr>
      </thead>
      <tbody>
        {rows.map((e) => {
          const isShown = shownEpoch === e.index;
          const expanded = open === e.index;
          const clickable = mode === "epochs" && withFrames.has(e.index);
          return (
            <Fragment key={e.index}>
              <tr
                data-testid="epoch-row"
                data-epoch={e.index}
                aria-selected={isShown || undefined}
                className={cn(
                  "group border-b border-hair/60 transition-colors duration-150",
                  isShown ? "bg-accent-faint" : "hover:bg-white/[0.03]",
                  !e.full && "text-fg-faint",
                )}
              >
                <td className="relative py-1 pl-1.5">
                  {isShown && <span aria-hidden className="absolute inset-y-0 left-0 w-0.5 bg-accent" />}
                  <button
                    type="button"
                    aria-expanded={expanded}
                    aria-label={`${expanded ? "Hide" : "Show"} the exposures of ${e.label}`}
                    onClick={() => setOpen(expanded ? null : e.index)}
                    className="grid size-4 place-items-center rounded-sm text-fg-faint hover:text-fg"
                  >
                    <ChevronRightIcon className={cn("size-3 transition-transform duration-200", expanded && "rotate-90")} aria-hidden />
                  </button>
                </td>
                <td className="py-1">
                  <button
                    type="button"
                    disabled={!clickable}
                    onClick={() => onSeekEpoch(e.index)}
                    className="readout text-left text-fg enabled:hover:underline enabled:hover:decoration-hair-strong enabled:hover:underline-offset-4 disabled:text-inherit"
                    title={clickable ? `Show ${e.label}` : e.full ? "No frame for this detector" : "Partial epoch"}
                  >
                    {e.label}
                  </button>
                  {!e.full && <span className="block text-fg-faint">partial</span>}
                </td>
                <td className="readout py-1 text-fg-dim">
                  {e.survey} <span className="text-fg-dim">{e.pa}°</span>
                </td>
                <td className="py-1">
                  <DetectorCells detectors={e.detectors} active={detKey} />
                </td>
                <td className="readout py-1 pr-3 text-right text-fg-dim">{e.n_exposures}</td>
              </tr>
              <AnimatePresence initial={false}>
                {expanded && (
                  <tr className="border-b border-hair/60 bg-ink-2">
                    <td colSpan={5} className="p-0">
                      <motion.div
                        initial={reduce ? false : { height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={reduce ? undefined : { height: 0, opacity: 0 }}
                        transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
                        className="overflow-hidden"
                      >
                        <ExposureRows epoch={e} manifest={manifest} />
                      </motion.div>
                    </td>
                  </tr>
                )}
              </AnimatePresence>
            </Fragment>
          );
        })}
      </tbody>
    </table>
    </>
  );
}

/** Six tiny cells, one per detector, filled when the detector has exposures in the epoch. */
function DetectorCells({ detectors, active }: { detectors: Epoch["detectors"]; active: DetectorKey | null }) {
  return (
    <span role="img" className="flex items-end gap-px" aria-label={DETECTOR_KEYS.map((d) => `${d} ${detectors[d.slice(1) as "1"] ?? 0}`).join(", ")}>
      {DETECTOR_KEYS.map((d) => {
        const n = detectors[d.slice(1) as "1"] ?? 0;
        return (
          <span
            key={d}
            aria-hidden
            className={cn("block w-1.5 rounded-[1px]", n ? (d === active ? "bg-accent" : "bg-fg-dim") : "bg-hair-strong")}
            style={{ height: n ? Math.min(12, 4 + Math.sqrt(n) * 1.8) : 3 }}
          />
        );
      })}
    </span>
  );
}

function ExposureRows({ epoch, manifest }: { epoch: Epoch; manifest: FieldManifest }) {
  const days = Math.max(1, Math.round((Date.parse(epoch.end) - Date.parse(epoch.start)) / 86_400_000) + 1);
  const { ra, dec } = manifest.center;
  const start = epoch.start;
  const end = epoch.end;
  const irsa = siaExposureUrl(manifest, epoch);
  return (
    <div className="flex flex-col gap-1.5 px-3 py-2" data-testid="exposure-rows">
      <p className="text-micro text-fg-faint">
        <span className="readout text-fg-dim">
          {start} → {end}
        </span>{" "}
        · {days} {days === 1 ? "day" : "days"} · <Term k="survey">{epoch.survey}</Term>, position angle{" "}
        <span className="readout">{epoch.pa}°</span>
      </p>
      <table className="w-full text-micro">
        <caption className="sr-only">Exposures per detector in {epoch.label}</caption>
        <thead className="text-fg-faint">
          <tr className="text-left">
            <th scope="col" className="font-normal">
              Detector
            </th>
            <th scope="col" className="font-normal">
              Band (µm)
            </th>
            <th scope="col" className="text-right font-normal">
              Exposures
            </th>
            <th scope="col" className="text-right font-normal">
              Frame
            </th>
          </tr>
        </thead>
        <tbody className="readout">
          {DETECTOR_KEYS.map((d) => {
            const n = epoch.detectors[d.slice(1) as "1"] ?? 0;
            const frame = manifest.frames.epoch[d]?.find((f) => f.epoch === epoch.index);
            const band = frame?.wl_um ?? DETECTOR_BANDS[d];
            return (
              <tr key={d} className={n ? "text-fg-dim" : "text-fg-faint"}>
                <td>{d}</td>
                <td>
                  {band[0].toFixed(2)}–{band[1].toFixed(2)}
                </td>
                <td className="text-right">{n}</td>
                <td className="text-right">{frame ? `co-add of ${frame.n ?? n}` : "–"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <a
        href={irsa}
        target="_blank"
        rel="noreferrer noopener"
        className="inline-flex w-fit items-center gap-1 text-micro text-fg-dim underline decoration-hair-strong underline-offset-4 hover:text-fg"
      >
        List these exposures at IRSA (CSV, with cutout links)
        <ArrowUpRightIcon className="size-3" aria-hidden />
      </a>
      <p className="sr-only">
        Field centre {ra.toFixed(5)} {dec.toFixed(5)}
      </p>
    </div>
  );
}

const isoToMjd = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 86_400_000 + 40587;

/** IRSA's SIA query for the images of one epoch at the field centre (each row has its file URL). */
export function siaExposureUrl(manifest: FieldManifest, epoch: Epoch): string {
  const { ra, dec } = manifest.center;
  const collections = manifest.release.collections.filter((c) => !c.endsWith("_cube"));
  const params = [
    ...collections.map((c) => `COLLECTION=${encodeURIComponent(c)}`),
    `POS=${encodeURIComponent(`CIRCLE ${ra.toFixed(5)} ${dec.toFixed(5)} 0.002`)}`,
    `TIME=${encodeURIComponent(`${isoToMjd(epoch.start).toFixed(1)} ${(isoToMjd(epoch.end) + 1).toFixed(1)}`)}`,
    "RESPONSEFORMAT=CSV",
  ];
  return `https://irsa.ipac.caltech.edu/SIA?${params.join("&")}`;
}

const LAYER_LABEL: Record<LayerId, { name: React.ReactNode; plain: string; hint: string }> = {
  epochs: { name: <>SPHEREx epochs</>, plain: "SPHEREx epochs", hint: "The blink frames, one co-add per visit" },
  difference: { name: <Term k="difference">Difference</Term>, plain: "Difference", hint: "Last epoch minus first, in units of the noise" },
  wise: { name: <>WISE 2010 (W2)</>, plain: "WISE 2010", hint: "AllWISE at 4.6 µm, about 15 years earlier" },
  gaia: { name: <Term k="gaia">Gaia DR3</Term>, plain: "Gaia DR3 stars", hint: "Catalogue stars: click one to inspect it" },
  flags: { name: <Term k="flags">Flags</Term>, plain: "Flags", hint: "Pixels marked in the official SPHEREx masks" },
  path: { name: <>Motion path</>, plain: "Motion path", hint: "The selected object's track across the epochs" },
  cube: { name: <>SPHEREx all-sky cube</>, plain: "SPHEREx all-sky cube", hint: "DR1 map underneath, 102 wavelengths" },
};

function LayerList({
  layers,
  onVisible,
  onOpacity,
  cube,
}: {
  layers: LayerRow[];
  onVisible: (id: LayerId, on: boolean) => void;
  onOpacity: (id: LayerId, v: number) => void;
  cube: React.ReactNode;
}) {
  return (
    <ul className="flex flex-col" data-testid="layer-list">
      {layers.map((l) => {
        const meta = LAYER_LABEL[l.id];
        return (
          <li key={l.id} className={cn("flex flex-col gap-1 px-3 py-1.5", l.disabled && "opacity-45")} data-testid={`layer-${l.id}`}>
            <div className="flex items-center gap-2">
              <button
                type="button"
                role="switch"
                aria-checked={l.visible}
                aria-label={`Show ${meta.plain}`}
                disabled={l.disabled}
                onClick={() => onVisible(l.id, !l.visible)}
                data-testid={`layer-toggle-${l.id}`}
                className={cn(
                  "grid size-6 shrink-0 place-items-center rounded-[5px] transition-colors hover:bg-white/[0.06]",
                  l.visible ? "text-fg" : "text-fg-faint",
                )}
              >
                {l.visible ? <EyeIcon className="size-3.5" aria-hidden /> : <EyeOffIcon className="size-3.5" aria-hidden />}
              </button>
              <div className="min-w-0 flex-1">
                <p className={cn("truncate text-meta", l.visible ? "text-fg" : "text-fg-dim")}>{meta.name}</p>
                <p className="truncate text-micro text-fg-faint">{l.note ?? meta.hint}</p>
              </div>
              {l.opacity !== undefined && (
                <div className="flex w-[4.5rem] shrink-0 items-center gap-1.5">
                  <Slider
                    min={0}
                    max={1}
                    step={0.05}
                    value={[l.opacity]}
                    disabled={!l.visible || l.disabled}
                    onValueChange={([v]) => onOpacity(l.id, v)}
                    aria-label={`Opacity of ${meta.plain}`}
                    aria-valuetext={`${Math.round(l.opacity * 100)} percent`}
                    className="[&_[data-slot=slider-range]]:bg-fg-dim [&_[data-slot=slider-thumb]]:size-3 [&_[data-slot=slider-thumb]]:border-fg [&_[data-slot=slider-thumb]]:bg-ink"
                  />
                </div>
              )}
            </div>
            {l.id === "cube" && cube}
          </li>
        );
      })}
    </ul>
  );
}
