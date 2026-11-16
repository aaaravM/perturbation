// The Lab's layout buttons, like VS Code's: the data pane, the blink player and the analysis pane
// each hide and come back (by the buttons, by Ctrl B / Ctrl J / Ctrl Alt B, by the palette), the
// sky takes their room at the same scale and stays sharp, the layout is remembered, the analysis
// pane keeps its selection, phones keep their tabs, and the Lab tour shows what it needs and puts
// the layout back. Set UI_REVIEW_DIR to save screenshots.
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { DESKTOP_LAYOUT, FIREFOX_DEV_AXE, firefoxOnDevServer, hideDevOverlay, viewerCenter } from "./helpers";

const OUT = process.env.UI_REVIEW_DIR;
const TARGET = "/explore?target=barnards-star";
const PANES = ["data", "player", "analysis"] as const;
type Pane = (typeof PANES)[number];
const PANE_ID: Record<Pane, string> = { data: "lab-data-pane", player: "lab-blink-player", analysis: "lab-analysis-pane" };
const KEY: Record<Pane, string> = { data: "Control+b", player: "Control+j", analysis: "Control+Alt+b" };
const LAB_STEPS = ["lab", "field", "fov", "blink", "visits", "detectors", "difference", "motion", "spectrum", "overlays", "share"];

async function shot(page: Page, name: string) {
  if (!OUT) return;
  await hideDevOverlay(page);
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
}

/** No first-visit offers or tips; optionally start with some panes hidden. */
async function quiet(page: Page, hidden: Pane[] = []) {
  await page.addInitScript((hide) => {
    try {
      window.localStorage.setItem("pxh-tour-seen", "sky,lab");
      window.localStorage.setItem("pxh-lab-hint-seen", "1");
      if (hide.length && !window.sessionStorage.getItem("layout-set")) {
        const name = { data: "labDataPane", player: "labBlinkPlayer", analysis: "labAnalysisPane" } as const;
        const prefs = Object.fromEntries(hide.map((p) => [name[p], false]));
        window.localStorage.setItem("pxh:prefs", JSON.stringify({ v: 1, prefs }));
        window.sessionStorage.setItem("layout-set", "1");
      }
    } catch {
      // ignore
    }
  }, hidden);
}

async function openLab(page: Page, url = TARGET) {
  await page.goto(url);
  await hideDevOverlay(page);
  await expect(page.getByTestId("blink-player")).toHaveAttribute("data-ready", "true", { timeout: 60_000 });
}

const toggle = (page: Page, p: Pane) => page.getByTestId(`lab-toggle-${p}`);

/** The pane is shown or hidden: the button says so, and the pane is in or out of the page's way. */
async function expectPane(page: Page, p: Pane, shown: boolean) {
  await expect(toggle(page, p)).toHaveAttribute("aria-pressed", String(shown));
  const pane = page.locator(`#${PANE_ID[p]}`);
  await expect(pane).toHaveAttribute("data-shown", String(shown));
  if (shown) await expect(pane).not.toHaveAttribute("inert", /.*/);
  else await expect(pane).toHaveAttribute("inert", /.*/);
}

/** Viewer width and Aladin's own view, once a slide has finished. */
async function settledView(page: Page) {
  await page.waitForTimeout(700);
  const box = (await page.getByTestId("sky-viewer").boundingBox())!;
  const c = (await viewerCenter(page))!;
  return { w: box.width, h: box.height, ...c };
}

/** Every canvas of the sky draws at the size it is shown (sharp, not stretched). */
async function expectSharp(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() =>
        [...document.querySelectorAll<HTMLCanvasElement>("[data-testid=sky-viewer] canvas")].every(
          (c) => c.clientWidth > 0 && Math.abs(c.width - Math.floor(c.clientWidth * window.devicePixelRatio)) <= 1,
        ),
      ),
    )
    .toBe(true);
}

// In a phone profile only the "phone" tests run: the others drive the desktop panes.
test.beforeEach(({ isMobile }, testInfo) => {
  test.skip(isMobile && !testInfo.titlePath.includes("phone"), DESKTOP_LAYOUT);
});

