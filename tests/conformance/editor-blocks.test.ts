// @vitest-environment happy-dom

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDocumentEngine,
  semanticNormalize,
  type NotebookDocument,
} from "../../packages/document-engine/src/index.js";
import { MilkdownVisualAdapter } from "../../apps/web/src/editors/visual/MilkdownVisualAdapter.js";

const engine = createDocumentEngine();
const fixturesRoot = join(process.cwd(), "packages/document-engine/tests/fixtures");
const groups = ["callout", "sticky", "toggle", "tabs", "columns", "canvas", "p5"] as const;

interface FixtureCase {
  readonly label: string;
  readonly input: string;
}

function fixtureCases(): FixtureCase[] {
  return groups.flatMap((group) => {
    const groupDir = join(fixturesRoot, group);
    return readdirSync(groupDir)
      .filter((name) => statSync(join(groupDir, name)).isDirectory())
      .map((name) => ({
        label: `${group}/${name}`,
        input: readFileSync(join(groupDir, name, "input.md"), "utf8"),
      }));
  });
}

interface DirectiveShape {
  readonly type: string;
  readonly fields: unknown;
  readonly childTypes: readonly string[];
}

function directiveShapes(document: NotebookDocument): DirectiveShape[] {
  const shapes: DirectiveShape[] = [];
  const normalized = semanticNormalize(document) as unknown;

  const visit = (value: unknown): void => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return;
    const node = value as Record<string, unknown>;
    const type = typeof node.type === "string" ? node.type : "";
    if (
      [
        "callout",
        "sticky",
        "toggle",
        "tabs",
        "tab",
        "columns",
        "column",
        "runtime",
        "unknown-directive",
        "invalid-block",
        "textDirective",
      ].includes(type)
    ) {
      const children = Array.isArray(node.children) ? node.children : [];
      const childTypes = children.flatMap((child) => {
        if (child === null || typeof child !== "object" || Array.isArray(child)) return [];
        const childType = (child as Record<string, unknown>).type;
        return typeof childType === "string" ? [childType] : [];
      });
      const fields = { ...node };
      delete fields.children;
      shapes.push({ type, fields, childTypes });
    }

    if (Array.isArray(node.children)) {
      for (const child of node.children) visit(child);
    }
  };

  visit(normalized);
  return shapes;
}

function markdownDocument(body: string): string {
  return ["---", "glyphquire-spec: 1", "---", "", body, ""].join("\n");
}

const inlineDirectiveCases = [
  {
    label: "paragraph",
    markdown: markdownDocument('A :future[child]{a="1"} B'),
  },
  {
    label: "heading",
    markdown: markdownDocument('# A :future[child]{a="1"} B'),
  },
  {
    label: "list paragraph",
    markdown: markdownDocument('- A :future[child]{a="1"} B'),
  },
  {
    label: "table cell",
    markdown: markdownDocument(["| Cell |", "| --- |", '| A :future[child]{a="1"} B |'].join("\n")),
  },
  {
    label: "link-adjacent",
    markdown: markdownDocument(
      '[left](https://safe.example):future[child]{a="1"}[right](https://safe.example)',
    ),
  },
  {
    label: "multiple and nested",
    markdown: markdownDocument(
      ':one[first]{a="1"} :outer[before :inner[child]{b="2"} after]{extra="yes"}',
    ),
  },
  {
    label: "duplicate and unknown attributes",
    markdown: markdownDocument(':future[child]{a="1" a="2" extra="yes"}'),
  },
  {
    label: "accepted malformed attribute tail",
    markdown: markdownDocument('A :future[child]{a="1" B'),
  },
  {
    label: "accepted known directive used as hostile phrasing",
    markdown: markdownDocument(
      ':callout[**bold** <svg onload=boom()>]{type="critical" handler="javascript:boom"}',
    ),
  },
] as const;

const leafDirectiveCases = [
  {
    label: "top-level leaf",
    markdown: markdownDocument('::future{a="1" extra="yes"}'),
  },
  {
    label: "leaf nested in a list item",
    markdown: markdownDocument(["- item", "", '  ::future{a="1" extra="yes"}'].join("\n")),
  },
] as const;

