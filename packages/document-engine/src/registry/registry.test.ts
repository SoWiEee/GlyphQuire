import { describe, it, expect } from "vitest";
import { createRegistry } from "./builtins.js";
import { RESERVED_NAMES } from "./registry.js";

describe("registry", () => {
  it("registers all reserved built-in names", () => {
    const registry = createRegistry();
    for (const name of RESERVED_NAMES) {
      expect(registry.has(name)).toBe(true);
    }
  });

  it("rejects duplicate registration", () => {
    const registry = createRegistry();
    expect(() => registry.register(registry.get("callout")!)).toThrow();
  });
});
