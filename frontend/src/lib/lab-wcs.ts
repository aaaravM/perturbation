// Small sky-geometry helpers for the Lab workbench: the TAN projection of a field's grid (so a
// cursor position can be looked up in a frame or flags image), ICRS to galactic coordinates, and
// the position angle between two points.

import type { AladinWcs } from "@/lib/manifest";
import type { RaDec } from "@/lib/lab-coords";

const D2R = Math.PI / 180;

export interface TanGrid {
  crval1: number;
  crval2: number;
  crpix1: number;
  crpix2: number;
  cd11: number;
  cd12: number;
  cd21: number;
  cd22: number;
  width: number;
  height: number;
}

/** The linear part of a TAN WCS (CD matrix, or CDELT without rotation). */
export function tanFromWcs(wcs: AladinWcs, width: number, height: number): TanGrid | null {
  const n = (key: string) => {
    const v = Number(wcs[key]);
    return Number.isFinite(v) ? v : null;
  };
  const crval1 = n("CRVAL1");
  const crval2 = n("CRVAL2");
  const crpix1 = n("CRPIX1");
  const crpix2 = n("CRPIX2");
  if (crval1 === null || crval2 === null || crpix1 === null || crpix2 === null) return null;
  let cd11 = n("CD1_1");
  let cd22 = n("CD2_2");
  let cd12 = n("CD1_2") ?? 0;
  let cd21 = n("CD2_1") ?? 0;
  if (cd11 === null || cd22 === null) {
    cd11 = n("CDELT1");
    cd22 = n("CDELT2");
    cd12 = 0;
    cd21 = 0;
  }
  if (cd11 === null || cd22 === null) return null;
  return { crval1, crval2, crpix1, crpix2, cd11, cd12, cd21, cd22, width, height };
}

/** ICRS degrees to 1-based FITS pixel coordinates on the grid (null on the far side). */
export function worldToPixel(g: TanGrid, ra: number, dec: number): { x: number; y: number } | null {
  const a0 = g.crval1 * D2R;
  const d0 = g.crval2 * D2R;
  const a = ra * D2R;
  const d = dec * D2R;
  const cosc = Math.sin(d0) * Math.sin(d) + Math.cos(d0) * Math.cos(d) * Math.cos(a - a0);
  if (cosc <= 1e-9) return null;
  const xi = (Math.cos(d) * Math.sin(a - a0)) / cosc / D2R;
  const eta = (Math.cos(d0) * Math.sin(d) - Math.sin(d0) * Math.cos(d) * Math.cos(a - a0)) / cosc / D2R;
  const det = g.cd11 * g.cd22 - g.cd12 * g.cd21;
  if (Math.abs(det) < 1e-18) return null;
  const dx = (g.cd22 * xi - g.cd12 * eta) / det;
  const dy = (-g.cd21 * xi + g.cd11 * eta) / det;
  return { x: dx + g.crpix1, y: dy + g.crpix2 };
}

/** 1-based FITS pixel to ICRS degrees. */
export function pixelToWorld(g: TanGrid, x: number, y: number): RaDec {
  const dx = x - g.crpix1;
  const dy = y - g.crpix2;
  const xi = (g.cd11 * dx + g.cd12 * dy) * D2R;
  const eta = (g.cd21 * dx + g.cd22 * dy) * D2R;
  const a0 = g.crval1 * D2R;
  const d0 = g.crval2 * D2R;
  const denom = Math.cos(d0) - eta * Math.sin(d0);
  const a = a0 + Math.atan2(xi, denom);
  const d = Math.atan2(Math.sin(d0) + eta * Math.cos(d0), Math.hypot(xi, denom));
  return { ra: (((a / D2R) % 360) + 360) % 360, dec: d / D2R };
}

/**
 * Row and column of a PNG frame at a sky position. PNG rows run top down while FITS y runs
 * bottom up, so row 0 is the top (north) edge. null outside the image.
 */
export function pngPixelAt(g: TanGrid, ra: number, dec: number): { col: number; row: number } | null {
  const p = worldToPixel(g, ra, dec);
  if (!p) return null;
  const col = Math.round(p.x) - 1;
  const row = g.height - Math.round(p.y);
  if (col < 0 || row < 0 || col >= g.width || row >= g.height) return null;
  return { col, row };
}

/** The four sky corners of the grid (pixel edges), for drawing a footprint. */
export function gridCorners(g: TanGrid): RaDec[] {
  return [
    pixelToWorld(g, 0.5, 0.5),
    pixelToWorld(g, g.width + 0.5, 0.5),
    pixelToWorld(g, g.width + 0.5, g.height + 0.5),
    pixelToWorld(g, 0.5, g.height + 0.5),
  ];
}

// ICRS (J2000) to galactic rotation (Hipparcos convention).
const GAL = [
  [-0.0548755604162154, -0.873437090234885, -0.4838350155487132],
  [0.4941094278755837, -0.4448296299600112, 0.7469822444972189],
  [-0.8676661490190047, -0.1980763734312015, 0.4559837761750669],
];

/** Galactic longitude and latitude in degrees. */
export function toGalactic(ra: number, dec: number): { l: number; b: number } {
  const a = ra * D2R;
  const d = dec * D2R;
  const v = [Math.cos(d) * Math.cos(a), Math.cos(d) * Math.sin(a), Math.sin(d)];
  const g = GAL.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]);
  const l = Math.atan2(g[1], g[0]) / D2R;
  const b = Math.asin(Math.max(-1, Math.min(1, g[2]))) / D2R;
  return { l: ((l % 360) + 360) % 360, b };
}

/** Position angle of b as seen from a, east of north, in [0, 360). */
export function positionAngleDeg(a: RaDec, b: RaDec): number {
  const d1 = a.dec * D2R;
  const d2 = b.dec * D2R;
  const da = (b.ra - a.ra) * D2R;
  const y = Math.sin(da) * Math.cos(d2);
  const x = Math.cos(d1) * Math.sin(d2) - Math.sin(d1) * Math.cos(d2) * Math.cos(da);
  const pa = Math.atan2(y, x) / D2R;
  return ((pa % 360) + 360) % 360;
}

/** Angles for display: arcsec below 1', arcmin below 1 degree, else degrees. */
export function formatAngle(deg: number): string {
  const arcsec = deg * 3600;
  if (arcsec < 60) return `${arcsec < 10 ? arcsec.toFixed(2) : arcsec.toFixed(1)}″`;
  const arcmin = deg * 60;
  if (arcmin < 60) return `${arcmin.toFixed(2)}′`;
  return `${deg.toFixed(3)}°`;
}
