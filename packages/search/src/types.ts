/**
 * Search-domain types. Deliberately independent of the HTTP API contract
 * (`@glyphquire/api-contract`) so this package stays a pure port/adapter: the
 * API layer translates between its own request/response schemas and these
 * shapes, never the other way around.
 */

export interface SearchableNote {
  noteId: string;
  workspaceId: string;
  revision: number;
  title: string;
  headings: string[];
  body: string;
  tags: string[];
  normalizedText: string;
}

export interface SearchCursor {
  updatedAt: string;
  noteId: string;
}

export interface SearchQuery {
  actorId: string;
  workspaceId: string;
  q: string;
  cursor?: SearchCursor;
  pageSize: number;
}

export interface SearchResult {
  noteId: string;
  workspaceId: string;
  revision: number;
  title: string;
  snippet: string;
  score: number;
  updatedAt: string;
}

/**
 * `search()` returns raw ranked rows for the requested page — up to
 * `query.pageSize + 1` results, ordered newest-first with a stable
 * `(updatedAt, noteId)` tie-break. Callers (the API's SearchService) detect
 * "has more" from the overflow row and derive the next cursor from the last
 * kept result themselves; the port never encodes cursor envelopes.
 */
export interface SearchPort {
  indexNote(note: SearchableNote): Promise<void>;
  removeNote(noteId: string): Promise<void>;
  search(query: SearchQuery): Promise<SearchResult[]>;
}
