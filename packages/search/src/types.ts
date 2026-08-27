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

export interface DerivedSearchMutationTarget {
  noteId: string;
  workspaceId: string;
  revision: number;
}

export interface DerivedSearchMissingTarget {
  noteId: string;
  workspaceId: string;
}

/**
 * Stronger mutation capability for at-least-once jobs derived from the
 * authoritative note row. Implementations must compare the target identity,
 * workspace, revision, and deletion state at the same serialization boundary
 * as the index mutation. Index applies only to an exact active revision;
 * current removal applies only to an exact deleted revision (or an absent
 * source), and missing removal applies only while the source remains absent.
 * A stale comparison is a successful no-op.
 */
export interface DerivedSearchMutationPort {
  indexNoteIfCurrent(note: SearchableNote): Promise<void>;
  removeNoteIfCurrent(target: DerivedSearchMutationTarget): Promise<void>;
  removeNoteIfMissing(target: DerivedSearchMissingTarget): Promise<void>;
}
