<template>
  <section aria-label="Search notes" class="space-y-3 rounded border border-gray-200 p-4">
    <h2 class="text-sm font-semibold text-gray-900">Search</h2>
    <form class="flex gap-2" @submit.prevent="runSearch">
      <input
        v-model="query"
        type="search"
        aria-label="Search notes"
        maxlength="512"
        autocomplete="off"
        class="min-w-0 flex-1 rounded border border-gray-300 px-3 py-2 text-sm"
      />
      <button
        type="button"
        aria-label="Run search"
        :disabled="!canSearch || store.busy"
        class="rounded bg-gray-900 px-3 py-2 text-sm text-white disabled:opacity-50"
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
          class="w-full rounded border border-gray-200 p-2 text-left"
          @click="emit('select-note', result.noteId)"
        >
          <span class="block text-sm font-medium text-gray-900">{{ result.title }}</span>
          <span class="block text-xs text-gray-700">{{ result.snippet }}</span>
        </button>
      </li>
    </ul>
    <p v-else-if="searched && !store.error" class="text-sm text-gray-600">No matching notes.</p>
    <p v-if="store.error" role="alert" class="text-sm text-red-700">{{ store.error }}</p>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { usePhase5Store } from "../../stores/phase5.js";

const props = defineProps<{ workspaceId: string }>();
const emit = defineEmits<{ "select-note": [noteId: string] }>();
const store = usePhase5Store();
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
