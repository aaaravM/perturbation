// The guided tours of the Sky globe and the Lab: started from the Tour button and from a tour=1
// link, every step in order, the pointer moving and the controls really changing (the globe
// turns, Sirius opens, 3D space, Barnard's Star in focus; in the Lab the Difference mode and the
// Spectrum tab), Back, Esc returning focus to the Tour button, the once-only first-visit offer,
// reduced motion (no glide), the phone sheet, and axe with a tour open. Set UI_REVIEW_DIR to save
// a screenshot of every step.
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { DESKTOP_LAYOUT, FIREFOX_DEV_AXE, firefoxOnDevServer, hideDevOverlay } from "./helpers";

const OUT = process.env.UI_REVIEW_DIR;
const SKY_STEPS = ["globe", "turn", "search", "panel", "lists", "layers", "space", "focus", "lab"];
const LAB_STEPS = ["lab", "field", "fov", "blink", "visits", "detectors", "difference", "motion", "spectrum", "overlays", "share"];

const tour = (page: Page) => page.getByTestId("tour");
const card = (page: Page) => page.getByTestId("tour-card");

async function shot(page: Page, name: string) {
  if (!OUT) return;
  await hideDevOverlay(page);
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
}

/** No first-visit offers or tips, so a test sees only what it starts. */
async function quiet(page: Page) {
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem("pxh-tour-seen", "sky,lab");
      window.localStorage.setItem("pxh-lab-hint-seen", "1");
    } catch {
      // ignore
    }
  });
}

/** The step has arrived and its pointer has finished. */
async function settled(page: Page, step: string) {
  await expect(tour(page)).toHaveAttribute("data-step", step, { timeout: 30_000 });
  await expect(tour(page)).toHaveAttribute("data-busy", "false", { timeout: 60_000 });
}

async function next(page: Page) {
  await card(page).getByTestId("tour-next").click();
}

async function openSky(page: Page) {
  await page.goto("/sky");
  // The dev server's indicator sits in the bottom left corner, over the Sky's Tour button on phones.
  await hideDevOverlay(page);
  await expect(page.getByTestId("sky-globe")).toBeVisible({ timeout: 60_000 });
  await expect.poll(async () => Number(await page.getByTestId("sky-globe").getAttribute("data-stars")), { timeout: 60_000 }).toBeGreaterThan(0);
}

async function openLab(page: Page, url = "/explore?target=barnards-star") {
  await page.goto(url);
  await hideDevOverlay(page);
  await expect(page.getByTestId("blink-player")).toHaveAttribute("data-ready", "true", { timeout: 60_000 });
}

const cursorAt = (page: Page) => page.getByTestId("tour-cursor").evaluate((el) => (el as HTMLElement).style.transform);

/** Right ascension at the centre of the globe, from the view controls' readout. */
const centreRa = (page: Page) =>
  page.evaluate(() => {
    const m = /RA\s+(-?[\d.]+)/.exec(document.querySelector("[data-tour=sky-controls] .readout")?.textContent ?? "");
    return m ? Number(m[1]) : NaN;
  });

test.describe.configure({ mode: "serial" });

// In a phone profile only the "phone" tests run: the others drive the desktop layout.
test.beforeEach(({ isMobile }, testInfo) => {
  test.skip(isMobile && !testInfo.titlePath.includes("phone"), DESKTOP_LAYOUT);
});

test("Sky tour from the Tour button: every step, the pointer turns the globe and the controls really change", async ({ page }) => {
  test.setTimeout(240_000);
  await quiet(page);
  await openSky(page);
  const button = page.locator("[data-tour-button=sky]");
  await button.click();
  await expect(card(page)).toBeVisible();
  await expect(card(page)).toBeFocused();
  await expect(page.getByTestId("tour-count")).toHaveText("1 of 9");

  for (const [i, step] of SKY_STEPS.entries()) {
    if (step === "turn") {
      const before = await centreRa(page);
      await settled(page, step);
      // The pointer moved off its starting place, and its drag turned the sky by tens of degrees
      // (the idle drift is 1.2° a second).
      expect(await cursorAt(page)).not.toContain("-100px");
      const turned = Math.abs(((await centreRa(page)) - before + 540) % 360 - 180);
      expect(turned).toBeGreaterThan(10);
    } else {
      await settled(page, step);
    }
    await expect(page.getByTestId("tour-count")).toHaveText(`${i + 1} of 9`);
    await expect(card(page).getByTestId("tour-defs")).toBeVisible();
    if (step === "search") await expect(page).toHaveURL(/star=32349/);
    if (step === "panel") await expect(page.getByTestId("star-story")).toBeVisible();
    if (step === "lists") {
      await expect(page.getByTestId("rail-tab-fastest")).toHaveAttribute("aria-selected", "true");
      // Back to the panel, and on again.
      await card(page).getByTestId("tour-back").click();
      await settled(page, "panel");
      await next(page);
      await settled(page, "lists");
    }
    if (step === "layers") await expect(page.getByTestId("layer-spherex")).toHaveCount(0); // the menu closed again
    if (step === "space") {
      await expect(page.getByTestId("mode-space")).toHaveAttribute("aria-checked", "true");
      await expect(page).toHaveURL(/mode=3d/);
    }
    if (step === "focus") {
      await expect(page).toHaveURL(/target=barnards-star/);
      await expect(page.getByTestId("target-story")).toHaveAttribute("data-slug", "barnards-star");
    }
    await shot(page, `tour-sky-${String(i + 1).padStart(2, "0")}-${step}`);
    if (i < SKY_STEPS.length - 1) await next(page);
  }
  await expect(card(page).getByTestId("tour-next-tour")).toHaveAttribute("href", "/explore?target=barnards-star&tour=1");
  await card(page).getByTestId("tour-finish").click();
  await expect(tour(page)).toHaveCount(0);
  await expect(button).toBeFocused();
});

