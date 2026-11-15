"use client";
// Sky mode's globe (react-three-fiber): the real stars of the Hipparcos catalogue as dots in
// their own colours on a celestial sphere you fly around from outside, and the same stars
// unfolded into 3D space around the Sun at their measured distances.
//
// Sphere: the globe stays put and the camera flies round it (camera-rig.ts): drag to orbit with
// inertia, scroll or pinch to zoom towards the cursor, right-drag or Shift-drag to pan, double-
// click to fly in, arrow keys and +/-. Fainter stars fade in as the view comes closer. The
// SPHEREx all-sky map and the constellation figures are optional layers.
//
// 3D space: every star moves from the sphere to its place in space (star-field.ts), nearest
// first; the camera orbits a point (the Sun at first) and flies to a star when it is clicked.
//
// Almost every star can be picked: hover shows a ring and a label, a click selects it. Picking
// uses the catalogue's grid on the sphere and a projection of the 3D positions in space, with a
// radius in pixels that favours brighter stars.
//
// Rendering runs on demand: a frame is drawn only while something moves. Rings, labels and
// markers are DOM elements positioned from the same projection every frame.

import {
  Component,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { cn } from "@/lib/utils";
import { KEY_LIGHT_VIEW, createGlobeMaterial } from "@/components/globe/globe-material";
import { DEG, radecToVector } from "@/components/globe/globe-math";
import {
  ALT_MAX,
  ALT_MIN,
  DEC_LIMIT,
  altitudeForRadius,
  applyRig,
  fovFor,
  pickGlobe,
  pixelsPerRadian,
  pointToRadec,
  rotateRig,
  slerpRadec,
  smoothstep,
  tiltFor,
  type Rig,
} from "@/components/globe/camera-rig";
import {
  buildConstellationGeometry,
  createLineMaterial,
  loadSkyLines,
  type SkyLines,
} from "@/components/globe/sky-layers";
import { SKY_TEXTURE_2K, SKY_TEXTURE_4K, SKY_TEXTURE_8K, SKY_TEXTURE_MONO } from "@/components/globe/sky-assets";
import {
  RING_LY,
  SPACE_SHELL,
  buildRings,
  buildTierField,
  createRingMaterial,
  createStarFieldMaterial,
  easeInOutCubic,
  fieldPosition,
  morphOf,
  ringPoint,
  spaceRadius,
  type StarFieldMaterial,
  type TierField,
} from "@/components/globe/star-field";
import { LY_PER_PC, distancePc, getStar, queryTier, starTitle, type Catalogue, type StarTier } from "@/lib/stars";

export type GlobeView = "colour" | "mono";
export type SkyMode = "sphere" | "space";

export type GlobeSelection =
  | { kind: "target"; slug: string }
  | { kind: "star"; id: number }
  | { kind: "spot"; ra: number; dec: number }
  | null;

export interface GlobeMarker {
  slug: string;
  name: string;
  ra: number;
  dec: number;
  /** Distance for 3D space, or null to leave it on the outer shell. */
  distancePc: number | null;
}

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface SkyLayerToggles {
  /** The SPHEREx all-sky map on the sphere. */
  spherex: boolean;
  /** Constellation figures and names. */
  constellations: boolean;
  /** Names of the brightest stars. */
  names: boolean;
  /** RA/Dec grid. */
  grid: boolean;
  /** The five challenge targets. */
  markers: boolean;
}

export interface GlobeHandle {
  /** factor > 1 comes closer. */
  zoomBy: (factor: number) => void;
  resetView: () => void;
  focus: () => void;
}

export interface SkyGlobeProps {
  catalogue: Catalogue | null;
  markers: GlobeMarker[];
  selection: GlobeSelection;
  /** A challenge target highlighted from the side list. */
  hovered: string | null;
  /** A star highlighted from the side list. */
  railStar: number | null;
  onHoverChange: (slug: string | null) => void;
  onSelectTarget: (slug: string) => void;
  onSelectStar: (id: number) => void;
  onSelectSpot: (ra: number, dec: number) => void;
  mode: SkyMode;
  layers: SkyLayerToggles;
  view: GlobeView;
  /** Opacity of the SPHEREx imagery when its layer is on, 0..1. */
  imagery: number;
  insets: Insets;
  reducedMotion: boolean;
  onTextureReady?: () => void;
  onCentreChange?: (ra: number, dec: number) => void;
  onUnavailable: () => void;
  handleRef?: Ref<GlobeHandle>;
}

const IDLE_MS = 7000;
const AUTO_SPEED = 1.2; // deg/s, sidereal sense
const AUTO_SPEED_SPACE = 2.2; // deg/s, a slow orbit
const INERTIA_TAU = 0.62;
/** Where the globe faces on arrival: Orion and the winter Milky Way, with Sirius below. */
const HOME = { ra: 92, dec: 4 };
const FOCUS_HALF_SPAN = 24;
const STAR_HALF_SPAN = 11;
const SPACE_FOV = 50;
const SPACE_HOME_DIST = 8.8;
const SPACE_MIN_DIST = 0.035;
const SPACE_MAX_DIST = 18;
const SPACE_STAR_DIST = 0.42;
const MORPH_MS = 2400;

/** Well-known stars labelled in 3D space (HIP numbers) and whether they are close neighbours. */
const SPACE_LABELS: { hip: number; name: string; near: boolean }[] = [
  { hip: 70890, name: "Proxima Centauri", near: true },
  { hip: 71683, name: "Alpha Centauri", near: true },
  { hip: 87937, name: "Barnard's Star", near: true },
  { hip: 54035, name: "Lalande 21185", near: true },
  { hip: 32349, name: "Sirius", near: true },
  { hip: 16537, name: "Epsilon Eridani", near: true },
  { hip: 104214, name: "61 Cygni", near: true },
  { hip: 37279, name: "Procyon", near: true },
  { hip: 8102, name: "Tau Ceti", near: true },
  { hip: 91262, name: "Vega", near: false },
  { hip: 97649, name: "Altair", near: false },
  { hip: 69673, name: "Arcturus", near: false },
  { hip: 21421, name: "Aldebaran", near: false },
  { hip: 27989, name: "Betelgeuse", near: false },
  { hip: 24436, name: "Rigel", near: false },
  { hip: 80763, name: "Antares", near: false },
  { hip: 11767, name: "Polaris", near: false },
  { hip: 30438, name: "Canopus", near: false },
];

interface RigTween {
  from: Rig;
  to: Rig;
  start: number;
  dur: number;
  arc: number;
  ease: (t: number) => number;
  onDone?: () => void;
}

interface SpaceTween {
  fromT: THREE.Vector3;
  toT: THREE.Vector3;
  fromD: number;
  toD: number;
  start: number;
  dur: number;
  onDone?: () => void;
}

interface MorphAnim {
  from: number;
  to: number;
  start: number;
  dur: number;
  fromT: THREE.Vector3;
  toT: THREE.Vector3;
  fromD: number;
  toD: number;
  fromFov: number;
  toFov: number;
  fromRa: number;
  toRa: number;
  fromDec: number;
  toDec: number;
  onDone?: () => void;
}

interface StarRef {
  f: number;
  i: number;
  id: number;
}

interface Ctl {
  rig: Rig;
  altTarget: number;
  followHome: boolean;
  homeAlt: number;
  focusAlt: number;
  starAlt: number;
  altMax: number;
  vRa: number;
  vDec: number;
  panTargetX: number;
  panTargetY: number;
  auto: number;
  tween: RigTween | null;
  anchor: { x: number; y: number; point: THREE.Vector3; pinch: boolean } | null;
  dragging: boolean;
  hoverMarker: boolean;
  highlighted: boolean;
  lastInteraction: number;
  entrance: boolean;
  entranceStart: number;
  pending: (() => void)[];
  dirty: boolean;
  dx: number;
  dy: number;
  width: number;
  height: number;
  opacity: number;
  mapMix: number;
  mapReady: boolean;
  wantMono: boolean;
  monoReady: boolean;
  mono: number;
  imagery: number;
  imageryTarget: number;
  grid: number;
  stars: number;
  lines: number;
  layers: SkyLayerToggles;
  linesReady: boolean;
  wantSharp: boolean;
  allowAuto: boolean;
  reduced: boolean;
  coarse: boolean;
  insets: Insets;
  camera: THREE.PerspectiveCamera | null;
  invalidate: () => void;
  // 3D space
  cam: SkyMode;
  morph: number;
  morphAnim: MorphAnim | null;
  spaceTarget: THREE.Vector3;
  spaceDist: number;
  spaceDistTarget: number;
  spaceTween: SpaceTween | null;
  fov: number;
  fields: TierField[];
  magLimit: number;
  magLimitSpace: number;
  hover: StarRef | null;
  railHover: StarRef | null;
  sel: StarRef | null;
}

const easeOutExpo = (t: number) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t));
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const wrap180 = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;
const wrap360 = (d: number) => ((d % 360) + 360) % 360;

function fitLayout(width: number, height: number, insets: Insets) {
  const w = Math.max(160, width - insets.left - insets.right);
  const h = Math.max(160, height - insets.top - insets.bottom);
  return {
    radius: Math.min(h * 0.42, w * 0.45),
    freeHeight: h,
    dx: (insets.left - insets.right) / 2,
    dy: (insets.top - insets.bottom) / 2,
  };
}

const _up = new THREE.Vector3(0, 1, 0);
function applySpace(
  camera: THREE.PerspectiveCamera,
  rig: Rig,
  target: THREE.Vector3,
  dist: number,
  fov: number,
  width: number,
  height: number,
  ox: number,
  oy: number,
) {
  const v = radecToVector(rig.ra, rig.dec);
  camera.position.set(target.x + v.x * dist, target.y + v.y * dist, target.z + v.z * dist);
  camera.up.copy(_up);
  camera.lookAt(target);
  camera.fov = fov;
  camera.near = Math.max(0.002, dist * 0.02);
  camera.far = 400;
  camera.setViewOffset(width, height, -ox, -oy, width, height);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
}

function vec3(ra: number, dec: number): THREE.Vector3 {
  const v = radecToVector(ra, dec);
  return new THREE.Vector3(v.x, v.y, v.z);
}

// ----------------------------------------------------------------------------------------------
// Overlay elements positioned every frame.

interface LabelEntry {
  key: string;
  el: HTMLElement | null;
  v: THREE.Vector3;
  kind: "constellation" | "star";
  level: number;
  shown: boolean;
}

interface SpaceLabelEntry {
  key: string;
  el: HTMLElement | null;
  ref: StarRef;
  near: boolean;
}

interface OverlayRefs {
  markers: React.RefObject<Record<string, HTMLDivElement | null>>;
  spot: React.RefObject<HTMLDivElement | null>;
  focus: React.RefObject<HTMLDivElement | null>;
  labels: React.RefObject<LabelEntry[]>;
  hover: React.RefObject<HTMLDivElement | null>;
  sel: React.RefObject<HTMLDivElement | null>;
  sun: React.RefObject<HTMLDivElement | null>;
  rings: React.RefObject<(HTMLDivElement | null)[]>;
  legend: React.RefObject<HTMLDivElement | null>;
  spaceLabels: React.RefObject<SpaceLabelEntry[]>;
}

