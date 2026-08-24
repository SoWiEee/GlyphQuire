<template>
  <div
    ref="containerRef"
    class="fixed inset-0 z-50 flex flex-col bg-white motion-safe:transition-opacity motion-safe:duration-150"
    role="dialog"
    aria-modal="true"
    aria-label="Resolve conflicting edits"
    @keydown.escape="onDismiss"
  >
    <p class="sr-only" role="status" aria-live="polite">{{ statusMessage }}</p>
    <p class="sr-only" aria-live="polite">{{ copyFeedback }}</p>

    <header class="flex items-center justify-between border-b border-gray-200 px-4 py-3">
      <div>
        <h1 class="text-sm font-semibold text-gray-900">Someone else saved changes to this note</h1>
        <p class="text-xs text-gray-500">
          Your edits were never sent — the server still has its own version. Merge the two below, then
          resubmit.
        </p>
      </div>
      <span
        class="rounded-full px-2 py-1 text-xs font-medium"
        :class="statusBadgeClass"
        data-testid="conflict-status-badge"
      >
        {{ statusLabel }}
      </span>
    </header>

    <p v-if="errorMessage" role="alert" class="border-b border-red-100 bg-red-50 px-4 py-2 text-xs text-red-700">
      {{ errorMessage }}
    </p>

    <section aria-label="Line differences between your version and the server version" class="border-b border-gray-200">
      <div class="flex items-center justify-between px-4 py-1.5">
        <h2 class="text-xs font-semibold uppercase tracking-wide text-gray-500">What changed</h2>
        <span class="text-xs text-gray-500">{{ diffSummary }}</span>
      </div>
      <div
        v-if="diffSegments"
        class="max-h-36 overflow-auto px-4 pb-2 font-mono text-xs leading-5"
        data-testid="diff-view"
      >
        <div v-for="(segment, index) in diffSegments" :key="index" :class="diffLineClass(segment.kind)">
          <span aria-hidden="true">{{ diffMarker(segment.kind) }}</span>{{ segment.text.length > 0 ? segment.text : " " }}
        </div>
      </div>
      <p v-else class="px-4 pb-2 text-xs text-gray-500">
        This document is too large to highlight line by line — compare the two panes below directly.
      </p>
    </section>

    <div class="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-2">
      <section aria-labelledby="conflict-local-heading" class="flex min-h-0 flex-col border-b border-gray-200 md:border-b-0 md:border-r">
        <div class="flex items-center justify-between px-3 py-2">
          <h2 id="conflict-local-heading" class="text-xs font-semibold uppercase tracking-wide text-gray-500">
            Your version (editable)
          </h2>
          <div class="flex gap-2">
            <button
              type="button"
              class="rounded px-2 py-1 text-xs font-medium text-gray-600 hover:bg-gray-100"
              @click="copyText('Your version', mergedMarkdown)"
            >
              Copy
            </button>
            <button
              type="button"
              class="rounded px-2 py-1 text-xs font-medium text-gray-600 hover:bg-gray-100"
              @click="useServerVersion"
            >
              Use server version
            </button>
          </div>
        </div>
        <label for="conflict-local-textarea" class="sr-only">Your version — editable, this is what will be resubmitted</label>
        <textarea
          id="conflict-local-textarea"
          ref="localTextareaRef"
          class="min-h-0 flex-1 resize-none border-0 p-3 font-mono text-sm text-gray-900 outline-none"
          spellcheck="false"
          data-testid="local-pane"
          :value="mergedMarkdown"
          @input="onLocalInput"
        ></textarea>
      </section>

      <section aria-labelledby="conflict-server-heading" class="flex min-h-0 flex-col">
        <div class="flex items-center justify-between px-3 py-2">
          <h2 id="conflict-server-heading" class="text-xs font-semibold uppercase tracking-wide text-gray-500">
            Server version (read-only)
          </h2>
          <button
            type="button"
            class="rounded px-2 py-1 text-xs font-medium text-gray-600 hover:bg-gray-100"
            @click="copyText('Server version', currentConflict.serverMarkdown)"
          >
            Copy
          </button>
        </div>
        <p class="px-3 pb-1 text-xs text-gray-500">
          Revision {{ currentConflict.serverRevision }} · saved {{ formattedServerUpdatedAt
          }}<template v-if="currentConflict.lastEditedBy"> by {{ currentConflict.lastEditedBy.displayName }}</template>
        </p>
        <!--
          Strictly read-only: a <pre> element with no contenteditable
          attribute, no v-html, and no input/keydown handler that could ever
          route a keystroke into this pane's content. Text interpolation
          only, so the server's Markdown is never parsed as HTML.
        -->
        <pre
          data-testid="server-pane"
          aria-readonly="true"
          tabindex="0"
          class="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-sm text-gray-800"
          >{{ currentConflict.serverMarkdown }}</pre
        >
      </section>
    </div>

    <footer class="flex items-center justify-between border-t border-gray-200 px-4 py-3">
      <button
        type="button"
        class="rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
        @click="onDismiss"
      >
        Keep working elsewhere
      </button>
      <button
        ref="resubmitRef"
        type="button"
        class="rounded-md bg-gray-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-800 disabled:opacity-50"
        :disabled="status === 'resubmitting'"
        data-testid="resubmit-button"
        @click="resubmit"
      >
        {{ status === "resubmitting" ? "Resubmitting…" : "Resubmit merged version" }}
      </button>
    </footer>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { NoteApiError, NoteConflictError, NoteOfflineError } from "../../api/NoteClient.js";
