<template>
  <div class="gq-editor-tabs flex items-center overflow-x-auto border-b border-gray-200 bg-white">
    <div role="tablist" aria-label="Open notes" class="gq-editor-tabs__list flex items-center">
      <button
        v-for="tab in tabs"
        :key="tab.id"
        type="button"
        role="tab"
        :aria-selected="tab.id === activeTabId"
        :tabindex="tab.id === activeTabId ? 0 : -1"
        :data-active="tab.id === activeTabId ? 'true' : undefined"
        class="gq-editor-tabs__tab flex min-h-11 items-center gap-2 px-3 py-1.5 text-sm"
        :class="{ 'gq-editor-tabs__tab--active': tab.id === activeTabId }"
        @click="emit('select', tab.id)"
        @keydown.enter.prevent="emit('select', tab.id)"
        @keydown.space.prevent="emit('select', tab.id)"
      >
        <span class="max-w-[10rem] truncate">{{ tab.title }}</span>
        <span
          v-if="isDirty(tab.id)"
          class="gq-editor-tabs__dirty-dot"
          role="img"
          aria-label="unsaved changes"
        ></span>
      </button>
    </div>
    <div
      v-for="tab in tabs"
      :key="tab.id"
      class="gq-editor-tabs__close-item group flex items-center"
    >
      <button
        type="button"
        class="gq-editor-tabs__close mr-1 rounded px-1 focus-visible:opacity-100"
        :aria-label="`Close ${tab.title}`"
        @click.stop="emit('close', tab.id)"
      >
        <GqIcon name="x" size="sm" />
      </button>
    </div>
    <p v-if="tabs.length === 0" class="gq-editor-empty px-3 py-1.5 text-sm">
      No notes open — pick one from the Explorer.
    </p>
  </div>
</template>

<script setup lang="ts">
import GqIcon from "../icons/GqIcon.vue";
import type { WorkbenchNote } from "./types.js";

const props = defineProps<{
  tabs: WorkbenchNote[];
  activeTabId: string | null;
  /** Tab ids with unsaved changes; only the active tab carries session state today. */
  dirtyTabIds?: readonly string[];
}>();

const emit = defineEmits<{
  select: [noteId: string];
  close: [noteId: string];
}>();

function isDirty(tabId: string): boolean {
  return props.dirtyTabIds?.includes(tabId) ?? false;
}
</script>

<style scoped>
.gq-editor-tabs__dirty-dot {
  display: inline-block;
  inline-size: 0.375rem;
  block-size: 0.375rem;
  flex-shrink: 0;
  border-radius: 999px;
  background: var(--gq-status-warning);
}
</style>
