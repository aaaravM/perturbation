// Procedural star field for the landing illustration (not real data): a seeded RNG, a power-law
// brightness distribution (many faint stars, few bright ones), gentle density variation and soft
// PSF-like sprites. Positions are normalised (0..1) so a resize keeps the same field.

export type Rgb = readonly [number, number, number];

/** mulberry32: tiny, fast, deterministic 32-bit PRNG returning [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Subtle stellar tints around off-white: neutral, warm, cool, K-type, B-type. */
export const TINTS: readonly Rgb[] = [
  [244, 243, 238],
  [255, 239, 222],
  [226, 233, 255],
  [255, 224, 198],
  [212, 225, 255],
];
const TINT_WEIGHTS = [0.46, 0.25, 0.19, 0.05, 0.05];

export interface Star {
  /** Normalised position; slightly beyond 0..1 so parallax never reveals an empty edge. */
  x: number;
  y: number;
  /** log10 of flux relative to the faintest star (0..~3.8). */
  lum: number;
  tint: number;
  /** 0 far, 1 mid, 2 near (parallax depth). */
  layer: number;
}

export interface Mover {
  x: number;
  y: number;
  lum: number;
  tint: number;
  /** Shift between plate A and plate B, in CSS px. */
  dx: number;
  dy: number;
}

export interface Field {
  stars: Star[];
  movers: Mover[];
}

export const STAR_BUDGET = 4200;
export const MOVER_LAYER = 1;

function pickTint(rng: () => number): number {
  let u = rng();
  for (let i = 0; i < TINT_WEIGHTS.length; i++) {
    u -= TINT_WEIGHTS[i];
    if (u <= 0) return i;
  }
  return 0;
}

/** Smooth 0.3..1 density: a few long sine waves plus one soft diagonal band. */
function densityField(rng: () => number): (x: number, y: number) => number {
  const waves = Array.from({ length: 6 }, () => ({
    kx: (rng() * 2 - 1) * 8,
    ky: (rng() * 2 - 1) * 8,
    phase: rng() * Math.PI * 2,
    amp: 0.4 + rng() * 0.6,
  }));
  const norm = waves.reduce((s, w) => s + w.amp, 0);
  const angle = 0.35 + rng() * 0.5;
  const offset = rng() * 0.3 - 0.15;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return (x, y) => {
    let s = 0;
    for (const w of waves) s += w.amp * Math.sin(w.kx * x + w.ky * y + w.phase);
    const n = s / norm; // -1..1
    const d = (x - 0.5) * sin - (y - 0.5) * cos - offset;
    const band = Math.exp(-(d * d) / (2 * 0.2 * 0.2));
    return 0.16 + 0.42 * (n * 0.5 + 0.5) + 0.42 * band;
  };
}

export function createField(seed: number): Field {
  const rng = mulberry32(seed);
  const density = densityField(rng);
  const stars: Star[] = [];
  let guard = 0;
  while (stars.length < STAR_BUDGET && guard++ < STAR_BUDGET * 8) {
    const x = rng() * 1.06 - 0.03;
    const y = rng() * 1.06 - 0.03;
    if (rng() > density(x, y)) continue;
    // Counts N(<m) ~ 10^(0.3 m): flux = u^(-1/(0.75 * 1.1)) relative to the faintest star.
    const u = 1 - rng();
    const lum = Math.min(3.8, -1.2 * Math.log10(u));
    const r = rng();
    const layer = lum > 2.3 || r < 0.06 ? 2 : lum > 1.1 || r < 0.32 ? 1 : 0;
    stars.push({ x, y, lum, tint: pickTint(rng), layer });
  }

  // Candidate movers: mid brightness, inside a safe area (clear of the plate label at top left),
  // spread apart so consecutive cycles happen in different parts of the plate.
  const mrng = mulberry32(seed ^ 0x9e3779b9);
  const movers: Mover[] = [];
  guard = 0;
  while (movers.length < 7 && guard++ < 500) {
    const x = 0.14 + mrng() * 0.72;
    const y = 0.2 + mrng() * 0.62;
    if (x < 0.34 && y < 0.3) continue;
    if (movers.some((m) => Math.hypot(m.x - x, m.y - y) < 0.2)) continue;
    const dist = 13 + mrng() * 4;
    const angle = mrng() * Math.PI * 2;
    movers.push({
      x,
      y,
      lum: 1.65 + mrng() * 0.45,
      tint: mrng() < 0.6 ? 0 : 1,
      dx: Math.cos(angle) * dist,
      dy: Math.sin(angle) * dist,
    });
  }
  return { stars, movers };
}

