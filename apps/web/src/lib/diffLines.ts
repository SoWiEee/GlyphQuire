/**
 * Line-level diff used only to drive CSS highlight classes in the conflict
 * recovery panes — every consumer renders `DiffSegment.text` as a plain text
 * node, never as HTML, so this module has no injection surface regardless of
 * document content.
 */
export type DiffSegmentKind = "equal" | "local-only" | "server-only";

export interface DiffSegment {
  readonly kind: DiffSegmentKind;
  readonly text: string;
}

/** Bounds the O(n*m) LCS table so a pathologically large document can't hang the tab. */
export const MAX_DIFF_LINES = 600;

function computeLcsTable(a: readonly string[], b: readonly string[]): number[][] {
  const table: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i][j] =
        a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  return table;
}

function backtrack(a: readonly string[], b: readonly string[], table: number[][]): DiffSegment[] {
  const segments: DiffSegment[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      segments.push({ kind: "equal", text: a[i] });
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      segments.push({ kind: "local-only", text: a[i] });
      i += 1;
    } else {
      segments.push({ kind: "server-only", text: b[j] });
      j += 1;
    }
  }
  while (i < a.length) {
    segments.push({ kind: "local-only", text: a[i] });
    i += 1;
  }
  while (j < b.length) {
    segments.push({ kind: "server-only", text: b[j] });
    j += 1;
  }
  return segments;
}

/**
 * Diffs two Markdown documents line by line. Returns `null` when either side
 * exceeds {@link MAX_DIFF_LINES}, signaling the caller to fall back to plain
 * (unhighlighted) panes instead of paying the quadratic cost.
 */
export function diffLines(localText: string, serverText: string): DiffSegment[] | null {
  const a = localText.split("\n");
  const b = serverText.split("\n");
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) return null;
  return backtrack(a, b, computeLcsTable(a, b));
}
