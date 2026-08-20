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

  it("records an INVALID_CHILD diagnostic for a foreign child of tabs and keeps the valid tab", () => {
    const r = parse(
      '---\nglyphquire-spec: 1\n---\n\n:::tabs\nStray paragraph.\n\n:::tab{title="A"}\nHi\n:::\n:::\n',
    );
    expect(r.diagnostics.some((d) => d.code === "INVALID_CHILD")).toBe(true);
    const tabs = r.document.children.find((c) => c.type === "tabs");
    expect(tabs).toBeDefined();
    // @ts-expect-error test narrowing
    expect(tabs.children).toHaveLength(1);
    // @ts-expect-error test narrowing
    expect(tabs.children[0].props.title).toBe("A");
  });

  it("records an INVALID_CHILD diagnostic for a foreign child of columns and keeps the valid column", () => {
    const r = parse(
      '---\nglyphquire-spec: 1\n---\n\n:::columns\nStray paragraph.\n\n:::column\nHi\n:::\n:::\n',
    );
    expect(r.diagnostics.some((d) => d.code === "INVALID_CHILD")).toBe(true);
    const columns = r.document.children.find((c) => c.type === "columns");
    expect(columns).toBeDefined();
    // @ts-expect-error test narrowing
    expect(columns.children).toHaveLength(1);
  });

  it("emits DIRECTIVE_UNKNOWN exactly once for an unknown directive nested in a known block", () => {
    const r = parse(
      '---\nglyphquire-spec: 1\n---\n\n:::callout{type="info"}\n:::future{}\n:::\n:::\n',
    );
    const occurrences = r.diagnostics.filter((d) => d.code === "DIRECTIVE_UNKNOWN");
    expect(occurrences).toHaveLength(1);
  });
});