test("the three buttons hide and show each pane, and the sky takes the room at the same scale", async ({ page }) => {
  test.setTimeout(180_000);
  await quiet(page);
  await openLab(page);
  // Hold the blink still: software WebGL redraws every frame, which slows everything else.
  await page.getByTestId("blink-play").click();
  // The buttons sit at the right end of the session bar, in VS Code's order, all shown at first.
  const bar = page.getByTestId("session-bar");
  const order = await bar.locator("[data-testid^=lab-toggle-]").evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));
  expect(order).toEqual(["lab-toggle-data", "lab-toggle-player", "lab-toggle-analysis"]);
  for (const p of PANES) await expectPane(page, p, true);
  await expect(toggle(page, "data")).toHaveAttribute("aria-controls", PANE_ID.data);
  await expect(toggle(page, "data")).toHaveAccessibleName("Data pane");
  await toggle(page, "data").hover();
  await expect(page.getByRole("tooltip")).toContainText("Hide the data pane");
  await expect(page.getByRole("tooltip")).toContainText("Ctrl B");

  const start = await settledView(page);
  await toggle(page, "data").click();
  await expectPane(page, "data", false);
  const noData = await settledView(page);
  expect(noData.w - start.w).toBeGreaterThan(250);
  // Same centre and the same pixels per degree: the sky shows more around the field, not a zoom.
  expect(Math.abs(noData.ra - start.ra)).toBeLessThan(1e-4);
  expect(Math.abs(noData.dec - start.dec)).toBeLessThan(1e-4);
  expect(Math.abs(noData.w / noData.fov / (start.w / start.fov) - 1)).toBeLessThan(0.02);
  await expectSharp(page);

  await toggle(page, "player").click();
  await expectPane(page, "player", false);
  const noPlayer = await settledView(page);
  expect(noPlayer.h - noData.h).toBeGreaterThan(150);
  expect(Math.abs(noPlayer.fov - noData.fov)).toBeLessThan(1e-3);
  // The status bar stays, at the bottom.
  const status = (await page.getByTestId("status-bar").boundingBox())!;
  expect(status.y + status.height).toBeGreaterThan((page.viewportSize()?.height ?? 900) - 2);

  await toggle(page, "analysis").click();
  await expectPane(page, "analysis", false);
  const bare = await settledView(page);
  expect(bare.w).toBeGreaterThan((page.viewportSize()?.width ?? 1440) - 2);
  expect(Math.abs(bare.w / bare.fov / (start.w / start.fov) - 1)).toBeLessThan(0.02);
  await expectSharp(page);
  await shot(page, "lab-layout-all-hidden-1440x900");

  for (const p of PANES) await toggle(page, p).click();
  for (const p of PANES) await expectPane(page, p, true);
  const back = await settledView(page);
  expect(Math.abs(back.w - start.w)).toBeLessThan(1);
  expect(Math.abs(back.h - start.h)).toBeLessThan(1);
  expect(Math.abs(back.fov / start.fov - 1)).toBeLessThan(0.02);
  await expectSharp(page);
});

test("Ctrl B, Ctrl J and Ctrl Alt B toggle the panes, with the sky focused; not while typing; other keys still work", async ({ page }) => {
  test.setTimeout(180_000);
  await quiet(page);
  await openLab(page);
  await page.getByTestId("blink-play").click();
  await page.getByTestId("sky-viewer").focus();
  for (const p of PANES) {
    await page.keyboard.press(KEY[p]);
    await expectPane(page, p, false);
  }
  // Focus was in none of them, so it stays on the sky.
  await expect(page.getByTestId("sky-viewer")).toBeFocused();
  for (const p of PANES) {
    await page.keyboard.press(KEY[p]);
    await expectPane(page, p, true);
  }

  // Typing in the search box: the keys are left alone.
  const search = page.getByTestId("lab-search");
  await search.click();
  await search.pressSequentially("Barn");
  await page.keyboard.press("Control+b");
  await page.keyboard.press("Control+j");
  for (const p of PANES) await expectPane(page, p, true);
  await expect(search).toHaveValue("Barn");
  await search.fill("");

  // A key pressed with focus inside a pane hides it and hands focus to the sky.
  await page.getByTestId("analysis-tab-motion").focus();
  await page.keyboard.press("Control+Alt+b");
  await expectPane(page, "analysis", false);
  await expect(page.getByTestId("sky-viewer")).toBeFocused();
  await page.keyboard.press("Control+Alt+b");
  await expectPane(page, "analysis", true);

  // The Lab's own keys still work, and the sheet lists the new ones.
  await page.getByTestId("sky-viewer").focus();
  await page.keyboard.press("g");
  await expect(page.getByTestId("tool-grid")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("g");
  await page.keyboard.press("?");
  const sheet = page.getByTestId("shortcuts-dialog");
  await expect(sheet).toContainText("Show or hide the data pane");
  await expect(sheet).toContainText("Show or hide the analysis pane");
  await page.keyboard.press("Escape");
});

test("the palette shows and hides each pane, or all of them", async ({ page }) => {
  test.setTimeout(180_000);
  await quiet(page);
  await openLab(page);
  await page.getByTestId("blink-play").click();
  const run = async (text: string) => {
    await page.keyboard.press("Control+k");
    await expect(page.getByTestId("command-palette")).toBeVisible();
    await page.getByTestId("command-input").fill(text);
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("command-palette")).toHaveCount(0);
  };
  await run("Hide all panels");
  for (const p of PANES) await expectPane(page, p, false);
  await run("Show the blink player");
  await expectPane(page, "player", true);
  await run("Show all panels");
  for (const p of PANES) await expectPane(page, p, true);
  await run("Hide the analysis pane");
  await expectPane(page, "analysis", false);
  await run("Show the analysis pane");
  await expectPane(page, "analysis", true);
});

