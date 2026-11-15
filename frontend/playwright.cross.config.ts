// Cross-browser end-to-end runs: Safari's engine (WebKit) on a desktop and on an iPhone, and
// Firefox on a desktop. Same tests and dev server as playwright.config.ts, but no Chrome launch
// flags: each engine uses its own WebGL path. Tests hit IRSA for real tiles, so they run serially
// in one worker.
//   pnpm exec playwright test --config playwright.cross.config.ts --output=test-results/xbrowser
//   add --project=webkit-phone (or webkit-desktop, firefox-desktop) to run one engine.
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

// Read the same settings as the dev server (frontend/.env.local, e.g. NEXT_PUBLIC_API_URL), so the
// tests that depend on a live backend agree with what the server shows.
try {
  process.loadEnvFile(path.join(__dirname, ".env.local"));
} catch {
  // No .env.local.
}

const BASE_URL = process.env.E2E_BASE_URL || "http://localhost:3000";
const DESKTOP = { width: 1440, height: 900 };

export default defineConfig({
  testDir: "./e2e",
  // The design-review screenshots are taken in Chrome only.
  testIgnore: ["**/screenshots.spec.ts"],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 25_000 },
  reporter: [["list"]],
  outputDir: "test-results/xbrowser",
  use: {
    baseURL: BASE_URL,
    headless: true,
    trace: "retain-on-failure",
  },
  projects: [
    { name: "webkit-desktop", use: { browserName: "webkit", viewport: DESKTOP } },
    // 390 x 664 CSS px with Safari's toolbars, on a 390 x 844 screen, touch, 3x pixels.
    { name: "webkit-phone", use: { ...devices["iPhone 14"] } },
    { name: "firefox-desktop", use: { browserName: "firefox", viewport: DESKTOP } },
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: "pnpm dev",
        url: "http://localhost:3000",
        reuseExistingServer: true,
        timeout: 180_000,
      },
});
