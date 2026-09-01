<template>
  <Teleport to="body">
    <div class="fixed inset-0 z-50 flex justify-end" @keydown.escape="emit('close')">
      <div class="absolute inset-0 bg-black/20" aria-hidden="true" @click="emit('close')" />

      <aside
        ref="panelRef"
        role="dialog"
        aria-modal="true"
        aria-label="Theme editor"
        class="relative z-10 flex h-full w-80 flex-col overflow-y-auto border-l border-gray-200 bg-white shadow-xl"
        tabindex="-1"
      >
        <header class="flex items-center justify-between border-b border-gray-200 px-4 py-3">
          <h2 class="text-sm font-semibold text-gray-900">Theme Editor</h2>
          <button
            type="button"
            class="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
            aria-label="Close theme editor"
            @click="emit('close')"
          >
            <GqIcon name="x" size="sm" />
          </button>
        </header>

        <div class="flex-1 space-y-4 overflow-y-auto px-4 py-3">
          <ThemeSelector
            :themes="themeStore.availableThemes"
            :selected-theme-id="selectedThemeId"
            @select="onThemeSelect"
          />

          <TokenEditor
            :colors="editor.draftColor.value"
            :typography="editor.draftTypography.value"
            :radius="editor.draftRadius.value"
            :spacing="editor.draftSpacing.value"
            @update:color="editor.updateColor"
            @update:typography="editor.updateTypography"
            @update:radius="editor.updateRadius"
            @update:spacing="editor.updateSpacing"
          />

          <VariantPicker
            :variants="themeContext.variants.value"
            @update:variant="onVariantUpdate"
          />
        </div>

        <div class="px-4 pb-3">
          <ThemeActions
            :has-changes="editor.hasUnsavedChanges.value"
            :is-dark="themeContext.isDark.value"
            @save="onSave"
            @reset="editor.reset()"
            @toggle-dark="themeContext.isDark.value = !themeContext.isDark.value"
          />
        </div>
      </aside>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { inject, onBeforeUnmount, onMounted, ref } from "vue";
import GqIcon from "../icons/GqIcon.vue";
import { useThemeStore } from "../../stores/theme.js";
import { THEME_INJECTION_KEY, type ThemeContext } from "../../themes/ThemeProvider.js";
import { useThemeEditor } from "../../themes/useThemeEditor.js";
import ThemeSelector from "./ThemeSelector.vue";
import TokenEditor from "./TokenEditor.vue";
import VariantPicker from "./VariantPicker.vue";
import ThemeActions from "./ThemeActions.vue";
import { trapFocus, type FocusTrapHandle } from "../../lib/focusTrap.js";

const emit = defineEmits<{
  close: [];
}>();

const themeStore = useThemeStore();
const themeContext = inject(THEME_INJECTION_KEY) as ThemeContext;
const editor = useThemeEditor(themeContext);
const panelRef = ref<HTMLElement | null>(null);
const selectedThemeId = ref(themeStore.activeUserTheme?.themeId ?? "");
let focusTrap: FocusTrapHandle | undefined;

function onThemeSelect(themeId: string) {
  selectedThemeId.value = themeId;
  const theme = themeStore.availableThemes.find((t) => t.id === themeId);
  if (theme) {
    editor.loadFromTokens(theme.tokens);
  }
}

function onVariantUpdate(component: string, variant: string) {
  editor.hasUnsavedChanges.value = true;
  themeContext.setDraftVariants(
    component === "heading"
      ? { heading: { decoration: variant as "none" | "sparkle" | "line" } }
      : { [component]: { variant } },
  );
}

function onSave() {
  themeContext.commitDraft();
  themeContext.applyToDocument();
  editor.hasUnsavedChanges.value = false;
}

onMounted(() => {
  if (panelRef.value) focusTrap = trapFocus(panelRef.value);
});

onBeforeUnmount(() => {
  focusTrap?.release();
  focusTrap = undefined;
});
</script>
