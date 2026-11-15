// Sky mode (/sky): the globe of real stars loads with the full catalogue, a star chosen from the
// lists or the search opens its panel with the catalogue's numbers, the 3D space view unfolds and
// folds back, a star selected in 3D space is in focus (the rest dim) until Esc, the explanation
// words over the globe take the pointer, empty sky (by keyboard) is described specifically, the
// challenge targets still open their bundles, phones get a bottom sheet, and a browser without
// WebGL gets the flat map.
// Design-review screenshots are opt-in: UI_REVIEW_DIR=/some/dir pnpm test:e2e sky
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { DESKTOP_LAYOUT, hideDevOverlay, watchPage } from "./helpers";

// Per-target bundles may still be building (404 until then); nothing else may fail.
const PENDING_DATA = /\/bundles\/[^/]+\/manifest\.json/;
const unexpected = (lines: string[]) => lines.filter((l) => !PENDING_DATA.test(l));

const globe = (page: Page) => page.getByTestId("sky-globe");
const rail = (page: Page) => page.getByTestId("sky-rail");
const panel = (page: Page) => page.getByTestId("sky-panel");

async function openSky(page: Page, url = "/sky") {
  const response = await page.goto(url);
  expect(response?.status()).toBe(200);
  await expect(globe(page).locator("canvas")).toBeVisible();
  // The full Hipparcos catalogue: 117,955 stars in three tiers.
  // While tiers load it reads "8,870 of 117,955 stars from Hipparcos, loading".
  await expect(rail(page).getByTestId("stars-loaded")).toHaveText(/^117,955 stars from/, { timeout: 30_000 });
}

