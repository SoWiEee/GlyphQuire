import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: ["e2e/**/*.spec.ts", "performance/**/*.perf.spec.ts"],
  webServer: {
    command: "pnpm --filter @glyphquire/web dev --host 127.0.0.1",
    url: "http://127.0.0.1:5173",
    reuseExistingServer: !process.env.CI,
  },
  use: { ...devices["Desktop Chrome"], baseURL: "http://localhost:5173" },
});
