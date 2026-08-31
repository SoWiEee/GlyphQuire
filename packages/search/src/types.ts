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
 * The read-side document returned by a search query. The ranking fields are
 * selected with the match in one adapter query so API composition never has
 * to enrich a result by reaching back into the search index.
 */
export interface SearchDocument extends SearchResult {
  headings: string;
  tags: string;
  body: string;
}

/** Retrieves already-authorized search documents for a read model. */
export interface SearchQueryPort {
  search(query: SearchQuery): Promise<SearchDocument[]>;
}

/** Mutation-only port used by note-derived indexing jobs. */
export interface SearchPort {
  indexNote(note: SearchableNote): Promise<void>;
  removeNote(noteId: string): Promise<void>;
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
