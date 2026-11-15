// DEVELOPMENT FIXTURE generator. Writes a synthetic FieldManifest (docs/api-contract.md, schema
// pxh-field/1, source "fixture") and its PNG frames next to this file. NOT SPHEREx DATA: a seeded
// random star field, one moving dot (12 arcsec/yr), one variable star, noise, partial-coverage
// epochs, flags, a difference image and a fake "then vs now" pair. The Lab uses it only in
// development, always under a "Development fixture: not real data" banner, never in production.
//
//   node frontend/public/bundles/_fixture/generate-fixture.mjs
//
// No dependencies: PNGs are encoded with node:zlib. Row 0 of every PNG is north and east is
// left, matching grid.wcs (CD1_1 < 0, CD2_2 > 0, FITS pixel y = height - row).

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const OUT = dirname(fileURLToPath(import.meta.url));
const FRAMES = join(OUT, "frames");
mkdirSync(FRAMES, { recursive: true });

// ----------------------------------------------------------------------------- PNG encoding
const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
/** channels: 1 = greyscale, 4 = RGBA. `pixels` is a row-major Buffer, row 0 first. */
function encodePng(width, height, channels, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = channels === 1 ? 0 : 6;
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height); // filter byte 0 (none) per row
  for (let y = 0; y < height; y++) pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([signature, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}
function writePng(name, width, height, channels, pixels) {
  writeFileSync(join(FRAMES, name), encodePng(width, height, channels, pixels));
  return `frames/${name}`;
}

// ----------------------------------------------------------------------------- helpers
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20261114);
function gauss() {
  const u = Math.max(rand(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}
const D2R = Math.PI / 180;
const mjdToEpoch = (mjd) => 2000 + (mjd - 51544.5) / 365.25;
const dateToMjd = (iso) => Date.parse(`${iso}T00:00:00Z`) / 86400000 + 40587;
const round = (v, d) => Number(v.toFixed(d));

// ----------------------------------------------------------------------------- field geometry
const W = 98;
const H = 98;
const PIX_ARCSEC = 6.15;
const CENTER = { ra: 180.0, dec: 30.0 };
const CD = PIX_ARCSEC / 3600;
const CRPIX = 49.5;
const WCS = {
  NAXIS1: W,
  NAXIS2: H,
  CTYPE1: "RA---TAN",
  CTYPE2: "DEC--TAN",
  CRPIX1: CRPIX,
  CRPIX2: CRPIX,
  CRVAL1: CENTER.ra,
  CRVAL2: CENTER.dec,
  CD1_1: -round(CD, 9),
  CD1_2: 0,
  CD2_1: 0,
  CD2_2: round(CD, 9),
  RADESYS: "ICRS",
  EQUINOX: 2000.0,
};

/** Sky -> PNG pixel (column, row), row 0 north. */
function skyToPixel(ra, dec) {
  const a = (ra - CENTER.ra) * D2R;
  const d = dec * D2R;
  const d0 = CENTER.dec * D2R;
  const cosc = Math.sin(d0) * Math.sin(d) + Math.cos(d0) * Math.cos(d) * Math.cos(a);
  const xi = (Math.cos(d) * Math.sin(a)) / cosc / D2R; // deg, east positive
  const eta = (Math.cos(d0) * Math.sin(d) - Math.sin(d0) * Math.cos(d) * Math.cos(a)) / cosc / D2R;
  const x = CRPIX + xi / WCS.CD1_1; // FITS 1-based
  const y = CRPIX + eta / WCS.CD2_2;
  return { col: x - 1, row: H - y };
}
/** Offset (arcsec east, north) from the centre -> sky. */
function offsetToSky(east, north) {
  const xi = (east / 3600) * D2R;
  const eta = (north / 3600) * D2R;
  const d0 = CENTER.dec * D2R;
  const rho = Math.hypot(xi, eta);
  if (rho === 0) return { ...CENTER };
  const c = Math.atan(rho);
  const dec = Math.asin(Math.cos(c) * Math.sin(d0) + (eta * Math.sin(c) * Math.cos(d0)) / rho);
  const ra = CENTER.ra * D2R + Math.atan2(xi * Math.sin(c), rho * Math.cos(d0) * Math.cos(c) - eta * Math.sin(d0) * Math.sin(c));
  return { ra: ((ra / D2R) % 360 + 360) % 360, dec: dec / D2R };
}

// ----------------------------------------------------------------------------- epochs
const EPOCHS = [
  { label: "May 2025", survey: "S1", year: 1, pa: 0, start: "2025-05-03", end: "2025-05-17", full: true },
  { label: "Jun 2025", survey: "S1", year: 1, pa: 0, start: "2025-06-02", end: "2025-06-06", full: false },
  { label: "Nov 2025", survey: "S2", year: 1, pa: 180, start: "2025-11-04", end: "2025-11-18", full: true },
  { label: "Dec 2025", survey: "S2", year: 1, pa: 180, start: "2025-12-01", end: "2025-12-04", full: false },
  { label: "May 2026", survey: "S3", year: 2, pa: 0, start: "2026-05-05", end: "2026-05-19", full: true },
  { label: "Oct 2026", survey: "S4", year: 2, pa: 180, start: "2026-10-06", end: "2026-10-12", full: false },
].map((e, index) => {
  const mjd_mid = (dateToMjd(e.start) + dateToMjd(e.end)) / 2;
  const perDet = e.full ? 10 : 3;
  return {
    index,
    ...e,
    mjd_mid: round(mjd_mid, 2),
    n_exposures: perDet * 6,
    detectors: { 1: perDet, 2: perDet, 3: perDet, 4: perDet, 5: perDet, 6: perDet },
  };
});

const DETS = ["D1", "D2", "D3", "D4", "D5", "D6"];
const BANDS = { D1: [0.75, 1.11], D2: [1.11, 1.64], D3: [1.64, 2.42], D4: [2.42, 3.82], D5: [3.82, 4.42], D6: [4.42, 5.0] };

// ----------------------------------------------------------------------------- sources
const NOW_MJD = dateToMjd("2026-11-14");
const NOW_EPOCH = mjdToEpoch(NOW_MJD);
const MOVER = { pmra: 7200, pmdec: -9600 }; // mas/yr: 12.0 arcsec/yr towards PA 143.1 deg
/** Mover offset (arcsec) from the centre at `mjd`; it sits at the centre "now". */
function moverOffset(mjd) {
  const dt = mjdToEpoch(mjd) - NOW_EPOCH;
  return { east: (MOVER.pmra / 1000) * dt, north: (MOVER.pmdec / 1000) * dt };
}
/** Mover spectrum (uJy): a cool, red object, faint in D1-D3, with a dip near 3.3 um. */
function moverFlux(wl) {
  const rise = 260 * Math.pow(wl / 4.5, 2.4);
  const dip = 1 - 0.55 * Math.exp(-((wl - 3.3) ** 2) / (2 * 0.18 ** 2));
  return 18 + rise * dip;
}

const STARS = Array.from({ length: 46 }, () => ({
  east: (rand() - 0.5) * W * PIX_ARCSEC * 0.98,
  north: (rand() - 0.5) * H * PIX_ARCSEC * 0.98,
  flux: 400 * Math.pow(10, rand() * 2.0), // uJy-ish at 1 um
  temp: 0.6 + rand() * 1.2, // colour: higher = bluer
}));
// Keep the centre clear for the mover, and add one variable star.
const STAR_FIELD = STARS.filter((s) => Math.hypot(s.east, s.north) > 45);
const VARIABLE = { east: -118, north: 96, flux: 2600, temp: 0.8 };
const variableScale = (epochIndex) => 1 + 0.45 * Math.sin(epochIndex * 1.7 + 0.4);

function starFlux(star, wl) {
  return star.flux * Math.pow(wl, -star.temp);
}

// ----------------------------------------------------------------------------- rendering
function blankImage() {
  return new Float64Array(W * H);
}
function addPsf(img, col, row, flux, sigma) {
  const r = Math.ceil(sigma * 4);
  const norm = flux / (2 * Math.PI * sigma * sigma);
  const c0 = Math.round(col);
  const r0 = Math.round(row);
  for (let y = r0 - r; y <= r0 + r; y++) {
    if (y < 0 || y >= H) continue;
    for (let x = c0 - r; x <= c0 + r; x++) {
      if (x < 0 || x >= W) continue;
      const dx = x - col;
      const dy = y - row;
      img[y * W + x] += norm * Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma));
    }
  }
}
/** Partial epochs miss part of the field (diagonal edge), as when a scan clips the position. */
function coverageMask(epoch) {
  const mask = new Uint8Array(W * H).fill(1);
  if (epoch.full) return mask;
  const angle = 0.6 + epoch.index * 0.9;
  const nx = Math.cos(angle);
  const ny = Math.sin(angle);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const d = (x - W / 2) * nx + (y - H / 2) * ny;
      if (d > W * 0.18) mask[y * W + x] = 0;
    }
  }
  return mask;
}

