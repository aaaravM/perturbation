// Sky mode (/sky): the 3D globe renders, the five objects are listed, choosing one opens the
// plain-language panel with the right Lab link, Escape closes it, empty sky and the keyboard
// work, the camera zooms and flies, the layers control works, the phone layout uses a bottom
// sheet, and a browser without WebGL gets the flat map.
// Design-review screenshots are opt-in: UI_REVIEW_DIR=/some/dir pnpm test:e2e sky
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { hideDevOverlay, watchPage } from "./helpers";

// Per-target bundles are produced by the backend while the frontend is built; until one exists
// its manifest 404s (the panel then says so, or shows the labelled dev fixture). Nothing else may.
const PENDING_DATA = /\/bundles\/[^/]+\/manifest\.json$/;
const unexpected = (lines: string[]) =>
  lines.filter(
    (l) => !(PENDING_DATA.test(l.split(" ").pop() ?? "") || /bundles\/[^/]+\/manifest\.json/.test(l)),
  );

const globe = (page: Page) => page.getByTestId("sky-globe");
const list = (page: Page) => page.getByTestId("target-list");
const panel = (page: Page) => page.getByTestId("sky-panel");

async function openSky(page: Page) {
  const response = await page.goto("/sky");
  expect(response?.status()).toBe(200);
  await expect(globe(page).locator("canvas")).toBeVisible();
}

