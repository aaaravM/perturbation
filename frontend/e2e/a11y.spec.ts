// Accessibility. axe-core (WCAG 2.x A and AA rules) must find no serious or critical violations
// on the landing page, Sky mode with and without its panel, and the Lab with a panel open, at
// desktop and phone sizes. Keyboard focus order and reduced motion are checked by hand below.
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

async function audit(page: Page, label: string) {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  const blocking = results.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => ({
      rule: v.id,
      impact: v.impact,
      help: v.help,
      nodes: v.nodes.slice(0, 6).map((n) => `${n.target.join(" ")}: ${n.failureSummary?.split("\n").slice(1).join(" ").trim()}`),
    }));
  expect(blocking, `${label}: serious or critical axe violations`).toEqual([]);
}

async function hasBundle(page: Page, slug: string) {
  return (await page.request.get(`/bundles/${slug}/manifest.json`)).status() === 200;
}

test.describe.configure({ mode: "serial" });

for (const vp of [
  { name: "desktop", width: 1440, height: 900 },
  { name: "phone", width: 390, height: 844 },
] as const) {
  test.describe(vp.name, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test(`/ has no serious or critical violations (${vp.name})`, async ({ page }) => {
      await page.goto("/");
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Perturbation");
      await page.waitForTimeout(1500); // the globe has taken over from its still
      await audit(page, `/ ${vp.name}`);
    });

    test(`/sky has no serious or critical violations (${vp.name})`, async ({ page }) => {
      await page.goto("/sky");
      await expect(page.getByTestId("sky-globe")).toHaveAttribute("data-texture", "ready", { timeout: 30_000 });
      await page.waitForTimeout(1200);
      await audit(page, `/sky ${vp.name}`);

      // With Barnard's Star's panel open. On phones the star lists fold away under "Browse stars".
      const browse = page.getByRole("button", { name: "Browse stars" });
      if (await browse.isVisible()) await browse.click();
      await page.getByTestId("target-list").getByRole("button", { name: /Barnard.s Star/ }).click();
      const panel = page.getByTestId("sky-panel");
      await expect(panel.getByRole("heading", { level: 2 })).toHaveText("Barnard's Star");
      await expect(panel.getByTestId("mini-blink").or(panel.getByTestId("bundle-missing"))).toBeVisible({
        timeout: 30_000,
      });
      // Hold the blink still while axe reads the page (see the Lab test below).
      const pause = panel.getByRole("button", { name: "Pause" });
      if (await pause.isVisible()) await pause.click();
      await page.waitForTimeout(900);
      await audit(page, `/sky?target=barnards-star ${vp.name}`);

      // The layers popover.
      if (vp.name === "desktop") {
        await page.getByRole("button", { name: "Layers" }).click();
        await expect(page.getByTestId("layers-panel")).toBeVisible();
        await audit(page, `/sky layers ${vp.name}`);
      }
    });

    test(`/explore with a panel open has no serious or critical violations (${vp.name})`, async ({ page }) => {
      test.skip(!(await hasBundle(page, "barnards-star")), "Barnard's Star bundle not built yet");
      await page.goto("/explore?target=barnards-star");
      await expect(page.getByTestId("blink-player")).toHaveAttribute("data-ready", "true", { timeout: 45_000 });
      // Pause the blink first: axe is far slower on a page whose DOM changes twice a second (and on
      // phones the analysis pane, once open, covers the player).
      await page.getByTestId("blink-play").click();
      await expect(page.getByTestId("blink-play")).toHaveAttribute("data-playing", "false");
      if (vp.name === "phone") await page.getByTestId("open-details").click();
      await expect(page.getByTestId("detail-panel").getByTestId("panel-title")).toHaveText("Barnard's Star");
      await page.waitForTimeout(1200);
      await audit(page, `/explore?target=barnards-star ${vp.name}`);

      // A clicked position's panel.
      await page.goto("/explore?ra=83.8221&dec=-5.3911&fov=1.5");
      await expect(page.getByTestId("sky-status")).toHaveAttribute("data-state", "ready", { timeout: 30_000 });
      const viewer = page.getByTestId("sky-viewer");
      const box = await viewer.boundingBox();
      if (!box) throw new Error("no sky viewer");
      await page.mouse.click(box.x + box.width * 0.62, box.y + box.height * 0.4);
      if (vp.name === "phone") {
        // Phones show a small card over the viewer; Details opens the analysis pane.
        const details = page.getByTestId("open-details");
        await details.waitFor({ timeout: 10_000 }).catch(() => {});
        if (await details.isVisible()) await details.click();
      }
      await expect(page.getByTestId("position-details")).toBeVisible();
      await page.waitForTimeout(900);
      await audit(page, `/explore position panel ${vp.name}`);
    });
  });
}

