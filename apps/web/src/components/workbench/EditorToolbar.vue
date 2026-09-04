<template>
  <nav
    class="gq-editor-toolbar flex items-center gap-1 border-b border-border px-3 py-1.5"
    aria-label="編輯工具列"
  >
    <template v-for="(group, groupIndex) in groups" :key="group.id">
      <span
        v-if="groupIndex > 0"
        class="gq-editor-toolbar-separator mx-1 h-5 w-px shrink-0"
        aria-hidden="true"
      />
      <button
        v-for="action in group.actions"
        :key="action.id"
        type="button"
        class="rounded border border-transparent p-1.5 text-foreground hover:border-border hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-50"
        :aria-label="action.label"
        :disabled="disabled"
        :title="action.label"
        @click="emit('action', action.id)"
      >
        <GqIcon :name="action.icon" :label="action.label" :decorative="false" />
      </button>
    </template>
  </nav>
</template>

<script setup lang="ts">
import type { IconName } from "@glyphquire/theme-sdk";
import GqIcon from "../icons/GqIcon.vue";
import type { ToolbarAction } from "./types.js";

defineProps<{ disabled: boolean }>();

const emit = defineEmits<{
  action: [action: ToolbarAction];
}>();

interface ToolbarActionDefinition {
  readonly id: ToolbarAction;
  readonly label: string;
  readonly icon: IconName;
}

interface ToolbarActionGroup {
  readonly id: string;
  readonly actions: readonly ToolbarActionDefinition[];
}

const groups: readonly ToolbarActionGroup[] = [
  {
    id: "text",
    actions: [
      { id: "bold", label: "粗體 (⌘B)", icon: "bold" },
      { id: "italic", label: "斜體 (⌘I)", icon: "italic" },
      { id: "strikethrough", label: "刪除線 (⌘⇧X)", icon: "strikethrough" },
      { id: "code", label: "行內程式碼 (⌘E)", icon: "code" },
    ],
  },
  {
    id: "paragraph",
    actions: [
      { id: "heading", label: "標題 (⌘⌥2)", icon: "heading-2" },
      { id: "bulletList", label: "項目符號清單 (⌘⇧8)", icon: "list" },
      { id: "blockquote", label: "引用 (⌘⇧.)", icon: "quote" },
    ],
  },
  {
    id: "insert",
    actions: [{ id: "link", label: "連結 (⌘K)", icon: "link-2" }],
  },
];
</script>

<style scoped>
.gq-editor-toolbar-separator {
  background: var(--gq-color-border);
}
</style>
