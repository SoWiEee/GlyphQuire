import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [vue()],
  test: {
    include: ["tests/scaffold.test.ts", "tests/conformance/**/*.test.ts"],
    environment: "node",
  },
});
