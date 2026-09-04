import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import { describe, expect, it } from "vitest";
import ContextRail from "./ContextRail.vue";
import TopBar from "./TopBar.vue";

const baseProps = {
  open: true,
  compact: false,
  noteTitle: "Field notes",
  workspaceAvailable: true,
  noteAvailable: true,
  outline: [],
  currentRevision: 2,
};

describe("ContextRail", () => {
  it("renders a context rail only when requested and emits tool actions", async () => {
    const wrapper = mount(ContextRail, { props: baseProps });

    await wrapper.get('button[aria-label="開啟版本歷史"]').trigger("click");

    expect(wrapper.emitted("action")?.[0]).toEqual(["history"]);
  });

  it("uses a dialog sheet below the compact breakpoint", () => {
    const wrapper = mount(ContextRail, {
      props: { ...baseProps, compact: true },
    });

    expect(wrapper.get('[data-testid="context-rail"]').attributes("aria-label")).toBe(
      "工具面板",
    );
  });

  it("renders outline entries and disables note tools without a note", () => {
    const wrapper = mount(ContextRail, {
      props: {
        ...baseProps,
        compact: true,
        noteTitle: null,
        noteAvailable: false,
        outline: [{ id: "h1", depth: 1 as const, label: "Research" }],
        currentRevision: null,
      },
    });

    expect(wrapper.get('[data-outline-entry-id="h1"]').text()).toContain("Research");
    expect(wrapper.get('button[aria-label="開啟版本歷史"]').isDisabled()).toBe(true);
    expect(
      wrapper.get('button[aria-label="開啟版本歷史"]').attributes("aria-describedby"),
    ).toBeTruthy();
  });

  it("uses a modal dialog, scrim, and focus trap in compact mode", () => {
    const wrapper = mount(ContextRail, {
      props: { ...baseProps, compact: true },
    });

    expect(wrapper.get('[role="dialog"][aria-modal="true"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="context-rail-scrim"]').attributes("aria-hidden")).toBe(
      "true",
    );
  });

  it("restores focus to the Context button after Escape closes the sheet", async () => {
    const opener = document.createElement("button");
    opener.setAttribute("aria-label", "Open context tools");
    document.body.append(opener);
    opener.focus();

    const wrapper = mount(ContextRail, {
      props: { ...baseProps, compact: true },
    });
    await wrapper.get('[role="dialog"]').trigger("keydown", { key: "Escape" });
    await wrapper.setProps({ open: false });
    await nextTick();

    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it("keeps account menu actions keyboard reachable and side-effect free", async () => {
    const wrapper = mount(TopBar, {
      props: { noteTitle: "Field notes", mode: "source", accountLabel: "AL" },
    });

    await wrapper.get('button[aria-label="開啟帳號選單"]').trigger("click");
    await wrapper.get('button[aria-label="登出"]').trigger("click");

    expect(wrapper.emitted("account-action")?.[0]).toEqual(["sign-out"]);
  });
});
