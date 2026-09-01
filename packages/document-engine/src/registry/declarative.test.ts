import { describe, expect, it } from "vitest";
import { registerDeclarative } from "./declarative.js";
import { BlockRegistry } from "./registry.js";

const definition = {
  name: "reading-score",
  version: 1,
  kind: "container" as const,
  propsSchema: {
    label: { type: "string" as const, required: true, maxLength: 50 },
    score: { type: "number" as const, required: true, minimum: 0, maximum: 5 },
  },
  contentPolicy: "required" as const,
  icon: "check" as const,
  preset: "rating" as const,
  capabilities: ["static", "interactive-ui"] as const,
};

describe("declarative Custom Block registry adapter", () => {
  it("registers validated definitions without executable hooks", () => {
    const registry = new BlockRegistry();
    registerDeclarative(registry, definition);
    const registered = registry.get("reading-score");
    expect(registered?.kind).toBe("container");
    expect(registered?.capabilities).toEqual(["static", "interactive-ui"]);
    expect(registered?.schema).toBeDefined();
  });

  it("rejects built-in names before registration", () => {
    const registry = new BlockRegistry();
    expect(() => registerDeclarative(registry, { ...definition, name: "callout" })).toThrow();
  });
});
