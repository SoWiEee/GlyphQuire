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
      testMatch: "e2e/**/*.spec.ts",
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
