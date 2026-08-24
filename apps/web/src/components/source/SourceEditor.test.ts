import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import SourceEditor from "./SourceEditor.vue";
import { CodeMirrorSourceAdapter } from "../../editors/source/CodeMirrorSourceAdapter.js";

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
});
