"use client";
// The Sky-mode globe: a 3D scene with the SPHEREx all-sky map on a sphere floating in space,
// real stars as white dots on it, constellation figures and names, an optional RA/Dec grid, and
// a field of faint dots far out around it (react-three-fiber).
//
// The globe stays put with the texture's own orientation and the camera flies round it
// (camera-rig.ts): drag to orbit with inertia, scroll or pinch to zoom towards the cursor from far
// out down to skimming the surface, right-drag or Shift-drag to pan a little, double-click (or
// double-tap) to fly in, arrow keys to orbit and +/- to zoom. While nobody touches it, it drifts
// slowly in the sidereal sense (never with reduced motion, never close up or with a selection).
// Choosing an object flies to it; the camera's lens shift centres the view in the space the
// panel leaves free.
//
// Rendering runs on demand: a frame is drawn only while something moves. Markers and labels are
// DOM elements positioned from the same projection every frame (crisp at any DPR, styled with the
// design tokens); markers are pointer targets only, the accessible way in is the target list.

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
  STARS_BRIGHT_URL,
  STARS_FAINT_URL,
  buildConstellationGeometry,
  buildStarGeometry,
  createBackdrop,
  createLineMaterial,
  createStarMaterial,
  loadSkyLines,
  loadStars,
  type SkyLines,
} from "@/components/globe/sky-layers";

import {
  SKY_TEXTURE_2K,
  SKY_TEXTURE_4K,
  SKY_TEXTURE_8K,
  SKY_TEXTURE_MONO,
} from "@/components/globe/sky-assets";

export type GlobeView = "colour" | "mono";

export type GlobeSelection =
  { kind: "target"; slug: string } | { kind: "patch"; ra: number; dec: number } | null;

export interface GlobeMarker {
  slug: string;
  name: string;
  ra: number;
  dec: number;
}

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface SkyLayerToggles {
  /** Catalogue stars as white dots. */
  stars: boolean;
  /** Constellation figures and names. */
  constellations: boolean;
  /** Names of the brightest stars. */
  names: boolean;
  /** RA/Dec grid. */
  grid: boolean;
  /** The five featured objects. */
  markers: boolean;
}

export interface GlobeHandle {
  /** factor > 1 comes closer. */
  zoomBy: (factor: number) => void;
  resetView: () => void;
  focus: () => void;
}

export interface SkyGlobeProps {
  markers: GlobeMarker[];
  selection: GlobeSelection;
  hovered: string | null;
  onHoverChange: (slug: string | null) => void;
  onSelectTarget: (slug: string) => void;
  onSelectPatch: (ra: number, dec: number) => void;
  layers: SkyLayerToggles;
  /** False-colour composite, or one SPHEREx colour on its own. */
  view: GlobeView;
  /** Opacity of the SPHEREx imagery, 0..1 (0 leaves a bare dark globe with the stars). */
  imagery: number;
  /** Pixels covered by the interface on each side; the globe centres itself in the rest. */
  insets: Insets;
  reducedMotion: boolean;
  onTextureReady?: () => void;
  /** The sharper 8k map has replaced the 4k one. */
  onSharpTexture?: () => void;
  /** Centre of the view, throttled to ~8 Hz while the camera moves. */
  onCentreChange?: (ra: number, dec: number) => void;
  /** WebGL failed after all: the parent swaps in the flat map. */
  onUnavailable: () => void;
  handleRef?: Ref<GlobeHandle>;
}

const IDLE_MS = 6000;
/** Sidereal sense: the centre's RA increases. One turn in about four minutes. */
const AUTO_SPEED = 1.5; // deg/s
const INERTIA_TAU = 0.62;
/** Where the globe faces on arrival: the Milky Way's bulge, with Barnard's Star above it. */
const HOME = { ra: 276, dec: -2 };
/** Half the sky angle the free area spans when an object is chosen (deg). */
const FOCUS_HALF_SPAN = 24;

interface RigTween {
  from: Rig;
  to: Rig;
  start: number;
  dur: number;
  /** How far the path bows outwards in the middle (fly-to arc), as a factor on altitude. */
  arc: number;
  ease: (t: number) => number;
  onDone?: () => void;
}

interface Ctl {
  rig: Rig;
  altTarget: number;
  /** The zoom follows the layout until the user zooms. */
  followHome: boolean;
  homeAlt: number;
  focusAlt: number;
  altMax: number;
  vRa: number;
  vDec: number;
  panTargetX: number;
  panTargetY: number;
  auto: number;
  tween: RigTween | null;
  /** Zoom towards the cursor: keep this globe point under this canvas pixel. */
  anchor: { x: number; y: number; point: THREE.Vector3; pinch: boolean } | null;
  dragging: boolean;
  hoverMarker: boolean;
  /** Something is highlighted from the list: hold still so the label can be read. */
  highlighted: boolean;
  lastInteraction: number;
  entrance: boolean;
  /** A flight asked for before the first frame knew the layout (a deep link). */
  pending: (() => void) | null;
  /** Input changed the rig directly since the last frame. */
  dirty: boolean;
  /** Lens shift that centres the globe in the free area (px), eased. */
  dx: number;
  dy: number;
  width: number;
  height: number;
  /** Fades (0..1) */
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
  backdrop: number;
  layers: SkyLayerToggles;
  starsReady: boolean;
  linesReady: boolean;
  wantFaint: boolean;
  wantSharp: boolean;
  allowAuto: boolean;
  reduced: boolean;
  insets: Insets;
  camera: THREE.PerspectiveCamera | null;
  invalidate: () => void;
}

