import type { z } from "zod";
import type { searchQuerySchema, searchResponseSchema, searchResultSchema } from "./schemas.js";

export type SearchQuery = z.output<typeof searchQuerySchema>;
export type SearchResult = z.infer<typeof searchResultSchema>;
export type SearchResponse = z.infer<typeof searchResponseSchema>;
