import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import SourceEditor from "./SourceEditor.vue";

describe("SourceEditor", () => {
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
});