const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOutExpo = (t: number) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t));
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const wrap180 = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;
const wrap360 = (d: number) => ((d % 360) + 360) % 360;

/** Globe radius (px) at the home view and its centre offset from the canvas centre, for the insets. */
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

// ----------------------------------------------------------------------------------------------
// Overlay elements positioned every frame.

interface LabelEntry {
  key: string;
  el: HTMLElement | null;
  v: THREE.Vector3;
  kind: "constellation" | "star";
  /** constellation rank (1..3) or star magnitude */
  level: number;
  shown: boolean;
}

interface OverlayRefs {
  markers: React.RefObject<Record<string, HTMLDivElement | null>>;
  patch: React.RefObject<HTMLDivElement | null>;
  focus: React.RefObject<HTMLDivElement | null>;
  labels: React.RefObject<LabelEntry[]>;
}

// ----------------------------------------------------------------------------------------------
// Scene runtime: everything that runs per frame, kept out of React render (three.js objects are
// mutated imperatively here, which components must not do).

class GlobeRuntime {
  material = createGlobeMaterial();
  geometry = new THREE.SphereGeometry(1, 256, 128);
  starMaterial = createStarMaterial();
  lineMaterial = createLineMaterial();
  backdrop = createBackdrop();
  private tmp = new THREE.Vector3();
  private tmp2 = new THREE.Vector3();
  private lastCentre = 0;
  private centreStale = true;
  private trailing: ReturnType<typeof setTimeout> | null = null;
  /** Screen x of the element placed last (labels check it against the interface). */
  private lastX = 0;
  private markersSrc: GlobeMarker[] | null = null;
  private markerVectors: { slug: string; v: THREE.Vector3 }[] = [];
  private patchSrc: { ra: number; dec: number } | null = null;
  private patchVector: THREE.Vector3 | null = null;
  private faintLoader: () => void = () => {};
  private sharpLoader: () => void = () => {};

  /** What to do the first time the view needs the stars to V = 8 / the 8k map. */
  onNeedFaint(load: () => void) {
    this.faintLoader = load;
  }
  onNeedSharp(load: () => void) {
    this.sharpLoader = load;
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
    this.starMaterial.dispose();
    this.lineMaterial.dispose();
    this.backdrop.geometry.dispose();
    this.backdrop.material.dispose();
  }

