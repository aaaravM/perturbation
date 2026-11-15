// Every route answers 200, renders its heading, logs no console errors and carries the site's name.
import { expect, test } from "@playwright/test";
import { watchPage } from "./helpers";

const ROUTES = [
  { path: "/", heading: "Perturbation" },
  { path: "/explore", heading: "Lab: a workbench for SPHEREx images of any patch of sky" },
  { path: "/discoveries", heading: "Candidate movers and variables" },
  { path: "/help", heading: "Review candidates with us" },
  { path: "/planet-x", heading: "The first Planet X" },
  { path: "/how-it-works", heading: "How it works" },
  { path: "/about", heading: "About Perturbation" },
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
    // The site's old name is gone from the tab title and from everything on screen.
    await expect(page).toHaveTitle(/Perturbation$/);
    await expect(page).not.toHaveTitle(/Planet X Hunter/i);
    await expect(page.locator("body")).not.toContainText(/Planet X Hunter/i, { useInnerText: true });
  });
}

test("the home page's title and the top bar name the site", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle("Perturbation");
  const home = page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Perturbation", exact: true });
  await expect(home).toHaveAttribute("href", "/");
});

test("the landing links to Barnard's Star in the explorer", async ({ page }) => {
  await page.goto("/");
  const cta = page.getByRole("link", { name: /Try Barnard.s Star/ });
  await expect(cta).toHaveAttribute("href", "/explore?target=barnards-star");
  await expect(page.getByRole("link", { name: "Explore the sky globe" })).toHaveAttribute("href", "/sky");
  await expect(page.getByRole("link", { name: "skip the story" })).toHaveAttribute("href", "#two-ways-in");
});
