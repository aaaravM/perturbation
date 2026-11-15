// The globe's surface shader. The SPHEREx map is light, not paint, so it is shown as recorded:
// facing the camera, the pixels are the texture's own colours. Around that, three restrained cues
// give the object its form: a gentle limb darkening, a soft key light from the upper left of the
// view (it moves with the camera, like a photographer's light), and a thin cool rim at the
// silhouette. The SPHEREx imagery can be dimmed (uImagery) down to a bare dark globe, so the
// catalogue stars drawn over it can be seen on their own.
//
// The RA/Dec graticule is drawn analytically in the fragment shader (constant ~1 px lines at any
// zoom, every 30 deg, with 10 deg lines fading in close up), so it needs no extra geometry and can
// fade in and out with one uniform.

import * as THREE from "three";

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vLocal;
  varying vec3 vNormalW;
  varying vec3 vPosW;

  void main() {
    vUv = uv;
    vLocal = position;
    vec4 world = modelMatrix * vec4(position, 1.0);
    vPosW = world.xyz;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const fragmentShader = /* glsl */ `
  uniform sampler2D uMap;
  uniform sampler2D uMapMono;
  uniform float uMapMix;
  uniform float uMono;
  uniform float uImagery;
  uniform float uGrid;
  uniform float uGridMinor;
  uniform float uOpacity;
  uniform vec3 uLightDir;
  uniform vec3 uBase;

  varying vec2 vUv;
  varying vec3 vLocal;
  varying vec3 vNormalW;
  varying vec3 vPosW;

  // Distance-to-line in pixels for lines every 'spacing' units of 'coord'; returns 0..1 coverage.
  float gridLine(float coord, float spacing, float widthPx) {
    float c = coord / spacing;
    float d = abs(fract(c + 0.5) - 0.5);
    float fw = max(fwidth(c), 1e-5);
    return 1.0 - smoothstep(0.0, widthPx, d / fw);
  }

  void main() {
    vec3 n = normalize(vNormalW);
    vec3 v = normalize(cameraPosition - vPosW);
    float ndv = clamp(dot(n, v), 0.0, 1.0);

    vec3 sky = mix(texture2D(uMap, vUv).rgb, texture2D(uMapMono, vUv).rgb, uMono);
    vec3 color = mix(uBase, sky, uMapMix * uImagery);

    // Form: limb darkening, a soft key light, a hairline rim. Facing the camera stays at 1.0.
    // (All in linear light: small additions read much brighter on screen, so the rim is tiny.)
    float limb = mix(0.38, 1.0, smoothstep(0.0, 0.7, ndv));
    float key = 0.9 + 0.1 * clamp(dot(n, uLightDir), -1.0, 1.0);
    color *= limb * key;
    float rim = pow(1.0 - ndv, 14.0);
    color += vec3(0.62, 0.66, 0.74) * rim * 0.05;

    // Graticule: meridians every 30 deg of RA, parallels every 30 deg of Dec, equator stronger;
    // close up, 10 deg lines fade in between them.
    if (uGrid > 0.001) {
      vec3 p = normalize(vLocal);
      float dec = degrees(asin(clamp(p.y, -1.0, 1.0)));
      float ra1 = degrees(atan(p.z, -p.x));
      float ra2 = degrees(atan(-p.z, p.x));
      // atan jumps at +-180 deg; use whichever branch is continuous at this pixel.
      float useA = step(fwidth(ra1), fwidth(ra2));
      float mer = mix(gridLine(ra2, 30.0, 1.0), gridLine(ra1, 30.0, 1.0), useA);
      mer *= 1.0 - smoothstep(72.0, 86.0, abs(dec));
      float par = gridLine(dec, 30.0, 1.0);
      float eq = 1.0 - smoothstep(0.0, 1.25, abs(dec) / max(fwidth(dec), 1e-5));
      float lines = max(max(mer, par) * 0.5, eq * 0.85);
      if (uGridMinor > 0.001) {
        float merMinor = mix(gridLine(ra2, 10.0, 1.0), gridLine(ra1, 10.0, 1.0), useA);
        merMinor *= 1.0 - smoothstep(80.0, 88.0, abs(dec));
        float minor = max(merMinor, gridLine(dec, 10.0, 1.0));
        lines = max(lines, minor * 0.28 * uGridMinor);
      }
      float fade = smoothstep(0.03, 0.4, ndv);
      // Lines read a little stronger on the bare sphere than over the data.
      float strength = mix(0.3, 0.13, uMapMix * uImagery);
      color = mix(color, vec3(0.86, 0.85, 0.82), lines * fade * strength * uGrid);
    }

    gl_FragColor = vec4(color, uOpacity);
    #include <colorspace_fragment>
  }
`;

/** 1x1 black texture so the sampler is always bound before the SPHEREx map arrives. */
function blankTexture(): THREE.DataTexture {
  const t = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

export interface GlobeUniforms {
  [key: string]: THREE.IUniform;
  uMap: THREE.IUniform<THREE.Texture>;
  uMapMono: THREE.IUniform<THREE.Texture>;
  uMapMix: THREE.IUniform<number>;
  uMono: THREE.IUniform<number>;
  uImagery: THREE.IUniform<number>;
  uGrid: THREE.IUniform<number>;
  uGridMinor: THREE.IUniform<number>;
  uOpacity: THREE.IUniform<number>;
  uLightDir: THREE.IUniform<THREE.Vector3>;
  uBase: THREE.IUniform<THREE.Color>;
}

/** Key light in view space: upper left, slightly in front (the camera looks down -z). */
export const KEY_LIGHT_VIEW = new THREE.Vector3(-0.55, 0.62, 0.56).normalize();

export function createGlobeMaterial(): THREE.ShaderMaterial & { uniforms: GlobeUniforms } {
  const uniforms: GlobeUniforms = {
    uMap: { value: blankTexture() },
    uMapMono: { value: blankTexture() },
    uMapMix: { value: 0 },
    uMono: { value: 0 },
    uImagery: { value: 1 },
    uGrid: { value: 0 },
    uGridMinor: { value: 0 },
    uOpacity: { value: 0 },
    uLightDir: { value: KEY_LIGHT_VIEW.clone() },
    // The bare sphere (before the map arrives, or with the imagery turned down): a deep, faintly
    // warm grey (linear).
    uBase: { value: new THREE.Color("#141413") },
  };
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader,
    fragmentShader,
    transparent: true,
  });
  return material as THREE.ShaderMaterial & { uniforms: GlobeUniforms };
}
