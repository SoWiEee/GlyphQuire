import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import ExplorerPane from "./ExplorerPane.vue";

describe("ExplorerPane", () => {
  it("marks the active note with a semantic state hook", () => {
    const wrapper = mount(ExplorerPane, {
      props: {
        notes: [{ id: "field-notes", title: "Field notes", markdown: "# Notes" }],
        activeNoteId: "field-notes",
        workspaceAvailable: true,
      },
    });

    const activeNote = wrapper.get('button[aria-current="true"]');
    expect(wrapper.get("nav").classes()).toContain("gq-explorer");
    expect(activeNote.attributes("data-active")).toBe("true");
  });

  it("exposes workspace search and shared links as explicit Explorer actions", async () => {
    const wrapper = mount(ExplorerPane, {
      props: { notes: [], activeNoteId: null, workspaceAvailable: true },
    });

    await wrapper.get('button[aria-label="Search notes"]').trigger("click");
    await wrapper.get('button[aria-label="Open shared links"]').trigger("click");

    expect(wrapper.emitted("search")).toHaveLength(1);
    expect(wrapper.emitted("shared-links")).toHaveLength(1);
  });

  it("disables workspace actions when no workspace is available", () => {
    const wrapper = mount(ExplorerPane, {
      props: { notes: [], activeNoteId: null, workspaceAvailable: false },
    });

    for (const label of ["Search notes", "Open shared links"]) {
      const button = wrapper.get(`button[aria-label="${label}"]`);
      expect(button.isDisabled()).toBe(true);
      expect(button.attributes("aria-describedby")).toBeTruthy();
    }
  });
});
