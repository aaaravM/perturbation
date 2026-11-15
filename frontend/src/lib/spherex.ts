// SPHEREx DR1 all-sky HiPS cube: endpoints, frame <-> frequency mapping and channel labels.
// Explicit IRSA URLs only: CDS Strasbourg has been degraded since ~9 Nov 2026, so no HiPS IDs,
// no VizieR/SIMBAD helpers and no Simbad pointer anywhere in the app.

export const SPHEREX_CUBE = "https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube";
export const SPHEREX_CHANNELS_URL = `${SPHEREX_CUBE}/spectral_channels.ecsv`;
export const SPHEREX_PROPERTIES_URL = `${SPHEREX_CUBE}/properties`;
export const ALLWISE_W2 = "https://irsa.ipac.caltech.edu/data/hips/CDS/AllWISE/W2";

const C = 299_792_458; // m/s
const EM_MIN = 7.43e-7; // m (em_min in the cube properties)
const EM_MAX = 5.009e-6; // m (em_max)
export const DEPTH = 102; // hips_cube_depth
export const CHANNELS_PER_DETECTOR = 17;
export const DETECTORS = 6;
/** Frames with no data in DR1 (detector 3/4 dichroic hand-over); IRSA returns 404 for them. */
export const BLANK_FRAMES: ReadonlySet<number> = new Set([50, 51]);
/**
 * Frame 0 exists, but Aladin Lite 3.8.2 requests it as Npix*_0.png while IRSA serves it as
 * Npix*.png (no suffix), so it 404s in this viewer.
 */
export const UNLOADABLE_FRAMES: ReadonlySet<number> = new Set([0]);
export const FIRST_FRAME = 0;
export const LAST_FRAME = DEPTH - 1;

export function isFrameAvailable(frame: number): boolean {
  return (
    Number.isInteger(frame) &&
    frame >= FIRST_FRAME &&
    frame <= LAST_FRAME &&
    !BLANK_FRAMES.has(frame) &&
    !UNLOADABLE_FRAMES.has(frame)
  );
}

/**
 * Snap a requested frame to a loadable one. Keyboard steps move through the gap in the
 * direction of travel (49 -> 52, 52 -> 49); pointer jumps go to the nearest loadable frame.
 */
export function snapFrame(requested: number, previous: number): number {
  const value = Math.min(Math.max(Math.round(requested), FIRST_FRAME), LAST_FRAME);
  if (isFrameAvailable(value)) return value;
  let lo = value - 1;
  while (lo >= FIRST_FRAME && !isFrameAvailable(lo)) lo--;
  let hi = value + 1;
  while (hi <= LAST_FRAME && !isFrameAvailable(hi)) hi++;
  const hasLo = lo >= FIRST_FRAME;
  const hasHi = hi <= LAST_FRAME;
  if (!hasLo) return hi;
  if (!hasHi) return lo;
  if (previous === lo) return hi; // stepping up into the gap
  if (previous === hi) return lo; // stepping down into the gap
  const dLo = value - lo;
  const dHi = hi - value;
  if (dLo === dHi) return previous > value ? lo : hi;
  return dLo < dHi ? lo : hi;
}

/** Tile URL of the SPHEREx cube: .../Norder5/Dir0/Npix7945_20.png (frame 0 has no suffix). */
export const SPHEREX_TILE_RE =
  /\/data\/hips\/SPHEREx\/spherex_allsky_cube\/Norder\d+\/Dir\d+\/Npix\d+(?:_(\d+))?\.(?:png|jpg|fits)$/;

const F_LO = C / EM_MAX;
const F_HI = C / EM_MIN;

/**
 * Frequency (Hz) that selects cube frame `frame` (0..101). This is IRSA's own method;
 * HiPS.setSliceNumber interpolates linearly in wavelength and lands on the wrong frames.
 */
export function frameToFrequencyHz(frame: number): number {
  const f = Math.min(Math.max(Math.round(frame), 0), DEPTH - 1);
  return F_LO + ((f + 0.5) / DEPTH) * (F_HI - F_LO);
}

/** frame = 17 * (detector - 1) + (channel - 1), detector 1..6, channel 1..17. */
export function frameToDetector(frame: number): { detector: number; channel: number } {
  return {
    detector: Math.floor(frame / CHANNELS_PER_DETECTOR) + 1,
    channel: (frame % CHANNELS_PER_DETECTOR) + 1,
  };
}

export interface SpectralChannel {
  frame: number;
  detector: number;
  channel: number;
  /** Central wavelength in micrometres. */
  wavelength: number;
  wlMin?: number;
  wlMax?: number;
  /** Resolving power. */
  r?: number;
}

/** Parse spectral_channels.ecsv (space-delimited, '#' header; FRAME DETECTOR SUBCHAN WAVELENGTH ...). */
export function parseChannelsEcsv(text: string): SpectralChannel[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  if (lines.length < 2) return [];
  const header = lines[0].split(/\s+/);
  const col = (name: string) => header.indexOf(name);
  const iFrame = col("FRAME");
  const iDet = col("DETECTOR");
  const iSub = col("SUBCHAN");
  const iWl = col("WAVELENGTH");
  const iMin = col("WL_MIN");
  const iMax = col("WL_MAX");
  const iR = col("R");
  if (iFrame < 0 || iWl < 0) return [];

  const num = (cells: string[], i: number) => (i >= 0 ? Number(cells[i]) : undefined);
  return lines
    .slice(1)
    .map((line) => {
      const cells = line.split(/\s+/);
      const frame = Number(cells[iFrame]);
      const fallback = frameToDetector(frame);
      return {
        frame,
        detector: num(cells, iDet) ?? fallback.detector,
        channel: num(cells, iSub) ?? fallback.channel,
        wavelength: Number(cells[iWl]),
        wlMin: num(cells, iMin),
        wlMax: num(cells, iMax),
        r: num(cells, iR),
      };
    })
    .filter((c) => Number.isFinite(c.frame) && Number.isFinite(c.wavelength))
    .sort((a, b) => a.frame - b.frame);
}

/** Fallback: `data_cube_crval3_arr` from the HiPS properties file (wavelengths in um). */
export function parseCrval3FromProperties(text: string): SpectralChannel[] {
  const line = text.split(/\r?\n/).find((l) => l.startsWith("data_cube_crval3_arr"));
  if (!line) return [];
  const values = line
    .split("=")[1]
    ?.trim()
    .split(/\s+/)
    .map(Number)
    .filter(Number.isFinite);
  return (values ?? []).map((wavelength, frame) => ({ frame, wavelength, ...frameToDetector(frame) }));
}

/** Load channel labels, preferring the ECSV table, falling back to the properties file. */
export async function loadSpectralChannels(signal?: AbortSignal): Promise<SpectralChannel[]> {
  try {
    const res = await fetch(SPHEREX_CHANNELS_URL, { signal });
    if (res.ok) {
      const parsed = parseChannelsEcsv(await res.text());
      if (parsed.length > 0) return parsed;
    }
  } catch (err) {
    if (signal?.aborted) throw err;
  }
  const res = await fetch(SPHEREX_PROPERTIES_URL, { signal });
  if (!res.ok) throw new Error(`SPHEREx properties: HTTP ${res.status}`);
  return parseCrval3FromProperties(await res.text());
}
