import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { createDocumentEngine, semanticNormalize, migrateDocument } from "../index.js";

const engine = createDocumentEngine();

describe("properties (§60)", () => {
  it("parse never throws on arbitrary UTF-8", () => {
    fc.assert(
      fc.property(fc.fullUnicodeString(), (s) => {
        expect(() => engine.parse(s)).not.toThrow();
      }),
      { numRuns: 500 },
    );
  });

  it("serialize(parse(valid)) preserves semantics for prefixed documents", () => {
    fc.assert(
      fc.property(fc.lorem({ maxCount: 8 }), (body) => {
        const md = `---\nglyphquire-spec: 1\n---\n\n${body}\n`;
        const parsed1 = engine.parse(md);
        expect(parsed1.ok).toBe(true);
        if (!parsed1.ok) throw new Error("expected a valid v1 document");
        const ast1 = parsed1.document;
        const parsed2 = engine.parse(engine.serialize(ast1));
        expect(parsed2.ok).toBe(true);
        if (!parsed2.ok) throw new Error("expected serialized v1 document");
        const ast2 = parsed2.document;
        expect(semanticNormalize(ast2)).toEqual(semanticNormalize(ast1));
      }),
      { numRuns: 200 },
    );
  });

  it("migrate v1->v1 is identity", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        expect(migrateDocument(s, 1, 1).markdown).toBe(s);
      }),
    );
  });
});
