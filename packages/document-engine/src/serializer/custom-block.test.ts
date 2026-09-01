import { describe, expect, it } from "vitest";
import { parse } from "../parser/index.js";
import { serialize } from "./index.js";
import { registerDeclarative } from "../registry/declarative.js";
import { createRegistry } from "../registry/builtins.js";

const definition = {
  name: "reading-score",
  version: 1,
  kind: "container" as const,
  propsSchema: {
    label: { type: "string" as const, required: true, maxLength: 50 },
    score: { type: "number" as const, required: true, minimum: 0, maximum: 5 },
  },
  contentPolicy: "required" as const,
  icon: "check" as const,
  preset: "rating" as const,
  capabilities: ["static"] as const,
};

function registry() {
  const value = createRegistry();
  registerDeclarative(value, definition);
  return value;
}

describe("Custom Block serialization", () => {
  it("round-trips a valid custom directive through the semantic AST", () => {
    const source =
      '---\nglyphquire-spec: 1\n---\n\n:::reading-score{version="1" label="Clarity" score="4"}\nEvidence\n:::\n';
    const value = parse(source, registry());
    expect(value.ok).toBe(true);
    if (!value.ok) throw new Error("expected accepted document");
    const emitted = serialize(value.document, registry());
    const reparsed = parse(emitted, registry());
    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) throw new Error("expected round-trip document");
    expect(reparsed.document.children[0]).toMatchObject({
      type: "custom-block",
      props: { label: "Clarity", score: 4 },
    });
  });
});