test("Lab tour from a tour=1 link: every step; Difference and the Spectrum tab really change; finishing puts the Lab back", async ({ page }) => {
  test.setTimeout(300_000);
  await quiet(page);
  await openLab(page, "/explore?target=barnards-star&tour=1");
  await expect(card(page)).toBeVisible();
  await expect(page).not.toHaveURL(/tour=1/);
  for (const [i, step] of LAB_STEPS.entries()) {
    await settled(page, step);
    await expect(page.getByTestId("tour-count")).toHaveText(`${i + 1} of ${LAB_STEPS.length}`);
    if (step === "field") await expect(page.getByTestId("lab-search-status")).toContainText("Featured target");
    if (step === "difference") {
      await expect(page.getByTestId("mode-difference")).toHaveAttribute("aria-selected", "true");
      await expect(page.getByTestId("blink-player")).toHaveAttribute("data-mode", "difference");
    }
    if (step === "motion") await expect(page.getByTestId("analysis-tab-motion")).toHaveAttribute("aria-selected", "true");
    if (step === "spectrum") await expect(page.getByTestId("analysis-tab-spectrum")).toHaveAttribute("aria-selected", "true");
    if (step === "overlays") await expect(page.getByTestId("layer-toggle-wise")).toHaveAttribute("aria-checked", "true");
    await shot(page, `tour-lab-${String(i + 1).padStart(2, "0")}-${step}`);
    if (i < LAB_STEPS.length - 1) await next(page);
  }
  await expect(card(page).getByTestId("tour-next")).toHaveText("Finish");
  await next(page);
  await expect(tour(page)).toHaveCount(0);
  // The Lab is back as it was: blinking epochs, no WISE layer.
  await expect(page.getByTestId("blink-player")).toHaveAttribute("data-mode", "epochs");
  await expect(page.getByTestId("layer-toggle-wise")).toHaveAttribute("aria-checked", "false");
  await expect(page).not.toHaveURL(/mode=difference|wise/);
  await expect(page.locator("[data-tour-button=lab]")).toBeFocused();
});

test("Lab tour on another field offers Barnard's Star first; Esc closes and returns focus to the Tour button", async ({ page }) => {
  test.setTimeout(180_000);
  await quiet(page);
  await openLab(page, "/explore?target=r-dra");
  const button = page.locator("[data-tour-button=lab]");
  await button.click();
  await expect(tour(page)).toHaveAttribute("data-step", "switch");
  await expect(card(page)).toContainText("Barnard's Star");
  await card(page).getByTestId("tour-yes").click();
  await settled(page, "lab");
  await expect(page).toHaveURL(/target=barnards-star/);
  await expect(page.getByTestId("tour-count")).toHaveText(`1 of ${LAB_STEPS.length}`);
  await next(page);
  await settled(page, "field");
  await page.keyboard.press("Escape");
  await expect(tour(page)).toHaveCount(0);
  await expect(button).toBeFocused();
});

test("keyboard: Enter and the arrow keys move through the tour", async ({ page }) => {
  await quiet(page);
  await openSky(page);
  await page.locator("[data-tour-button=sky]").click();
  await settled(page, "globe");
  await expect(card(page)).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await settled(page, "turn");
  await page.keyboard.press("ArrowLeft");
  await settled(page, "globe");
  await page.keyboard.press("Enter");
  await settled(page, "turn");
  await expect(card(page)).toBeFocused();
  await expect(page.getByTestId("tour-announce")).toHaveText("Step 2 of 9: Turn and zoom.");
  await page.keyboard.press("Escape");
  await expect(tour(page)).toHaveCount(0);
});

test("first visit: the offer appears once, and Not now dismisses it for good", async ({ page }) => {
  test.setTimeout(180_000);
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem("pxh-lab-hint-seen", "1");
    } catch {
      // ignore
    }
  });
  await openSky(page);
  const offer = page.getByTestId("tour-offer");
  await expect(offer).toBeVisible({ timeout: 10_000 });
  await expect(offer).toContainText("New here? Take a one-minute tour of the Sky globe.");
  await shot(page, "tour-offer-sky");
  await offer.getByTestId("tour-offer-dismiss").click();
  await expect(offer).toHaveCount(0);
  expect(await page.evaluate(() => window.localStorage.getItem("pxh-tour-seen"))).toBe("sky");
  await page.reload();
  await expect(page.getByTestId("sky-globe")).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(3500);
  await expect(offer).toHaveCount(0);

  // The Lab has its own offer; Start tour starts it.
  await openLab(page);
  await expect(offer).toBeVisible({ timeout: 10_000 });
  await expect(offer).toContainText("tour of the Lab");
  await offer.getByTestId("tour-offer-start").click();
  await settled(page, "lab");
  await page.keyboard.press("Escape");
  await expect(tour(page)).toHaveCount(0);
});

