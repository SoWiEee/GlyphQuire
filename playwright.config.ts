import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  // A leftover `.only` must never silently narrow the release-gate run.
  forbidOnly: Boolean(process.env.CI),
  // E2E tolerates the usual dev-server/network flakiness with a couple of
  // retries in CI; the performance project deliberately does not (see its
  // own `retries: 0` below) so a slow sample is never silently rerun away.
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  webServer: {
    command: "pnpm --filter @glyphquire/web dev --host 127.0.0.1",
    url: "http://127.0.0.1:5173",
    reuseExistingServer: !process.env.CI,
  },
  use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:5173" },
  projects: [
    {
      name: "e2e",
      // Keep the existing Task 8 E2E project stable. The Phase 6 browser
      // matrix has explicit projects below so a local diagnostic run never
      // changes the semantics of the ordinary Chrome suite.
      testMatch: "e2e/**/*.spec.ts",
      // README screenshots are maintained manually and are not release-gate
      // checks; the demo route remains available as a deterministic fixture
      // for product-flow tests.
      testIgnore: [
        "e2e/phase6-browser-matrix.spec.ts",
        "e2e/readme-demo.spec.ts",
        "e2e/readme-gallery-render.spec.ts",
      ],
    },
    {
      name: "chromium",
      testMatch: "e2e/phase6-browser-matrix.spec.ts",
      use: { ...devices["Desktop Chrome"], browserName: "chromium" },
    },
    {
      name: "msedge",
      testMatch: "e2e/phase6-browser-matrix.spec.ts",
      use: { ...devices["Desktop Edge"], browserName: "chromium", channel: "msedge" },
    },
    {
      name: "firefox",
      testMatch: "e2e/phase6-browser-matrix.spec.ts",
      use: { ...devices["Desktop Firefox"], browserName: "firefox" },
    },
    {
      name: "webkit",
      testMatch: "e2e/phase6-browser-matrix.spec.ts",
      // WebKit diagnostic only; it is never substituted for Safari
      // BrowserStack evidence and never counts as the Safari P0 result.
      metadata: { phase6Role: "diagnostic-only", providerEvidence: "never" },
      use: { ...devices["Desktop Safari"], browserName: "webkit" },
    },
    {
      name: "performance",
      testMatch: "performance/**/*.perf.spec.ts",
      // SPEC §40's percentile gates are meaningless if a slow sample gets
      // silently retried into a faster one — a failing perf assertion here
      // must be reported once, not laundered by Playwright's own retries.
      retries: 0,
      fullyParallel: false,
    },
  ],
});
