import { defineStore } from "pinia";
import { ref, shallowRef } from "vue";
import type { ThemeResult, UserThemeResult } from "@glyphquire/api-contract";

export const useThemeStore = defineStore("theme", () => {
  const availableThemes = ref<ThemeResult[]>([]);
  const activeUserTheme = shallowRef<UserThemeResult | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const editorOpen = ref(false);

  function setAvailableThemes(themes: ThemeResult[]) {
    availableThemes.value = themes;
  }

  function setActiveUserTheme(userTheme: UserThemeResult) {
    activeUserTheme.value = userTheme;
  }

  function openEditor() {
    editorOpen.value = true;
  }

  function closeEditor() {
    editorOpen.value = false;
  }

  return {
    availableThemes,
    activeUserTheme,
    loading,
    error,
    editorOpen,
    setAvailableThemes,
    setActiveUserTheme,
    openEditor,
    closeEditor,
  };
});
