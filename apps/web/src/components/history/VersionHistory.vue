<template>
  <div class="gq-version-history flex h-full min-h-0" aria-label="Version history">
    <div class="flex w-72 shrink-0 flex-col border-r border-gray-200">
      <div class="flex items-center justify-between px-3 py-2">
        <h2 class="text-xs font-semibold uppercase tracking-wide text-gray-500">History</h2>
        <button
          type="button"
          class="rounded px-1.5 py-0.5 text-xs font-medium text-gray-600 hover:bg-gray-100"
          :disabled="!hasValidRevision"
          @click="checkpointOpen = true"
        >
          Checkpoint
        </button>
      </div>
      <p v-if="store.error" role="alert" class="px-3 pb-2 text-xs text-red-600">
        {{ store.error }}
      </p>
      <ul class="min-h-0 flex-1 overflow-y-auto" aria-label="Versions">
        <li v-for="version in versions" :key="version.id">
          <button
            type="button"
            class="w-full px-3 py-2 text-left text-sm"
            :class="version.id === selectedVersionId ? 'bg-gray-200' : 'hover:bg-gray-100'"
            :aria-current="version.id === selectedVersionId ? 'true' : undefined"
            @click="select(version.id)"
          >
            <span class="block font-medium text-gray-800">Revision {{ version.revision }}</span>
            <span class="block text-xs text-gray-500">
              {{ describeVersionReason(version.reason) }} · {{ version.createdBy.displayName }}
            </span>
          </button>
        </li>
        <li v-if="versions.length === 0 && !store.loading" class="px-3 py-4 text-xs text-gray-400">
          No history yet.
        </li>
      </ul>
      <button
        v-if="hasMore"
        type="button"
        class="border-t border-gray-200 px-3 py-2 text-xs text-gray-600 hover:bg-gray-50"
        @click="store.loadMore(noteId)"
      >
        Load more
      </button>
    </div>

    <div class="flex min-h-0 flex-1 flex-col">
      <VersionPreview :version="selectedVersion" />
      <div v-if="selectedVersion" class="border-t border-gray-200 px-3 py-2">
        <button
          type="button"
          class="rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
          :disabled="!hasValidRevision"
          @click="confirmRestore = true"
        >
          Restore this version
        </button>
      </div>
    </div>
  </div>

  <CheckpointDialog
    v-if="checkpointOpen"
    :note-id="noteId"
    :base-revision="currentRevision ?? 0"
    @created="onCheckpointCreated"
    @cancel="checkpointOpen = false"
  />

  <ConfirmDialog
    v-if="confirmRestore && selectedVersion"
    :title="`Restore revision ${selectedVersion.revision}?`"
    confirm-label="Restore"
    @confirm="onConfirmRestore"
    @cancel="confirmRestore = false"
  >
    This replaces the note's current content (revision {{ currentRevision }}) with the content from
    revision {{ selectedVersion.revision }}. The note moves forward to a new revision — nothing
    already in history is lost.
  </ConfirmDialog>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import CheckpointDialog from "./CheckpointDialog.vue";
import VersionPreview from "./VersionPreview.vue";
import ConfirmDialog from "../common/ConfirmDialog.vue";
import { describeVersionReason } from "../../lib/versionReasons.js";
import { useNoteVersionsStore } from "../../stores/noteVersions.js";
import type { CheckpointNoteResult, NoteResult, NoteVersionResult } from "@glyphquire/api-contract";

const props = defineProps<{
  noteId: string;
  currentRevision: number | null;
}>();

const emit = defineEmits<{
  restored: [result: NoteResult];
}>();

const store = useNoteVersionsStore();
const selectedVersionId = ref<string | null>(null);
const selectedVersion = ref<NoteVersionResult | null>(null);
const checkpointOpen = ref(false);
const confirmRestore = ref(false);

const versions = computed(() => store.summariesByNote.get(props.noteId) ?? []);
const hasMore = computed(() => Boolean(store.cursorByNote.get(props.noteId)));
const hasValidRevision = computed(
  () => Number.isInteger(props.currentRevision) && (props.currentRevision ?? 0) > 0,
);

async function load(): Promise<void> {
  await store.load(props.noteId);
}

onMounted(load);
watch(
  () => props.noteId,
  () => {
    selectedVersionId.value = null;
    selectedVersion.value = null;
    void load();
  },
);

async function select(versionId: string): Promise<void> {
  selectedVersionId.value = versionId;
  selectedVersion.value = await store.getVersion(props.noteId, versionId);
}

function onCheckpointCreated(result: CheckpointNoteResult): void {
  checkpointOpen.value = false;
  selectedVersionId.value = result.version.id;
  selectedVersion.value = result.version;
}

async function onConfirmRestore(): Promise<void> {
  confirmRestore.value = false;
  const version = selectedVersion.value;
  if (!version || !hasValidRevision.value || props.currentRevision === null) return;
  const result = await store.restoreVersion(props.noteId, version.id, props.currentRevision);
  emit("restored", result);
}
</script>
