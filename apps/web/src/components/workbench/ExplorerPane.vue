<template>
  <nav
    class="w-56 shrink-0 overflow-y-auto border-r border-gray-200 bg-gray-50"
    aria-label="Notes explorer"
  >
    <h2 class="px-3 pt-3 pb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
      Notes
    </h2>
    <ul class="pb-3">
      <li v-for="note in notes" :key="note.id">
        <button
          type="button"
          class="flex w-full items-center px-3 py-1.5 text-left text-sm"
          :class="
            note.id === activeNoteId
              ? 'bg-gray-200 font-medium text-gray-900'
              : 'text-gray-700 hover:bg-gray-100'
          "
          :aria-current="note.id === activeNoteId ? 'true' : undefined"
          @click="emit('select', note.id)"
        >
          <span class="truncate">{{ note.title }}</span>
        </button>
      </li>
    </ul>
  </nav>
</template>

<script setup lang="ts">
import type { WorkbenchNote } from "./types.js";

defineProps<{
  notes: WorkbenchNote[];
  activeNoteId: string | null;
}>();

const emit = defineEmits<{
  select: [noteId: string];
}>();
</script>
