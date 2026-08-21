import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";

describe("API integration test runner", () => {
  it("imports the application factory", () => {
    expect(createApp).toBeTypeOf("function");
  });
});