const SIGMA_PSF = { D1: 0.72, D2: 0.74, D3: 0.78, D4: 0.86, D5: 0.95, D6: 1.0 };
const NOISE = { D1: 6, D2: 5, D3: 5, D4: 6, D5: 7, D6: 8 };

/** One co-add: model + noise, in uJy-ish units per pixel. */
function renderEpoch(det, epoch, mask) {
  const [lo, hi] = BANDS[det];
  const wl = (lo + hi) / 2;
  const img = blankImage();
  const sigma = SIGMA_PSF[det];
  for (const s of STAR_FIELD) {
    const p = skyToPixel(offsetToSky(s.east, s.north).ra, offsetToSky(s.east, s.north).dec);
    addPsf(img, p.col, p.row, starFlux(s, wl), sigma);
  }
  const v = offsetToSky(VARIABLE.east, VARIABLE.north);
  const vp = skyToPixel(v.ra, v.dec);
  addPsf(img, vp.col, vp.row, starFlux(VARIABLE, wl) * variableScale(epoch.index), sigma);
  const mo = moverOffset(epoch.mjd_mid);
  const m = offsetToSky(mo.east, mo.north);
  const mp = skyToPixel(m.ra, m.dec);
  addPsf(img, mp.col, mp.row, moverFlux(wl) * 9, sigma);
  const noise = NOISE[det] * (epoch.full ? 1 : 1.7);
  for (let i = 0; i < img.length; i++) img[i] = mask[i] ? img[i] + noise * gauss() : NaN;
  return { img, noise };
}

