// End-to-end tests in a real browser engine (installed Google Chrome, headless, software WebGL).
// Reuses the dev server on :3000 if one is running. Tests hit IRSA for real tiles, so they run
// serially in one worker and pause between bursts of tile requests.
import path from "node:path";
import { defineConfig } from "@playwright/test";

// Read the same settings as the dev server (frontend/.env.local, e.g. NEXT_PUBLIC_API_URL), so the
// tests that depend on a live backend agree with what the server shows. Without the file, both the
// server and the tests run with no backend.
try {
  process.loadEnvFile(path.join(__dirname, ".env.local"));
} catch {
  // No .env.local.
}

// E2E_BASE_URL=https://... runs the tests against another server, such as the published site,
// instead of the local dev server (which is then not started).
const BASE_URL = process.env.E2E_BASE_URL || "http://localhost:3000";

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
    baseURL: BASE_URL,
    channel: "chrome",
    headless: true,
    launchOptions: {
      args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--ignore-gpu-blocklist"],
    },
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
  },
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: "pnpm dev",
        url: "http://localhost:3000",
        reuseExistingServer: true,
        timeout: 180_000,
      },
});
