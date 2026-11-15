"use client";
// Spectrum: measured points with 1-sigma error bars on a log wavelength axis. Detectors are told
// apart by alternating shade and by their band labels along the top; saturated points are hollow
// (excluded from fits); the quick-look cube spectrum is a faint line. Linear flux axis, so noisy
// points near zero stay honest. No smoothing, no interpolation across gaps.

import { CartesianGrid, ComposedChart, ErrorBar, Line, ReferenceArea, Scatter, Tooltip, XAxis, YAxis } from "recharts";
import type { FieldManifest } from "@/lib/manifest";
import { DETECTOR_BANDS, DETECTOR_KEYS } from "@/lib/lab-field";
import { ChartContainer } from "@/components/ui/chart";

const SHADES = ["#ecebe7", "#a6a5a0"]; // fg, fg-dim, alternating by detector
const WL_TICKS = [0.75, 1, 1.5, 2, 3, 4, 5];

export function fluxUnit(maxUjy: number): { unit: string; scale: number } {
  if (maxUjy >= 1e6) return { unit: "Jy", scale: 1e-6 };
  if (maxUjy >= 1e3) return { unit: "mJy", scale: 1e-3 };
  return { unit: "µJy", scale: 1 };
}

/** Round tick steps (1, 2, 2.5, 5 x 10^n) covering [lo, hi] in about four intervals. */
export function niceTicks(lo: number, hi: number): { ticks: number[]; digits: number } {
  const span = hi - lo || Math.abs(hi) || 1;
  const raw = span / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  const step = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
  const start = Math.floor(lo / step) * step;
  const end = Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= end + step / 2; v += step) ticks.push(Number(v.toPrecision(12)));
  const digits = Math.max(0, -Math.floor(Math.log10(step)) + (n > 2 && n <= 2.5 ? 1 : 0));
  return { ticks, digits };
}

interface Point {
  wl: number;
  flux: number;
  err: number;
  bw: number;
  detector: number;
  saturated: boolean;
  epoch: number;
}

function PointShape(props: { cx?: number; cy?: number; payload?: Point }) {
  const { cx, cy, payload } = props;
  if (cx === undefined || cy === undefined || !payload) return null;
  const shade = SHADES[(payload.detector - 1) % 2];
  return payload.saturated ? (
    <circle cx={cx} cy={cy} r={3.5} fill="var(--ink)" stroke={shade} strokeWidth={1.25} />
  ) : (
    <circle cx={cx} cy={cy} r={3.5} fill={shade} stroke="var(--ink)" strokeWidth={1} />
  );
}