/** One asinh stretch per detector, shared by all epochs. */
function stretch(img, soft, max) {
  const out = Buffer.alloc(W * H);
  const top = Math.asinh(max / soft);
  for (let i = 0; i < img.length; i++) {
    const v = img[i];
    if (Number.isNaN(v)) {
      out[i] = 0;
      continue;
    }
    const s = Math.asinh(Math.max(v + soft * 0.2, 0) / soft) / top;
    out[i] = Math.max(1, Math.min(255, Math.round(s * 255)));
  }
  return out;
}

// ----------------------------------------------------------------------------- build frames
const frames = { epoch: { D1: [], D2: [], D3: [], D4: [], D5: [], D6: [], rgb: [] }, then_vs_now: [], difference: [], flags: [] };
const stretched = {}; // det -> epoch -> Buffer
const rawImages = {}; // det -> epoch -> {img, noise}
const masks = EPOCHS.map(coverageMask);

for (const det of DETS) {
  stretched[det] = [];
  rawImages[det] = [];
  for (const epoch of EPOCHS) {
    const r = renderEpoch(det, epoch, masks[epoch.index]);
    rawImages[det].push(r);
  }
  const soft = NOISE[det] * 3;
  const max = NOISE[det] * 260;
  for (const epoch of EPOCHS) {
    const buf = stretch(rawImages[det][epoch.index].img, soft, max);
    stretched[det].push(buf);
    const url = writePng(`${det}_E${epoch.index}.png`, W, H, 1, buf);
    frames.epoch[det].push({
      epoch: epoch.index,
      url,
      mjd: epoch.mjd_mid,
      n: epoch.detectors[det.slice(1)],
      wl_um: BANDS[det],
    });
  }
}

