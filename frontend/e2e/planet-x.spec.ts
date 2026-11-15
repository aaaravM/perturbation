// The Planet X page: Pluto in SPHEREx images, read from the prepared bundle
// (public/planet-x/pluto.json). Its numbers on the page, every image loaded, the blink that cycles
// through real frames and pauses, the frames side by side with reduced motion, explained words
// within budget, no horizontal scroll on a phone, and no serious or critical axe violations.
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { FIREFOX_DEV_AXE, firefoxOnDevServer, hideDevOverlay, watchPage } from "./helpers";

const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const PHONE = { width: 390, height: 844 };

const SECTIONS = [
  "Pluto was the first Planet X",
  "Pluto in SPHEREx",
  "Its infrared spectrum",
  "Stacking along an orbit",
  "Could SPHEREx find a new Planet X?",
  "Data and references",
];

async function noSideScroll(page: Page) {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(over, "horizontal page scroll").toBeLessThanOrEqual(0);
}

/** Hydrated (the server renders every entrance "idle"), then every entrance has run. */
async function revealAll(page: Page) {
  await expect(page.locator('[data-reveal="idle"]')).toHaveCount(0);
  await page.evaluate(async () => {
    for (let y = 0; y < document.documentElement.scrollHeight; y += Math.round(innerHeight * 0.6)) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 60));
    }
    window.scrollTo(0, 0);
  });
  await expect(page.locator('[data-reveal="hidden"]')).toHaveCount(0);
}

async function imagesLoaded(page: Page, selector: string) {
  const imgs = page.locator(`${selector} img`);
  expect(await imgs.count()).toBeGreaterThan(0);
  for (const img of await imgs.all()) {
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true);
  }
}

