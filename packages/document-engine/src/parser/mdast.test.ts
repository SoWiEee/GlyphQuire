import { describe, it, expect } from "vitest";
import { parseMarkdown, parseToMdast } from "./mdast.js";

describe("parseToMdast", () => {
  it("parses a container directive into a containerDirective node", () => {
    const tree = parseToMdast(':::callout{type="info"}\nHi\n:::\n');
    const node = tree.children.find((c) => c.type === "containerDirective");
    expect(node).toBeDefined();
    // @ts-expect-error narrowing for test
    expect(node.name).toBe("callout");
  });

  it("parses GFM tables", () => {
    const tree = parseToMdast("| a | b |\n| - | - |\n| 1 | 2 |\n");
    expect(tree.children.some((c) => c.type === "table")).toBe(true);
  });

  it("does not throw on arbitrary input", () => {
    expect(() => parseToMdast(" ￿:::{}}}not valid")).not.toThrow();
  });

  it("reports an injected parser failure explicitly", () => {
    const result = parseMarkdown("source", () => {
      throw new Error("parser exploded");
    });

    expect(result).toStrictEqual({ ok: false });
  });
});
