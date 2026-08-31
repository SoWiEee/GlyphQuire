import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import StatusIndicator from "./StatusIndicator.vue";

describe("StatusIndicator", () => {
  it("does not rely on color alone", () => {
    const wrapper = mount(StatusIndicator, { props: { state: "offline" } });

    expect(wrapper.get('[role="status"]').text()).toContain("Offline");
    expect(wrapper.get('[data-status-icon="offline"]').attributes("aria-hidden")).toBe("true");
  });

  it("maps an autosave error to Save failed instead of Saved", () => {
    const wrapper = mount(StatusIndicator, { props: { state: "error" } });

    expect(wrapper.get('[role="status"]').text()).toContain("Save failed");
  });
});
