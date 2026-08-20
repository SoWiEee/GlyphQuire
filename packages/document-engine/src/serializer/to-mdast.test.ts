import { describe, it, expect } from "vitest";
import { parse } from "../parser/index.js";
import { serialize } from "./index.js";
import { documentToMdast } from "./to-mdast.js";
import { BlockRegistry } from "../registry/registry.js";

function roundTrip(md: string): string {
  const result = parse(md);
  if (!result.ok) throw new Error("expected a valid v1 document");
  return serialize(result.document);
}

describe("serialize", () => {
  it("re-emits a callout directive", () => {
    const out = roundTrip('---\nglyphquire-spec: 1\n---\n\n:::callout{type="warning"}\nHi\n:::\n');
    expect(out).toContain(":::callout");
    expect(out).toContain('type="warning"');
  });

  it("preserves an unknown directive", () => {
    const out = roundTrip('---\nglyphquire-spec: 1\n---\n\n:::future{x="1"}\nHi\n:::\n');
    expect(out).toContain(":::future");
    expect(out).toContain('x="1"');
  });

  it("preserves an unknown leaf directive as a leaf", () => {
    const out = roundTrip('---\nglyphquire-spec: 1\n---\n\n::future{x="1"}\n');
    expect(out).toContain("::future");
    expect(out).not.toContain(":::future");
    expect(out).toContain('x="1"');
  });

  it("preserves the leaf form of a known directive kind mismatch", () => {
    const out = roundTrip('---\nglyphquire-spec: 1\n---\n\n::callout{type="warning"}\n');
    expect(out).toContain("::callout");
    expect(out).not.toContain(":::callout");
    expect(out).toContain('type="warning"');
  });

  it("round-trips an unknown inline text directive inside its paragraph", () => {
    const out = roundTrip('---\nglyphquire-spec: 1\n---\n\nBefore :future[inline] after.\n');
    expect(out).toContain(":future[inline]");
  });

  it.each([
    ["tabs", '::::tabs\n\n:::tab{title="A"}\nValid tab.\n:::\n\nSentinel tabs paragraph.\n\n::::\n'],
    ["columns", '::::columns{count="2"}\n\n:::column\nValid column.\n:::\n\nSentinel columns paragraph.\n\n::::\n'],
  ])("serializes the retained foreign child of %s", (_name, body) => {
    const out = roundTrip(`---\nglyphquire-spec: 1\n---\n\n${body}`);
    expect(out).toContain("Sentinel");
  });

  it("serializes a schema-invalid nominal tab with its sentinel content", () => {
    const out = roundTrip('---\nglyphquire-spec: 1\n---\n\n:::tabs\n:::tab\nSentinel tab content.\n:::\n:::\n');
    expect(out).toContain("Sentinel tab content.");
    expect(out).toContain(":::tab");
  });

  it("serializes a leaf-form nominal column with its original kind", () => {
    const out = roundTrip('---\nglyphquire-spec: 1\n---\n\n::::columns{count="2"}\n::column\n::::\n');
    expect(out).toMatch(/\n::column(?:\n|$)/);
    expect(out).not.toMatch(/\n:::column(?:\{|\n|$)/);
  });

  it("preserves asset:// image URIs", () => {
    const out = roundTrip("---\nglyphquire-spec: 1\n---\n\n![Arch](asset://01ABC)\n");
    expect(out).toContain("asset://01ABC");
  });

  it("emits the glyphquire-spec frontmatter", () => {
    const out = roundTrip("---\nglyphquire-spec: 1\n---\n\n# Hi\n");
    expect(out).toContain("glyphquire-spec: 1");
  });

  it("throws instead of silently dropping a directive block whose definition is missing from the registry", () => {
    const result = parse('---\nglyphquire-spec: 1\n---\n\n:::callout{type="warning"}\nHi\n:::\n');
    if (!result.ok) throw new Error("expected a valid v1 document");
    const { document } = result;
    const emptyRegistry = new BlockRegistry();
    expect(() => documentToMdast(document, emptyRegistry)).toThrow(/Cannot serialize block "callout"/);
    expect(() => serialize(document, emptyRegistry)).toThrow(/Cannot serialize block "callout"/);
  });
});
