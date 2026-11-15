// The Lab workbench on a real prepared bundle (Barnard's Star): clicking a Gaia star opens its
// catalogue data, the analysis pane stays docked through zoom and pan, Esc clears it, the blink
// still cycles, and axe finds no serious problems. Set UI_REVIEW_DIR to save screenshots.
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { hideDevOverlay, watchPage } from "./helpers";

const OUT = process.env.UI_REVIEW_DIR;
const TARGET = "/explore?target=barnards-star";

async function shot(page: Page, name: string) {
  if (!OUT) return;
  await hideDevOverlay(page);
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
}

async function hasBundle(page: Page, slug: string) {
  const res = await page.request.get(`/bundles/${slug}/manifest.json`);
  return res.ok();
}

async function openTarget(page: Page) {
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem("pxh-lab-hint-seen", "1");
    } catch {
      // ignore
    }
  });
  await page.goto(TARGET);
  await expect(page.getByTestId("blink-player")).toHaveAttribute("data-ready", "true", { timeout: 60_000 });
}

/** Move the pointer outwards from the centre until the hover ring finds a Gaia star; click it. */
async function clickAStar(page: Page) {
  await expect(page.getByTestId("layer-gaia")).toContainText("stars ·", { timeout: 45_000 });
  const box = (await page.getByTestId("sky-viewer").boundingBox())!;
  for (let r = 60; r < 280; r += 12) {
    for (let a = 0; a < 360; a += 24) {
      const x = box.x + box.width / 2 + r * Math.cos((a * Math.PI) / 180);
      const y = box.y + box.height / 2 + r * Math.sin((a * Math.PI) / 180);
      await page.mouse.move(x, y);
      await page.waitForTimeout(30);
      if (await page.getByTestId("hover-marker").count()) {
        await page.mouse.click(x, y);
        return;
      }
    }
  }
  throw new Error("no Gaia star under the pointer");
}

test.describe.configure({ mode: "serial" });

test("clicking a star opens its Gaia DR3 and SIMBAD information", async ({ page }) => {
  test.skip(!(await hasBundle(page, "barnards-star")), "Barnard's Star bundle not built yet");
  test.setTimeout(240_000);
  const log = watchPage(page);
  await openTarget(page);
  const pane = page.getByTestId("detail-panel");
  await expect(pane.getByTestId("panel-title")).toHaveText("Barnard's Star");

  await clickAStar(page);
  const star = pane.getByTestId("star-details");
  await expect(star).toBeVisible();
  await expect(star.getByTestId("star-gaia")).toContainText("G magnitude");
  await expect(star).toHaveAttribute("data-source-id", /^\d{10,}$/);
  await expect(star.getByTestId("star-simbad")).not.toContainText("Loading", { timeout: 20_000 });
  await expect(star.getByTestId("star-spherex")).toContainText("In the loaded field");
  await page.waitForTimeout(1500);
  await shot(page, "lab-star-info-1440x900");

  expect(log.cdsRequests, "no requests to CDS").toEqual([]);
  expect(log.consoleErrors.filter((e) => !/Failed to load resource/.test(e)), "console errors").toEqual([]);
});

test("the analysis pane stays docked through zoom and pan, and Esc clears it", async ({ page }) => {
  test.skip(!(await hasBundle(page, "barnards-star")), "Barnard's Star bundle not built yet");
  test.setTimeout(240_000);
  await openTarget(page);
  // Hold the blink still: software WebGL redraws every frame, which slows pointer actions.
  await page.getByTestId("blink-play").click();
  const pane = page.getByTestId("detail-panel");
  await expect(pane.getByTestId("panel-title")).toHaveText("Barnard's Star");
  const before = (await pane.boundingBox())!;

  const box = (await page.getByTestId("sky-viewer").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 3; i++) {
    await page.mouse.wheel(0, -240);
    await page.waitForTimeout(150);
  }
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 140, box.y + box.height / 2 + 70, { steps: 4 });
  await page.mouse.up();
  // Wheel over the panes too: the page itself must never scroll.
  await page.mouse.move(before.x + 40, before.y + 40);
  await page.mouse.wheel(0, 600);
  await page.mouse.move(60, 600);
  await page.mouse.wheel(0, 600);
  await page.waitForTimeout(600);

  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await expect(pane.getByTestId("panel-title")).toHaveText("Barnard's Star");
  const after = (await pane.boundingBox())!;
  expect(Math.abs(after.y - before.y)).toBeLessThan(1);
  expect(Math.abs(after.x - before.x)).toBeLessThan(1);
  await expect(page.getByTestId("readout-fov")).not.toContainText("13′");
  await shot(page, "lab-panel-during-zoom-1440x900");

  await page.getByTestId("sky-viewer").focus();
  await page.keyboard.press("Escape");
  await expect(pane.getByTestId("target-details")).toHaveCount(0);
  await expect(pane.getByTestId("analysis-empty")).toBeVisible();
});

