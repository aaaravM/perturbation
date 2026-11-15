// End-to-end tests in a real browser engine (installed Google Chrome, headless, software WebGL).
// Reuses the dev server on :3000 if one is running. Tests hit IRSA for real tiles, so they run
// serially in one worker and pause between bursts of tile requests.
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 25_000 },
  reporter: [["list"]],
  outputDir: "test-results",
  use: {
    baseURL: "http://localhost:3000",
    channel: "chrome",
    headless: true,
    launchOptions: {
      args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--ignore-gpu-blocklist"],
    },
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
  },
  webServer: {
    command: "pnpm dev",
    url: "http://localhost:3000",
    reuseExistingServer: true,
    timeout: 180_000,
  },
});
