// When IRSA fails, the Explorer must say so and offer a retry, not show a blank or a silently
// substituted (CDS) sky. Tile failures are simulated with request interception.
import path from "node:path";
import { expect, test } from "@playwright/test";
import { hideDevOverlay, watchPage } from "./helpers";

const SPHEREX_TILES = /spherex_allsky_cube\/Norder\d+\/Dir\d+\/Npix\d+/;

test("tile failures show an error with a working retry", async ({ page }) => {
  const log = watchPage(page);
  await page.route(SPHEREX_TILES, (route) => route.fulfill({ status: 404, body: "Not Found" }));
  await page.goto("/explore");

  const error = page.getByTestId("sky-error");
  await expect(error).toBeVisible({ timeout: 30_000 });
  await expect(error).toContainText("did not load");
  await expect(page.getByTestId("sky-status")).toHaveAttribute("data-state", "error");
  if (process.env.UI_REVIEW_DIR) {
    await hideDevOverlay(page);
    await page.screenshot({ path: path.join(process.env.UI_REVIEW_DIR, "explore-error-1440x900.png") });
  }

  await page.unroute(SPHEREX_TILES);
  await page.waitForTimeout(1500);
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByTestId("sky-status")).toHaveAttribute("data-state", "ready", { timeout: 45_000 });
  await expect(error).toHaveCount(0);
  expect(log.spherex.some((t) => t.status === 200), "real tiles after retry").toBe(true);
  expect(log.cdsRequests, "no fallback to CDS").toEqual([]);
});
