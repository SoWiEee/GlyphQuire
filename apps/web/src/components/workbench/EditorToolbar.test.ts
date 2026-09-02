import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import EditorToolbar from "./EditorToolbar.vue";
import { applyToolbarAction, BLOCK_COMMANDS } from "./markdown-format.js";

describe("EditorToolbar", () => {
  it("exposes common actions with names and disables them when read-only", () => {
    const wrapper = mount(EditorToolbar, { props: { disabled: true } });

    expect(wrapper.get('button[aria-label="Bold"]').attributes("disabled")).toBeDefined();
    expect(wrapper.find('button[aria-label="Open command palette"]').exists()).toBe(false);
  });

  it("formats selected inline ranges and inserts deterministic placeholders at a cursor", () => {
    expect(applyToolbarAction("hello", "bold", { anchor: 1, head: 4 })).toEqual({
      markdown: "h**ell**o",
      selection: { anchor: 1, head: 8 },
    });
    expect(applyToolbarAction("hello", "italic", { anchor: 1, head: 4 }).markdown).toBe("h*ell*o");
    expect(applyToolbarAction("hello", "link", { anchor: 1, head: 4 }).markdown).toBe(
      "h[ell](https://example.com)o",
    );
    expect(applyToolbarAction("hello", "bold", { anchor: 2, head: 2 }).markdown).toBe(
      "he**text**llo",
    );
  });

  it("expands line actions to covered lines without consuming a following paragraph", () => {
    expect(applyToolbarAction("one\ntwo\nthree", "heading", { anchor: 2, head: 5 })).toEqual({
      markdown: "## one\n## two\nthree",
      selection: { anchor: 0, head: 13 },
    });
    expect(applyToolbarAction("one\ntwo\n", "bulletList", { anchor: 0, head: 3 }).markdown).toBe(
      "- one\ntwo\n",
    );
    expect(applyToolbarAction("😀 text", "bold", { anchor: 2, head: 2 }).markdown).toBe(
      "😀**text** text",
    );
  });

  it("keeps the explicit block catalog independent from executable commands", () => {
    expect(BLOCK_COMMANDS).toHaveLength(4);
    expect(BLOCK_COMMANDS[3].markdown).toBe(["```", "", "```"].join(String.fromCharCode(10)));
    expect(BLOCK_COMMANDS[3].cursorOffset).toBe(4);
    expect("run" in BLOCK_COMMANDS[3]).toBe(false);
  });
});
