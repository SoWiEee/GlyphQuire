import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { putThemePreferenceInputSchema, themePreferenceResultSchema } from "./schemas.js";

const completeInput = {
  themeId: randomUUID(),
  mode: "dark" as const,
  customOverrides: {
    color: { background: "#111827" },
  },
  variantOverrides: {
    callout: { variant: "outline" as const, animation: "none" as const },
  },
  baseRevision: 0,
};

describe("theme preference contracts", () => {
  it("accepts the complete write payload and rejects omitted preference fields", () => {
    expect(putThemePreferenceInputSchema.parse(completeInput)).toEqual(completeInput);

    for (const key of [
      "themeId",
      "mode",
      "customOverrides",
      "variantOverrides",
      "baseRevision",
    ] as const) {
      const candidate = { ...completeInput } as Record<string, unknown>;
      delete candidate[key];
      expect(putThemePreferenceInputSchema.safeParse(candidate).success).toBe(false);
    }
  });

  it("rejects unknown identity fields and malformed overrides", () => {
    expect(
      putThemePreferenceInputSchema.safeParse({ ...completeInput, userId: "victim" }).success,
    ).toBe(false);
    expect(
      putThemePreferenceInputSchema.safeParse({
        ...completeInput,
        customOverrides: { color: { background: "url(https://attacker.invalid/x)" } },
      }).success,
    ).toBe(false);
    expect(
      putThemePreferenceInputSchema.safeParse({
        ...completeInput,
        variantOverrides: { callout: { variant: "script" } },
      }).success,
    ).toBe(false);
  });

  it("accepts the default response and enforces its exact shape", () => {
    const result = {
      themeId: null,
      mode: "light" as const,
      customOverrides: {},
      variantOverrides: {},
      revision: 0,
      updatedAt: "1970-01-01T00:00:00.000Z",
    };

    expect(themePreferenceResultSchema.parse(result)).toEqual(result);
    expect(themePreferenceResultSchema.safeParse({ ...result, actorId: "secret" }).success).toBe(
      false,
    );
  });
});
