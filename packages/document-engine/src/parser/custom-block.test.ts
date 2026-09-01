import { describe, expect, it } from "vitest";
import { parse } from "./index.js";
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

describe("Custom Block parsing", () => {
  it("parses bounded scalar props and nested content", () => {
    const result = parse(
      '---\nglyphquire-spec: 1\n---\n\n:::reading-score{version="1" label="Clarity" score="4"}\nEvidence\n:::\n',
      registry(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected accepted document");
    expect(result.document.children[0]).toMatchObject({
      type: "custom-block",
      name: "reading-score",
      version: 1,
      props: { label: "Clarity", score: 4 },
      children: [{ type: "paragraph" }],
    });
  });

  it("preserves invalid authored directives as recoverable nodes", () => {
    const result = parse(
      '---\nglyphquire-spec: 1\n---\n\n:::reading-score{label="Clarity" score="nine"}\nEvidence\n:::\n',
      registry(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected recoverable document");
    expect(result.document.children[0]).toMatchObject({
      type: "invalid-block",
      originalType: "reading-score",
      attributes: { label: "Clarity", score: "nine" },
    });
  });
});
