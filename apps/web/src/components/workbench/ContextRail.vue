<template>
  <div v-if="open" :class="compact ? 'gq-context-rail-layer' : undefined">
    <button
      v-if="compact"
      data-testid="context-rail-scrim"
      class="gq-context-rail__scrim"
      aria-hidden="true"
      tabindex="-1"
      type="button"
      @click="emit('close')"
    />
    <aside
      ref="dialogRef"
      :role="compact ? 'dialog' : undefined"
      :aria-modal="compact ? 'true' : undefined"
      :tabindex="compact ? -1 : undefined"
      aria-label="工具面板"
      id="context-rail"
      data-testid="context-rail"
      class="gq-context-rail"
      @keydown.esc="emit('close')"
    >
      <header class="gq-context-rail__header">
        <div>
          <h2 class="gq-context-rail__heading text-xs font-semibold uppercase tracking-wide">
            工具
          </h2>
          <p v-if="noteTitle" class="gq-context-rail__note text-sm text-foreground">
            {{ noteTitle }}
          </p>
        </div>
        <button
          ref="closeRef"
          type="button"
          aria-label="關閉工具面板"
          class="gq-context-rail__close rounded p-1 hover:bg-surface-muted hover:text-foreground"
          @click="emit('close')"
        >
          <GqIcon name="x" size="sm" />
        </button>
      </header>

      <ol v-if="outline.length" aria-label="文件大綱" class="gq-context-rail__outline">
        <li
          v-for="entry in outline"
          :key="entry.id"
          :data-outline-entry-id="entry.id"
          :style="{ paddingInlineStart: `${(entry.depth - 1) * 0.75}rem` }"
        >
          <button
            type="button"
            class="w-full rounded px-2 py-1 text-left text-sm text-foreground hover:bg-surface-muted"
            @click="emit('selectOutline', entry.id)"
          >
            {{ entry.label }}
          </button>
        </li>
      </ol>

      <nav aria-label="筆記工具" class="gq-context-rail__actions">
        <p v-if="!workspaceAvailable" id="context-rail-workspace-unavailable" class="sr-only">
          尚未選擇已驗證的工作區，工作區工具無法使用。
        </p>
        <p v-if="!noteAvailable" id="context-rail-note-unavailable" class="sr-only">
          尚未開啟筆記，筆記工具無法使用。
        </p>
        <p
          v-if="workspaceAvailable && noteAvailable && (!currentRevision || currentRevision <= 0)"
          id="context-rail-history-unavailable"
          class="sr-only"
        >
          尚無有效的目前版本，版本歷史無法使用。
        </p>
        <button
          type="button"
          aria-label="開啟版本歷史"
          :aria-describedby="
            !workspaceAvailable
              ? 'context-rail-workspace-unavailable'
              : !noteAvailable
                ? 'context-rail-note-unavailable'
                : !currentRevision || currentRevision <= 0
                  ? 'context-rail-history-unavailable'
                  : undefined
          "
          :disabled="
            !workspaceAvailable || !noteAvailable || !currentRevision || currentRevision <= 0
          "
          @click="emit('action', 'history')"
        >
          歷史
        </button>
        <button
          type="button"
          aria-label="管理素材"
          :aria-describedby="workspaceAvailable ? undefined : 'context-rail-workspace-unavailable'"
          :disabled="!workspaceAvailable"
          @click="emit('action', 'assets')"
        >
          素材
        </button>
        <button
          type="button"
          aria-label="管理自訂區塊"
          :aria-describedby="workspaceAvailable ? undefined : 'context-rail-workspace-unavailable'"
          :disabled="!workspaceAvailable"
          @click="emit('action', 'custom-blocks')"
        >
          自訂區塊
        </button>
      </nav>
    </aside>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { trapFocus, type FocusTrapHandle } from "../../lib/focusTrap.js";
import GqIcon from "../icons/GqIcon.vue";
import type { ContextAction, OutlineEntry } from "./types.js";

const props = defineProps<{
  open: boolean;
  compact: boolean;
  noteTitle: string | null;
  workspaceAvailable: boolean;
  noteAvailable: boolean;
  outline: readonly OutlineEntry[];
  currentRevision: number | null;
}>();

const emit = defineEmits<{
  close: [];
  action: [action: Exclude<ContextAction, "outline">];
  selectOutline: [id: string];
}>();

const dialogRef = ref<HTMLElement | null>(null);
const closeRef = ref<HTMLButtonElement | null>(null);
let trap: FocusTrapHandle | undefined;

function releaseTrap(): void {
  trap?.release();
  trap = undefined;
}

function syncTrap(): void {
  releaseTrap();
  if (!props.open || !props.compact) return;
  if (dialogRef.value) trap = trapFocus(dialogRef.value, closeRef.value);
}

watch(() => [props.open, props.compact] as const, syncTrap, { flush: "post" });

onMounted(syncTrap);
onBeforeUnmount(releaseTrap);
</script>

<style scoped>
.gq-context-rail-layer {
  position: fixed;
  inset: 0;
  z-index: 40;
}

.gq-context-rail__scrim {
  position: absolute;
  inset: 0;
  width: 100%;
  border: 0;
  background: var(--gq-color-scrim);
}

.gq-context-rail {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  overflow-y: auto;
  background: var(--gq-surface);
  color: var(--gq-color-foreground);
}

.gq-context-rail__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  padding: 1rem;
  border-bottom: 1px solid var(--gq-color-border);
}

.gq-context-rail__heading,
.gq-context-rail__close {
  color: var(--gq-color-muted);
}

.gq-context-rail__outline,
.gq-context-rail__actions {
  display: grid;
  gap: 0.25rem;
  padding-inline: 1rem;
}

.gq-context-rail__actions button {
  min-height: 2rem;
  border-radius: 0.375rem;
  padding: 0.375rem 0.5rem;
  text-align: left;
  font-size: 0.875rem;
  color: var(--gq-color-foreground);
}

.gq-context-rail__actions button:hover:not(:disabled) {
  background: var(--gq-surface-muted);
}

.gq-context-rail__actions button:disabled {
  cursor: not-allowed;
}

@media (min-width: 48rem) {
  .gq-context-rail {
    width: 18rem;
    min-width: 18rem;
    height: 100%;
    border-inline-start: 1px solid var(--gq-color-border);
  }
}

@media (max-width: 47.999rem) {
  .gq-context-rail {
    position: absolute;
    top: 0;
    right: 0;
    width: min(88vw, 22rem);
    height: 100%;
    box-shadow: var(--gq-shadow-panel-right);
  }
}
</style>
