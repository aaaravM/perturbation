"use client";
// Light curve: epoch photometry in AB magnitudes (brighter is up) with 1-sigma error bars.
// The detector chosen in the blink player is drawn in full; the other detectors are faint
// context. The accent line marks the epoch on screen in the blink. Points only: no lines
// between epochs, because nothing is known about the brightness in between.

import { CartesianGrid, ComposedChart, ErrorBar, ReferenceLine, Scatter, Tooltip, XAxis, YAxis } from "recharts";
import type { FieldManifest } from "@/lib/manifest";
import { formatDay, formatMonthYear } from "@/lib/lab-coords";
import { ChartContainer } from "@/components/ui/chart";
import { niceTicks } from "@/components/panel/spectrum-chart";

interface Point {
  mjd: number;
  mag: number;
  magErr: number;
  detector: number;
  epoch: number;
  wl: number;
  saturatedFrac: number;
}

function Dot(props: { cx?: number; cy?: number; payload?: Point; focus?: boolean }) {
  const { cx, cy, payload, focus } = props;
  if (cx === undefined || cy === undefined || !payload) return null;
  const hollow = payload.saturatedFrac > 0.5;
  if (!focus) return <circle cx={cx} cy={cy} r={2.5} fill="var(--fg-faint)" fillOpacity={0.55} />;
  return hollow ? (
    <circle cx={cx} cy={cy} r={4} fill="var(--ink)" stroke="var(--fg)" strokeWidth={1.25} />
  ) : (
    <circle cx={cx} cy={cy} r={4} fill="var(--fg)" stroke="var(--ink)" strokeWidth={1} />
  );
}

export function LightCurveChart({
  lightcurve,
  detector,
  currentMjd,
}: {
  lightcurve: NonNullable<FieldManifest["lightcurve"]>;
  /** 1..6: the detector in focus. */
  detector: number;
  currentMjd: number | null;
}) {
  const points: Point[] = lightcurve.epoch_photometry
    .filter((p) => Number.isFinite(p.mag_ab) && p.flux_ujy > 0)
    .map((p) => ({
      mjd: p.mjd,
      mag: p.mag_ab,
      magErr: (1.0857 * p.err_ujy) / p.flux_ujy,
      detector: p.detector,
      epoch: p.epoch,
      wl: p.wl_um,
      saturatedFrac: p.saturated_frac,
    }));
  const focus = points.filter((p) => p.detector === detector);
  const rest = points.filter((p) => p.detector !== detector);
  if (points.length === 0) return null;
  const mjds = points.map((p) => p.mjd);
  const pad = Math.max(15, (Math.max(...mjds) - Math.min(...mjds)) * 0.06);
  const focusMags = focus.flatMap((p) => [p.mag - p.magErr, p.mag + p.magErr]);
  const yValues = focusMags.length ? focusMags : points.map((p) => p.mag);
  const yPad = Math.max(0.05, (Math.max(...yValues) - Math.min(...yValues)) * 0.15);
  // Round magnitude ticks (e.g. 16.8, 17.0, 17.2) covering the detector in focus.
  const { ticks: yTicks, digits: yDigits } = niceTicks(Math.min(...yValues) - yPad, Math.max(...yValues) + yPad);
  const wl = focus[0]?.wl;

  return (
    <figure className="flex flex-col gap-2" data-testid="lightcurve-chart">
      <ChartContainer config={{}} className="aspect-auto h-[196px] w-full [&_.recharts-cartesian-axis-tick_text]:fill-fg-faint">
        <ComposedChart margin={{ top: 8, right: 10, bottom: 18, left: 2 }}>
          <CartesianGrid stroke="var(--hair)" vertical={false} />
          <XAxis
            type="number"
            dataKey="mjd"
            domain={[Math.min(...mjds) - pad, Math.max(...mjds) + pad]}
            tickLine={false}
            axisLine={{ stroke: "var(--hair-strong)" }}
            tick={{ fontSize: 11 }}
            tickCount={4}
            tickFormatter={(v: number) => formatMonthYear(v)}
            label={{ value: "Date of epoch (UTC)", position: "insideBottom", offset: -12, fill: "var(--fg-dim)", fontSize: 11 }}
          />
          <YAxis
            type="number"
            dataKey="mag"
            reversed
            width={60}
            domain={[yTicks[0], yTicks[yTicks.length - 1]]}
            ticks={yTicks}
            allowDataOverflow
            tickLine={false}
            axisLine={false}
            tick={{ fontSize: 11 }}
            tickFormatter={(v: number) => v.toFixed(Math.max(1, yDigits))}
            label={{ value: "AB magnitude", angle: -90, position: "insideLeft", offset: 4, fill: "var(--fg-dim)", fontSize: 11, dy: 36 }}
          />
          {currentMjd !== null && (
            <ReferenceLine x={currentMjd} stroke="var(--accent)" strokeOpacity={0.8} strokeDasharray="3 3" ifOverflow="hidden" />
          )}
          {rest.length > 0 && <Scatter data={rest} shape={<Dot />} isAnimationActive={false} name="Other detectors" />}
          {focus.length > 0 && (
            <Scatter data={focus} shape={<Dot focus />} isAnimationActive={false} name={`D${detector}`}>
              <ErrorBar dataKey="magErr" direction="y" width={0} stroke="var(--fg)" strokeOpacity={0.7} strokeWidth={1} />
            </Scatter>
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
                    {p.mag.toFixed(3)} ± {p.magErr.toFixed(3)} mag
                  </p>
                  <p className="text-fg-dim">
                    D{p.detector} at <span className="readout">{p.wl.toFixed(2)}</span> µm, {formatDay(p.mjd)}
                    {p.saturatedFrac > 0 ? `, ${Math.round(p.saturatedFrac * 100)}% of pixels saturated` : ""}
                  </p>
                </div>
              );
            }}
          />
        </ComposedChart>
      </ChartContainer>
      <figcaption className="flex flex-wrap items-center gap-x-4 gap-y-1 text-micro text-fg-dim">
        <span className="flex items-center gap-1.5">
          <svg aria-hidden width="10" height="10">
            <circle cx="5" cy="5" r="4" fill="var(--fg)" />
          </svg>
          D{detector}
          {wl ? (
            <>
              {" "}
              at <span className="readout">{wl.toFixed(2)}</span> µm
            </>
          ) : null}
        </span>
        {rest.length > 0 && (
          <span className="flex items-center gap-1.5">
            <svg aria-hidden width="10" height="10">
              <circle cx="5" cy="5" r="2.5" fill="var(--fg-faint)" />
            </svg>
            Other detectors
          </span>
        )}
        {currentMjd !== null && (
          <span className="flex items-center gap-1.5">
            <svg aria-hidden width="12" height="10">
              <line x1="6" y1="0" x2="6" y2="10" stroke="var(--accent)" strokeDasharray="2 2" />
            </svg>
            Frame on screen
          </span>
        )}
        <span>Bars: 1σ</span>
      </figcaption>
    </figure>
  );
}
