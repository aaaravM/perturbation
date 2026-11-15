// The spectral classifier's answer in the Sky star panel and the Lab's Spectrum tab. The live API may not
// classify yet, so these tests take its real quick-look response and add a `classification` object in the
// shape of docs/api-contract.md ("What kind of object"). The values are test fixtures, never shown as data.
import { expect, test, type Page, type Route } from "@playwright/test";
import { hideDevOverlay } from "./helpers";

const OK = {
  status: "ok",
  label: "cool_star",
  label_text: "cool star",
  probs: { hot_star: 0.01, sunlike_star: 0.12, cool_star: 0.82, brown_dwarf: 0.02, young_dusty: 0.02, galaxy: 0.005, quasar: 0.005 },
  confidence: 0.82,
  anomaly: { score: 41.2, p_value: 0.31, unusual: false },
  model: "specclass-v1",
  channels_used: 100,
  caveats: [],
};

const UNUSUAL = {
  ...OK,
  label: "young_dusty",
  label_text: "young or dusty star",
  probs: { hot_star: 0.25, sunlike_star: 0.0, cool_star: 0.04, brown_dwarf: 0.31, young_dusty: 0.4, galaxy: 0.0, quasar: 0.0 },
  confidence: 0.4,
  anomaly: { score: 337.3, p_value: 0.0065, unusual: true },
};

const NONE = {
  status: "none",
  reason: "Only 9 of 100 channels have a complete measurement; the classifier needs 60. The cube blanks the centres of bright, saturated stars.",
  model: "specclass-v1",
  channels_used: 9,
};

/** Answer /api/spectrum/quick, and the spectrum part of /api/object, with the live spectrum plus the given classification. */
async function classifyAs(page: Page, classification: object) {
  await page.route(/\/api\/spectrum\/quick\?/, async (route: Route) => {
    const res = await route.fetch();
    const body = res.ok() ? await res.json() : null;
    if (!body) return route.fulfill({ response: res });
    await route.fulfill({ response: res, json: { ...body, classification } });
  });
  await page.route(/\/api\/object\?/, async (route: Route) => {
    const res = await route.fetch();
    const body = res.ok() ? await res.json() : null;
    const sp = body?.spectrum;
    if (!sp || typeof sp !== "object" || (sp.status && sp.status !== "ok")) return route.fulfill({ response: res });
    await route.fulfill({ response: res, json: { ...body, spectrum: { ...sp, classification } } });
  });
}

/** Open the Lab's Spectrum tab, clicking again if the first click came before the page was interactive. */
async function openSpectrumTab(page: Page) {
  const tab = page.getByTestId("analysis-tab-spectrum");
  await expect(async () => {
    await tab.click();
    await expect(tab).toHaveAttribute("aria-selected", "true", { timeout: 2_000 });
  }).toPass({ timeout: 60_000 });
}

test("the Sky star panel says what kind of object the spectrum looks like", async ({ page }) => {
  test.setTimeout(150_000);
  await classifyAs(page, OK);
  await page.goto("/sky?star=1"); // HIP 1, faint enough for a usable quick look
  await hideDevOverlay(page);
  const view = page.getByTestId("sky-panel").getByTestId("spectral-class");
  await expect(view).toBeVisible({ timeout: 45_000 });
  await expect(view).toContainText("From its SPHEREx spectrum, this looks most like a cool star (82% confidence).");
  await expect(view.getByRole("listitem")).toHaveCount(3);
  await expect(view.getByRole("listitem").first()).toContainText("Cool star");
  await expect(view.getByTestId("spectral-class-unusual")).toHaveCount(0);
  await view.scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/spectral-class/sky-panel.png" });
});

test("the Lab's Spectrum tab compares the answer with the catalogues and flags unusual spectra", async ({ page }) => {
  test.setTimeout(150_000);
  await classifyAs(page, UNUSUAL);
  await page.goto("/explore?target=eps-indi-b");
  await hideDevOverlay(page);
  await openSpectrumTab(page);
  const view = page.getByTestId("lab-class");
  await expect(view).toBeVisible({ timeout: 45_000 });
  await expect(view).toContainText("looks most like a young or dusty star (40% confidence)");
  await expect(view.getByTestId("lab-class-unusual")).toContainText("Unusual spectrum");
  await expect(view.getByTestId("lab-class-catalogue")).toHaveText(
    "Catalogues list Epsilon Indi B as a brown dwarf, so the network is wrong here. It learned from only a few dozen brown dwarf spectra.",
  );
  await page.getByTestId("lab-spectral-class").screenshot({ path: "test-results/spectral-class/lab-tab.png" });
});

test("a saturated star gets a plain reason instead of a class", async ({ page }) => {
  test.setTimeout(150_000);
  await classifyAs(page, NONE);
  await page.goto("/explore?target=barnards-star");
  await hideDevOverlay(page);
  await openSpectrumTab(page);
  await expect(page.getByTestId("lab-class-none")).toContainText("No class from this spectrum. Only 9 of 100 channels");
});

test("a backend without the classifier shows no class section", async ({ page }) => {
  test.setTimeout(150_000);
  await page.route(/\/api\/spectrum\/quick\?/, async (route: Route) => {
    const res = await route.fetch();
    const body = res.ok() ? await res.json() : {};
    delete body.classification;
    await route.fulfill({ response: res, json: body });
  });
  await page.goto("/explore?target=eps-indi-b");
  await hideDevOverlay(page);
  const answered = page.waitForResponse(/\/api\/spectrum\/quick\?/, { timeout: 90_000 });
  await openSpectrumTab(page);
  await answered;
  await expect(page.getByTestId("lab-spectral-class")).toHaveCount(0);
});
