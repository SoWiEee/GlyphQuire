import { describe, it, expect } from "vitest";
import { validateDocument } from "./validate.js";
import type { NotebookDocument } from "../ast/nodes.js";

describe("validateDocument", () => {
  it("flags a tab outside tabs as invalid parent", () => {
    const doc: NotebookDocument = { type: "document", specVersion: 1, children: [{ type: "tab", version: 1, props: { title: "X" }, children: [] }] };
    const r = validateDocument(doc);
    expect(r.valid).toBe(false);
    expect(r.diagnostics[0]?.code).toBe("INVALID_PARENT");
  });

  it("accepts a well-formed tabs block", () => {
    const doc: NotebookDocument = { type: "document", specVersion: 1, children: [{ type: "tabs", version: 1, children: [{ type: "tab", version: 1, props: { title: "A" }, children: [] }] }] };
    expect(validateDocument(doc).valid).toBe(true);
  });
});
