"use client";
// Workbench marks drawn by Aladin on the sky, so they stay attached while the view pans and zooms:
// - Gaia DR3 sources in view as small, quiet circles (clickable through the workspace's click
//   handler, which picks the nearest source);
// - the selected star as an accent ring;
// - the ruler (a great-circle segment between two points) and the circular aperture.

import { useEffect, useRef } from "react";
import type { AladinSession } from "@/components/sky/aladin-session";
import { extra, type Catalog, type GraphicOverlay } from "@/components/sky/aladin-extra";
import type { GaiaSource } from "@/lib/lab-catalog";
import type { RaDec } from "@/lib/lab-coords";

const ACCENT = "#f0885a";
const MARK = "rgba(236, 235, 231, 0.3)";
/** Markers drawn for the brightest sources only; every source stays clickable. */
const MAX_MARKERS = 320;
const TOOL = "#ecebe7";

export interface ToolShape {
  ruler: { a: RaDec; b: RaDec } | null;
  aperture: { center: RaDec; radiusDeg: number } | null;
}

export function useSkyOverlays({
  session,
  sources,
  showSources,
  selected,
  fovDeg,
  tools,
}: {
  session: AladinSession | null;
  sources: GaiaSource[];
  showSources: boolean;
  selected: RaDec | null;
  fovDeg: number;
  tools: ToolShape;
}) {
  const catalogRef = useRef<Catalog | null>(null);
  const overlaysRef = useRef<{ selected: GraphicOverlay; tools: GraphicOverlay } | null>(null);

  useEffect(() => {
    if (!session) return;
    const { A, aladin } = extra(session);
    const catalog = A.catalog({ name: "Gaia DR3", color: MARK, sourceSize: 7, shape: "circle", onClick: null });
    aladin.addCatalog(catalog);
    const selectedOverlay = A.graphicOverlay({ name: "Selected star", color: ACCENT, lineWidth: 1.75 });
    const toolsOverlay = A.graphicOverlay({ name: "Measurements", color: TOOL, lineWidth: 1.25 });
    aladin.addOverlay(selectedOverlay);
    aladin.addOverlay(toolsOverlay);
    catalogRef.current = catalog;
    overlaysRef.current = { selected: selectedOverlay, tools: toolsOverlay };
    return () => {
      catalog.removeAll();
      aladin.removeOverlay(catalog);
      aladin.removeOverlay(selectedOverlay);
      aladin.removeOverlay(toolsOverlay);
      catalogRef.current = null;
      overlaysRef.current = null;
    };
  }, [session]);

  // Sources: replaced as a whole when the cone changes.
  useEffect(() => {
    const catalog = catalogRef.current;
    if (!session || !catalog) return;
    const { A } = extra(session);
    catalog.removeAll();
    if (showSources && sources.length) {
      const brightest = [...sources].sort((a, b) => (a.g ?? 99) - (b.g ?? 99)).slice(0, MAX_MARKERS);
      catalog.addSources(brightest.map((s) => A.source(s.ra, s.dec, { id: s.id })));
      catalog.show();
    } else {
      catalog.hide();
    }
  }, [session, sources, showSources]);

  const unit = Math.min(Math.max(fovDeg * 0.0045, 1.2 / 3600), 40 / 3600);
  const selRa = selected?.ra;
  const selDec = selected?.dec;
  useEffect(() => {
    const overlays = overlaysRef.current;
    if (!session || !overlays) return;
    const { A } = extra(session);
    overlays.selected.removeAll();
    if (selRa !== undefined && selDec !== undefined) {
      overlays.selected.add(A.circle(selRa, selDec, unit * 2.6, { color: ACCENT, lineWidth: 1.75 }), false);
    }
    overlays.selected.reportChange();
  }, [session, selRa, selDec, unit]);

  const toolsKey = JSON.stringify(tools);
  useEffect(() => {
    const overlays = overlaysRef.current;
    if (!session || !overlays) return;
    const { A } = extra(session);
    const t = JSON.parse(toolsKey) as ToolShape;
    overlays.tools.removeAll();
    if (t.ruler) {
      overlays.tools.add(
        A.polyline(
          [
            [t.ruler.a.ra, t.ruler.a.dec],
            [t.ruler.b.ra, t.ruler.b.dec],
          ],
          { color: TOOL, lineWidth: 1.25 },
        ),
        false,
      );
      overlays.tools.add(A.circle(t.ruler.a.ra, t.ruler.a.dec, unit * 0.8, { color: TOOL, lineWidth: 1 }), false);
      overlays.tools.add(A.circle(t.ruler.b.ra, t.ruler.b.dec, unit * 0.8, { color: TOOL, lineWidth: 1 }), false);
    }
    if (t.aperture && t.aperture.radiusDeg > 0) {
      overlays.tools.add(
        A.circle(t.aperture.center.ra, t.aperture.center.dec, t.aperture.radiusDeg, { color: ACCENT, lineWidth: 1.25 }),
        false,
      );
    }
    overlays.tools.reportChange();
  }, [session, toolsKey, unit]);
}

/** The source nearest to a point within `maxDeg`, or null. */
export function nearestSource(sources: GaiaSource[], ra: number, dec: number, maxDeg: number): GaiaSource | null {
  const cosDec = Math.cos((dec * Math.PI) / 180);
  let best: GaiaSource | null = null;
  let bestD = maxDeg * maxDeg;
  for (const s of sources) {
    let dRa = s.ra - ra;
    if (dRa > 180) dRa -= 360;
    if (dRa < -180) dRa += 360;
    const dx = dRa * cosDec;
    const dy = s.dec - dec;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return best;
}