export function SpectrumChart({
  spectrum,
  epochLabel,
}: {
  spectrum: NonNullable<FieldManifest["spectrum"]>;
  epochLabel: (epoch: number) => string;
}) {
  const fluxes = [
    ...spectrum.points.map((p) => p.flux_ujy + p.err_ujy),
    ...(spectrum.quicklook?.flux_ujy.filter((v): v is number => v !== null) ?? []),
  ];
  const { unit, scale } = fluxUnit(Math.max(1, ...fluxes.map(Math.abs)));
  const points: Point[] = spectrum.points.map((p) => ({
    wl: p.wl_um,
    flux: p.flux_ujy * scale,
    err: p.err_ujy * scale,
    bw: p.bw_um / 2,
    detector: p.detector,
    saturated: p.saturated,
    epoch: p.epoch,
  }));
  const quick =
    spectrum.quicklook?.wl_um.map((wl, i) => ({
      wl,
      flux: spectrum.quicklook!.flux_ujy[i] === null ? null : spectrum.quicklook!.flux_ujy[i]! * scale,
    })) ?? [];
  const byDet = DETECTOR_KEYS.map((_, i) => points.filter((p) => p.detector === i + 1));
  const yLo = Math.min(0, ...points.map((p) => p.flux - p.err), ...quick.map((p) => p.flux ?? 0));
  const yHi = Math.max(...points.map((p) => p.flux + p.err), ...quick.map((p) => p.flux ?? 0), 1e-9);
  const { ticks: yTicks, digits: yDigits } = niceTicks(yLo, yHi);
  const epochs = [...new Set(points.map((p) => p.epoch))];

  return (
    <figure className="flex flex-col gap-2" data-testid="spectrum-chart">
      <ChartContainer config={{}} className="aspect-auto h-[232px] w-full [&_.recharts-cartesian-axis-tick_text]:fill-fg-faint">
        <ComposedChart margin={{ top: 18, right: 10, bottom: 18, left: 2 }}>
          <CartesianGrid stroke="var(--hair)" vertical={false} />
          {DETECTOR_KEYS.map((d, i) => (
            <ReferenceArea
              key={d}
              x1={DETECTOR_BANDS[d][0]}
              x2={DETECTOR_BANDS[d][1]}
              fill={i % 2 ? "var(--fg)" : "transparent"}
              fillOpacity={0.025}
              strokeOpacity={0}
              ifOverflow="hidden"
              label={{ value: d, position: "insideTop", offset: -14, fill: "var(--fg-faint)", fontSize: 10 }}
            />
          ))}
          <XAxis
            type="number"
            dataKey="wl"
            scale="log"
            domain={[0.72, 5.1]}
            ticks={WL_TICKS}
            allowDataOverflow
            tickLine={false}
            axisLine={{ stroke: "var(--hair-strong)" }}
            tick={{ fontSize: 11 }}
            label={{ value: "Wavelength (µm)", position: "insideBottom", offset: -12, fill: "var(--fg-dim)", fontSize: 11 }}
          />
          <YAxis
            type="number"
            dataKey="flux"
            width={48}
            domain={[yTicks[0], yTicks[yTicks.length - 1]]}
            ticks={yTicks}
            tickLine={false}
            axisLine={false}
            tick={{ fontSize: 11 }}
            tickFormatter={(v: number) => v.toFixed(yDigits)}
            label={{ value: `Flux (${unit})`, angle: -90, position: "insideLeft", offset: 12, fill: "var(--fg-dim)", fontSize: 11, dy: 30 }}
          />
          {quick.length > 0 && (
            <Line
              data={quick}
              dataKey="flux"
              type="linear"
              dot={false}
              activeDot={false}
              stroke="var(--fg-faint)"
              strokeOpacity={0.7}
              strokeWidth={1}
              isAnimationActive={false}
              connectNulls={false}
              name="Quick-look"
            />
          )}
          {byDet.map((data, i) =>
            data.length ? (
              <Scatter key={DETECTOR_KEYS[i]} data={data} shape={<PointShape />} isAnimationActive={false} name={DETECTOR_KEYS[i]}>
                <ErrorBar dataKey="err" direction="y" width={0} stroke={SHADES[i % 2]} strokeOpacity={0.7} strokeWidth={1} />
              </Scatter>
            ) : null,
          )}
          <Tooltip
            cursor={{ stroke: "var(--hair-strong)" }}
            isAnimationActive={false}
            content={({ active, payload }) => {
              const p = active ? (payload?.[0]?.payload as Point | undefined) : undefined;
              if (!p || p.detector === undefined) return null;
              return (
                <div className="rounded-md border border-hair-strong bg-popover px-2.5 py-1.5 text-micro text-fg shadow-lg">
                  <p className="readout">
                    {p.wl.toFixed(3)} µm · {p.flux.toPrecision(3)} ± {p.err.toPrecision(2)} {unit}
                  </p>
                  <p className="text-fg-dim">
                    D{p.detector}, {epochLabel(p.epoch)}
                    {p.saturated ? ", saturated (excluded from fits)" : ""}
                  </p>
                </div>
              );
            }}
          />
        </ComposedChart>
      </ChartContainer>
      <figcaption className="flex flex-wrap items-center gap-x-4 gap-y-1 text-micro text-fg-dim">
        {points.length > 0 && (
          <span className="flex items-center gap-1.5">
            <svg aria-hidden width="10" height="10">
              <circle cx="5" cy="5" r="3.5" fill={SHADES[0]} />
            </svg>
            Measured{epochs.length === 1 ? `, ${epochLabel(epochs[0])}` : ""}
          </span>
        )}
        {points.some((p) => p.saturated) && (
          <span className="flex items-center gap-1.5">
            <svg aria-hidden width="10" height="10">
              <circle cx="5" cy="5" r="3.5" fill="none" stroke={SHADES[0]} strokeWidth="1.25" />
            </svg>
            Saturated
          </span>
        )}
        {quick.length > 0 && (
          <span className="flex items-center gap-1.5">
            <svg aria-hidden width="14" height="10">
              <line x1="0" y1="5" x2="14" y2="5" stroke="var(--fg-faint)" strokeWidth="1" />
            </svg>
            {spectrum.quicklook?.label ?? "Quick-look cube spectrum"}
          </span>
        )}
        {points.length > 0 && <span>Bars: 1σ</span>}
      </figcaption>
    </figure>
  );
}
