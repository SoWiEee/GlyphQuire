import type { JobHandler } from "@glyphquire/queue";
import {
  createSearchIndexHandler,
  PostgresSearchIndexRepository,
} from "../handlers/search-index.js";
import {
  createSearchRemoveHandler,
  PostgresSearchRemoveRepository,
} from "../handlers/search-remove.js";
import {
  createSearchRebuildNoteHandler,
  PostgresSearchRebuildNoteRepository,
} from "../handlers/search-rebuild-note.js";
import {
  createWorkspaceSearchRebuildHandler,
  PostgresWorkspaceSearchRebuildRepository,
} from "../handlers/workspace-search-rebuild.js";
import type { JobRegistryDependencies, DomainJobRegistry } from "./types.js";

export type SearchJobRegistry = DomainJobRegistry<
  "search.index" | "search.remove" | "search.rebuild"
>;

export function createSearchRegistry(dependencies: JobRegistryDependencies): SearchJobRegistry {
  const searchRebuildNote = createSearchRebuildNoteHandler({
    repository: new PostgresSearchRebuildNoteRepository(dependencies.database),
    searchPort: dependencies.search,
  });
  const searchRebuildWorkspace = createWorkspaceSearchRebuildHandler({
    repository: new PostgresWorkspaceSearchRebuildRepository(dependencies.database),
    searchPort: dependencies.search,
    dispatcher: dependencies.dispatcher,
  });
  const searchRebuild: JobHandler<"search.rebuild"> = async (job, signal) => {
    if (job.payload.scope === "note") {
      await searchRebuildNote(job, signal);
      return;
    }
    await searchRebuildWorkspace(job, signal);
  };

  return {
    "search.index": createSearchIndexHandler({
      repository: new PostgresSearchIndexRepository(dependencies.database),
      searchPort: dependencies.search,
    }),
    "search.remove": createSearchRemoveHandler({
      repository: new PostgresSearchRemoveRepository(dependencies.database),
      searchPort: dependencies.search,
    }),
    "search.rebuild": searchRebuild,
  };
}