test("six sections with the bundle's numbers, its images and its spectrum", async ({ page }) => {
  const bundle = await (await page.request.get("/planet-x/pluto.json")).json();
  const log = watchPage(page);
  expect((await page.goto("/planet-x"))?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("The first Planet X");
  const main = page.getByRole("main");
  await expect(main.getByRole("heading", { level: 2 })).toHaveText(SECTIONS);

  await expect(main.locator("header")).toContainText(`${bundle.summary.n_images} SPHEREx images`);
  await expect(page.locator("#spherex")).toContainText(`checked ${bundle.provenance.n_observations_scanned.toLocaleString("en-US")}`);
  await expect(page.locator("#spherex")).toContainText(`In the ${bundle.astrometry.n} best measurements`);
  const depths = bundle.spectrum.bands.map((b: { depth: number }) => `${Math.round(b.depth * 100)}%`);
  for (const d of depths) await expect(page.locator("#spectrum svg[role=img]")).toContainText(d);
  await expect(page.locator("#spectrum svg[role=img] circle")).toHaveCount(bundle.spectrum.points.length);
  await expect(page.locator("#stacking")).toContainText(`S/N ${bundle.shift_and_stack_faint.snr_stack.toFixed(1)}`);
  await expect(page.locator("#new")).toContainText("14 to 21 times too faint");
  // Motion within a week-long visit, modelled over the Pluto images' solar elongations: up to several pixels.
  const week = bundle.planet_x_geometry.cases[0].within_visit_arcsec["7_days"].map(Math.round);
  await expect(page.locator("#new")).toContainText(`moves ${week[0]} to ${week[1]} arcseconds`);
  await expect(page.locator("#new")).toContainText(`${week[0]}–${week[1]}″`);

  await imagesLoaded(page, "[data-testid=pluto-blink]");
  await imagesLoaded(page, "[data-testid=stack-figure]");
  await expect(page.locator("main a[href='/explore?target=wise-0855']")).toBeVisible();

  await page.waitForTimeout(800);
  expect(log.badResponses, "HTTP errors").toEqual([]);
  expect(log.consoleErrors, "console errors").toEqual([]);
});

test("the blink cycles through real frames, pauses and hides JPL's ring", async ({ page }) => {
  await page.goto("/planet-x");
  await expect(page.locator('[data-reveal="idle"]')).toHaveCount(0);
  await page.waitForTimeout(300);
  const fig = page.getByTestId("pluto-blink");
  await fig.scrollIntoViewIfNeeded();
  await expect(fig).toHaveAttribute("data-view", "blink");
  const label = page.getByTestId("blink-tracked").locator("[data-glass-surface]");
  const seen = new Set<string>();
  await expect
    .poll(
      async () => {
        seen.add((await label.textContent()) ?? "");
        return seen.size;
      },
      { timeout: 20_000, intervals: [150] },
    )
    .toBeGreaterThanOrEqual(3);

  await fig.getByRole("button", { name: "Pause" }).click();
  await expect(fig).toHaveAttribute("data-playing", "false");
  const held = await label.textContent();
  await page.waitForTimeout(2000);
  await expect(label).toHaveText(held ?? "");
  await expect(fig.getByRole("button", { name: "Play" })).toBeVisible();

  await expect(fig.locator("[data-ring]")).toHaveCount(2);
  await fig.getByRole("button", { name: "JPL’s prediction" }).click();
  await expect(fig.locator("[data-ring]")).toHaveCount(0);
  await expect(fig.getByRole("button", { name: "JPL’s prediction" })).toHaveAttribute("aria-pressed", "false");

  await fig.getByRole("button", { name: "Side by side" }).click();
  await expect(fig).toHaveAttribute("data-view", "strip");
  await expect(fig.getByTestId("strip-sky-fixed").locator("img")).toHaveCount(3);
  await expect(fig.getByTestId("strip-tracked").locator("img")).toHaveCount(6);
});

test("reduced motion: the frames start side by side and everything is in place", async ({ browser }) => {
  const ctx = await browser.newContext({ reducedMotion: "reduce", viewport: PHONE });
  const page = await ctx.newPage();
  await page.goto("/planet-x");
  await expect(page.locator("[data-reveal]").first()).toBeAttached();
  await expect(page.locator('[data-reveal="hidden"]')).toHaveCount(0);
  const fig = page.getByTestId("pluto-blink");
  await expect(fig).toHaveAttribute("data-view", "strip");
  await expect(fig).toHaveAttribute("data-playing", "false");
  await expect(fig.getByTestId("strip-sky-fixed").locator("img")).toHaveCount(3);
  await expect(fig.getByTestId("strip-tracked").locator("img")).toHaveCount(6);
  await fig.scrollIntoViewIfNeeded();
  await imagesLoaded(page, "[data-testid=pluto-blink]");
  // Asking for the blink plays it.
  await fig.getByRole("button", { name: "Blink", exact: true }).click();
  await expect(fig).toHaveAttribute("data-playing", "true");
  await noSideScroll(page);
  await ctx.close();
});

test("explained words stay few, and never on headings, links or buttons", async ({ page }) => {
  await page.goto("/planet-x");
  const keys = await page.locator("main [data-term]").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.term));
  expect(keys.length).toBeGreaterThan(0);
  expect(keys.length).toBeLessThanOrEqual(3);
  expect(new Set(keys).size, "each word explained once").toBe(keys.length);
  await expect(page.locator("main :is(h1, h2, h3, a, button, summary) [data-term]")).toHaveCount(0);
});

for (const vp of [
  { name: "desktop", width: 1440, height: 900 },
  { name: "phone", ...PHONE },
]) {
  test(`no serious or critical axe violations, folds open (${vp.name})`, async ({ page, isMobile, browserName }) => {
    test.skip(isMobile && vp.name === "desktop", "drives the desktop layout; the phone test covers phones");
    test.skip(firefoxOnDevServer(browserName), FIREFOX_DEV_AXE);
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.goto("/planet-x");
    await hideDevOverlay(page);
    await revealAll(page);
    await noSideScroll(page);
    for (const d of await page.locator("main details").all()) await d.evaluate((el) => el.setAttribute("open", ""));
    await page.waitForTimeout(400);
    await noSideScroll(page);
    const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
    const blocking = results.violations
      .filter((v) => v.impact === "serious" || v.impact === "critical")
      .map((v) => ({ rule: v.id, help: v.help, nodes: v.nodes.slice(0, 5).map((n) => n.target.join(" ")) }));
    expect(blocking, `/planet-x ${vp.name}: serious or critical axe violations`).toEqual([]);
  });
}
