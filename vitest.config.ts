import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/scaffold.test.ts", "tests/conformance/**/*.test.ts"],
    environment: "node",
  },
});