import { diffLines } from "../../lib/diffLines.js";
import { trapFocus } from "../../lib/focusTrap.js";
import { newOperationId } from "../../lib/operationId.js";
import type { FocusTrapHandle } from "../../lib/focusTrap.js";
import type { DiffSegment, DiffSegmentKind } from "../../lib/diffLines.js";
import type { DraftKey, DraftStore } from "../../persistence/DraftStore.js";
import type { NoteConflict, NoteResult, SaveNoteInput } from "@glyphquire/api-contract";

/** The narrow slice of {@link NoteClient} this workspace depends on. */
export interface ConflictNoteClient {
  save(noteId: string, input: SaveNoteInput): Promise<NoteResult>;
}

type RecoveryStatus = "idle" | "resubmitting" | "resubmitted" | "error";

const DRAFT_PERSIST_DEBOUNCE_MS = 400;

const props = defineProps<{
  noteId: string;
  userId: string;
  workspaceId: string;
  conflict: NoteConflict;
  localMarkdown: string;
  noteClient: ConflictNoteClient;
  draftStore: DraftStore;
}>();

const emit = defineEmits<{
  resolved: [result: NoteResult];
  dismiss: [];
}>();

const containerRef = ref<HTMLElement | null>(null);
const localTextareaRef = ref<HTMLTextAreaElement | null>(null);
const resubmitRef = ref<HTMLButtonElement | null>(null);

const mergedMarkdown = ref(props.localMarkdown);
const currentConflict = ref<NoteConflict>(props.conflict);
const status = ref<RecoveryStatus>("idle");
const errorMessage = ref<string | null>(null);
const copyFeedback = ref<string | null>(null);

let trap: FocusTrapHandle | undefined;
let persistTimer: ReturnType<typeof setTimeout> | undefined;
let copyFeedbackTimer: ReturnType<typeof setTimeout> | undefined;
let draftStorageOperationId = newOperationId();

const draftKey: DraftKey = {
  userId: props.userId,
  workspaceId: props.workspaceId,
  noteId: props.noteId,
};

const diffSegments = computed<DiffSegment[] | null>(() =>
  diffLines(mergedMarkdown.value, currentConflict.value.serverMarkdown),
);

const diffSummary = computed(() => {
  const segments = diffSegments.value;
  if (!segments) return "too large to diff";
  const changed = segments.filter((segment) => segment.kind !== "equal").length;
  return changed === 0 ? "no differences" : `${changed} line${changed === 1 ? "" : "s"} differ`;
});

const statusLabel = computed(() => {
  switch (status.value) {
    case "resubmitting":
      return "Resubmitting…";
    case "resubmitted":
      return "Resolved";
    case "error":
      return "Needs attention";
    default:
      return "Unresolved conflict";
  }
});

const statusMessage = computed(() => {
  switch (status.value) {
    case "resubmitting":
      return "Resubmitting your merged version.";
    case "resubmitted":
      return "Conflict resolved. Your merged version was saved.";
    case "error":
      return errorMessage.value ?? "Resubmit failed.";
    default:
      return "A newer server version exists. Review both versions and resubmit to save.";
  }
});

const statusBadgeClass = computed(() => {
  switch (status.value) {
    case "resubmitted":
      return "bg-green-100 text-green-800";
    case "error":
      return "bg-red-100 text-red-700";
    default:
      return "bg-amber-100 text-amber-800";
  }
});

const formattedServerUpdatedAt = computed(() => {
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
      new Date(currentConflict.value.serverUpdatedAt),
    );
  } catch {
    return currentConflict.value.serverUpdatedAt;
  }
});

function diffLineClass(kind: DiffSegmentKind): string {
  switch (kind) {
    case "local-only":
      return "bg-blue-50 text-blue-800";
    case "server-only":
      return "bg-amber-50 text-amber-900";
    default:
      return "text-gray-500";
  }
}

function diffMarker(kind: DiffSegmentKind): string {
  switch (kind) {
    case "local-only":
      return "− ";
    case "server-only":
      return "+ ";
    default:
      return "  ";
  }
}

