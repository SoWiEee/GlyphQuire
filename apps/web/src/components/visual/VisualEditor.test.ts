import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import VisualEditor from "./VisualEditor.vue";
import { MilkdownVisualAdapter } from "../../editors/visual/MilkdownVisualAdapter.js";

const markdown = ["---", "glyphquire-spec: 1", "---", "", "# Research", "", "Body", ""].join("\n");

describe("VisualEditor", () => {
  afterEach(() => vi.restoreAllMocks());

  it("exposes a paper-canvas surface hook and locked state marker", () => {
    const wrapper = mount(VisualEditor, { props: { markdown } });

    const surface = wrapper.get('[data-testid="visual-editor-host"]');
    expect(surface.classes()).toContain("gq-editor-surface");
    expect(surface.attributes("data-read-only")).toBe("true");

    wrapper.unmount();
  });

  it("renders canonical heading anchors on the visual surface", async () => {
    const wrapper = mount(VisualEditor, { props: { markdown } });
    await flushPromises();
    expect(wrapper.get('[data-editor-outline-id="research"]').element.tagName).toMatch(/^H1$/i);
    expect(wrapper.find('[data-outline-entry-id="research"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("exposes toolbar and exact-range operations through the Milkdown adapter", async () => {
    const apply = vi
      .spyOn(MilkdownVisualAdapter.prototype, "applyVisualToolbarAction")
      .mockReturnValue(true);
    const replace = vi.spyOn(MilkdownVisualAdapter.prototype, "replaceRange").mockReturnValue(true);
    const wrapper = mount(VisualEditor, { props: { markdown, readOnly: false } });
    await flushPromises();
    const handle = wrapper.vm as unknown as {
      applyToolbarAction(action: "bold"): boolean;
      replaceRange(from: number, to: number, insert: string, cursorOffset: number): boolean;
    };

    expect(handle.applyToolbarAction("bold")).toBe(true);
    expect(apply).toHaveBeenCalledWith("bold");
    expect(handle.replaceRange(8, 9, "## ", 3)).toBe(true);
    expect(replace).toHaveBeenCalledWith(8, 9, "## ", 3);
    wrapper.unmount();
  });
});
