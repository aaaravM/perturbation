// Design-review screenshots of every route at desktop, tablet and phone sizes. Opt-in:
//   UI_REVIEW_DIR=/some/dir pnpm test:e2e screenshots
import path from "node:path";
import { test } from "@playwright/test";
import { hideDevOverlay, pause } from "./helpers";

const OUT = process.env.UI_REVIEW_DIR;
const VIEWPORTS = [
  { name: "1440x900", width: 1440, height: 900 },
  { name: "834x1112", width: 834, height: 1112 },
  { name: "390x844", width: 390, height: 844 },
] as const;
const ROUTES = [
  { name: "home", path: "/" },
  { name: "explore", path: "/explore" },
  { name: "discoveries", path: "/discoveries" },
  { name: "help", path: "/help" },
  { name: "how-it-works", path: "/how-it-works" },
  { name: "about", path: "/about" },
] as const;

test.skip(!OUT, "set UI_REVIEW_DIR to save design-review screenshots");

for (const vp of VIEWPORTS) {
  test(`screenshots at ${vp.name}`, async ({ page }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    for (const route of ROUTES) {
      await page.goto(route.path);
      await hideDevOverlay(page);
      if (route.path === "/explore") {
        await page.waitForTimeout(6500); // tiles drawn
      } else if (route.path === "/") {
        await page.waitForTimeout(4600); // hero mid-cycle: ring drawn around the mover
        await page.screenshot({ path: path.join(OUT!, `${route.name}-hero-mid-animation-${vp.name}.png`) });
        await page.screenshot({ path: path.join(OUT!, `${route.name}-full-${vp.name}.png`), fullPage: true });
        continue;
      } else {
        await page.waitForTimeout(900);
      }
      await page.screenshot({ path: path.join(OUT!, `${route.name}-${vp.name}.png`) });
      if (route.path === "/explore") await pause(page, 1500);
    }
  });
}
