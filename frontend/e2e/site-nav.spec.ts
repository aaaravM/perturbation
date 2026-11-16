// The top bar, the phone menu and the footer: Sky and Lab, then Planet X, AI, How it works and
// About, and Settings last. From 768 px every link shows in the bar, on one row and unwrapped; below
// that they are in the menu. No page links to the retired Discoveries and Help the search pages.
import { expect, test, type Page } from "@playwright/test";
import { DESKTOP_LAYOUT, watchPage } from "./helpers";

const PAGES = ["Sky", "Lab", "Planet X", "AI", "How it works", "About", "Settings"];
const PHONE = { width: 390, height: 844 };

/** The bar's visible links, in order: name, box, and whether the label is cut or wrapped. */
function barLinks(page: Page) {
  return page.evaluate(() => {
    const nav = document.querySelector<HTMLElement>('nav[aria-label="Main"]')!;
    const box = nav.getBoundingClientRect();
    const links = [...nav.querySelectorAll<HTMLAnchorElement>("a")]
      .filter((a) => a.getClientRects().length > 0 && a.getBoundingClientRect().width > 0)
      .map((a) => {
        const r = a.getBoundingClientRect();
        return {
          name: (a.getAttribute("aria-label") ?? a.textContent ?? "").trim(),
          left: r.left,
          right: r.right,
          middle: r.top + r.height / 2,
          cut: a.scrollWidth > a.clientWidth + 1 || a.scrollHeight > a.clientHeight + 1,
        };
      });
    return { left: box.left, right: box.right, links };
  });
}

async function noSideScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, "no sideways scroll").toBeLessThanOrEqual(1);
}

const CASES = [
  ...[768, 900, 1024, 1280, 1440].map((width) => ({ width, path: "/about" })),
  // The Sky globe docks the bar to the top edge; the narrowest width is the one to check.
  { width: 768, path: "/sky" },
];

for (const { width, path } of CASES) {
  test(`at ${width} px the bar on ${path} shows every page on one row`, async ({ page, isMobile }) => {
    test.skip(isMobile, DESKTOP_LAYOUT);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(path);
    await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "About", exact: true })).toBeVisible();
    const bar = await barLinks(page);
    expect(bar.links.map((l) => l.name)).toEqual(["Perturbation", ...PAGES]);
    for (const l of bar.links) {
      expect(l.cut, `${l.name} is not cut or wrapped`).toBe(false);
      expect(Math.abs(l.middle - bar.links[0].middle), `${l.name} on the bar's row`).toBeLessThan(3);
      expect(l.left, `${l.name} inside the bar`).toBeGreaterThanOrEqual(bar.left - 0.5);
      expect(l.right, `${l.name} inside the bar`).toBeLessThanOrEqual(bar.right + 0.5);
    }
    // In order from left to right, without overlapping (Sky and Lab share an edge in the switch).
    for (let i = 1; i < bar.links.length; i++) {
      const [before, link] = [bar.links[i - 1], bar.links[i]];
      expect(link.left, `${link.name} after ${before.name}`).toBeGreaterThanOrEqual(before.right - 0.5);
    }
    await expect(page.getByRole("button", { name: "Open menu" })).toBeHidden();
    await noSideScroll(page);
  });
}

test("on a phone the menu holds every page, Settings last", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: PHONE, hasTouch: true });
  const page = await ctx.newPage();
  await page.goto("/about");
  const bar = page.getByRole("navigation", { name: "Main" });
  await expect(bar.getByRole("link", { name: "Planet X" })).toBeHidden();
  await expect(bar.getByRole("link", { name: "Sky", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Open menu" }).click();
  const menu = page.getByRole("dialog");
  await expect(menu.getByRole("link")).toHaveText(PAGES);
  await expect(menu.getByRole("link", { name: "AI", exact: true })).toHaveAttribute("href", "/ai");
  await noSideScroll(page);
  await ctx.close();
});

test("the footer lists the same pages", async ({ page }) => {
  await page.goto("/about");
  const footer = page.getByRole("navigation", { name: "Footer" });
  await expect(footer.getByRole("link")).toHaveText(PAGES);
});

test("no page links to Discoveries or Help the search", async ({ page }) => {
  test.setTimeout(180_000);
  const log = watchPage(page);
  for (const path of ["/", "/planet-x", "/ai", "/how-it-works", "/about", "/settings"]) {
    log.consoleErrors.length = 0;
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    // Everything the page loads is in (the AI page's finds, say), and leaving it cancels nothing.
    await page.waitForLoadState("networkidle");
    await expect(page.locator("a[href^='/discoveries'], a[href^='/help']"), path).toHaveCount(0);
    await expect(page.locator("body"), path).not.toContainText(/Help the search|Discoveries page/, { useInnerText: true });
    expect(log.consoleErrors, `${path}: console errors`).toEqual([]);
  }
});
