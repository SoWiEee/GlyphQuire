import type { z } from "zod";
import type {
  searchQuerySchema,
  searchRankingSchema,
  searchResponseSchema,
  searchResultSchema,
} from "./schemas.js";

export type SearchRanking = z.infer<typeof searchRankingSchema>;
type ParsedSearchQuery = z.output<typeof searchQuerySchema>;
export type SearchQuery = Omit<ParsedSearchQuery, "ranking"> & { ranking?: SearchRanking };
export type SearchResult = z.infer<typeof searchResultSchema>;
export type SearchResponse = z.infer<typeof searchResponseSchema>;
