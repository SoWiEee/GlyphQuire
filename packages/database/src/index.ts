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
  jobs,
  jobsRelations,
  idempotencyRecords,
  idempotencyRecordsRelations,
  type WorkspaceRole,
  type NoteVisibility,
  type SnapshotReason,
  type NoteOperationKind,
  type DocumentJobKind,
  type DocumentJobStatus,
  type JobStatus,
} from "./schema/index.js";

export {
  IdempotencyStore,
  PostgresIdempotencyBackend,
  decodeEncryptionKey,
  type IdempotencyBackend,
  type IdempotencyBackendBeginInput,
  type IdempotencyBackendBeginResult,
  type IdempotencyBackendCompleteInput,
  type IdempotencyBeginInput,
  type IdempotencyBeginResult,
  type IdempotencyStoreOptions,
} from "./idempotency.js";

export type { InferSelectModel, InferInsertModel } from "drizzle-orm";

import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import type {
  documentJobs,
  idempotencyRecords,
  jobs,
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
export type Job = InferSelectModel<typeof jobs>;
export type NewJob = InferInsertModel<typeof jobs>;
export type IdempotencyRecord = InferSelectModel<typeof idempotencyRecords>;
export type NewIdempotencyRecord = InferInsertModel<typeof idempotencyRecords>;
