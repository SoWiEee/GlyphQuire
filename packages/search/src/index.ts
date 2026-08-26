export type {
  SearchableNote,
  SearchCursor,
  SearchQuery,
  SearchResult,
  SearchPort,
} from "./types.js";
export {
  extractSearchableText,
  normalizeSearchText,
  SearchTextTooLargeError,
  type ExtractedNoteText,
} from "./extract.js";
export { PostgresSearchAdapter } from "./postgres.js";