  step(
    c: Ctl,
    state: { size: { width: number; height: number }; invalidate: () => void; viewport: { dpr: number } },
    delta: number,
    camera: THREE.PerspectiveCamera,
    markers: GlobeMarker[],
    patch: { ra: number; dec: number } | null,
    overlay: OverlayRefs,
    onCentreChange?: (ra: number, dec: number, alt: number) => void,
  ) {
    if (markers !== this.markersSrc) {
      this.markersSrc = markers;
      this.markerVectors = markers.map((m) => ({ slug: m.slug, v: vec3(m.ra, m.dec) }));
    }
    if (patch !== this.patchSrc) {
      this.patchSrc = patch;
      this.patchVector = patch ? vec3(patch.ra, patch.dec) : null;
    }
    const tmp = this.tmp;
    const dt = Math.min(0.05, delta);
    const now = performance.now();
    const { width, height } = state.size;
    c.width = width;
    c.height = height;
    let moving = false;
    const rig = c.rig;

    // Layout: the home view fits the globe in the space the interface leaves free.
    const fit = fitLayout(width, height, c.insets);
    c.homeAlt = clamp(altitudeForRadius(fit.radius, height), 0.8, 14);
    c.altMax = Math.max(ALT_MAX, c.homeAlt * 2.2);
    // Close enough that the free area spans about +-FOCUS_HALF_SPAN degrees of sky.
    const ppr = fit.freeHeight / 2 / (FOCUS_HALF_SPAN * DEG);
    c.focusAlt = clamp(height / 2 / (ppr * Math.tan((fovFor(2) / 2) * DEG)), 0.7, c.homeAlt);

    if (c.pending) {
      // A deep link: skip the entrance and fly straight to the object from a little further out.
      const run = c.pending;
      c.pending = null;
      c.entrance = false;
      rig.alt = c.altTarget = c.homeAlt * 1.2;
      run();
    }
    if (c.entrance) {
      c.entrance = false;
      if (c.reduced) {
        rig.alt = c.altTarget = c.homeAlt;
      } else {
        rig.alt = c.altTarget = c.homeAlt * 1.55;
        c.tween = {
          from: { ...rig },
          to: { ra: HOME.ra, dec: HOME.dec, alt: c.homeAlt, panX: 0, panY: 0 },
          start: now + 120,
          dur: 2600,
          arc: 0,
          ease: easeOutExpo,
        };
        c.lastInteraction = now - IDLE_MS + 1500;
      }
    }

    // Camera motion
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
      if (!c.dragging) {
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
          c.allowAuto &&
          !c.reduced &&
          !c.hoverMarker &&
          !c.highlighted &&
          rig.alt > c.homeAlt * 0.7 &&
          now - c.lastInteraction > IDLE_MS;
        // Ease the drift in and out over about two seconds.
        c.auto += ((wantAuto ? AUTO_SPEED : 0) - c.auto) * (1 - Math.exp(-dt / 0.7));
        if (Math.abs(c.auto) > 1e-3) {
          rig.ra = wrap360(rig.ra + c.auto * dt);
          moving = true;
        } else {
          c.auto = 0;
        }
        if (wantAuto) moving = true;
      }
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

    // Lens shift for the interface, eased.
    const ki = c.reduced ? 1 : 1 - Math.exp(-dt / 0.16);
    const first = c.dx === 0 && c.dy === 0 && c.opacity === 0;
    const nextDx = first ? fit.dx : c.dx + (fit.dx - c.dx) * ki;
    const nextDy = first ? fit.dy : c.dy + (fit.dy - c.dy) * ki;
    if (Math.abs(nextDx - c.dx) > 0.05 || Math.abs(nextDy - c.dy) > 0.05) moving = true;
    c.dx = nextDx;
    c.dy = nextDy;

    // Zoom towards the cursor: once the altitude has changed, turn so the anchored point of the
    // globe is back under the cursor.
    applyRig(camera, rig, width, height, c.dx + rig.panX, c.dy + rig.panY);
    if (c.anchor && !c.tween) {
      const hit = pickGlobe(camera, c.anchor.x, c.anchor.y, width, height, this.tmp2);
      if (hit) {
        rotateRig(rig, hit, c.anchor.point);
        applyRig(camera, rig, width, height, c.dx + rig.panX, c.dy + rig.panY);
      }
    }

    // Fades: entrance, map arrival, layers
    const fade = (cur: number, to: number, tau: number) => {
      if (Math.abs(to - cur) < 1e-3) return to;
      moving = true;
      return c.reduced ? to : cur + (to - cur) * (1 - Math.exp(-dt / tau));
    };
    c.opacity = fade(c.opacity, 1, 0.35);
    c.backdrop = fade(c.backdrop, 1, 0.8);
    c.mapMix = fade(c.mapMix, c.mapReady ? 1 : 0, 0.45);
    c.mono = fade(c.mono, c.wantMono && c.monoReady ? 1 : 0, 0.3);
    c.imagery = fade(c.imagery, c.imageryTarget, 0.12);
    c.grid = fade(c.grid, c.layers.grid ? 1 : 0, 0.18);
    c.stars = fade(c.stars, c.layers.stars && c.starsReady ? 1 : 0, 0.3);
    // Constellation figures stay faint over the map, a little clearer on the bare globe.
    const lineLevel = c.layers.constellations && c.linesReady ? 0.2 + 0.14 * (1 - c.imagery) : 0;
    c.lines = fade(c.lines, lineLevel, 0.25);

    const scale = pixelsPerRadian(rig.alt, height);
    const u = this.material.uniforms;
    u.uOpacity.value = c.opacity;
    u.uMapMix.value = c.mapMix;
    u.uMono.value = c.mono;
    u.uImagery.value = c.imagery;
    u.uGrid.value = c.grid;
    u.uGridMinor.value = smoothstep(900, 1600, scale);
    u.uLightDir.value.copy(KEY_LIGHT_VIEW).applyQuaternion(camera.quaternion);

    // Stars: the faintest shown depends on the scale of the view.
    const magLimit = clamp(5.6 + 0.68 * Math.log2(scale / 565), 4.4, 8.3);
    const su = this.starMaterial.uniforms;
    su.uMagLimit.value = magLimit;
    su.uPixelRatio.value = state.viewport.dpr;
    su.uOpacity.value = c.stars * c.opacity;
    su.uRefDist.value = 1 + c.homeAlt;
    if (magLimit > 5.9 && !c.wantFaint) {
      c.wantFaint = true;
      this.faintLoader();
    }
    if (rig.alt < 0.9 && !c.wantSharp) {
      c.wantSharp = true;
      this.sharpLoader();
    }
    this.lineMaterial.uniforms.uOpacity.value = c.lines * c.opacity;
    this.backdrop.material.uniforms.uPixelRatio.value = state.viewport.dpr;
    this.backdrop.material.uniforms.uOpacity.value = c.backdrop;

    // DOM overlay: markers, the inspected patch, labels and the keyboard focus ring.
    const cam = camera.position;
    const camDist = cam.length();
    const horizon = 1 / camDist;
    const viewMatrix = camera.matrixWorldInverse;
    const project = (local: THREE.Vector3) => {
      // facing: 0 at the horizon, 1 straight below the camera
      const facing = (tmp.copy(local).dot(cam) / camDist - horizon) / (1 - horizon);
      tmp.copy(local).applyMatrix4(viewMatrix);
      if (tmp.z > -camera.near) return null;
      tmp.applyMatrix4(camera.projectionMatrix);
      const x = (tmp.x * 0.5 + 0.5) * width;
      const y = (-tmp.y * 0.5 + 0.5) * height;
      if (x < -80 || x > width + 80 || y < -40 || y > height + 40) return null;
      return { x, y, facing };
    };
    const place = (el: HTMLElement | null | undefined, local: THREE.Vector3, gain = 1) => {
      if (!el) return;
      const p = project(local);
      const opacity = p ? smoothstep(0.015, 0.16, p.facing) * gain : 0;
      if (!p || opacity < 0.02) {
        if (el.style.visibility !== "hidden") el.style.visibility = "hidden";
        return;
      }
      this.lastX = p.x;
      el.style.transform = `translate3d(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px, 0)`;
      el.style.opacity = opacity.toFixed(3);
      if (el.style.visibility !== "visible") el.style.visibility = "visible";
    };
    const markerEls = overlay.markers.current;
    const markerGain = c.layers.markers ? 1 : 0;
    for (const m of this.markerVectors) place(markerEls?.[m.slug], m.v, markerGain * c.opacity);
    if (this.patchVector) place(overlay.patch.current, this.patchVector);

    // Labels: level of detail by the scale of the view.
    const labels = overlay.labels.current;
    if (labels?.length) {
      const nameLimit = clamp(0.6 + 1.3 * Math.log2(scale / 480), -2, 3.05);
      const showNames = c.layers.names ? c.opacity : 0;
      const showConst = c.layers.constellations ? c.opacity : 0;
      for (const l of labels) {
        let gain: number;
        if (l.kind === "constellation") {
          const need = l.level === 1 ? 330 : l.level === 2 ? 760 : 1500;
          gain = showConst * smoothstep(need, need * 1.3, scale) * (1 - smoothstep(9000, 16000, scale));
        } else {
          gain = showNames * (1 - smoothstep(nameLimit - 0.45, nameLimit, l.level));
        }
        if (gain < 0.02) {
          if (l.shown && l.el) {
            l.el.style.visibility = "hidden";
            l.shown = false;
          }
          continue;
        }
        place(l.el, l.v, gain);
        l.shown = true;
        // Names never sit under the list or the panel.
        if (l.el && l.el.style.visibility === "visible") {
          const x = this.lastX;
          if (x < c.insets.left - 12 || x > width - c.insets.right + 12) {
            l.el.style.visibility = "hidden";
            l.shown = false;
          }
        }
      }
    }

    const ring = overlay.focus.current;
    if (ring) {
      // The globe's outline on screen (only meaningful while the whole globe is in view).
      const alpha = Math.asin(Math.min(1, 1 / camDist));
      const r = (height / 2) * (Math.tan(alpha) / Math.tan((camera.fov / 2) * DEG));
      tmp.set(0, 0, 0).project(camera);
      const cx = (tmp.x * 0.5 + 0.5) * width;
      const cy = (-tmp.y * 0.5 + 0.5) * height;
      const d = (r + 7) * 2;
      const whole = tiltFor(rig.alt) < 1e-3 && r < Math.max(width, height);
      ring.style.width = ring.style.height = `${d.toFixed(1)}px`;
      ring.style.transform = `translate3d(${(cx - d / 2).toFixed(1)}px, ${(cy - d / 2).toFixed(1)}px, 0)`;
      ring.style.display = whole ? "block" : "none";
    }

    // The pointer moves the rig directly: that counts as motion for this frame.
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
        onCentreChange(centre.ra, centre.dec, rig.alt);
      } else if (!moving && !this.trailing) {
        // Report where the camera came to rest, once the throttle allows.
        this.trailing = setTimeout(() => {
          this.trailing = null;
          c.invalidate();
        }, 130);
      }
    }

    if (moving) state.invalidate();
  }
}

