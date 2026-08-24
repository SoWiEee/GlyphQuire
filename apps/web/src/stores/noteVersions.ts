import { reactive, ref, shallowRef } from "vue";
import { defineStore } from "pinia";
import { NoteClient } from "../api/NoteClient.js";
import { newOperationId } from "../lib/operationId.js";
import type {
  CheckpointNoteResult,
  NoteResult,
  NoteVersionResult,
  NoteVersionSummary,
} from "@glyphquire/api-contract";

type VersionsClient = Pick<
  NoteClient,
  "listNoteVersions" | "checkpointNote" | "getNoteVersion" | "restoreNoteVersion"
>;

/**
 * Per-note version history state: the summary list (paginated), an on-demand
 * cache of fully loaded version bodies for preview, and the two mutations
 * that create or restore a snapshot — both CAS-protected against the note's
 * currently known revision, exactly like every other note mutation.
 */
export const useNoteVersionsStore = defineStore("noteVersions", () => {
  const client = shallowRef<VersionsClient>(new NoteClient());
  const summariesByNote = reactive(new Map<string, NoteVersionSummary[]>());
  const cursorByNote = reactive(new Map<string, string | null>());
  const versionCache = reactive(new Map<string, NoteVersionResult>());
  const loading = ref(false);
  const error = ref<string | null>(null);

  function configure(nextClient: VersionsClient): void {
    client.value = nextClient;
  }

  function versionCacheKey(noteId: string, versionId: string): string {
    return `${noteId}:${versionId}`;
  }

  async function load(noteId: string): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      const page = await client.value.listNoteVersions(noteId, { pageSize: 50 });
      summariesByNote.set(noteId, page.items);
      cursorByNote.set(noteId, page.nextCursor);
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : "Failed to load version history";
    } finally {
      loading.value = false;
    }
  }

  async function loadMore(noteId: string): Promise<void> {
    const cursor = cursorByNote.get(noteId);
    if (!cursor) return;
    loading.value = true;
    error.value = null;
    try {
      const page = await client.value.listNoteVersions(noteId, { cursor, pageSize: 50 });
      const existing = summariesByNote.get(noteId) ?? [];
      summariesByNote.set(noteId, [...existing, ...page.items]);
      cursorByNote.set(noteId, page.nextCursor);
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : "Failed to load more versions";
    } finally {
      loading.value = false;
    }
  }

  async function checkpoint(noteId: string, baseRevision: number): Promise<CheckpointNoteResult> {
    const result = await client.value.checkpointNote(noteId, {
      operationId: newOperationId(),
      baseRevision,
    });
    const existing = summariesByNote.get(noteId) ?? [];
    summariesByNote.set(noteId, [result.version, ...existing]);
    versionCache.set(versionCacheKey(noteId, result.version.id), result.version);
    return result;
  }

  async function getVersion(noteId: string, versionId: string): Promise<NoteVersionResult> {
    const key = versionCacheKey(noteId, versionId);
    const cached = versionCache.get(key);
    if (cached) return cached;
    const version = await client.value.getNoteVersion(noteId, versionId);
    versionCache.set(key, version);
    return version;
  }

  async function restoreVersion(
    noteId: string,
    versionId: string,
    baseRevision: number,
  ): Promise<NoteResult> {
    return client.value.restoreNoteVersion(noteId, versionId, {
      operationId: newOperationId(),
      baseRevision,
    });
  }

  return {
    summariesByNote,
    cursorByNote,
    versionCache,
    loading,
    error,
    configure,
    load,
    loadMore,
    checkpoint,
    getVersion,
    restoreVersion,
  };
});
