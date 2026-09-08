<template>
  <section aria-label="Search notes" class="space-y-3 rounded border border-border p-4">
    <h2 class="text-sm font-semibold text-foreground">Search</h2>
    <form class="flex gap-2" @submit.prevent="runSearch">
      <input
        v-model="query"
        type="search"
        aria-label="Search notes"
        maxlength="512"
        autocomplete="off"
        class="min-w-0 flex-1 rounded border border-border px-3 py-2 text-sm"
      />
      <button
        type="button"
        aria-label="Run search"
        :disabled="!canSearch || store.busy"
        class="rounded bg-accent px-3 py-2 text-sm text-accent-contrast disabled:opacity-50"
        @click="runSearch"
      >
        Search
      </button>
    </form>

    <ul v-if="store.searchResults.length" aria-label="Search results" class="space-y-2">
      <li v-for="result in store.searchResults" :key="`${result.noteId}:${result.revision}`">
        <button
          type="button"
          aria-label="Open search result"
          class="w-full rounded border border-border p-2 text-left"
          @click="emit('select-note', result.noteId)"
        >
          <span class="block text-sm font-medium text-foreground">{{ result.title }}</span>
          <span class="block text-xs text-foreground">{{ result.snippet }}</span>
        </button>
      </li>
    </ul>
    <p v-else-if="searched && !store.error" class="text-sm text-muted">No matching notes.</p>
    <p v-if="store.error" role="alert" class="text-sm text-danger">{{ store.error }}</p>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { useWorkspaceToolsStore } from "../../stores/workspace-tools.js";

const props = defineProps<{ workspaceId: string }>();
const emit = defineEmits<{ "select-note": [noteId: string] }>();
const store = useWorkspaceToolsStore();
const query = ref("");
const searched = ref(false);
const canSearch = computed(() => {
  const trimmed = query.value.trim();
  return trimmed.length > 0 && new TextEncoder().encode(trimmed).byteLength <= 512;
});

async function runSearch(): Promise<void> {
  if (!canSearch.value) return;
  searched.value = true;
  try {
    await store.searchWorkspace({
      workspaceId: props.workspaceId,
      q: query.value.trim(),
      pageSize: 20,
    });
  } catch {
    // The store renders the stable, non-enumerating public error.
  }
}
</script>
