// @vitest-environment happy-dom

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDocumentEngine,
  semanticNormalize,
  type BlockNode,
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

  const visit = (node: BlockNode): void => {
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
      ].includes(node.type)
    ) {
      const normalized = semanticNormalize({ type: "document", specVersion: 1, children: [node] });
      const normalizedNode = normalized.children[0] as BlockNode;
      const childTypes =
        "children" in normalizedNode ? normalizedNode.children.map((child) => child.type) : [];
      const fields = { ...normalizedNode } as Record<string, unknown>;
      delete fields.children;
      shapes.push({ type: node.type, fields, childTypes });
    }

    if ("children" in node) {
      for (const child of node.children) {
        if ("type" in child && child.type !== "tableRow" && child.type !== "tableCell") {
          visit(child as BlockNode);
        }
      }
    }
  };

  for (const child of document.children) visit(child);
  return shapes;
}

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
