import { describe, it, expect } from "vitest";
import { semanticNormalize } from "./normalize.js";
import type { NotebookDocument, CalloutNode } from "./nodes.js";

describe("semanticNormalize", () => {
  it("deep clones: returned document and nested children are different references", () => {
    const callout: CalloutNode = {
      type: "callout",
      version: 1,
      props: { type: "info" },
      children: [],
    };
    const doc: NotebookDocument = {
      type: "document",
      specVersion: 1,
      children: [callout],
    };

    const normalized = semanticNormalize(doc);

    expect(normalized).not.toBe(doc);
    expect(normalized.children).not.toBe(doc.children);
    expect(normalized.children[0]).not.toBe(doc.children[0]);

    // Mutating the output must not affect the input.
    (normalized.children[0] as CalloutNode).props.type = "warning";
    expect((doc.children[0] as CalloutNode).props.type).toBe("info");
  });

  it("drops undefined-valued props", () => {
    const doc: NotebookDocument = {
      type: "document",
      specVersion: 1,
      children: [
        {
          type: "callout",
          version: 1,
          props: { type: "warning", title: "T", icon: undefined },
          children: [],
        },
      ],
    };

    const normalized = semanticNormalize(doc);
    const props = (normalized.children[0] as CalloutNode).props as unknown as Record<
      string,
      unknown
    >;

    expect("icon" in props).toBe(false);
    expect(JSON.stringify(normalized)).not.toContain('"icon"');
  });

  it("sorts object keys deterministically and orders callout props", () => {
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
    expect(JSON.stringify(normalized.children[0])).toBe(
      '{"children":[],"props":{"title":"T","type":"warning"},"type":"callout","version":1}',
    );
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
