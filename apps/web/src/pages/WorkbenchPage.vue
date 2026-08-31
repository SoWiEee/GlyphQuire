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
  <Workbench
    v-else
    :session-factory="sessionFactory"
    :phase5-workspace-id="hostContext.workspaceId"
    :workspace-name="hostContext.workspaceName"
    :account-label="hostContext.accountLabel"
    @account-action="forwardAccountAction"
  />
</template>

<script setup lang="ts">
import { computed } from "vue";
import { storeToRefs } from "pinia";
import Workbench from "../components/workbench/Workbench.vue";
import ConflictWorkspace from "../components/conflict/ConflictWorkspace.vue";
import { NoteClient } from "../api/NoteClient.js";
import { IndexedDbDraftStore } from "../persistence/DraftStore.js";
import { useConflictStore } from "../stores/conflict.js";
import {
  useWorkbenchHostContext,
  type WorkbenchAccountAction,
} from "../components/workbench/WorkbenchContext.js";
import type { WorkbenchSessionFactory } from "../components/workbench/types.js";

const props = defineProps<{
  sessionFactory?: WorkbenchSessionFactory;
  onAccountAction?: (action: WorkbenchAccountAction) => void;
}>();

const hostContext = useWorkbenchHostContext();
const sessionFactory = computed(() => props.sessionFactory ?? hostContext.sessionFactory);

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

function forwardAccountAction(action: WorkbenchAccountAction): void {
  (props.onAccountAction ?? hostContext.onAccountAction)?.(action);
}
</script>
