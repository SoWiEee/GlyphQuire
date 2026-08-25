export { createDb, type Database } from "./client.js";
export { migrate as runDatabaseMigrations } from "drizzle-orm/postgres-js/migrator";
export { readRepositoryMigrations, verifyMigrationBaseline } from "./migrations/verify-baseline.js";
export {
  user,
  session,
  account,
  verification,
  userRelations,
  sessionRelations,
  accountRelations,
  workspaceMembers,
  workspaces,
  workspaceMembersRelations,
  workspacesRelations,
  notes,
  notesRelations,
  noteVersions,
  noteVersionsRelations,
  noteOperations,
  noteOperationsRelations,
  documentJobs,
  documentJobsRelations,
  rateLimitBuckets,
  rateLimitReservations,
  themes,
  themesRelations,
  userThemes,
  userThemesRelations,
  type WorkspaceRole,
  type NoteVisibility,
  type SnapshotReason,
  type NoteOperationKind,
  type DocumentJobKind,
  type DocumentJobStatus,
} from "./schema/index.js";

export type { InferSelectModel, InferInsertModel } from "drizzle-orm";

import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import type {
  documentJobs,
  noteOperations,
  notes,
  noteVersions,
  themes,
  userThemes,
  workspaceMembers,
  workspaces,
} from "./schema/index.js";

export type Workspace = InferSelectModel<typeof workspaces>;
export type NewWorkspace = InferInsertModel<typeof workspaces>;
export type WorkspaceMember = InferSelectModel<typeof workspaceMembers>;
export type NewWorkspaceMember = InferInsertModel<typeof workspaceMembers>;
export type Note = InferSelectModel<typeof notes>;
export type NewNote = InferInsertModel<typeof notes>;
export type NoteVersion = InferSelectModel<typeof noteVersions>;
export type NewNoteVersion = InferInsertModel<typeof noteVersions>;
export type NoteOperation = InferSelectModel<typeof noteOperations>;
export type NewNoteOperation = InferInsertModel<typeof noteOperations>;
export type DocumentJob = InferSelectModel<typeof documentJobs>;
export type NewDocumentJob = InferInsertModel<typeof documentJobs>;
export type Theme = InferSelectModel<typeof themes>;
export type NewTheme = InferInsertModel<typeof themes>;
export type UserTheme = InferSelectModel<typeof userThemes>;
export type NewUserTheme = InferInsertModel<typeof userThemes>;