// ----------------------------------------------------------------------------------------------
// Scene runtime: everything that runs per frame, kept out of React render.

class GlobeRuntime {
  material = createGlobeMaterial();
  geometry = new THREE.SphereGeometry(1, 192, 96);
  lineMaterial = createLineMaterial();
  ringMaterial = createRingMaterial();
  ringGeometry = buildRings();
  pathMaterial = new THREE.LineBasicMaterial({
    color: new THREE.Color("#f0885a"),
    transparent: true,
    opacity: 0,
    depthTest: false,
    depthWrite: false,
  });
  pathGeometry = new THREE.BufferGeometry().setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array(6), 3),
  );
  path = new THREE.Line(this.pathGeometry, this.pathMaterial);
  starMaterials: StarFieldMaterial[] = [];
  private tmp = new THREE.Vector3();
  private tmp2 = new THREE.Vector3();
  private lastCentre = 0;
  private centreStale = true;
  private trailing: ReturnType<typeof setTimeout> | null = null;
  private lastX = 0;
  private markersSrc: GlobeMarker[] | null = null;
  private markerVectors: { slug: string; v: THREE.Vector3; space: THREE.Vector3; delay: number }[] = [];
  private spotSrc: { ra: number; dec: number } | null = null;
  private spotVector: THREE.Vector3 | null = null;
  private sharpLoader: () => void = () => {};
  private fieldFade = new Map<TierField, number>();

  constructor() {
    this.material.uniforms.uBase.value = new THREE.Color("#0a0a0a");
    this.path.renderOrder = 3;
    this.path.frustumCulled = false;
  }

  onNeedSharp(load: () => void) {
    this.sharpLoader = load;
  }

  materialFor(index: number): StarFieldMaterial {
    while (this.starMaterials.length <= index) this.starMaterials.push(createStarFieldMaterial());
    return this.starMaterials[index];
  }

  setTexture(c: Ctl, texture: THREE.Texture, maxAnisotropy: number, which: "map" | "mono") {
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = Math.min(16, maxAnisotropy);
    texture.wrapS = THREE.RepeatWrapping;
    texture.needsUpdate = true;
    const uniform = which === "map" ? this.material.uniforms.uMap : this.material.uniforms.uMapMono;
    const old = uniform.value;
    uniform.value = texture;
    if (old && old !== texture && !(old instanceof THREE.DataTexture)) old.dispose();
    if (which === "map") c.mapReady = true;
    else c.monoReady = true;
    c.invalidate();
  }

  dispose() {
    if (this.trailing) clearTimeout(this.trailing);
    this.geometry.dispose();
    this.material.uniforms.uMap.value?.dispose();
    this.material.uniforms.uMapMono.value?.dispose();
    this.material.dispose();
    this.lineMaterial.dispose();
    this.ringMaterial.dispose();
    this.ringGeometry.dispose();
    this.pathMaterial.dispose();
    this.pathGeometry.dispose();
    this.starMaterials.forEach((m) => m.dispose());
  }

  step(
    c: Ctl,
    state: { size: { width: number; height: number }; invalidate: () => void; viewport: { dpr: number } },
    delta: number,
    camera: THREE.PerspectiveCamera,
    markers: GlobeMarker[],
    spot: { ra: number; dec: number } | null,
    overlay: OverlayRefs,
    onCentreChange?: (ra: number, dec: number, alt: number) => void,
  ) {
    if (markers !== this.markersSrc) {
      this.markersSrc = markers;
      this.markerVectors = markers.map((m) => {
        const v = vec3(m.ra, m.dec);
        const r = m.distancePc ? spaceRadius(m.distancePc) : SPACE_SHELL;
        return { slug: m.slug, v, space: v.clone().multiplyScalar(r), delay: clamp((r - 0.25) / (SPACE_SHELL - 0.25), 0, 1) };
      });
    }
    if (spot !== this.spotSrc) {
      this.spotSrc = spot;
      this.spotVector = spot ? vec3(spot.ra, spot.dec) : null;
    }
    const tmp = this.tmp;
    const dt = Math.min(0.05, delta);
    const now = performance.now();
    const { width, height } = state.size;
    c.width = width;
    c.height = height;
    let moving = false;
    const rig = c.rig;

    const fit = fitLayout(width, height, c.insets);
    c.homeAlt = clamp(altitudeForRadius(fit.radius, height), 0.8, 14);
    c.altMax = Math.max(ALT_MAX, c.homeAlt * 2.2);
    const focusAltFor = (half: number) => {
      const ppr = fit.freeHeight / 2 / (half * DEG);
      return clamp(height / 2 / (ppr * Math.tan((fovFor(2) / 2) * DEG)), 0.45, c.homeAlt);
    };
    c.focusAlt = focusAltFor(FOCUS_HALF_SPAN);
    c.starAlt = focusAltFor(STAR_HALF_SPAN);

    if (c.pending.length) {
      const queue = c.pending;
      c.pending = [];
      if (c.entrance) {
        c.entrance = false;
        c.entranceStart = now - 4000;
        rig.alt = c.altTarget = c.homeAlt * 1.2;
      }
      queue.forEach((run) => run());
    }
    if (c.entrance) {
      c.entrance = false;
      c.entranceStart = now;
      if (c.reduced) {
        rig.alt = c.altTarget = c.homeAlt;
      } else {
        rig.alt = c.altTarget = c.homeAlt * 1.6;
        c.tween = {
          from: { ...rig },
          to: { ra: HOME.ra, dec: HOME.dec, alt: c.homeAlt, panX: 0, panY: 0 },
          start: now + 120,
          dur: 2800,
          arc: 0,
          ease: easeOutExpo,
        };
        c.lastInteraction = now - IDLE_MS + 2500;
      }
    }

    // ---------------------------------------------------------------- morph between modes
    if (c.morphAnim) {
      const a = c.morphAnim;
      const t = c.reduced ? 1 : clamp((now - a.start) / a.dur, 0, 1);
      c.morph = a.from + (a.to - a.from) * t;
      const e = easeInOutCubic(t);
      c.spaceTarget.lerpVectors(a.fromT, a.toT, e);
      c.spaceDist = Math.exp(Math.log(a.fromD) + (Math.log(a.toD) - Math.log(a.fromD)) * e);
      c.fov = a.fromFov + (a.toFov - a.fromFov) * e;
      rig.ra = wrap360(a.fromRa + wrap180(a.toRa - a.fromRa) * e);
      rig.dec = a.fromDec + (a.toDec - a.fromDec) * e;
      if (t >= 1) {
        c.morphAnim = null;
        c.morph = a.to;
        c.spaceDistTarget = c.spaceDist;
        if (a.to === 0) {
          c.cam = "sphere";
          rig.alt = c.altTarget = Math.max(ALT_MIN, c.spaceDist - 1);
          rig.panX = rig.panY = c.panTargetX = c.panTargetY = 0;
        }
        a.onDone?.();
      }
      moving = true;
    } else if (c.cam === "sphere") {
      // ---------------------------------------------------------------- sphere camera
      if (c.tween) {
        const tw = c.tween;
        const t = clamp((now - tw.start) / tw.dur, 0, 1);
        const e = tw.ease(t);
        const p = slerpRadec(tw.from.ra, tw.from.dec, tw.to.ra, tw.to.dec, e);
        rig.ra = p.ra;
        rig.dec = clamp(p.dec, -DEC_LIMIT, DEC_LIMIT);
        const logAlt = Math.log(tw.from.alt) + (Math.log(tw.to.alt) - Math.log(tw.from.alt)) * e;
        rig.alt = Math.exp(logAlt) * (1 + tw.arc * Math.sin(Math.PI * e));
        rig.panX = tw.from.panX + (tw.to.panX - tw.from.panX) * e;
        rig.panY = tw.from.panY + (tw.to.panY - tw.from.panY) * e;
        c.altTarget = rig.alt;
        c.panTargetX = rig.panX;
        c.panTargetY = rig.panY;
        if (t >= 1) {
          c.tween = null;
          c.altTarget = tw.to.alt;
          tw.onDone?.();
        }
        moving = true;
      } else {
        if (!c.dragging) moving = this.coast(c, dt, now, AUTO_SPEED, rig.alt > c.homeAlt * 0.7) || moving;
        if (c.followHome) c.altTarget = c.homeAlt;
        c.altTarget = clamp(c.altTarget, ALT_MIN, c.altMax);
        if (Math.abs(Math.log(c.altTarget / rig.alt)) > 1e-4) {
          const k = c.reduced || c.anchor?.pinch ? 1 : 1 - Math.exp(-dt / 0.12);
          rig.alt = Math.exp(Math.log(rig.alt) + (Math.log(c.altTarget) - Math.log(rig.alt)) * k);
          moving = true;
        } else if (c.anchor && !c.anchor.pinch) {
          c.anchor = null;
        }
        const kp = c.dragging ? 1 : 1 - Math.exp(-dt / 0.14);
        if (Math.abs(c.panTargetX - rig.panX) + Math.abs(c.panTargetY - rig.panY) > 0.1) {
          rig.panX += (c.panTargetX - rig.panX) * kp;
          rig.panY += (c.panTargetY - rig.panY) * kp;
          moving = true;
        }
      }
      c.fov = fovFor(rig.alt);
    } else {
      // ---------------------------------------------------------------- space camera
      if (c.spaceTween) {
        const tw = c.spaceTween;
        const t = c.reduced ? 1 : clamp((now - tw.start) / tw.dur, 0, 1);
        const e = easeInOutCubic(t);
        c.spaceTarget.lerpVectors(tw.fromT, tw.toT, e);
        // Pull back a little mid-flight, so a long hop reads as a flight.
        const hop = tw.fromT.distanceTo(tw.toT);
        const lift = 1 + Math.min(0.8, hop * 0.35) * Math.sin(Math.PI * e);
        c.spaceDist = Math.exp(Math.log(tw.fromD) + (Math.log(tw.toD) - Math.log(tw.fromD)) * e) * lift;
        c.spaceDistTarget = tw.toD;
        if (t >= 1) {
          c.spaceTween = null;
          c.spaceDist = tw.toD;
          tw.onDone?.();
        }
        moving = true;
      } else {
        if (!c.dragging) moving = this.coast(c, dt, now, AUTO_SPEED_SPACE, true) || moving;
        c.spaceDistTarget = clamp(c.spaceDistTarget, SPACE_MIN_DIST, SPACE_MAX_DIST);
        if (Math.abs(Math.log(c.spaceDistTarget / c.spaceDist)) > 1e-4) {
          const k = c.reduced ? 1 : 1 - Math.exp(-dt / 0.14);
          c.spaceDist = Math.exp(Math.log(c.spaceDist) + (Math.log(c.spaceDistTarget) - Math.log(c.spaceDist)) * k);
          moving = true;
        }
      }
      c.fov = SPACE_FOV;
    }

    // Lens shift for the interface, eased.
    const ki = c.reduced ? 1 : 1 - Math.exp(-dt / 0.16);
    const first = c.dx === 0 && c.dy === 0 && c.opacity === 0;
    const nextDx = first ? fit.dx : c.dx + (fit.dx - c.dx) * ki;
    const nextDy = first ? fit.dy : c.dy + (fit.dy - c.dy) * ki;
    if (Math.abs(nextDx - c.dx) > 0.05 || Math.abs(nextDy - c.dy) > 0.05) moving = true;
    c.dx = nextDx;
    c.dy = nextDy;

    if (c.cam === "sphere") {
      applyRig(camera, rig, width, height, c.dx + rig.panX, c.dy + rig.panY);
      if (c.anchor && !c.tween) {
        const hit = pickGlobe(camera, c.anchor.x, c.anchor.y, width, height, this.tmp2);
        if (hit) {
          rotateRig(rig, hit, c.anchor.point);
          applyRig(camera, rig, width, height, c.dx + rig.panX, c.dy + rig.panY);
        }
      }
    } else {
      applySpace(camera, rig, c.spaceTarget, c.spaceDist, c.fov, width, height, c.dx, c.dy);
    }

    // ---------------------------------------------------------------- fades and uniforms
    const fade = (cur: number, to: number, tau: number) => {
      if (Math.abs(to - cur) < 1e-3) return to;
      moving = true;
      return c.reduced ? to : cur + (to - cur) * (1 - Math.exp(-dt / tau));
    };
    c.opacity = fade(c.opacity, 1, 0.35);
    c.mapMix = fade(c.mapMix, c.mapReady ? 1 : 0, 0.45);
    c.mono = fade(c.mono, c.wantMono && c.monoReady ? 1 : 0, 0.3);
    c.imagery = fade(c.imagery, c.layers.spherex ? c.imageryTarget : 0, 0.18);
    c.grid = fade(c.grid, c.layers.grid ? 1 : 0, 0.18);
    c.stars = fade(c.stars, c.fields.length ? 1 : 0, 0.3);
    const lineLevel = c.layers.constellations && c.linesReady ? 0.22 + 0.12 * (1 - c.imagery) : 0;
    c.lines = fade(c.lines, lineLevel, 0.25);

    const m = c.morph;
    const sphereGain = 1 - smoothstep(0, 0.45, m);
    const scale = pixelsPerRadian(rig.alt, height);
    const u = this.material.uniforms;
    u.uOpacity.value = c.opacity * sphereGain;
    u.uMapMix.value = c.mapMix;
    u.uMono.value = c.mono;
    u.uImagery.value = c.imagery;
    u.uGrid.value = c.grid;
    u.uGridMinor.value = smoothstep(900, 1600, scale);
    u.uLightDir.value.copy(KEY_LIGHT_VIEW).applyQuaternion(camera.quaternion);

    // Stars: the faintest shown depends on the scale of the view; at first they come in from the
    // brightest down.
    const entrance = c.reduced ? 1 : clamp((now - c.entranceStart) / 2600, 0, 1);
    if (entrance < 1) moving = true;
    const entranceLimit = -1.5 + 15 * easeOutExpo(entrance);
    c.magLimit = Math.min(entranceLimit, clamp(7.7 + 1.5 * Math.log2(scale / 600), 6.6, 12.5));
    c.magLimitSpace = Math.min(entranceLimit, clamp(7.4 + 2.2 * Math.log2(SPACE_HOME_DIST / c.spaceDist), 7.2, 14));
    const sizeGain = clamp(Math.pow(scale / 600, 0.3), 0.9, 2.1);
    const back = 0.085 * (1 - c.imagery);
    for (let fi = 0; fi < c.fields.length; fi++) {
      const f = c.fields[fi];
      const mat = this.materialFor(fi);
      const ff = fade(this.fieldFade.get(f) ?? 0, 1, 0.6);
      this.fieldFade.set(f, ff);
      const su = mat.uniforms;
      su.uMagLimit.value = c.magLimit;
      su.uMagLimitSpace.value = c.magLimitSpace;
      su.uPixelRatio.value = state.viewport.dpr;
      su.uOpacity.value = c.stars * c.opacity;
      su.uMorph.value = m;
      su.uSizeGain.value = sizeGain * (1 - m) + m;
      su.uBack.value = back;
      su.uRefDist.value = SPACE_HOME_DIST * 0.62;
      su.uFade.value = ff;
    }
    if (rig.alt < 0.9 && !c.wantSharp && c.layers.spherex) {
      c.wantSharp = true;
      this.sharpLoader();
    }
    this.lineMaterial.uniforms.uOpacity.value = c.lines * c.opacity * sphereGain;
    const spaceGain = smoothstep(0.55, 1, m);
    this.ringMaterial.uniforms.uOpacity.value = 0.34 * spaceGain;

    // Path from the Sun to the selected star (3D space).
    const selPos = c.sel ? fieldPosition(c.fields[c.sel.f], c.sel.i, m, this.tmp2) : null;
    if (selPos && spaceGain > 0.01) {
      const arr = this.pathGeometry.getAttribute("position") as THREE.BufferAttribute;
      arr.setXYZ(0, 0, 0, 0);
      arr.setXYZ(1, selPos.x, selPos.y, selPos.z);
      arr.needsUpdate = true;
      this.pathMaterial.opacity = 0.55 * spaceGain;
    } else {
      this.pathMaterial.opacity = 0;
    }

    // ---------------------------------------------------------------- DOM overlay
    const cam = camera.position;
    const camDist = cam.length();
    const horizon = 1 / Math.max(camDist, 1.0001);
    const viewMatrix = camera.matrixWorldInverse;
    const project = (local: THREE.Vector3, onSphere: boolean) => {
      let facing = 1;
      if (onSphere && m < 0.5) facing = (tmp.copy(local).dot(cam) / camDist - horizon) / (1 - horizon);
      tmp.copy(local).applyMatrix4(viewMatrix);
      if (tmp.z > -camera.near) return null;
      tmp.applyMatrix4(camera.projectionMatrix);
      const x = (tmp.x * 0.5 + 0.5) * width;
      const y = (-tmp.y * 0.5 + 0.5) * height;
      if (x < -80 || x > width + 80 || y < -40 || y > height + 40) return null;
      return { x, y, facing };
    };
    const place = (el: HTMLElement | null | undefined, local: THREE.Vector3, gain = 1, onSphere = true) => {
      if (!el) return null;
      const p = project(local, onSphere);
      const opacity = p ? smoothstep(0.015, 0.16, p.facing) * gain : 0;
      if (!p || opacity < 0.02) {
        if (el.style.visibility !== "hidden") el.style.visibility = "hidden";
        return null;
      }
      this.lastX = p.x;
      el.style.transform = `translate3d(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px, 0)`;
      el.style.opacity = opacity.toFixed(3);
      if (el.style.visibility !== "visible") el.style.visibility = "visible";
      return p;
    };

    const markerEls = overlay.markers.current;
    const markerGain = c.layers.markers ? c.opacity : 0;
    for (const mk of this.markerVectors) {
      const e = morphOf(m, mk.delay);
      tmp.copy(mk.v).lerp(mk.space, e);
      const pos = this.tmp2.copy(tmp);
      place(markerEls?.[mk.slug], pos, markerGain, m < 0.5);
    }
    if (this.spotVector) place(overlay.spot.current, this.spotVector, sphereGain);

    // Hover and selection rings.
    const hov = c.hover ?? c.railHover;
    let hovP: { x: number; y: number } | null = null;
    let selP: { x: number; y: number } | null = null;
    if (hov && c.fields[hov.f]) {
      const p = fieldPosition(c.fields[hov.f], hov.i, m, new THREE.Vector3());
      hovP = place(overlay.hover.current, p, 1, m < 0.5);
    } else if (overlay.hover.current && overlay.hover.current.style.visibility !== "hidden") {
      overlay.hover.current.style.visibility = "hidden";
    }
    if (c.sel && c.fields[c.sel.f]) {
      const p = fieldPosition(c.fields[c.sel.f], c.sel.i, m, new THREE.Vector3());
      selP = place(overlay.sel.current, p, 1, m < 0.5);
    } else if (overlay.sel.current && overlay.sel.current.style.visibility !== "hidden") {
      overlay.sel.current.style.visibility = "hidden";
    }

    // 3D guides: the Sun, ring labels and the names of well-known stars.
    place(overlay.sun.current, tmp.set(0, 0, 0), spaceGain, false);
    const ringEls = overlay.rings.current;
    // Ring labels sit on the side of each ring nearest the viewer.
    const labelRa = wrap360(rig.ra + 18);
    RING_LY.forEach((ly, k) => {
      place(ringEls?.[k], ringPoint(ly, labelRa, this.tmp2), spaceGain * 0.95, false);
    });
    if (overlay.legend.current) overlay.legend.current.style.opacity = spaceGain.toFixed(3);
    const spaceLabels = overlay.spaceLabels.current;
    if (spaceLabels?.length) {
      const nearGain = 1 - smoothstep(2.6, 4.2, c.spaceDist);
      for (const l of spaceLabels) {
        const f = c.fields[l.ref.f];
        if (!f) continue;
        const p = fieldPosition(f, l.ref.i, m, this.tmp2);
        const tooClose = c.sel?.id === l.ref.id || (c.hover ?? c.railHover)?.id === l.ref.id;
        const gain = tooClose ? 0 : spaceGain * (l.near ? nearGain : 1 - 0.6 * nearGain);
        if (gain < 0.02) {
          if (l.el && l.el.style.visibility !== "hidden") l.el.style.visibility = "hidden";
          continue;
        }
        place(l.el, p, gain, false);
      }
    }

    // Constellation and star names (sphere only).
    const labels = overlay.labels.current;
    if (labels?.length) {
      const nameLimit = clamp(0.6 + 1.3 * Math.log2(scale / 480), -2, 3.05);
      const showNames = c.layers.names ? c.opacity * sphereGain : 0;
      const showConst = c.layers.constellations ? c.opacity * sphereGain : 0;
      for (const l of labels) {
        let gain: number;
        if (l.kind === "constellation") {
          const need = l.level === 1 ? 330 : l.level === 2 ? 760 : 1500;
          gain = showConst * smoothstep(need, need * 1.3, scale) * (1 - smoothstep(9000, 16000, scale));
        } else {
          gain = showNames * (1 - smoothstep(nameLimit - 0.45, nameLimit, l.level)) * 0.9;
        }
        if (gain < 0.02) {
          if (l.shown && l.el) {
            l.el.style.visibility = "hidden";
            l.shown = false;
          }
          continue;
        }
        const lp = place(l.el, l.v, gain);
        l.shown = true;
        if (l.el && l.el.style.visibility === "visible") {
          const x = this.lastX;
          // Names never sit under the interface, nor on top of the hovered or selected star's label.
          const near = (q: { x: number; y: number } | null) =>
            !!q && !!lp && l.kind === "star" && Math.abs(q.x - lp.x) < 40 && Math.abs(q.y - lp.y) < 16;
          if (x < c.insets.left - 12 || x > width - c.insets.right + 12 || near(selP) || near(hovP)) {
            l.el.style.visibility = "hidden";
            l.shown = false;
          }
        }
      }
    }

    const ring = overlay.focus.current;
    if (ring) {
      const alpha = Math.asin(Math.min(1, 1 / Math.max(camDist, 1.0001)));
      const r = (height / 2) * (Math.tan(alpha) / Math.tan((camera.fov / 2) * DEG));
      tmp.set(0, 0, 0).project(camera);
      const cx = (tmp.x * 0.5 + 0.5) * width;
      const cy = (-tmp.y * 0.5 + 0.5) * height;
      const d = (r + 7) * 2;
      const whole = c.cam === "sphere" && m < 0.01 && tiltFor(rig.alt) < 1e-3 && r < Math.max(width, height);
      ring.style.width = ring.style.height = `${d.toFixed(1)}px`;
      ring.style.transform = `translate3d(${(cx - d / 2).toFixed(1)}px, ${(cy - d / 2).toFixed(1)}px, 0)`;
      ring.style.display = whole ? "block" : "none";
    }

    if (c.dirty) {
      c.dirty = false;
      moving = true;
    }
    if (moving || this.lastCentre === 0) this.centreStale = true;
    if (onCentreChange && this.centreStale) {
      if (now - this.lastCentre > 120) {
        this.lastCentre = now;
        this.centreStale = false;
        const centre = centreOfView(c, camera);
        onCentreChange(centre.ra, centre.dec, c.cam === "sphere" ? rig.alt : c.spaceDist);
      } else if (!moving && !this.trailing) {
        this.trailing = setTimeout(() => {
          this.trailing = null;
          c.invalidate();
        }, 130);
      }
    }

    if (moving) state.invalidate();
  }

  /** Inertia after a fling, then the slow drift when nobody touches anything. */
  private coast(c: Ctl, dt: number, now: number, speed: number, far: boolean): boolean {
    let moving = false;
    const rig = c.rig;
    if (Math.abs(c.vRa) + Math.abs(c.vDec) > 0.02) {
      rig.ra = wrap360(rig.ra + c.vRa * dt);
      rig.dec = clamp(rig.dec + c.vDec * dt, -DEC_LIMIT, DEC_LIMIT);
      const k = Math.exp(-dt / INERTIA_TAU);
      c.vRa *= k;
      c.vDec *= k;
      moving = true;
    } else {
      c.vRa = c.vDec = 0;
    }
    const wantAuto =
      c.allowAuto && !c.reduced && !c.hoverMarker && !c.highlighted && !c.hover && far && now - c.lastInteraction > IDLE_MS;
    c.auto += ((wantAuto ? speed : 0) - c.auto) * (1 - Math.exp(-dt / 0.8));
    if (Math.abs(c.auto) > 1e-3) {
      rig.ra = wrap360(rig.ra + c.auto * dt);
      moving = true;
    } else {
      c.auto = 0;
    }
    return moving || wantAuto;
  }
}

