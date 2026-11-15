// What is drawn over and around the SPHEREx globe:
//   * catalogue stars: real stars (Hipparcos, via d3-celestial) as crisp white dots just above
//     the surface at their true RA/Dec, sized by brightness, faintly tinted by colour (B-V); the
//     fainter ones fade in as the camera comes closer;
//   * constellation figures: hairlines along great circles, just above the surface;
//   * the backdrop: a field of faint dots far out in space around the scene, so the globe reads
//     as an object in space. It is decoration, generated here, and never on the globe itself.
// One Points or LineSegments object each, with small shaders; no per-star meshes.

import * as THREE from "three";
import { radecToVector } from "@/components/globe/globe-math";

export const STARS_BRIGHT_URL = "/data/stars-6.bin";
export const STARS_FAINT_URL = "/data/stars-8.bin";
export const SKY_LINES_URL = "/data/sky-lines.json";

/** Catalogue stars sit just above the surface; constellation lines just below them. */
const STAR_RADIUS = 1.0016;
const LINE_RADIUS = 1.001;

// ---------------------------------------------------------------------------------- data

export interface StarCatalog {
  count: number;
  ra: Float32Array;
  dec: Float32Array;
  /** V magnitude x 100 */
  mag: Int16Array;
  /** B-V x 1000; -32768 = unknown */
  bv: Int16Array;
}

export interface Constellation {
  id: string;
  name: string;
  /** 1 = large and famous, 3 = small and faint */
  rank: number;
  label: [number, number] | null;
  /** Polylines as flat [ra, dec, ra, dec, ...] (deg) */
  lines: number[][];
}

export interface NamedStar {
  name: string;
  ra: number;
  dec: number;
  mag: number;
}

export interface SkyLines {
  constellations: Constellation[];
  named: NamedStar[];
}

/** Read a PXS1 star file written by scripts/build_star_catalog.mjs. */
export async function loadStars(url: string, signal?: AbortSignal): Promise<StarCatalog> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  const buf = await res.arrayBuffer();
  const view = new DataView(buf);
  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (magic !== "PXS1") throw new Error(`not a star file: ${url}`);
  const n = view.getUint32(4, true);
  if (buf.byteLength < 8 + 12 * n) throw new Error(`truncated star file: ${url}`);
  return {
    count: n,
    ra: new Float32Array(buf, 8, n),
    dec: new Float32Array(buf, 8 + 4 * n, n),
    mag: new Int16Array(buf, 8 + 8 * n, n),
    bv: new Int16Array(buf, 8 + 10 * n, n),
  };
}

let skyLines: Promise<SkyLines> | null = null;

/** Constellations and star names (one small file, fetched once per page). */
export function loadSkyLines(): Promise<SkyLines> {
  skyLines ??= fetch(SKY_LINES_URL)
    .then((res) => {
      if (!res.ok) throw new Error(`${res.status} ${SKY_LINES_URL}`);
      return res.json() as Promise<Partial<SkyLines>>;
    })
    .then((j) => ({ constellations: j.constellations ?? [], named: j.named ?? [] }));
  skyLines.catch(() => {
    skyLines = null;
  });
  return skyLines;
}

/**
 * Display colour of a star from its B-V index: B-V -> temperature (Ballesteros 2012) ->
 * approximate blackbody sRGB, normalised to its brightest channel.
 */
export function starColour(bv: number, out: THREE.Color): THREE.Color {
  const b = Math.min(2, Math.max(-0.4, bv));
  const temp = 4600 * (1 / (0.92 * b + 1.7) + 1 / (0.92 * b + 0.62));
  const t = temp / 100;
  const r = t <= 66 ? 255 : 329.698727446 * Math.pow(t - 60, -0.1332047592);
  const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * Math.pow(t - 60, -0.0755148492);
  const bl = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  const c = [r, g, bl].map((v) => Math.min(255, Math.max(0, v)));
  const m = Math.max(...c) || 1;
  return out.setRGB(c[0] / m, c[1] / m, c[2] / m, THREE.SRGBColorSpace);
}

// ---------------------------------------------------------------------------------- stars

