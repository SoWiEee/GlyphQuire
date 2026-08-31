import { h, defineComponent } from "vue";
import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import SplitEditor from "./SplitEditor.vue";

function paneStub(name: string) {
  return defineComponent({
    name,
    props: {
      markdown: { type: String, required: true },
      readOnly: { type: Boolean, required: true },
      outlineActive: { type: Boolean, required: true },
    },
    emits: ["slash-command"],
    setup(_, { expose }) {
      const applyToolbarAction = vi.fn(() => true);
      const replaceRange = vi.fn(() => true);
      expose({ applyToolbarAction, replaceRange });
      return { applyToolbarAction, replaceRange };
    },
    render() {
      return h("div", { "data-testid": name });
    },
  });
}

const SourcePane = paneStub("SourceEditor");
const VisualPane = paneStub("VisualEditor");

const props = {
  sourceMarkdown: "source",
  sourceReadOnly: false,
  visualMarkdown: "visual",
  visualReadOnly: true,
};

describe("SplitEditor", () => {
  it("marks the split editor and each pane with semantic surface hooks", () => {
    const wrapper = mount(SplitEditor, {
      props,
      global: { stubs: { SourceEditor: SourcePane, VisualEditor: VisualPane } },
    });

    expect(wrapper.get('[data-testid="split-editor"]').classes()).toContain("gq-split-editor");
    expect(wrapper.get('[aria-label="Source pane"]').classes()).toContain("gq-editor-pane");
    expect(wrapper.get('[aria-label="Visual pane"]').classes()).toContain("gq-editor-pane");
  });

  it("delegates toolbar and replacement actions to the writable pane", () => {
    const wrapper = mount(SplitEditor, {
      props,
      global: { stubs: { SourceEditor: SourcePane, VisualEditor: VisualPane } },
    });
    const source = wrapper.findComponent(SourcePane).vm as unknown as {
      applyToolbarAction: ReturnType<typeof vi.fn>;
      replaceRange: ReturnType<typeof vi.fn>;
    };
    const handle = wrapper.vm as unknown as {
      applyToolbarAction(action: "bold"): boolean;
      replaceRange(from: number, to: number, insert: string, cursorOffset: number): boolean;
    };

    expect(handle.applyToolbarAction("bold")).toBe(true);
    expect(handle.replaceRange(1, 2, "## ", 3)).toBe(true);
    expect(source.applyToolbarAction).toHaveBeenCalledWith("bold");
    expect(source.replaceRange).toHaveBeenCalledWith(1, 2, "## ", 3);
  });

  it("forwards slash discovery and refuses actions when both panes are locked", async () => {
    const wrapper = mount(SplitEditor, {
      props: { ...props, sourceReadOnly: true, visualReadOnly: true },
      global: { stubs: { SourceEditor: SourcePane, VisualEditor: VisualPane } },
    });
    const request = { query: "", slashRange: { from: 2, to: 3 } };
    wrapper.findComponent(VisualPane).vm.$emit("slash-command", request);
    expect(wrapper.emitted("slash-command")).toEqual([[request]]);
    const handle = wrapper.vm as unknown as {
      applyToolbarAction(action: "bold"): boolean;
      replaceRange(from: number, to: number, insert: string, cursorOffset: number): boolean;
    };
    expect(handle.applyToolbarAction("bold")).toBe(false);
    expect(handle.replaceRange(2, 3, "## ", 3)).toBe(false);
  });
});