// False colour: D6 / D3 / D1 as R / G / B, transparent outside coverage.
for (const epoch of EPOCHS) {
  const rgba = Buffer.alloc(W * H * 4);
  const mask = masks[epoch.index];
  for (let i = 0; i < W * H; i++) {
    rgba[i * 4] = stretched.D6[epoch.index][i];
    rgba[i * 4 + 1] = stretched.D3[epoch.index][i];
    rgba[i * 4 + 2] = stretched.D1[epoch.index][i];
    rgba[i * 4 + 3] = mask[i] ? 255 : 0;
  }
  const url = writePng(`RGB_E${epoch.index}.png`, W, H, 4, rgba);
  frames.epoch.rgb.push({ epoch: epoch.index, url, mjd: epoch.mjd_mid, channels: "D6/D3/D1" });
}

// Difference: last minus first epoch in sigma, symmetric [-5, 5] -> 0..255 (128 = 0).
const FIRST = 0;
const LAST = EPOCHS.length - 1;
for (const det of DETS) {
  const a = rawImages[det][LAST];
  const b = rawImages[det][FIRST];
  const out = Buffer.alloc(W * H);
  const sigma = Math.hypot(a.noise, b.noise);
  for (let i = 0; i < W * H; i++) {
    const va = a.img[i];
    const vb = b.img[i];
    if (Number.isNaN(va) || Number.isNaN(vb)) {
      out[i] = 128;
      continue;
    }
    const z = Math.max(-5, Math.min(5, (va - vb) / sigma));
    out[i] = Math.round(127.5 + (z / 5) * 127.5);
  }
  const url = writePng(`DIFF_${det}_E${LAST}-E${FIRST}.png`, W, H, 1, out);
  frames.difference.push({ detector: det, a: LAST, b: FIRST, url, units: "sigma", limits: [-5, 5] });
}

// Flags: saturated cores of the brightest stars, plus an artifact streak in some epochs.
const FLAG_COLORS = { saturated: [227, 200, 110], artifact: [143, 155, 179] };
for (const det of DETS) {
  for (const epoch of EPOCHS) {
    const rgba = Buffer.alloc(W * H * 4);
    const img = rawImages[det][epoch.index].img;
    const threshold = NOISE[det] * 160;
    for (let i = 0; i < W * H; i++) {
      if (img[i] > threshold) {
        rgba.set([...FLAG_COLORS.saturated, 210], i * 4);
      }
    }
    if (epoch.index % 2 === 1) {
      const y0 = 12 + epoch.index * 9;
      for (let x = 6; x < W - 6; x++) {
        const y = Math.round(y0 + x * 0.22);
        if (y >= 0 && y < H) rgba.set([...FLAG_COLORS.artifact, 190], (y * W + x) * 4);
      }
    }
    const url = writePng(`FLAGS_${det}_E${epoch.index}.png`, W, H, 4, rgba);
    frames.flags.push({ detector: det, epoch: epoch.index, url, legend: { saturated: "#e3c86e", artifact: "#8f9bb3" } });
  }
}

