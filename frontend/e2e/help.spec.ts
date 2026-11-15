// /help with the synthetic fixture (e2e/fixtures/discoveries): the review queue (keys 1 to 4, a known
// object as every fifth item with feedback and a score, the difference view), the votes kept in
// localStorage and their CSV and JSON downloads, practice on the three examples when there are no
// candidates, reduced motion and axe.
// PXH_SHOTS=<folder> also saves screenshots of the page with the real list at desktop and phone sizes.
import fs from "node:fs";
import path from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { hideDevOverlay, watchPage } from "./helpers";
import { SHOTS_DIR, serveDiscoveries } from "./fixtures/discoveries/serve";

async function openQueue(page: Page) {
  await page.goto("/help");
  await hideDevOverlay(page);
  const queue = page.getByTestId("review-queue");
  await expect(queue).toBeVisible();
  await queue.scrollIntoViewIfNeeded();
  await expect(queue).toHaveAttribute("data-keys", "on");
  return queue;
}

const stored = (page: Page) =>
  page.evaluate(() => JSON.parse(window.localStorage.getItem("pxh:votes") ?? "null") as { v: number; votes: Record<string, unknown>[] } | null);

test("review queue: keys and clicks, a check every fifth item, votes saved, downloaded and cleared", async ({ page }) => {
  const log = watchPage(page);
  await serveDiscoveries(page);
  const queue = await openQueue(page);
  await expect(queue).toHaveAttribute("data-mode", "review");
  await expect(page.getByTestId("queue-intro")).toContainText("8 images");
  const progress = page.getByTestId("queue-progress");
  await expect(progress).toHaveText(/Item 1 of 8/);

  await page.keyboard.press("1");
  await expect(progress).toHaveText(/Item 2 of 8/);
  await expect(page.getByTestId("queue-saved")).toContainText("it moves");
  await expect(page.getByTestId("queue-saved")).toContainText("The model said it moves (97% sure it is real)");
  await page.getByTestId("answer-brightness").click();
  await page.getByTestId("answer-unsure").click();
  await page.keyboard.press("2");

  // The fifth item is a known object: feedback, a score, and Enter goes on.
  await expect(progress).toHaveText(/Item 5 of 8/);
  await page.keyboard.press("1");
  const feedback = page.getByTestId("queue-feedback");
  await expect(feedback).toHaveAttribute("data-result", "right");
  await expect(feedback).toContainText("That was a check: Synthetic Target A.");
  await expect(page.getByTestId("queue-score")).toContainText("Checks right: 1 of 1");
  await expect(page.getByTestId("queue-next")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(progress).toHaveText(/Item 6 of 8/);

  // The difference, by key and by button; speed and pause.
  const viewer = page.getByTestId("review-viewer");
  await expect(viewer).toHaveAttribute("data-view", "blink");
  await page.keyboard.press("d");
  await expect(viewer).toHaveAttribute("data-view", "difference");
  await page.getByTestId("queue-difference").click();
  await expect(viewer).toHaveAttribute("data-view", "blink");
  await page.getByTestId("queue-speed").getByRole("radio", { name: "Fast" }).click();
  await expect(page.getByTestId("queue-speed").getByRole("radio", { name: "Fast" })).toBeChecked();
  await page.getByTestId("queue-play").click();
  await expect(page.getByTestId("queue-play")).toHaveAttribute("aria-pressed", "true");

  const saved = await stored(page);
  expect(saved?.v).toBe(1);
  expect(saved?.votes).toHaveLength(5);
  expect(saved?.votes[0]).toMatchObject({ id: "fx-a-000", answer: "moves", source: "candidate", model: "mover" });
  expect(saved?.votes[1]).toMatchObject({ id: "fx-a-001", answer: "brightness" });
  expect(saved?.votes[2]).toMatchObject({ id: "fx-b-000", answer: "unsure" });
  expect(saved?.votes[4]).toMatchObject({ id: "fx-a-target-000", source: "check", expected: "moves", correct: true });
  expect(saved?.votes[0].run).toBe("2026-11-15T03:00:00Z");
  await expect(page.getByTestId("vote-count")).toContainText("4 candidates reviewed, 1 of 1 known objects right.");

  // Downloads.
  const [csv] = await Promise.all([page.waitForEvent("download"), page.getByTestId("export-csv").click()]);
  expect(csv.suggestedFilename()).toMatch(/^planet-x-hunter-answers-\d{4}-\d{2}-\d{2}\.csv$/);
  const rows = fs.readFileSync(await csv.path(), "utf8").trim().split(/\r?\n/);
  expect(rows[0]).toBe("id,source,answer,expected,correct,model,run,answered_at");
  expect(rows).toHaveLength(6);
  expect(rows[5]).toMatch(/^fx-a-target-000,check,moves,moves,true,mover,2026-11-15T03:00:00Z,/);
  const [json] = await Promise.all([page.waitForEvent("download"), page.getByTestId("export-json").click()]);
  const body = JSON.parse(fs.readFileSync(await json.path(), "utf8"));
  expect(body.version).toBe(1);
  expect(body.votes).toHaveLength(5);

  // Answers survive a reload, and Clear asks first.
  await page.reload();
  await expect(page.getByTestId("vote-count")).toContainText("4 candidates reviewed");
  await page.getByTestId("clear-votes").click();
  await page.getByTestId("clear-confirm").click();
  await expect(page.getByTestId("vote-count")).toHaveText("No answers saved yet.");
  expect(await stored(page)).toBeNull();
  expect(log.consoleErrors, "console errors").toEqual([]);
});

test("no candidates: practice on the three real examples, with feedback", async ({ page }) => {
  await serveDiscoveries(page, "empty.json");
  const queue = await openQueue(page);
  await expect(queue).toHaveAttribute("data-mode", "practice");
  await expect(page.getByTestId("queue-intro")).toContainText("still running");
  await expect(page.getByTestId("example")).toHaveCount(3);
  const progress = page.getByTestId("queue-progress");
  await expect(progress).toHaveText(/Example 1 of 3/);

  // Barnard's Star moves: a wrong answer says so and gives the right one.
  await page.keyboard.press("2");
  const feedback = page.getByTestId("queue-feedback");
  await expect(feedback).toHaveAttribute("data-result", "wrong");
  await expect(feedback).toContainText("The answer is it moves; you said it changes brightness.");
  await expect(page.getByTestId("queue-score")).toContainText("0 of 1");
  await page.getByTestId("queue-next").click();

  await page.keyboard.press("2"); // RW Aurigae fades
  await expect(feedback).toHaveAttribute("data-result", "right");
  await page.keyboard.press("Enter");
  await page.keyboard.press("3"); // the ring is a ghost: nothing real
  await expect(feedback).toHaveAttribute("data-result", "right");
  await expect(feedback).toContainText("probably a ghost");
  await page.getByTestId("queue-next").click();
  await expect(page.getByTestId("queue-finished")).toContainText("You got 2 of 3 right.");

  const saved = await stored(page);
  expect(saved?.votes.map((v) => [v.id, v.source, v.correct])).toEqual([
    ["example-barnards-star", "practice", false],
    ["example-rw-aur", "practice", true],
    ["example-eps-indi-ghost", "practice", true],
  ]);
});

test("reduced motion: the images side by side, no blink controls", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await serveDiscoveries(page);
  await openQueue(page);
  await expect(page.getByTestId("review-viewer")).toHaveAttribute("data-view", "side-by-side");
  await expect(page.getByTestId("queue-play")).toHaveCount(0);
  await page.keyboard.press("d");
  await expect(page.getByTestId("review-viewer")).toHaveAttribute("data-view", "difference");
});

for (const vp of [
  { name: "desktop", width: 1440, height: 900 },
  { name: "phone", width: 390, height: 844 },
]) {
  test(`/help has no serious or critical axe violations (${vp.name})`, async ({ page }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await serveDiscoveries(page);
    await openQueue(page);
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
    await page.goto("/help");
    await expect(page.getByTestId("review-queue")).toBeVisible();
    await hideDevOverlay(page);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(SHOTS_DIR, `help-${vp.name}.png`), fullPage: true });
  });
}
