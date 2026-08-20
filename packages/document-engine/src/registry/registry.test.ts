import { describe, it, expect } from "vitest";
import { createRegistry } from "./builtins.js";
import { BlockRegistry, RESERVED_NAMES } from "./registry.js";
import { calloutBlock } from "./blocks/callout.js";

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

  it("rejects public registration of reserved built-in names", () => {
    const registry = new BlockRegistry();

    expect(() => registry.register({ ...calloutBlock })).toThrow(/reserved/);
  });

  it("allows registration of non-reserved names", () => {
    const registry = new BlockRegistry();

    registry.register({ ...calloutBlock, name: "custom" });

    expect(registry.has("custom")).toBe(true);
  });
});
