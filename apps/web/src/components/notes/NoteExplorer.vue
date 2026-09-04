<template>
  <nav
    class="flex w-64 shrink-0 flex-col overflow-y-auto border-r border-gray-200 bg-gray-50"
    aria-label="Notes explorer"
  >
    <div class="flex items-center justify-between px-3 pt-3 pb-2">
      <h2 class="text-xs font-semibold uppercase tracking-wide text-gray-500">Notes</h2>
      <button
        type="button"
        class="rounded px-1.5 py-0.5 text-xs font-medium text-gray-600 hover:bg-gray-100"
        @click="startCreate"
      >
        <GqIcon name="sticky-note" size="sm" />
        <span>New</span>
      </button>
    </div>

    <form v-if="creating" class="px-3 pb-2" @submit.prevent="submitCreate">
      <label for="note-explorer-create-title" class="sr-only">New note title</label>
      <input
        id="note-explorer-create-title"
        ref="createInputRef"
        v-model="createTitle"
        type="text"
        class="w-full rounded border border-gray-300 px-2 py-1 text-sm"
        placeholder="Note title"
        @keydown.escape="cancelCreate"
      />
      <div class="mt-1 flex gap-2">
        <button type="submit" class="rounded bg-gray-900 px-2 py-1 text-xs font-medium text-white">
          Create
        </button>
        <button type="button" class="rounded px-2 py-1 text-xs text-gray-600" @click="cancelCreate">
          Cancel
        </button>
      </div>
    </form>

    <p v-if="store.error" role="alert" class="px-3 pb-2 text-xs text-red-600">{{ store.error }}</p>

    <div class="px-3 pb-2">
      <label for="note-explorer-filter" class="sr-only">Filter notes</label>
      <input
        id="note-explorer-filter"
        v-model="query"
        type="text"
        aria-label="Filter notes"
        placeholder="Search notes"
        class="w-full rounded border border-gray-300 px-2 py-1 text-sm"
      />
    </div>

    <ul class="pb-2" aria-label="Active notes">
      <li v-for="note in filteredActiveNotes" :key="note.id">
        <form
          v-if="renamingId === note.id"
          class="flex items-center gap-1 px-2 py-1"
          @submit.prevent="submitRename(note.id)"
        >
          <label :for="`note-explorer-rename-${note.id}`" class="sr-only"
            >Rename "{{ note.title }}"</label
          >
          <input
            :id="`note-explorer-rename-${note.id}`"
            ref="renameInputRef"
            v-model="renameTitle"
            type="text"
            class="w-full rounded border border-gray-300 px-2 py-1 text-sm"
            @keydown.escape="cancelRename"
          />
          <button type="submit" class="shrink-0 text-xs text-gray-600" aria-label="Save name">
            <GqIcon name="check" size="sm" />
          </button>
          <button
            type="button"
            class="shrink-0 text-xs text-gray-400"
            aria-label="Cancel rename"
            @click="cancelRename"
          >
            <GqIcon name="x" size="sm" />
          </button>
        </form>
        <div v-else class="group flex items-center px-1">
          <button
            type="button"
            class="flex flex-1 items-center gap-1.5 truncate rounded px-2 py-1.5 text-left text-sm"
            :class="
              note.id === activeNoteId
                ? 'bg-gray-200 font-medium text-gray-900'
                : 'text-gray-700 hover:bg-gray-100'
            "
            :aria-current="note.id === activeNoteId ? 'true' : undefined"
            @click="emit('open', note.id)"
          >
            <GqIcon v-if="note.id === activeNoteId" name="file-text" size="sm" />
            <span class="truncate">{{ note.title }}</span>
          </button>
          <button
            type="button"
            class="shrink-0 rounded px-1.5 py-1 text-xs text-gray-400 opacity-0 hover:bg-gray-200 group-hover:opacity-100 focus-visible:opacity-100"
            :aria-label="`Rename &quot;${note.title}&quot;`"
            @click="startRename(note.id, note.title)"
          >
            Rename
          </button>
          <button
            type="button"
            class="shrink-0 rounded px-1.5 py-1 text-xs text-gray-400 opacity-0 hover:bg-gray-200 group-hover:opacity-100 focus-visible:opacity-100"
            :aria-label="`Delete &quot;${note.title}&quot;`"
            @click="confirmDeleteId = note.id"
          >
            Delete
          </button>
        </div>
      </li>
      <li
        v-if="filteredActiveNotes.length === 0 && !store.loading"
        class="px-3 py-2 text-xs text-gray-400"
      >
        No notes yet.
      </li>
    </ul>

    <button
      type="button"
      class="flex items-center justify-between border-t border-gray-200 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-gray-500 hover:bg-gray-100"
      :aria-expanded="trashOpen"
      aria-controls="note-explorer-trash-list"
      @click="trashOpen = !trashOpen"
    >
      <span>Trash ({{ store.trashedNotes.length }})</span>
      <GqIcon :name="trashOpen ? 'chevron-down' : 'chevrons-right'" size="sm" aria-hidden="true" />
    </button>
    <ul v-if="trashOpen" id="note-explorer-trash-list" class="pb-3" aria-label="Deleted notes">
      <li
        v-for="note in store.trashedNotes"
        :key="note.id"
        class="flex items-center justify-between gap-2 px-3 py-1.5 text-sm text-gray-500"
      >
        <span class="truncate" :title="`Deleted ${note.deletedAt}`">{{ note.title }}</span>
        <button
          type="button"
          class="shrink-0 text-xs font-medium text-gray-700 underline"
          @click="confirmRestoreId = note.id"
        >
          Restore
        </button>
      </li>
      <li v-if="store.trashedNotes.length === 0" class="px-3 py-1.5 text-xs text-gray-400">
        Trash is empty.
      </li>
    </ul>
  </nav>

  <ConfirmDialog
    v-if="deleteTarget"
    :title="`Delete &quot;${deleteTarget.title}&quot;?`"
    description="It will move to Trash and can be restored later."
    confirm-label="Delete"
    destructive
    @confirm="onConfirmDelete"
    @cancel="confirmDeleteId = null"
  />

  <ConfirmDialog
    v-if="restoreTarget"
    :title="`Restore &quot;${restoreTarget.title}&quot;?`"
    confirm-label="Restore"
    @confirm="onConfirmRestore"
    @cancel="confirmRestoreId = null"
  >
    This restores revision {{ restoreTarget.revision }} of the note.
  </ConfirmDialog>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import ConfirmDialog from "../common/ConfirmDialog.vue";
