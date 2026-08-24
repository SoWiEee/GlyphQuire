import { ref } from "vue";
import { defineStore } from "pinia";
import type { NoteConflict } from "@glyphquire/api-contract";

/** Everything the conflict recovery workspace needs to render for one note. */
export interface ActiveConflict {
  readonly userId: string;
  readonly workspaceId: string;
  readonly noteId: string;
  readonly conflict: NoteConflict;
  readonly localMarkdown: string;
  readonly localBaseRevision: number | null;
}

/**
 * The page-level switch that decides whether the workbench or the full-
 * screen conflict recovery workspace is shown. Anything that owns a live
 * editing session (an EditorSession subscriber today; a future in-workbench
 * autosave surface later) calls `report()` the moment a save is rejected
 * with `REVISION_CONFLICT` — this store never derives a conflict on its own
 * and never resolves one itself. Resolution only ever happens by the
 * conflict recovery workspace calling `NoteClient.save` directly and then
 * `clear()`-ing this store; there is no code path here that can silently
 * overwrite the server.
 */
export const useConflictStore = defineStore("conflict", () => {
  const active = ref<ActiveConflict | null>(null);

  function report(entry: ActiveConflict): void {
    active.value = entry;
  }

  function clear(): void {
    active.value = null;
  }

  return { active, report, clear };
});
