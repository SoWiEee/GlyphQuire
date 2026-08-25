import { computed, ref, shallowRef } from "vue";
import { defineStore } from "pinia";
import { NoteClient } from "../api/NoteClient.js";
import { newOperationId } from "../lib/operationId.js";
import type { NoteResult, NoteSummary } from "@glyphquire/api-contract";

/** Safety cap on auto-pagination so a runaway cursor loop can't hang a tab. */
const MAX_LIST_PAGES = 40;

function toSummary(result: NoteResult): NoteSummary {
  return {
    id: result.id,
    workspaceId: result.workspaceId,
    title: result.title,
    revision: result.revision,
    visibility: result.visibility,
    createdAt: result.createdAt,
    updatedAt: result.updatedAt,
    deletedAt: result.deletedAt,
  };
}

/**
 * The single source of note lifecycle state (list, create, rename, soft
 * delete, restore) for one workspace. Every mutation is CAS-protected: it
 * reads the note's currently known `revision` as `baseRevision` and mints a
 * fresh operation id, exactly mirroring the server's optimistic-concurrency
 * contract. Deleted notes stay in `items` (never dropped) so the Trash view
 * can list them; `activeNotes`/`trashedNotes` split on `deletedAt`.
 */
export const useNotesStore = defineStore("notes", () => {
  const client = shallowRef<
    Pick<NoteClient, "listNotes" | "createNote" | "renameNote" | "deleteNote" | "restoreNote">
  >(new NoteClient());
  const workspaceId = ref<string | null>(null);
  const items = ref<NoteSummary[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);

  const activeNotes = computed(() => items.value.filter((note) => note.deletedAt === null));
  const trashedNotes = computed(() => items.value.filter((note) => note.deletedAt !== null));

  /** Test/host seam — production code never needs to call this. */
  function configure(nextClient: typeof client.value): void {
    client.value = nextClient;
  }

  function findRevision(noteId: string): number {
    const note = items.value.find((entry) => entry.id === noteId);
    if (!note) throw new Error(`Unknown note "${noteId}"`);
    return note.revision;
  }

  function upsert(result: NoteResult): void {
    const summary = toSummary(result);
    const index = items.value.findIndex((note) => note.id === summary.id);
    if (index === -1) items.value = [...items.value, summary];
    else items.value = items.value.map((note, i) => (i === index ? summary : note));
  }

  async function loadWorkspace(nextWorkspaceId: string): Promise<void> {
    loading.value = true;
    error.value = null;
    workspaceId.value = nextWorkspaceId;
    try {
      const collected: NoteSummary[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
        const result = await client.value.listNotes(nextWorkspaceId, { cursor, pageSize: 100 });
        collected.push(...result.items);
        if (!result.nextCursor) break;
        cursor = result.nextCursor;
      }
      if (workspaceId.value === nextWorkspaceId) items.value = collected;
    } catch (cause) {
      if (workspaceId.value === nextWorkspaceId) {
        error.value = cause instanceof Error ? cause.message : "Failed to load notes";
      }
    } finally {
      if (workspaceId.value === nextWorkspaceId) loading.value = false;
    }
  }

  async function create(title: string): Promise<NoteResult> {
    if (!workspaceId.value) throw new Error("No workspace is loaded");
    const result = await client.value.createNote(workspaceId.value, {
      operationId: newOperationId(),
      title,
      contentMarkdown: "",
      visibility: "private",
    });
    upsert(result);
    return result;
  }

  async function rename(noteId: string, title: string): Promise<NoteResult> {
    const result = await client.value.renameNote(noteId, {
      operationId: newOperationId(),
      baseRevision: findRevision(noteId),
      title,
    });
    upsert(result);
    return result;
  }

  async function remove(noteId: string): Promise<NoteResult> {
    const result = await client.value.deleteNote(noteId, {
      operationId: newOperationId(),
      baseRevision: findRevision(noteId),
    });
    upsert(result);
    return result;
  }

  async function restore(noteId: string): Promise<NoteResult> {
    const result = await client.value.restoreNote(noteId, {
      operationId: newOperationId(),
      baseRevision: findRevision(noteId),
    });
    upsert(result);
    return result;
  }

  return {
    workspaceId,
    items,
    loading,
    error,
    activeNotes,
    trashedNotes,
    configure,
    loadWorkspace,
    create,
    rename,
    remove,
    restore,
  };
});