test("keyboard: the skip order reaches the Sky controls and the panel in a sensible order", async ({ page }) => {
  await page.goto("/sky");
  await expect(page.getByTestId("sky-globe")).toHaveAttribute("data-texture", "ready", { timeout: 30_000 });
  // Nav first, then the rail (intro links, search, list tabs, the objects), then the globe and its
  // controls.
  const order: string[] = [];
  for (let i = 0; i < 30; i++) {
    await page.keyboard.press("Tab");
    order.push(
      await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el) return "";
        return (el.getAttribute("aria-label") || el.textContent || el.tagName).trim().slice(0, 40);
      }),
    );
  }
  const firstObject = order.findIndex((t) => /Barnard/.test(t));
  const globe = order.findIndex((t) => /Globe of the whole sky/.test(t));
  const zoomIn = order.findIndex((t) => t === "Zoom in");
  expect(firstObject, order.join(" | ")).toBeGreaterThan(0);
  expect(globe, order.join(" | ")).toBeGreaterThan(firstObject);
  expect(zoomIn, order.join(" | ")).toBeGreaterThan(globe);

  // Enter on a list item opens the panel and moves focus to its heading; Escape returns it.
  await page.getByTestId("target-list").getByRole("button", { name: /Epsilon Indi B/ }).focus();
  await page.keyboard.press("Enter");
  const heading = page.getByTestId("sky-panel").getByRole("heading", { level: 2 });
  await expect(heading).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("sky-panel").locator(":focus")).toHaveCount(1);
  // If focus landed on an explained word, its explanation is open: Escape closes that first.
  const tip = page.locator("[data-slot=tooltip-content]");
  if (await tip.count()) {
    await page.keyboard.press("Escape");
    await expect(tip).toHaveCount(0);
  }
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("target-list").getByRole("button", { name: /Epsilon Indi B/ })).toBeFocused();
});

test.describe("reduced motion", () => {
  test.use({ reducedMotion: "reduce" });

  test("the Lab blink waits for Play, and the globe holds still", async ({ page }) => {
    test.skip(!(await hasBundle(page, "barnards-star")), "Barnard's Star bundle not built yet");
    await page.goto("/explore?target=barnards-star");
    await expect(page.getByTestId("blink-player")).toHaveAttribute("data-ready", "true", { timeout: 45_000 });
    await expect(page.getByTestId("blink-play")).toHaveAttribute("data-playing", "false");
    const counter = page.getByTestId("frame-counter");
    const before = await counter.textContent();
    await page.waitForTimeout(2500);
    await expect(counter).toHaveText(before ?? "");

    await page.goto("/sky");
    const globe = page.getByTestId("sky-globe");
    await expect(globe).toHaveAttribute("data-texture", "ready", { timeout: 30_000 });
    await page.waitForTimeout(1500);
    // The "Centre" readout follows the camera; with reduced motion there is no drift to follow.
    const centre = page.locator("p", { hasText: /^Centre/ }).locator(".readout");
    await expect(centre).not.toHaveText("");
    const a = await centre.textContent();
    await page.waitForTimeout(2500);
    expect(await centre.textContent()).toBe(a);
  });
});
