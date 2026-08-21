import { describe, expect, it } from "vitest";
import App from "./App.vue";

describe("web test runner", () => {
  it("imports the root component", () => {
    expect(App).toBeDefined();
  });
});
