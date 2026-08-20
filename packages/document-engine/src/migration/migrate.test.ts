import { describe, it, expect } from "vitest";
import { migrateDocument, CURRENT_SPEC_VERSION } from "./migrate.js";

describe("migrateDocument", () => {
  it("v1 -> v1 is identity", () => {
    const md = "---\nglyphquire-spec: 1\n---\n\n# Hi\n";
    const r = migrateDocument(md, 1, 1);
    expect(r.ok).toBe(true);
    expect(r.markdown).toBe(md);
    expect(r.diagnostics).toHaveLength(0);
  });

  it("rejects unsupported future target version and preserves source", () => {
    const md = "# Hi\n";
    const r = migrateDocument(md, 1, 2);
    expect(r.ok).toBe(false);
    expect(r.markdown).toBe(md);
    expect(r.diagnostics[0]?.code).toBe("UNSUPPORTED_SPEC_VERSION");
  });

  it("rejects a non-positive from version", () => {
    const r = migrateDocument("x", 0, 1);
    expect(r.ok).toBe(false);
    expect(r.diagnostics[0]?.code).toBe("SPEC_VERSION_INVALID");
  });

  it("CURRENT_SPEC_VERSION is 1", () => {
    expect(CURRENT_SPEC_VERSION).toBe(1);
  });
});
