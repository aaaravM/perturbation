// The home page globe: the SPHEREx all-sky map on a sphere, drawn by one WebGL fragment shader on a
// full-canvas triangle. No scene graph: each pixel finds the point of the sphere under it
// (orthographic projection), turns it into RA and Dec, and reads the map there. Zooming is only a
// larger radius, so the same code shows the whole sky and a 10-arcminute patch. Drawn on demand:
// the caller decides when a frame is needed.
//
// The sphere is seen from outside but mirrored, so it reads like the sky from Earth: north up and
// east to the left, the same way round as the SPHEREx frames. scripts/make_landing_globe.py draws
// the still with the same projection and shading.

export interface GlobeView {
  /** Centre and radius of the sphere, in CSS pixels of the canvas. */
  cx: number;
  cy: number;
  r: number;
  /** Sky position at the centre of the sphere, in degrees. */
  ra: number;
  dec: number;
  /** Turn about the line of sight, in degrees (0 = north up). */
  roll?: number;
  /** Brightness, 0 to 1. */
  bright: number;
}

export interface GlobeRenderer {
  resize(width: number, height: number, dpr: number): void;
  setTexture(image: TexImageSource): void;
  readonly ready: boolean;
  readonly maxTexture: number;
  draw(view: GlobeView): void;
  destroy(): void;
}

