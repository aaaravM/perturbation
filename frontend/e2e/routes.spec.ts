// Every route answers 200, renders its heading and logs no console errors.
import { expect, test } from "@playwright/test";
import { watchPage } from "./helpers";

const ROUTES = [
  { path: "/", heading: "Watch the sky move." },
  { path: "/explore", heading: "Sky explorer" },
  { path: "/discoveries", heading: "Candidate movers and variables" },
  { path: "/help", heading: "Review candidates with us" },
  { path: "/how-it-works", heading: "From SPHEREx exposures to a blink" },
  { path: "/about", heading: "Team Ninth Vanguard" },
] as const;

for (const route of ROUTES) {
  test(`${route.path} returns 200 and renders its heading`, async ({ page }) => {
    const log = watchPage(page);
    const response = await page.goto(route.path);
    expect(response?.status()).toBe(200);
    const heading = page.getByRole("heading", { level: 1 });
    await expect(heading).toHaveCount(1);
    await expect(heading).toHaveText(route.heading);
    await page.waitForTimeout(route.path === "/explore" ? 3000 : 800);
    expect(log.badResponses, "HTTP errors").toEqual([]);
    expect(log.consoleErrors, "console errors").toEqual([]);
  });
}

test("placeholders say so, quietly", async ({ page }) => {
  for (const path of ["/discoveries", "/help", "/how-it-works", "/about"]) {
    await page.goto(path);
    await expect(page.locator("[data-placeholder]")).toHaveText(/^Placeholder\. Built in Phase \d+\.$/);
  }
});

test("the landing links to Barnard's Star in the explorer", async ({ page }) => {
  await page.goto("/");
  const cta = page.getByRole("link", { name: /Try Barnard.s Star/ });
  await expect(cta).toHaveAttribute("href", "/explore?target=barnards-star&ra=269.4461&dec=4.7707&fov=10");
  await expect(page.getByRole("link", { name: "Explore the sky globe" })).toHaveAttribute("href", "/sky");
  await expect(page.getByTestId("blink-hero")).toBeVisible();
  await expect(page.getByTestId("blink-hero")).toContainText(/Illustration/);
});