const starVertex = /* glsl */ `
  uniform float uMagLimit;
  uniform float uPixelRatio;
  uniform float uOpacity;
  uniform float uRefDist;
  attribute float aMag;
  attribute vec3 aTint;
  varying vec3 vTint;
  varying float vAlpha;
  varying float vSize;

  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vec3 toCam = cameraPosition - world.xyz;
    float dist = length(toCam);
    float facing = dot(normalize(world.xyz), toCam / dist);
    float limb = smoothstep(0.0, 0.1, facing);
    // Level of detail: stars fainter than the limit fade out over most of a magnitude.
    float lod = 1.0 - smoothstep(uMagLimit - 0.9, uMagLimit, aMag);
    // Size and weight by brightness (CSS px), growing gently as the camera comes closer.
    float t = clamp((6.5 - aMag) / 8.0, 0.0, 1.0);
    float diameter = 1.5 + 4.8 * pow(t, 1.25);
    diameter = min(diameter * clamp(pow(uRefDist / dist, 0.38), 0.85, 2.4), 12.0);
    float weight = clamp(0.45 + 0.55 * (7.0 - aMag) / 3.0, 0.3, 1.0);
    // Never draw below 1.6 px (it would shimmer); dim instead.
    float drawn = max(diameter, 1.6);
    float energy = min(1.0, (diameter * diameter) / (drawn * drawn) + 0.25);
    vAlpha = uOpacity * limb * lod * weight * energy;
    vSize = drawn * uPixelRatio;
    vTint = aTint;
    gl_PointSize = vSize;
    gl_Position = projectionMatrix * viewMatrix * world;
    if (vAlpha < 0.004) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  }
`;

const starFragment = /* glsl */ `
  varying vec3 vTint;
  varying float vAlpha;
  varying float vSize;

  void main() {
    vec2 c = gl_PointCoord * 2.0 - 1.0;
    float r = length(c);
    // A crisp disc with a one-pixel antialiased edge.
    float edge = 2.0 / max(vSize, 1.0);
    float disc = 1.0 - smoothstep(1.0 - edge * 1.5, 1.0, r);
    if (disc <= 0.0) discard;
    gl_FragColor = vec4(vTint, vAlpha * disc);
    #include <colorspace_fragment>
  }
`;

export interface StarUniforms {
  [key: string]: THREE.IUniform;
  uMagLimit: THREE.IUniform<number>;
  uPixelRatio: THREE.IUniform<number>;
  uOpacity: THREE.IUniform<number>;
  uRefDist: THREE.IUniform<number>;
}

export function createStarMaterial(): THREE.ShaderMaterial & { uniforms: StarUniforms } {
  const uniforms: StarUniforms = {
    uMagLimit: { value: 5.5 },
    uPixelRatio: { value: 1 },
    uOpacity: { value: 0 },
    uRefDist: { value: 3.6 },
  };
  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader: starVertex,
    fragmentShader: starFragment,
    transparent: true,
    depthWrite: false,
  }) as THREE.ShaderMaterial & { uniforms: StarUniforms };
}

const WHITE = new THREE.Color(1, 1, 1);

/** Points geometry for a star catalogue: positions on the globe, magnitude and a faint tint. */
export function buildStarGeometry(cat: StarCatalog): THREE.BufferGeometry {
  const n = cat.count;
  const pos = new Float32Array(3 * n);
  const mag = new Float32Array(n);
  const tint = new Float32Array(3 * n);
  const c = new THREE.Color();
  for (let i = 0; i < n; i++) {
    const v = radecToVector(cat.ra[i], cat.dec[i]);
    pos[3 * i] = v.x * STAR_RADIUS;
    pos[3 * i + 1] = v.y * STAR_RADIUS;
    pos[3 * i + 2] = v.z * STAR_RADIUS;
    mag[i] = cat.mag[i] / 100;
    if (cat.bv[i] === -32768) c.copy(WHITE);
    else starColour(cat.bv[i] / 1000, c).lerp(WHITE, 0.62);
    tint[3 * i] = c.r;
    tint[3 * i + 1] = c.g;
    tint[3 * i + 2] = c.b;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("aMag", new THREE.BufferAttribute(mag, 1));
  g.setAttribute("aTint", new THREE.BufferAttribute(tint, 3));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), STAR_RADIUS);
  return g;
}

// ---------------------------------------------------------------------------------- lines

const lineVertex = /* glsl */ `
  uniform float uOpacity;
  varying float vAlpha;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vec3 toCam = normalize(cameraPosition - world.xyz);
    float facing = dot(normalize(world.xyz), toCam);
    vAlpha = uOpacity * smoothstep(0.0, 0.2, facing);
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const lineFragment = /* glsl */ `
  uniform vec3 uColor;
  varying float vAlpha;
  void main() {
    gl_FragColor = vec4(uColor, vAlpha);
    #include <colorspace_fragment>
  }