import GqIcon from "../icons/GqIcon.vue";
import { useNotesStore } from "../../stores/notes.js";

const props = defineProps<{
  workspaceId: string;
  activeNoteId?: string | null;
}>();

const emit = defineEmits<{
  open: [noteId: string];
}>();

const store = useNotesStore();

const creating = ref(false);
const createTitle = ref("");
const createInputRef = ref<HTMLInputElement | null>(null);

const renamingId = ref<string | null>(null);
const renameTitle = ref("");
const renameInputRef = ref<HTMLInputElement[] | HTMLInputElement | null>(null);

const trashOpen = ref(false);
const confirmDeleteId = ref<string | null>(null);
const confirmRestoreId = ref<string | null>(null);

const query = ref("");
const filteredActiveNotes = computed(() => {
  const needle = query.value.trim().toLowerCase();
  if (!needle) return store.activeNotes;
  return store.activeNotes.filter((note) => note.title.toLowerCase().includes(needle));
});

const deleteTarget = computed(
  () => store.items.find((note) => note.id === confirmDeleteId.value) ?? null,
);
const restoreTarget = computed(
  () => store.items.find((note) => note.id === confirmRestoreId.value) ?? null,
);

async function load(): Promise<void> {
  await store.loadWorkspace(props.workspaceId);
}

onMounted(load);
watch(() => props.workspaceId, load);

function startCreate(): void {
  creating.value = true;
  createTitle.value = "";
  void nextTick(() => createInputRef.value?.focus());
}

function cancelCreate(): void {
  creating.value = false;
  createTitle.value = "";
}

async function submitCreate(): Promise<void> {
  const title = createTitle.value.trim();
  if (!title) return;
  const result = await store.create(title);
  cancelCreate();
  emit("open", result.id);
}

function startRename(noteId: string, title: string): void {
  renamingId.value = noteId;
  renameTitle.value = title;
  void nextTick(() => {
    const el = renameInputRef.value;
    (Array.isArray(el) ? el[0] : el)?.focus();
  });
}

function cancelRename(): void {
  renamingId.value = null;
  renameTitle.value = "";
}

async function submitRename(noteId: string): Promise<void> {
  const title = renameTitle.value.trim();
  if (!title) return;
  await store.rename(noteId, title);
  cancelRename();
}

async function onConfirmDelete(): Promise<void> {
  const noteId = confirmDeleteId.value;
  confirmDeleteId.value = null;
  if (noteId) await store.remove(noteId);
}

async function onConfirmRestore(): Promise<void> {
  const noteId = confirmRestoreId.value;
  confirmRestoreId.value = null;
  if (noteId) await store.restore(noteId);
}
</script>