/** Sky position at the middle of the free area, or below the camera when that is empty space. */
function centreOfView(c: Ctl, camera: THREE.Camera) {
  if (c.cam === "space") return { ra: wrap360(c.rig.ra + 180), dec: -c.rig.dec };
  const hit = pickGlobe(
    camera,
    c.width / 2 + c.dx + c.rig.panX,
    c.height / 2 + c.dy + c.rig.panY,
    c.width,
    c.height,
  );
  return hit ? pointToRadec(hit) : { ra: c.rig.ra, dec: c.rig.dec };
}

// ----------------------------------------------------------------------------------------------
// Picking

const _pm = new THREE.Matrix4();
const _pv = new THREE.Vector3();

function screenOf(camera: THREE.Camera, x: number, y: number, z: number, w: number, h: number) {
  _pv.set(x, y, z).project(camera);
  if (_pv.z > 1 || _pv.z < -1) return null;
  return { x: (_pv.x * 0.5 + 0.5) * w, y: (-_pv.y * 0.5 + 0.5) * h };
}

/** The star under a canvas pixel, if any: nearest on screen, with brighter stars favoured. */
function pickStar(c: Ctl, x: number, y: number): StarRef | null {
  const camera = c.camera;
  if (!camera || !c.width || !c.fields.length) return null;
  const R = c.coarse ? 24 : 14;
  let best: StarRef | null = null;
  let bestScore = Infinity;
  // Each star can be picked within a radius that grows with its brightness, so bright stars are
  // easy targets and the dark gaps between faint ones still reach the empty sky.
  const base = c.coarse ? 9 : 4.5;
  const consider = (f: number, i: number, sx: number, sy: number, mag: number, limit: number) => {
    const d = Math.hypot(sx - x, sy - y);
    if (d > R) return;
    const reach = clamp(base + 1.8 * (limit - mag), base, R);
    if (d > reach) return;
    const score = d / reach;
    if (score < bestScore) {
      bestScore = score;
      best = { f, i, id: c.fields[f].tier.offset + i };
    }
  };
  if (c.morph < 0.01 && c.cam === "sphere") {
    const hit = pickGlobe(camera, x, y, c.width, c.height);
    if (!hit) return null;
    const rd = pointToRadec(hit);
    const scale = pixelsPerRadian(c.rig.alt, c.height);
    const radius = clamp(((R * 2.4) / scale) / DEG, 0.05, 25);
    const limit = c.magLimit + 0.15;
    const cam = camera.position;
    const camDist = cam.length();
    c.fields.forEach((f, fi) => {
      queryTier(f.tier, rd.ra, rd.dec, radius, (i) => {
        const mag = f.mag[i];
        if (mag > limit) return;
        const px = f.tier.xyz[3 * i];
        const py = f.tier.xyz[3 * i + 1];
        const pz = f.tier.xyz[3 * i + 2];
        if ((px * cam.x + py * cam.y + pz * cam.z) / camDist < 1 / camDist) return; // far side
        const s = screenOf(camera, px, py, pz, c.width, c.height);
        if (s) consider(fi, i, s.x, s.y, mag, limit);
      });
    });
    return best;
  }
  if (c.morph > 0.99) {
    const e = _pm.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).elements;
    const W = c.width;
    const H = c.height;
    const limit = c.magLimitSpace + 0.15;
    c.fields.forEach((f, fi) => {
      const s = f.space;
      const mag = f.mag;
      const n = f.tier.count;
      for (let i = 0; i < n; i++) {
        if (mag[i] > limit) continue;
        const px = s[3 * i];
        const py = s[3 * i + 1];
        const pz = s[3 * i + 2];
        const w = e[3] * px + e[7] * py + e[11] * pz + e[15];
        if (w <= 0.001) continue;
        const sx = ((e[0] * px + e[4] * py + e[8] * pz + e[12]) / w) * 0.5 * W + 0.5 * W;
        if (sx < x - R || sx > x + R) continue;
        const sy = 0.5 * H - ((e[1] * px + e[5] * py + e[9] * pz + e[13]) / w) * 0.5 * H;
        if (sy < y - R || sy > y + R) continue;
        consider(fi, i, sx, sy, mag[i], limit);
      }
    });
    return best;
  }
  return null;
}

