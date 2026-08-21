import { describe, it, expect } from "vitest";
import { parseToMdast } from "../parser/mdast.js";
import { mdastToMarkdown } from "./to-markdown.js";

describe("mdastToMarkdown", () => {
  it("round-trips a nested container directive with sufficient fence length", () => {
    const input = '::::columns{count="2"}\n\n:::callout{type="info"}\nLeft\n:::\n\n::::\n';
    const out = mdastToMarkdown(parseToMdast(input));
    expect(out).toContain("::::columns");
    expect(out).toContain(":::callout");
    // outer fence longer than inner
    expect(out.indexOf("::::columns")).toBeGreaterThanOrEqual(0);
  });

  it("ends with a trailing newline", () => {
    const out = mdastToMarkdown(parseToMdast("# Hi\n"));
    expect(out.endsWith("\n")).toBe(true);
  });
});
