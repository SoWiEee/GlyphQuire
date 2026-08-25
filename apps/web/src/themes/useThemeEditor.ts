import { ref } from "vue";
import type { ThemeTokens } from "@glyphquire/theme-engine";
import type { ThemeContext } from "./ThemeProvider.js";

export function useThemeEditor(themeContext: ThemeContext) {
  const draftColor = ref({ ...themeContext.tokens.value.color });
  const draftTypography = ref({ ...themeContext.tokens.value.typography });
  const draftRadius = ref({ ...themeContext.tokens.value.radius });
  const draftSpacing = ref({ ...themeContext.tokens.value.spacing });
  const hasUnsavedChanges = ref(false);

  function applyDraft() {
    themeContext.setDraftTokens({
      color: draftColor.value,
      typography: draftTypography.value,
      radius: draftRadius.value,
      spacing: draftSpacing.value,
    });
  }

  function updateColor(key: keyof ThemeTokens["color"], value: string) {
    draftColor.value = { ...draftColor.value, [key]: value };
    hasUnsavedChanges.value = true;
    applyDraft();
  }

  function updateTypography(key: keyof ThemeTokens["typography"], value: string) {
    draftTypography.value = { ...draftTypography.value, [key]: value };
    hasUnsavedChanges.value = true;
    applyDraft();
  }

  function updateRadius(key: keyof ThemeTokens["radius"], value: string) {
    draftRadius.value = { ...draftRadius.value, [key]: value };
    hasUnsavedChanges.value = true;
    applyDraft();
  }

  function updateSpacing(key: string, value: string) {
    draftSpacing.value = { ...draftSpacing.value, [key]: value };
    hasUnsavedChanges.value = true;
    applyDraft();
  }

  function reset() {
    draftColor.value = { ...themeContext.tokens.value.color };
    draftTypography.value = { ...themeContext.tokens.value.typography };
    draftRadius.value = { ...themeContext.tokens.value.radius };
    draftSpacing.value = { ...themeContext.tokens.value.spacing };
    hasUnsavedChanges.value = false;
    themeContext.resetDraft();
  }

  function loadFromTokens(tokens: ThemeTokens) {
    draftColor.value = { ...tokens.color };
    draftTypography.value = { ...tokens.typography };
    draftRadius.value = { ...tokens.radius };
    draftSpacing.value = { ...tokens.spacing };
    hasUnsavedChanges.value = false;
  }

  return {
    draftColor,
    draftTypography,
    draftRadius,
    draftSpacing,
    hasUnsavedChanges,
    updateColor,
    updateTypography,
    updateRadius,
    updateSpacing,
    reset,
    loadFromTokens,
  };
}
