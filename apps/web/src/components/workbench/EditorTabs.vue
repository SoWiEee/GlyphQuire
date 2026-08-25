<template>
  <div
    role="tablist"
    aria-label="Open notes"
    class="flex items-center border-b border-gray-200 bg-white"
  >
    <div
      v-for="tab in tabs"
      :key="tab.id"
      role="tab"
      :aria-selected="tab.id === activeTabId"
      tabindex="0"
      class="group flex items-center gap-2 border-r border-gray-200 px-3 py-1.5 text-sm"
      :class="
        tab.id === activeTabId
          ? 'bg-gray-100 font-medium text-gray-900'
          : 'text-gray-500 hover:bg-gray-50'
      "
      @click="emit('select', tab.id)"
      @keydown.enter="emit('select', tab.id)"
    >
      <span class="max-w-[10rem] truncate">{{ tab.title }}</span>
      <button
        type="button"
        class="rounded text-gray-500 opacity-0 group-hover:opacity-100 hover:text-gray-700 focus-visible:opacity-100"
        :aria-label="`Close ${tab.title}`"
        @click.stop="emit('close', tab.id)"
      >
        ×
      </button>
    </div>
    <p v-if="tabs.length === 0" class="px-3 py-1.5 text-sm text-gray-400">
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