test("Settings: the offer can be turned off, and the tours replayed", async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto("/settings#tours");
  // Hydrated: the stored-data list fills in from an effect.
  await expect(page.getByTestId("stored-empty").or(page.getByTestId("stored-list"))).toBeVisible();
  const toggle = page.getByTestId("pref-tour-offer");
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  expect(await page.evaluate(() => JSON.parse(window.localStorage.getItem("pxh:prefs") ?? "null")?.prefs)).toEqual({ tourOffer: false });
  await expect(page.getByTestId("replay-sky-tour")).toHaveAttribute("href", "/sky?tour=1");
  await expect(page.getByTestId("replay-lab-tour")).toHaveAttribute("href", "/explore?target=barnards-star&tour=1");
  await shot(page, "tour-settings");

  await openLab(page);
  await page.waitForTimeout(3500);
  await expect(page.getByTestId("tour-offer")).toHaveCount(0);

  await page.goto("/settings#tours");
  await expect(page.getByTestId("stored-list")).toBeVisible();
  await page.getByTestId("replay-sky-tour").click();
  await page.waitForURL(/\/sky/, { timeout: 90_000 });
  await settled(page, "globe");
});

test("reduced motion: the pointer never glides, and each action still happens", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await quiet(page);
  await openSky(page);
  await page.locator("[data-tour-button=sky]").click();
  await settled(page, "globe");
  // Record whether the pointer is ever caught moving.
  await page.evaluate(() => {
    const el = document.querySelector("[data-testid=tour-cursor]")!;
    const w = window as unknown as { glided: boolean };
    w.glided = false;
    new MutationObserver(() => {
      if (el.hasAttribute("data-moving")) w.glided = true;
    }).observe(el, { attributes: true, attributeFilter: ["data-moving"] });
  });
  await next(page);
  await settled(page, "turn");
  await next(page);
  await settled(page, "search");
  await expect(page).toHaveURL(/star=32349/);
  expect(await page.evaluate(() => (window as unknown as { glided: boolean }).glided)).toBe(false);
  await page.keyboard.press("Escape");
});

test("axe: no serious or critical problems with a tour open", async ({ page, browserName }) => {
  test.setTimeout(180_000);
  test.skip(firefoxOnDevServer(browserName), FIREFOX_DEV_AXE);
  await quiet(page);
  await openSky(page);
  await page.locator("[data-tour-button=sky]").click();
  await settled(page, "globe");
  let results = await new AxeBuilder({ page }).exclude("canvas").analyze();
  let serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  await page.keyboard.press("Escape");

  await openLab(page);
  await page.locator("[data-tour-button=lab]").click();
  await settled(page, "lab");
  results = await new AxeBuilder({ page }).exclude("[data-testid=sky-viewer] canvas").analyze();
  serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("phone: the card docks as a sheet, and the Sky tour hands over to the Lab tour, both to the end", async ({ page }) => {
    test.setTimeout(480_000);
    await quiet(page);
    await openSky(page);
    await page.locator("[data-tour-button=sky]").click();
    for (const [i, step] of SKY_STEPS.entries()) {
      await settled(page, step);
      const box = (await card(page).boundingBox())!;
      const vw = page.viewportSize()!.width;
      expect(Math.round(box.x)).toBe(8);
      expect(Math.round(box.width)).toBe(vw - 16);
      await shot(page, `tour-sky-phone-${String(i + 1).padStart(2, "0")}-${step}`);
      if (i < SKY_STEPS.length - 1) await next(page);
    }
    await expect(page.getByTestId("target-story")).toHaveAttribute("data-slug", "barnards-star");
    // The Sky tour ends by offering the Lab tour, which starts on Barnard's Star.
    await card(page).getByTestId("tour-next-tour").click();
    await page.waitForURL(/\/explore\?target=barnards-star/, { timeout: 90_000 });
    await expect(tour(page)).toHaveAttribute("data-tour-id", "lab", { timeout: 60_000 });

    // The Lab on a phone: its panes are tabs, and the field-of-view step is left out.
    const steps = LAB_STEPS.filter((s) => s !== "fov");
    for (const [i, step] of steps.entries()) {
      await settled(page, step);
      await expect(page.getByTestId("tour-count")).toHaveText(`${i + 1} of ${steps.length}`);
      await shot(page, `tour-lab-phone-${String(i + 1).padStart(2, "0")}-${step}`);
      if (step === "spectrum") await expect(page.getByTestId("analysis-tab-spectrum")).toHaveAttribute("aria-selected", "true");
      if (i < steps.length - 1) await next(page);
    }
    await next(page);
    await expect(tour(page)).toHaveCount(0);
  });
});