function refFor(fields: TierField[], id: number | null | undefined): StarRef | null {
  if (id === null || id === undefined) return null;
  for (let f = 0; f < fields.length; f++) {
    const t = fields[f].tier;
    if (id >= t.offset && id < t.offset + t.count) return { f, i: id - t.offset, id };
  }
  return null;
}

// ----------------------------------------------------------------------------------------------
// Scene

interface SceneProps {
  ctlRef: React.RefObject<Ctl>;
  runtime: GlobeRuntime;
  fields: TierField[];
  markers: GlobeMarker[];
  overlay: OverlayRefs;
  spot: { ra: number; dec: number } | null;
  textureUrl: string;
  sharpAllowed: boolean;
  wantMap: boolean;
  view: GlobeView;
  onTextureReady?: () => void;
  onCentreChange?: (ra: number, dec: number, alt: number) => void;
}

function GlobeScene({
  ctlRef,
  runtime,
  fields,
  markers,
  overlay,
  spot,
  textureUrl,
  sharpAllowed,
  wantMap,
  view,
  onTextureReady,
  onCentreChange,
}: SceneProps) {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const gl = useThree((s) => s.gl);
  const invalidate = useThree((s) => s.invalidate);
  const [lines, setLines] = useState<THREE.BufferGeometry | null>(null);
  const callbacks = useRef({ onTextureReady });
  useEffect(() => {
    callbacks.current = { onTextureReady };
  }, [onTextureReady]);

  useEffect(() => {
    const c = ctlRef.current;
    c.camera = camera;
    c.invalidate = invalidate;
    invalidate();
  }, [ctlRef, camera, invalidate]);

  useEffect(() => {
    invalidate();
  }, [spot, fields, invalidate]);

  useEffect(() => () => lines?.dispose(), [lines]);

  // The SPHEREx map, fetched the first time its layer is switched on.
  useEffect(() => {
    if (!wantMap) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    if (ctlRef.current.mapReady) return;
    const loader = new THREE.TextureLoader();
    const tryLoad = () => {
      const url = attempt === 0 ? textureUrl : `${textureUrl}?t=${Date.now()}`;
      loader.load(
        url,
        (texture) => {
          if (cancelled) {
            texture.dispose();
            return;
          }
          runtime.setTexture(ctlRef.current, texture, gl.capabilities.getMaxAnisotropy(), "map");
          callbacks.current.onTextureReady?.();
        },
        undefined,
        () => {
          if (cancelled) return;
          attempt += 1;
          timer = setTimeout(tryLoad, Math.min(60_000, 5_000 * 2 ** Math.min(attempt - 1, 4)));
        },
      );
    };
    tryLoad();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [wantMap, textureUrl, gl, runtime, ctlRef]);

  // The 8k map, on desktops with the GPU for it, the first time the camera comes close.
  useEffect(() => {
    if (!sharpAllowed || gl.capabilities.maxTextureSize < 8192) return;
    const state = { cancelled: false, started: false };
    const loadSharp = () => {
      if (state.started) return;
      state.started = true;
      const onTexture = (texture: THREE.Texture) => {
        if (state.cancelled) {
          texture.dispose();
          return;
        }
        const apply = () => {
          if (state.cancelled) return;
          if (!ctlRef.current.mapReady) {
            setTimeout(apply, 500);
            return;
          }
          runtime.setTexture(ctlRef.current, texture, gl.capabilities.getMaxAnisotropy(), "map");
        };
        apply();
      };
      if (typeof createImageBitmap === "function") {
        new THREE.ImageBitmapLoader()
          .setOptions({ imageOrientation: "flipY", premultiplyAlpha: "none" })
          .load(
            SKY_TEXTURE_8K,
            (bitmap) => {
              const texture = new THREE.Texture(bitmap as unknown as HTMLImageElement);
              texture.flipY = false;
              onTexture(texture);
            },
            undefined,
            () => {},
          );
      } else {
        new THREE.TextureLoader().load(SKY_TEXTURE_8K, onTexture, undefined, () => {});
      }
    };
    runtime.onNeedSharp(loadSharp);
    if (ctlRef.current.wantSharp) loadSharp();
    return () => {
      state.cancelled = true;
      runtime.onNeedSharp(() => {});
    };
  }, [sharpAllowed, gl, runtime, ctlRef]);

  const wantMono = view === "mono" && wantMap;
  useEffect(() => {
    if (!wantMono || ctlRef.current.monoReady) return;
    let cancelled = false;
    new THREE.TextureLoader().load(SKY_TEXTURE_MONO, (texture) => {
      if (cancelled) {
        texture.dispose();
        return;
      }
      runtime.setTexture(ctlRef.current, texture, gl.capabilities.getMaxAnisotropy(), "mono");
    });
    return () => {
      cancelled = true;
    };
  }, [wantMono, runtime, ctlRef, gl]);

  useEffect(() => {
    let cancelled = false;
    loadSkyLines()
      .then((data) => {
        if (cancelled) return;
        setLines(buildConstellationGeometry(data.constellations));
        ctlRef.current.linesReady = true;
        ctlRef.current.invalidate();
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [ctlRef]);

  useFrame((state, delta) => {
    runtime.step(ctlRef.current, state, delta, camera, markers, spot, overlay, onCentreChange);
  });

  return (
    <>
      <mesh geometry={runtime.geometry} material={runtime.material} renderOrder={0} />
      {lines && (
        <lineSegments geometry={lines} material={runtime.lineMaterial} renderOrder={1} frustumCulled={false} />
      )}
      <lineSegments geometry={runtime.ringGeometry} material={runtime.ringMaterial} renderOrder={1} frustumCulled={false} />
      <primitive object={runtime.path} />
      {fields.map((f, i) => (
        <points
          key={`${f.tier.name}:${f.tier.offset}:${f.tier.count}`}
          geometry={f.geometry}
          material={runtime.materialFor(i)}
          renderOrder={2}
          frustumCulled={false}
        />
      ))}
    </>
  );
}

class GlobeErrorBoundary extends Component<{ onError: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    this.props.onError();
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

// ----------------------------------------------------------------------------------------------
// The component

const fieldCache = new WeakMap<StarTier, TierField>();

export default function SkyGlobe({
  catalogue,
  markers,
  selection,
  hovered,
  railStar,
  onHoverChange,
  onSelectTarget,
  onSelectStar,
  onSelectSpot,
  mode,
  layers,
  view,
  imagery,
  insets,
  reducedMotion,
  onTextureReady,
  onCentreChange,
  onUnavailable,
  handleRef,
}: SkyGlobeProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const markerEls = useRef<Record<string, HTMLDivElement | null>>({});
  const spotEl = useRef<HTMLDivElement>(null);
  const focusEl = useRef<HTMLDivElement>(null);
  const hoverEl = useRef<HTMLDivElement>(null);
  const selEl = useRef<HTMLDivElement>(null);
  const sunEl = useRef<HTMLDivElement>(null);
  const ringEls = useRef<(HTMLDivElement | null)[]>([]);
  const legendEl = useRef<HTMLDivElement>(null);
  const labelEntries = useRef<LabelEntry[]>([]);
  const spaceLabelEntries = useRef<SpaceLabelEntry[]>([]);
  const [arrived, setArrived] = useState<string | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [skyLines, setSkyLines] = useState<SkyLines | null>(null);
  const [hoverId, setHoverId] = useState<number | null>(null);
  const [settledMode, setSettledMode] = useState<SkyMode | "moving">("sphere");
  const [runtime] = useState(() => new GlobeRuntime());
  useEffect(() => () => runtime.dispose(), [runtime]);

  const handleTextureReady = useCallback(() => {
    setMapReady(true);
    onTextureReady?.();
  }, [onTextureReady]);
  const handleCentre = useCallback(
    (ra: number, dec: number, alt: number) => {
      containerRef.current?.setAttribute("data-altitude", alt.toFixed(3));
      onCentreChange?.(ra, dec);
    },
    [onCentreChange],
  );
  const [{ textureUrl, sharpAllowed, coarse }] = useState(() => {
    if (typeof window === "undefined") return { textureUrl: SKY_TEXTURE_4K, sharpAllowed: false, coarse: false };
    const small = Math.min(window.innerWidth, window.innerHeight) < 700;
    const isCoarse = window.matchMedia("(pointer: coarse)").matches;
    return {
      textureUrl: small ? SKY_TEXTURE_2K : SKY_TEXTURE_4K,
      sharpAllowed: !small && !isCoarse && window.innerWidth >= 1024,
      coarse: isCoarse,
    };
  });

  // Star fields for the loaded tiers (built once per tier).
  const fields = useMemo(() => {
    if (!catalogue) return [];
    const out: TierField[] = [];
    for (const tier of catalogue.tiers) {
      if (!tier) continue;
      let f = fieldCache.get(tier);
      if (!f) {
        f = buildTierField(tier);
        fieldCache.set(tier, f);
      }
      out.push(f);
    }
    return out;
  }, [catalogue]);
  const prevFields = useRef<TierField[]>([]);
  useEffect(() => {
    const gone = prevFields.current.filter((f) => !fields.includes(f));
    gone.forEach((f) => f.geometry.dispose());
    prevFields.current = fields;
  }, [fields]);

  const ctl = useRef<Ctl>({
    rig: { ra: HOME.ra - (reducedMotion ? 0 : 42), dec: HOME.dec, alt: 3, panX: 0, panY: 0 },
    altTarget: 3,
    followHome: true,
    homeAlt: 3,
    focusAlt: 1.5,
    starAlt: 0.8,
    altMax: ALT_MAX,
    vRa: 0,
    vDec: 0,
    panTargetX: 0,
    panTargetY: 0,
    auto: 0,
    tween: null,
    anchor: null,
    dragging: false,
    hoverMarker: false,
    highlighted: hovered !== null,
    lastInteraction: 0,
    entrance: true,
    entranceStart: 0,
    pending: [],
    dirty: false,
    dx: 0,
    dy: 0,
    width: 0,
    height: 0,
    opacity: reducedMotion ? 1 : 0,
    mapMix: 0,
    mapReady: false,
    wantMono: view === "mono",
    monoReady: false,
    mono: 0,
    imagery: 0,
    imageryTarget: imagery,
    grid: layers.grid ? 1 : 0,
    stars: 0,
    lines: 0,
    layers,
    linesReady: false,
    wantSharp: false,
    allowAuto: selection === null,
    reduced: reducedMotion,
    coarse,
    insets,
    camera: null,
    invalidate: () => {},
    cam: "sphere",
    morph: 0,
    morphAnim: null,
    spaceTarget: new THREE.Vector3(),
    spaceDist: SPACE_HOME_DIST,
    spaceDistTarget: SPACE_HOME_DIST,
    spaceTween: null,
    fov: 30,
    fields: [],
    magLimit: 6,
    magLimitSpace: 9,
    hover: null,
    railHover: null,
    sel: null,
  });

  // Development aid: the controller on window, for inspecting the view from the console and tests.
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    (window as unknown as { __pxhSky?: Ctl }).__pxhSky = ctl.current;
  }, []);

  useEffect(() => {
    const c = ctl.current;
    c.insets = insets;
    c.layers = layers;
    c.reduced = reducedMotion;
    c.allowAuto = selection === null;
    c.highlighted = hovered !== null || railStar !== null;
    c.wantMono = view === "mono";
    c.imageryTarget = imagery;
    c.fields = fields;
    c.railHover = refFor(fields, railStar);
    c.invalidate();
  }, [insets, layers, reducedMotion, selection, hovered, railStar, view, imagery, fields]);

  // Labels for the sphere (constellations, bright star names).
  useEffect(() => {
    let cancelled = false;
    loadSkyLines()
      .then((data) => {
        if (!cancelled) setSkyLines(data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  const labels = useMemo(() => {
    if (!skyLines) return [];
    return [
      ...skyLines.constellations
        .filter((cst) => cst.label)
        .map((cst, i) => ({
          key: `c:${cst.id}:${i}`,
          text: cst.name,
          kind: "constellation" as const,
          level: cst.rank,
          v: vec3(cst.label![0], cst.label![1]),
        })),
      ...skyLines.named.map((s, i) => ({
        key: `s:${s.name}:${i}`,
        text: s.name,
        kind: "star" as const,
        level: s.mag,
        v: vec3(s.ra, s.dec).multiplyScalar(1.0016),
      })),
    ];
  }, [skyLines]);
  const labelEls = useRef<Record<string, HTMLDivElement | null>>({});
  useEffect(() => {
    labelEntries.current = labels.map((l) => ({
      key: l.key,
      el: labelEls.current[l.key] ?? null,
      v: l.v,
      kind: l.kind,
      level: l.level,
      shown: false,
    }));
    ctl.current.invalidate();
  }, [labels]);

  // Labels for 3D space: well-known stars found by HIP number.
  const spaceLabels = useMemo(() => {
    if (!catalogue || catalogue.source !== "hipparcos") return [];
    const out: { key: string; name: string; ref: StarRef; near: boolean; ly: number | null }[] = [];
    for (const s of SPACE_LABELS) {
      const id = catalogue.byHip.get(s.hip);
      const ref = refFor(fields, id);
      if (!ref) continue;
      const star = getStar(catalogue, id);
      const pc = distancePc(star?.plx ?? null);
      out.push({ key: `h:${s.hip}`, name: s.name, ref, near: s.near, ly: pc ? pc * LY_PER_PC : null });
    }
    return out;
  }, [catalogue, fields]);
  const spaceLabelEls = useRef<Record<string, HTMLDivElement | null>>({});
  useEffect(() => {
    spaceLabelEntries.current = spaceLabels.map((l) => ({
      key: l.key,
      el: spaceLabelEls.current[l.key] ?? null,
      ref: l.ref,
      near: l.near,
    }));
    ctl.current.invalidate();
  }, [spaceLabels]);

  /** Fly the sphere camera to a sky position. */
  const flyTo = useCallback(
    (ra: number, dec: number, opts?: { alt?: number; pan?: boolean; onDone?: () => void }) => {
      const c = ctl.current;
      const from: Rig = { ...c.rig };
      const toAlt = clamp(opts?.alt ?? c.altTarget, ALT_MIN, c.altMax);
      const to: Rig = {
        ra,
        dec: clamp(dec, -DEC_LIMIT, DEC_LIMIT),
        alt: toAlt,
        panX: opts?.pan === false ? c.rig.panX : 0,
        panY: opts?.pan === false ? c.rig.panY : 0,
      };
      const { angle } = slerpRadec(from.ra, from.dec, to.ra, to.dec, 0);
      c.vRa = c.vDec = 0;
      c.auto = 0;
      c.anchor = null;
      if (c.reduced) {
        Object.assign(c.rig, to);
        c.altTarget = to.alt;
        c.panTargetX = to.panX;
        c.panTargetY = to.panY;
        c.tween = null;
        opts?.onDone?.();
      } else {
        const zoomChange = Math.abs(Math.log(to.alt / from.alt));
        c.tween = {
          from,
          to,
          start: performance.now(),
          dur: clamp(700 + angle * 520 + zoomChange * 280, 700, 2300),
          arc: Math.min(0.9, angle * 0.45) * (to.alt < 1.2 ? 1 : 0.5),
          ease: easeInOutCubic,
          onDone: opts?.onDone,
        };
      }
      c.lastInteraction = performance.now();
      c.invalidate();
    },
    [],
  );

  /** Fly the 3D camera to a point in space. */
  const flySpace = useCallback((target: THREE.Vector3, dist: number, onDone?: () => void) => {
    const c = ctl.current;
    c.vRa = c.vDec = 0;
    c.auto = 0;
    const hop = c.spaceTarget.distanceTo(target);
    c.spaceTween = {
      fromT: c.spaceTarget.clone(),
      toT: target.clone(),
      fromD: c.spaceDist,
      toD: clamp(dist, SPACE_MIN_DIST, SPACE_MAX_DIST),
      start: performance.now(),
      dur: clamp(900 + hop * 520, 900, 2400),
      onDone,
    };
    c.lastInteraction = performance.now();
    c.invalidate();
  }, []);

  // ------------------------------------------------------------------ mode: sphere <-> 3D space
  const modeRef = useRef<SkyMode>("sphere");
  const selectionRef = useRef(selection);
  useEffect(() => {
    selectionRef.current = selection;
  }, [selection]);
  const flyToSelectionInSpace = useRef<() => void>(() => {});

  useEffect(() => {
    const c = ctl.current;
    if (modeRef.current === mode) return;
    modeRef.current = mode;
    const run = () => {
      c.tween = null;
      c.spaceTween = null;
      c.vRa = c.vDec = 0;
      c.auto = 0;
      c.anchor = null;
      const now = performance.now();
      const dur = c.reduced ? 0 : MORPH_MS;
      if (mode === "space") {
        const startD = c.cam === "sphere" ? 1 + c.rig.alt : c.spaceDist;
        c.cam = "space";
        c.morphAnim = {
          from: c.morph,
          to: 1,
          start: now,
          dur,
          fromT: c.spaceTarget.set(0, 0, 0).clone(),
          toT: new THREE.Vector3(),
          fromD: startD,
          toD: SPACE_HOME_DIST,
          fromFov: c.fov,
          toFov: SPACE_FOV,
          fromRa: c.rig.ra,
          toRa: c.rig.ra + 32,
          fromDec: c.rig.dec,
          // Rise above the plane of the rings, so they open into ellipses.
          toDec: 26,
          onDone: () => {
            setSettledMode("space");
            flyToSelectionInSpace.current();
          },
        };
      } else {
        c.morphAnim = {
          from: c.morph,
          to: 0,
          start: now,
          dur,
          fromT: c.spaceTarget.clone(),
          toT: new THREE.Vector3(),
          fromD: c.spaceDist,
          toD: 1 + c.homeAlt,
          fromFov: c.fov,
          toFov: fovFor(c.homeAlt),
          fromRa: c.rig.ra,
          toRa: c.rig.ra,
          fromDec: c.rig.dec,
          toDec: clamp(c.rig.dec, -DEC_LIMIT, DEC_LIMIT),
          onDone: () => {
            c.followHome = true;
            setSettledMode("sphere");
          },
        };
      }
      setSettledMode("moving");
      c.lastInteraction = now;
      c.invalidate();
    };
    if (c.width === 0) {
      c.pending.push(run);
      c.invalidate();
    } else {
      run();
    }
  }, [mode]);

  // ------------------------------------------------------------------ selection
  const selectionKey =
    selection === null
      ? ""
      : selection.kind === "target"
        ? `t:${selection.slug}`
        : selection.kind === "star"
          ? `s:${selection.id}`
          : `p:${selection.ra.toFixed(4)},${selection.dec.toFixed(4)}`;
  const selStarRef = selection?.kind === "star" ? refFor(fields, selection.id) : null;
  const selStarReady = selStarRef !== null;

  useEffect(() => {
    ctl.current.sel = selection?.kind === "star" ? refFor(fields, selection.id) : null;
    ctl.current.invalidate();
  }, [selection, fields]);

  useEffect(() => {
    if (!selection || selection.kind === "spot") return;
    const key = selectionKey;
    const c = ctl.current;
    let ra: number;
    let dec: number;
    let space: THREE.Vector3;
    if (selection.kind === "target") {
      const mk = markers.find((x) => x.slug === selection.slug);
      if (!mk) return;
      ra = mk.ra;
      dec = mk.dec;
      space = vec3(ra, dec).multiplyScalar(mk.distancePc ? spaceRadius(mk.distancePc) : SPACE_SHELL);
    } else {
      const ref = refFor(fields, selection.id);
      if (!ref) return;
      const f = fields[ref.f];
      ra = f.tier.data[ref.i * 8];
      dec = f.tier.data[ref.i * 8 + 1];
      space = new THREE.Vector3(f.space[3 * ref.i], f.space[3 * ref.i + 1], f.space[3 * ref.i + 2]);
    }
    const goSpace = () => {
      const cc = ctl.current;
      const d = Math.min(cc.spaceDist, SPACE_STAR_DIST * (selection.kind === "target" ? 1.6 : 1));
      flySpace(space, d, () => setArrived(key));
    };
    flyToSelectionInSpace.current = () => {
      if (selectionRef.current && selectionKeyOf(selectionRef.current) === key) goSpace();
    };
    const go = () => {
      if (c.cam === "space" || c.morphAnim) {
        if (!c.morphAnim) goSpace();
        return;
      }
      c.followHome = false;
      const current = c.tween ? c.tween.to.alt : c.altTarget;
      const want = selection.kind === "target" ? c.focusAlt : c.starAlt;
      const alt = current > want ? want : Math.max(current, 0.3);
      flyTo(ra, dec, { alt, onDone: () => setArrived(key) });
    };
    if (c.width === 0) {
      c.pending.push(go);
      c.invalidate();
    } else {
      go();
    }
    // selectionKey captures the selection's identity; selStarReady re-runs it once the star's tier loads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionKey, selStarReady, markers, flyTo, flySpace]);

  const resetView = useCallback(() => {
    const c = ctl.current;
    if (c.cam === "space") {
      flySpace(new THREE.Vector3(), SPACE_HOME_DIST);
      return;
    }
    c.followHome = true;
    flyTo(HOME.ra, HOME.dec, { alt: c.homeAlt });
  }, [flyTo, flySpace]);

  const zoomBy = useCallback((factor: number) => {
    const c = ctl.current;
    if (c.cam === "space") {
      c.spaceDistTarget = clamp(c.spaceDistTarget / factor, SPACE_MIN_DIST, SPACE_MAX_DIST);
    } else {
      c.followHome = false;
      c.anchor = null;
      c.altTarget = clamp(c.altTarget / factor, ALT_MIN, c.altMax);
    }
    c.lastInteraction = performance.now();
    c.invalidate();
  }, []);

  useImperativeHandle(
    handleRef,
    () => ({ zoomBy, resetView, focus: () => containerRef.current?.focus() }),
    [zoomBy, resetView],
  );

  // ------------------------------------------------------------------ pointer input
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef({
    startX: 0,
    startY: 0,
    startT: 0,
    moved: 0,
    marker: null as string | null,
    lastT: 0,
    pinchDist: 0,
    pinchAlt: 1,
    multi: false,
    pan: false,
    grab: null as THREE.Vector3 | null,
    lastTapT: 0,
    lastTapX: 0,
    lastTapY: 0,
  });
  const hoverFrame = useRef<number | null>(null);
  const hoverAt = useRef<{ x: number; y: number } | null>(null);

  const local = useCallback((clientX: number, clientY: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    return { x: clientX - (rect?.left ?? 0), y: clientY - (rect?.top ?? 0) };
  }, []);

  const pick = useCallback((x: number, y: number) => {
    const c = ctl.current;
    if (!c.camera || !c.width || c.cam !== "sphere") return null;
    return pickGlobe(c.camera, x, y, c.width, c.height);
  }, []);

  const setHover = useCallback((ref: StarRef | null) => {
    const c = ctl.current;
    const prev = c.hover?.id ?? null;
    c.hover = ref;
    if ((ref?.id ?? null) !== prev) {
      setHoverId(ref?.id ?? null);
      c.invalidate();
    }
  }, []);

  const scheduleHover = (x: number, y: number) => {
    hoverAt.current = { x, y };
    if (hoverFrame.current !== null) return;
    hoverFrame.current = requestAnimationFrame(() => {
      hoverFrame.current = null;
      const c = ctl.current;
      const at = hoverAt.current;
      if (!at || c.dragging || c.morphAnim || c.tween || c.spaceTween) return;
      setHover(pickStar(c, at.x, at.y));
    });
  };
  useEffect(
    () => () => {
      if (hoverFrame.current !== null) cancelAnimationFrame(hoverFrame.current);
    },
    [],
  );

  const interrupt = () => {
    const c = ctl.current;
    if (c.tween) {
      const done = c.tween.onDone;
      c.tween = null;
      c.altTarget = c.rig.alt;
      done?.();
    }
    if (c.spaceTween) {
      const done = c.spaceTween.onDone;
      c.spaceTween = null;
      c.spaceDistTarget = c.spaceDist;
      done?.();
    }
    c.vRa = c.vDec = 0;
    c.auto = 0;
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0 && e.button !== 2) return;
    const c = ctl.current;
    if (c.morphAnim) return;
    const g = gesture.current;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    c.lastInteraction = performance.now();
    if (pointers.current.size === 1) {
      g.startX = e.clientX;
      g.startY = e.clientY;
      g.startT = e.timeStamp || performance.now();
      g.lastT = g.startT;
      g.moved = 0;
      g.multi = false;
      g.pan = e.button === 2 || e.shiftKey;
      g.marker = (e.target as HTMLElement).closest<HTMLElement>("[data-marker]")?.dataset.marker ?? null;
      const p = local(e.clientX, e.clientY);
      g.grab = g.pan || c.cam !== "sphere" ? null : pick(p.x, p.y);
      c.dragging = true;
      c.anchor = null;
      interrupt();
    } else if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      g.pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      g.pinchAlt = c.cam === "sphere" ? c.rig.alt : c.spaceDist;
      g.multi = true;
      if (c.cam === "sphere") {
        const mid = local((a.x + b.x) / 2, (a.y + b.y) / 2);
        const hit = pick(mid.x, mid.y);
        c.anchor = hit ? { x: mid.x, y: mid.y, point: hit.clone(), pinch: true } : null;
        c.followHome = false;
      }
    }
    c.invalidate();
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) {
      if (e.pointerType !== "touch") {
        const p = local(e.clientX, e.clientY);
        scheduleHover(p.x, p.y);
      }
      return;
    }
    const c = ctl.current;
    const g = gesture.current;
    const dx = e.clientX - prev.x;
    const dy = e.clientY - prev.y;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const now = e.timeStamp || performance.now();
    if (pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (g.pinchDist > 0) {
        if (c.cam === "sphere") c.altTarget = clamp(g.pinchAlt * (g.pinchDist / dist), ALT_MIN, c.altMax);
        else c.spaceDistTarget = c.spaceDist = clamp(g.pinchAlt * (g.pinchDist / dist), SPACE_MIN_DIST, SPACE_MAX_DIST);
      }
      if (c.anchor) {
        const mid = local((a.x + b.x) / 2, (a.y + b.y) / 2);
        c.anchor.x = mid.x;
        c.anchor.y = mid.y;
      }
      g.moved += 100;
    } else if (c.dragging) {
      const before = g.moved;
      g.moved += Math.abs(dx) + Math.abs(dy);
      if (before < 6 && g.moved >= 6 && !e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.setPointerCapture(e.pointerId);
        setHover(null);
      }
      if (g.moved >= 3) {
        const rig = c.rig;
        if (c.cam === "space") {
          if (g.pan && c.camera) {
            const k = (2 * c.spaceDist * Math.tan((c.fov / 2) * DEG)) / c.height;
            const right = new THREE.Vector3().setFromMatrixColumn(c.camera.matrixWorld, 0);
            const up = new THREE.Vector3().setFromMatrixColumn(c.camera.matrixWorld, 1);
            c.spaceTarget.addScaledVector(right, -dx * k).addScaledVector(up, dy * k);
          } else {
            const ra0 = rig.ra;
            const dec0 = rig.dec;
            const k = 0.24;
            rig.ra = wrap360(rig.ra - dx * k);
            rig.dec = clamp(rig.dec + dy * k, -DEC_LIMIT, DEC_LIMIT);
            const dtMove = Math.max(1, now - g.lastT) / 1000;
            c.vRa = c.vRa * 0.6 + (wrap180(rig.ra - ra0) / dtMove) * 0.4;
            c.vDec = c.vDec * 0.6 + ((rig.dec - dec0) / dtMove) * 0.4;
          }
        } else if (g.pan) {
          const lim = 0.25 * Math.min(c.width, c.height);
          c.panTargetX = rig.panX = clamp(rig.panX + dx, -lim, lim);
          c.panTargetY = rig.panY = clamp(rig.panY + dy, -lim, lim);
        } else {
          const ra0 = rig.ra;
          const dec0 = rig.dec;
          const p = local(e.clientX, e.clientY);
          const hit = g.grab && c.camera ? pick(p.x, p.y) : null;
          if (g.grab && hit) {
            rotateRig(rig, hit, g.grab);
          } else {
            const k = (rig.alt * Math.tan((fovFor(rig.alt) / 2) * DEG)) / (c.height / 2) / DEG;
            rig.ra = wrap360(rig.ra - (dx * k) / Math.max(Math.cos(rig.dec * DEG), 0.2));
            rig.dec = clamp(rig.dec + dy * k, -DEC_LIMIT, DEC_LIMIT);
            g.grab = null;
          }
          const dtMove = Math.max(1, now - g.lastT) / 1000;
          c.vRa = c.vRa * 0.6 + (wrap180(rig.ra - ra0) / dtMove) * 0.4;
          c.vDec = c.vDec * 0.6 + ((rig.dec - dec0) / dtMove) * 0.4;
        }
      }
    }
    g.lastT = now;
    c.lastInteraction = performance.now();
    c.dirty = true;
    c.invalidate();
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.delete(e.pointerId);
    const c = ctl.current;
    const g = gesture.current;
    const now = e.timeStamp || performance.now();
    c.lastInteraction = performance.now();
    if (pointers.current.size > 0) {
      g.grab = null;
      return;
    }
    c.dragging = false;
    if (c.anchor?.pinch) c.anchor = null;
    const isTap = !g.multi && g.moved < 6 && now - g.startT < 700 && e.type === "pointerup" && !g.pan;
    if (isTap) {
      c.vRa = c.vDec = 0;
      const at = e.timeStamp || now;
      const doubleTap = at - g.lastTapT < 360 && Math.hypot(e.clientX - g.lastTapX, e.clientY - g.lastTapY) < 24;
      g.lastTapT = doubleTap ? 0 : at;
      g.lastTapX = e.clientX;
      g.lastTapY = e.clientY;
      const p = local(e.clientX, e.clientY);
      if (g.marker) {
        onSelectTarget(g.marker);
      } else if (doubleTap) {
        if (c.cam === "space") {
          c.spaceDistTarget = clamp(c.spaceDist * 0.45, SPACE_MIN_DIST, SPACE_MAX_DIST);
        } else {
          const hit = pick(p.x, p.y);
          if (hit) {
            const rd = pointToRadec(hit);
            c.followHome = false;
            flyTo(rd.ra, rd.dec, { alt: Math.max(ALT_MIN, c.rig.alt * 0.38) });
          }
        }
      } else {
        const star = pickStar(c, p.x, p.y);
        if (star) {
          onSelectStar(star.id);
        } else if (c.cam === "sphere") {
          const hit = pick(p.x, p.y);
          if (hit) {
            const rd = pointToRadec(hit);
            const key = `p:${rd.ra.toFixed(4)},${rd.dec.toFixed(4)}`;
            if (c.rig.alt > 0.8) flyTo(rd.ra, rd.dec, { onDone: () => setArrived(key) });
            else setArrived(key);
            onSelectSpot(rd.ra, rd.dec);
          }
        }
      }
    } else if (now - g.lastT > 90 || c.reduced || g.pan) {
      c.vRa = c.vDec = 0;
    } else {
      const cap = 160;
      c.vRa = clamp(c.vRa, -cap, cap);
      c.vDec = clamp(c.vDec, -cap, cap);
    }
    c.invalidate();
  };

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const c = ctl.current;
      if (c.morphAnim) return;
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      const delta = clamp(e.deltaY * unit, -240, 240);
      if (c.tween) {
        const done = c.tween.onDone;
        c.tween = null;
        c.altTarget = c.rig.alt;
        done?.();
      }
      if (c.spaceTween) {
        const done = c.spaceTween.onDone;
        c.spaceTween = null;
        c.spaceDistTarget = c.spaceDist;
        done?.();
      }
      if (c.cam === "space") {
        c.spaceDistTarget = clamp(c.spaceDistTarget * Math.exp(delta * 0.0024), SPACE_MIN_DIST, SPACE_MAX_DIST);
      } else {
        c.followHome = false;
        c.altTarget = clamp(c.altTarget * Math.exp(delta * 0.0022), ALT_MIN, c.altMax);
        const rect = el.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const hit = c.camera && c.width ? pickGlobe(c.camera, x, y, c.width, c.height) : null;
        c.anchor = hit ? { x, y, point: hit.clone(), pinch: false } : null;
      }
      c.vRa = c.vDec = 0;
      c.lastInteraction = performance.now();
      c.invalidate();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    const c = ctl.current;
    if (c.morphAnim) return;
    const space = c.cam === "space";
    const step = space ? (e.shiftKey ? 4 : 12) : (e.shiftKey ? 5 : 15) * clamp(c.rig.alt / c.homeAlt, 0.02, 1);
    const nudge = (dRa: number, dDec: number) => {
      if (space) {
        c.rig.ra = wrap360(c.rig.ra + dRa);
        c.rig.dec = clamp(c.rig.dec + dDec, -DEC_LIMIT, DEC_LIMIT);
        c.dirty = true;
        c.invalidate();
        return;
      }
      const base = c.tween ? c.tween.to : c.rig;
      const cos = Math.max(Math.cos(base.dec * DEG), 0.2);
      flyTo(wrap360(base.ra + dRa / cos), base.dec + dDec, { pan: false, alt: c.tween ? c.tween.to.alt : undefined });
    };
    switch (e.key) {
      case "ArrowLeft":
        nudge(-step, 0);
        break;
      case "ArrowRight":
        nudge(step, 0);
        break;
      case "ArrowUp":
        nudge(0, step);
        break;
      case "ArrowDown":
        nudge(0, -step);
        break;
      case "+":
      case "=":
        zoomBy(1.35);
        break;
      case "-":
      case "_":
        zoomBy(1 / 1.35);
        break;
      case "Home":
        resetView();
        break;
      case "Enter":
      case " ": {
        if (!c.camera || space) break;
        const centre = centreOfView(c, c.camera);
        onSelectSpot(centre.ra, centre.dec);
        setArrived(`p:${centre.ra.toFixed(4)},${centre.dec.toFixed(4)}`);
        break;
      }
      default:
        return;
    }
    e.preventDefault();
    c.lastInteraction = performance.now();
  };

  const selectedSlug = selection?.kind === "target" ? selection.slug : null;
  const spotRa = selection?.kind === "spot" ? selection.ra : null;
  const spotDec = selection?.kind === "spot" ? selection.dec : null;
  const spot = useMemo(
    () => (spotRa !== null && spotDec !== null ? { ra: spotRa, dec: spotDec } : null),
    [spotRa, spotDec],
  );
  const spotKey = spot ? `p:${spot.ra.toFixed(4)},${spot.dec.toFixed(4)}` : "";
  const overlay = useMemo<OverlayRefs>(
    () => ({
      markers: markerEls,
      spot: spotEl,
      focus: focusEl,
      labels: labelEntries,
      hover: hoverEl,
      sel: selEl,
      sun: sunEl,
      rings: ringEls,
      legend: legendEl,
      spaceLabels: spaceLabelEntries,
    }),
    [],
  );

  const shownHover = hoverId ?? railStar;
  const hoverStar = shownHover !== null ? getStar(catalogue, shownHover) : null;
  const selStar = selection?.kind === "star" ? getStar(catalogue, selection.id) : null;
  const inSpace = settledMode === "space";
  const hoverDist = hoverStar ? distancePc(hoverStar.plx) : null;

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      role="application"
      aria-roledescription="globe"
      aria-label={
        mode === "space"
          ? "The catalogue stars in 3D space around the Sun"
          : "Globe of the whole sky with the real stars as dots"
      }
      aria-describedby="sky-globe-help"
      data-testid="sky-globe"
      // Whether the globe's surface is drawn: the stars, or with the SPHEREx layer on, the map too.
      data-texture={fields.length && (!layers.spherex || mapReady) ? "ready" : "pending"}
      data-map={mapReady ? "ready" : layers.spherex ? "pending" : "off"}
      data-stars={catalogue ? `${catalogue.loadedCount}` : "0"}
      data-mode={settledMode}
      data-view={view}
      data-arrived={arrived ?? ""}
      data-hover={hoverId ?? ""}
      data-lenis-prevent
      className={cn(
        "group/globe absolute inset-0 touch-none outline-none select-none",
        hoverId !== null ? "cursor-pointer" : "cursor-grab active:cursor-grabbing",
      )}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerLeave={() => {
        if (!ctl.current.dragging) setHover(null);
      }}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={onKeyDown}
    >
      <GlobeErrorBoundary onError={onUnavailable}>
        <Canvas
          flat
          dpr={[1, 2]}
          frameloop="demand"
          gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
          camera={{ fov: 30, near: 0.1, far: 400, position: [0, 0, 7] }}
          aria-hidden
        >
          <GlobeScene
            ctlRef={ctl}
            runtime={runtime}
            fields={fields}
            markers={markers}
            overlay={overlay}
            spot={spot}
            textureUrl={textureUrl}
            sharpAllowed={sharpAllowed}
            wantMap={layers.spherex}
            view={view}
            onTextureReady={handleTextureReady}
            onCentreChange={handleCentre}
          />
        </Canvas>
      </GlobeErrorBoundary>

      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        <div
          ref={focusEl}
          data-testid="globe-outline"
          className="absolute top-0 left-0 rounded-full border border-accent opacity-0 transition-opacity duration-200 group-focus-visible/globe:opacity-100"
        />

        {labels.map((l) => (
          <div
            key={l.key}
            ref={(el) => {
              labelEls.current[l.key] = el;
              const entry = labelEntries.current.find((x) => x.key === l.key);
              if (entry) entry.el = el;
            }}
            className="absolute top-0 left-0"
            style={{ visibility: "hidden" }}
          >
            {l.kind === "constellation" ? (
              <span className="absolute -translate-x-1/2 -translate-y-1/2 text-micro whitespace-nowrap text-[#b9c2d3]/75 [text-shadow:0_0_3px_rgb(0_0_0/0.9)]">
                {l.text}
              </span>
            ) : (
              <span className="absolute top-0 left-2.5 -translate-y-1/2 text-[11px] leading-none whitespace-nowrap text-fg-dim/90 [text-shadow:0_0_3px_rgb(0_0_0/0.95)]">
                {l.text}
              </span>
            )}
          </div>
        ))}

        {/* 3D space: the Sun, the distance rings and well-known stars. */}
        <div ref={sunEl} className="absolute top-0 left-0" style={{ visibility: "hidden" }} data-testid="space-sun">
          <span className="absolute -top-[3px] -left-[3px] size-1.5 rounded-full bg-[#fff1d6]" />
          <span className="absolute top-0 left-2.5 -translate-y-1/2 text-micro font-medium whitespace-nowrap text-fg [text-shadow:0_0_3px_rgb(0_0_0/0.95)]">
            Sun
          </span>
        </div>
        {RING_LY.map((ly, k) => (
          <div
            key={ly}
            ref={(el) => {
              ringEls.current[k] = el;
            }}
            className="absolute top-0 left-0"
            style={{ visibility: "hidden" }}
          >
            <span className="absolute top-0 left-1.5 -translate-y-1/2 rounded-[3px] bg-[#030303]/70 px-1 py-0.5 text-[11px] leading-none whitespace-nowrap text-fg-dim">
              <span className="readout">{ly.toLocaleString("en-US")}</span> light-years
            </span>
          </div>
        ))}
        {spaceLabels.map((l) => (
          <div
            key={l.key}
            ref={(el) => {
              spaceLabelEls.current[l.key] = el;
              const entry = spaceLabelEntries.current.find((x) => x.key === l.key);
              if (entry) entry.el = el;
            }}
            className="absolute top-0 left-0"
            style={{ visibility: "hidden" }}
          >
            <span className="absolute top-0 left-2.5 -translate-y-1/2 text-[11px] leading-none whitespace-nowrap text-fg/85 [text-shadow:0_0_3px_rgb(0_0_0/0.95),0_0_1px_rgb(0_0_0)]">
              {l.name}
              {l.ly !== null && l.near ? (
                <span className="readout ml-1 text-fg-faint">{l.ly < 100 ? l.ly.toFixed(1) : Math.round(l.ly)} ly</span>
              ) : null}
            </span>
          </div>
        ))}

        {spot && (
          <div ref={spotEl} className="absolute top-0 left-0" style={{ visibility: "hidden" }}>
            <SpotReticle key={spotKey} drawn={arrived === spotKey} reduced={reducedMotion} />
          </div>
        )}

        {/* Hover: a fine ring and a small label. */}
        <div ref={hoverEl} className="absolute top-0 left-0" style={{ visibility: "hidden" }} data-testid="star-hover">
          {hoverStar && selStar?.id !== hoverStar.id && (
            <>
              <span className="absolute -top-[9px] -left-[9px] size-[18px] rounded-full border border-fg/70" />
              <span className="absolute top-0 left-3.5 -translate-y-1/2 rounded-[3px] bg-[#030303]/80 px-1.5 py-0.5 text-micro whitespace-nowrap text-fg">
                {starTitle(hoverStar)}
                <span className="readout ml-1.5 text-fg-faint">
                  {inSpace && hoverDist
                    ? `${formatLy(hoverDist * LY_PER_PC)} ly`
                    : `V ${hoverStar.vmag.toFixed(1).replace("-", "−")}`}
                </span>
              </span>
            </>
          )}
        </div>

        {/* Selection: an accent ring that draws itself once the camera has arrived. */}
        <div ref={selEl} className="absolute top-0 left-0" style={{ visibility: "hidden" }} data-testid="star-selection">
          {selStar && (
            <>
              <SelectionRing key={selStar.id} drawn={arrived === `s:${selStar.id}`} reduced={reducedMotion} size={30} />
              <span className="absolute top-0 left-5 -translate-y-1/2 text-micro font-medium whitespace-nowrap text-fg [text-shadow:0_0_4px_rgb(0_0_0/0.95)]">
                {starTitle(selStar)}
              </span>
            </>
          )}
        </div>

        {markers.map((mk) => {
          const selected = selectedSlug === mk.slug;
          const active = selected || hovered === mk.slug;
          return (
            <div
              key={mk.slug}
              ref={(el) => {
                markerEls.current[mk.slug] = el;
              }}
              className="absolute top-0 left-0"
              style={{ visibility: "hidden" }}
            >
              <div
                data-marker={mk.slug}
                data-testid={`globe-marker-${mk.slug}`}
                className={cn(
                  "absolute -top-3 -left-3 grid size-6 cursor-pointer place-items-center pointer-coarse:-top-5 pointer-coarse:-left-5 pointer-coarse:size-10",
                  layers.markers ? "pointer-events-auto" : "pointer-events-none",
                )}
                onPointerEnter={() => {
                  ctl.current.hoverMarker = true;
                  onHoverChange(mk.slug);
                }}
                onPointerLeave={() => {
                  ctl.current.hoverMarker = false;
                  onHoverChange(null);
                  ctl.current.invalidate();
                }}
              >
                {/* A small diamond: the challenge targets are not ordinary catalogue stars. */}
                <span
                  className={cn(
                    "block size-[8px] rotate-45 border shadow-[0_0_0_1px_rgb(0_0_0/0.6)] transition-[border-color,transform] duration-200",
                    active ? "scale-125 border-accent" : "border-accent/70",
                  )}
                />
                {selected && <SelectionRing drawn={arrived === `t:${mk.slug}`} reduced={reducedMotion} size={32} />}
              </div>
              <span
                className={cn(
                  "absolute top-0 left-3.5 -translate-y-1/2 rounded-[3px] bg-[#030303]/82 px-1.5 py-0.5 text-micro font-medium whitespace-nowrap text-fg transition-[opacity,translate] duration-200 ease-out-expo",
                  active ? "translate-x-0 opacity-100" : "-translate-x-1 opacity-0",
                )}
              >
                {mk.name}
              </span>
            </div>
          );
        })}
      </div>

      {/* Scale legend for 3D space. */}
      <div
        ref={legendEl}
        aria-hidden={!inSpace}
        className="pointer-events-none absolute z-[1] max-w-[17.5rem] rounded-md bg-ink/75 px-3 py-2.5 text-micro text-pretty text-fg-faint"
        style={{ opacity: 0, left: insets.left + 20, bottom: insets.bottom + 72 }}
        data-testid="space-legend"
      >
        <svg viewBox="0 0 120 14" className="mb-1.5 h-3.5 w-[120px] overflow-visible" aria-hidden>
          <line x1="0" x2="120" y1="7" y2="7" stroke="var(--hair-strong)" />
          {[0, 40, 80, 120].map((x, k) => (
            <g key={x}>
              <line x1={x} x2={x} y1="3" y2="11" stroke="var(--fg-faint)" />
              <text x={x} y="-1" textAnchor="middle" className="readout fill-fg-faint text-[8px]">
                {["1", "10", "100", "1k"][k]}
              </text>
            </g>
          ))}
        </svg>
        Distance from the Sun in light-years, on a log scale: each ring is ten times farther out. Distances from
        Hipparcos parallaxes; stars beyond about 3,000 light-years, or without one, stay on the faint outer shell.
      </div>
    </div>
  );
}

function selectionKeyOf(s: NonNullable<GlobeSelection>): string {
  return s.kind === "target" ? `t:${s.slug}` : s.kind === "star" ? `s:${s.id}` : `p:${s.ra.toFixed(4)},${s.dec.toFixed(4)}`;
}

function formatLy(ly: number): string {
  if (ly < 10) return ly.toFixed(2);
  if (ly < 100) return ly.toFixed(1);
  return Math.round(ly).toLocaleString("en-US");
}

/** Accent ring that draws itself round the selection once the camera has arrived. */
function SelectionRing({ drawn, reduced, size = 32 }: { drawn: boolean; reduced: boolean; size?: number }) {
  const show = drawn || reduced;
  return (
    <svg
      viewBox="-16 -16 32 32"
      className="pointer-events-none absolute overflow-visible"
      style={{ width: size, height: size, left: -size / 2, top: -size / 2 }}
    >
      <circle
        r={12.5}
        fill="none"
        stroke="var(--accent)"
        strokeWidth={1.25}
        pathLength={1}
        strokeDasharray="1 1"
        transform="rotate(-118)"
        style={{
          strokeDashoffset: show ? 0 : 1,
          transition: reduced ? "none" : "stroke-dashoffset 900ms cubic-bezier(0.65, 0, 0.35, 1)",
        }}
      />
    </svg>
  );
}

/** Finder-chart reticle for a clicked spot of sky: four ticks and a fine ring. */
function SpotReticle({ drawn, reduced }: { drawn: boolean; reduced: boolean }) {
  const show = drawn || reduced;
  return (
    <svg viewBox="-24 -24 48 48" className="absolute -top-6 -left-6 size-12 overflow-visible">
      <g
        stroke="var(--accent)"
        strokeWidth={1.25}
        strokeLinecap="round"
        style={{
          opacity: show ? 1 : 0,
          transform: show ? "scale(1)" : "scale(1.5)",
          transformOrigin: "center",
          transition: reduced ? "none" : "opacity 300ms ease-out, transform 700ms cubic-bezier(0.16, 1, 0.3, 1)",
        }}
      >
        <line x1={0} y1={-18} x2={0} y2={-10} />
        <line x1={0} y1={10} x2={0} y2={18} />
        <line x1={-18} y1={0} x2={-10} y2={0} />
        <line x1={10} y1={0} x2={18} y2={0} />
        <circle r={6} fill="none" strokeWidth={1} opacity={0.9} />
      </g>
    </svg>
  );
}
