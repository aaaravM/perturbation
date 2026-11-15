"use client";
// The selected object's motion on the sky, drawn by Aladin above the blink frames: a thin accent
// polyline along the predicted path, small hollow markers at the measured epoch positions, and an
// accent ring that follows the object from frame to frame. Sizes follow the zoom so the marks stay
// legible without covering the object.

import { useEffect, useRef } from "react";
import type { AladinSession } from "@/components/sky/aladin-session";
import { extra, type GraphicOverlay } from "@/components/sky/aladin-extra";

const ACCENT = "#f0885a";
const MARKER = "#a6a5a0";
const PROBE = "#ecebe7";

interface Overlays {
  path: GraphicOverlay;
  markers: GraphicOverlay;
  current: GraphicOverlay;
  probe: GraphicOverlay;
}

export function useMotionOverlay({
  session,
  path,
  markers,
  current,
  fovDeg,
  show,
  probe,
}: {
  session: AladinSession | null;
  path: [number, number][];
  markers: { ra: number; dec: number }[];
  current: { ra: number; dec: number } | null;
  fovDeg: number;
  show: boolean;
  /** A clicked sky position, drawn as a small neutral ring. */
  probe: { ra: number; dec: number } | null;
}) {
  const overlaysRef = useRef<Overlays | null>(null);

  useEffect(() => {
    if (!session) return;
    const { A, aladin } = extra(session);
    const overlays: Overlays = {
      path: A.graphicOverlay({ name: "Motion path", color: ACCENT, lineWidth: 1.5 }),
      markers: A.graphicOverlay({ name: "Measured positions", color: MARKER, lineWidth: 1 }),
      current: A.graphicOverlay({ name: "Selected object", color: ACCENT, lineWidth: 1.75 }),
      probe: A.graphicOverlay({ name: "Clicked position", color: PROBE, lineWidth: 1.25 }),
    };
    aladin.addOverlay(overlays.path);
    aladin.addOverlay(overlays.markers);
    aladin.addOverlay(overlays.current);
    aladin.addOverlay(overlays.probe);
    overlaysRef.current = overlays;
    return () => {
      aladin.removeOverlay(overlays.path);
      aladin.removeOverlay(overlays.markers);
      aladin.removeOverlay(overlays.current);
      aladin.removeOverlay(overlays.probe);
      overlaysRef.current = null;
    };
  }, [session]);

  // Radius in degrees: about 0.45% of the view width, so roughly 6 px whatever the zoom.
  const unit = Math.min(Math.max(fovDeg * 0.0045, 1.2 / 3600), 40 / 3600);
  const pathKey = JSON.stringify(path);
  const markersKey = JSON.stringify(markers);

  useEffect(() => {
    const overlays = overlaysRef.current;
    if (!session || !overlays) return;
    const { A } = extra(session);
    overlays.path.removeAll();
    overlays.markers.removeAll();
    if (show) {
      const coords = JSON.parse(pathKey) as [number, number][];
      if (coords.length >= 2) overlays.path.add(A.polyline(coords, { color: ACCENT, lineWidth: 1.5 }), false);
      for (const m of JSON.parse(markersKey) as { ra: number; dec: number }[]) {
        overlays.markers.add(A.circle(m.ra, m.dec, unit * 0.55, { color: MARKER, lineWidth: 1 }), false);
      }
    }
    overlays.path.reportChange();
    overlays.markers.reportChange();
  }, [session, pathKey, markersKey, unit, show]);

  const curRa = current?.ra;
  const curDec = current?.dec;
  useEffect(() => {
    const overlays = overlaysRef.current;
    if (!session || !overlays) return;
    const { A } = extra(session);
    overlays.current.removeAll();
    if (curRa !== undefined && curDec !== undefined) {
      overlays.current.add(A.circle(curRa, curDec, unit * 2.4, { color: ACCENT, lineWidth: 1.75 }), false);
    }
    overlays.current.reportChange();
  }, [session, curRa, curDec, unit]);

  const probeRa = probe?.ra;
  const probeDec = probe?.dec;
  useEffect(() => {
    const overlays = overlaysRef.current;
    if (!session || !overlays) return;
    const { A } = extra(session);
    overlays.probe.removeAll();
    if (probeRa !== undefined && probeDec !== undefined) {
      overlays.probe.add(A.circle(probeRa, probeDec, unit * 1.6, { color: PROBE, lineWidth: 1.25 }), false);
    }
    overlays.probe.reportChange();
  }, [session, probeRa, probeDec, unit]);
}
