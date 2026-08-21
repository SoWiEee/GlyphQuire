import { describe, it, expect } from "vitest";
import { extractText } from "./extract.js";
import type { NotebookDocument } from "../ast/nodes.js";

describe("extractText", () => {
  it("collects heading, callout title, and paragraph text; excludes runtime source", () => {
    const doc: NotebookDocument = {
      type: "document",
      specVersion: 1,
      children: [
        { type: "heading", depth: 1, children: [{ type: "text", value: "GPU" }] },
        {
          type: "callout",
          version: 1,
          props: { type: "warning", title: "Limit" },
          children: [{ type: "paragraph", children: [{ type: "text", value: "shared memory" }] }],
        },
        {
          type: "runtime",
          version: 1,
          runtime: "p5",
          props: { height: 400, network: [], autoplay: false },
          source: "circle(1,2,3)",
        },
      ],
    };
    const text = extractText(doc);
    expect(text).toContain("GPU");
    expect(text).toContain("Limit");
    expect(text).toContain("shared memory");
    expect(text).not.toContain("circle(1,2,3)");
  });

  it("collects quote, list item, sticky, toggle, tab, table, and image-alt text", () => {
    const doc: NotebookDocument = {
      type: "document",
      specVersion: 1,
      children: [
        {
          type: "quote",
          children: [
            { type: "paragraph", children: [{ type: "text", value: "attributed wisdom" }] },
          ],
        },
        {
          type: "list",
          ordered: false,
          spread: false,
          children: [
            {
              type: "listItem",
              spread: false,
              children: [{ type: "paragraph", children: [{ type: "text", value: "buy milk" }] }],
            },
          ],
        },
        {
          type: "sticky",
          version: 1,
          props: { tone: "yellow", title: "Reminder" },
          children: [{ type: "paragraph", children: [{ type: "text", value: "sticky body" }] }],
        },
        {
          type: "toggle",
          version: 1,
          props: { title: "More info", open: false },
          children: [{ type: "paragraph", children: [{ type: "text", value: "toggle body" }] }],
        },
        {
          type: "tabs",
          version: 1,
          children: [
            {
              type: "tab",
              version: 1,
              props: { title: "Tab One" },
              children: [{ type: "paragraph", children: [{ type: "text", value: "tab body" }] }],
            },
          ],
        },
        {
          type: "table",
          align: [null, null],
          children: [
            {
              type: "tableRow",
              children: [{ type: "tableCell", children: [{ type: "text", value: "cell value" }] }],
            },
          ],
        },
        { type: "image", url: "https://example.com/a.png", alt: "diagram of a cat" },
      ],
    };
    const text = extractText(doc);
    expect(text).toContain("attributed wisdom");
    expect(text).toContain("buy milk");
    expect(text).toContain("Reminder");
    expect(text).toContain("sticky body");
    expect(text).toContain("More info");
    expect(text).toContain("toggle body");
    expect(text).toContain("Tab One");
    expect(text).toContain("tab body");
    expect(text).toContain("cell value");
    expect(text).toContain("diagram of a cat");
  });

  it("excludes thematic breaks, definitions, and code blocks", () => {
    const doc: NotebookDocument = {
      type: "document",
      specVersion: 1,
      children: [
        { type: "thematicBreak" },
        {
          type: "definition",
          identifier: "ref1",
          url: "https://example.com",
          title: "Example Title Text",
        },
        { type: "code", lang: "js", value: "const secretCode = 42;" },
      ],
    };
    const text = extractText(doc);
    expect(text).not.toContain("Example Title Text");
    expect(text).not.toContain("secretCode");
    expect(text).toBe("");
  });
});
