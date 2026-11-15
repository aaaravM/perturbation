// The catalogue stars of Sky mode as one Points object per magnitude tier, with one small shader.
//
// Every star carries two positions: on the celestial sphere (radius 1, its direction on the sky)
// and in 3D space around the Sun (its distance from the Hipparcos parallax on a logarithmic
// scale, see spaceRadius). A single uniform, uMorph, moves the stars between the two, each
// starting a little later the farther away it is, so "3D space" unfolds from the nearest stars
// outwards. Stars without a usable parallax stay on a dim outer shell.
//
// Colours are the catalogue's sRGB colours (blackbody from B-V), converted to linear light here so
// the renderer's output conversion gives back exactly those colours. Size and weight follow the
// V magnitude; fainter stars fade in as the view comes closer (uMagLimit).

import * as THREE from "three";
import type { StarTier } from "@/lib/stars";
import { radecToVector } from "@/components/globe/globe-math";

/** Radial scale of 3D space: r = R0 + K log10(d / 1 pc), so 1 pc -> 0.25, 1 kpc -> 3. */
export const SPACE_R0 = 0.25;
export const SPACE_K = 0.9167;
export const SPACE_MAX_PC = 1000;
/** Radius of the shell for stars whose distance is unknown or too uncertain. */
export const SPACE_SHELL = 3.45;
/** Parallaxes below this (mas, more than 1 kpc) are too uncertain to place a star. */
export const MIN_PARALLAX_MAS = 1;
/** How much of the morph is spent staggering the start of each star. */
export const STAGGER = 0.5;

export function spaceRadius(pc: number): number {
  return SPACE_R0 + SPACE_K * Math.log10(Math.min(SPACE_MAX_PC, Math.max(1, pc)));
}

export const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/** Per-star progress of the morph, as the shader computes it. */
export function morphOf(morph: number, delay: number): number {
  const t = Math.min(1, Math.max(0, (morph - delay * STAGGER) / (1 - STAGGER)));
  return easeInOutCubic(t);
}

export interface TierField {
  tier: StarTier;
  geometry: THREE.BufferGeometry;
  /** 3D positions, count x 3. */
  space: Float32Array;
  delay: Float32Array;
  known: Uint8Array;
  mag: Float32Array;
}

export function buildTierField(tier: StarTier): TierField {
  const n = tier.count;
  const space = new Float32Array(3 * n);
  const delay = new Float32Array(n);
  const known = new Uint8Array(n);
  const mag = new Float32Array(n);
  const knownF = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 8;
    mag[i] = tier.data[o + 2];
    const plx = tier.data[o + 4];
    let r = SPACE_SHELL;
    if (Number.isFinite(plx) && plx >= MIN_PARALLAX_MAS) {
      r = spaceRadius(1000 / plx);
      known[i] = 1;
      knownF[i] = 1;
      delay[i] = Math.min(1, Math.max(0, (r - SPACE_R0) / (SPACE_SHELL - SPACE_R0)));
    } else {
      delay[i] = 1;
    }
    space[3 * i] = tier.xyz[3 * i] * r;
    space[3 * i + 1] = tier.xyz[3 * i + 1] * r;
    space[3 * i + 2] = tier.xyz[3 * i + 2] * r;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(tier.xyz, 3));
  g.setAttribute("aSpace", new THREE.BufferAttribute(space, 3));
  g.setAttribute("aMag", new THREE.BufferAttribute(mag, 1));
  g.setAttribute("aColor", new THREE.BufferAttribute(tier.rgb, 3, true));
  g.setAttribute("aDelay", new THREE.BufferAttribute(delay, 1));
  g.setAttribute("aKnown", new THREE.BufferAttribute(knownF, 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), SPACE_SHELL + 0.1);
  return { tier, geometry: g, space, delay, known, mag };
}

/** Where star i of a field is drawn for a given morph. */
export function fieldPosition(f: TierField, i: number, morph: number, out: THREE.Vector3): THREE.Vector3 {
  const e = morph <= 0 ? 0 : morphOf(morph, f.delay[i]);
  const x = f.tier.xyz;
  return out.set(
    x[3 * i] + (f.space[3 * i] - x[3 * i]) * e,
    x[3 * i + 1] + (f.space[3 * i + 1] - x[3 * i + 1]) * e,
    x[3 * i + 2] + (f.space[3 * i + 2] - x[3 * i + 2]) * e,
  );
}