function onLocalInput(event: Event): void {
  mergedMarkdown.value = (event.target as HTMLTextAreaElement).value;
  scheduleDraftPersist();
}

function useServerVersion(): void {
  mergedMarkdown.value = currentConflict.value.serverMarkdown;
  if (localTextareaRef.value) localTextareaRef.value.value = mergedMarkdown.value;
  void persistDraft();
}

async function copyText(label: string, text: string): Promise<void> {
  try {
    await writeClipboardText(text);
    copyFeedback.value = `${label} copied to clipboard.`;
  } catch {
    copyFeedback.value = `Could not copy the ${label.toLowerCase()}.`;
  } finally {
    if (copyFeedbackTimer) clearTimeout(copyFeedbackTimer);
    copyFeedbackTimer = setTimeout(() => {
      copyFeedback.value = null;
    }, 2500);
  }
}

async function writeClipboardText(text: string): Promise<void> {
  const clipboard = navigator.clipboard;
  if (clipboard?.writeText) {
    await clipboard.writeText(text);
    return;
  }
  const el = document.createElement("textarea");
  el.value = text;
  el.style.position = "fixed";
  el.style.opacity = "0";
  document.body.appendChild(el);
  el.focus();
  el.select();
  try {
    const copied = document.execCommand("copy");
    if (!copied) throw new Error("execCommand copy was rejected");
  } finally {
    document.body.removeChild(el);
  }
}

function scheduleDraftPersist(): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    void persistDraft();
  }, DRAFT_PERSIST_DEBOUNCE_MS);
}

async function persistDraft(): Promise<void> {
  try {
    await props.draftStore.put({
      ...draftKey,
      operationId: draftStorageOperationId,
      baseRevision: currentConflict.value.serverRevision,
      markdown: mergedMarkdown.value,
      conflict: currentConflict.value,
      updatedAt: Date.now(),
    });
  } catch {
    // Best-effort durability only — in-memory state remains authoritative for this tab.
  }
}

async function clearDraft(): Promise<void> {
  try {
    await props.draftStore.delete(draftKey);
  } catch {
    // Best-effort cleanup only.
  }
}

async function recoverDraft(): Promise<void> {
  try {
    const existing = await props.draftStore.get(draftKey);
    if (existing?.conflict && existing.conflict.noteId === props.noteId) {
      mergedMarkdown.value = existing.markdown;
      currentConflict.value = existing.conflict;
      draftStorageOperationId = existing.operationId;
      if (localTextareaRef.value) localTextareaRef.value.value = existing.markdown;
    }
  } catch {
    // Best-effort recovery only — editing still starts from the supplied local Markdown.
  }
}

function describeError(error: unknown): string {
  if (error instanceof NoteOfflineError) {
    return "You appear to be offline. Your merged version is kept locally — try resubmitting once you're back online.";
  }
  if (error instanceof NoteApiError) {
    return `The server rejected the resubmit (${error.code}). Your merged version is kept locally — try again.`;
  }
  return "Resubmitting failed. Your merged version is kept locally — try again.";
}

/**
 * The only place this component ever calls `noteClient.save`. It always
 * sends the currently *displayed* server revision as `baseRevision` and a
 * freshly minted operation id — never the stale revision the local edit was
 * originally based on — so this can never silently overwrite a version the
 * user has not seen. A second conflict here updates the displayed server
 * pane and asks the user to reconcile again instead of retrying blindly.
 */
async function resubmit(): Promise<void> {
  if (status.value === "resubmitting") return;
  status.value = "resubmitting";
  errorMessage.value = null;
  const operationId = newOperationId();
  const baseRevision = currentConflict.value.serverRevision;
  try {
    const result = await props.noteClient.save(props.noteId, {
      operationId,
      baseRevision,
      contentMarkdown: mergedMarkdown.value,
    });
    status.value = "resubmitted";
    await clearDraft();
    emit("resolved", result);
  } catch (error) {
    if (error instanceof NoteConflictError) {
      currentConflict.value = error.conflict;
      draftStorageOperationId = newOperationId();
      status.value = "error";
      errorMessage.value =
        "The server changed again while you were resubmitting. Review the updated server version below and resubmit.";
      await persistDraft();
      return;
    }
    status.value = "error";
    errorMessage.value = describeError(error);
  }
}

function onDismiss(): void {
  emit("dismiss");
}

onMounted(() => {
  if (containerRef.value) trap = trapFocus(containerRef.value, localTextareaRef.value);
  void recoverDraft();
});

onBeforeUnmount(() => {
  trap?.release();
  if (persistTimer) clearTimeout(persistTimer);
  if (copyFeedbackTimer) clearTimeout(copyFeedbackTimer);
});
</script>
