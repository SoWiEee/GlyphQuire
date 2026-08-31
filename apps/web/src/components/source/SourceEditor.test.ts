import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import SourceEditor from "./SourceEditor.vue";
import { CodeMirrorSourceAdapter } from "../../editors/source/CodeMirrorSourceAdapter.js";
import { EditorView } from "@codemirror/view";

describe("SourceEditor", () => {
  afterEach(() => vi.restoreAllMocks());

  it("mounts fail-safe read-only when no authority explicitly grants writes", () => {
    const wrapper = mount(SourceEditor, { props: { markdown: "private draft" } });

    expect(wrapper.get(".cm-content").attributes("contenteditable")).toBe("false");

    wrapper.unmount();
  });

  it("becomes editable only when readOnly is explicitly false", () => {
    const wrapper = mount(SourceEditor, {
      props: { markdown: "authorized draft", readOnly: false },
    });

    expect(wrapper.get(".cm-content").attributes("contenteditable")).toBe("true");

    wrapper.unmount();
  });

  it("fails closed when authoritative Markdown cannot be projected", () => {
    vi.spyOn(CodeMirrorSourceAdapter.prototype, "setMarkdown").mockImplementationOnce(() => {
      throw new Error("raw projection failure");
    });

    const wrapper = mount(SourceEditor, {
      props: { markdown: "SERVER-AUTHORITATIVE", readOnly: false },
    });

    expect(wrapper.get(".cm-content").attributes("contenteditable")).toBe("false");
    expect(wrapper.emitted("update:markdown")).toBeUndefined();
    wrapper.unmount();
  });

  it("exposes editor-owned outline anchors and routes toolbar formatting", () => {
    const wrapper = mount(SourceEditor, {
      props: { markdown: "# Research", readOnly: false },
    });
    expect(wrapper.get('[data-editor-outline-id="research"]').element).toBeTruthy();
    const handle = wrapper.vm as unknown as { applyToolbarAction(action: "bold"): boolean };
    expect(handle.applyToolbarAction("bold")).toBe(true);
    expect(wrapper.emitted("update:markdown")?.at(-1)?.[0]).toBe("**text**# Research");
    wrapper.unmount();
  });

  it("emits slash discovery for user insertion but not a projected slash", async () => {
    const wrapper = mount(SourceEditor, { props: { markdown: "\n", readOnly: false } });
    const view = EditorView.findFromDOM(wrapper.get(".cm-editor").element as HTMLElement);
    view?.dispatch({ changes: { from: 0, insert: "/" } });
    expect(wrapper.emitted("slash-command")).toEqual([
      [{ query: "", slashRange: { from: 0, to: 1 } }],
    ]);

    await wrapper.setProps({ markdown: "/" });
    expect(wrapper.emitted("slash-command")).toHaveLength(1);
    wrapper.unmount();
  });
});
