<template>
  <section aria-labelledby="custom-block-picker-heading" class="space-y-2">
    <h3
      id="custom-block-picker-heading"
      class="text-xs font-semibold uppercase tracking-wide text-gray-500"
    >
      Insert a Custom Block
    </h3>
    <p v-if="published.length === 0" class="text-xs text-gray-500">
      Publish a definition to make it available here.
    </p>
    <ul v-else class="grid gap-1">
      <li v-for="record in published" :key="record.id">
        <button
          type="button"
          class="flex w-full items-center gap-2 rounded border px-2 py-2 text-left text-sm hover:bg-gray-50"
          @click="emit('insert', serialize(record))"
        >
          <GqIcon :name="record.definition.icon" size="sm" />
          <span class="min-w-0 flex-1 truncate">{{ record.name }}</span>
          <span class="text-[10px] uppercase text-gray-500">v{{ record.version }}</span>
        </button>
      </li>
    </ul>
  </section>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type { CustomBlockRecord } from "@glyphquire/api-contract";
import GqIcon from "../icons/GqIcon.vue";

const props = defineProps<{ definitions: readonly CustomBlockRecord[] }>();
const emit = defineEmits<{ insert: [markdown: string] }>();
const published = computed(() =>
  props.definitions.filter((record) => record.status === "published"),
);

function escapeAttribute(value: string): string {
  return value.replace(/[\\"]/gu, (character) => `\\${character}`);
}

function serialize(record: CustomBlockRecord): string {
  const attributes = Object.entries(record.definition.propsSchema)
    .filter(([, descriptor]) => descriptor.default !== undefined)
    .map(([name, descriptor]) => `${name}=\"${escapeAttribute(String(descriptor.default))}\"`);
  const opening = `:::${record.name}{version=\"${record.version}\"${attributes.length ? ` ${attributes.join(" ")}` : ""}}`;
  return record.definition.contentPolicy === "none" ? `${opening}\n:::` : `${opening}\n\n:::`;
}
</script>
