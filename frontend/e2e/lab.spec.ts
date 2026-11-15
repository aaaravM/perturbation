// Lab mode (/explore) against the development fixture (public/bundles/_fixture), which is always
// labelled "Development fixture: not real data". The blink, mode tabs, detector picker, panel,
// keyboard and URL round-trip are covered. Set UI_REVIEW_DIR to save design-review screenshots.
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { hideDevOverlay, viewerCenter, watchPage } from "./helpers";

const OUT = process.env.UI_REVIEW_DIR;
const FIXTURE = "/explore?target=_fixture";
/**
 * Some tests check what the Lab says without the live backend. Run the tests with the same
 * NEXT_PUBLIC_API_URL as the dev server; with a backend configured, those tests are skipped.
 */
const LIVE_BACKEND = Boolean(process.env.NEXT_PUBLIC_API_URL);

async function shot(page: Page, name: string) {
  if (!OUT) return;
  await hideDevOverlay(page);
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
}

async function openFixture(page: Page, query = "") {
  await page.goto(`${FIXTURE}${query}`);
  await expect(page.getByTestId("blink-player")).toHaveAttribute("data-ready", "true", { timeout: 45_000 });
}

const counter = (page: Page) => page.getByTestId("frame-counter");
const param = (page: Page, name: string) => new URL(page.url()).searchParams.get(name);

test.describe.configure({ mode: "serial" });

test("the fixture is labelled and the blink cycles through every frame", async ({ page }) => {
  const log = watchPage(page);
  await openFixture(page);
  const banner = page.getByTestId("fixture-banner");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("Development fixture: not real data");
  await expect(page.getByTestId("panel-fixture-note")).toBeVisible();

  // Autoplay: the counter walks through all six frames and loops.
  await expect(page.getByTestId("blink-play")).toHaveAttribute("data-playing", "true");
  const seen = new Set<string>();
  for (let i = 0; i < 40 && seen.size < 6; i++) {
    seen.add((await counter(page).textContent())?.trim() ?? "");
    await page.waitForTimeout(150);
  }
  expect([...seen].sort()).toEqual(["1 / 6", "2 / 6", "3 / 6", "4 / 6", "5 / 6", "6 / 6"]);
  await expect(page.getByTestId("loop-cue")).toBeAttached({ timeout: 6000 });
  // On a wide screen the epochs are labelled with date and survey under the scrubber, as many
  // as fit (the fixture's pairs of epochs a month apart share one label).
  await expect(page.getByTestId("scrubber-label").first()).toHaveText(/May 2025\s*S1/);
  expect(await page.getByTestId("scrubber-label").count()).toBeGreaterThanOrEqual(3);
  await expect(page.getByTestId("scrubber-label").last()).toHaveText(/Oct 2026/);
  await page.waitForTimeout(1200); // let the sky tiles settle for the screenshot
  await shot(page, "lab-fixture-1440x900");

  expect(log.cdsRequests, "no requests to CDS").toEqual([]);
  expect(log.badResponses.filter((r) => !/\/favicon/.test(r)), "HTTP errors").toEqual([]);
  expect(log.consoleErrors, "console errors").toEqual([]);
});

test("Space pauses, the arrow keys step, and the scrubber seeks", async ({ page }) => {
  await openFixture(page);
  await page.getByTestId("panel-close").click();
  await page.locator("body").press("Space");
  await expect(page.getByTestId("blink-play")).toHaveAttribute("data-playing", "false");
  await page.getByTestId("scrubber-tick").first().click();
  await expect(counter(page)).toHaveText("1 / 6");
  await expect(page.getByTestId("frame-label")).toContainText("May 2025");
  await page.locator("body").press("ArrowRight");
  await expect(counter(page)).toHaveText("2 / 6");
  await page.locator("body").press("ArrowLeft");
  await page.locator("body").press("ArrowLeft");
  await expect(counter(page)).toHaveText("6 / 6");
  await expect.poll(() => param(page, "frame")).toBe("5");
  // Space on a focused button presses that button; from the sky viewer it toggles playback.
  await page.getByTestId("sky-viewer").focus();
  await page.keyboard.press("Space");
  await expect(page.getByTestId("blink-play")).toHaveAttribute("data-playing", "true");
});