/** Sky position at the middle of the free area, or below the camera when that is empty space. */
function centreOfView(c: Ctl, camera: THREE.Camera) {
  const hit = pickGlobe(
    camera,
    c.width / 2 + c.dx + c.rig.panX,
    c.height / 2 + c.dy + c.rig.panY,
    c.width,
    c.height,
  );
  return hit ? pointToRadec(hit) : { ra: c.rig.ra, dec: c.rig.dec };
}

function vec3(ra: number, dec: number): THREE.Vector3 {
  const v = radecToVector(ra, dec);
  return new THREE.Vector3(v.x, v.y, v.z);
}

interface SceneProps {
  ctlRef: React.RefObject<Ctl>;
  markers: GlobeMarker[];
  overlay: OverlayRefs;
  patch: { ra: number; dec: number } | null;
  textureUrl: string;
  sharpAllowed: boolean;
  view: GlobeView;
  onTextureReady?: () => void;
  onSharpTexture?: () => void;
  onCentreChange?: (ra: number, dec: number, alt: number) => void;
}

function GlobeScene({
  ctlRef,
  markers,
  overlay,
  patch,
  textureUrl,
  sharpAllowed,
  view,
  onTextureReady,
  onSharpTexture,
  onCentreChange,
}: SceneProps) {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const gl = useThree((s) => s.gl);
  const invalidate = useThree((s) => s.invalidate);
  const [runtime] = useState(() => new GlobeRuntime());
  const [bright, setBright] = useState<THREE.BufferGeometry | null>(null);
  const [faint, setFaint] = useState<THREE.BufferGeometry | null>(null);
  const [lines, setLines] = useState<THREE.BufferGeometry | null>(null);
  const callbacks = useRef({ onTextureReady, onSharpTexture });
  useEffect(() => {
    callbacks.current = { onTextureReady, onSharpTexture };
  }, [onTextureReady, onSharpTexture]);

  useEffect(() => {
    const c = ctlRef.current;
    c.camera = camera;
    c.invalidate = invalidate;
    invalidate();
  }, [ctlRef, camera, invalidate]);

  useEffect(() => {
    invalidate();
  }, [patch, invalidate]);

  useEffect(() => () => runtime.dispose(), [runtime]);
  useEffect(() => () => bright?.dispose(), [bright]);
  useEffect(() => () => faint?.dispose(), [faint]);
  useEffect(() => () => lines?.dispose(), [lines]);

  // Catalogue stars to V = 6 straight away; to V = 8 once the camera comes close.
  useEffect(() => {
    const controller = new AbortController();
    loadStars(STARS_BRIGHT_URL, controller.signal)
      .then((cat) => {
        setBright(buildStarGeometry(cat));
        ctlRef.current.starsReady = true;
        ctlRef.current.invalidate();
      })
      .catch(() => {});
    const started = { faint: false };
    const loadFaint = () => {
      if (started.faint) return;
      started.faint = true;
      loadStars(STARS_FAINT_URL, controller.signal)
        .then((cat) => {
          setFaint(buildStarGeometry(cat));
          ctlRef.current.invalidate();
        })
        .catch(() => {});
    };
    runtime.onNeedFaint(loadFaint);
    if (ctlRef.current.wantFaint) loadFaint();
    return () => {
      controller.abort();
      runtime.onNeedFaint(() => {});
    };
  }, [runtime, ctlRef]);

  // The SPHEREx map. If it is not there yet, keep the bare sphere and look again now and then,
  // so it appears without a reload.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
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
  }, [textureUrl, gl, runtime, ctlRef]);

  // The 8k map, on desktops with the GPU for it, the first time the camera comes close. Decoded
  // off the main thread; it replaces the 4k map (same mapping) once it is ready.
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
        // Only after the 4k map: never swap a sharper map out for a softer one.
        const apply = () => {
          if (state.cancelled) return;
          if (!ctlRef.current.mapReady) {
            setTimeout(apply, 500);
            return;
          }
          runtime.setTexture(ctlRef.current, texture, gl.capabilities.getMaxAnisotropy(), "map");
          callbacks.current.onSharpTexture?.();
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

  // The single-colour map is fetched the first time it is asked for, then kept.
  const wantMono = view === "mono";
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

  // Constellation figures (the overlay uses the same file for the names).
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
    runtime.step(ctlRef.current, state, delta, camera, markers, patch, overlay, onCentreChange);
  });

  return (
    <>
      <primitive object={runtime.backdrop} />
      <mesh geometry={runtime.geometry} material={runtime.material} />
      {lines && (
        <lineSegments geometry={lines} material={runtime.lineMaterial} renderOrder={1} frustumCulled={false} />
      )}
      {bright && <points geometry={bright} material={runtime.starMaterial} renderOrder={2} frustumCulled={false} />}
      {faint && <points geometry={faint} material={runtime.starMaterial} renderOrder={2} frustumCulled={false} />}
    </>
  );
}

