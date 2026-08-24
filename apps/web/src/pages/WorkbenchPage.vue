<template>
  <ConflictWorkspace
    v-if="activeConflict"
    :note-id="activeConflict.noteId"
    :user-id="activeConflict.userId"
    :workspace-id="activeConflict.workspaceId"
    :conflict="activeConflict.conflict"
    :local-markdown="activeConflict.localMarkdown"
    :note-client="noteClient"
    :draft-store="draftStore"
    @resolved="onConflictResolved"
    @dismiss="onConflictDismissed"
  />
  <Workbench v-else />
</template>

<script setup lang="ts">
import { storeToRefs } from "pinia";
import Workbench from "@/components/workbench/Workbench.vue";
import ConflictWorkspace from "@/components/conflict/ConflictWorkspace.vue";
import { NoteClient } from "@/api/NoteClient.js";
import { IndexedDbDraftStore } from "@/persistence/DraftStore.js";
import { useConflictStore } from "@/stores/conflict.js";

// Whatever surfaces a REVISION_CONFLICT from a live editing session (an
// EditorSession subscriber today; a future in-workbench autosave surface
// next) calls `useConflictStore().report(...)`. This page only reacts to
// that shared switch: when a conflict is active it shows the full-screen
// recovery workspace instead of the workbench, and hands it back the exact
// NoteClient/DraftStore ports the recovery flow depends on.
const conflictStore = useConflictStore();
const { active: activeConflict } = storeToRefs(conflictStore);

const noteClient = new NoteClient();
const draftStore = new IndexedDbDraftStore();

function onConflictResolved(): void {
  conflictStore.clear();
}

function onConflictDismissed(): void {
  conflictStore.clear();
}
</script>
