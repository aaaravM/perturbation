// Sky-globe geometry, shared by the 3D globe, its markers and the flat fallback map.
//
// Texture convention (documented in public/textures/spherex-sky.json and
// scripts/make_sky_texture.py): plate carree in ICRS, RA = 0 at the LEFT edge increasing to the
// RIGHT, Dec = +90 on the top row, i.e. u = RA / 360 and v_from_top = (90 - Dec) / 180, laid onto
// three.js SphereGeometry default UVs (flipY = true). SphereGeometry puts u at azimuth phi = RA and
// v at polar angle theta = 90 deg - Dec, so a sky position sits at
//     x = -cos(Dec) cos(RA),   y = sin(Dec),   z = cos(Dec) sin(RA)      (unit sphere, object space)
// Seen from outside, RA increases to the right, as on a classic celestial globe: the sky appears
// mirror-reversed compared with the view from the ground.

export const DEG = Math.PI / 180;

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Unit vector (object space of the globe) for a sky position in degrees. */
export function radecToVector(raDeg: number, decDeg: number): Vec3 {
  const ra = raDeg * DEG;
  const dec = decDeg * DEG;
  const c = Math.cos(dec);
  return { x: -c * Math.cos(ra), y: Math.sin(dec), z: c * Math.sin(ra) };
}

/** Inverse of radecToVector. RA in [0, 360), Dec in [-90, 90]. */
export function vectorToRadec(x: number, y: number, z: number): { ra: number; dec: number } {
  const r = Math.hypot(x, y, z) || 1;
  const dec = Math.asin(Math.max(-1, Math.min(1, y / r))) / DEG;
  let ra = Math.atan2(z, -x) / DEG;
  if (ra < 0) ra += 360;
  return { ra: ra >= 360 ? ra - 360 : ra, dec };
}

/**
 * Globe orientation that puts (ra, dec) at the centre of the view. The globe is first spun about
 * its polar axis by `yaw`, then tilted about the screen's horizontal axis by `pitch`
 * (Euler order XYZ in three.js), and the camera looks down -z.
 */
export function facingRotation(raDeg: number, decDeg: number): { yaw: number; pitch: number } {
  return { yaw: Math.PI / 2 - raDeg * DEG, pitch: decDeg * DEG };
}

/** Sky position at the centre of the view for a given orientation. */
export function centreOfView(yaw: number, pitch: number): { ra: number; dec: number } {
  let ra = (Math.PI / 2 - yaw) / DEG;
  ra = ((ra % 360) + 360) % 360;
  return { ra, dec: pitch / DEG };
}

/** Wrap an angle to (-pi, pi]. */
export function wrapAngle(a: number): number {
  const t = (a + Math.PI) % (2 * Math.PI);
  return (t < 0 ? t + 2 * Math.PI : t) - Math.PI;
}

/** Great-circle distance in degrees. */
export function angularDistance(ra1: number, dec1: number, ra2: number, dec2: number): number {
  const a = radecToVector(ra1, dec1);
  const b = radecToVector(ra2, dec2);
  const dot = a.x * b.x + a.y * b.y + a.z * b.z;
  return Math.acos(Math.max(-1, Math.min(1, dot))) / DEG;
}

// North Galactic Pole in ICRS (Hipparcos / IAU 1958 frame transformed to ICRS).
const NGP_RA = 192.85948 * DEG;
const NGP_DEC = 27.12825 * DEG;

/** Galactic latitude (deg) of an ICRS position: how far it lies from the plane of the Milky Way. */
export function galacticLatitude(raDeg: number, decDeg: number): number {
  const ra = raDeg * DEG;
  const dec = decDeg * DEG;
  const s = Math.sin(dec) * Math.sin(NGP_DEC) + Math.cos(dec) * Math.cos(NGP_DEC) * Math.cos(ra - NGP_RA);
  return Math.asin(Math.max(-1, Math.min(1, s))) / DEG;
}

export function formatRa(ra: number, digits = 3): string {
  return `${ra.toFixed(digits)}°`;
}

export function formatDec(dec: number, digits = 3): string {
  const v = dec.toFixed(digits);
  return `${dec >= 0 && !v.startsWith("-") ? "+" : ""}${v.replace("-", "−")}°`;
}