// Then vs now: a synthetic "WISE 2010" frame of the same field, and the latest full D6 frame.
const WISE_MJD = 55400;
{
  const img = blankImage();
  for (const s of STAR_FIELD) {
    const p = skyToPixel(offsetToSky(s.east, s.north).ra, offsetToSky(s.east, s.north).dec);
    addPsf(img, p.col, p.row, starFlux(s, 4.6) * 1.1, 1.05);
  }
  const vp = skyToPixel(offsetToSky(VARIABLE.east, VARIABLE.north).ra, offsetToSky(VARIABLE.east, VARIABLE.north).dec);
  addPsf(img, vp.col, vp.row, starFlux(VARIABLE, 4.6), 1.05);
  const mo = moverOffset(WISE_MJD);
  const mp = skyToPixel(offsetToSky(mo.east, mo.north).ra, offsetToSky(mo.east, mo.north).dec);
  addPsf(img, mp.col, mp.row, moverFlux(4.6) * 9, 1.05);
  for (let i = 0; i < img.length; i++) img[i] += 7 * gauss();
  const url = writePng("WISE_W2.png", W, H, 1, stretch(img, 16, 2000));
  const lastFull = [...EPOCHS].reverse().find((e) => e.full);
  frames.then_vs_now.push(
    { label: "WISE 2010", url, mjd: WISE_MJD, instrument: "Synthetic stand-in for AllWISE W2 4.6 µm" },
    {
      label: `SPHEREx ${lastFull.label.slice(-4)}`,
      url: `frames/D6_E${lastFull.index}.png`,
      mjd: lastFull.mjd_mid,
      instrument: "Synthetic stand-in for SPHEREx D6 4.42–5.00 µm",
    },
  );
}

// ----------------------------------------------------------------------------- measurements
const epochPositions = EPOCHS.map((e) => {
  const o = moverOffset(e.mjd_mid);
  const err = e.full ? 220 : 420;
  const p = offsetToSky(o.east + (gauss() * err) / 1000, o.north + (gauss() * err) / 1000);
  return { epoch: e.index, mjd: e.mjd_mid, ra: round(p.ra, 7), dec: round(p.dec, 7), err_mas: err };
});
const predictedPath = EPOCHS.map((e) => {
  const o = moverOffset(e.mjd_mid);
  const p = offsetToSky(o.east, o.north);
  return [round(p.ra, 7), round(p.dec, 7)];
});
const catTotal = Math.hypot(MOVER.pmra, MOVER.pmdec) / 1000;
const catPa = ((Math.atan2(MOVER.pmra, MOVER.pmdec) / D2R) + 360) % 360;
const fit = { pmra: 7135, pmdec: -9558, pmra_err: 240, pmdec_err: 260 };
const fitTotal = Math.hypot(fit.pmra, fit.pmdec) / 1000;
const fitPa = ((Math.atan2(fit.pmra, fit.pmdec) / D2R) + 360) % 360;

const spectrumPoints = [];
for (const det of DETS) {
  const [lo, hi] = BANDS[det];
  for (let k = 0; k < 6; k++) {
    const wl = lo + ((k + 0.5) / 6) * (hi - lo);
    const flux = moverFlux(wl);
    const err = 6 + 0.04 * flux;
    spectrumPoints.push({
      wl_um: round(wl, 4),
      bw_um: round(wl / 41, 4),
      flux_ujy: round(flux + gauss() * err, 2),
      err_ujy: round(err, 2),
      epoch: 4,
      detector: Number(det.slice(1)),
      saturated: det === "D6" && k >= 4,
    });
  }
}
const quickWl = Array.from({ length: 102 }, (_, i) => round(0.753 * Math.pow(5.0 / 0.753, i / 101), 4));
const quickFlux = quickWl.map((wl, i) => (i === 50 || i === 51 ? null : round(moverFlux(wl) * 1.08 + gauss() * 9, 2)));

const photometry = [];
for (const e of EPOCHS) {
  for (const det of DETS) {
    const [lo, hi] = BANDS[det];
    const wl = (lo + hi) / 2;
    const flux = moverFlux(wl) * (1 + 0.025 * Math.sin(e.index * 1.3 + Number(det.slice(1))));
    const err = (6 + 0.04 * flux) * (e.full ? 0.5 : 0.9);
    const measured = flux + gauss() * err;
    photometry.push({
      epoch: e.index,
      detector: Number(det.slice(1)),
      mjd: e.mjd_mid,
      flux_ujy: round(measured, 2),
      err_ujy: round(err, 2),
      mag_ab: round(23.9 - 2.5 * Math.log10(measured), 3),
      wl_um: round(wl, 3),
      saturated_frac: det === "D6" ? 0.04 : 0,
    });
  }
}

