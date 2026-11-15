// Shared helpers for the e2e tests: console-error capture and IRSA tile bookkeeping.
import type { Page, Response } from "@playwright/test";

/** SPHEREx cube tile; group 1 = frame (frame 0 would have no suffix, and 404s in Aladin 3.8.2). */
export const SPHEREX_TILE =
  /^https:\/\/irsa\.ipac\.caltech\.edu\/data\/hips\/SPHEREx\/spherex_allsky_cube\/Norder\d+\/Dir\d+\/Npix(\d+)(?:_(\d+))?\.png$/;
export const ALLWISE_TILE =
  /^https:\/\/irsa\.ipac\.caltech\.edu\/data\/hips\/CDS\/AllWISE\/W2\/Norder\d+\/Dir\d+\/Npix\d+\.\w+$/;

const NEXT_DEV_INTERNALS = /^https?:\/\/localhost:\d+\/__nextjs_/;

export interface TileRecord {
  url: string;
  status: number;
  npix: number;
  frame: number | null;
}

export interface PageLog {
  consoleErrors: string[];
  spherex: TileRecord[];
  allwise: { url: string; status: number }[];
  cdsRequests: string[];
  /** Every response with status >= 400, as "status url". */
  badResponses: string[];
}

export function watchPage(page: Page): PageLog {
  const log: PageLog = { consoleErrors: [], spherex: [], allwise: [], cdsRequests: [], badResponses: [] };
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    // Next 16.4.6 dev tools request their own Geist font, which its dev server 404s. Dev-only,
    // not part of the app; everything else counts.
    if (NEXT_DEV_INTERNALS.test(msg.location()?.url ?? "")) return;
    log.consoleErrors.push(`${msg.text()} ${msg.location()?.url ?? ""}`.trim());
  });
  page.on("pageerror", (err) => log.consoleErrors.push(`pageerror: ${err.message}`));
  page.on("request", (req) => {
    if (/unistra\.fr|u-strasbg\.fr|cds\.unistra/.test(req.url())) log.cdsRequests.push(req.url());
  });
  page.on("response", (res: Response) => {
    const url = res.url();
    if (res.status() >= 400 && !NEXT_DEV_INTERNALS.test(url)) {
      log.badResponses.push(`${res.status()} ${url}`);
    }
    const m = SPHEREX_TILE.exec(url);
    if (m) {
      log.spherex.push({
        url,
        status: res.status(),
        npix: Number(m[1]),
        frame: m[2] === undefined ? null : Number(m[2]),
      });
    } else if (ALLWISE_TILE.test(url)) {
      log.allwise.push({ url, status: res.status() });
    }
  });
  return log;
}

export const tilesFor = (log: PageLog, frame: number) => log.spherex.filter((t) => t.frame === frame);

/** Be gentle with IRSA between bursts of tile requests. */
export const pause = (page: Page, ms = 1500) => page.waitForTimeout(ms);

/** Hide the Next.js dev-mode indicator in screenshots. */
export async function hideDevOverlay(page: Page) {
  await page.addStyleTag({ content: "nextjs-portal{display:none!important}" });
}

/** Aladin's actual view centre, published on the viewer element as "ra,dec,fov". */
export async function viewerCenter(page: Page) {
  const raw = await page.getByTestId("sky-viewer").getAttribute("data-center");
  if (!raw) return null;
  const [ra, dec, fov] = raw.split(",").map(Number);
  return { ra, dec, fov };
}
