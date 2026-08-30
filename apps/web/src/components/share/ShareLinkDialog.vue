<template>
  <section aria-label="Share link" class="space-y-3 rounded border border-gray-200 p-4">
    <h2 class="text-sm font-semibold text-gray-900">Read-only sharing</h2>
    <label class="block text-sm text-gray-700">
      Optional expiry
      <input
        v-model="expiresAtLocal"
        type="datetime-local"
        aria-label="Share link expiry"
        class="mt-1 block rounded border border-gray-300 px-2 py-1 text-sm"
      />
    </label>
    <button
      type="button"
      aria-label="Create share link"
      :disabled="store.busy"
      class="rounded bg-gray-900 px-3 py-2 text-sm text-white disabled:opacity-50"
      @click="createLink"
    >
      Create share link
    </button>

    <ul v-if="noteLinks.length" aria-label="Active share links" class="space-y-2 text-sm">
      <li v-for="link in noteLinks" :key="link.id" class="rounded bg-gray-50 p-2">
        <a
          :href="link.url"
          aria-label="Read-only share link"
          target="_blank"
          rel="noopener noreferrer"
          referrerpolicy="no-referrer"
          class="underline"
          >Open read-only link</a
        >
        <button
          type="button"
          aria-label="Revoke share link"
          class="ml-3 text-red-700 underline"
          @click="revoke(link.id)"
        >
          Revoke
        </button>
      </li>
    </ul>
    <p v-if="inputError" role="alert" class="text-sm text-red-700">{{ inputError }}</p>
    <p v-else-if="store.error" role="alert" class="text-sm text-red-700">{{ store.error }}</p>
    <p aria-live="polite" class="sr-only">{{ status }}</p>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { usePhase5Store } from "../../stores/phase5.js";

const props = defineProps<{ noteId: string }>();
const store = usePhase5Store();
const expiresAtLocal = ref("");
const inputError = ref<string | null>(null);
const status = ref("");
const noteLinks = computed(() => store.shareLinks.filter((link) => link.noteId === props.noteId));

function expiryInput(): { expiresAt?: string } | null {
  if (expiresAtLocal.value === "") return {};
  const parsed = new Date(expiresAtLocal.value);
  if (!Number.isFinite(parsed.getTime()) || parsed.getTime() <= Date.now()) return null;
  return { expiresAt: parsed.toISOString() };
}

async function createLink(): Promise<void> {
  const input = expiryInput();
  if (!input) {
    inputError.value = "Choose a future expiry time.";
    return;
  }
  inputError.value = null;
  try {
    await store.createShareLink(props.noteId, input);
    status.value = "Read-only share link created.";
  } catch {
    status.value = "Share link was not created.";
  }
}

async function revoke(linkId: string): Promise<void> {
  try {
    await store.revokeShareLink(linkId);
    status.value = "Share link revoked.";
  } catch {
    status.value = "Share link was not revoked.";
  }
}
</script>
