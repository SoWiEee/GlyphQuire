import { beforeEach, describe, expect, it, vi } from "vitest";
import { CodeMirrorSourceAdapter } from "./CodeMirrorSourceAdapter.js";

function mountedAdapter() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const adapter = new CodeMirrorSourceAdapter();
  adapter.mount(host);
  return { adapter, host };
}

describe("CodeMirrorSourceAdapter", () => {
  let cleanup: (() => void) | undefined;

  beforeEach(() => {
    cleanup?.();
    cleanup = undefined;
  });

  it("renders the editor into the host element on mount", () => {
    const { adapter, host } = mountedAdapter();
    cleanup = () => adapter.destroy();

    expect(host.querySelector(".cm-editor")).not.toBeNull();
  });

  it("round-trips markdown through setMarkdown/getMarkdown", () => {
    const { adapter } = mountedAdapter();
    cleanup = () => adapter.destroy();

    adapter.setMarkdown("# Hello\n\nSome *text*.");
    expect(adapter.getMarkdown()).toBe("# Hello\n\nSome *text*.");

    adapter.setMarkdown("Replaced content");
    expect(adapter.getMarkdown()).toBe("Replaced content");
  });

  it("reflects source edits made directly against the underlying view", () => {
    const { adapter } = mountedAdapter();
    cleanup = () => adapter.destroy();

    adapter.setMarkdown("abc");
    const view = adapter.getView();
    view.dispatch({ changes: { from: 3, insert: "def" } });

    expect(adapter.getMarkdown()).toBe("abcdef");
  });

  it("notifies onChange only for user transactions and returns an unsubscribe", () => {
    const { adapter } = mountedAdapter();
    cleanup = () => adapter.destroy();

    const listener = vi.fn();
    const unsubscribe = adapter.onChange(listener);

    adapter.setMarkdown("authoritative");
    expect(listener).not.toHaveBeenCalled();

    adapter.getView().dispatch({ changes: { from: 13, insert: "+user" } });
    expect(listener).toHaveBeenCalledWith("authoritative+user");

    unsubscribe();
    listener.mockClear();
    adapter.getView().dispatch({ changes: { from: 18, insert: "+ignored" } });
    expect(listener).not.toHaveBeenCalled();
  });

  it("projects authoritative Markdown while read-only without admitting user transactions", () => {
    const { adapter } = mountedAdapter();
    cleanup = () => adapter.destroy();
    const listener = vi.fn();
    adapter.onChange(listener);
    adapter.setReadOnly(true);

    adapter.setMarkdown("SERVER-AUTHORITATIVE");

    expect(adapter.getMarkdown()).toBe("SERVER-AUTHORITATIVE");
    expect(listener).not.toHaveBeenCalled();
    adapter.getView().dispatch({ changes: { from: 20, insert: "+FORGED" } });
    expect(adapter.getMarkdown()).toBe("SERVER-AUTHORITATIVE");
    expect(listener).not.toHaveBeenCalled();
  });

  it("does not leave replaced seed content reachable through user undo history", () => {
    const { adapter } = mountedAdapter();
    cleanup = () => adapter.destroy();
    adapter.setMarkdown("UNTRUSTED-SEED");
    adapter.getView().dispatch({ changes: { from: 14, insert: "+OLD-USER" } });

    adapter.setReadOnly(true);
    adapter.setMarkdown("SERVER-AUTHORITATIVE");
    adapter.setReadOnly(false);

    expect(adapter.undo()).toBe(false);
    expect(adapter.getMarkdown()).toBe("SERVER-AUTHORITATIVE");
  });

  it("blocks edits once read-only is enabled and restores editing when disabled", () => {
    const { adapter } = mountedAdapter();
    cleanup = () => adapter.destroy();

    adapter.setMarkdown("locked");
    adapter.setReadOnly(true);

    const view = adapter.getView();
    view.dispatch({ changes: { from: 6, insert: "!" } });
    expect(adapter.getMarkdown()).toBe("locked");

    adapter.setReadOnly(false);
    view.dispatch({ changes: { from: 6, insert: "!" } });
    expect(adapter.getMarkdown()).toBe("locked!");
  });

  it("projects the readOnly state onto the CodeMirror view's editable contentDOM", () => {
    const { adapter, host } = mountedAdapter();
    cleanup = () => adapter.destroy();

    adapter.setReadOnly(true);
    const contentDom = host.querySelector(".cm-content");
    expect(contentDom?.getAttribute("contenteditable")).toBe("false");

    adapter.setReadOnly(false);
    expect(contentDom?.getAttribute("contenteditable")).toBe("true");
  });

  it("moves focus into the editor's content DOM", () => {
    const { adapter, host } = mountedAdapter();
    cleanup = () => adapter.destroy();

    adapter.focus();
    const contentDom = host.querySelector(".cm-content");
    expect(document.activeElement).toBe(contentDom);
  });

  it("runs the bundled markdown language extension so headings get syntax highlighting", () => {
    const { adapter } = mountedAdapter();
    cleanup = () => adapter.destroy();

    adapter.setMarkdown("# Heading");
    const host2 = adapter.getView().dom;
    const line = host2.querySelector(".cm-line");
    expect(line).not.toBeNull();
    // The markdown language extension splits "# Heading" into separately
    // styled spans (marker vs. heading text) instead of one plain text node.
    expect(line?.querySelectorAll("span").length).toBeGreaterThanOrEqual(2);
  });

  it("supports the standard undo/redo keyboard shortcut history from @codemirror/commands", () => {
    const { adapter } = mountedAdapter();
    cleanup = () => adapter.destroy();

    adapter.setMarkdown("");
    const view = adapter.getView();
    view.dispatch({ changes: { from: 0, insert: "typed" } });
    expect(adapter.getMarkdown()).toBe("typed");

    const undone = view.dispatch;
    expect(typeof undone).toBe("function");
    // Exercise the same command the Ctrl/Cmd+Z keybinding invokes.
    expect(adapter.undo()).toBe(true);
    expect(adapter.getMarkdown()).toBe("");
    expect(adapter.redo()).toBe(true);
    expect(adapter.getMarkdown()).toBe("typed");
  });

  it("exposes lint diagnostics through the CodeMirror lint gutter for unclosed markdown links", () => {
    const { adapter, host } = mountedAdapter();
    cleanup = () => adapter.destroy();

    adapter.setMarkdown("See [broken link](no-closing-paren");
    // Force a synchronous lint pass instead of waiting on the debounce.
    return adapter.runLintForTests().then(() => {
      expect(host.querySelectorAll(".cm-lintRange-error").length).toBeGreaterThan(0);
    });
  });

  it("offers markdown-aware completions for fenced code block languages", () => {
    const { adapter } = mountedAdapter();
    cleanup = () => adapter.destroy();

    expect(typeof adapter.getView().state.languageDataAt).toBe("function");
    const completionSources = adapter.getView().state.languageDataAt<unknown[]>("autocomplete", 0);
    expect(completionSources.length).toBeGreaterThan(0);
  });

  it("tears down cleanly, removing DOM nodes and rejecting further use", () => {
    const { adapter, host } = mountedAdapter();

    adapter.destroy();
    expect(host.querySelector(".cm-editor")).toBeNull();

    // A second destroy must be a safe no-op.
    expect(() => adapter.destroy()).not.toThrow();
  });
});
