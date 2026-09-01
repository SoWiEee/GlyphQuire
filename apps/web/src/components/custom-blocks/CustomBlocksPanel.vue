<template>
  <div class="space-y-5">
    <header class="flex items-start justify-between gap-3">
      <div>
        <h2 class="text-base font-semibold text-gray-900">Custom Blocks</h2>
        <p class="mt-1 text-xs text-gray-500">
          Workspace definitions use approved presets and stay safe to share.
        </p>
      </div>
      <button
        type="button"
        class="rounded border px-2 py-1 text-xs"
        aria-label="Close custom blocks"
        @click="emit('close')"
      >
        Close
      </button>
    </header>
    <p
      v-if="store.error"
      class="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700"
      role="alert"
    >
      {{ store.error }}
    </p>
    <p v-if="store.loading" class="text-xs text-gray-500" role="status">Loading definitions…</p>
    <CustomBlockPicker :definitions="store.definitions" @insert="onInsert" />
    <section class="border-t pt-4">
      <div class="mb-2 flex items-center justify-between">
        <h3 class="text-xs font-semibold uppercase tracking-wide text-gray-500">Definitions</h3>
        <button
          v-if="!showForm"
          type="button"
          class="rounded bg-gray-900 px-2 py-1 text-xs font-medium text-white"
          @click="showForm = true"
        >
          New block
        </button>
      </div>
      <CustomBlockForm v-if="showForm" @save="onCreate" @cancel="showForm = false" />
      <ul v-else class="grid gap-2">
        <li
          v-for="record in store.definitions"
          :key="record.id"
          class="flex items-center gap-2 rounded border px-2 py-2 text-sm"
        >
          <GqIcon :name="record.definition.icon" size="sm" />
          <span class="min-w-0 flex-1 truncate">{{ record.name }}</span>
          <span class="text-[10px] uppercase text-gray-500"
            >{{ record.status }} · v{{ record.version }}</span
          >
          <button
            v-if="record.status === 'draft'"
            type="button"
            class="rounded border px-2 py-1 text-[11px]"
            @click="onPublish(record.id)"
          >
            Publish
          </button>
          <button
            v-if="record.status === 'draft'"
            type="button"
            class="rounded border px-2 py-1 text-[11px] text-red-700"
            @click="onRemove(record.id)"
          >
            Delete
          </button>
        </li>
      </ul>
    </section>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from "vue";
import type { CustomBlockDefinition } from "@glyphquire/theme-sdk";
import { useCustomBlocksStore } from "../../stores/custom-blocks.js";
import CustomBlockForm from "./CustomBlockForm.vue";
import CustomBlockPicker from "./CustomBlockPicker.vue";
import GqIcon from "../icons/GqIcon.vue";

const props = defineProps<{ workspaceId: string }>();
const emit = defineEmits<{ close: []; insert: [markdown: string] }>();
const store = useCustomBlocksStore();
const showForm = ref(false);

async function onCreate(definition: CustomBlockDefinition): Promise<void> {
  try {
    await store.create(definition);
    showForm.value = false;
  } catch {
    // Store owns the user-facing error projection.
  }
}

async function onPublish(id: string): Promise<void> {
  try {
    await store.publish(id);
  } catch {
    // Store owns the user-facing error projection.
  }
}

async function onRemove(id: string): Promise<void> {
  try {
    await store.remove(id);
  } catch {
    // Store owns the user-facing error projection.
  }
}

function onInsert(markdown: string): void {
  emit("insert", markdown);
}

onMounted(() => {
  if (store.workspaceId !== props.workspaceId) void store.load(props.workspaceId);
});
</script>
