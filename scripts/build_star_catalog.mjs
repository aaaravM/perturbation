#!/usr/bin/env node
// Build the Sky-mode star and constellation data from the d3-celestial catalogues.
//
//   node scripts/build_star_catalog.mjs                 # download the pinned d3-celestial files
//   node scripts/build_star_catalog.mjs --src <dir>     # or use local copies of the same files
//
// Source: d3-celestial by Olaf Frohn (BSD-3-Clause), https://github.com/ofrohn/d3-celestial, data/ at
// commit PINNED below. Stars are the Hipparcos-based stars.8.json (every star to V = 8); names come
// from starnames.json; constellation figures and names from constellations.lines.json and
// constellations.json. d3-celestial stores RA as a longitude in -180..180 deg; it is mapped to 0..360.
//
// Outputs (frontend/public/data/):
//   stars-6.bin   stars with V <= 6 (what the eye can see), brightest first
//   stars-8.bin   stars with 6 < V <= 8, brightest first (loaded when the camera comes close)
//   sky-lines.json  constellation figures, names and label positions; named stars with V <= 3
//   LICENSE-d3-celestial.txt  the BSD-3-Clause notice the licence asks to keep with the data
//
// Binary layout (little-endian), n stars:
//   0  "PXS1" magic        4  uint32 n
//   8  float32 ra[n] (deg, ICRS J2000)   8+4n  float32 dec[n] (deg)
//   8+8n  int16 mag[n] (V x 100)         8+10n int16 bv[n] (B-V x 1000; -32768 = unknown)

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PINNED = "7e720a3de062059d4c5400a379146a601d9010e0";
const RAW = `https://raw.githubusercontent.com/ofrohn/d3-celestial/${PINNED}`;
const FILES = {
  stars: "data/stars.8.json",
  names: "data/starnames.json",
  lines: "data/constellations.lines.json",
  constellations: "data/constellations.json",
  licence: "LICENSE",
};
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(REPO, "frontend", "public", "data");
const BV_UNKNOWN = -32768;
const NAMED_MAG_LIMIT = 3;

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function load(rel, src) {
  if (src) return readFile(path.join(src, path.basename(rel)), "utf8");
  const res = await fetch(`${RAW}/${rel}`, { headers: { "User-Agent": "planet-x-hunter-catalog-builder" } });
  if (!res.ok) throw new Error(`${res.status} for ${rel}`);
  return res.text();
}

const toRa = (lon) => (lon < 0 ? lon + 360 : lon);
const round = (v, d = 4) => Math.round(v * 10 ** d) / 10 ** d;

function packStars(stars) {
  const n = stars.length;
  const buf = new ArrayBuffer(8 + 12 * n);
  const view = new DataView(buf);
  "PXS1".split("").forEach((c, i) => view.setUint8(i, c.charCodeAt(0)));
  view.setUint32(4, n, true);
  stars.forEach((s, i) => {
    view.setFloat32(8 + 4 * i, s.ra, true);
    view.setFloat32(8 + 4 * n + 4 * i, s.dec, true);
    view.setInt16(8 + 8 * n + 2 * i, Math.round(s.mag * 100), true);
    view.setInt16(8 + 10 * n + 2 * i, s.bv === null ? BV_UNKNOWN : Math.round(s.bv * 1000), true);
  });
  return Buffer.from(buf);
}

async function main() {
  const src = arg("--src");
  const [starsRaw, namesRaw, linesRaw, constRaw, licence] = await Promise.all(
    Object.values(FILES).map((f) => load(f, src)),
  );
  const starsJson = JSON.parse(starsRaw);
  const names = JSON.parse(namesRaw);
  const lines = JSON.parse(linesRaw);
  const consts = JSON.parse(constRaw);

  const stars = starsJson.features
    .map((f) => {
      const [lon, dec] = f.geometry.coordinates;
      const bv = Number.parseFloat(f.properties.bv);
      return {
        hip: f.id,
        ra: toRa(lon),
        dec,
        mag: Number(f.properties.mag),
        bv: Number.isFinite(bv) ? bv : null,
      };
    })
    .filter((s) => Number.isFinite(s.ra) && Number.isFinite(s.dec) && Number.isFinite(s.mag))
    .sort((a, b) => a.mag - b.mag);
  const bright = stars.filter((s) => s.mag <= 6);
  const faint = stars.filter((s) => s.mag > 6);

  const constById = new Map(consts.features.map((f) => [f.id, f]));
  const constellations = lines.features.map((f) => {
    const meta = constById.get(f.id);
    const [lon, dec] = meta?.geometry?.coordinates ?? [NaN, NaN];
    return {
      id: f.id,
      name: meta?.properties?.name ?? f.id,
      rank: Number(meta?.properties?.rank ?? f.properties?.rank ?? 3),
      label: Number.isFinite(lon) ? [round(toRa(lon), 3), round(dec, 3)] : null,
      lines: f.geometry.coordinates.map((l) => l.flatMap(([lo, d]) => [round(toRa(lo)), round(d)])),
    };
  });

  const byHip = new Map(stars.map((s) => [String(s.hip), s]));
  const named = Object.entries(names)
    .filter(([, v]) => v.name)
    .map(([hip, v]) => ({ name: v.name, s: byHip.get(hip) }))
    .filter((x) => x.s && x.s.mag <= NAMED_MAG_LIMIT)
    .sort((a, b) => a.s.mag - b.s.mag)
    .map(({ name, s }) => ({ name, ra: round(s.ra), dec: round(s.dec), mag: s.mag }));

  await mkdir(OUT, { recursive: true });
  await writeFile(path.join(OUT, "stars-6.bin"), packStars(bright));
  await writeFile(path.join(OUT, "stars-8.bin"), packStars(faint));
  const meta = {
    source: `d3-celestial by Olaf Frohn, https://github.com/ofrohn/d3-celestial (commit ${PINNED})`,
    licence: "BSD-3-Clause; see LICENSE-d3-celestial.txt",
    catalogue: "Hipparcos-based star positions (J2000) and V magnitudes, as compiled by d3-celestial",
    stars: { "stars-6.bin": bright.length, "stars-8.bin": faint.length },
    constellations,
    named,
  };
  await writeFile(path.join(OUT, "sky-lines.json"), `${JSON.stringify(meta)}\n`);
  await writeFile(path.join(OUT, "LICENSE-d3-celestial.txt"), licence);
  console.log(
    `stars-6.bin ${bright.length} stars, stars-8.bin ${faint.length} stars, ` +
      `${constellations.length} constellations, ${named.length} named stars -> ${path.relative(REPO, OUT)}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
