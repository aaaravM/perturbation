// The main journeys end to end, as a visitor would take them: landing -> Sky globe -> Barnard's
// Star -> its panel -> the Lab, where the blink plays and the panel shows motion and spectrum;
// Back through the history; the Sky | Lab switch; the Lab's search by name and by pasted
// coordinates; and the same first journey on a phone.
// QA screenshots are opt-in: UI_REVIEW_DIR=/some/dir pnpm test:e2e journeys (files qa-*.png).
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { hideDevOverlay, watchPage } from "./helpers";

const OUT = process.env.UI_REVIEW_DIR;
/** These journeys assume the prepared bundles and no live backend (the default dev setup). */
const LIVE_BACKEND = Boolean(process.env.NEXT_PUBLIC_API_URL);

async function shot(page: Page, name: string, fullPage = false) {
  if (!OUT) return;
  await hideDevOverlay(page);
  await page.screenshot({ path: path.join(OUT, `qa-${name}.png`), fullPage });
}

const param = (page: Page, name: string) => new URL(page.url()).searchParams.get(name);
const player = (page: Page) => page.getByTestId("blink-player");
const skyPanel = (page: Page) => page.getByTestId("sky-panel");
const counter = (page: Page) => page.getByTestId("frame-counter");

async function hasBundle(page: Page, slug: string) {
  return (await page.request.get(`/bundles/${slug}/manifest.json`)).status() === 200;
}

/** The blink is ready, playing and actually changing frame. */
async function expectBlinkPlays(page: Page) {
  await expect(player(page)).toHaveAttribute("data-ready", "true", { timeout: 45_000 });
  await expect(page.getByTestId("blink-play")).toHaveAttribute("data-playing", "true");
  const first = (await counter(page).textContent())?.trim();
  await expect.poll(async () => (await counter(page).textContent())?.trim(), { timeout: 8000 }).not.toBe(first);
}

test.describe.configure({ mode: "serial" });

