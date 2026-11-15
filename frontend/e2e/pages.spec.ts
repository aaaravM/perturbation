// The long-form pages: How it works and About. Real data on the page (the Barnard's Star bundle,
// the validation table, the model results read at run time, with an honest fallback when they are
// missing), the folded "For scientists" layers, the blink, explained words within budget, no
// horizontal scroll on a phone, and no serious or critical axe violations.
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { hideDevOverlay, watchPage } from "./helpers";

const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const PHONE = { width: 390, height: 844 };

async function audit(page: Page, label: string) {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  const blocking = results.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => ({ rule: v.id, help: v.help, nodes: v.nodes.slice(0, 5).map((n) => n.target.join(" ")) }));
  expect(blocking, `${label}: serious or critical axe violations`).toEqual([]);
}

async function noSideScroll(page: Page) {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(over, "horizontal page scroll").toBeLessThanOrEqual(0);
}

/** Every figure entrance has finished: nothing waits hidden for a scroll. */
async function revealAll(page: Page) {
  await page.evaluate(async () => {
    for (let y = 0; y < document.documentElement.scrollHeight; y += Math.round(innerHeight * 0.6)) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 60));
    }
    window.scrollTo(0, 0);
  });
  await expect(page.locator('[data-reveal="hidden"]')).toHaveCount(0);
}

const STEPS = [
  "What SPHEREx sees",
  "From exposures to visits",
  "Blink and difference",
  "Measuring motion and brightness",
  "Spectra",
  "The automatic search",
  "Limits and honesty",
  "Data and code",
];

test.describe("How it works", () => {
  test("eight steps, each with a folded layer for scientists", async ({ page }) => {
    const log = watchPage(page);
    expect((await page.goto("/how-it-works"))?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("How it works");
    const main = page.getByRole("main");
    await expect(main.getByRole("heading", { level: 2 })).toHaveText(STEPS);

    const folds = main.locator("details");
    await expect(folds).toHaveCount(7); // steps 1 to 5, and one per model in step 6
    for (const d of await folds.all()) await expect(d).not.toHaveAttribute("open", "");
    const first = folds.first();
    await first.locator("summary").click();
    await expect(first).toHaveAttribute("open", "");
    await expect(first.getByRole("cell", { name: "128" })).toBeVisible(); // D6 resolving power
    await first.locator("summary").press("Enter");
    await expect(first).not.toHaveAttribute("open", "");

    await page.waitForTimeout(800);
    expect(log.badResponses, "HTTP errors").toEqual([]);
    expect(log.consoleErrors, "console errors").toEqual([]);
  });

  test("the timeline and the plots show Barnard's Star's real bundle", async ({ page }) => {
    const manifest = await (await page.request.get("/bundles/barnards-star/manifest.json")).json();
    await page.goto("/how-it-works");
    const visits = page.locator("#visits figure ol > li");
    await expect(visits).toHaveCount(manifest.epochs.length);
    for (const [i, e] of manifest.epochs.entries()) {
      await expect(visits.nth(i)).toContainText(e.label);
      await expect(visits.nth(i)).toContainText(`${e.n_exposures} exposure`);
      await expect(visits.nth(i)).toContainText(e.full ? "Full visit" : "Partial visit");
    }
    await expect(page.locator("#measure figure").first()).toContainText(
      `SPHEREx measures ${manifest.motion.fit.total_arcsec_yr.toFixed(2)} ± ${manifest.motion.fit.total_err.toFixed(2)}″ a year`,
    );
    const table = page.locator("#measure table");
    await expect(table.getByRole("row")).toHaveCount(8); // header and seven measurements
    await expect(table).toContainText("10.55 ± 0.12″ a year");
    await expect(table).toContainText("Does not agree");
    await expect(page.locator("#spectra svg[role=img]")).toBeVisible();
  });

  test("the blink flips between two real visits and can be paused", async ({ page }) => {
    await page.goto("/how-it-works");
    // Hydrated (the model results have loaded), so smooth scrolling has started and keeps our scroll.
    await expect(page.locator("#search").getByText("Reading the latest")).toHaveCount(0);
    await page.waitForTimeout(300);
    const fig = page.locator("#blink figure");
    await fig.scrollIntoViewIfNeeded();
    const label = fig.locator("[data-glass-surface]").first();
    const seen = new Set<string>();
    await expect
      .poll(
        async () => {
          seen.add((await label.textContent()) ?? "");
          return seen.size;
        },
        { timeout: 20_000, intervals: [200] },
      )
      .toBe(2);
    expect([...seen].sort()).toEqual(["Aug 2025", "Aug 2026"]);
    await fig.getByRole("button", { name: "Aug 2026" }).click();
    await expect(fig.getByRole("button", { name: "Blink" })).toHaveAttribute("aria-pressed", "false");
    await page.waitForTimeout(1200);
    await expect(label).toHaveText("Aug 2026");
    await expect(fig.locator("img")).toHaveCount(3);
    for (const img of await fig.locator("img").all()) {
      expect(await img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true);
    }
  });

  test("model results are read at run time, and say so when missing", async ({ page }) => {
    const movers = await (await page.request.get("/discoveries/candidates.json")).json();
    const spec = await (await page.request.get("/models/specclass.json")).json();
    await page.goto("/how-it-works");
    const search = page.locator("#search");
    await expect(search).toContainText(`${Math.round(movers.model.metrics.mover_completeness_shift_ge_1px_snr10 * 100)}%`);
    await expect(search).toContainText(`${Math.round(spec.test_accuracy * 100)}%`);
    await expect(search).toContainText(spec.n_test.toLocaleString("en-GB"));
    await expect(search.getByText("Being measured")).toHaveCount(0);

    await page.route("**/discoveries/candidates.json", (r) => r.fulfill({ status: 404, body: "" }));
    await page.route("**/models/specclass.json", (r) => r.fulfill({ status: 404, body: "" }));
    await page.reload();
    await expect(search.getByRole("status")).toHaveCount(2);
    await expect(search.getByRole("status").first()).toContainText("Being measured");
  });

  test("explained words stay few, and never on headings, links or buttons", async ({ page }) => {
    await page.goto("/how-it-works");
    const keys = await page.locator("main [data-term]").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.term));
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.length).toBeLessThanOrEqual(6);
    expect(new Set(keys).size, "each word explained once").toBe(keys.length);
    await expect(page.locator("main :is(h1, h2, h3, a, button, summary) [data-term]")).toHaveCount(0);
  });

  test("reduced motion: everything is in place and the blink waits", async ({ browser }) => {
    const ctx = await browser.newContext({ reducedMotion: "reduce", viewport: PHONE });
    const page = await ctx.newPage();
    await page.goto("/how-it-works");
    await expect(page.locator("#search").getByText("Reading the latest")).toHaveCount(0);
    await expect(page.locator("[data-reveal]").first()).toBeAttached();
    await expect(page.locator('[data-reveal="hidden"]')).toHaveCount(0);
    const fig = page.locator("#blink figure");
    await fig.scrollIntoViewIfNeeded();
    const label = fig.locator("[data-glass-surface]").first();
    await expect(label).toHaveText("Aug 2025");
    await page.waitForTimeout(2000);
    await expect(label).toHaveText("Aug 2025");
    await noSideScroll(page);
    await ctx.close();
  });

  for (const vp of [
    { name: "desktop", width: 1440, height: 900 },
    { name: "phone", ...PHONE },
  ]) {
    test(`no serious or critical axe violations, folds open (${vp.name})`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto("/how-it-works");
      await hideDevOverlay(page);
      await expect(page.locator("#search").getByText("Reading the latest")).toHaveCount(0);
      await revealAll(page);
      await noSideScroll(page);
      for (const d of await page.locator("main details").all()) await d.evaluate((el) => el.setAttribute("open", ""));
      await page.waitForTimeout(400);
      await noSideScroll(page);
      await audit(page, `/how-it-works ${vp.name}`);
    });
  }
});

