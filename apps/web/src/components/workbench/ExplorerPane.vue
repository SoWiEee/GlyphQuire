<template>
  <nav
    class="gq-explorer gq-explorer-pane w-56 shrink-0 overflow-y-auto border-r"
    aria-label="Notes explorer"
  >
    <h2 class="gq-explorer__heading px-3 pt-3 pb-2 text-xs font-semibold uppercase tracking-wide">
      Notes
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

    <div class="gq-explorer__actions grid gap-1 border-t px-3 py-3">
      <p v-if="!workspaceAvailable" id="explorer-workspace-unavailable" class="sr-only">
        Workspace actions are unavailable until an authenticated workspace is selected.
      </p>
      <button
        type="button"
        aria-label="Search notes"
        :aria-describedby="workspaceAvailable ? undefined : 'explorer-workspace-unavailable'"
        class="gq-explorer__action rounded px-2 py-1.5 text-left text-sm disabled:cursor-not-allowed disabled:opacity-50"
        :disabled="!workspaceAvailable"
        @click="emit('search')"
      >
        Search notes
      </button>
      <button
        type="button"
        aria-label="Open shared links"
        :aria-describedby="workspaceAvailable ? undefined : 'explorer-workspace-unavailable'"
        class="gq-explorer__action rounded px-2 py-1.5 text-left text-sm disabled:cursor-not-allowed disabled:opacity-50"
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
