import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import EditorTabs from "./EditorTabs.vue";

const NOTE_ID = "44444444-4444-4444-8444-444444444444";
const OTHER_NOTE_ID = "55555555-5555-4555-8555-555555555555";

const tabs = [
  { id: NOTE_ID, title: "Field notes", markdown: "# Notes" },
  { id: OTHER_NOTE_ID, title: "Other note", markdown: "# Other" },
];

describe("EditorTabs", () => {
  it("shows no unsaved dot when dirtyTabIds is empty", () => {
    const wrapper = mount(EditorTabs, {
      props: { tabs, activeTabId: NOTE_ID },
    });

    expect(wrapper.find(".gq-editor-tabs__dirty-dot").exists()).toBe(false);
  });

  it("shows an unsaved dot with an accessible label on a dirty tab", () => {
    const wrapper = mount(EditorTabs, {
      props: { tabs, activeTabId: NOTE_ID, dirtyTabIds: [NOTE_ID] },
    });

    const activeTab = wrapper.get('[role="tab"][aria-selected="true"]');
    const dot = activeTab.get(".gq-editor-tabs__dirty-dot");
    expect(dot.attributes("aria-label")).toBe("unsaved changes");

    const otherTab = wrapper
      .findAll('[role="tab"]')
      .find((tab) => tab.attributes("aria-selected") === "false");
    expect(otherTab?.find(".gq-editor-tabs__dirty-dot").exists()).toBe(false);
  });
});