test.describe("About", () => {
  test("the project, the challenge, the team, credits, citation and contact", async ({ page }) => {
    const log = watchPage(page);
    expect((await page.goto("/about"))?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("About Planet X Hunter");
    const main = page.getByRole("main");
    await expect(main.getByRole("heading", { level: 2 })).toHaveText([
      "The project in plain words",
      "The challenge",
      "The team",
      "Data credits and licences",
      "How to cite the data",
      "Source and contact",
    ]);
    await expect(main).toContainText("Planet X and SPHEREx");
    await expect(main).toContainText("Ninth Vanguard");
    await expect(main).toContainText("doi:10.26131/IRSA678");
    await expect(main).toContainText("doi:10.26131/IRSA679");
    await expect(main.getByRole("link", { name: "open an issue on GitHub" })).toHaveAttribute(
      "href",
      "https://github.com/aaaravM/planet-x-hunter/issues",
    );
    await expect(main.getByRole("link", { name: "github.com/aaaravM/planet-x-hunter" })).toHaveAttribute(
      "href",
      "https://github.com/aaaravM/planet-x-hunter",
    );
    await page.waitForTimeout(800);
    expect(log.badResponses, "HTTP errors").toEqual([]);
    expect(log.consoleErrors, "console errors").toEqual([]);
  });

  test("a link to a section lands on it, loaded directly or from How it works", async ({ page }) => {
    const citeTop = () => page.locator("#cite").evaluate((el) => Math.round(el.getBoundingClientRect().top));
    await page.goto("/about#cite");
    await expect(page.locator('#cite[data-reveal="shown"]')).toBeAttached(); // hydrated, smooth scrolling started
    await page.waitForTimeout(300);
    expect(await citeTop()).toBeGreaterThanOrEqual(0);
    expect(await citeTop()).toBeLessThan(200);

    await page.goto("/how-it-works");
    await expect(page.locator("#search").getByText("Reading the latest")).toHaveCount(0);
    await page.getByRole("link", { name: "About this project" }).click();
    await page.waitForURL("**/about#cite");
    await expect(page.locator('#cite[data-reveal="shown"]')).toBeAttached();
    await page.waitForTimeout(300);
    expect(await citeTop()).toBeLessThan(200);
  });

  test("the citation copies", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("/about");
    const cite = page.locator("#cite");
    await cite.getByRole("button", { name: "Copy citation" }).click();
    await expect(cite.getByRole("button", { name: "Copied" })).toBeVisible();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toContain("Team Ninth Vanguard (2026). Planet X Hunter");
    expect(copied).toContain("https://planet-x-hunter.vercel.app");
  });

  for (const vp of [
    { name: "desktop", width: 1440, height: 900 },
    { name: "phone", ...PHONE },
  ]) {
    test(`no serious or critical axe violations (${vp.name})`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto("/about");
      await hideDevOverlay(page);
      await revealAll(page);
      await noSideScroll(page);
      await audit(page, `/about ${vp.name}`);
    });
  }
});
