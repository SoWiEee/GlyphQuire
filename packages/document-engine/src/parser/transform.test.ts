import { describe, it, expect } from "vitest";
import { importLegacy, parse, parseWithMdastParser } from "./index.js";

describe("parse", () => {
  it("transforms a callout directive to a semantic callout node", () => {
    const source = '---\nglyphquire-spec: 1\n---\n\n:::callout{type="warning" title="T"}\nHi\n:::\n';
    const r = parse(source);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected a valid v1 document");
    const callout = r.document.children.find((c) => c.type === "callout");
    expect(callout).toBeDefined();
    // @ts-expect-error test narrowing
    expect(callout.props.type).toBe("warning");
    expect(r.specVersion).toBe(1);
    expect(r.source).toBe(source);
  });

  it("lifts a lone image paragraph to an image node", () => {
    const r = parse("---\nglyphquire-spec: 1\n---\n\n![Arch](asset://01ABC)\n");
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected a valid v1 document");
    expect(r.document.children.some((c) => c.type === "image")).toBe(true);
  });

  it("preserves an unknown directive without discarding it", () => {
    const r = parse('---\nglyphquire-spec: 1\n---\n\n:::future{x="1"}\nHi\n:::\n');
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected a valid v1 document");
    const unknown = r.document.children.find((c) => c.type === "unknown-directive");
    expect(unknown).toBeDefined();
    // @ts-expect-error test narrowing
    expect(unknown.name).toBe("future");
    expect(r.diagnostics.some((d) => d.code === "DIRECTIVE_UNKNOWN")).toBe(true);
  });

  it("produces an invalid-block for a schema-invalid callout", () => {
    const r = parse('---\nglyphquire-spec: 1\n---\n\n:::callout{type="banana"}\nHi\n:::\n');
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected a recoverable v1 document");
    expect(r.document.children.some((c) => c.type === "invalid-block")).toBe(true);
  });

  it("never throws on arbitrary input", () => {
    expect(() => parse("  not ::: valid {{{")).not.toThrow();
  });

  it("records an INVALID_CHILD diagnostic for a foreign child of tabs and keeps the valid tab", () => {
    const r = parse(
      '---\nglyphquire-spec: 1\n---\n\n:::tabs\nStray paragraph.\n\n:::tab{title="A"}\nHi\n:::\n:::\n',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected a recoverable v1 document");
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
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected a recoverable v1 document");
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
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected a recoverable v1 document");
    const occurrences = r.diagnostics.filter((d) => d.code === "DIRECTIVE_UNKNOWN");
    expect(occurrences).toHaveLength(1);
  });

  it("returns an accepted result with the exact source for valid v1 input", () => {
    const source = "---\nglyphquire-spec: 1\n---\n\n# Hi\n";
    const result = parse(source);

    expect(result.ok).toBe(true);
    expect(result.source).toBe(source);
    expect(result.specVersion).toBe(1);
    expect(result.document).not.toBeNull();
  });

  it("rejects an unsupported future version without manufacturing a v1 document", () => {
    const source = "---\nglyphquire-spec: 2\n---\n\n# Future\n";
    const result = parse(source);

    expect(result.ok).toBe(false);
    expect(result.document).toBeNull();
    expect(result.source).toBe(source);
    expect(result.specVersion).toBe(2);
    expect(result.diagnostics.some((d) => d.code === "UNSUPPORTED_SPEC_VERSION")).toBe(true);
  });

  it("rejects a malformed top-level block directive attribute opener", () => {
    const source = '---\nglyphquire-spec: 1\n---\n\n:::callout{type="warning"\nHi\n:::\n';
    const result = parse(source);

    expect(result.ok).toBe(false);
    expect(result.document).toBeNull();
    expect(result.source).toBe(source);
    expect(result.diagnostics.some((d) => d.code === "DIRECTIVE_SYNTAX_INVALID")).toBe(true);
  });

  it.each([
    ["ordinary colon prose", "::: ordinary prose\n"],
    ["escaped opener", '\\:::callout{type="warning"\n'],
    ["closing-fence-like line", ":::\n"],
    ["blockquote text", '> :::callout{type="warning"\n> nested\n'],
    ["list text", '- :::callout{type="warning"\n'],
    ["fenced code", '```\n:::callout{type="warning"\n```\n'],
    ["inline code", '`:::callout{type="warning"`\n'],
  ])("accepts %s without classifying it as a malformed directive", (_label, body) => {
    const source = `---\nglyphquire-spec: 1\n---\n\n${body}`;
    const result = parse(source);

    expect(result.ok).toBe(true);
    expect(result.source).toBe(source);
    expect(result.diagnostics.some((d) => d.code === "DIRECTIVE_SYNTAX_INVALID")).toBe(false);
  });

  it("accepts multiline inline code containing a directive-looking source line", () => {
    const source = '---\nglyphquire-spec: 1\n---\n\n`prefix\n:::callout{type="warning"\nsuffix`\n';
    const result = parse(source);

    expect(result.ok).toBe(true);
    expect(result.source).toBe(source);
    expect(result.diagnostics.some((d) => d.code === "DIRECTIVE_SYNTAX_INVALID")).toBe(false);
  });

  it("rejects a malformed opener on a bare-CR continuation line", () => {
    const source = ["---", "glyphquire-spec: 1", "---", "", "plain", ':::callout{type="warning"', "body", ""].join("\r");
    const result = parse(source);

    expect(result.ok).toBe(false);
    expect(result.document).toBeNull();
    expect(result.source).toBe(source);
    expect(result.diagnostics.some((d) => d.code === "DIRECTIVE_SYNTAX_INVALID")).toBe(true);
  });

  it("retains exact legacy source and removes only the expected missing-version warning", () => {
    const source = "# Legacy  \r\n\r\nBody with trailing spaces  \r\n";
    const result = importLegacy(source, 1);

    expect(result.ok).toBe(true);
    expect(result.source).toBe(source);
    expect(result.specVersion).toBe(1);
    expect(result.diagnostics.some((d) => d.code === "SPEC_VERSION_MISSING")).toBe(false);
  });

  it("retains unrelated diagnostics when importing versionless legacy input", () => {
    const source = ':::future{x="1"}\nlegacy\n:::\n';
    const result = importLegacy(source, 1);

    expect(result.ok).toBe(true);
    expect(result.diagnostics.map((d) => d.code)).toContain("DIRECTIVE_UNKNOWN");
    expect(result.diagnostics.map((d) => d.code)).not.toContain("SPEC_VERSION_MISSING");
  });

  it.each([
    [0, "SPEC_VERSION_INVALID"],
    [1.5, "SPEC_VERSION_INVALID"],
    [2, "UNSUPPORTED_SPEC_VERSION"],
  ])("rejects an invalid legacy assumed version %s", (assumedVersion, code) => {
    const source = "# Legacy\n";
    const result = importLegacy(source, assumedVersion);

    expect(result.ok).toBe(false);
    expect(result.document).toBeNull();
    expect(result.source).toBe(source);
    expect(result.diagnostics.some((d) => d.code === code)).toBe(true);
  });

  it("turns an injected MDAST parser exception into a deterministic rejected result", () => {
    const source = "---\nglyphquire-spec: 1\n---\n\n# Broken parser\n";
    const result = parseWithMdastParser(source, () => {
      throw new Error("nondeterministic parser detail");
    });

    expect(result).toStrictEqual({
      ok: false,
      document: null,
      source,
      diagnostics: [
        {
          code: "DIRECTIVE_SYNTAX_INVALID",
          severity: "error",
          message: "Markdown could not be parsed safely.",
        },
      ],
      specVersion: null,
    });
  });
});