test("mode tabs and the detector picker switch the frames", async ({ page }) => {
  await openFixture(page, "&frame=0");
  const player = page.getByTestId("blink-player");

  await page.getByTestId("det-D2").click();
  await expect(page.getByTestId("det-range")).toContainText("1.11–1.64");
  await expect.poll(() => param(page, "det")).toBe("D2");

  await page.getByTestId("mode-then-now").click();
  await expect(player).toHaveAttribute("data-mode", "then-now");
  await expect(player).toHaveAttribute("data-ready", "true", { timeout: 20_000 });
  await expect(counter(page)).toHaveText("1 / 2");
  await expect(page.getByTestId("frame-label")).toContainText("WISE 2010");
  await expect(page.getByTestId("then-now-row")).toContainText("years apart");
  await expect.poll(() => param(page, "mode")).toBe("then-now");
  await shot(page, "lab-then-now-1440x900");

  await page.getByTestId("mode-difference").click();
  await expect(player).toHaveAttribute("data-mode", "difference");
  await expect(page.getByTestId("difference-legend")).toBeVisible();
  await expect(page.getByTestId("frame-label")).toContainText("Oct 2026 minus May 2025");
  // One image: no timeline or transport to pretend otherwise.
  await expect(page.getByTestId("blink-scrubber")).toHaveCount(0);
  await expect.poll(() => param(page, "mode")).toBe("difference");
  await page.waitForTimeout(800);
  await shot(page, "lab-difference-1440x900");

  await page.getByTestId("mode-epochs").click();
  await expect(player).toHaveAttribute("data-mode", "epochs");
  await page.getByTestId("det-rgb").click();
  await expect(page.getByTestId("det-range")).toContainText("False colour");
  await page.getByTestId("layer-flags").isDisabled();
  await page.getByTestId("det-D6").click();
  await page.getByTestId("layer-flags").click();
  await expect.poll(() => param(page, "layers")).toBe("path,flags");
  await page.waitForTimeout(600);
  await shot(page, "lab-flags-1440x900");
});

test("the panel opens for a target and for a clicked position, and Esc closes it", async ({ page }) => {
  await openFixture(page);
  const panel = page.getByTestId("detail-panel");
  await expect(panel).toBeVisible();
  await expect(page.getByTestId("panel-title")).toHaveText("Fixture mover");
  await expect(page.getByTestId("spectrum-chart")).toBeAttached();
  await expect(page.getByTestId("lightcurve-chart")).toBeAttached();

  // Scroll the panel to the charts for a screenshot.
  await page.getByTestId("panel-spectrum").scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await shot(page, "lab-panel-charts-1440x900");

  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);

  // Click the sky: the panel shows that position and takes focus.
  await page.mouse.click(560, 420);
  await expect(page.getByTestId("position-details")).toBeVisible();
  await expect(page.getByTestId("panel-focus-target")).toBeFocused();
  if (!LIVE_BACKEND) await expect(page.getByTestId("quicklook-off")).toContainText("not connected");
  await page.waitForTimeout(500);
  await shot(page, "lab-position-1440x900");
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(page.getByTestId("sky-viewer")).toBeFocused();
});

test("the URL restores mode, detector, frame, layers and view", async ({ page }) => {
  const url = `${FIXTURE}&mode=epochs&det=D5&frame=3&layers=flags&ra=180.01&dec=30.02&fov=0.3`;
  await page.goto(url);
  await expect(page.getByTestId("blink-player")).toHaveAttribute("data-ready", "true", { timeout: 45_000 });
  await expect(page.getByTestId("det-D5")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("mode-epochs")).toHaveAttribute("aria-selected", "true");
  await expect(counter(page)).toHaveText("4 / 6");
  await expect(page.getByTestId("blink-play")).toHaveAttribute("data-playing", "false");
  await expect(page.getByTestId("layer-flags")).toHaveAttribute("data-state", "checked");
  await expect(page.getByTestId("layer-path")).toHaveAttribute("data-state", "unchecked");
  await expect.poll(async () => (await viewerCenter(page))?.ra, { timeout: 20_000 }).toBeCloseTo(180.01, 3);
  expect((await viewerCenter(page))?.dec).toBeCloseTo(30.02, 3);
  expect((await viewerCenter(page))?.fov).toBeCloseTo(0.3, 2);

  // Change things, then reload: the same view comes back.
  await page.getByTestId("mode-difference").click();
  await expect.poll(() => param(page, "mode")).toBe("difference");
  await page.waitForTimeout(500);
  const saved = page.url();
  await page.reload();
  await expect(page.getByTestId("blink-player")).toHaveAttribute("data-mode", "difference", { timeout: 45_000 });
  expect(new URL(page.url()).searchParams.get("det")).toBe(new URL(saved).searchParams.get("det"));
});

