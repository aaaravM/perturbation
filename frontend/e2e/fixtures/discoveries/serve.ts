// Serves the synthetic Discoveries fixture (made by make_fixture.py in this folder) in place of
// public/discoveries/ through route interception. Nothing in this folder is ever deployed.
import path from "node:path";
import type { Page } from "@playwright/test";

const DIR = __dirname;

/** "candidates.json" (the full fixture), "empty.json" (no candidates) or null (the file is missing: 404). */
export async function serveDiscoveries(page: Page, file: "candidates.json" | "empty.json" | null = "candidates.json") {
  await page.route("**/discoveries/candidates.json", (route) =>
    file
      ? route.fulfill({ path: path.join(DIR, file), contentType: "application/json" })
      : route.fulfill({ status: 404, contentType: "text/plain", body: "Not found" }),
  );
  await page.route(/\/discoveries\/stamps\/fx-[\w.-]+\.png$/, (route) => {
    const name = path.basename(new URL(route.request().url()).pathname);
    return route.fulfill({ path: path.join(DIR, "stamps", name), contentType: "image/png" });
  });
}

/** Where to save review screenshots, if anywhere (PXH_SHOTS=<folder>). */
export const SHOTS_DIR = process.env.PXH_SHOTS ?? "";