// ----------------------------------------------------------------------------------------------
// Error boundary: a WebGL context that cannot be created throws out of the Canvas.

class GlobeErrorBoundary extends Component<
  { onError: () => void; children: ReactNode },
  { failed: boolean }
> {
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

export default function SkyGlobe({
  markers,
  selection,
  hovered,
  onHoverChange,
  onSelectTarget,
  onSelectPatch,
  layers,
  view,
  imagery,
  insets,
  reducedMotion,
  onTextureReady,
  onSharpTexture,
  onCentreChange,
  onUnavailable,
  handleRef,
}: SkyGlobeProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const markerEls = useRef<Record<string, HTMLDivElement | null>>({});
  const patchEl = useRef<HTMLDivElement>(null);
  const focusEl = useRef<HTMLDivElement>(null);
  const labelEntries = useRef<LabelEntry[]>([]);
  const [arrived, setArrived] = useState<string | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [sharp, setSharp] = useState(false);
  const [skyLines, setSkyLines] = useState<SkyLines | null>(null);
  const handleTextureReady = useCallback(() => {
    setMapReady(true);
    onTextureReady?.();
  }, [onTextureReady]);
  const handleSharp = useCallback(() => {
    setSharp(true);
    onSharpTexture?.();
  }, [onSharpTexture]);
  // Height of the camera above the globe, in radii, published for tests and tools.
  const handleCentre = useCallback(
    (ra: number, dec: number, alt: number) => {
      containerRef.current?.setAttribute("data-altitude", alt.toFixed(3));
      onCentreChange?.(ra, dec);
    },
    [onCentreChange],
  );
  const [{ textureUrl, sharpAllowed }] = useState(() => {
    if (typeof window === "undefined") return { textureUrl: SKY_TEXTURE_4K, sharpAllowed: false };
    const small = Math.min(window.innerWidth, window.innerHeight) < 700;
    const coarse = window.matchMedia("(pointer: coarse)").matches;
    return {
      textureUrl: small ? SKY_TEXTURE_2K : SKY_TEXTURE_4K,
      sharpAllowed: !small && !coarse && window.innerWidth >= 1024,
    };
  });

  const ctl = useRef<Ctl>({
    rig: { ra: HOME.ra - (reducedMotion ? 0 : 38), dec: HOME.dec, alt: 3, panX: 0, panY: 0 },
    altTarget: 3,
    followHome: true,
    homeAlt: 3,
    focusAlt: 1.5,
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
    pending: null,
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
    imagery,
    imageryTarget: imagery,
    grid: layers.grid ? 1 : 0,
    stars: 0,
    lines: 0,
    backdrop: reducedMotion ? 1 : 0,
    layers,
    starsReady: false,
    linesReady: false,
    wantFaint: false,
    wantSharp: false,
    allowAuto: selection === null,
    reduced: reducedMotion,
    insets,
    camera: null,
    invalidate: () => {},
  });

  // Keep the controller in step with props without re-rendering the scene.
  useEffect(() => {
    const c = ctl.current;
    c.insets = insets;
    c.layers = layers;
    c.reduced = reducedMotion;
    c.allowAuto = selection === null;
    c.highlighted = hovered !== null;
    c.wantMono = view === "mono";
    c.imageryTarget = imagery;
    c.invalidate();
  }, [insets, layers, reducedMotion, selection, hovered, view, imagery]);

  // Label data for the overlay (the scene loads the same file for the figures).
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
        v: vec3(s.ra, s.dec),
      })),
    ];
  }, [skyLines]);
  // Elements arrive through ref callbacks during commit; the entries are rebuilt after it.
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

  /** Fly the camera to a sky position. */
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
          dur: clamp(650 + angle * 520 + zoomChange * 260, 650, 2200),
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

  // Selection of a featured object: fly to it and mark it once there.
  const selectionKey =
    selection === null
      ? ""
      : selection.kind === "target"
        ? `t:${selection.slug}`
        : `p:${selection.ra.toFixed(4)},${selection.dec.toFixed(4)}`;
  useEffect(() => {
    if (!selection || selection.kind !== "target") return;
    const key = selectionKey;
    const m = markers.find((x) => x.slug === selection.slug);
    if (!m) return;
    const c = ctl.current;
    const go = () => {
      c.followHome = false;
      // Come in to the object's neighbourhood; never zoom out, and never closer than the tilt.
      const current = c.tween ? c.tween.to.alt : c.altTarget;
      const alt = current > c.focusAlt ? c.focusAlt : Math.max(current, 0.62);
      flyTo(m.ra, m.dec, { alt, onDone: () => setArrived(key) });
    };
    if (c.width === 0) {
      c.pending = go;
      c.invalidate();
    } else {
      go();
    }
    // selectionKey captures the selection's identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionKey, markers, flyTo]);

  const resetView = useCallback(() => {
    const c = ctl.current;
    c.followHome = true;
    flyTo(HOME.ra, HOME.dec, { alt: c.homeAlt });
  }, [flyTo]);

  const zoomBy = useCallback((factor: number) => {
    const c = ctl.current;
    c.followHome = false;
    c.anchor = null;
    c.altTarget = clamp(c.altTarget / factor, ALT_MIN, c.altMax);
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

  /** Canvas-relative pixel position of a pointer. */
  const local = useCallback((clientX: number, clientY: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    return { x: clientX - (rect?.left ?? 0), y: clientY - (rect?.top ?? 0) };
  }, []);

  const pick = useCallback((x: number, y: number) => {
    const c = ctl.current;
    if (!c.camera || !c.width) return null;
    return pickGlobe(c.camera, x, y, c.width, c.height);
  }, []);

  const interrupt = () => {
    const c = ctl.current;
    if (c.tween) {
      // Grabbing the globe mid-flight hands control back at once.
      const done = c.tween.onDone;
      c.tween = null;
      c.altTarget = c.rig.alt;
      done?.();
    }
    c.vRa = c.vDec = 0;
    c.auto = 0;
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0 && e.button !== 2) return;
    const c = ctl.current;
    const g = gesture.current;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    c.lastInteraction = performance.now();
    if (pointers.current.size === 1) {
      g.startX = e.clientX;
      g.startY = e.clientY;
      // Event times, not handling times: a slow frame must not turn a fling into a stop.
      g.startT = e.timeStamp || performance.now();
      g.lastT = g.startT;
      g.moved = 0;
      g.multi = false;
      g.pan = e.button === 2 || e.shiftKey;
      g.marker = (e.target as HTMLElement).closest<HTMLElement>("[data-marker]")?.dataset.marker ?? null;
      const p = local(e.clientX, e.clientY);
      g.grab = g.pan ? null : pick(p.x, p.y);
      c.dragging = true;
      c.anchor = null;
      interrupt();
    } else if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      g.pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      g.pinchAlt = c.rig.alt;
      g.multi = true;
      const mid = local((a.x + b.x) / 2, (a.y + b.y) / 2);
      const hit = pick(mid.x, mid.y);
      c.anchor = hit ? { x: mid.x, y: mid.y, point: hit.clone(), pinch: true } : null;
      c.followHome = false;
    }
    c.invalidate();
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    const c = ctl.current;
    const g = gesture.current;
    const dx = e.clientX - prev.x;
    const dy = e.clientY - prev.y;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const now = e.timeStamp || performance.now();
    if (pointers.current.size >= 2) {
      // Pinch: zoom about the fingers' midpoint, and follow it as it moves.
      const [a, b] = [...pointers.current.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (g.pinchDist > 0) c.altTarget = clamp(g.pinchAlt * (g.pinchDist / dist), ALT_MIN, c.altMax);
      if (c.anchor) {
        const mid = local((a.x + b.x) / 2, (a.y + b.y) / 2);
        c.anchor.x = mid.x;
        c.anchor.y = mid.y;
      }
      g.moved += 100;
    } else if (c.dragging) {
      const before = g.moved;
      g.moved += Math.abs(dx) + Math.abs(dy);
      // Capture only once it is clearly a drag, so a click on a marker stays a plain click.
      if (before < 6 && g.moved >= 6 && !e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.setPointerCapture(e.pointerId);
      }
      if (g.moved >= 3) {
        const rig = c.rig;
        if (g.pan) {
          const lim = 0.25 * Math.min(c.width, c.height);
          c.panTargetX = rig.panX = clamp(rig.panX + dx, -lim, lim);
          c.panTargetY = rig.panY = clamp(rig.panY + dy, -lim, lim);
        } else {
          const ra0 = rig.ra;
          const dec0 = rig.dec;
          const p = local(e.clientX, e.clientY);
          const hit = g.grab && c.camera ? pick(p.x, p.y) : null;
          if (g.grab && hit) {
            // Grab: turn so the point first touched stays under the pointer.
            rotateRig(rig, hit, g.grab);
          } else {
            // Off the globe: turn at the rate that would keep the centre under the pointer.
            const k =
              (rig.alt * Math.tan((fovFor(rig.alt) / 2) * DEG)) / (c.height / 2) / DEG;
            rig.ra = wrap360(rig.ra - (dx * k) / Math.max(Math.cos(rig.dec * DEG), 0.2));
            rig.dec = clamp(rig.dec + dy * k, -DEC_LIMIT, DEC_LIMIT);
            g.grab = null;
          }
          const dtMove = Math.max(1, now - g.lastT) / 1000;
          // Smoothed angular velocity for the release (deg/s).
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
      // One finger left after a pinch: carry on as a drag from here, without a grab point.
      g.grab = null;
      return;
    }
    c.dragging = false;
    if (c.anchor?.pinch) c.anchor = null;
    const isTap = !g.multi && g.moved < 6 && now - g.startT < 700 && e.type === "pointerup" && !g.pan;
    if (isTap) {
      c.vRa = c.vDec = 0;
      // Event time, not handling time: a busy frame between the two taps must not split them.
      const at = e.timeStamp || now;
      const doubleTap =
        at - g.lastTapT < 360 && Math.hypot(e.clientX - g.lastTapX, e.clientY - g.lastTapY) < 24;
      g.lastTapT = doubleTap ? 0 : at;
      g.lastTapX = e.clientX;
      g.lastTapY = e.clientY;
      if (g.marker) {
        onSelectTarget(g.marker);
      } else {
        const p = local(e.clientX, e.clientY);
        const hit = pick(p.x, p.y);
        if (hit) {
          const rd = pointToRadec(hit);
          const key = `p:${rd.ra.toFixed(4)},${rd.dec.toFixed(4)}`;
          if (doubleTap) {
            // Fly in: centre the spot and come much closer.
            c.followHome = false;
            flyTo(rd.ra, rd.dec, { alt: Math.max(ALT_MIN, c.rig.alt * 0.38), onDone: () => setArrived(key) });
          } else if (c.rig.alt > 0.8) {
            flyTo(rd.ra, rd.dec, { onDone: () => setArrived(key) });
          } else {
            setArrived(key);
          }
          onSelectPatch(rd.ra, rd.dec);
        }
      }
    } else if (now - g.lastT > 90 || c.reduced || g.pan) {
      // Released after holding still: no fling.
      c.vRa = c.vDec = 0;
    } else {
      const cap = 160;
      c.vRa = clamp(c.vRa, -cap, cap);
      c.vDec = clamp(c.vDec, -cap, cap);
    }
    c.invalidate();
  };

  // Wheel zoom needs a non-passive listener to keep the page from scrolling.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const c = ctl.current;
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      const delta = clamp(e.deltaY * unit, -240, 240);
      if (c.tween) {
        const done = c.tween.onDone;
        c.tween = null;
        c.altTarget = c.rig.alt;
        done?.();
      }
      c.followHome = false;
      c.altTarget = clamp(c.altTarget * Math.exp(delta * 0.0022), ALT_MIN, c.altMax);
      const rect = el.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const hit = c.camera && c.width ? pickGlobe(c.camera, x, y, c.width, c.height) : null;
      c.anchor = hit ? { x, y, point: hit.clone(), pinch: false } : null;
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
    // One step turns the view by 15 deg at the home distance, less close up.
    const step = (e.shiftKey ? 5 : 15) * clamp(c.rig.alt / c.homeAlt, 0.02, 1);
    const nudge = (dRa: number, dDec: number) => {
      // Repeated presses add up: step from where the current flight is heading.
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
        if (!c.camera) break;
        const centre = centreOfView(c, c.camera);
        onSelectPatch(centre.ra, centre.dec);
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
  const patchRa = selection?.kind === "patch" ? selection.ra : null;
  const patchDec = selection?.kind === "patch" ? selection.dec : null;
  const patch = useMemo(
    () => (patchRa !== null && patchDec !== null ? { ra: patchRa, dec: patchDec } : null),
    [patchRa, patchDec],
  );
  const patchKey = patch ? `p:${patch.ra.toFixed(4)},${patch.dec.toFixed(4)}` : "";
  const overlay = useMemo<OverlayRefs>(
    () => ({ markers: markerEls, patch: patchEl, focus: focusEl, labels: labelEntries }),
    [],
  );

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      role="application"
      aria-roledescription="globe"
      aria-label="Globe of the whole sky in SPHEREx infrared light"
      aria-describedby="sky-globe-help"
      data-testid="sky-globe"
      data-texture={mapReady ? "ready" : "pending"}
      data-detail={sharp ? "8k" : textureUrl === SKY_TEXTURE_2K ? "2k" : "4k"}
      data-view={view}
      data-arrived={arrived ?? ""}
      data-lenis-prevent
      className="group/globe absolute inset-0 cursor-grab touch-none outline-none select-none active:cursor-grabbing"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
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
            markers={markers}
            overlay={overlay}
            patch={patch}
            textureUrl={textureUrl}
            sharpAllowed={sharpAllowed}
            view={view}
            onTextureReady={handleTextureReady}
            onSharpTexture={handleSharp}
            onCentreChange={handleCentre}
          />
        </Canvas>
      </GlobeErrorBoundary>

      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        {/* Keyboard focus: a hairline ring around the globe itself. */}
        <div
          ref={focusEl}
          data-testid="globe-outline"
          className="absolute top-0 left-0 rounded-full border border-accent opacity-0 transition-opacity duration-200 group-focus-visible/globe:opacity-100"
        />

        {/* Constellation and star names: quiet, below the markers. */}
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
              <span className="absolute top-0 left-2 -translate-y-1/2 text-[11px] leading-none whitespace-nowrap text-fg-dim [text-shadow:0_0_3px_rgb(0_0_0/0.95)]">
                {l.text}
              </span>
            )}
          </div>
        ))}

        {patch && (
          <div ref={patchEl} className="absolute top-0 left-0" style={{ visibility: "hidden" }}>
            <PatchReticle key={patchKey} drawn={arrived === patchKey} reduced={reducedMotion} />
          </div>
        )}

        {markers.map((m) => {
          const selected = selectedSlug === m.slug;
          const active = selected || hovered === m.slug;
          return (
            <div
              key={m.slug}
              ref={(el) => {
                markerEls.current[m.slug] = el;
              }}
              className="absolute top-0 left-0"
              style={{ visibility: "hidden" }}
            >
              <div
                data-marker={m.slug}
                data-testid={`globe-marker-${m.slug}`}
                className={cn(
                  "absolute -top-3 -left-3 grid size-6 cursor-pointer place-items-center pointer-coarse:-top-5 pointer-coarse:-left-5 pointer-coarse:size-10",
                  layers.markers ? "pointer-events-auto" : "pointer-events-none",
                )}
                onPointerEnter={() => {
                  ctl.current.hoverMarker = true;
                  onHoverChange(m.slug);
                }}
                onPointerLeave={() => {
                  ctl.current.hoverMarker = false;
                  onHoverChange(null);
                  ctl.current.invalidate();
                }}
              >
                <span
                  className={cn(
                    "block size-[9px] rounded-full border shadow-[0_0_0_1px_rgb(0_0_0/0.6)] transition-[border-color,transform] duration-200",
                    active ? "scale-110 border-accent" : "border-fg/80",
                  )}
                />
                {selected && <SelectionRing drawn={arrived === `t:${m.slug}`} reduced={reducedMotion} />}
              </div>
              <span
                className={cn(
                  "absolute top-0 left-3.5 -translate-y-1/2 rounded-[3px] bg-[#030303]/82 px-1.5 py-0.5 text-micro font-medium whitespace-nowrap text-fg transition-[opacity,translate] duration-200 ease-out-expo",
                  active ? "translate-x-0 opacity-100" : "-translate-x-1 opacity-0",
                )}
              >
                {m.name}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Accent ring that draws itself round the selected object once the camera has arrived. */
function SelectionRing({ drawn, reduced }: { drawn: boolean; reduced: boolean }) {
  const show = drawn || reduced;
  return (
    <svg
      viewBox="-16 -16 32 32"
      className="pointer-events-none absolute size-8 overflow-visible"
      style={{ left: "calc(50% - 1rem)", top: "calc(50% - 1rem)" }}
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

/** Finder-chart reticle for an inspected patch of sky: four ticks and a fine ring. */
function PatchReticle({ drawn, reduced }: { drawn: boolean; reduced: boolean }) {
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
          transition: reduced
            ? "none"
            : "opacity 300ms ease-out, transform 700ms cubic-bezier(0.16, 1, 0.3, 1)",
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
