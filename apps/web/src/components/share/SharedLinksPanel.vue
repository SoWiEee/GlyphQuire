<template>
  <section aria-label="Shared links" class="space-y-3">
    <header>
      <h2 class="text-sm font-semibold text-foreground">Shared links</h2>
      <p class="text-xs text-muted">Read-only links cached during this authenticated session.</p>
    </header>

    <ul v-if="links.length" aria-label="Cached shared links" class="space-y-2">
      <li
        v-for="link in links"
        :key="link.id"
        class="flex items-center justify-between gap-3 rounded border border-border p-2"
      >
        <div class="min-w-0">
          <p class="truncate text-sm text-foreground">{{ link.noteId }}</p>
          <p class="text-xs text-muted">
            {{ link.expiresAt ? `Expires ${link.expiresAt}` : "No expiry" }}
          </p>
        </div>
        <div class="flex shrink-0 gap-2">
          <button
            type="button"
            aria-label="Open shared note"
            class="rounded border border-border px-2 py-1 text-xs text-foreground hover:bg-surface-muted"
            @click="emit('open', link.noteId)"
          >
            Open note
          </button>
          <button
            type="button"
            aria-label="Revoke shared link"
            class="rounded border border-red-300 px-2 py-1 text-xs text-red-700 hover:bg-red-50"
            @click="emit('revoke', link.id)"
          >
            Revoke
          </button>
        </div>
      </li>
    </ul>
    <p v-else data-testid="shared-links-empty" class="text-sm text-muted">No shared links.</p>
  </section>
</template>

<script setup lang="ts">
import type { ShareLinkResponse } from "@glyphquire/api-contract";

defineProps<{
  links: readonly ShareLinkResponse[];
}>();

const emit = defineEmits<{
  open: [noteId: string];
  revoke: [linkId: string];
}>();
</script>
