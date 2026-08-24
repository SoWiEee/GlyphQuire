import { describe, it, expect } from "vitest";
import { validateDocument } from "./validate.js";
import type { NotebookDocument } from "../ast/nodes.js";

describe("validateDocument", () => {
  it("flags a tab outside tabs as invalid parent", () => {
    const doc: NotebookDocument = {
      type: "document",
      specVersion: 1,
      children: [{ type: "tab", version: 1, props: { title: "X" }, children: [] }],
    };
    const r = validateDocument(doc);
    expect(r.valid).toBe(false);
    expect(r.diagnostics[0]?.code).toBe("INVALID_PARENT");
  });

  it("accepts a well-formed tabs block", () => {
    const doc: NotebookDocument = {
      type: "document",
      specVersion: 1,
      children: [
        {
          type: "tabs",
          version: 1,
          children: [{ type: "tab", version: 1, props: { title: "A" }, children: [] }],
        },
      ],
    };
    expect(validateDocument(doc).valid).toBe(true);
  });

  it("flags an empty tabs block as invalid child", () => {
    const doc: NotebookDocument = {
      type: "document",
      specVersion: 1,
      children: [{ type: "tabs", version: 1, children: [] }],
    };
    const r = validateDocument(doc);
    expect(r.valid).toBe(false);
    expect(r.diagnostics[0]?.code).toBe("INVALID_CHILD");
  });

  it("flags a column outside columns as invalid parent", () => {
    const doc: NotebookDocument = {
      type: "document",
      specVersion: 1,
      children: [{ type: "column", version: 1, children: [] }],
    };
    const r = validateDocument(doc);
    expect(r.valid).toBe(false);
    expect(r.diagnostics[0]?.code).toBe("INVALID_PARENT");
  });

  it("uses the recovered tabs scope for retained children of an invalid tabs block", () => {
    const doc: NotebookDocument = {
      type: "document",
      specVersion: 1,
      children: [
        {
          type: "invalid-block",
          originalType: "tabs",
          directiveType: "container",
          attributes: {},
          errors: [{ code: "INVALID_CHILD", message: "foreign child" }],
          children: [
            { type: "paragraph", children: [] },
            { type: "tab", version: 1, props: { title: "A" }, children: [] },
          ],
        },
      ],
    };

    const r = validateDocument(doc);
    expect(r.diagnostics.filter((d) => d.code === "INVALID_PARENT")).toHaveLength(0);
  });

  it("uses the recovered columns scope for retained children of an invalid columns block", () => {
    const doc: NotebookDocument = {
      type: "document",
      specVersion: 1,
      children: [
        {
          type: "invalid-block",
          originalType: "columns",
          directiveType: "container",
          attributes: {},
          errors: [{ code: "INVALID_CHILD", message: "foreign child" }],
          children: [
            { type: "paragraph", children: [] },
            { type: "column", version: 1, children: [] },
          ],
        },
      ],
    };

    const r = validateDocument(doc);
    expect(r.diagnostics.filter((d) => d.code === "INVALID_PARENT")).toHaveLength(0);
  });
});