const centerNow = offsetToSky(0, 0);
const manifest = {
  schema: "pxh-field/1",
  generated_at: "2026-11-14T23:00:00Z",
  source: "fixture",
  target: {
    key: "_fixture",
    name: "Fixture mover",
    kind: "brown-dwarf",
    aliases: [],
    summary_plain:
      "A synthetic moving dot used to build and test the Lab. It is not a real object and these are not SPHEREx images.",
    facts: [
      { label: "Motion", value: "12″ per year (synthetic)" },
      { label: "Epochs", value: "6 (3 partial)" },
    ],
    astrometry: {
      ra: round(centerNow.ra, 7),
      dec: round(centerNow.dec, 7),
      ref_epoch: round(NOW_EPOCH, 3),
      pmra: MOVER.pmra,
      pmdec: MOVER.pmdec,
      parallax: null,
      rv: null,
      source: "Synthetic (development fixture)",
    },
  },
  center: { ra: CENTER.ra, dec: CENTER.dec, epoch_mjd: round(NOW_MJD, 1) },
  fov_arcmin: round((W * PIX_ARCSEC) / 60, 2),
  release: {
    collections: ["fixture"],
    file_tags: ["fixture-v1"],
    latest_obs: EPOCHS[LAST].end,
    discovered_at: "2026-11-14T23:00:00Z",
  },
  grid: { width: W, height: H, pixscale_arcsec: PIX_ARCSEC, wcs: WCS },
  epochs: EPOCHS,
  frames,
  render: { stretch: "asinh", note: "Synthetic frames; one stretch per detector, shared by all epochs." },
  motion: {
    method: "Fixture: synthetic positions with added noise (not a measurement)",
    epoch_positions: epochPositions,
    fit: {
      ...fit,
      total_arcsec_yr: round(fitTotal, 3),
      total_err: 0.25,
      pa_deg: round(fitPa, 1),
    },
    catalog: {
      pmra: MOVER.pmra,
      pmdec: MOVER.pmdec,
      total_arcsec_yr: round(catTotal, 3),
      pa_deg: round(catPa, 1),
      source: "Fixture catalogue",
    },
    predicted_path: predictedPath,
    verdict: "pass",
    verdict_text: "The synthetic motion is recovered within 1%. Fixture only: this is not a measurement.",
  },
  spectrum: {
    points: spectrumPoints,
    quicklook: { wl_um: quickWl, flux_ujy: quickFlux, label: "Quick-look cube spectrum (synthetic)" },
    notes: ["Saturated points are shown hollow and excluded from fits.", "Synthetic values from the development fixture."],
  },
  lightcurve: {
    epoch_photometry: photometry,
    same_channel: [],
    variability: { chi2_dof: 1.3, max_delta_mag: 0.06, significant: false },
  },
  checks: [
    { name: "Proper motion vs catalogue", value: `${fitTotal.toFixed(2)} ± 0.25 ″/yr vs ${catTotal.toFixed(2)}`, pass: true },
    { name: "Frames share one grid", value: `${W} × ${H} px at ${PIX_ARCSEC}″`, pass: true },
    { name: "Partial epochs marked", value: "3 of 6", pass: true },
  ],
  warnings: ["Development fixture: synthetic frames and numbers, not SPHEREx data."],
  links: [],
  credits: "Synthetic development fixture (generate-fixture.mjs). Contains no SPHEREx, WISE or Gaia data.",
};

writeFileSync(join(OUT, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Wrote ${join(OUT, "manifest.json")} and ${Object.values(frames.epoch).flat().length + frames.difference.length + frames.flags.length + 1} frames.`);
