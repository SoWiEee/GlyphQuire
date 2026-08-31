<template>
  <div
    role="tablist"
    aria-label="Open notes"
    class="gq-editor-tabs flex items-center overflow-x-auto border-b border-gray-200 bg-white"
  >
    <div
      v-for="tab in tabs"
      :key="tab.id"
      role="tab"
      :aria-selected="tab.id === activeTabId"
      :data-active="tab.id === activeTabId ? 'true' : undefined"
      tabindex="0"
      class="gq-editor-tabs__tab group flex items-center gap-2 border-r px-3 py-1.5 text-sm"
      :class="{ 'gq-editor-tabs__tab--active': tab.id === activeTabId }"
      @click="emit('select', tab.id)"
      @keydown.enter="emit('select', tab.id)"
    >
      <span class="max-w-[10rem] truncate">{{ tab.title }}</span>
      <button
        type="button"
        class="gq-editor-tabs__close rounded opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
        :aria-label="`Close ${tab.title}`"
        @click.stop="emit('close', tab.id)"
      >
        ×
      </button>
    </div>
    <p v-if="tabs.length === 0" class="gq-editor-empty px-3 py-1.5 text-sm">
      No notes open — pick one from the Explorer.
    </p>
  </div>
</template>

<script setup lang="ts">
import type { WorkbenchNote } from "./types.js";

defineProps<{
  tabs: WorkbenchNote[];
  activeTabId: string | null;
}>();

const emit = defineEmits<{
  select: [noteId: string];
  close: [noteId: string];
}>();
</script>