const vertexShader = /* glsl */ `
  uniform float uMagLimit;
  uniform float uMagLimitSpace;
  uniform float uPixelRatio;
  uniform float uOpacity;
  uniform float uMorph;
  uniform float uSizeGain;
  uniform float uBack;
  uniform float uRefDist;
  uniform float uFade;
  attribute vec3 aSpace;
  attribute float aMag;
  attribute vec3 aColor;
  attribute float aDelay;
  attribute float aKnown;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vSize;

  float easeInOut(float t) {
    return t < 0.5 ? 4.0 * t * t * t : 1.0 - pow(-2.0 * t + 2.0, 3.0) / 2.0;
  }
  vec3 toLinear(vec3 c) {
    return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
  }

  void main() {
    float t = clamp((uMorph - aDelay * ${STAGGER.toFixed(2)}) / ${(1 - STAGGER).toFixed(2)}, 0.0, 1.0);
    float e = easeInOut(t);
    vec3 p = mix(position, aSpace, e);
    vec4 world = modelMatrix * vec4(p, 1.0);
    vec3 toCam = cameraPosition - world.xyz;
    float dist = length(toCam);

    // On the sphere the far side shows faintly through, which gives the globe its depth.
    float facing = dot(normalize(position), normalize(cameraPosition - position));
    float occl = mix(uBack, 1.0, smoothstep(-0.04, 0.1, facing));
    occl = mix(occl, 1.0, e);
    // Level of detail: stars fainter than the limit fade out over a magnitude.
    float limit = mix(uMagLimit, uMagLimitSpace, e);
    float lod = 1.0 - smoothstep(limit - 1.2, limit, aMag);
    // In space, stars without a distance stay dim on the outer shell.
    float shell = mix(1.0, mix(0.3, 1.0, aKnown), e);

    float b = clamp((7.5 - aMag) / 9.0, 0.0, 1.0);
    float diameter = (1.35 + 6.2 * pow(b, 1.4)) * uSizeGain;
    float persp = clamp(pow(uRefDist / dist, 0.75), 0.5, 3.4);
    diameter *= mix(1.0, persp, e);
    diameter = min(diameter, 15.0);
    float weight = clamp(0.5 + 0.5 * (8.5 - aMag) / 4.0, 0.3, 1.0);
    // Never draw below 2 px (it would shimmer); dim instead.
    float drawn = max(diameter, 2.0);
    float energy = min(1.0, (diameter * diameter) / (drawn * drawn) + 0.2);
    // In space, nearer stars read brighter than far ones: a depth cue as the view turns.
    float depth = mix(1.0, clamp(pow(uRefDist / dist, 0.8), 0.3, 1.25), e);
    vAlpha = uOpacity * uFade * occl * lod * shell * weight * energy * depth;
    vSize = drawn * uPixelRatio;
    vColor = toLinear(aColor);
    gl_PointSize = vSize;
    gl_Position = projectionMatrix * viewMatrix * world;
    if (vAlpha < 0.003) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;
  varying float vSize;

  void main() {
    vec2 c = gl_PointCoord * 2.0 - 1.0;
    float r = length(c);
    // A crisp disc with an antialiased edge about a pixel wide; tiny points keep their full
    // footprint (their pixel centres sit near the rim). Big stars get a slightly brighter core.
    float inner = max(0.72, 1.0 - 1.6 / max(vSize, 1.0));
    float disc = 1.0 - smoothstep(inner, 1.0, r);
    if (disc <= 0.0) discard;
    float core = vSize > 5.0 ? 1.0 - 0.3 * r * r : 1.0;
    gl_FragColor = vec4(vColor * core, vAlpha * disc);
    #include <colorspace_fragment>
  }
`;

export interface StarFieldUniforms {
  [key: string]: THREE.IUniform;
  uMagLimit: THREE.IUniform<number>;
  uMagLimitSpace: THREE.IUniform<number>;
  uPixelRatio: THREE.IUniform<number>;
  uOpacity: THREE.IUniform<number>;
  uMorph: THREE.IUniform<number>;
  uSizeGain: THREE.IUniform<number>;
  uBack: THREE.IUniform<number>;
  uRefDist: THREE.IUniform<number>;
  uFade: THREE.IUniform<number>;
}

export type StarFieldMaterial = THREE.ShaderMaterial & { uniforms: StarFieldUniforms };

export function createStarFieldMaterial(): StarFieldMaterial {
  const uniforms: StarFieldUniforms = {
    uMagLimit: { value: 6 },
    uMagLimitSpace: { value: 9 },
    uPixelRatio: { value: 1 },
    uOpacity: { value: 0 },
    uMorph: { value: 0 },
    uSizeGain: { value: 1 },
    uBack: { value: 0.1 },
    uRefDist: { value: 4 },
    uFade: { value: 1 },
  };
  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
  }) as StarFieldMaterial;
}

// ------------------------------------------------------------------------------------ 3D guides

const ringVertex = /* glsl */ `
  uniform float uOpacity;
  varying float vAlpha;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    // Nearer parts of the ring a little stronger: it reads as a circle lying in space.
    vAlpha = uOpacity * clamp(1.15 - 0.06 * length(mv.xyz), 0.35, 1.0);
    gl_Position = projectionMatrix * mv;
  }
`;
const ringFragment = /* glsl */ `
  uniform vec3 uColor;
  varying float vAlpha;
  void main() {
    gl_FragColor = vec4(uColor, vAlpha);
    #include <colorspace_fragment>
  }
`;

export type RingMaterial = THREE.ShaderMaterial & {
  uniforms: { uOpacity: THREE.IUniform<number>; uColor: THREE.IUniform<THREE.Color> };
};

export function createRingMaterial(color = "#c8c6bf"): RingMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uOpacity: { value: 0 }, uColor: { value: new THREE.Color(color) } },
    vertexShader: ringVertex,
    fragmentShader: ringFragment,
    transparent: true,
    depthWrite: false,
    depthTest: false,
  }) as RingMaterial;
}

/**
 * Distance rings (light-years) around the Sun. They lie in the plane of Earth's equator, so with
 * celestial north up they read as level ellipses.
 */
export const RING_LY = [10, 100, 1000] as const;
const LY_PER_PC = 3.261564;

/** Point on the ring of `ly` light-years at right ascension `ra` (deg). */
export function ringPoint(ly: number, ra: number, out: THREE.Vector3): THREE.Vector3 {
  const r = spaceRadius(ly / LY_PER_PC);
  const v = radecToVector(ra, 0);
  return out.set(v.x * r, v.y * r, v.z * r);
}

export function buildRings(): THREE.BufferGeometry {
  const pts: number[] = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const seg = 240;
  for (const ly of RING_LY) {
    for (let k = 0; k < seg; k++) {
      ringPoint(ly, (k / seg) * 360, a);
      ringPoint(ly, ((k + 1) / seg) * 360, b);
      pts.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pts), 3));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), SPACE_SHELL);
  return g;
}
