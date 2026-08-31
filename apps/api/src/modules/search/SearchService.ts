import { notes, workspaceMembers, type Database } from "@glyphquire/database";
import type { JobDispatcher } from "@glyphquire/queue";
import type { SearchRebuildPayload } from "@glyphquire/api-contract/jobs";
import type { SearchQuery as SearchQueryContract, SearchResponse } from "@glyphquire/api-contract";
import { type SearchQueryPort } from "@glyphquire/search";
import { and, eq } from "drizzle-orm";
import { PublicApiError } from "../../middleware/error-handler.js";
import type { OperatorAuthorizer } from "./OperatorAuthorizer.js";
import { SearchReadModule } from "./SearchReadModule.js";

function notFound(): never {
  throw new PublicApiError("NOTE_NOT_FOUND", 404);
}

export type SearchRebuildNoteInput = Extract<SearchRebuildPayload, { scope: "note" }>;

export interface SearchService {
  search(actorId: string, query: SearchQueryContract): Promise<SearchResponse>;
  rebuildNote(actorId: string, input: SearchRebuildNoteInput): Promise<{ enqueued: boolean }>;
}

export class SearchServiceImpl implements SearchService {
  constructor(
    private readonly db: Database,
    searchPort: SearchQueryPort,
    private readonly dispatcher: JobDispatcher,
    private readonly operatorAuthorizer: OperatorAuthorizer,
    private readonly searchReadModule = new SearchReadModule(searchPort),
  ) {}

  private async requireMembership(actorId: string, workspaceId: string): Promise<void> {
    const [member] = await this.db
      .select({ role: workspaceMembers.role })
      .from(workspaceMembers)
      .where(
        and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, actorId)),
      )
      .limit(1);
    if (!member) notFound();
  }

  async search(actorId: string, query: SearchQueryContract): Promise<SearchResponse> {
    await this.requireMembership(actorId, query.workspaceId);
    return this.searchReadModule.search(actorId, query);
  }

  async rebuildNote(
    actorId: string,
    input: SearchRebuildNoteInput,
  ): Promise<{ enqueued: boolean }> {
    this.operatorAuthorizer.authorize(actorId);

    const [note] = await this.db
      .select({ id: notes.id })
      .from(notes)
      .where(and(eq(notes.id, input.noteId), eq(notes.workspaceId, input.workspaceId)))
      .limit(1);
    if (!note) notFound();

    await this.dispatcher.enqueue({
      workspaceId: input.workspaceId,
      type: "search.rebuild",
      payload: input,
    });
    return { enqueued: true };
  }
}
