// Dark-centred diverging colour map for difference images (after Crameri's "berlin", which is
// designed for dark backgrounds): blue = brighter in the first epoch, black = no change,
// red = brighter in the last epoch. Perceptually ordered, readable for common colour deficiencies.

type Rgb = [number, number, number];

const STOPS: { t: number; c: Rgb }[] = [
  { t: -1, c: [158, 176, 255] },
  { t: -0.6, c: [62, 120, 196] },
  { t: -0.25, c: [24, 52, 80] },
  { t: 0, c: [14, 13, 12] },
  { t: 0.25, c: [74, 22, 12] },
  { t: 0.6, c: [176, 70, 50] },
  { t: 1, c: [255, 172, 160] },
];

/** t in [-1, 1] (value / limit) -> RGB. */
export function divergingColor(t: number): Rgb {
  const x = Math.max(-1, Math.min(1, t));
  for (let i = 1; i < STOPS.length; i++) {
    const a = STOPS[i - 1];
    const b = STOPS[i];
    if (x <= b.t) {
      const f = (x - a.t) / (b.t - a.t);
      return [0, 1, 2].map((k) => Math.round(a.c[k] + (b.c[k] - a.c[k]) * f)) as Rgb;
    }
  }
  return STOPS[STOPS.length - 1].c;
}

/** CSS gradient for the legend. */
export const DIVERGING_GRADIENT = `linear-gradient(90deg, ${STOPS.map(
  (s) => `rgb(${s.c.join(" ")}) ${((s.t + 1) / 2) * 100}%`,
).join(", ")})`;