/** Number of stars to draw for a plate of this size (keeps density roughly constant). */
export function starCount(width: number, height: number): number {
  return Math.round(Math.min(STAR_BUDGET, Math.max(800, (width * height) / 118)));
}

/** Prerender a PSF sprite: Gaussian core plus a faint Moffat-like wing, tinted. */
function makeSprite(rgb: Rgb, size: number, sigmaFrac: number, wing: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  const img = ctx.createImageData(size, size);
  const c = size / 2;
  const sigma = size * sigmaFrac;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - c;
      const dy = y + 0.5 - c;
      const r2 = dx * dx + dy * dy;
      const r = Math.sqrt(r2) / c;
      let v = Math.exp(-r2 / (2 * sigma * sigma)) + wing * Math.pow(1 + r2 / (sigma * sigma * 5), -2.4);
      v *= Math.max(0, 1 - Math.pow(r, 5));
      const i = (y * size + x) * 4;
      img.data[i] = rgb[0];
      img.data[i + 1] = rgb[1];
      img.data[i + 2] = rgb[2];
      img.data[i + 3] = Math.round(Math.min(1, v) * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

export interface Sprites {
  core: HTMLCanvasElement[];
  halo: HTMLCanvasElement[];
}

export function makeSprites(): Sprites {
  return {
    core: TINTS.map((t) => makeSprite(t, 64, 0.11, 0.045)),
    halo: TINTS.map((t) => makeSprite(t, 64, 0.26, 0)),
  };
}

/** Sprite size in CSS px (the Gaussian sigma is 0.11 of it) and peak opacity for a brightness. */
export function starSize(lum: number): number {
  return 5.2 + 2.5 * Math.pow(lum, 1.35);
}
export function starAlpha(lum: number): number {
  return Math.min(1, 0.12 + 0.3 * lum);
}

/** Draw one star centred on (x, y) in CSS px. The context should use "lighter" compositing. */
export function drawStar(
  ctx: CanvasRenderingContext2D,
  sprites: Sprites,
  lum: number,
  tint: number,
  x: number,
  y: number,
): void {
  const size = starSize(lum);
  ctx.globalAlpha = starAlpha(lum);
  ctx.drawImage(sprites.core[tint], x - size / 2, y - size / 2, size, size);
  if (lum > 2.1) {
    const hs = size * 2.7;
    ctx.globalAlpha = Math.min(0.085, (lum - 2.1) * 0.05);
    ctx.drawImage(sprites.halo[tint], x - hs / 2, y - hs / 2, hs, hs);
  }
}

/** Prerender the static stars into one transparent canvas per depth layer (padded by `pad`). */
export function renderLayers(
  field: Field,
  sprites: Sprites,
  width: number,
  height: number,
  dpr: number,
  pad: number,
): HTMLCanvasElement[] {
  const layers = [0, 1, 2].map(() => {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round((width + pad * 2) * dpr));
    canvas.height = Math.max(1, Math.round((height + pad * 2) * dpr));
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.globalCompositeOperation = "lighter";
    }
    return { canvas, ctx };
  });
  const n = Math.min(field.stars.length, starCount(width, height));
  for (let i = 0; i < n; i++) {
    const s = field.stars[i];
    const ctx = layers[s.layer].ctx;
    if (ctx) drawStar(ctx, sprites, s.lum, s.tint, pad + s.x * width, pad + s.y * height);
  }
  return layers.map((l) => l.canvas);
}

/** A small tileable grain texture; each plate gets its own, like two different emulsions. */
export function makeGrain(seed: number, size = 128, strength = 9): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  const rng = mulberry32(seed);
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    const v = Math.round(rng() * strength);
    img.data[i * 4] = v;
    img.data[i * 4 + 1] = v;
    img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}