const VERT = `
attribute vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

const FRAG = `
#extension GL_OES_standard_derivatives : enable
precision highp float;
uniform sampler2D u_tex;
uniform vec2 u_center;
uniform float u_radius;
uniform float u_height;
uniform mat3 u_basis;
uniform float u_bright;
const float TAU = 6.283185307179586;
const float PI = 3.141592653589793;
void main() {
  vec2 q = (vec2(gl_FragCoord.x, u_height - gl_FragCoord.y) - u_center) / u_radius;
  float r2 = dot(q, q);
  float rho = sqrt(r2);
  float z = sqrt(max(1.0 - r2, 0.0));
  vec3 s = u_basis * vec3(q.x, -q.y, z);
  float ra = atan(s.y, s.x);
  float dec = asin(clamp(s.z, -1.0, 1.0));
  // Two longitudes, one with its seam on the far side: use whichever is smooth here, so the
  // mipmap level does not jump at RA 0.
  float uA = fract(ra / TAU);
  float uB = fract(ra / TAU + 0.5) - 0.5;
  float u = fwidth(uA) <= fwidth(uB) + 1e-6 ? uA : uB;
  vec3 col = texture2D(u_tex, vec2(u, 0.5 - dec / PI)).rgb;
  float t = clamp(z / 0.5, 0.0, 1.0);
  col *= 0.55 + 0.45 * t * t * (3.0 - 2.0 * t);
  float k = clamp((rho - 0.86) / 0.14, 0.0, 1.0);
  col += 0.10 * k * k * (3.0 - 2.0 * k);
  float a = clamp((1.0 - rho) * u_radius, 0.0, 1.0);
  gl_FragColor = vec4(col * u_bright * a, a);
}
`;

const D2R = Math.PI / 180;

/** Columns e_right, e_up, e_z of the view, in ICRS (east to the left). */
export function viewBasis(raDeg: number, decDeg: number, rollDeg = 0): Float32Array {
  const a = raDeg * D2R;
  const d = decDeg * D2R;
  const ez = [Math.cos(d) * Math.cos(a), Math.cos(d) * Math.sin(a), Math.sin(d)];
  const eu = [-Math.sin(d) * Math.cos(a), -Math.sin(d) * Math.sin(a), Math.cos(d)];
  const er = [Math.sin(a), -Math.cos(a), 0];
  const c = Math.cos(rollDeg * D2R);
  const s = Math.sin(rollDeg * D2R);
  const r = er.map((v, i) => c * v + s * eu[i]);
  const u = eu.map((v, i) => -s * er[i] + c * v);
  return new Float32Array([...r, ...u, ...ez]);
}

/** Where a sky position falls on the drawn sphere, in CSS pixels; null on the far side. */
export function project(view: GlobeView, raDeg: number, decDeg: number): { x: number; y: number } | null {
  const b = viewBasis(view.ra, view.dec, view.roll);
  const a = raDeg * D2R;
  const d = decDeg * D2R;
  const p = [Math.cos(d) * Math.cos(a), Math.cos(d) * Math.sin(a), Math.sin(d)];
  const x = p[0] * b[0] + p[1] * b[1] + p[2] * b[2];
  const y = p[0] * b[3] + p[1] * b[4] + p[2] * b[5];
  const z = p[0] * b[6] + p[1] * b[7] + p[2] * b[8];
  if (z <= 0) return null;
  return { x: view.cx + view.r * x, y: view.cy - view.r * y };
}

// Galactic to ICRS: the transpose of the ICRS-to-galactic rotation (Hipparcos, ESA 1997).
const GAL = [
  [-0.0548755604162154, -0.873437090234885, -0.4838350155487132],
  [0.4941094278755837, -0.4448296299600112, 0.7469822444972189],
  [-0.8676661490190047, -0.1980763734312015, 0.4559837761750669],
];

/** Galactic longitude and latitude to RA and Dec, in degrees. */
export function galacticToIcrs(lDeg: number, bDeg: number): { ra: number; dec: number } {
  const l = lDeg * D2R;
  const b = bDeg * D2R;
  const g = [Math.cos(b) * Math.cos(l), Math.cos(b) * Math.sin(l), Math.sin(b)];
  const e = [0, 1, 2].map((j) => GAL[0][j] * g[0] + GAL[1][j] * g[1] + GAL[2][j] * g[2]);
  const ra = (Math.atan2(e[1], e[0]) / D2R + 360) % 360;
  return { ra, dec: Math.asin(Math.max(-1, Math.min(1, e[2]))) / D2R };
}

export function createGlobeRenderer(canvas: HTMLCanvasElement): GlobeRenderer | null {
  const gl = canvas.getContext("webgl", {
    alpha: true,
    premultipliedAlpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    powerPreference: "low-power",
  });
  if (!gl || !gl.getExtension("OES_standard_derivatives")) return null;

  const compile = (type: number, src: string) => {
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    return gl.getShaderParameter(sh, gl.COMPILE_STATUS) ? sh : null;
  };
  const vs = compile(gl.VERTEX_SHADER, VERT);
  const fs = compile(gl.FRAGMENT_SHADER, FRAG);
  if (!vs || !fs) return null;
  const prog = gl.createProgram()!;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
  gl.useProgram(prog);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, "a_pos");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  const u = {
    center: gl.getUniformLocation(prog, "u_center"),
    radius: gl.getUniformLocation(prog, "u_radius"),
    height: gl.getUniformLocation(prog, "u_height"),
    basis: gl.getUniformLocation(prog, "u_basis"),
    bright: gl.getUniformLocation(prog, "u_bright"),
  };

  const tex = gl.createTexture();
  const aniso = gl.getExtension("EXT_texture_filter_anisotropic");
  let ready = false;
  let dpr = 1;
  const maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;

  return {
    get ready() {
      return ready;
    },
    maxTexture,
    resize(width, height, ratio) {
      dpr = ratio;
      const w = Math.max(1, Math.round(width * ratio));
      const h = Math.max(1, Math.round(height * ratio));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      gl.viewport(0, 0, w, h);
    },
    setTexture(image) {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, image);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      if (aniso) gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, 4);
      ready = true;
    },
    draw(view) {
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      if (!ready || view.bright <= 0) return;
      gl.uniform2f(u.center, view.cx * dpr, view.cy * dpr);
      gl.uniform1f(u.radius, view.r * dpr);
      gl.uniform1f(u.height, canvas.height);
      gl.uniformMatrix3fv(u.basis, false, viewBasis(view.ra, view.dec, view.roll));
      gl.uniform1f(u.bright, view.bright);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    destroy() {
      gl.deleteTexture(tex);
      gl.deleteBuffer(buf);
      gl.deleteProgram(prog);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    },
  };
}
