// The home page story: the hero and its links, the pinned story on wide screens (WebGL globe,
// scenes in order, measured results, two ways in), the stacked story on phones, and the still story
// when motion is reduced. Run with its own output folder, e.g.
//   npx playwright test e2e/home.spec.ts --output=test-results/home
import { expect, test, type Page } from "@playwright/test";
import { watchPage } from "./helpers";

const BEATS = [
  "SPHEREx photographs the whole sky every six months.",
  "In 102 colours of infrared.",
  "Flip between visits, and nearby things jump.",
  "Subtract, and only change remains.",
  "Then measure it.",
];

/** Scrolls to a fraction of the page height and lets the story settle. */
async function scrollToFraction(page: Page, f: number) {
  await page.evaluate((v) => window.scrollTo(0, v * (document.documentElement.scrollHeight - innerHeight)), f);
  await page.waitForTimeout(700);
}

test.describe("wide screens", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("hero links, the pinned story in order, results and the two ways in", async ({ page }) => {
    const log = watchPage(page);
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Watch the sky move.");
    await expect(page.getByRole("link", { name: /Try Barnard.s Star/ })).toHaveAttribute("href", "/explore?target=barnards-star");
    await expect(page.getByRole("link", { name: "Explore the sky globe" })).toHaveAttribute("href", "/sky");

    const stage = page.locator('[data-story="stage"]');
    await expect(stage).toBeVisible();
    await expect(page.locator('[data-story="stack"]')).toBeHidden();
    // The WebGL globe takes over from the still image.
    await expect(stage.locator("[data-globe]")).toHaveAttribute("data-globe", "ready", { timeout: 30_000 });

    // Each beat's heading is in reading order and comes into view as the page scrolls.
    const headings = stage.getByRole("heading", { level: 2 });
    await expect(headings).toHaveText(BEATS);
    for (const [i, title] of BEATS.entries()) {
      const h = stage.getByRole("heading", { name: title });
      await h.scrollIntoViewIfNeeded();
      await page.waitForTimeout(500);
      await expect(h, `beat ${i + 1} is on screen`).toBeInViewport();
    }

    // The results carry their measured values, whatever the counters show.
    for (const spoken of ["10.55 arcseconds a year, plus or minus 0.12", "10.3 sigma", "0.86 magnitudes, plus or minus 0.04"]) {
      await expect(stage.getByText(spoken)).toHaveCount(1);
    }

    // The two ways in.
    const ways = page.locator("#two-ways-in");
    await expect(ways.getByRole("link", { name: "Open the sky globe" })).toHaveAttribute("href", "/sky");
    await expect(ways.getByRole("link", { name: "Open the Lab" })).toHaveAttribute("href", "/explore?target=barnards-star");
    await expect(ways.getByRole("link", { name: "what the search has found" })).toHaveAttribute("href", "/discoveries");
    await expect(ways.getByRole("link", { name: "how it works" })).toHaveAttribute("href", "/how-it-works");

    expect(log.consoleErrors, "no console errors").toEqual([]);
  });

  test("skip the story lands on the two ways in", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "skip the story" }).click();
    await expect(page.locator("#two-ways-in").getByRole("heading", { name: "Two ways in." })).toBeInViewport({ timeout: 10_000 });
  });

  test("the stage holds still between scroll steps and stays within the screen", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator('[data-story="stage"] [data-globe]')).toHaveAttribute("data-globe", "ready", { timeout: 30_000 });
    for (const f of [0.1, 0.3, 0.5, 0.7]) {
      await scrollToFraction(page, f);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      expect(overflow, `no sideways scroll at ${f}`).toBeLessThanOrEqual(0);
    }
  });

  test("explained words: only a few, and never on headings", async ({ page }) => {
    await page.goto("/");
    const words = page.locator('[data-story="stage"] [data-term], #two-ways-in [data-term]');
    expect(await words.count()).toBeLessThanOrEqual(4);
    await expect(page.locator("h1 [data-term], h2 [data-term], h3 [data-term]")).toHaveCount(0);
  });
});

test.describe("phones", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("the stacked story plays as it passes, with no pinning and no sideways scroll", async ({ page }) => {
    const log = watchPage(page);
    await page.goto("/");
    const stack = page.locator('[data-story="stack"]');
    await expect(stack).toBeVisible();
    await expect(page.locator('[data-story="stage"]')).toBeHidden();
    await expect(stack.getByRole("heading", { level: 2 })).toHaveText(BEATS);

    // The globe in the first scene starts once it is on screen.
    await stack.getByRole("heading", { name: BEATS[0] }).scrollIntoViewIfNeeded();
    await expect(stack.locator("[data-globe]")).toHaveAttribute("data-globe", "ready", { timeout: 30_000 });

    // Nothing is sticky: the stacked story never pins.
    const sticky = await stack.evaluate((el) => [...el.querySelectorAll("*")].filter((n) => getComputedStyle(n).position === "sticky").length);
    expect(sticky).toBe(0);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    expect(log.consoleErrors).toEqual([]);
  });
});

test.describe("reduced motion", () => {
  test.use({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });

  test("the story is still: stacked, no WebGL, final numbers", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator('[data-story="stack"]')).toBeVisible();
    await expect(page.locator('[data-story="stage"]')).toBeHidden();
    await page.waitForTimeout(800);
    await expect(page.locator("canvas")).toHaveCount(0);
    const stack = page.locator('[data-story="stack"]');
    await stack.getByRole("heading", { name: "Then measure it." }).scrollIntoViewIfNeeded();
    await expect(stack.getByText("10.55 arcseconds a year, plus or minus 0.12")).toHaveCount(1);
    await expect(stack.locator("number-flow-react").first()).toBeVisible();
  });
});
