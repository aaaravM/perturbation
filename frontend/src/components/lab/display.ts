// Display settings for the blink frames: min/max cuts on the frame's 0-255 display levels, a
// stretch and a colour map, applied on a canvas before the frame goes to Aladin. These change how
// a frame looks, never the data: the frames are already one shared stretch per detector, so the
// same setting applied to every epoch keeps brightness changes between epochs comparable.

export type Stretch = "linear" | "asinh" | "log";
export type Colormap = "grey" | "inverted" | "heat" | "viridis";

export interface DisplaySettings {
  stretch: Stretch;
  colormap: Colormap;
  /** Cuts on the 0-255 display levels of the PNG frames. */
  lo: number;
  hi: number;
}

export const DEFAULT_DISPLAY: DisplaySettings = { stretch: "linear", colormap: "grey", lo: 0, hi: 255 };

export const STRETCHES: { value: Stretch; label: string }[] = [
  { value: "linear", label: "Linear" },
  { value: "asinh", label: "Asinh" },
  { value: "log", label: "Log" },
];

export const COLORMAPS: { value: Colormap; label: string; css: string }[] = [
  { value: "grey", label: "Grey", css: "linear-gradient(90deg,#000,#fff)" },
  { value: "inverted", label: "Inverted", css: "linear-gradient(90deg,#fff,#000)" },
  { value: "heat", label: "Heat", css: "linear-gradient(90deg,#000,#7a1500,#f0885a,#ffe08a,#fff)" },
  { value: "viridis", label: "Viridis", css: "linear-gradient(90deg,#440154,#3b528b,#21918c,#5ec962,#fde725)" },
];

export function isDefaultDisplay(d: DisplaySettings): boolean {
  return d.stretch === "linear" && d.colormap === "grey" && d.lo <= 0 && d.hi >= 255;
}

export function displaySignature(d: DisplaySettings): string {
  return isDefaultDisplay(d) ? "raw" : `${d.stretch}|${d.colormap}|${d.lo}|${d.hi}`;
}

const STOPS: Record<Exclude<Colormap, "grey" | "inverted">, [number, number, number][]> = {
  heat: [
    [0, 0, 0],
    [122, 21, 0],
    [240, 136, 90],
    [255, 224, 138],
    [255, 255, 255],
  ],
  viridis: [
    [68, 1, 84],
    [59, 82, 139],
    [33, 145, 140],
    [94, 201, 98],
    [253, 231, 37],
  ],
};

function ramp(stops: [number, number, number][], t: number): [number, number, number] {
  const x = Math.min(Math.max(t, 0), 1) * (stops.length - 1);
  const i = Math.min(Math.floor(x), stops.length - 2);
  const f = x - i;
  const a = stops[i];
  const b = stops[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

function stretchFn(stretch: Stretch): (t: number) => number {
  if (stretch === "asinh") {
    const k = Math.asinh(10);
    return (t) => Math.asinh(10 * t) / k;
  }
  if (stretch === "log") {
    const k = Math.log(101);
    return (t) => Math.log(1 + 100 * t) / k;
  }
  return (t) => t;
}

/** A 256-entry lookup table per output channel. */
export function buildLut(d: DisplaySettings): { level: Uint8ClampedArray; rgb: Uint8ClampedArray } {
  const level = new Uint8ClampedArray(256);
  const rgb = new Uint8ClampedArray(256 * 3);
  const f = stretchFn(d.stretch);
  const span = Math.max(1, d.hi - d.lo);
  for (let v = 0; v < 256; v++) {
    const t = f(Math.min(Math.max((v - d.lo) / span, 0), 1));
    level[v] = Math.round(t * 255);
    let c: [number, number, number];
    if (d.colormap === "grey") c = [t * 255, t * 255, t * 255];
    else if (d.colormap === "inverted") c = [(1 - t) * 255, (1 - t) * 255, (1 - t) * 255];
    else c = ramp(STOPS[d.colormap], t);
    rgb[v * 3] = c[0];
    rgb[v * 3 + 1] = c[1];
    rgb[v * 3 + 2] = c[2];
  }
  return { level, rgb };
}

/**
 * Apply the display settings to decoded frame pixels. Grey frames get the colour map; colour
 * composites keep their colours and get the cuts and stretch per channel.
 */
export function applyDisplay(raw: ImageData, d: DisplaySettings): ImageData {
  const { level, rgb } = buildLut(d);
  const src = raw.data;
  const out = new ImageData(raw.width, raw.height);
  const dst = out.data;
  const colour = isColourImage(raw);
  for (let i = 0; i < src.length; i += 4) {
    if (colour) {
      dst[i] = level[src[i]];
      dst[i + 1] = level[src[i + 1]];
      dst[i + 2] = level[src[i + 2]];
    } else {
      const v = src[i];
      dst[i] = rgb[v * 3];
      dst[i + 1] = rgb[v * 3 + 1];
      dst[i + 2] = rgb[v * 3 + 2];
    }
    dst[i + 3] = src[i + 3];
  }
  return out;
}

/** True when the channels differ anywhere (a false-colour composite). Sampled for speed. */
export function isColourImage(raw: ImageData): boolean {
  const px = raw.data;
  const step = Math.max(4, Math.floor(px.length / 4 / 2000) * 4);
  for (let i = 0; i < px.length; i += step) {
    if (Math.abs(px[i] - px[i + 1]) > 2 || Math.abs(px[i] - px[i + 2]) > 2) return true;
  }
  return false;
}

/** 64-bin histogram of display levels (luminance), for the stretch control. */
export function histogram(raw: ImageData, bins = 64): number[] {
  const counts = new Array<number>(bins).fill(0);
  const px = raw.data;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] === 0) continue;
    const v = (px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114) | 0;
    counts[Math.min(bins - 1, Math.floor((v / 256) * bins))] += 1;
  }
  return counts;
}

/** Display level (0-255, luminance) at a pixel. */
export function levelAt(raw: ImageData, col: number, row: number): number | null {
  if (col < 0 || row < 0 || col >= raw.width || row >= raw.height) return null;
  const i = (row * raw.width + col) * 4;
  if (raw.data[i + 3] === 0) return null;
  return Math.round(raw.data[i] * 0.299 + raw.data[i + 1] * 0.587 + raw.data[i + 2] * 0.114);
}

export async function decodePng(blob: Blob): Promise<ImageData | null> {
  try {
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close?.();
    return ctx.getImageData(0, 0, canvas.width, canvas.height);
  } catch {
    return null;
  }
}

export async function encodePng(image: ImageData): Promise<Blob | null> {
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.putImageData(image, 0, 0);
  return new Promise((resolve) => canvas.toBlob((out) => resolve(out), "image/png"));
}
