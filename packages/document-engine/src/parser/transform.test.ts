import { describe, it, expect } from "vitest";
import { parse } from "./index.js";

describe("parse", () => {
  it("transforms a callout directive to a semantic callout node", () => {
    const r = parse('---\nglyphquire-spec: 1\n---\n\n:::callout{type="warning" title="T"}\nHi\n:::\n');
    const callout = r.document.children.find((c) => c.type === "callout");
    expect(callout).toBeDefined();
    // @ts-expect-error test narrowing
    expect(callout.props.type).toBe("warning");
    expect(r.specVersion).toBe(1);
  });

  it("lifts a lone image paragraph to an image node", () => {
    const r = parse("---\nglyphquire-spec: 1\n---\n\n![Arch](asset://01ABC)\n");
    expect(r.document.children.some((c) => c.type === "image")).toBe(true);
  });

  it("preserves an unknown directive without discarding it", () => {
    const r = parse('---\nglyphquire-spec: 1\n---\n\n:::future{x="1"}\nHi\n:::\n');
    const unknown = r.document.children.find((c) => c.type === "unknown-directive");
    expect(unknown).toBeDefined();
    // @ts-expect-error test narrowing
    expect(unknown.name).toBe("future");
    expect(r.diagnostics.some((d) => d.code === "DIRECTIVE_UNKNOWN")).toBe(true);
  });

  it("produces an invalid-block for a schema-invalid callout", () => {
    const r = parse('---\nglyphquire-spec: 1\n---\n\n:::callout{type="banana"}\nHi\n:::\n');
    expect(r.document.children.some((c) => c.type === "invalid-block")).toBe(true);
  });

  it("never throws on arbitrary input", () => {
    expect(() => parse("  not ::: valid {{{")).not.toThrow();
  });
});
