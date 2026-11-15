// Settings: each choice applies at once, survives a reload, reaches the page it is for, and can
// be reset per section. Also the Data and privacy list and the live API check.

import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const choice = (page: Page, group: string, name: string | RegExp) =>
  page.getByTestId(group).getByRole("radio", { name });

async function openSettings(page: Page) {
  const response = await page.goto("/settings");
  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
  // Hydrated: the storage list is read on the client only.
  await expect(page.getByTestId("stored-empty").or(page.getByTestId("stored-list"))).toBeVisible();
}

const storedPrefs = (page: Page) =>
  page.evaluate(() => JSON.parse(window.localStorage.getItem("pxh:prefs") ?? "null")?.prefs ?? null);

test("glass: Off applies at once, survives a reload and resets with its section", async ({ page }) => {
  await openSettings(page);
  const html = page.locator("html");
  await expect(html).toHaveAttribute("data-glass", "full");

  await choice(page, "pref-glass", "Off").click();
  // "Saved" shows for about two seconds, so it is checked first.
  await expect(page.locator("#appearance").getByText("Saved")).toBeVisible();
  await expect(html).toHaveAttribute("data-glass", "off");
  await expect(choice(page, "pref-glass", "Off")).toHaveAttribute("aria-checked", "true");
  // The top bar is a solid panel now.
  const bar = page.locator(".site-nav__bar");
  await expect.poll(() => bar.evaluate((el) => getComputedStyle(el).backdropFilter)).toBe("none");
  expect(await storedPrefs(page)).toEqual({ glass: "off" });

  await page.reload();
  await expect(html).toHaveAttribute("data-glass", "off");
  await expect(choice(page, "pref-glass", "Off")).toHaveAttribute("aria-checked", "true");

  await page.locator("#appearance").getByRole("button", { name: "Reset" }).click();
  await expect(html).toHaveAttribute("data-glass", "full");
  await expect(page.locator("#appearance").getByText("Back to the defaults")).toBeVisible();
  expect(await storedPrefs(page)).toBeNull();
});

test("explanation marks: switching them off hides the ? after explained words", async ({ page }) => {
  await openSettings(page);
  await page.getByTestId("pref-term-marks").click();
  await expect(page.locator("html")).toHaveAttribute("data-term-marks", "false");

  await page.goto("/sky");
  const marks = page.locator("[data-term-mark]");
  await expect(marks.first()).toBeAttached();
  await expect(marks.first()).toBeHidden();
});

test("lab: the first detector and blink speed apply where the link names none", async ({ page }) => {
  await openSettings(page);
  // By value: "Colour" also mentions D3 in its description.
  await page.getByTestId("pref-detector").locator('[role="radio"][value="D3"]').click();
  const thumb = page.getByTestId("pref-blink").getByRole("slider");
  await thumb.focus();
  for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowLeft"); // 500 → 300 ms
  await expect(page.locator("#lab").getByText("300 ms")).toBeVisible();
  expect(await storedPrefs(page)).toEqual({ labDetector: "D3", labBlinkMs: 300 });

  await page.goto("/explore?target=barnards-star");
  await expect(page.locator('[data-det="D3"]').first()).toHaveAttribute("aria-checked", "true", { timeout: 60_000 });
  await expect(page.getByText("300 ms", { exact: true })).toBeVisible();

  // A detector in the link still wins.
  await page.goto("/explore?target=barnards-star&det=D5");
  await expect(page.locator('[data-det="D5"]').first()).toHaveAttribute("aria-checked", "true", { timeout: 60_000 });
});

test("sky: start in 3D space with the SPHEREx map on", async ({ page }) => {
  await openSettings(page);
  await choice(page, "pref-start-in", "3D space").click();
  await page.getByTestId("pref-infrared").click();
  expect(await storedPrefs(page)).toEqual({ skyStartIn: "3d", skyInfraredMap: true });

  await page.goto("/sky");
  const globe = page.getByTestId("sky-globe");
  await expect(globe).toHaveAttribute("data-mode", "space", { timeout: 30_000 });
  await expect(globe).not.toHaveAttribute("data-map", "off");

  // Back to the sphere here: the choice holds for this visit.
  await page.getByTestId("mode-sphere").click();
  await expect(globe).toHaveAttribute("data-mode", "sphere", { timeout: 10_000 });
});

test("data and privacy lists what is stored and clears it; the API check answers", async ({ page }) => {
  await openSettings(page);
  await expect(page.getByTestId("stored-empty")).toBeVisible();
  await choice(page, "pref-motion", "Reduce").click();
  await expect(page.locator("html")).toHaveAttribute("data-motion", "reduce");

  const list = page.getByTestId("stored-list");
  await expect(list.getByText("Your settings")).toBeVisible();
  await list.getByRole("button", { name: "Clear Your settings" }).click();
  await expect(page.getByTestId("stored-empty")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-motion", "system");
  expect(await storedPrefs(page)).toBeNull();

  // The live check ends one way or the other, and says so in words.
  await expect(page.getByTestId("connection-status")).toHaveAttribute("data-state", /^(ok|error|none)$/, {
    timeout: 20_000,
  });
});

for (const vp of [
  { name: "desktop", width: 1440, height: 900 },
  { name: "phone", width: 390, height: 844 },
]) {
  test(`/settings has no serious or critical axe violations (${vp.name})`, async ({ page }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await openSettings(page);
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    const blocking = results.violations
      .filter((v) => v.impact === "serious" || v.impact === "critical")
      .map((v) => `${v.id}: ${v.nodes.slice(0, 4).map((n) => n.target.join(" ")).join(", ")}`);
    expect(blocking).toEqual([]);
  });
}
