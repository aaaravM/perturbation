// The Explorer technical preview against the real IRSA SPHEREx and AllWISE HiPS services.
// One page is shared across the serial tests to keep the load on IRSA low.
import { expect, test, type Page } from "@playwright/test";
import { pause, tilesFor, viewerCenter, watchPage, type PageLog } from "./helpers";

test.describe.configure({ mode: "serial" });

let page: Page;
let log: PageLog;

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  log = watchPage(page);
});

test.afterAll(async () => {
  await page.close();
});

const DEFAULT_FRAME = 20;
const slider = () => page.getByTestId("wavelength-slider").getByRole("slider");
const status = () => page.getByTestId("sky-status");

test("loads real SPHEREx tiles for the default view with no console errors", async () => {
  const response = await page.goto("/explore");
  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1, name: "Lab: blink SPHEREx images of any patch of sky" })).toBeAttached();
  await expect(status()).toHaveAttribute("data-state", "ready", { timeout: 45_000 });
  await pause(page, 2500); // let the first burst of tiles finish

  const tiles = tilesFor(log, DEFAULT_FRAME);
  expect(tiles.length, "SPHEREx tiles requested for the default frame").toBeGreaterThan(0);
  expect(tiles.filter((t) => t.status === 200).length).toBeGreaterThan(0);
  expect(log.spherex.filter((t) => t.status === 404), "no 404 tiles").toEqual([]);
  expect(log.spherex.filter((t) => t.frame === null || t.frame === 0), "never frame 0").toEqual([]);
  expect(log.cdsRequests, "no requests to CDS").toEqual([]);
  expect(log.consoleErrors, "console errors").toEqual([]);

  // Default field of view is about 1.5 degrees.
  const center = await viewerCenter(page);
  expect(center?.fov).toBeGreaterThan(1.3);
  expect(center?.fov).toBeLessThan(1.7);
});

test("moving the wavelength slider loads tiles for the new frame", async () => {
  await slider().focus();
  const target = DEFAULT_FRAME + 5;
  const firstTile = page.waitForResponse(
    (res) => new RegExp(`/Npix\\d+_${target}\\.png$`).test(res.url()),
    { timeout: 30_000 },
  );
  for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowRight");
  await expect(slider()).toHaveAttribute("aria-valuetext", new RegExp(`^Frame ${target},`));
  expect((await firstTile).status()).toBe(200);
  await pause(page, 2000);
  const tiles = tilesFor(log, target);
  expect(tiles.length).toBeGreaterThan(0);
  expect(tiles.every((t) => t.status === 200), JSON.stringify(tiles)).toBe(true);
  await expect(status()).toHaveAttribute("data-state", "ready");
});

test("the slider skips the blank frames 50 and 51", async () => {
  // 25 -> 49 one step at a time; the debounce means only the last frame loads.
  for (let i = 25; i < 49; i++) await page.keyboard.press("ArrowRight");
  await expect(slider()).toHaveAttribute("aria-valuetext", /^Frame 49,/);
  await pause(page, 1200);
  await page.keyboard.press("ArrowRight");
  await expect(slider()).toHaveAttribute("aria-valuetext", /^Frame 52,/);
  await page.keyboard.press("ArrowLeft");
  await expect(slider()).toHaveAttribute("aria-valuetext", /^Frame 49,/);
  await page.keyboard.press("Home");
  await expect(slider()).toHaveAttribute("aria-valuetext", /^Frame 1,/);
  await pause(page, 2500);
  for (const frame of [0, 50, 51]) expect(tilesFor(log, frame), `frame ${frame}`).toEqual([]);
  expect(log.spherex.filter((t) => t.status !== 200), "all SPHEREx tiles 200").toEqual([]);
  await expect(status()).toHaveAttribute("data-state", "ready");
});

test("the AllWISE W2 overlay loads its tiles", async () => {
  const firstTile = page.waitForResponse((res) => /\/AllWISE\/W2\/Norder\d+\/Dir\d+\/Npix/.test(res.url()), {
    timeout: 30_000,
  });
  await page.getByTestId("allwise-toggle-desktop").click();
  await expect(page.getByTestId("allwise-toggle-desktop")).toHaveAttribute("data-state", "checked");
  expect((await firstTile).status()).toBe(200);
  await pause(page, 2000);
  expect(log.allwise.length).toBeGreaterThan(0);
  expect(log.allwise.filter((t) => t.status !== 200), "all AllWISE tiles 200").toEqual([]);
  await page.getByRole("slider", { name: "AllWISE overlay opacity" }).first().focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByText("55%").first()).toBeVisible();
  await page.getByTestId("allwise-toggle-desktop").click();
  await pause(page);
});

test("the URL follows the view, and the view follows the URL", async () => {
  // View -> URL: pan and zoom with the keyboard.
  await page.getByTestId("sky-viewer").focus();
  await page.keyboard.press("ArrowLeft");
  await expect.poll(() => new URL(page.url()).searchParams.get("ra")).not.toBeNull();
  const ra = Number(new URL(page.url()).searchParams.get("ra"));
  expect(ra).toBeGreaterThan(269.4461); // east is left: panning left increases RA
  await page.keyboard.press("+");
  await expect
    .poll(() => Number(new URL(page.url()).searchParams.get("fov")))
    .toBeLessThan(1.3);
  await pause(page);

  // URL -> view: a client-side URL change (what a link or search does) moves the sky.
  await page.evaluate(() => window.history.pushState(null, "", "/explore?ra=83.82208&dec=-5.39111&fov=2"));
  await expect.poll(async () => (await viewerCenter(page))?.ra).toBeCloseTo(83.82208, 3);
  expect((await viewerCenter(page))?.dec).toBeCloseTo(-5.39111, 3);
  expect((await viewerCenter(page))?.fov).toBeCloseTo(2, 2);
  await pause(page, 2500);

  // Back moves it back.
  await page.goBack();
  await expect.poll(async () => (await viewerCenter(page))?.ra).toBeCloseTo(ra, 3);
  await pause(page);
  expect(log.spherex.filter((t) => t.status !== 200), "all SPHEREx tiles 200").toEqual([]);
  expect(log.badResponses, "HTTP errors").toEqual([]);
  expect(log.consoleErrors, "console errors").toEqual([]);
});

test("leaving and coming back reuses the one Aladin instance", async () => {
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Discoveries" }).click();
  await expect(page).toHaveURL(/\/discoveries$/);
  await expect(page.locator(".aladin-container")).toHaveCount(0);
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Lab" }).click();
  await expect(page).toHaveURL(/\/explore/);
  await expect(page.getByTestId("sky-viewer")).toHaveAttribute("data-instances", "1");
  await expect(page.locator(".aladin-container")).toHaveCount(1);
  await expect(status()).toHaveAttribute("data-state", "ready", { timeout: 30_000 });
  expect(log.consoleErrors, "console errors").toEqual([]);
});