test("the layout is remembered: a reload opens with the same panes hidden, and Settings resets it", async ({ page }) => {
  test.setTimeout(180_000);
  await quiet(page);
  await openLab(page);
  await toggle(page, "data").click();
  await toggle(page, "analysis").click();
  await expectPane(page, "data", false);
  await expectPane(page, "analysis", false);
  await page.reload();
  await expect(page.getByTestId("blink-player")).toHaveAttribute("data-ready", "true", { timeout: 60_000 });
  await expectPane(page, "data", false);
  await expectPane(page, "player", true);
  await expectPane(page, "analysis", false);
  const stored = await page.evaluate(() => JSON.parse(window.localStorage.getItem("pxh:prefs") ?? "{}"));
  expect(stored.prefs).toMatchObject({ labDataPane: false, labAnalysisPane: false });

  await page.goto("/settings#lab");
  await expect(page.getByTestId("lab-layout-hidden")).toHaveText("Hidden now: the data pane and the analysis pane.");
  await page.getByTestId("reset-lab-layout").click();
  await expect(page.getByTestId("lab-layout-hidden")).toHaveCount(0);
  await expect(page.getByTestId("reset-lab-layout")).toBeDisabled();
  await openLab(page);
  for (const p of PANES) await expectPane(page, p, true);
});

test("hiding the analysis pane keeps the selection; the close button still clears it; a click on the sky brings the pane back", async ({ page }) => {
  test.setTimeout(180_000);
  await quiet(page);
  await openLab(page);
  await page.getByTestId("blink-play").click();
  const pane = page.getByTestId("detail-panel");
  await expect(pane.getByTestId("panel-title")).toHaveText("Barnard's Star");
  await toggle(page, "analysis").click();
  await expectPane(page, "analysis", false);
  await toggle(page, "analysis").click();
  await expectPane(page, "analysis", true);
  await expect(pane.getByTestId("panel-title")).toHaveText("Barnard's Star");

  // The close button clears the selection; the pane stays, as before.
  await pane.getByTestId("panel-close").click();
  await expect(pane.getByTestId("analysis-empty")).toBeVisible();
  await expectPane(page, "analysis", true);

  // Hidden, then a click on empty sky (no catalogue stars): the pane comes back with that position.
  await page.getByTestId("layer-toggle-gaia").click();
  await toggle(page, "analysis").click();
  await expectPane(page, "analysis", false);
  const box = (await page.getByTestId("sky-viewer").boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.2, box.y + box.height * 0.25);
  await expectPane(page, "analysis", true);
  await expect(pane.getByTestId("position-details")).toBeVisible();
});

test("reduced motion: the panes go at once, with no slide", async ({ page }) => {
  test.setTimeout(120_000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await quiet(page);
  await openLab(page);
  const aside = page.locator(`#${PANE_ID.data}`);
  const start = await settledView(page);
  await toggle(page, "data").click();
  await expectPane(page, "data", false);
  expect(await aside.evaluate((el) => getComputedStyle(el).transitionDuration)).toBe("0s");
  // The sky keeps its scale here too.
  const wider = await settledView(page);
  expect(wider.w - start.w).toBeGreaterThan(250);
  expect(Math.abs(wider.w / wider.fov / (start.w / start.fov) - 1)).toBeLessThan(0.02);
  await toggle(page, "data").click();
  await expectPane(page, "data", true);
  const back = await settledView(page);
  expect(Math.abs(back.fov / start.fov - 1)).toBeLessThan(0.02);
});

test("at 1024 px the view centre in the session bar still shows in full beside the layout buttons", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1024, height: 768 });
  await quiet(page);
  await openLab(page);
  const readout = page.getByTestId("coordinate-readout");
  await expect(readout).toBeVisible();
  expect(await readout.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  await expect(toggle(page, "analysis")).toBeVisible();
});

