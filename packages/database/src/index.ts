export { createDb, type Database } from "./client.js";
export {
  MigrationRunner,
  type MigrationCatalog,
  type MigrationRunnerOptions,
} from "./migrations/MigrationRunner.js";
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
  userPreferences,
  userPreferencesRelations,
  customBlocks,
  customBlocksRelations,
  customBlockVersions,
  customBlockVersionsRelations,
  jobs,
  jobsRelations,
  idempotencyRecords,
  idempotencyRecordsRelations,
  assets,
  assetsRelations,
  searchDocuments,
  searchDocumentsRelations,
  imports,
  importsRelations,
  importResources,
  importResourcesRelations,
  exports,
  exportsRelations,
  shareLinks,
  shareLinksRelations,
  workspaceDeletions,
  workspaceDeletionsRelations,
  accountDeletions,
  MAX_SEARCH_TEXT_BYTES,
  type WorkspaceRole,
  type NoteVisibility,
  type SnapshotReason,
  type NoteOperationKind,
  type DocumentJobKind,
  type DocumentJobStatus,
  type JobStatus,
  type AssetThumbnailStatus,
  type ImportStatus,
  type ImportCompensationStatus,
  type ImportManifest,
  type ImportResourceState,
  type ExportScopeType,
  type ExportFormat,
  type ExportStatus,
  type ShareLinkScopeType,
  type WorkspaceDeletionStatus,
  type WorkspaceDeletionManifest,
  type AccountDeletionStatus,
  type AccountDeletionManifest,
  type ThemePreferenceMode,
  type CustomBlockVersionStatus,
  type CustomBlockOperationKind,
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
  assets,
  exports,
  shareLinks,
  importResources,
  imports,
  documentJobs,
  idempotencyRecords,
  jobs,
  noteOperations,
  notes,
  noteVersions,
  searchDocuments,
  themes,
  userThemes,
  userPreferences,
  customBlocks,
  customBlockVersions,
  workspaceMembers,
  workspaces,
  workspaceDeletions,
  accountDeletions,
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
export type UserPreference = InferSelectModel<typeof userPreferences>;
export type NewUserPreference = InferInsertModel<typeof userPreferences>;
export type CustomBlock = InferSelectModel<typeof customBlocks>;
export type NewCustomBlock = InferInsertModel<typeof customBlocks>;
export type CustomBlockVersion = InferSelectModel<typeof customBlockVersions>;
export type NewCustomBlockVersion = InferInsertModel<typeof customBlockVersions>;
export type Job = InferSelectModel<typeof jobs>;
export type NewJob = InferInsertModel<typeof jobs>;
export type IdempotencyRecord = InferSelectModel<typeof idempotencyRecords>;
export type NewIdempotencyRecord = InferInsertModel<typeof idempotencyRecords>;
export type Asset = InferSelectModel<typeof assets>;
export type NewAsset = InferInsertModel<typeof assets>;
export type SearchDocument = InferSelectModel<typeof searchDocuments>;
export type NewSearchDocument = InferInsertModel<typeof searchDocuments>;
export type Import = InferSelectModel<typeof imports>;
export type NewImport = InferInsertModel<typeof imports>;
export type ImportResource = InferSelectModel<typeof importResources>;
export type NewImportResource = InferInsertModel<typeof importResources>;
export type Export = InferSelectModel<typeof exports>;
export type NewExport = InferInsertModel<typeof exports>;
export type ShareLink = InferSelectModel<typeof shareLinks>;
export type NewShareLink = InferInsertModel<typeof shareLinks>;
export type WorkspaceDeletion = InferSelectModel<typeof workspaceDeletions>;
export type NewWorkspaceDeletion = InferInsertModel<typeof workspaceDeletions>;
export type AccountDeletion = InferSelectModel<typeof accountDeletions>;
export type NewAccountDeletion = InferInsertModel<typeof accountDeletions>;
