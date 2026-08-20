import { unified, type Processor } from "unified";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import remarkGfm from "remark-gfm";
import remarkDirective from "remark-directive";
import remarkFrontmatter from "remark-frontmatter";
import type { Root } from "mdast";

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

const MALFORMED_BLOCK_DIRECTIVE_RE = /^ {0,3}:{2,3}[a-z][a-z0-9-]{0,63}\{/;

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

    const source = markdown.slice(node.position.start.offset, node.position.end.offset);
    for (const line of source.split(/\r?\n/)) {
      if (MALFORMED_BLOCK_DIRECTIVE_RE.test(line) && !line.includes("}")) {
        return true;
      }
    }
  }
  return false;
}
