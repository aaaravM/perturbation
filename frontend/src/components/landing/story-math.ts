// Small easing helpers for the home page story (all take and return 0 to 1 unless noted).

export const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Progress of v through [a, b], clamped. */
export const span = (v: number, a: number, b: number) => clamp01((v - a) / (b - a));

export const smooth = (v: number) => {
  const t = clamp01(v);
  return t * t * (3 - 2 * t);
};

export const easeInOut = (v: number) => {
  const t = clamp01(v);
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
};

export const easeOut = (v: number) => 1 - (1 - clamp01(v)) ** 3;

export const mix = (a: number, b: number, t: number) => a + (b - a) * t;
