import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import ExplorerPane from "./ExplorerPane.vue";

describe("ExplorerPane", () => {
  it("marks the active note with a semantic state hook", () => {
    const wrapper = mount(ExplorerPane, {
      props: {
        notes: [{ id: "field-notes", title: "Field notes", markdown: "# Notes" }],
        activeNoteId: "field-notes",
      },
    });

    const activeNote = wrapper.get('button[aria-current="true"]');
    expect(wrapper.get("nav").classes()).toContain("gq-explorer");
    expect(activeNote.attributes("data-active")).toBe("true");
  });

  it("keeps the explorer focused on note navigation", () => {
    const wrapper = mount(ExplorerPane, {
      props: { notes: [], activeNoteId: null },
    });

    expect(wrapper.find('[aria-label="Search notes"]').exists()).toBe(false);
    expect(wrapper.find('[aria-label="Open shared links"]').exists()).toBe(false);
  });
});
