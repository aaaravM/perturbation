// Coordinates and plain-language descriptions of a place on the sky: galactic and ecliptic
// coordinates, sexagesimal formatting, the best month to see it, and a few sentences on where it
// is (Milky Way, ecliptic, poles). All computed from the position alone.

const DEG = Math.PI / 180;

// ICRS -> Galactic rotation (Hipparcos, ESA 1997, vol. 1 sec. 1.5.3).
const G = [
  [-0.0548755604162154, -0.873437090234885, -0.4838350155487132],
  [0.4941094278755837, -0.4448296299600112, 0.7469822444972189],
  [-0.8676661490190047, -0.1980763734312015, 0.4559837761750669],
];

export function toGalactic(ra: number, dec: number): { l: number; b: number } {
  const a = ra * DEG;
  const d = dec * DEG;
  const v = [Math.cos(d) * Math.cos(a), Math.cos(d) * Math.sin(a), Math.sin(d)];
  const g = G.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]);
  let l = Math.atan2(g[1], g[0]) / DEG;
  if (l < 0) l += 360;
  return { l, b: Math.asin(Math.max(-1, Math.min(1, g[2]))) / DEG };
}

/** Galactic (l, b) back to ICRS (ra, dec): the transpose of the rotation. */
export function fromGalactic(l: number, b: number): { ra: number; dec: number } {
  const lr = l * DEG;
  const br = b * DEG;
  const g = [Math.cos(br) * Math.cos(lr), Math.cos(br) * Math.sin(lr), Math.sin(br)];
  const v = [0, 1, 2].map((j) => G[0][j] * g[0] + G[1][j] * g[1] + G[2][j] * g[2]);
  let ra = Math.atan2(v[1], v[0]) / DEG;
  if (ra < 0) ra += 360;
  return { ra, dec: Math.asin(Math.max(-1, Math.min(1, v[2]))) / DEG };
}

const OBLIQUITY = 23.4392911 * DEG;

export function eclipticLatitude(ra: number, dec: number): number {
  const a = ra * DEG;
  const d = dec * DEG;
  const s = Math.sin(d) * Math.cos(OBLIQUITY) - Math.cos(d) * Math.sin(OBLIQUITY) * Math.sin(a);
  return Math.asin(Math.max(-1, Math.min(1, s))) / DEG;
}

const pad = (v: number, n = 2) => String(v).padStart(n, "0");

/** 101.2875 -> "6h 45m 09.0s" */
export function formatRaHms(ra: number, decimals = 1): string {
  const h = (((ra % 360) + 360) % 360) / 15;
  let hh = Math.floor(h);
  let mm = Math.floor((h - hh) * 60);
  let ss = Number(((h - hh - mm / 60) * 3600).toFixed(decimals));
  if (ss >= 60) {
    ss = 0;
    mm += 1;
  }
  if (mm >= 60) {
    mm = 0;
    hh = (hh + 1) % 24;
  }
  const s = ss.toFixed(decimals).padStart(decimals ? 3 + decimals : 2, "0");
  return `${hh}h ${pad(mm)}m ${s}s`;
}

/** -16.7161 -> "−16° 42′ 58″" */
export function formatDecDms(dec: number, decimals = 0): string {
  const sign = dec < 0 ? "−" : "+";
  const a = Math.abs(dec);
  let dd = Math.floor(a);
  let mm = Math.floor((a - dd) * 60);
  let ss = Number(((a - dd - mm / 60) * 3600).toFixed(decimals));
  if (ss >= 60) {
    ss = 0;
    mm += 1;
  }
  if (mm >= 60) {
    mm = 0;
    dd += 1;
  }
  return `${sign}${dd}° ${pad(mm)}′ ${ss.toFixed(decimals).padStart(decimals ? 3 + decimals : 2, "0")}″`;
}

export function formatDeg(v: number, digits = 3, signed = false): string {
  const s = Math.abs(v).toFixed(digits);
  return `${v < 0 ? "−" : signed ? "+" : ""}${s}°`;
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * Month when this part of the sky is highest at midnight: when the Sun is on the opposite side,
 * at RA + 180 deg. The Sun's RA is 0 at the March equinox (about 20 March) and grows about a degree
 * a day.
 */
export function bestMonth(ra: number): string {
  const days = ((((ra + 180) % 360) + 360) % 360) / 360 * 365.25;
  const date = new Date(Date.UTC(2026, 2, 20) + days * 86400000);
  return MONTHS[date.getUTCMonth()];
}

/** A few plain sentences on where a position is, different from place to place. */
export function describePlace(ra: number, dec: number): string[] {
  const { l, b } = toGalactic(ra, dec);
  const beta = eclipticLatitude(ra, dec);
  const out: string[] = [];
  const ab = Math.abs(b);
  const towards = (lon: number) => {
    const d = Math.abs(((lon - l + 540) % 360) - 180);
    return d;
  };
  if (ab < 5) {
    if (towards(0) < 25) out.push("In the plane of the Milky Way, looking towards the crowded centre of our galaxy.");
    else if (towards(180) < 30) out.push("In the plane of the Milky Way, looking away from its centre, towards the galaxy's outer edge.");
    else if (towards(90) < 30) out.push("In the plane of the Milky Way, in the direction the Sun is travelling round the galaxy.");
    else if (towards(270) < 30) out.push("In the plane of the Milky Way, behind us as the Sun travels round the galaxy.");
    else out.push("In the plane of the Milky Way, where stars and dust crowd together.");
  } else if (ab < 20) {
    out.push(`Just ${b > 0 ? "north" : "south"} of the Milky Way band (${ab.toFixed(0)}° off its plane).`);
  } else if (ab > 65) {
    out.push(
      `Near the ${b > 0 ? "north" : "south"} galactic pole: we look straight out of the Milky Way, through few stars and little dust.`,
    );
  } else {
    out.push(`Well away from the Milky Way (${ab.toFixed(0)}° off its plane), so foreground stars are sparser.`);
  }
  if (Math.abs(beta) < 6) out.push("On the ecliptic: the Sun, Moon and planets pass through this part of the sky.");
  else if (Math.abs(beta) > 80)
    out.push(
      `Close to the ${beta > 0 ? "north" : "south"} ecliptic pole, where SPHEREx looks on almost every orbit.`,
    );
  if (Math.abs(dec) > 60) {
    const lat = (90 - Math.abs(dec)).toFixed(0);
    out.push(
      dec > 0
        ? `Never sets as seen from north of latitude ${lat}° N, and never rises south of ${lat}° S.`
        : `Never sets as seen from south of latitude ${lat}° S, and never rises north of ${lat}° N.`,
    );
  }
  else if (dec > 35) out.push("Seen best from the Northern Hemisphere.");
  // (|dec| > 60 is covered above)
  else if (dec < -35) out.push("Seen best from the Southern Hemisphere.");
  else if (Math.abs(dec) < 10) out.push("Near the celestial equator, so it can be seen from almost anywhere on Earth.");
  return out;
}