`;

export interface LineUniforms {
  [key: string]: THREE.IUniform;
  uOpacity: THREE.IUniform<number>;
  uColor: THREE.IUniform<THREE.Color>;
}

export function createLineMaterial(): THREE.ShaderMaterial & { uniforms: LineUniforms } {
  const uniforms: LineUniforms = {
    uOpacity: { value: 0 },
    uColor: { value: new THREE.Color("#c9d2e3") },
  };
  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader: lineVertex,
    fragmentShader: lineFragment,
    transparent: true,
    depthWrite: false,
  }) as THREE.ShaderMaterial & { uniforms: LineUniforms };
}

/** Constellation figures as line segments along great circles (about one degree per piece). */
export function buildConstellationGeometry(constellations: Constellation[]): THREE.BufferGeometry {
  const out: number[] = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const p = new THREE.Vector3();
  const q = new THREE.Vector3();
  for (const c of constellations) {
    for (const line of c.lines) {
      for (let i = 0; i + 3 < line.length; i += 2) {
        const va = radecToVector(line[i], line[i + 1]);
        const vb = radecToVector(line[i + 2], line[i + 3]);
        a.set(va.x, va.y, va.z);
        b.set(vb.x, vb.y, vb.z);
        const angle = a.angleTo(b);
        const steps = Math.max(1, Math.ceil(angle / (Math.PI / 180)));
        const s = Math.sin(angle) || 1;
        for (let k = 0; k < steps; k++) {
          for (const [t, v] of [
            [k / steps, p],
            [(k + 1) / steps, q],
          ] as const) {
            if (angle < 1e-6) v.copy(a);
            else
              v.copy(a)
                .multiplyScalar(Math.sin((1 - t) * angle) / s)
                .addScaledVector(b, Math.sin(t * angle) / s);
            v.normalize().multiplyScalar(LINE_RADIUS);
          }
          out.push(p.x, p.y, p.z, q.x, q.y, q.z);
        }
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(out), 3));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), LINE_RADIUS);
  return g;
}

// ---------------------------------------------------------------------------------- backdrop

const backdropVertex = /* glsl */ `
  uniform float uPixelRatio;
  uniform float uOpacity;
  attribute float aBright;
  varying float vAlpha;
  varying float vSize;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    float size = (1.15 + 1.5 * aBright) * uPixelRatio;
    vSize = max(size, 1.0);
    gl_PointSize = vSize;
    vAlpha = uOpacity * (0.2 + 0.62 * aBright);
  }
`;

const backdropFragment = /* glsl */ `
  varying float vAlpha;
  varying float vSize;
  void main() {
    vec2 c = gl_PointCoord * 2.0 - 1.0;
    float r = length(c);
    float disc = 1.0 - smoothstep(1.0 - 3.0 / max(vSize, 1.0), 1.0, r);
    if (disc <= 0.0) discard;
    gl_FragColor = vec4(vec3(0.86, 0.88, 0.92), vAlpha * disc);
    #include <colorspace_fragment>
  }
`;

export interface BackdropUniforms {
  [key: string]: THREE.IUniform;
  uPixelRatio: THREE.IUniform<number>;
  uOpacity: THREE.IUniform<number>;
}

/** A deterministic field of faint dots in a thick shell far out around the globe. */
export function createBackdrop(count = 14000): THREE.Points & {
  material: THREE.ShaderMaterial & { uniforms: BackdropUniforms };
} {
  let seed = 0x2f6e2b1;
  const rand = () => {
    // mulberry32: the same sky on every visit
    seed = (seed + 0x6d2b79f5) | 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pos = new Float32Array(3 * count);
  const bright = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const z = rand() * 2 - 1;
    const phi = rand() * Math.PI * 2;
    const rr = Math.sqrt(1 - z * z);
    const radius = 45 + 110 * Math.cbrt(rand());
    pos[3 * i] = rr * Math.cos(phi) * radius;
    pos[3 * i + 1] = z * radius;
    pos[3 * i + 2] = rr * Math.sin(phi) * radius;
    bright[i] = Math.pow(rand(), 3.2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("aBright", new THREE.BufferAttribute(bright, 1));
  const uniforms: BackdropUniforms = { uPixelRatio: { value: 1 }, uOpacity: { value: 0 } };
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: backdropVertex,
    fragmentShader: backdropFragment,
    transparent: true,
    depthWrite: false,
    depthTest: false,
  }) as THREE.ShaderMaterial & { uniforms: BackdropUniforms };
  const points = new THREE.Points(g, material) as THREE.Points & {
    material: THREE.ShaderMaterial & { uniforms: BackdropUniforms };
  };
  points.renderOrder = -10;
  points.frustumCulled = false;
  return points;
}
