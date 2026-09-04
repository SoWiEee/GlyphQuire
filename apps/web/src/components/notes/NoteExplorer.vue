<template>
  <nav
    class="flex w-64 shrink-0 flex-col overflow-y-auto border-r border-border bg-surface-muted"
    aria-label="筆記側欄"
  >
    <div class="flex items-center justify-between px-3 pt-3 pb-2">
      <h2 class="text-xs font-semibold uppercase tracking-wide text-muted">筆記</h2>
      <button
        type="button"
        class="rounded px-1.5 py-0.5 text-xs font-medium text-muted hover:bg-surface-muted"
        @click="startCreate"
      >
        <GqIcon name="sticky-note" size="sm" />
        <span>新增</span>
      </button>
    </div>

    <form v-if="creating" class="px-3 pb-2" @submit.prevent="submitCreate">
      <label for="note-explorer-create-title" class="sr-only">筆記標題</label>
      <input
        id="note-explorer-create-title"
        ref="createInputRef"
        v-model="createTitle"
        type="text"
        class="w-full rounded border border-border px-2 py-1 text-sm"
        placeholder="筆記標題"
        @keydown.escape="cancelCreate"
      />
      <div class="mt-1 flex gap-2">
        <button type="submit" class="rounded bg-accent px-2 py-1 text-xs font-medium text-accent-contrast">
          建立
        </button>
        <button type="button" class="rounded px-2 py-1 text-xs text-muted" @click="cancelCreate">
          取消
        </button>
      </div>
    </form>

    <p v-if="store.error" role="alert" class="px-3 pb-2 text-xs text-danger">{{ store.error }}</p>

    <div class="px-3 pb-2">
      <label for="note-explorer-filter" class="sr-only">搜尋筆記</label>
      <input
        id="note-explorer-filter"
        v-model="query"
        type="text"
        aria-label="搜尋筆記"
        placeholder="搜尋筆記"
        class="w-full rounded border border-border px-2 py-1 text-sm"
      />
    </div>

    <nav
      v-if="!query.trim() && store.activeNotes.length > RECENT_LIMIT && recentNotes.length > 0"
      aria-label="最近的筆記"
      class="pb-2"
    >
      <h3 class="px-3 pt-1 pb-1 text-xs font-semibold uppercase tracking-wide text-muted">
        最近
      </h3>
      <ul>
        <li v-for="note in recentNotes" :key="`recent-${note.id}`">
          <button
            type="button"
            class="flex w-full items-center truncate px-3 py-1 text-left text-sm text-foreground hover:bg-surface-muted"
            @click="emit('open', note.id)"
          >
            <span class="truncate">{{ note.title }}</span>
          </button>
        </li>
      </ul>
    </nav>

    <ul class="pb-2" aria-label="使用中的筆記">
      <li v-for="note in filteredActiveNotes" :key="note.id">
        <form
          v-if="renamingId === note.id"
          class="flex items-center gap-1 px-2 py-1"
          @submit.prevent="submitRename(note.id)"
        >
          <label :for="`note-explorer-rename-${note.id}`" class="sr-only"
            >重新命名「{{ note.title }}」</label
          >
          <input
            :id="`note-explorer-rename-${note.id}`"
            ref="renameInputRef"
            v-model="renameTitle"
            type="text"
            class="w-full rounded border border-border px-2 py-1 text-sm"
            @keydown.escape="cancelRename"
          />
          <button type="submit" class="shrink-0 text-xs text-muted" aria-label="儲存名稱">
            <GqIcon name="check" size="sm" />
          </button>
          <button
            type="button"
            class="shrink-0 text-xs text-muted"
            aria-label="取消重新命名"
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
                ? 'bg-surface-muted font-medium text-foreground'
                : 'text-foreground hover:bg-surface-muted'
            "
            :aria-current="note.id === activeNoteId ? 'true' : undefined"
            @click="emit('open', note.id)"
          >
            <GqIcon v-if="note.id === activeNoteId" name="file-text" size="sm" />
            <span class="truncate">{{ note.title }}</span>
          </button>
          <button
            type="button"
            class="shrink-0 rounded px-1.5 py-1 text-xs text-muted opacity-0 hover:bg-surface-muted group-hover:opacity-100 focus-visible:opacity-100"
            :aria-label="`重新命名「${note.title}」`"
            @click="startRename(note.id, note.title)"
          >
            重新命名
          </button>
          <button
            type="button"
            class="shrink-0 rounded px-1.5 py-1 text-xs text-muted opacity-0 hover:bg-surface-muted group-hover:opacity-100 focus-visible:opacity-100"
            :aria-label="`刪除「${note.title}」`"
            @click="confirmDeleteId = note.id"
          >
            刪除
          </button>
        </div>
      </li>
      <li
        v-if="filteredActiveNotes.length === 0 && !store.loading"
        class="px-3 py-2 text-xs text-muted"
      >
        尚無筆記
      </li>
    </ul>

    <button
      type="button"
      class="flex items-center justify-between border-t border-border px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted hover:bg-surface-muted"
      :aria-expanded="trashOpen"
      aria-controls="note-explorer-trash-list"
      @click="trashOpen = !trashOpen"
    >
      <span>垃圾桶 ({{ store.trashedNotes.length }})</span>
      <GqIcon :name="trashOpen ? 'chevron-down' : 'chevrons-right'" size="sm" aria-hidden="true" />
    </button>
    <ul v-if="trashOpen" id="note-explorer-trash-list" class="pb-3" aria-label="已刪除的筆記">
      <li
        v-for="note in store.trashedNotes"
        :key="note.id"
        class="flex items-center justify-between gap-2 px-3 py-1.5 text-sm text-muted"
      >
        <span class="truncate" :title="`已刪除 ${note.deletedAt}`">{{ note.title }}</span>
        <button
          type="button"
          class="shrink-0 text-xs font-medium text-foreground underline"
          @click="confirmRestoreId = note.id"
        >
          還原
        </button>
      </li>
      <li v-if="store.trashedNotes.length === 0" class="px-3 py-1.5 text-xs text-muted">
        垃圾桶是空的
      </li>
    </ul>
  </nav>

  <ConfirmDialog
    v-if="deleteTarget"
    :title="`刪除「${deleteTarget.title}」？`"
    description="這將移到垃圾桶，之後可以還原。"
    confirm-label="刪除"
    destructive
    @confirm="onConfirmDelete"
    @cancel="confirmDeleteId = null"
  />

  <ConfirmDialog
    v-if="restoreTarget"
    :title="`還原「${restoreTarget.title}」？`"
    confirm-label="還原"
    @confirm="onConfirmRestore"
    @cancel="confirmRestoreId = null"
  >
    這將還原此筆記的版本 {{ restoreTarget.revision }}。
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

const RECENT_LIMIT = 5;
const recentNotes = computed(() =>
  [...store.activeNotes]
    .sort((first, second) => second.updatedAt.localeCompare(first.updatedAt))
    .slice(0, RECENT_LIMIT),
);

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
