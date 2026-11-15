// Sky coordinates and time for the Lab: a forgiving coordinate parser (decimal degrees or
// sexagesimal), formatting, linear proper-motion propagation and MJD helpers.

export interface RaDec {
  ra: number;
  dec: number;
}

const MJD_UNIX_EPOCH = 40587; // MJD of 1970-01-01T00:00Z
const MJD_J2000 = 51544.5;
const DAYS_PER_JULIAN_YEAR = 365.25;

export function mjdNow(): number {
  return Date.now() / 86_400_000 + MJD_UNIX_EPOCH;
}

export function mjdToDate(mjd: number): Date {
  return new Date((mjd - MJD_UNIX_EPOCH) * 86_400_000);
}

/** Julian epoch, e.g. 2026.87. */
export function mjdToEpoch(mjd: number): number {
  return 2000 + (mjd - MJD_J2000) / DAYS_PER_JULIAN_YEAR;
}

export function epochToMjd(epoch: number): number {
  return MJD_J2000 + (epoch - 2000) * DAYS_PER_JULIAN_YEAR;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Aug 2025" (UTC). */
export function formatMonthYear(mjd: number): string {
  const d = mjdToDate(mjd);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** "14 Aug 2025" (UTC). */
export function formatDay(mjd: number): string {
  const d = mjdToDate(mjd);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Wrap RA into [0, 360). */
export function normRa(ra: number): number {
  return ((ra % 360) + 360) % 360;
}

/**
 * Move a position linearly with its proper motion (mas/yr; pmra includes cos(dec)), from
 * `fromEpoch` to `toEpoch` (Julian years). Fine for decades away from the poles; parallax and
 * radial velocity are ignored.
 */
export function propagate(
  pos: RaDec & { pmra: number; pmdec: number },
  fromEpoch: number,
  toEpoch: number,
): RaDec {
  const dt = toEpoch - fromEpoch;
  const cosDec = Math.max(Math.cos((pos.dec * Math.PI) / 180), 1e-6);
  return {
    ra: normRa(pos.ra + (pos.pmra * dt) / 3.6e6 / cosDec),
    dec: Math.max(-90, Math.min(90, pos.dec + (pos.pmdec * dt) / 3.6e6)),
  };
}

/** Great-circle separation in degrees. */
export function separationDeg(a: RaDec, b: RaDec): number {
  const r = Math.PI / 180;
  const sinDDec = Math.sin(((b.dec - a.dec) * r) / 2);
  const sinDRa = Math.sin(((b.ra - a.ra) * r) / 2);
  const h = sinDDec * sinDDec + Math.cos(a.dec * r) * Math.cos(b.dec * r) * sinDRa * sinDRa;
  return (2 * Math.asin(Math.min(1, Math.sqrt(h)))) / r;
}

/** Offset of b from a on the tangent plane, in arcsec (east positive, north positive). */
export function offsetArcsec(a: RaDec, b: RaDec): { east: number; north: number } {
  let dRa = b.ra - a.ra;
  if (dRa > 180) dRa -= 360;
  if (dRa < -180) dRa += 360;
  return {
    east: dRa * Math.cos((a.dec * Math.PI) / 180) * 3600,
    north: (b.dec - a.dec) * 3600,
  };
}

function pad(value: number, width: number, digits = 0): string {
  const [int, frac] = value.toFixed(digits).split(".");
  return frac === undefined ? int.padStart(width, "0") : `${int.padStart(width, "0")}.${frac}`;
}

/** Split a positive value into (units, minutes, seconds) with carry after rounding. */
function sexagesimal(value: number, secDigits: number): [number, number, number] {
  const scale = 10 ** secDigits;
  let totalSec = Math.round(value * 3600 * scale) / scale;
  const units = Math.floor(totalSec / 3600);
  totalSec -= units * 3600;
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec - minutes * 60;
  return [units, minutes, Math.max(0, seconds)];
}

/** "17h 57m 47.06s" */
export function formatRaHms(ra: number, secDigits = 2): string {
  const [hours, m, s] = sexagesimal(normRa(ra) / 15, secDigits);
  const h = hours >= 24 ? hours - 24 : hours;
  return `${pad(h, 2)}h ${pad(m, 2)}m ${pad(s, 2, secDigits)}s`;
}

/** "+04° 46′ 14.6″" */
export function formatDecDms(dec: number, secDigits = 1): string {
  const sign = dec < 0 ? "−" : "+";
  const [d, m, s] = sexagesimal(Math.abs(dec), secDigits);
  return `${sign}${pad(d, 2)}° ${pad(m, 2)}′ ${pad(s, 2, secDigits)}″`;
}

/** "269.44607°" style decimal readouts. */
export function formatDeg(value: number, digits = 5, signed = false): string {
  const text = Math.abs(value).toFixed(digits);
  if (!signed) return `${value < 0 ? "−" : ""}${text}°`;
  return `${value < 0 ? "−" : "+"}${text}°`;
}

/** Field of view for display: arcmin below 1 degree, degrees above. */
export function formatFov(fovDeg: number): string {
  const arcmin = fovDeg * 60;
  if (arcmin < 59.95) return `${arcmin < 9.95 ? arcmin.toFixed(1) : arcmin.toFixed(0)}′`;
  return `${fovDeg < 9.95 ? fovDeg.toFixed(1) : fovDeg.toFixed(0)}°`;
}

// ---------------------------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------------------------

const MINUS = /[−–—]/g; // typographic minus signs
const NUM = String.raw`[+-]?\d+(?:\.\d*)?|[+-]?\.\d+`;

function inRange(pos: RaDec): RaDec | null {
  if (!Number.isFinite(pos.ra) || !Number.isFinite(pos.dec)) return null;
  if (pos.ra < 0 || pos.ra >= 360 || pos.dec < -90 || pos.dec > 90) return null;
  return pos;
}

function fromParts(raParts: number[], decSign: number, decParts: number[]): RaDec | null {
  const [h, m = 0, s = 0] = raParts;
  const [d, dm = 0, ds = 0] = decParts;
  if (m >= 60 || s >= 60 || dm >= 60 || ds >= 60 || h >= 24 || h < 0) return null;
  const ra = (h + m / 60 + s / 3600) * 15;
  const dec = decSign * (Math.abs(d) + dm / 60 + ds / 3600);
  return inRange({ ra, dec });
}

/** "J175748.49+044136.1" style designations (as in many catalogue names). */
function parseCompact(text: string): RaDec | null {
  const m = /^j?(\d{2})(\d{2})(\d{2}(?:\.\d+)?)([+-])(\d{2})(\d{2})(\d{2}(?:\.\d+)?)$/i.exec(text.replace(/\s+/g, ""));
  if (!m) return null;
  return fromParts([+m[1], +m[2], +m[3]], m[4] === "-" ? -1 : 1, [+m[5], +m[6], +m[7]]);
}

/**
 * Parse sky coordinates typed by a person. Accepts:
 * - decimal degrees: "269.452 4.693", "269.452, -4.693", "269.452d +4.693d"
 * - sexagesimal (RA in hours): "17 57 48.5 +04 41 36", "17:57:48.5 +04:41:36",
 *   "17h57m48.5s +4d41m36s", "17h 57m 48.5s, +04° 41′ 36″"
 * - compact designations: "J175748.49+044136.1"
 * Returns null for anything else (it may be a name).
 */
export function parseCoordinates(input: string): RaDec | null {
  const text = input.trim().replace(MINUS, "-").replace(/[,;]/g, " ").replace(/\s+/g, " ");
  if (!text) return null;

  const compact = parseCompact(text);
  if (compact) return compact;

  const hasUnits = /[hms:°'′"″d]/i.test(text);
  // Plain decimal pair.
  const decimal = new RegExp(`^(${NUM})\\s*(?:d|deg|°)?\\s+(${NUM})\\s*(?:d|deg|°)?$`, "i").exec(text);
  if (decimal) {
    const raText = decimal[1];
    const decText = decimal[2];
    // "17 57" would be ambiguous; two plain numbers are degrees.
    const pos = inRange({ ra: Number(raText), dec: Number(decText) });
    if (pos) return pos;
    return null;
  }
  if (!hasUnits && !/^\S+ \S+ \S+ \S+/.test(text)) return null;

  // Split into RA and Dec at the sign of the declination, or in the middle of six numbers.
  const unitless = text.replace(/[hms:°'′"″d]/gi, " ").replace(/\s+/g, " ").trim();
  const tokens = unitless.split(" ");
  if (!tokens.every((t) => new RegExp(`^(?:${NUM})$`).test(t))) return null;
  let split = tokens.findIndex((t, i) => i > 0 && /^[+-]/.test(t));
  if (split < 0) {
    if (tokens.length === 6) split = 3;
    else if (tokens.length === 4) split = 2;
    else if (tokens.length === 2) split = 1;
    else return null;
  }
  const raTokens = tokens.slice(0, split).map(Number);
  const decTokens = tokens.slice(split);
  if (raTokens.length < 1 || raTokens.length > 3 || decTokens.length < 1 || decTokens.length > 3) return null;
  const decSign = decTokens[0].startsWith("-") ? -1 : 1;
  const decNums = decTokens.map((t) => Math.abs(Number(t)));

  // "269.45d 4.69d" (degrees with a d suffix) has one token each and a unit that is not h.
  if (raTokens.length === 1 && decNums.length === 1 && !/h/i.test(text)) {
    return inRange({ ra: raTokens[0], dec: decSign * decNums[0] });
  }
  return fromParts(raTokens, decSign, decNums);
}
