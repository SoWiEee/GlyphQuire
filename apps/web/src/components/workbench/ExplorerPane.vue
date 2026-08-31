<template>
  <nav
    class="gq-explorer-pane w-56 shrink-0 overflow-y-auto border-r border-gray-200 bg-gray-50"
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

    <div class="grid gap-1 border-t border-gray-200 px-3 py-3">
      <p v-if="!workspaceAvailable" id="explorer-workspace-unavailable" class="sr-only">
        Workspace actions are unavailable until an authenticated workspace is selected.
      </p>
      <button
        type="button"
        aria-label="Search notes"
        :aria-describedby="workspaceAvailable ? undefined : 'explorer-workspace-unavailable'"
        class="rounded px-2 py-1.5 text-left text-sm text-gray-700 hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-50"
        :disabled="!workspaceAvailable"
        @click="emit('search')"
      >
        Search notes
      </button>
      <button
        type="button"
        aria-label="Open shared links"
        :aria-describedby="workspaceAvailable ? undefined : 'explorer-workspace-unavailable'"
        class="rounded px-2 py-1.5 text-left text-sm text-gray-700 hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-50"
        :disabled="!workspaceAvailable"
        @click="emit('shared-links')"
      >
        Shared links
      </button>
    </div>
  </nav>
</template>

<script setup lang="ts">
import type { WorkbenchNote } from "./types.js";

withDefaults(
  defineProps<{
    notes: readonly WorkbenchNote[];
    activeNoteId: string | null;
    workspaceAvailable?: boolean;
  }>(),
  { workspaceAvailable: false },
);

const emit = defineEmits<{
  select: [noteId: string];
  search: [];
  "shared-links": [];
}>();
</script>