test("the blink still cycles, crossfades, and compares with a wipe", async ({ page }) => {
  test.skip(!(await hasBundle(page, "barnards-star")), "Barnard's Star bundle not built yet");
  test.setTimeout(240_000);
  await openTarget(page);
  const counter = page.getByTestId("frame-counter");
  const seen = new Set<string>();
  for (let i = 0; i < 40 && seen.size < 4; i++) {
    seen.add((await counter.textContent())?.trim() ?? "");
    await page.waitForTimeout(150);
  }
  expect(seen.size).toBe(4);

  await page.getByTestId("blink-style-fade").click();
  await expect(page.getByTestId("blink-style-fade")).toHaveAttribute("aria-checked", "true");
  seen.clear();
  for (let i = 0; i < 40 && seen.size < 3; i++) {
    seen.add((await counter.textContent())?.trim() ?? "");
    await page.waitForTimeout(150);
  }
  expect(seen.size).toBeGreaterThanOrEqual(3);

  await page.getByTestId("compare-wipe").click();
  await expect(page.getByTestId("blink-play")).toHaveAttribute("data-playing", "false");
  await expect(page.getByTestId("wipe-divider")).toBeVisible();
  await page.getByTestId("compare-off").click();
  await expect(page.getByTestId("wipe-divider")).toHaveCount(0);

  // The analysis tabs, the command palette and the shortcuts sheet.
  await page.getByTestId("analysis-tab-motion").click();
  await expect(page.getByTestId("motion-residuals")).toBeVisible();
  await page.getByTestId("analysis-tab-data").click();
  await expect(page.getByTestId("photometry-table")).toBeVisible();
  await page.keyboard.press("Control+k");
  await expect(page.getByTestId("command-palette")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByTestId("open-shortcuts").click();
  await expect(page.getByTestId("shortcuts-dialog")).toBeVisible();
  await page.keyboard.press("Escape");
});

test("the workbench has no serious or critical accessibility violations", async ({ page }) => {
  test.skip(!(await hasBundle(page, "barnards-star")), "Barnard's Star bundle not built yet");
  await openTarget(page);
  await page.getByTestId("blink-play").click();
  await expect(page.getByTestId("blink-play")).toHaveAttribute("data-playing", "false");
  await page.waitForTimeout(1000);
  await shot(page, "lab-target-bundle-1440x900");
  const results = await new AxeBuilder({ page }).exclude("[data-testid=sky-viewer] canvas").analyze();
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(" | ")}`)).toEqual([]);
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("one pane at a time, with Data, Viewer and Analysis tabs", async ({ page }) => {
    test.skip(!(await hasBundle(page, "barnards-star")), "Barnard's Star bundle not built yet");
    await openTarget(page);
    await expect(page.getByTestId("detail-panel")).toHaveCount(0);
    await page.waitForTimeout(1200);
    await shot(page, "lab-target-bundle-390x844");
    await page.getByTestId("open-details").click();
    const pane = page.getByTestId("detail-panel");
    await expect(pane.getByTestId("panel-title")).toHaveText("Barnard's Star");
    await page.waitForTimeout(600);
    await shot(page, "lab-analysis-390x844");
    await page.getByTestId("phone-tab-data").click();
    await expect(page.getByTestId("epoch-table")).toBeVisible();
    await page.waitForTimeout(400);
    await shot(page, "lab-data-390x844");
    await page.getByTestId("phone-tab-viewer").click();
    await page.getByTestId("open-details").click();
    await page.getByTestId("panel-close").click();
    await expect(pane).toHaveCount(0);
    const results = await new AxeBuilder({ page }).exclude("[data-testid=sky-viewer] canvas").analyze();
    const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(serious.map((v) => v.id)).toEqual([]);
  });
});