describe("visual editor block conformance", () => {
  const adapter = new MilkdownVisualAdapter();
  const host = document.createElement("div");

  beforeAll(async () => {
    document.body.appendChild(host);
    adapter.mount(host);
    await adapter.whenReady();
  });

  afterAll(() => adapter.destroy());

  for (const fixtureCase of fixtureCases()) {
    it(`preserves semantic kind, attributes, and children through Milkdown: ${fixtureCase.label}`, () => {
      const before = engine.parse(fixtureCase.input);
      expect(before.ok).toBe(true);
      if (!before.ok) throw new Error(`expected accepted fixture ${fixtureCase.label}`);

      adapter.setMarkdown(fixtureCase.input);
      const output = adapter.getMarkdown();
      const after = engine.parse(output);
      expect(after.ok).toBe(true);
      if (!after.ok) throw new Error(`visual output rejected for ${fixtureCase.label}`);

      expect(semanticNormalize(after.document)).toEqual(semanticNormalize(before.document));
      expect(directiveShapes(after.document)).toEqual(directiveShapes(before.document));
    });
  }

  it.each(inlineDirectiveCases)(
    "preserves accepted inline directive kind, fields, and phrasing in $label",
    ({ markdown }) => {
      const before = engine.parse(markdown);
      expect(before.ok).toBe(true);
      if (!before.ok) throw new Error("expected accepted inline directive Markdown");

      adapter.setMarkdown(markdown);
      const after = engine.parse(adapter.getMarkdown());
      expect(after.ok).toBe(true);
      if (!after.ok) throw new Error("expected accepted visual inline directive output");

      expect(semanticNormalize(after.document)).toEqual(semanticNormalize(before.document));
      expect(directiveShapes(after.document)).toEqual(directiveShapes(before.document));
      expect(host.querySelector("[data-glyphquire-inline-warning]")).not.toBeNull();
      expect(host.querySelector("script, svg, iframe, [onerror], [onload]")).toBeNull();
    },
  );

  it.each(leafDirectiveCases)(
    "keeps unknown $label paired as a lossless block warning",
    ({ markdown }) => {
      const before = engine.parse(markdown);
      expect(before.ok).toBe(true);
      if (!before.ok) throw new Error("expected accepted leaf directive Markdown");

      adapter.setMarkdown(markdown);
      const after = engine.parse(adapter.getMarkdown());
      expect(after.ok).toBe(true);
      if (!after.ok) throw new Error("expected accepted visual leaf directive output");

      expect(semanticNormalize(after.document)).toEqual(semanticNormalize(before.document));
      expect(directiveShapes(after.document)).toEqual(directiveShapes(before.document));
      expect(host.querySelector("[data-glyphquire-warning]")).not.toBeNull();
    },
  );

  it("keeps inline annotations independent from unknown and invalid block pairing", () => {
    const markdown = markdownDocument(
      [
        'Before :inline-one[first]{a="1"}.',
        "",
        ':::future-block{block="one"}',
        "Unknown container child.",
        ":::",
        "",
        'Between :inline-two[second]{b="2"}.',
        "",
        '::future-leaf{leaf="one"}',
        "",
        ':::callout{type="critical" extra="preserved"}',
        "Invalid callout child.",
        ":::",
      ].join("\n"),
    );
    const before = engine.parse(markdown);
    expect(before.ok).toBe(true);
    if (!before.ok) throw new Error("expected accepted mixed directive Markdown");

    adapter.setMarkdown(markdown);
    const after = engine.parse(adapter.getMarkdown());
    expect(after.ok).toBe(true);
    if (!after.ok) throw new Error("expected accepted mixed visual directive output");

    expect(semanticNormalize(after.document)).toEqual(semanticNormalize(before.document));
    expect(directiveShapes(after.document)).toEqual(directiveShapes(before.document));
    expect(host.querySelectorAll("[data-glyphquire-inline-warning]")).toHaveLength(2);
    expect(host.querySelectorAll("[data-glyphquire-warning]")).toHaveLength(3);
  });

  it.each([
    {
      label: "unknown container directive",
      markdown: [
        "---",
        "glyphquire-spec: 1",
        "---",
        "",
        ':::future-widget{alpha="1" payload="<svg onload=boom()>"}',
        "Unknown **child** content.",
        ":::",
        "",
      ].join("\n"),
    },
    {
      label: "raw HTML invalid block",
      markdown: [
        "---",
        "glyphquire-spec: 1",
        "---",
        "",
        '<img src="javascript:alert(1)" onerror="globalThis.EXECUTED=true">',
        "",
      ].join("\n"),
    },
  ])("losslessly preserves $label as an escaped visual boundary", ({ markdown }) => {
    const before = engine.parse(markdown);
    expect(before.ok).toBe(true);
    if (!before.ok) throw new Error("expected a recoverable boundary");

    adapter.setMarkdown(markdown);
    const after = engine.parse(adapter.getMarkdown());
    expect(after.ok).toBe(true);
    if (!after.ok) throw new Error("expected visual boundary output");

    expect(semanticNormalize(after.document)).toEqual(semanticNormalize(before.document));
    expect(host.querySelector("[data-glyphquire-warning]")).not.toBeNull();
    expect(host.querySelector("script, svg, iframe, [onerror], [onload]")).toBeNull();
  });
});
