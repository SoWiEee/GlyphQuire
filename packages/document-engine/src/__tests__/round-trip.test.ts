import { describe, it, expect } from "vitest";
import { createDocumentEngine, semanticNormalize } from "../index.js";

const engine = createDocumentEngine();

const DOCS: string[] = [
  '---\nglyphquire-spec: 1\n---\n\n# Title\n\nParagraph with **bold** and `code`.\n',
  '---\nglyphquire-spec: 1\n---\n\n:::callout{type="danger" title="Sec"}\nNever run this.\n:::\n',
  '---\nglyphquire-spec: 1\n---\n\n::::columns{count="2"}\n\n:::column\nLeft\n:::\n\n:::column\nRight\n:::\n\n::::\n',
  '---\nglyphquire-spec: 1\n---\n\n::::tabs\n\n:::tab{title="A"}\nAlpha\n:::\n\n::::\n',
  '---\nglyphquire-spec: 1\n---\n\n:::future{x="1"}\nkeep me\n:::\n',
];

describe("round-trip invariant (§36)", () => {
  for (const [index, md] of DOCS.entries()) {
    it(`preserves semantics for document ${index}`, () => {
      const ast1 = engine.parse(md).document;
      const ast2 = engine.parse(engine.serialize(ast1)).document;
      expect(semanticNormalize(ast2)).toEqual(semanticNormalize(ast1));
    });
  }
});