test("/sky renders the globe and lists the five objects", async ({ page }) => {
  const log = watchPage(page);
  await openSky(page);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("The sky as SPHEREx sees it");
  const buttons = list(page).getByRole("button");
  await expect(buttons).toHaveCount(5);
  for (const name of ["Barnard's Star", "Epsilon Indi B", "WISE 0855−0714", "RW Aurigae", "R Draconis"]) {
    await expect(
      list(page).getByRole("button", { name: new RegExp(name.replace(/[−']/g, ".")) }),
    ).toBeVisible();
  }
  // The SPHEREx map arrives on the globe, and the mode switch shows Sky as the current page.
  await expect(globe(page)).toHaveAttribute("data-texture", "ready", { timeout: 30_000 });
  await expect(page.getByTestId("mode-switch").getByRole("link", { name: "Sky" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await page.waitForTimeout(800);
  expect(unexpected(log.badResponses), "HTTP errors").toEqual([]);
  expect(unexpected(log.consoleErrors), "console errors").toEqual([]);
});

test("choosing Barnard's Star opens its panel; Escape closes it and returns focus", async ({ page }) => {
  await openSky(page);
  const item = list(page).getByRole("button", { name: /Barnard.s Star/ });
  await item.click();

  await expect(panel(page)).toBeVisible();
  const heading = panel(page).getByRole("heading", { level: 2 });
  await expect(heading).toHaveText("Barnard's Star");
  await expect(heading).toBeFocused();
  await expect(page.getByRole("dialog", { name: "Barnard's Star" })).toBeVisible();
  await expect(item).toHaveAttribute("aria-pressed", "true");
  await expect(page).toHaveURL(/[?&]target=barnards-star\b/);

  const lab = panel(page).getByRole("link", { name: /Open in the Lab/ });
  await expect(lab).toHaveAttribute("href", "/explore?target=barnards-star");

  // Either the real bundle's blink, the labelled dev fixture, or an honest "being prepared".
  await expect(
    panel(page).getByTestId("mini-blink").or(panel(page).getByTestId("bundle-missing")),
  ).toBeVisible({ timeout: 30_000 });
  if (await panel(page).getByTestId("mini-blink").isVisible()) {
    const fixture = await panel(page).getByTestId("provenance").textContent();
    if (/fixture/i.test(fixture ?? "")) {
      await expect(panel(page).getByTestId("fixture-banner")).toHaveText(
        /Development fixture: not real data/,
      );
    }
  }

  await page.keyboard.press("Escape");
  await expect(panel(page)).toHaveCount(0);
  await expect(item).toBeFocused();
  await expect(page).not.toHaveURL(/target=/);
});

test("a deep link opens the object, and every object has a Lab link", async ({ page }) => {
  await page.goto("/sky?target=r-dra");
  await expect(panel(page).getByRole("heading", { level: 2 })).toHaveText("R Draconis");
  await expect(panel(page).getByRole("link", { name: /Open in the Lab/ })).toHaveAttribute(
    "href",
    "/explore?target=r-dra",
  );
  // "Next" walks through the five.
  await panel(page)
    .getByRole("button", { name: /^Next: / })
    .click();
  await expect(panel(page).getByRole("heading", { level: 2 })).toHaveText("Barnard's Star");
});

test("clicking empty sky describes that patch, with a Lab link", async ({ page }) => {
  await openSky(page);
  await page.waitForTimeout(2800); // entrance turn settles
  // Below and right of the globe's centre: clear of the five markers in the opening view.
  const outline = await page.getByTestId("globe-outline").boundingBox();
  if (!outline) throw new Error("no globe outline");
  const ring = { x: outline.x + outline.width / 2, y: outline.y + outline.height / 2, r: outline.width / 2 };
  await page.mouse.click(ring.x + ring.r * 0.3, ring.y + ring.r * 0.35);

  await expect(panel(page).getByRole("heading", { level: 2 })).toHaveText("This patch of sky");
  const ra = Number((await panel(page).getByTestId("patch-ra").textContent())?.replace("°", ""));
  const dec = Number(
    (await panel(page).getByTestId("patch-dec").textContent())?.replace("°", "").replace("−", "-"),
  );
  expect(ra).toBeGreaterThanOrEqual(0);
  expect(ra).toBeLessThan(360);
  expect(Math.abs(dec)).toBeLessThanOrEqual(90);
  const href = await panel(page)
    .getByRole("link", { name: /Look closer in the Lab/ })
    .getAttribute("href");
  expect(href).toMatch(/^\/explore\?ra=\d+\.\d{4}&dec=-?\d+\.\d{4}&fov=1\.5$/);
});

test("arrow keys turn the globe and Enter describes the centre of the view", async ({ page }) => {
  await openSky(page);
  await page.waitForTimeout(2800);
  await globe(page).focus();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await page.waitForTimeout(1600); // the camera flies there in about a second
  await page.keyboard.press("Enter");
  await expect(panel(page).getByRole("heading", { level: 2 })).toHaveText("This patch of sky");
  const dec = Number(
    (await panel(page).getByTestId("patch-dec").textContent())?.replace("°", "").replace("−", "-"),
  );
  // Opening view faces Dec -2; two steps north is about +28 (it drifts in RA, not in Dec).
  expect(dec).toBeGreaterThan(20);
  expect(dec).toBeLessThan(35);
});

test("the layers control: one SPHEREx colour, imagery strength and the overlays", async ({ page }) => {
  await openSky(page);
  await expect(globe(page)).toHaveAttribute("data-texture", "ready", { timeout: 30_000 });
  await page.getByRole("button", { name: "Layers" }).click();
  const layersPanel = page.getByTestId("layers-panel");
  await expect(layersPanel).toBeVisible();

  await layersPanel.getByRole("radio", { name: "1.25 µm" }).click();
  await expect(globe(page)).toHaveAttribute("data-view", "mono");
  await expect(page.getByTestId("globe-caption")).toContainText("one of its 102 colours");
  await layersPanel.getByRole("radio", { name: "False colour" }).click();
  await expect(globe(page)).toHaveAttribute("data-view", "colour");
  await expect(page.getByTestId("globe-caption")).toContainText("false colour");

  // The SPHEREx imagery can be turned right down, leaving the catalogue stars on a bare globe.
  const imagery = layersPanel.getByRole("slider", { name: "SPHEREx imagery opacity" });
  await imagery.focus();
  await page.keyboard.press("Home");
  await expect(imagery).toHaveAttribute("aria-valuetext", "0 percent");
  await page.keyboard.press("End");
  await expect(imagery).toHaveAttribute("aria-valuetext", "100 percent");

  // Defaults: stars, constellations, names and objects on; the grid off.
  const grid = layersPanel.getByRole("switch", { name: /^Grid/ });
  await expect(grid).toHaveAttribute("aria-checked", "false");
  await grid.click();
  await expect(grid).toHaveAttribute("aria-checked", "true");
  for (const name of [/^Stars/, /^Constellations/, /^Star names/, /^Featured objects/]) {
    await expect(layersPanel.getByRole("switch", { name })).toHaveAttribute("aria-checked", "true");
  }
  await layersPanel.getByRole("switch", { name: /^Stars/ }).click();
  await expect(page.getByTestId("globe-caption")).not.toContainText("White dots");
  await layersPanel.getByRole("switch", { name: /^Stars/ }).click();
  await expect(page.getByTestId("globe-caption")).toContainText("White dots");
});

test("the camera zooms towards the cursor, flies in on double-click and resets", async ({ page }) => {
  await openSky(page);
  await page.waitForTimeout(3000); // entrance flight settles
  const altitude = async () => Number(await globe(page).getAttribute("data-altitude"));
  const home = await altitude();
  expect(home).toBeGreaterThan(1);

  const outline = await page.getByTestId("globe-outline").boundingBox();
  if (!outline) throw new Error("no globe outline");
  const cx = outline.x + outline.width / 2;
  const cy = outline.y + outline.height / 2;
  await page.mouse.move(cx + outline.width * 0.15, cy);
  for (let i = 0; i < 4; i++) {
    await page.mouse.wheel(0, -240);
    await page.waitForTimeout(80);
  }
  await page.waitForTimeout(1200);
  const zoomed = await altitude();
  expect(zoomed).toBeLessThan(home * 0.5);

  // Keyboard: minus backs out again.
  await globe(page).focus();
  await page.keyboard.press("-");
  await page.waitForTimeout(900);
  expect(await altitude()).toBeGreaterThan(zoomed);

  await page.getByRole("button", { name: "Reset view" }).click();
  await page.waitForTimeout(2600);
  expect(Math.abs((await altitude()) - home) / home).toBeLessThan(0.05);

  // A double click flies in towards that spot (and describes it).
  await page.mouse.dblclick(cx, cy + outline.height * 0.12);
  await expect(panel(page).getByRole("heading", { level: 2 })).toHaveText("This patch of sky");
  await page.waitForTimeout(2600);
  expect(await altitude()).toBeLessThan(home * 0.5);
});

test("on a phone the panel is a bottom sheet", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openSky(page);
  await list(page)
    .getByRole("button", { name: /Epsilon Indi B/ })
    .click();
  await expect(panel(page)).toHaveAttribute("data-layout", "sheet");
  await expect(panel(page).getByRole("heading", { level: 2 })).toHaveText("Epsilon Indi B");
  await panel(page).getByRole("button", { name: "Close panel" }).click();
  await expect(panel(page)).toHaveCount(0);
});

test("without WebGL the flat map and the list still work", async ({ page }) => {
  await page.addInitScript(() => {
    // Pretend WebGL is unavailable; every other context type still works.
    const original = HTMLCanvasElement.prototype.getContext as (
      this: HTMLCanvasElement,
      ...args: unknown[]
    ) => unknown;
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      value(this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
        return /webgl/i.test(type) ? null : original.call(this, type, ...rest);
      },
    });
  });
  await page.goto("/sky");
  await expect(page.getByTestId("sky-flat-map")).toBeVisible();
  await expect(page.getByTestId("sky-globe")).toHaveCount(0);
  await list(page)
    .getByRole("button", { name: /WISE 0855/ })
    .click();
  await expect(panel(page).getByRole("heading", { level: 2 })).toHaveText("WISE 0855−0714");
});

// ------------------------------------------------------------------------------ screenshots

const OUT = process.env.UI_REVIEW_DIR;

for (const vp of [
  { name: "1440x900", width: 1440, height: 900 },
  { name: "390x844", width: 390, height: 844 },
] as const) {
  test(`sky screenshots at ${vp.name}`, async ({ page }) => {
    test.skip(!OUT, "set UI_REVIEW_DIR to save design-review screenshots");
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await openSky(page);
    await hideDevOverlay(page);
    await expect(globe(page)).toHaveAttribute("data-texture", "ready", { timeout: 30_000 });
    await page.waitForTimeout(3200);
    await page.screenshot({ path: path.join(OUT!, `sky-globe-${vp.name}.png`) });

    // Close to the surface, looking out over the curve of the globe.
    const box = await page.getByTestId("globe-outline").boundingBox();
    if (box) {
      await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.42);
      for (let i = 0; i < 7; i++) {
        await page.mouse.wheel(0, -240);
        await page.waitForTimeout(90);
      }
      await page.waitForTimeout(2600);
      await page.screenshot({ path: path.join(OUT!, `sky-close-${vp.name}.png`) });
      await page.getByRole("button", { name: "Reset view" }).click();
      await page.waitForTimeout(2600);
    }

    // The bare globe: SPHEREx imagery turned down, catalogue stars and constellations only.
    await page.getByRole("button", { name: "Layers" }).click();
    const imagery = page.getByRole("slider", { name: "SPHEREx imagery opacity" });
    await imagery.focus();
    await page.keyboard.press("Home");
    await page.screenshot({ path: path.join(OUT!, `sky-layers-${vp.name}.png`) });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(900);
    await page.screenshot({ path: path.join(OUT!, `sky-bare-${vp.name}.png`) });
    await page.getByRole("button", { name: "Layers" }).click();
    await imagery.focus();
    await page.keyboard.press("End");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(600);

    await list(page)
      .getByRole("button", { name: /Barnard.s Star/ })
      .click();
    await expect(globe(page)).toHaveAttribute("data-arrived", "t:barnards-star", { timeout: 10_000 });
    await expect(
      panel(page).getByTestId("mini-blink").or(panel(page).getByTestId("bundle-missing")),
    ).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(1600);
    await page.screenshot({ path: path.join(OUT!, `sky-panel-${vp.name}.png`) });

    const scroller = panel(page).locator("[data-lenis-prevent]");
    await scroller.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
    await page.waitForTimeout(1600);
    await page.screenshot({ path: path.join(OUT!, `sky-panel-end-${vp.name}.png`) });

    await page.keyboard.press("Escape");
    await page.waitForTimeout(600);
    await globe(page).focus();
    await page.keyboard.press("Enter");
    await expect(panel(page).getByRole("heading", { level: 2 })).toHaveText("This patch of sky");
    await page.waitForTimeout(1800);
    await page.screenshot({ path: path.join(OUT!, `sky-patch-${vp.name}.png`) });
  });
}
