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
        { type: "runtime", version: 1, runtime: "p5", props: { height: 400, network: [], autoplay: false }, source: "circle(1,2,3)" },
      ],
    };
    const text = extractText(doc);
    expect(text).toContain("GPU");
    expect(text).toContain("Limit");
    expect(text).toContain("shared memory");
    expect(text).not.toContain("circle(1,2,3)");
  });
});
