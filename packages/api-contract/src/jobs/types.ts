export type JobType =
  | "search.index"
  | "search.remove"
  | "search.rebuild"
  | "asset.cleanup"
  | "asset.orphan_cleanup"
  | "asset.thumbnail"
  | "import"
  | "import.cleanup"
  | "export"
  | "export.expire"
  | "share.cleanup"
  | "version.retention"
  | "idempotency.cleanup"
  | "backup.verify"
  | "workspace.purge"
  | "account.purge";

export interface SearchIndexPayload {
  workspaceId: string;
  noteId: string;
  revision: number;
  operationId: string;
}

export type SearchRemovePayload = SearchIndexPayload;

export type SearchRebuildPayload =
  | {
      workspaceId: string;
      scope: "note";
      noteId: string;
      batchSize: 1;
      cursor?: string;
    }
  | {
      workspaceId: string;
      scope: "workspace";
      batchSize: number;
      cursor?: string;
    };

export interface AssetCleanupPayload {
  workspaceId: string;
  assetId: string;
}

export interface AssetOrphanCleanupPayload {
  workspaceId: string;
  batchSize: number;
  cursor?: string;
}

export type AssetThumbnailPayload = AssetCleanupPayload;

export interface ImportPayload {
  workspaceId: string;
  importId: string;
  actorId: string;
  noteId?: string;
  baseRevision?: number;
}

export type ImportCleanupPayload =
  | { workspaceId: string; scope: "one"; importId: string }
  | { workspaceId: string; scope: "staging"; batchSize: number; cursor?: string };

export interface ExportPayload {
  workspaceId: string;
  exportId: string;
}

export interface ExportExpirePayload {
  workspaceId: string;
  batchSize: number;
  cursor?: string;
}

export type ShareCleanupPayload =
  | { workspaceId: string; scope: "one"; shareLinkId: string }
  | { workspaceId: string; scope: "expired"; batchSize: number; cursor?: string };

export type VersionRetentionPayload =
  | { workspaceId: string; scope: "note"; noteId: string; batchSize: 1 }
  | { workspaceId: string; scope: "workspace"; batchSize: number; cursor?: string };

export interface IdempotencyCleanupPayload {
  workspaceId: string;
  batchSize: number;
  cursor?: string;
}

export interface BackupVerifyPayload {
  workspaceId: string | null;
  backupId: string;
}

export interface WorkspacePurgePayload {
  workspaceId: string;
  deletionId: string;
}

export interface AccountPurgePayload {
  workspaceId: string | null;
  accountDeletionId: string;
  accountId: string;
}

export interface JobPayloadMap {
  "search.index": SearchIndexPayload;
  "search.remove": SearchRemovePayload;
  "search.rebuild": SearchRebuildPayload;
  "asset.cleanup": AssetCleanupPayload;
  "asset.orphan_cleanup": AssetOrphanCleanupPayload;
  "asset.thumbnail": AssetThumbnailPayload;
  import: ImportPayload;
  "import.cleanup": ImportCleanupPayload;
  export: ExportPayload;
  "export.expire": ExportExpirePayload;
  "share.cleanup": ShareCleanupPayload;
  "version.retention": VersionRetentionPayload;
  "idempotency.cleanup": IdempotencyCleanupPayload;
  "backup.verify": BackupVerifyPayload;
  "workspace.purge": WorkspacePurgePayload;
  "account.purge": AccountPurgePayload;
}

export type JobPayload<TType extends JobType> = JobPayloadMap[TType];

export interface JobEnvelope<TType extends JobType = JobType> {
  id: string;
  workspaceId: string | null;
  type: TType;
  version: number;
  attempts: number;
  createdAt: string;
  payload: JobPayload<TType>;
}

export interface Phase5Cursor {
  createdAt: string;
  id: string;
}
