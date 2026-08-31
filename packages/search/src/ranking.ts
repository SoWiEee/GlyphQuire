import { normalizeSearchText } from "./extract.js";

export type SearchRanking = "relevance" | "weighted-v1";

export const DEFAULT_SEARCH_RANKING: SearchRanking = "relevance";

export interface SearchRankingFields {
  title: string;
  tags: readonly string[] | string;
  headings: readonly string[] | string;
  body: string;
}

export interface SearchRankingDocument extends SearchRankingFields {
  noteId: string;
  updatedAt: string;
  score?: number;
}

export interface RankedSearchResult extends SearchRankingDocument {
  score: number;
  rankingVersion: SearchRanking;
}

const FIELD_WEIGHTS = [
  ["title", 8],
  ["tags", 6],
  ["headings", 4],
  ["body", 1],
] as const satisfies readonly (readonly [keyof SearchRankingFields, number])[];

function fieldText(value: readonly string[] | string): string {
  return typeof value === "string" ? value : value.join(" ");
}

function trigrams(value: string): Set<string> {
  const padded = `  ${value} `;
  const result = new Set<string>();
  for (let index = 0; index + 3 <= padded.length; index += 1) {
    result.add(padded.slice(index, index + 3));
  }
  return result;
}

function trigramSimilarity(left: string, right: string): number {
  if (left === right) return 1;
  if (left.length < 3 || right.length < 3) return 0;

  const leftTrigrams = trigrams(left);
  const rightTrigrams = trigrams(right);
  let intersection = 0;
  for (const trigram of leftTrigrams) {
    if (rightTrigrams.has(trigram)) intersection += 1;
  }
  return (2 * intersection) / (leftTrigrams.size + rightTrigrams.size);
}

function matchesTerm(value: string, term: string): boolean {
  const normalizedValue = normalizeSearchText(value);
  if (normalizedValue.includes(term)) return true;

  // PostgreSQL's word_similarity fallback can return a row for a fuzzy word
  // even when the literal token is absent. Mirror that behavior for the
  // deterministic in-process score by comparing each whitespace-delimited
  // word with the query term using the same trigram-shaped signal.
  const words = normalizedValue.split(" ").filter(Boolean);
  return words.some((word) => trigramSimilarity(term, word) >= 0.5);
}

function matchesAnyTerm(value: readonly string[] | string, terms: readonly string[]): boolean {
  const text = fieldText(value);
  return terms.some((term) => matchesTerm(text, term));
}

/**
 * Computes the stable weighted-v1 score for one searchable document. A field
 * contributes its weight once when any normalized query term matches it;
 * this keeps repeated words from changing a result merely because of their
 * frequency while retaining the specified field priority.
 */
export function scoreWeightedV1(fields: SearchRankingFields, query: string): number {
  const terms = [...new Set(normalizeSearchText(query).split(" ").filter(Boolean))];
  if (terms.length === 0) return 0;

  return FIELD_WEIGHTS.reduce(
    (score, [field, weight]) => score + (matchesAnyTerm(fields[field], terms) ? weight : 0),
    0,
  );
}

function compareUpdatedAtDescending(left: string, right: string): number {
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
    return rightTime - leftTime;
  }
  if (left !== right) return right < left ? -1 : 1;
  return 0;
}

function compareRankedResults(left: RankedSearchResult, right: RankedSearchResult): number {
  if (left.score !== right.score) return right.score - left.score;

  const updatedAtOrder = compareUpdatedAtDescending(left.updatedAt, right.updatedAt);
  if (updatedAtOrder !== 0) return updatedAtOrder;
  if (left.noteId === right.noteId) return 0;
  return left.noteId < right.noteId ? -1 : 1;
}

/**
 * Applies a requested ranking and deterministic tie-break to search rows.
 * `relevance` preserves the backend relevance score, while `weighted-v1`
 * derives the score from title/tags/headings/body.
 */
export function rankSearchResults<T extends SearchRankingDocument>(
  documents: readonly T[],
  query: string,
  ranking: SearchRanking = DEFAULT_SEARCH_RANKING,
): Array<T & RankedSearchResult> {
  if (ranking !== "relevance" && ranking !== "weighted-v1") {
    throw new RangeError("Unsupported search ranking");
  }

  return documents
    .map((document) => ({
      ...document,
      score:
        ranking === "weighted-v1"
          ? scoreWeightedV1(document, query)
          : Number.isFinite(document.score)
            ? document.score!
            : 0,
      rankingVersion: ranking,
    }))
    .sort(compareRankedResults);
}