test("/sky draws the stars and lists the challenge targets", async ({ page, isMobile }) => {
  test.skip(isMobile, DESKTOP_LAYOUT);
  const log = watchPage(page);
  await openSky(page);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Every star you can click");
  await expect(globe(page)).toHaveAttribute("data-texture", "ready");
  await expect(globe(page)).toHaveAttribute("data-map", "off"); // just the dots by default
  const targets = page.getByTestId("target-list").getByRole("button");
  await expect(targets).toHaveCount(5);
  for (const name of ["Barnard's Star", "Epsilon Indi B", "WISE 0855−0714", "RW Aurigae", "R Draconis"]) {
    await expect(page.getByTestId("target-list").getByRole("button", { name: new RegExp(name.replace(/[−']/g, ".")) })).toBeVisible();
  }
  await page.waitForTimeout(800);
  expect(unexpected(log.badResponses), "HTTP errors").toEqual([]);
  expect(unexpected(log.consoleErrors), "console errors").toEqual([]);
});

test("a star from the Brightest list opens its panel with the catalogue's numbers", async ({ page, isMobile }) => {
  test.skip(isMobile, DESKTOP_LAYOUT);
  await openSky(page);
  await rail(page).getByRole("tab", { name: "Brightest" }).click();
  const sirius = rail(page).getByTestId("rail-star").filter({ hasText: "Sirius" });
  await sirius.click();

  await expect(page).toHaveURL(/[?&]star=32349\b/);
  const heading = panel(page).getByRole("heading", { level: 2 });
  await expect(heading).toHaveText("Sirius");
  await expect(heading).toBeFocused();
  await expect(panel(page).getByTestId("star-designations")).toContainText("HIP 32349");
  await expect(panel(page).getByTestId("star-designations")).toContainText("Canis Major");
  // 379.21 mas -> 8.6 light-years
  await expect(panel(page).getByTestId("fact-distance")).toContainText("light-years");
  await expect(panel(page).getByTestId("fact-distance").locator("number-flow-react").first()).toHaveAttribute(
    "aria-label",
    "8.6",
  );
  await expect(panel(page).getByTestId("see-in-spherex")).toHaveAttribute(
    "href",
    /^\/explore\?ra=101\.\d+&dec=-16\.\d+&fov=0\.1667$/,
  );
  await expect(globe(page)).toHaveAttribute("data-arrived", /^s:\d+$/, { timeout: 10_000 });

  await page.keyboard.press("Escape");
  await expect(panel(page)).toHaveCount(0);
  await expect(sirius).toBeFocused();
  await expect(page).not.toHaveURL(/star=/);
});

test("search finds a star by HIP number, and a challenge target by name", async ({ page }) => {
  await openSky(page);
  const search = page.getByTestId("star-search");
  await search.fill("HIP 87937");
  await expect(page.getByTestId("search-results").getByRole("option").first()).toContainText("Barnard");
  await search.press("Enter");
  await expect(panel(page).getByRole("heading", { level: 2 })).toHaveText(/Barnard/);
  await expect(panel(page).getByTestId("fact-motion")).toContainText("a year");
  // It is also one of the five: the panel offers its SPHEREx bundle.
  await panel(page).getByRole("button", { name: /One of the five challenge targets/ }).click();
  await expect(page).toHaveURL(/[?&]target=barnards-star\b/);
  await expect(panel(page).getByTestId("target-story")).toBeVisible();

  await search.fill("wise 0855");
  await search.press("Enter");
  await expect(panel(page).getByRole("heading", { level: 2 })).toHaveText("WISE 0855−0714");
});

test("3D space: the stars unfold around the Sun and fold back", async ({ page, isMobile }) => {
  test.skip(isMobile, DESKTOP_LAYOUT);
  await openSky(page);
  await page.getByTestId("mode-space").click();
  await expect(page).toHaveURL(/[?&]mode=3d\b/);
  await expect(globe(page)).toHaveAttribute("data-mode", "space", { timeout: 10_000 });
  await expect(page.getByTestId("space-sun").getByText("Sun", { exact: true })).toBeVisible();
  await expect(page.getByTestId("space-legend")).toContainText("log scale");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("The stars around the Sun");

  // A star chosen in 3D flies the camera to it.
  await page.getByTestId("star-search").fill("Vega");
  await page.getByTestId("star-search").press("Enter");
  await expect(panel(page).getByRole("heading", { level: 2 })).toHaveText("Vega");
  await expect(globe(page)).toHaveAttribute("data-arrived", /^s:\d+$/, { timeout: 10_000 });

  await page.getByTestId("mode-sphere").click();
  await expect(globe(page)).toHaveAttribute("data-mode", "sphere", { timeout: 10_000 });
  await expect(page).not.toHaveURL(/mode=3d/);
});

test("3D space: a selected star stays lit while the rest dim, with its distance on the line from the Sun", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, DESKTOP_LAYOUT);
  await openSky(page, "/sky?star=32349&mode=3d");
  await expect(panel(page).getByRole("heading", { level: 2 })).toHaveText("Sirius");
  await expect(globe(page)).toHaveAttribute("data-arrived", /^s:\d+$/, { timeout: 15_000 });
  await expect(globe(page)).toHaveAttribute("data-dim", "on");
  // Hipparcos parallax 379.21 mas: 8.6 light-years, as in the panel. (The line and its label are
  // placed every frame; their anchors have no size, so visibility is what says they are shown.)
  const line = page.getByTestId("space-line");
  const lineLabel = page.getByTestId("space-line-label");
  await expect(lineLabel).toHaveText("8.6 light-years");
  await expect(lineLabel).toHaveCSS("visibility", "visible");
  await expect(line).toHaveCSS("visibility", "visible");

  // Esc clears the selection and the stars come back.
  await page.keyboard.press("Escape");
  await expect(panel(page)).toHaveCount(0);
  await expect(globe(page)).toHaveAttribute("data-dim", "off");
  await expect(line).toHaveCSS("visibility", "hidden");
});

// The globe's canvas lies under the rail, the intro and the panel: every explanation word over it
// must take the pointer itself (not the canvas below), and open its explanation on screen.
for (const url of ["/sky", "/sky?star=32349"]) {
  test(`explanation words over the globe take the pointer (${url})`, async ({ page }) => {
    await openSky(page, url);
    if (url.includes("star=")) await expect(panel(page).getByRole("heading", { level: 2 })).toHaveText("Sirius");
    await hideDevOverlay(page);
    await page.waitForTimeout(800); // the panel has slid in
    const terms = await page.evaluate(() => {
      // Seen: inside the window and inside every scrolling box round it.
      const seen = (el: Element, x: number, y: number) => {
        if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return false;
        for (let a = el.parentElement; a; a = a.parentElement) {
          const s = getComputedStyle(a);
          if (s.overflowX === "visible" && s.overflowY === "visible") continue;
          const r = a.getBoundingClientRect();
          if (x < r.left || x > r.right || y < r.top || y > r.bottom) return false;
        }
        return true;
      };
      return [...document.querySelectorAll<HTMLElement>("[data-term]")].flatMap((el) => {
        const r = el.getBoundingClientRect();
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        if (!r.width || !r.height || getComputedStyle(el).visibility === "hidden" || !seen(el, x, y)) return [];
        const hit = document.elementFromPoint(x, y);
        const on = hit ? `${hit.tagName.toLowerCase()}.${String(hit.className).split(" ")[0]}` : "nothing";
        return [{ k: el.dataset.term!, text: el.textContent ?? "", x, y, hit: !!hit && el.contains(hit), on }];
      });
    });
    expect(terms.length, "explanation words on the page").toBeGreaterThan(0);
    for (const t of terms) {
      expect(t.hit, `"${t.text}" (${t.k}) lies under ${t.on}`).toBe(true);
      await page.mouse.move(t.x, t.y);
      const tip = page.locator(`[data-term-tip="${t.k}"]:not([data-state=closed])`);
      await expect(tip, `the explanation of "${t.text}" opens`).toBeVisible();
      await expect(tip, `the explanation of "${t.text}" is on screen`).toBeInViewport({ ratio: 1 });
      // Away to empty sky, so the next word opens on its own.
      await page.mouse.move(760, 120);
      await expect(tip).toHaveCount(0);
    }
  });
}

test("empty sky by keyboard: Enter describes the spot at the centre, specifically", async ({ page }) => {
  await openSky(page);
  await page.waitForTimeout(3000); // entrance flight settles
  await globe(page).focus();
  await page.keyboard.press("Enter");
  const story = panel(page).getByTestId("spot-story");
  await expect(story).toBeVisible();
  const heading = await story.getByTestId("spot-heading").textContent();
  expect(heading).not.toBe("This patch of sky");
  await expect(story.getByTestId("spot-constellation")).toContainText("constellation");
  const ra1 = Number(await story.getByTestId("spot-ra").getAttribute("data-value"));
  const dec1 = Number(await story.getByTestId("spot-dec").getAttribute("data-value"));
  expect(ra1).toBeGreaterThanOrEqual(0);
  expect(ra1).toBeLessThan(360);
  expect(Math.abs(dec1)).toBeLessThanOrEqual(90);
  await expect(story.getByTestId("spot-nearest").getByRole("button")).toHaveCount(6);
  await expect(story.getByTestId("watch-patch")).toHaveAttribute("href", /^\/explore\?ra=\d+\.\d+&dec=-?\d+\.\d+&fov=0\.1667$/);

  // Somewhere else, something else.
  await globe(page).focus();
  for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowUp");
  await page.waitForTimeout(1800);
  await page.keyboard.press("Enter");
  await expect
    .poll(async () => Number(await panel(page).getByTestId("spot-dec").getAttribute("data-value")))
    .toBeGreaterThan(dec1 + 10);
  expect(await panel(page).getByTestId("spot-heading").textContent()).not.toBe(heading);

  // A nearby star in the list opens that star.
  await panel(page).getByTestId("spot-nearest").getByRole("button").first().click();
  await expect(panel(page).getByTestId("star-story")).toBeVisible();
});

test("a deep link opens a challenge target, with its Lab link", async ({ page }) => {
  await page.goto("/sky?target=r-dra");
  await expect(panel(page).getByRole("heading", { level: 2 })).toHaveText("R Draconis");
  await expect(panel(page).getByRole("link", { name: /Open in the Lab/ })).toHaveAttribute("href", "/explore?target=r-dra");
});

test("on a phone the panel is a bottom sheet", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openSky(page);
  await page.getByTestId("star-search").fill("Betelgeuse");
  await page.getByTestId("star-search").press("Enter");
  await expect(panel(page)).toHaveAttribute("data-layout", "sheet");
  await expect(panel(page).getByRole("heading", { level: 2 })).toHaveText("Betelgeuse");
});

test("without WebGL the flat map and the lists still work", async ({ page, isMobile }) => {
  test.skip(isMobile, DESKTOP_LAYOUT);
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    // @ts-expect-error narrowing the overloads is not needed for this stub
    HTMLCanvasElement.prototype.getContext = function (type: string, ...rest: unknown[]) {
      return /webgl/i.test(type) ? null : (original as (...args: unknown[]) => unknown).call(this, type, ...rest);
    };
  });
  await page.goto("/sky");
  await expect(page.getByTestId("sky-flat-map")).toBeVisible();
  await page.getByTestId("target-list").getByRole("button", { name: /R Draconis/ }).click();
  await expect(panel(page).getByRole("heading", { level: 2 })).toHaveText("R Draconis");
});

// ------------------------------------------------------------------------------ screenshots

const OUT = process.env.UI_REVIEW_DIR;

for (const vp of [
  { name: "1440x900", width: 1440, height: 900 },
  { name: "390x844", width: 390, height: 844 },
] as const) {
  test(`sky screenshots at ${vp.name}`, async ({ page }) => {
    test.skip(!OUT, "set UI_REVIEW_DIR to save design-review screenshots");
    test.setTimeout(180_000);
    const api = process.env.SKY_API_URL ?? "https://perturbation-api.vercel.app";
    await page.addInitScript((url) => {
      try {
        localStorage.setItem("pxh:api", url);
      } catch {
        // no storage: the panels say live data is off
      }
    }, api);
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await openSky(page);
    await hideDevOverlay(page);
    await page.waitForTimeout(3500);
    await page.screenshot({ path: path.join(OUT!, `sky-globe-${vp.name}.png`) });

    await page.getByTestId("star-search").fill("Betelgeuse");
    await page.getByTestId("star-search").press("Enter");
    await expect(globe(page)).toHaveAttribute("data-arrived", /^s:\d+$/, { timeout: 10_000 });
    await page.waitForTimeout(6000); // live data arrives
    await page.screenshot({ path: path.join(OUT!, `sky-star-${vp.name}.png`) });

    await page.keyboard.press("Escape");
    await globe(page).focus();
    await page.keyboard.press("Enter");
    await expect(panel(page).getByTestId("spot-story")).toBeVisible();
    await page.waitForTimeout(6000);
    await page.screenshot({ path: path.join(OUT!, `sky-empty-${vp.name}.png`) });

    await page.keyboard.press("Escape");
    await page.getByTestId("mode-space").click();
    await expect(globe(page)).toHaveAttribute("data-mode", "space", { timeout: 10_000 });
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(OUT!, `sky-3d-${vp.name}.png`) });

    await page.getByTestId("star-search").fill("Sirius");
    await page.getByTestId("star-search").press("Enter");
    await expect(globe(page)).toHaveAttribute("data-arrived", /^s:\d+$/, { timeout: 10_000 });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(OUT!, `sky-3d-star-${vp.name}.png`) });
  });
}
