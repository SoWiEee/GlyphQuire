import { describe, it, expect } from "vitest";
import { createDocumentEngine } from "./engine.js";

describe("DocumentEngine", () => {
  it("parses, validates, serializes, and extracts text", () => {
    const engine = createDocumentEngine();
    const md =
      '---\nglyphquire-spec: 1\n---\n\n# GPU\n\n:::callout{type="warning" title="Limit"}\nshared memory\n:::\n';
    const parsed = engine.parse(md);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("expected a valid v1 document");
    expect(parsed.specVersion).toBe(1);
    expect(parsed.source).toBe(md);
    expect(engine.validate(parsed.document).valid).toBe(true);
    expect(engine.serialize(parsed.document)).toContain(":::callout");
    expect(engine.extractText(parsed.document)).toContain("GPU");
  });

  it("migrate v1->v1 is identity", () => {
    const engine = createDocumentEngine();
    const md = "---\nglyphquire-spec: 1\n---\n\n# Hi\n";
    expect(engine.migrate(md, 1, 1).markdown).toBe(md);
  });
});
