// The Sky-mode camera: it flies round the SPHEREx globe (radius 1, fixed at the origin with the
// texture's own orientation, see globe-math.ts) instead of turning the globe in front of it.
//
// The rig is three numbers and a lens shift:
//   ra, dec   the sky position straight below the camera (the "sub-camera point", degrees)
//   alt       height above the surface in globe radii (camera distance = 1 + alt)
//   pan       a small sideways shift of the picture (px), for nudging the globe off-centre
// North stays up. Far out the camera looks at the centre of the globe; near the surface it tips
// its view up towards the northern horizon and widens its lens a little, so skimming the surface
// shows the curve of the globe against space rather than a flat patch of pixels.

import * as THREE from "three";
import { DEG, radecToVector, vectorToRadec } from "@/components/globe/globe-math";

/** Closest approach: 5% of a radius above the surface (closer, the 8k map is only blur). */
export const ALT_MIN = 0.05;
/** Furthest out on a typical screen: the whole globe small among the stars. */
export const ALT_MAX = 7;
/** The camera never quite reaches a pole, so "north is up" always has a meaning. */
export const DEC_LIMIT = 89;

export interface Rig {
  ra: number;
  dec: number;
  alt: number;
  panX: number;
  panY: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export const smoothstep = (a: number, b: number, v: number) => {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Vertical field of view (deg): a long lens far out, a little wider when skimming the surface. */
export function fovFor(alt: number): number {
  return 30 + 16 * (1 - smoothstep(ALT_MIN, 0.8, alt));
}

/** How far the view tips up from straight down towards the horizon (rad). */
export function tiltFor(alt: number): number {
  const t = 1 - smoothstep(ALT_MIN, 0.55, alt);
  return 66 * DEG * t * t * (1.6 - 0.6 * t);
}

/** Altitude at which the globe's disc has the given radius on screen (px), for a canvas height. */
export function altitudeForRadius(radiusPx: number, heightPx: number): number {
  const tanHalf = Math.tan((fovFor(ALT_MAX) / 2) * DEG);
  const alpha = Math.atan((radiusPx / (heightPx / 2)) * tanHalf);
  return 1 / Math.sin(alpha) - 1;
}

/** Screen pixels per radian of sky at the point below the camera: the scale of the view. */
export function pixelsPerRadian(alt: number, heightPx: number): number {
  return heightPx / 2 / (alt * Math.tan((fovFor(alt) / 2) * DEG));
}

const _n = new THREE.Vector3();
const _f = new THREE.Vector3();
const _r = new THREE.Vector3();
const _u = new THREE.Vector3();
const _t = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

/**
 * Put the camera where the rig says. `offset` is the lens shift (px) that centres the globe in the
 * part of the canvas the interface leaves free, plus the user's pan.
 */
export function applyRig(
  camera: THREE.PerspectiveCamera,
  rig: Rig,
  width: number,
  height: number,
  offsetX: number,
  offsetY: number,
) {
  const v = radecToVector(rig.ra, rig.dec);
  _n.set(v.x, v.y, v.z);
  const distance = 1 + rig.alt;
  camera.position.copy(_n).multiplyScalar(distance);
  // Looking straight down: forward = -n; right and up complete a north-up frame.
  _f.copy(_n).negate();
  _r.crossVectors(_f, UP);
  if (_r.lengthSq() < 1e-10) _r.set(1, 0, 0);
  _r.normalize();
  _u.crossVectors(_r, _f).normalize();
  // Tip the view towards the northern horizon.
  const tilt = tiltFor(rig.alt);
  const c = Math.cos(tilt);
  const s = Math.sin(tilt);
  _t.copy(_f).multiplyScalar(c).addScaledVector(_u, s); // new forward
  _u.multiplyScalar(c).addScaledVector(_f, -s); // new up
  camera.up.copy(_u);
  camera.lookAt(_t.add(camera.position));
  camera.fov = fovFor(rig.alt);
  camera.near = Math.max(0.002, rig.alt * 0.3);
  camera.far = 400;
  camera.setViewOffset(width, height, -offsetX, -offsetY, width, height);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
}

const _ray = new THREE.Raycaster();
const _ndc = new THREE.Vector2();
const _sphere = new THREE.Sphere(new THREE.Vector3(), 1);

/** Point of the globe under a canvas pixel, or null for empty space. */
export function pickGlobe(
  camera: THREE.Camera,
  x: number,
  y: number,
  width: number,
  height: number,
  target = new THREE.Vector3(),
): THREE.Vector3 | null {
  _ndc.set((x / width) * 2 - 1, -(y / height) * 2 + 1);
  _ray.setFromCamera(_ndc, camera);
  return _ray.ray.intersectSphere(_sphere, target);
}

/** Sky position (deg) of a point of the globe. */
export function pointToRadec(p: THREE.Vector3): { ra: number; dec: number } {
  return vectorToRadec(p.x, p.y, p.z);
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _q = new THREE.Quaternion();

/**
 * Move the rig's sub-camera point by the rotation that carries `from` to `to` (both on the
 * globe), e.g. to keep the point under the cursor fixed while zooming.
 */
export function rotateRig(rig: Rig, from: THREE.Vector3, to: THREE.Vector3) {
  _a.copy(from).normalize();
  _b.copy(to).normalize();
  if (_a.distanceToSquared(_b) < 1e-14) return;
  _q.setFromUnitVectors(_a, _b);
  const v = radecToVector(rig.ra, rig.dec);
  _n.set(v.x, v.y, v.z).applyQuaternion(_q);
  const rd = vectorToRadec(_n.x, _n.y, _n.z);
  rig.ra = rd.ra;
  rig.dec = clamp(rd.dec, -DEC_LIMIT, DEC_LIMIT);
}

/** Great-circle interpolation between two sky positions (deg); t in 0..1. */
export function slerpRadec(
  ra0: number,
  dec0: number,
  ra1: number,
  dec1: number,
  t: number,
): { ra: number; dec: number; angle: number } {
  const a = radecToVector(ra0, dec0);
  const b = radecToVector(ra1, dec1);
  const dot = clamp(a.x * b.x + a.y * b.y + a.z * b.z, -1, 1);
  const angle = Math.acos(dot);
  if (angle < 1e-6) return { ra: ra1, dec: dec1, angle: 0 };
  const sa = Math.sin(angle);
  // Exactly opposite: any great circle will do; nudge the end so one is defined.
  if (sa < 1e-4) return slerpRadec(ra0, dec0, ra1 + 0.5, dec1 + (dec1 < 80 ? 0.5 : -0.5), t);
  const wa = Math.sin((1 - t) * angle) / sa;
  const wb = Math.sin(t * angle) / sa;
  const r = vectorToRadec(a.x * wa + b.x * wb, a.y * wa + b.y * wb, a.z * wa + b.z * wb);
  return { ra: r.ra, dec: r.dec, angle };
}
