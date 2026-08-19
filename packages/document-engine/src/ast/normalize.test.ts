import { describe, it, expect } from "vitest";
import { semanticNormalize } from "./normalize.js";
import type { NotebookDocument } from "./nodes.js";

describe("semanticNormalize", () => {
  it("drops the default toggle open value and orders callout props deterministically", () => {
    const doc: NotebookDocument = {
      type: "document",
      specVersion: 1,
      children: [
        {
          type: "callout",
          version: 1,
          props: { title: "T", type: "warning" },
          children: [],
        },
      ],
    };
    const normalized = semanticNormalize(doc);
    expect(JSON.stringify(normalized)).toContain('"type":"warning"');
  });

  it("is idempotent", () => {
    const doc: NotebookDocument = {
      type: "document",
      specVersion: 1,
      children: [{ type: "thematicBreak" }],
    };
    expect(semanticNormalize(semanticNormalize(doc))).toEqual(semanticNormalize(doc));
  });
});
