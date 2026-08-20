import { unified, type Processor } from "unified";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import remarkGfm from "remark-gfm";
import remarkDirective from "remark-directive";
import remarkFrontmatter from "remark-frontmatter";
import type { PhrasingContent, Root } from "mdast";

export type MdastParser = (markdown: string) => Root;

export type MdastParseResult =
  | { ok: true; tree: Root }
  | { ok: false };

/**
 * A unified processor configured for both parse (markdown -> MDAST) and
 * stringify (MDAST -> markdown) with GFM, generic directives, and YAML
 * frontmatter. The same plugin set MUST back both directions so directive
 * fences round-trip.
 */
export function createProcessor(): Processor<Root, undefined, undefined, Root, string> {
  return unified()
    .use(remarkParse)
    .use(remarkStringify, {
      bullet: "-",
      fences: true,
      listItemIndent: "one",
      rule: "-",
    })
    .use(remarkGfm)
    .use(remarkFrontmatter, ["yaml"])
    .use(remarkDirective) as unknown as Processor<
    Root,
    undefined,
    undefined,
    Root,
    string
  >;
}

function parseWithProcessor(markdown: string): Root {
  return createProcessor().parse(markdown);
}

/** Parse markdown through an injectable adapter without leaking parser errors. */
export function parseMarkdown(
  markdown: string,
  parser: MdastParser = parseWithProcessor,
): MdastParseResult {
  try {
    return { ok: true, tree: parser(markdown) };
  } catch {
    return { ok: false };
  }
}

/** Parse markdown into MDAST for callers that require a tree. */
export function parseToMdast(markdown: string): Root {
  const result = parseMarkdown(markdown);
  if (!result.ok) throw new Error("Markdown could not be parsed safely.");
  return result.tree;
}

const MALFORMED_BLOCK_DIRECTIVE_RE = /^( {0,3}):{2,3}[a-z][a-z0-9-]{0,63}\{/;

interface SourceRange {
  from: number;
  to: number;
}

function collectInlineCodeRanges(
  children: PhrasingContent[],
  ranges: SourceRange[],
): void {
  for (const child of children) {
    if (child.type === "inlineCode") {
      const from = child.position?.start.offset;
      const to = child.position?.end.offset;
      if (from !== undefined && to !== undefined) ranges.push({ from, to });
      continue;
    }
    if ("children" in child) {
      collectInlineCodeRanges(child.children as PhrasingContent[], ranges);
    }
  }
}

/**
 * Detect the bounded directive syntax failure that remark represents as a
 * top-level paragraph instead of a directive node. The source slice is used
 * deliberately: MDAST text values may normalize escapes or line endings.
 */
export function hasMalformedBlockDirective(tree: Root, markdown: string): boolean {
  for (const node of tree.children) {
    if (node.type !== "paragraph" || node.position?.start.offset === undefined || node.position.end.offset === undefined) {
      continue;
    }

    const sourceStart = node.position.start.offset;
    const source = markdown.slice(sourceStart, node.position.end.offset);
    const inlineCodeRanges: SourceRange[] = [];
    collectInlineCodeRanges(node.children, inlineCodeRanges);
    const lines = source.split(/(\r\n|[\r\n])/);
    let lineStart = sourceStart;
    for (let index = 0; index < lines.length; index += 2) {
      const line = lines[index] ?? "";
      const match = MALFORMED_BLOCK_DIRECTIVE_RE.exec(line);
      const openerStart = lineStart + (match?.[1]?.length ?? 0);
      const isInlineCode = inlineCodeRanges.some(
        (range) => openerStart >= range.from && openerStart < range.to,
      );
      if (match && !isInlineCode && !line.includes("}")) {
        return true;
      }
      lineStart += line.length + (lines[index + 1]?.length ?? 0);
    }
  }
  return false;
}
