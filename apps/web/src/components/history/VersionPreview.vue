<template>
  <section class="flex min-h-0 flex-1 flex-col" aria-label="Version preview">
    <div v-if="version" class="flex min-h-0 flex-1 flex-col">
      <header
        class="flex items-center justify-between border-b border-gray-200 px-3 py-2 text-xs text-gray-500"
      >
        <span>Revision {{ version.revision }} · {{ reasonLabel }}</span>
        <span>{{ version.createdBy.displayName }} · {{ formattedDate }}</span>
      </header>
      <!--
        Read-only by construction: a <pre> with no contenteditable, no
        v-html, and no input handler. Text interpolation (not v-html) keeps
        arbitrary note content from ever being parsed as markup.
      -->
      <pre
        class="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words px-3 py-2 text-sm text-gray-800"
        tabindex="0"
        aria-readonly="true"
        data-testid="version-preview-body"
        >{{ version.contentMarkdown }}</pre>
    </div>
    <p v-else class="flex flex-1 items-center justify-center px-3 py-6 text-sm text-gray-400">
      Select a version to preview it.
    </p>
  </section>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { describeVersionReason } from "../../lib/versionReasons.js";
import type { NoteVersionResult } from "@glyphquire/api-contract";

const props = defineProps<{
  version: NoteVersionResult | null;
}>();

const reasonLabel = computed(() =>
  props.version ? describeVersionReason(props.version.reason) : "",
);

const formattedDate = computed(() => {
  if (!props.version) return "";
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(props.version.createdAt));
  } catch {
    return props.version.createdAt;
  }
});
</script>
