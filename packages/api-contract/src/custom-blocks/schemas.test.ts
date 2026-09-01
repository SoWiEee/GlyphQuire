import { describe, expect, it } from "vitest";
import { createCustomBlockInputSchema, customBlockListResultSchema } from "./schemas.js";

const definition = {
  name: "reading-score",
  version: 1,
  kind: "container" as const,
  propsSchema: { label: { type: "string" as const, required: true, maxLength: 50 } },
  contentPolicy: "optional" as const,
  icon: "check" as const,
  preset: "rating" as const,
  capabilities: ["static" as const],
};

describe("Custom Block API contracts", () => {
  it("accepts a strict create payload and rejects executable fields", () => {
    expect(
      createCustomBlockInputSchema.safeParse({ operationId: "op-1", definition }).success,
    ).toBe(true);
    expect(
      createCustomBlockInputSchema.safeParse({
        operationId: "op-1",
        definition: { ...definition, html: "<script>" },
      }).success,
    ).toBe(false);
  });

  it("bounds list responses", () => {
    expect(customBlockListResultSchema.safeParse({ items: [] }).success).toBe(true);
  });
});
