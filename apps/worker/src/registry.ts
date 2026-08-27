import { createDb, type Database } from "@glyphquire/database";
import type { JobHandler, JobRegistry } from "@glyphquire/queue";
import { PostgresSearchAdapter } from "@glyphquire/search";
import { phase5EnvSchema, s3EnvSchema, type Phase5Env } from "@glyphquire/shared";
import { createMinioObjectStorage, type ObjectStoragePort } from "@glyphquire/storage";
import {
  createAssetCleanupHandler,
  PostgresAssetCleanupRepository,
} from "./handlers/asset-cleanup.js";
import { PostgresAssetThumbnailRepository } from "./handlers/asset-thumbnail-repository.js";
import { createAssetThumbnailHandler } from "./handlers/asset-thumbnail.js";
import {
  createSearchIndexHandler,
  PostgresSearchIndexRepository,
} from "./handlers/search-index.js";
import {
  createSearchRemoveHandler,
  PostgresSearchRemoveRepository,
} from "./handlers/search-remove.js";
import {
  createSearchRebuildNoteHandler,
  PostgresSearchRebuildNoteRepository,
} from "./handlers/search-rebuild-note.js";

/**
 * Lazily creates (and reuses) a single database connection for handlers
 * registered below. Deferred to first job execution rather than module
 * load, so importing this module — which `startWorker()` does even when
 * the caller supplies its own test registry — never depends on
 * `DATABASE_URL` being set or reachable.
 */
let cachedDatabase: Database | undefined;
function database(): Database {
  if (!cachedDatabase) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("JOB_FAILED: DATABASE_URL is required");
    cachedDatabase = createDb(url);
  }
  return cachedDatabase;
}

let cachedStorage: ObjectStoragePort | undefined;
function storage(): ObjectStoragePort {
  if (!cachedStorage) {
    const parsed = s3EnvSchema.safeParse(process.env);
    if (!parsed.success) throw new Error("JOB_FAILED: invalid object storage configuration");
    cachedStorage = createMinioObjectStorage(parsed.data);
  }
  return cachedStorage;
}

let cachedPhase5Environment: Phase5Env | undefined;
function phase5Environment(): Phase5Env {
  if (!cachedPhase5Environment) {
    const parsed = phase5EnvSchema.safeParse(process.env);
    if (!parsed.success) throw new Error("JOB_FAILED: invalid worker configuration");
    cachedPhase5Environment = parsed.data;
  }
  return cachedPhase5Environment;
}

const searchIndex = createSearchIndexHandler({
  get repository() {
    return new PostgresSearchIndexRepository(database());
  },
  get searchPort() {
    return new PostgresSearchAdapter(database());
  },
});

const searchRemove = createSearchRemoveHandler({
  get repository() {
    return new PostgresSearchRemoveRepository(database());
  },
  get searchPort() {
    return new PostgresSearchAdapter(database());
  },
});

const searchRebuildNote = createSearchRebuildNoteHandler({
  get repository() {
    return new PostgresSearchRebuildNoteRepository(database());
  },
  get searchPort() {
    return new PostgresSearchAdapter(database());
  },
});

let cachedAssetCleanupHandler: JobHandler<"asset.cleanup"> | undefined;
const assetCleanup: JobHandler<"asset.cleanup"> = async (job, signal) => {
  if (!cachedAssetCleanupHandler) {
    cachedAssetCleanupHandler = createAssetCleanupHandler({
      repository: new PostgresAssetCleanupRepository(database()),
      storage: storage(),
      graceDays: phase5Environment().ASSET_DELETE_GRACE_DAYS,
    });
  }
  await cachedAssetCleanupHandler(job, signal);
};

const assetThumbnail = createAssetThumbnailHandler({
  get repository() {
    return new PostgresAssetThumbnailRepository(database());
  },
  get storage() {
    return storage();
  },
  get limits() {
    const env = phase5Environment();
    return {
      maxSourceBytes: env.THUMBNAIL_MAX_SOURCE_BYTES,
      maxPixels: env.THUMBNAIL_MAX_PIXELS,
      maxOutputBytes: env.THUMBNAIL_MAX_OUTPUT_BYTES,
    };
  },
  buildThumbnailObjectKey(workspaceId, assetId) {
    return `workspace/${workspaceId}/assets/${assetId}/thumbnail.webp`;
  },
});

/**
 * Static staged registry. Task 4 adds the reviewed search/asset consumers;
 * later Phase 5 slices add only exact JobType keys. The `scope: "workspace"`
 * branch of `search.rebuild` and the remaining P0 set still arrive in later
 * handoffs. `assertRegistryComplete` therefore continues to keep this partial
 * registry from being treated as production-ready.
 */
export const jobRegistry: JobRegistry = Object.freeze({
  "search.index": searchIndex,
  "search.remove": searchRemove,
  "search.rebuild": searchRebuildNote,
  "asset.cleanup": assetCleanup,
  "asset.thumbnail": assetThumbnail,
});
