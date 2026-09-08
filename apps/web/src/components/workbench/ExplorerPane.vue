<template>
  <nav
    class="gq-explorer gq-explorer-pane w-56 shrink-0 overflow-y-auto border-r"
    aria-label="筆記側欄"
  >
    <h2 class="gq-explorer__heading px-3 pt-3 pb-2 text-xs font-semibold uppercase tracking-wide">
      筆記
    </h2>
    <ul class="pb-3">
      <li v-for="note in notes" :key="note.id">
        <button
          type="button"
          class="gq-explorer__note flex w-full items-center px-3 py-1.5 text-left text-sm"
          :class="{ 'gq-explorer__note--active': note.id === activeNoteId }"
          :data-active="note.id === activeNoteId ? 'true' : undefined"
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
  notes: readonly WorkbenchNote[];
  activeNoteId: string | null;
}>();

const emit = defineEmits<{ select: [noteId: string] }>();
</script>
