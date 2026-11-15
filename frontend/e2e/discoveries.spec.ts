// /discoveries with the synthetic fixture (e2e/fixtures/discoveries): the survey summary, the
// false-discovery-rate choice, filters and sorting, the cards and their blink, the detail sheet, the
// known objects found again, a list with no candidates or no file, reduced motion and axe.
// PXH_SHOTS=<folder> also saves screenshots of the page with the real list at desktop and phone sizes.
import path from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { hideDevOverlay, watchPage } from "./helpers";
import { SHOTS_DIR, serveDiscoveries } from "./fixtures/discoveries/serve";

async function open(page: Page) {
  await page.goto("/discoveries");
  await expect(page.getByTestId("discoveries-status")).toHaveAttribute("data-state", "ready");
  await hideDevOverlay(page);
}

const pick = (page: Page, group: string, name: RegExp) => page.getByTestId(group).getByRole("radio", { name });
const ids = (page: Page) => page.getByTestId("candidate-card").evaluateAll((els) => els.map((e) => e.getAttribute("data-id")));

test("summary, false-discovery rate, filters and sorting", async ({ page }) => {
  const log = watchPage(page);
  await serveDiscoveries(page);
  await open(page);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Candidate movers and variables");
  await expect(page.getByTestId("discoveries-status")).toContainText("15 Nov 2026, 03:00 UTC");

  const summary = page.getByTestId("survey-summary");
  await expect(summary).toContainText("SPHEREx fields searched");
  await expect(summary).toContainText("240"); // changes flagged, summed over the fields
  await expect(summary).toContainText("8candidates kept"); // 9 entries, one with impossible values
  await expect(page.getByTestId("dropped-note")).toContainText("One entry");

  // 5% by default: q <= 0.05.
  const cards = page.getByTestId("candidate-card");
  await expect(cards).toHaveCount(4);
  await expect(page.getByTestId("result-count")).toHaveText(/Showing 4 of 8 candidates/);
  await expect(page.getByTestId("fdr-meaning")).toContainText("1 in 20");

  await pick(page, "fdr-choice", /^1%/).click();
  await expect(cards).toHaveCount(1);
  await expect(page.getByTestId("fdr-meaning")).toContainText("1 in 100");
  await pick(page, "fdr-choice", /^20%/).click();
  await expect(cards).toHaveCount(8);
  const qs = await cards.evaluateAll((els) => els.map((e) => Number(e.getAttribute("data-q"))));
  expect(qs).toEqual([...qs].sort((a, b) => a - b));
  expect(Math.max(...qs)).toBeLessThanOrEqual(0.2);

  await pick(page, "kind-filter", /^Moves/).click();
  await expect(cards).toHaveCount(4);
  expect(await cards.evaluateAll((els) => els.every((e) => e.getAttribute("data-kind") === "mover"))).toBe(true);
  await pick(page, "match-filter", /^Known/).click();
  expect(await ids(page)).toEqual(["fx-a-000"]);
  await pick(page, "match-filter", /^New/).click();
  expect(await ids(page)).toEqual(["fx-b-000", "fx-c-000", "fx-c-002"]);
  await page.getByRole("button", { name: "Show all kinds" }).first().click();
  await expect(cards).toHaveCount(8);

  await pick(page, "sort-choice", /^Signal/).click();
  await expect.poll(() => ids(page)).toEqual([
    "fx-a-000",
    "fx-a-001",
    "fx-b-000",
    "fx-b-001",
    "fx-c-000",
    "fx-c-001",
    "fx-c-003",
    "fx-c-002",
  ]);
  await pick(page, "sort-choice", /^Confidence/).click();
  await expect.poll(async () => (await ids(page))[0]).toBe("fx-a-000");

  // An entry with unsafe links keeps its place, without a stamp and with a rebuilt Lab link.
  const unsafe = page.locator('[data-testid="candidate-card"][data-id="fx-c-003"]');
  await expect(unsafe).toContainText("No stamp");
  await expect(unsafe.getByRole("link", { name: /Open in the Lab/ })).toHaveAttribute(
    "href",
    "/explore?ra=280.05000&dec=60.03000&fov=0.1667",
  );

  // Nothing passes: say so and offer a way out.
  await pick(page, "fdr-choice", /^1%/).click();
  await pick(page, "kind-filter", /^Changes brightness/).click();
  await expect(page.getByTestId("no-results")).toBeVisible();
  await page.getByRole("button", { name: /Accept up to 20%/ }).click();
  await expect(cards).toHaveCount(4);

  expect(log.consoleErrors, "console errors").toEqual([]);
});

