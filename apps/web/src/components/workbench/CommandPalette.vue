<template>
  <div
    class="fixed inset-0 z-50 flex items-start justify-center bg-black/30 pt-24"
    @click.self="closePalette"
  >
    <div
      ref="dialogRef"
      role="dialog"
      aria-modal="true"
      aria-label="命令面板"
      class="w-full max-w-md rounded-lg bg-surface shadow-xl"
      @keydown="onDialogKeydown"
    >
      <input
        ref="inputRef"
        v-model="query"
        type="text"
        class="w-full rounded-t-lg border-b border-border px-4 py-3 text-sm"
        placeholder="輸入命令…"
        aria-label="篩選命令"
        aria-controls="command-palette-options"
        :aria-activedescendant="activeDescendant"
      />
      <ul
        id="command-palette-options"
        role="listbox"
        aria-label="命令"
        class="max-h-64 overflow-y-auto py-1"
      >
        <li
          v-for="(command, index) in filtered"
          :key="command.id"
          role="option"
          :id="`command-palette-option-${index}`"
          :aria-selected="index === highlightedIndex"
          class="cursor-pointer px-4 py-2 text-sm"
          :class="index === highlightedIndex ? 'bg-surface-muted text-foreground' : 'text-foreground'"
          @mouseenter="highlightedIndex = index"
          @click="run(command)"
        >
          <div class="flex items-center justify-between">
            <span>{{ command.label }}</span>
            <span v-if="command.hint" class="text-xs text-muted">{{ command.hint }}</span>
          </div>
        </li>
        <li
          v-if="filtered.length === 0"
          data-testid="command-palette-empty"
          role="status"
          class="px-4 py-2 text-sm text-muted"
        >
          沒有符合的命令
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
  /** Commands supplied by a capability-gated surface, such as maintenance. */
  additionalCommands?: WorkbenchCommand[];
  initialQuery?: string;
  categoryFilter?: WorkbenchCommand["category"];
}>();

const emit = defineEmits<{
  close: [];
}>();

const query = ref(props.initialQuery ?? "");
const highlightedIndex = ref(0);
const inputRef = ref<HTMLInputElement | null>(null);
const dialogRef = ref<HTMLElement | null>(null);
const opener = ref<HTMLElement | null>(null);
const closed = ref(false);

const availableCommands = computed(() => {
  const commands = [...props.commands, ...(props.additionalCommands ?? [])];
  return props.categoryFilter
    ? commands.filter((command) => command.category === props.categoryFilter)
    : commands;
});
const filtered = computed(() => {
  const needle = query.value.trim().toLowerCase();
  if (!needle) return availableCommands.value;
  return availableCommands.value.filter((command) => command.label.toLowerCase().includes(needle));
});
const activeDescendant = computed(() =>
  filtered.value[highlightedIndex.value]
    ? `command-palette-option-${highlightedIndex.value}`
    : undefined,
);

function move(delta: number): void {
  const count = filtered.value.length;
  if (count === 0) return;
  highlightedIndex.value = (highlightedIndex.value + delta + count) % count;
}

function closePalette(): void {
  if (closed.value) return;
  closed.value = true;
  emit("close");
  void nextTick(() => opener.value?.focus());
}

function run(command: WorkbenchCommand): void {
  try {
    command.run();
  } finally {
    closePalette();
  }
}

function runHighlighted(): void {
  const command = filtered.value[highlightedIndex.value];
  if (command) run(command);
}

onMounted(() => {
  const activeElement = document.activeElement;
  if (activeElement instanceof HTMLElement) opener.value = activeElement;
  void nextTick(() => inputRef.value?.focus());
});

watch([query, () => props.categoryFilter], () => {
  highlightedIndex.value = 0;
});

watch(
  () => props.initialQuery,
  (initialQuery) => {
    query.value = initialQuery ?? "";
    highlightedIndex.value = 0;
  },
);

function onDialogKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    event.preventDefault();
    closePalette();
    return;
  }
  if (event.key === "ArrowDown") {
    event.preventDefault();
    move(1);
    return;
  }
  if (event.key === "ArrowUp") {
    event.preventDefault();
    move(-1);
    return;
  }
  if (event.key === "Home") {
    event.preventDefault();
    if (filtered.value.length > 0) highlightedIndex.value = 0;
    return;
  }
  if (event.key === "End") {
    event.preventDefault();
    if (filtered.value.length > 0) highlightedIndex.value = filtered.value.length - 1;
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    runHighlighted();
    return;
  }
  if (event.key !== "Tab") return;
  const focusable = dialogRef.value?.querySelectorAll<HTMLElement>(
    'button, input, [href], [tabindex]:not([tabindex="-1"])',
  );
  if (!focusable || focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}
</script>