test("with motion, a pane slides out over a fifth of a second", async ({ page }) => {
  test.setTimeout(120_000);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await quiet(page);
  await openLab(page);
  await page.getByTestId("blink-play").click();
  const aside = page.locator(`#${PANE_ID.analysis}`);
  await toggle(page, "analysis").click();
  expect(await aside.evaluate((el) => getComputedStyle(el).transitionDuration)).toContain("0.2s");
  await expectPane(page, "analysis", false);
  await toggle(page, "analysis").click();
  await expectPane(page, "analysis", true);
});

test("axe: no serious or critical problems with every pane hidden", async ({ page, browserName }) => {
  test.setTimeout(120_000);
  test.skip(firefoxOnDevServer(browserName), FIREFOX_DEV_AXE);
  await quiet(page, ["data", "player", "analysis"]);
  await openLab(page);
  for (const p of PANES) await expectPane(page, p, false);
  await page.waitForTimeout(800);
  const results = await new AxeBuilder({ page }).exclude("[data-testid=sky-viewer] canvas").analyze();
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(" | ")}`)).toEqual([]);
});

test("the Lab tour with every pane hidden shows each pane as it needs it, and the layout comes back when it ends", async ({ page }) => {
  test.setTimeout(300_000);
  await quiet(page, ["data", "player", "analysis"]);
  await openLab(page, `${TARGET}&tour=1`);
  const tour = page.getByTestId("tour");
  const settled = async (step: string) => {
    await expect(tour).toHaveAttribute("data-step", step, { timeout: 30_000 });
    await expect(tour).toHaveAttribute("data-busy", "false", { timeout: 60_000 });
  };
  for (const [i, step] of LAB_STEPS.entries()) {
    await settled(step);
    if (step === "lab") for (const p of PANES) await expectPane(page, p, true);
    if (step === "field") await expect(page.getByTestId("lab-search-status")).toContainText("Featured target");
    if (step === "difference") await expect(page.getByTestId("blink-player")).toHaveAttribute("data-mode", "difference");
    if (step === "spectrum") await expect(page.getByTestId("analysis-tab-spectrum")).toHaveAttribute("aria-selected", "true");
    if (step === "overlays") await expect(page.getByTestId("layer-toggle-wise")).toHaveAttribute("aria-checked", "true");
    if (step === "visits") await shot(page, "lab-layout-tour-visits-1440x900");
    if (i < LAB_STEPS.length - 1) await page.getByTestId("tour-card").getByTestId("tour-next").click();
  }
  await page.getByTestId("tour-card").getByTestId("tour-next").click();
  await expect(tour).toHaveCount(0);
  // The visitor's layout is back, and the stored choice never changed.
  for (const p of PANES) await expectPane(page, p, false);
  const stored = await page.evaluate(() => JSON.parse(window.localStorage.getItem("pxh:prefs") ?? "{}"));
  expect(stored.prefs).toMatchObject({ labDataPane: false, labBlinkPlayer: false, labAnalysisPane: false });

  // Skipped part way (Esc): the same.
  await page.locator("[data-tour-button=lab]").click();
  await settled("lab");
  for (const p of PANES) await expectPane(page, p, true);
  await page.keyboard.press("Escape");
  await expect(tour).toHaveCount(0);
  for (const p of PANES) await expectPane(page, p, false);
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("phone: the tabs stay, with no layout buttons, and the keys change nothing", async ({ page }) => {
    test.setTimeout(120_000);
    // Even with panes hidden on a wide screen before.
    await quiet(page, ["data", "analysis"]);
    await openLab(page);
    await expect(page.getByTestId("phone-tabs")).toBeVisible();
    await expect(page.locator("[data-testid^=lab-toggle-]")).toHaveCount(0);
    await expect(page.getByTestId("phone-tab-viewer")).toHaveAttribute("aria-selected", "true");
    await page.getByTestId("sky-viewer").focus();
    await page.keyboard.press("Control+b");
    await page.keyboard.press("Control+Alt+b");
    await expect(page.getByTestId("phone-tab-viewer")).toHaveAttribute("aria-selected", "true");
    // The blink player is in place under the sky, and the Data tab still opens its pane.
    await expect(page.getByTestId("blink-play")).toBeVisible();
    // The shortcuts sheet leaves out the layout keys, which do nothing here.
    await page.getByTestId("open-shortcuts").click();
    const sheet = page.getByTestId("shortcuts-dialog");
    await expect(sheet).toContainText("Zoom to the field");
    await expect(sheet).not.toContainText("Show or hide the data pane");
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
    await page.getByTestId("phone-tab-data").click();
    await expect(page.getByTestId("epoch-table")).toBeVisible();
  });
});