test("the brief's example link opens Barnard's Star's prepared frames and says so", async ({ page }) => {
  test.skip(LIVE_BACKEND, "with a live backend the link builds a live field instead");
  const log = watchPage(page);
  await page.goto("/explore?ra=269.452&dec=4.693&fov=0.2");
  // No live backend here: the featured target inside the patch is shown instead, with a note.
  await expect.poll(() => param(page, "target")).toBe("barnards-star");
  await expect(page.getByTestId("blink-player")).toHaveAttribute("data-ready", "true", { timeout: 45_000 });
  await expect(page.getByTestId("blink-note")).toContainText("prepared frames of Barnard's Star");
  await expect(page.getByTestId("panel-title")).toHaveText("Barnard's Star");
  // Until the real bundle lands, the stand-in must carry the banner; afterwards it must not.
  const res = await page.request.get("/bundles/barnards-star/manifest.json");
  if (res.status() === 404) await expect(page.getByTestId("fixture-banner")).toBeVisible();
  else await expect(page.getByTestId("fixture-banner")).toHaveCount(0);
  await page.waitForTimeout(1500);
  await shot(page, "lab-brief-example-1440x900");
  expect(log.cdsRequests, "no requests to CDS").toEqual([]);
});

test("a patch with no prepared frames explains that live fields are not connected", async ({ page }) => {
  test.skip(LIVE_BACKEND, "assumes no live backend");
  await page.goto("/explore?ra=83.822&dec=-5.391&fov=0.2");
  const message = page.getByTestId("field-message");
  await expect(message).toHaveAttribute("data-state", "unavailable", { timeout: 20_000 });
  await expect(message).toContainText("not connected");
  expect(param(page, "target")).toBeNull();
  await page.waitForTimeout(1500);
  await shot(page, "lab-no-backend-1440x900");
});

test("search resolves featured names and coordinates", async ({ page }) => {
  test.skip(LIVE_BACKEND, "assumes no live backend (names resolve through Sesame, patches have no live frames)");
  await page.goto("/explore");
  const search = page.getByTestId("lab-search");
  await search.fill("GJ 699");
  await search.press("Enter");
  await expect.poll(() => param(page, "target")).toBe("barnards-star");
  // Coordinates far from the five targets: a plain position, with its own panel.
  await search.fill("05 35 17.3 -05 23 28");
  await search.press("Enter");
  await expect.poll(() => param(page, "target")).toBeNull();
  await expect(page.getByTestId("position-details")).toBeVisible();
  await expect(page.getByTestId("panel-title")).toContainText("05h 35m 17.3s");
  await expect(page.getByTestId("field-message")).toContainText("not connected");
  // Barnard's Star's J2000 coordinates: it has since moved 4.7′, but it is still in that patch.
  await search.fill("17 57 48.5 +04 41 36");
  await search.press("Enter");
  await expect.poll(() => param(page, "target")).toBe("barnards-star");
  await expect(page.getByTestId("blink-note")).toContainText("4.7′ from the position you asked for");
});

// Real bundles (public/bundles/<slug>/manifest.json) are picked up as soon as they exist.
for (const slug of ["barnards-star", "eps-indi-b", "wise-0855", "rw-aur", "r-dra"]) {
  test(`the prepared bundle for ${slug} loads as real data when it exists`, async ({ page }) => {
    const res = await page.request.get(`/bundles/${slug}/manifest.json`);
    test.skip(res.status() !== 200, "bundle not built yet");
    const log = watchPage(page);
    await page.goto(`/explore?target=${slug}`);
    const player = page.getByTestId("blink-player");
    await expect(player).toHaveAttribute("data-ready", "true", { timeout: 45_000 });
    await expect(page.getByTestId("fixture-banner")).toHaveCount(0);
    await expect(page.getByTestId("panel-fixture-note")).toHaveCount(0);
    await page.waitForTimeout(1500);
    await shot(page, `lab-${slug}-1440x900`);
    if (await page.getByTestId("mode-difference").isEnabled()) {
      await page.getByTestId("mode-difference").click();
      await expect(player).toHaveAttribute("data-ready", "true", { timeout: 20_000 });
      await page.waitForTimeout(800);
      await shot(page, `lab-${slug}-difference-1440x900`);
    }
    await page.getByTestId("panel-spectrum").scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    await shot(page, `lab-${slug}-panel-1440x900`);
    await page.getByTestId("panel-lightcurve").scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    await shot(page, `lab-${slug}-lightcurve-1440x900`);
    expect(log.cdsRequests, "no requests to CDS").toEqual([]);
    expect(log.badResponses.filter((r) => !/\/favicon/.test(r)), "HTTP errors").toEqual([]);
    expect(log.consoleErrors, "console errors").toEqual([]);
  });
}

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the Lab works on a phone, with the panel as a bottom sheet", async ({ page }) => {
    await openFixture(page);
    await expect(page.getByTestId("fixture-banner")).toBeVisible();
    // On phones the target panel waits for "Details", so the sheet does not cover the blink.
    await expect(page.getByTestId("detail-panel")).toHaveCount(0);
    await page.waitForTimeout(1500);
    await shot(page, "lab-390x844");
    await page.getByTestId("open-details").click();
    await expect(page.getByTestId("detail-panel")).toBeVisible();
    await page.waitForTimeout(700);
    await shot(page, "lab-panel-390x844");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("detail-panel")).toHaveCount(0);
  });
});
