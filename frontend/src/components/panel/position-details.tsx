"use client";
// Panel content for a clicked sky position: its coordinates, a quick-look spectrum from the
// backend's DR1 cube reader (when the backend is connected), "Watch this patch" and links out.

import { useEffect, useState } from "react";
import { ScanSearchIcon } from "lucide-react";
import { API_URL } from "@/lib/manifest";
import { featuredNear } from "@/lib/lab-resolve";
import { formatDecDms, formatDeg, formatRaHms, separationDeg } from "@/lib/lab-coords";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PanelSection, Row, Rows } from "@/components/panel/detail-panel";
import { SpectrumChart } from "@/components/panel/spectrum-chart";
import { defaultLinks, LinkList } from "@/components/panel/links";

type Quick =
  | { state: "off" }
  | { state: "loading" }
  | { state: "ready"; wl_um: number[]; flux_ujy: (number | null)[]; label: string }
  | { state: "error"; message: string };

export function PositionDetails({
  ra,
  dec,
  watchFieldArcmin,
  onWatch,
  onPickTarget,
}: {
  ra: number;
  dec: number;
  watchFieldArcmin: number;
  onWatch: () => void;
  onPickTarget: (slug: string) => void;
}) {
  const [quick, setQuick] = useState<Quick>(() => (API_URL ? { state: "loading" } : { state: "off" }));
  const [requested, setRequested] = useState({ ra, dec });
  if (requested.ra !== ra || requested.dec !== dec) {
    setRequested({ ra, dec });
    setQuick(API_URL ? { state: "loading" } : { state: "off" });
  }

  useEffect(() => {
    if (!API_URL) return;
    const controller = new AbortController();
    fetch(`${API_URL}/api/spectrum/quick?ra=${ra.toFixed(6)}&dec=${dec.toFixed(6)}`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { wl_um: number[]; flux_ujy: (number | null)[]; label: string };
        setQuick({ state: "ready", ...body });
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setQuick({ state: "error", message: err instanceof Error ? err.message : "unknown error" });
      });
    return () => controller.abort();
  }, [ra, dec]);

  const nearby = featuredNear(ra, dec, 0.25).map((t) => ({ t, sep: separationDeg(t, { ra, dec }) * 60 }));

  return (
    <div className="flex flex-col pb-4" data-testid="position-details">
      <header className="flex flex-col gap-1.5 px-5 pt-5 pr-12 pb-4">
        <p className="text-meta text-fg-dim">Sky position</p>
        <h2 className="readout text-heading font-normal text-fg" data-testid="panel-title">
          {formatRaHms(ra, 1)}
          <span className="block">{formatDecDms(dec, 0)}</span>
        </h2>
        <p className="readout text-meta text-fg-dim">
          {formatDeg(ra)} {formatDeg(dec, 5, true)} ICRS
        </p>
      </header>

      <div className="flex flex-col gap-2 px-5 pb-5">
        <Button
          variant="outline"
          onClick={onWatch}
          className="h-9 w-fit border-hair-strong text-ui"
          data-testid="watch-patch"
        >
          <ScanSearchIcon aria-hidden />
          Watch this patch
        </Button>
        <p className="text-micro text-fg-faint">
          Centres the view here and asks for SPHEREx epoch frames of a{" "}
          <span className="readout">{watchFieldArcmin.toFixed(0)}′</span> field.
          {API_URL ? "" : " Live frames need the backend, which is not connected to this site yet."}
        </p>
      </div>

      {nearby.length > 0 && (
        <PanelSection title="Featured targets nearby">
          <ul className="flex flex-col gap-1">
            {nearby.map(({ t, sep }) => (
              <li key={t.slug} className="flex items-baseline justify-between gap-3 text-meta">
                <button
                  type="button"
                  onClick={() => onPickTarget(t.slug)}
                  className="text-fg underline decoration-hair-strong underline-offset-4 transition-colors hover:decoration-accent"
                >
                  {t.name}
                </button>
                <span className="readout text-fg-dim">{sep.toFixed(1)}′ away</span>
              </li>
            ))}
          </ul>
        </PanelSection>
      )}

      <PanelSection title="Quick-look spectrum" testId="panel-quicklook">
        {quick.state === "off" && (
          <p className="text-meta text-fg-dim" data-testid="quicklook-off">
            A spectrum for any point comes from the SPHEREx DR1 all-sky cube, read by the Planet X Hunter backend in about
            a second. The backend is not connected to this site yet, so no spectrum is shown rather than a made-up one.
          </p>
        )}
        {quick.state === "loading" && <Skeleton className="h-40 w-full bg-ink-3" />}
        {quick.state === "error" && (
          <p className="text-meta text-fg-dim">The quick-look spectrum could not be read ({quick.message}).</p>
        )}
        {quick.state === "ready" && (
          <>
            <SpectrumChart
              spectrum={{ points: [], quicklook: { wl_um: quick.wl_um, flux_ujy: quick.flux_ujy, label: quick.label }, notes: [] }}
              epochLabel={() => ""}
            />
            <p className="text-micro text-fg-faint">
              Year-1 cube pixels are 12.9″ across, so neighbouring sources can blend into this spectrum.
            </p>
          </>
        )}
      </PanelSection>

      <PanelSection title="Look it up elsewhere">
        <Rows>
          <Row label="Search radius">
            <span className="readout">2′</span> around this point
          </Row>
        </Rows>
        <LinkList links={defaultLinks(ra, dec, null)} />
        <p className="text-micro text-fg-faint">Sky viewer: Aladin Lite (CDS). Map: SPHEREx DR1, NASA/JPL-Caltech, IRSA.</p>
      </PanelSection>
    </div>
  );
}
