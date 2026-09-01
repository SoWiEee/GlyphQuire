import type { PutThemePreferenceInput, ThemePreferenceResult } from "@glyphquire/api-contract";
import { ThemePreferenceClient } from "../api/ThemePreferenceClient.js";
import type { ThemeContext } from "./ThemeProvider.js";

export interface ThemePreferenceDraft {
  themeId: string | null;
  mode: "light" | "dark";
  customOverrides: Record<string, unknown>;
  variantOverrides: Record<string, unknown>;
}

export function useThemePersistence(
  context: ThemeContext,
  client: ThemePreferenceClient = new ThemePreferenceClient(),
) {
  async function load(): Promise<ThemePreferenceResult | null> {
    try {
      const preference = await client.get();
      context.applyPreference(preference);
      return preference;
    } catch {
      return null;
    }
  }

  async function save(draft?: ThemePreferenceDraft): Promise<ThemePreferenceResult> {
    const current = context.preferenceSnapshot();
    const input: PutThemePreferenceInput = {
      themeId: draft?.themeId ?? current.themeId,
      mode: draft?.mode ?? current.mode,
      customOverrides: (draft?.customOverrides ??
        current.customOverrides) as PutThemePreferenceInput["customOverrides"],
      variantOverrides: (draft?.variantOverrides ??
        current.variantOverrides) as PutThemePreferenceInput["variantOverrides"],
      baseRevision: current.revision,
    };
    const preference = await client.put(input);
    context.applyPreference(preference);
    return preference;
  }

  return { load, save, client };
}
