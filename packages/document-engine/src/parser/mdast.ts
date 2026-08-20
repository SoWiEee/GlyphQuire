import { unified, type Processor } from "unified";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import remarkGfm from "remark-gfm";
import remarkDirective from "remark-directive";
import remarkFrontmatter from "remark-frontmatter";
import type { Root } from "mdast";

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

/** Parse markdown into MDAST. Never throws on arbitrary UTF-8. */
export function parseToMdast(markdown: string): Root {
  return createProcessor().parse(markdown);
}
