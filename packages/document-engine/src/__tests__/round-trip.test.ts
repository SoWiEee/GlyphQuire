import { describe, it, expect } from "vitest";
import { createDocumentEngine, semanticNormalize } from "../index.js";

const engine = createDocumentEngine();

const DOCS: string[] = [
  "---\nglyphquire-spec: 1\n---\n\n# Title\n\nParagraph with **bold** and `code`.\n",
  '---\nglyphquire-spec: 1\n---\n\n:::callout{type="danger" title="Sec"}\nNever run this.\n:::\n',
  '---\nglyphquire-spec: 1\n---\n\n::::columns{count="2"}\n\n:::column\nLeft\n:::\n\n:::column\nRight\n:::\n\n::::\n',
  '---\nglyphquire-spec: 1\n---\n\n::::tabs\n\n:::tab{title="A"}\nAlpha\n:::\n\n::::\n',
  '---\nglyphquire-spec: 1\n---\n\n:::future{x="1"}\nkeep me\n:::\n',
];

describe("round-trip invariant (§36)", () => {
  for (const [index, md] of DOCS.entries()) {
    it(`preserves semantics for document ${index}`, () => {
      const parsed1 = engine.parse(md);
      expect(parsed1.ok).toBe(true);
      if (!parsed1.ok) throw new Error("expected a valid v1 document");
      const ast1 = parsed1.document;
      const parsed2 = engine.parse(engine.serialize(ast1));
      expect(parsed2.ok).toBe(true);
      if (!parsed2.ok) throw new Error("expected serialized v1 document");
      const ast2 = parsed2.document;
      expect(semanticNormalize(ast2)).toEqual(semanticNormalize(ast1));
    });
  }
});
