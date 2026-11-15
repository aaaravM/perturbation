// Typed access to the parts of Aladin Lite 3.8.2 the Lab uses beyond src/types/aladin-lite.d.ts:
// image overlays (A.image with an explicit WCS), graphic overlays (polyline, circle) and
// overlay management. Checked against node_modules/aladin-lite/dist/aladin.js:
//   A.image(url, opts)        -> Image layer; opts.wcs skips header parsing; opts.successCallback
//   A.graphicOverlay({color, lineWidth, lineDash, name}); overlay.add(item); overlay.removeAll()
//   A.polyline([[ra, dec], ...], {color, lineWidth}); A.circle(ra, dec, radiusDeg, {color, fillColor, lineWidth})
//   aladin.addOverlay(overlay); aladin.removeOverlay(overlay); aladin.on("click", ({ra, dec, isDragging}) => ...)
// Never use the CDS-bound helpers (catalogFromSimbad/VizieR, gotoObject, Simbad pointer).

import type { Aladin, HiPS } from "aladin-lite";
import type { AladinSession } from "@/components/sky/aladin-session";

export interface ImageLayer {
  readonly added: boolean;
  setOpacity(opacity: number): void;
  getOpacity(): number;
  /** Colour map and stretch (3.8.2: grayscale, viridis, magma, rdbu, ...; native keeps the PNG colours). */
  setColormap?(colormap: string | null, options?: { stretch?: "linear" | "asinh" | "log" | "sqrt" | "pow"; reversed?: boolean }): void;
  setCuts?(min: number, max: number): void;
}

export interface ImageOptions {
  name?: string;
  imgFormat: "png" | "jpeg";
  wcs: Record<string, number | string>;
  opacity?: number;
  successCallback?: (ra: number, dec: number, fov: number, image: ImageLayer) => void;
  errorCallback?: (error: unknown) => void;
}

export interface OverlayItem {
  readonly id: string;
}

export interface GraphicOverlay {
  add(item: OverlayItem, redraw?: boolean): void;
  removeAll(): void;
  show(): void;
  hide(): void;
  reportChange(): void;
}

export interface ShapeOptions {
  color?: string;
  fillColor?: string;
  lineWidth?: number;
  opacity?: number;
}

export interface CatalogSource {
  ra: number;
  dec: number;
  data?: Record<string, unknown>;
}

export interface Catalog {
  addSources(sources: CatalogSource[] | CatalogSource): void;
  removeAll(): void;
  show(): void;
  hide(): void;
  isShowing?: boolean;
}

export interface CatalogOptions {
  name?: string;
  color?: string;
  sourceSize?: number;
  shape?: "circle" | "square" | "plus" | "cross" | "rhomb" | "triangle";
  onClick?: "showTable" | "showPopup" | null;
}

export interface AladinStaticExtra {
  catalog(options: CatalogOptions): Catalog;
  source(ra: number, dec: number, data?: Record<string, unknown>): CatalogSource;
  image(url: string, options: ImageOptions): ImageLayer;
  graphicOverlay(options: { name?: string; color?: string; lineWidth?: number; lineDash?: number[] }): GraphicOverlay;
  polyline(coords: [number, number][], options?: ShapeOptions): OverlayItem;
  circle(ra: number, dec: number, radiusDeg: number, options?: ShapeOptions): OverlayItem;
}

export interface AladinExtra extends Aladin {
  setOverlayImageLayer(layer: HiPS | ImageLayer | string, name?: string): HiPS;
  addOverlay(overlay: GraphicOverlay): void;
  removeOverlay(overlay: GraphicOverlay | Catalog): void;
  addCatalog(catalog: Catalog): void;
  setCooGrid?(options: { enabled?: boolean; color?: string; opacity?: number; labelSize?: number; showLabels?: boolean }): void;
  showReticle?(show: boolean): void;
  world2pix(ra: number, dec: number): [number, number] | null;
  pix2world(x: number, y: number): [number, number] | null;
}

export function extra(session: AladinSession): { A: AladinStaticExtra; aladin: AladinExtra } {
  return {
    A: session.A as unknown as AladinStaticExtra,
    aladin: session.aladin as unknown as AladinExtra,
  };
}