test("landing -> Sky globe -> Barnard's Star -> the Lab, and Back through it all", async ({ page }) => {
  test.skip(LIVE_BACKEND, "assumes the prepared bundles and no live backend");
  test.skip(!(await hasBundle(page, "barnards-star")), "Barnard's Star bundle not built yet");
  const log = watchPage(page);

  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Watch the sky move.");
  await page.waitForTimeout(4200); // hero blink mid-cycle
  await shot(page, "landing-1440x900");

  // Into Sky mode.
  await page.getByRole("link", { name: "Explore the sky globe" }).click();
  await expect(page).toHaveURL(/\/sky$/);
  const globe = page.getByTestId("sky-globe");
  await expect(globe.locator("canvas")).toBeVisible();
  await expect(globe).toHaveAttribute("data-texture", "ready", { timeout: 30_000 });
  await expect(page.getByTestId("mode-switch").getByRole("link", { name: "Sky" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await page.waitForTimeout(3000); // entrance drift settles
  await shot(page, "sky-1440x900");

  // Choose Barnard's Star: the globe flies to it and the panel opens on the right.
  await page.getByTestId("target-list").getByRole("button", { name: /Barnard.s Star/ }).click();
  await expect(page).toHaveURL(/[?&]target=barnards-star\b/);
  await expect(skyPanel(page).getByRole("heading", { level: 2 })).toHaveText("Barnard's Star");
  await expect(globe).toHaveAttribute("data-arrived", "t:barnards-star", { timeout: 10_000 });
  await expect(skyPanel(page).getByTestId("mini-blink")).toBeVisible({ timeout: 30_000 });
  await expect(skyPanel(page).getByTestId("fixture-banner")).toHaveCount(0);
  await page.waitForTimeout(1200);
  await shot(page, "sky-panel-1440x900");

  // Clicking the star itself on the globe opens the same panel.
  await skyPanel(page).getByRole("button", { name: "Close panel" }).click();
  await expect(skyPanel(page)).toHaveCount(0);
  const marker = page.getByTestId("globe-marker-barnards-star");
  await expect(marker).toBeVisible();
  await marker.click();
  await expect(skyPanel(page).getByRole("heading", { level: 2 })).toHaveText("Barnard's Star");

  // Into the Lab: the blink plays, the panel shows the measured motion and the spectrum.
  await skyPanel(page).getByTestId("open-in-lab").click();
  await expect(page).toHaveURL(/\/explore\?target=barnards-star/);
  await expectBlinkPlays(page);
  await expect(page.getByTestId("fixture-banner")).toHaveCount(0);
  const details = page.getByTestId("detail-panel");
  await expect(details.getByTestId("panel-title")).toHaveText("Barnard's Star");
  await expect(details.getByTestId("panel-motion")).toContainText("Measured");
  await expect(details.getByTestId("spectrum-chart")).toBeVisible();
  await expect(page.getByTestId("mode-switch").getByRole("link", { name: "Lab" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await page.waitForTimeout(1500);
  await shot(page, "lab-barnards-star-1440x900");
  await details.getByTestId("panel-motion").scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  await shot(page, "lab-barnards-star-motion-1440x900");

  // Back returns to the globe with Barnard's Star still open, then to the landing page.
  await page.goBack();
  await expect(page).toHaveURL(/\/sky\?target=barnards-star$/);
  await expect(skyPanel(page).getByRole("heading", { level: 2 })).toHaveText("Barnard's Star");
  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Watch the sky move.");
  await page.goForward();
  await expect(page).toHaveURL(/\/sky/);
  await expect(page.getByTestId("sky-globe").locator("canvas")).toBeVisible();

  expect(log.cdsRequests, "no requests to CDS").toEqual([]);
  expect(log.badResponses.filter((r) => !/\/favicon/.test(r)), "HTTP errors").toEqual([]);
  expect(log.consoleErrors, "console errors").toEqual([]);
});

test("the Sky | Lab switch moves between the two modes", async ({ page }) => {
  await page.goto("/sky");
  const modes = page.getByTestId("mode-switch");
  await modes.getByRole("link", { name: "Lab" }).click();
  await expect(page).toHaveURL(/\/explore(\?|$)/);
  await expect(modes.getByRole("link", { name: "Lab" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("sky-viewer")).toBeVisible();
  await modes.getByRole("link", { name: "Sky" }).click();
  await expect(page).toHaveURL(/\/sky$/);
  await expect(page.getByTestId("sky-globe").locator("canvas")).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/explore(\?|$)/);
  await expect(page.getByTestId("sky-viewer")).toBeVisible();
});

test("Lab: search WISE 0855, then compare Then vs Now", async ({ page }) => {
  test.skip(LIVE_BACKEND, "assumes the prepared bundles and no live backend");
  test.skip(!(await hasBundle(page, "wise-0855")), "WISE 0855 bundle not built yet");
  await page.goto("/explore");
  const search = page.getByTestId("lab-search");
  await search.fill("WISE 0855");
  await search.press("Enter");
  await expect.poll(() => param(page, "target")).toBe("wise-0855");
  await expectBlinkPlays(page);
  await expect(page.getByTestId("detail-panel").getByTestId("panel-title")).toHaveText("WISE 0855−0714");

  // Pause, switch to Then vs Now (WISE about 2010 against SPHEREx today), then play the pair.
  // Pausing first also keeps the click quick under software WebGL, which redraws every frame.
  await page.getByTestId("blink-play").click();
  await expect(page.getByTestId("blink-play")).toHaveAttribute("data-playing", "false");
  await page.getByTestId("mode-then-now").click();
  await expect.poll(() => param(page, "mode")).toBe("then-now");
  await expect(page.getByTestId("then-now-row")).toBeVisible();
  await expect(player(page)).toHaveAttribute("data-ready", "true", { timeout: 20_000 });
  await expect(counter(page)).toHaveText(/^[12] \/ 2$/);
  await page.waitForTimeout(1200);
  await shot(page, "lab-wise-then-now-1440x900");
  await page.getByTestId("blink-play").click();
  await expectBlinkPlays(page);
});

test("Lab: pasted RA/Dec labels resolve to that patch", async ({ page }) => {
  test.skip(LIVE_BACKEND, "assumes the prepared bundles and no live backend");
  test.skip(!(await hasBundle(page, "wise-0855")), "WISE 0855 bundle not built yet");
  await page.goto("/explore");
  const search = page.getByTestId("lab-search");
  // As copied from a catalogue page: labels, units and an ASCII minus.
  await search.fill("RA 08h55m10.831s Dec -7d14m42.53s");
  await search.press("Enter");
  await expect(page.getByTestId("lab-search-status")).toContainText("Coordinates as typed");
  // Without the live backend, the patch shows the prepared frames of the target inside it.
  await expect.poll(() => param(page, "target")).toBe("wise-0855");
  await expect(page.getByTestId("blink-note")).toContainText("Showing the prepared frames of WISE 0855−0714");
  await expectBlinkPlays(page);
  await page.waitForTimeout(1000);
  await shot(page, "lab-pasted-coordinates-1440x900");

  // Labelled decimal degrees work too.
  await search.fill("ra=269.4461 dec=4.7707");
  await search.press("Enter");
  await expect.poll(() => param(page, "target")).toBe("barnards-star");
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("landing -> Sky -> Barnard's Star -> the Lab on a phone", async ({ page }) => {
    test.skip(LIVE_BACKEND, "assumes the prepared bundles and no live backend");
    test.skip(!(await hasBundle(page, "barnards-star")), "Barnard's Star bundle not built yet");
    await page.goto("/");
    await page.waitForTimeout(4200);
    await shot(page, "landing-390x844");
    await shot(page, "landing-full-390x844", true);

    // The phone menu lists both modes.
    await page.getByRole("button", { name: "Open menu" }).click();
    const menu = page.getByRole("dialog");
    await expect(menu.getByRole("link", { name: "Sky" })).toBeVisible();
    await expect(menu.getByRole("link", { name: "Lab" })).toBeVisible();
    await page.waitForTimeout(500);
    await shot(page, "nav-menu-390x844");
    await menu.getByRole("link", { name: "Sky" }).click();
    await expect(page).toHaveURL(/\/sky$/);

    const globe = page.getByTestId("sky-globe");
    await expect(globe).toHaveAttribute("data-texture", "ready", { timeout: 30_000 });
    await page.waitForTimeout(2500);
    await shot(page, "sky-390x844");

    // On phones the star lists fold away under "Browse stars".
    await page.getByRole("button", { name: "Browse stars" }).tap();
    await page.getByTestId("target-list").getByRole("button", { name: /Barnard.s Star/ }).tap();
    await expect(skyPanel(page)).toHaveAttribute("data-layout", "sheet");
    await expect(skyPanel(page).getByRole("heading", { level: 2 })).toHaveText("Barnard's Star");
    await expect(skyPanel(page).getByTestId("mini-blink")).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(1200);
    await shot(page, "sky-panel-390x844");

    const lab = skyPanel(page).getByTestId("open-in-lab");
    await lab.scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    await shot(page, "sky-panel-end-390x844");
    await lab.tap();
    await expect(page).toHaveURL(/\/explore\?target=barnards-star/);
    await expectBlinkPlays(page);
    // On phones the panel waits for Details, so the sheet does not cover the blink.
    await expect(page.getByTestId("detail-panel")).toHaveCount(0);
    await page.waitForTimeout(1500);
    await shot(page, "lab-barnards-star-390x844");
    await page.getByTestId("open-details").tap();
    const details = page.getByTestId("detail-panel");
    await expect(details.getByTestId("panel-title")).toHaveText("Barnard's Star");
    await page.waitForTimeout(800);
    await shot(page, "lab-panel-390x844");
    await details.getByTestId("panel-motion").scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    await shot(page, "lab-panel-motion-390x844");
    await page.getByTestId("panel-close").tap();
    await expect(details).toHaveCount(0);

    await page.goBack();
    await expect(page).toHaveURL(/\/sky\?target=barnards-star$/);
  });
});