test("cards blink and pause; the detail sheet; known objects found again", async ({ page }) => {
  const log = watchPage(page);
  await serveDiscoveries(page);
  await open(page);

  const card = page.locator('[data-testid="candidate-card"][data-id="fx-a-000"]');
  await expect(card).toContainText("Possible mover");
  await expect(card).toContainText("in the Synthetic field A field");
  await expect(card).toContainText("Known: Synthetic Star 1 in Gaia DR3");
  await expect(card).toContainText("97%");
  await expect(card).toContainText("0.0040");
  await expect(card).toContainText("42.0");
  await expect(card).toContainText("Moves 2.31 ± 0.12″ a year, towards the north-east.");
  await expect(card.getByRole("link", { name: /Open in the Lab/ })).toHaveAttribute(
    "href",
    "/explore?ra=10.10000&dec=20.20000&fov=0.1667",
  );
  await expect(page.locator('[data-testid="candidate-card"][data-id="fx-b-000"]')).toContainText(
    "New: no catalogued source close enough",
  );

  // The blink flips every stamp together, and pauses.
  const list = page.getByTestId("candidate-list");
  const phase = () => list.getAttribute("data-phase");
  await expect.poll(phase, { timeout: 5000 }).toBe("1");
  await expect.poll(phase, { timeout: 5000 }).toBe("0");
  await page.getByTestId("blink-toggle").click();
  await expect(page.getByTestId("blink-toggle")).toHaveAttribute("aria-pressed", "true");
  const held = await phase();
  await page.waitForTimeout(1300);
  expect(await phase()).toBe(held);

  // Details: large panels, the four class probabilities, every measurement.
  await card.getByRole("button", { name: "Details", exact: true }).click();
  const sheet = page.getByTestId("candidate-sheet");
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("heading", { name: "Possible mover" })).toBeVisible();
  const probs = sheet.getByTestId("class-probabilities").getByRole("listitem");
  await expect(probs).toHaveCount(4);
  await expect(probs.nth(0)).toContainText(/Mover\s*95%/);
  await expect(probs.nth(1)).toContainText(/Changes brightness\s*2%/);
  await expect(probs.nth(2)).toContainText(/Artifact\s*1%/);
  await expect(probs.nth(3)).toContainText(/Nothing\s*2%/);
  await expect(sheet).toContainText("2.31 ± 0.12″ a year, towards 45° (north-east), from 4 visits");
  await expect(sheet).toContainText("1 May 2025 and 1 May 2026, 365 days apart");
  await expect(sheet).toContainText("catalogue motion 2.25″ a year");
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();

  // Known objects found again: the known mover in the list, then the targets (found, not passed, absent).
  const strip = page.getByTestId("found-again");
  await expect(strip).toContainText("2 of 4 found again.");
  const items = strip.getByTestId("found-item");
  expect(await items.evaluateAll((els) => els.map((e) => e.getAttribute("data-outcome")))).toEqual([
    "found",
    "found",
    "missed",
    "absent",
  ]);
  await expect(items.nth(1)).toContainText("Found again as a mover");
  await expect(items.nth(2)).toContainText("q 0.090, needs 0.05 or less");
  await expect(items.nth(3)).toContainText("No candidate within 30″");

  await expect(page.getByRole("link", { name: "How sure are we?" })).toHaveAttribute("href", "/how-it-works");
  expect(log.consoleErrors, "console errors").toEqual([]);
});

test("no candidates yet, or no list at all: the search is still running", async ({ page }) => {
  await serveDiscoveries(page, "empty.json");
  await page.goto("/discoveries");
  await expect(page.getByTestId("discoveries-status")).toHaveAttribute("data-state", "empty");
  await expect(page.getByTestId("still-running")).toContainText("The automatic search is still running");
  await expect(page.getByTestId("candidate-card")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "How the list is made" })).toBeVisible();

  await page.unrouteAll({ behavior: "ignoreErrors" });
  await serveDiscoveries(page, null);
  await page.goto("/discoveries");
  await expect(page.getByTestId("discoveries-status")).toHaveAttribute("data-state", "missing");
  await expect(page.getByTestId("still-running")).toBeVisible();
});

test("reduced motion: panels side by side, nothing blinks", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await serveDiscoveries(page);
  await open(page);
  const card = page.locator('[data-testid="candidate-card"][data-id="fx-a-000"]');
  await expect(card.locator('[aria-hidden="true"].aspect-square')).toHaveCount(3);
  await expect(page.getByTestId("blink-toggle")).toHaveCount(0);
  await page.waitForTimeout(1200);
  expect(await page.getByTestId("candidate-list").getAttribute("data-phase")).toBeNull();
});

for (const vp of [
  { name: "desktop", width: 1440, height: 900 },
  { name: "phone", width: 390, height: 844 },
]) {
  test(`/discoveries has no serious or critical axe violations (${vp.name})`, async ({ page }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await serveDiscoveries(page);
    await open(page);
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    const blocking = results.violations
      .filter((v) => v.impact === "serious" || v.impact === "critical")
      .map((v) => `${v.id}: ${v.nodes.slice(0, 4).map((n) => n.target.join(" ")).join(", ")}`);
    expect(blocking).toEqual([]);
  });

  test(`screenshot with the real list (${vp.name})`, async ({ page }) => {
    test.skip(!SHOTS_DIR, "PXH_SHOTS is not set");
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.goto("/discoveries");
    await expect(page.getByTestId("discoveries-status")).not.toHaveAttribute("data-state", "loading");
    await hideDevOverlay(page);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(SHOTS_DIR, `discoveries-${vp.name}.png`), fullPage: true });
    const first = page.getByTestId("candidate-card").first();
    if (await first.count()) {
      await first.getByRole("button", { name: "Details", exact: true }).click();
      await expect(page.getByTestId("candidate-sheet")).toBeVisible();
      await page.waitForTimeout(600);
      await page.screenshot({ path: path.join(SHOTS_DIR, `discoveries-sheet-${vp.name}.png`) });
    }
  });
}
