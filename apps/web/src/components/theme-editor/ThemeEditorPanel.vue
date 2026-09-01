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
          <p v-if="themeStore.error" class="mb-2 text-xs text-red-600" role="alert">
            {{ themeStore.error }}
          </p>
          <ThemeActions
            :has-changes="editor.hasUnsavedChanges.value"
            :is-dark="themeContext.isDark.value"
            @save="onSave"
            @reset="editor.reset()"
            @toggle-dark="onToggleDark"
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
import { useThemePersistence } from "../../themes/useThemePersistence.js";
import ThemeSelector from "./ThemeSelector.vue";
import TokenEditor from "./TokenEditor.vue";
import VariantPicker from "./VariantPicker.vue";
import ThemeActions from "./ThemeActions.vue";
import { trapFocus, type FocusTrapHandle } from "../../lib/focusTrap.js";

const emit = defineEmits<{
  close: [];
}>();

const props = defineProps<{
  workspaceId?: string;
}>();

const themeStore = useThemeStore();
const themeContext = inject(THEME_INJECTION_KEY) as ThemeContext;
const editor = useThemeEditor(themeContext);
const persistence = useThemePersistence(themeContext);
const panelRef = ref<HTMLElement | null>(null);
const selectedThemeId = ref(
  themeContext.themeId.value ?? themeStore.activeUserTheme?.themeId ?? "",
);
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

async function onSave() {
  themeStore.loading = true;
  themeStore.error = null;
  try {
    const result = await persistence.save({
      themeId: selectedThemeId.value || null,
      mode: themeContext.isDark.value ? "dark" : "light",
      customOverrides: {
        color: editor.draftColor.value,
        typography: editor.draftTypography.value,
        radius: editor.draftRadius.value,
        spacing: editor.draftSpacing.value,
      },
      variantOverrides: themeContext.preferenceSnapshot().variantOverrides,
    });
    themeStore.setPreference(result);
    editor.loadFromTokens(themeContext.tokens.value);
    editor.hasUnsavedChanges.value = false;
  } catch (error) {
    themeStore.error = error instanceof Error ? error.message : "Theme could not be saved";
  } finally {
    themeStore.loading = false;
  }
}

async function onToggleDark() {
  themeContext.isDark.value = !themeContext.isDark.value;
  try {
    const result = await persistence.save();
    themeStore.setPreference(result);
  } catch (error) {
    themeStore.error =
      error instanceof Error ? error.message : "Theme preference could not be saved";
  }
}

onMounted(() => {
  if (panelRef.value) focusTrap = trapFocus(panelRef.value);
  if (props.workspaceId) {
    void persistence.client
      .listWorkspaceThemes(props.workspaceId)
      .then((themes) => themeStore.setAvailableThemes(themes))
      .catch(() => undefined);
  }
});

onBeforeUnmount(() => {
  focusTrap?.release();
  focusTrap = undefined;
});
</script>
