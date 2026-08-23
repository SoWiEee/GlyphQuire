<template>
  <div
    class="fixed inset-0 z-50 flex items-start justify-center bg-black/30 pt-24"
    @keydown.escape="emit('close')"
    @click.self="emit('close')"
  >
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      class="w-full max-w-md rounded-lg bg-white shadow-xl"
    >
      <input
        ref="inputRef"
        v-model="query"
        type="text"
        class="w-full rounded-t-lg border-b border-gray-200 px-4 py-3 text-sm outline-none"
        placeholder="Type a command…"
        aria-label="Filter commands"
        @keydown.down.prevent="move(1)"
        @keydown.up.prevent="move(-1)"
        @keydown.enter.prevent="runHighlighted"
      />
      <ul role="listbox" aria-label="Commands" class="max-h-64 overflow-y-auto py-1">
        <li
          v-for="(command, index) in filtered"
          :key="command.id"
          role="option"
          :aria-selected="index === highlightedIndex"
          class="cursor-pointer px-4 py-2 text-sm"
          :class="index === highlightedIndex ? 'bg-gray-100 text-gray-900' : 'text-gray-700'"
          @mouseenter="highlightedIndex = index"
          @click="run(command)"
        >
          <div class="flex items-center justify-between">
            <span>{{ command.label }}</span>
            <span v-if="command.hint" class="text-xs text-gray-400">{{ command.hint }}</span>
          </div>
        </li>
        <li v-if="filtered.length === 0" class="px-4 py-2 text-sm text-gray-400">
          No matching commands.
        </li>
      </ul>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import type { WorkbenchCommand } from "./types.js";

const props = defineProps<{
  commands: WorkbenchCommand[];
}>();

const emit = defineEmits<{
  close: [];
}>();

const query = ref("");
const highlightedIndex = ref(0);
const inputRef = ref<HTMLInputElement | null>(null);

const filtered = computed(() => {
  const needle = query.value.trim().toLowerCase();
  if (!needle) return props.commands;
  return props.commands.filter((command) => command.label.toLowerCase().includes(needle));
});

function move(delta: number): void {
  const count = filtered.value.length;
  if (count === 0) return;
  highlightedIndex.value = (highlightedIndex.value + delta + count) % count;
}

function run(command: WorkbenchCommand): void {
  command.run();
  emit("close");
}

function runHighlighted(): void {
  const command = filtered.value[highlightedIndex.value];
  if (command) run(command);
}

onMounted(() => {
  void nextTick(() => inputRef.value?.focus());
});

watch(query, () => {
  highlightedIndex.value = 0;
});
</script>
