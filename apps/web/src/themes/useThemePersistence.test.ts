import { describe, expect, it, vi } from "vitest";
import { ThemePreferenceClient } from "../api/ThemePreferenceClient.js";
import { useThemePersistence } from "./useThemePersistence.js";
import type { ThemeContext } from "./ThemeProvider.js";

const initial = {
  themeId: null,
  mode: "light" as const,
  customOverrides: {},
  variantOverrides: {},
  revision: 0,
};

function fakeContext() {
  return {
    preferenceSnapshot: vi.fn(() => initial),
    applyPreference: vi.fn(),
  } as unknown as ThemeContext;
}

describe("useThemePersistence", () => {
  it("loads server preferences into the shared theme context", async () => {
    const context = fakeContext();
    const client = new ThemePreferenceClient({
      fetchImpl: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ...initial,
              mode: "dark",
              revision: 1,
              updatedAt: "2026-01-01T00:00:00.000Z",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    });

    const result = await useThemePersistence(context, client).load();

    expect(result?.mode).toBe("dark");
    expect(context.applyPreference).toHaveBeenCalledWith(expect.objectContaining({ mode: "dark" }));
  });

  it("sends a complete payload and applies only the successful response", async () => {
    const context = fakeContext();
    const fetchImpl = vi.fn(async (_input: string, init?: RequestInit) => {
      expect(init?.method).toBe("PUT");
      expect(JSON.parse(String(init?.body))).toMatchObject({
        themeId: null,
        mode: "dark",
        customOverrides: { color: { accent: "#0f0" } },
        variantOverrides: {},
        baseRevision: 0,
      });
      return new Response(
        JSON.stringify({
          ...initial,
          mode: "dark",
          revision: 1,
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    await useThemePersistence(context, new ThemePreferenceClient({ fetchImpl })).save({
      themeId: null,
      mode: "dark",
      customOverrides: { color: { accent: "#0f0" } },
      variantOverrides: {},
    });

    expect(context.applyPreference).toHaveBeenCalledTimes(1);
  });
});
