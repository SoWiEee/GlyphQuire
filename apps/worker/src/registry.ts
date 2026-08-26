import { createDb, type Database } from "@glyphquire/database";
import type { JobRegistry } from "@glyphquire/queue";
import { PostgresSearchAdapter } from "@glyphquire/search";
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

const searchRebuildNote = createSearchRebuildNoteHandler({
  get repository() {
    return new PostgresSearchRebuildNoteRepository(database());
  },
  get searchPort() {
    return new PostgresSearchAdapter(database());
  },
});

/**
 * Static staged registry; later Phase 5 slices add reviewed handlers by
 * exact JobType key. Only the `scope: "note"` branch of `search.rebuild` is
 * registered here — the `scope: "workspace"` branch, and the rest of the
 * P0 handler set, are added by later tasks (see Task 7's scheduler
 * handoff). `assertRegistryComplete`'s full-P0 gate is what keeps this
 * partial registry from being treated as production-ready until then.
 */
export const jobRegistry: JobRegistry = Object.freeze({
  "search.rebuild": searchRebuildNote,
});
