import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import StatusIndicator from "./StatusIndicator.vue";

describe("StatusIndicator", () => {
  it("does not rely on color alone", () => {
    const wrapper = mount(StatusIndicator, { props: { state: "offline" } });

    expect(wrapper.get('[role="status"]').text()).toContain("離線");
    expect(wrapper.get('[data-status-icon="offline"]').attributes("aria-hidden")).toBe("true");
  });

  it("maps an autosave error to Save failed instead of Saved", () => {
    const wrapper = mount(StatusIndicator, { props: { state: "error" } });

    expect(wrapper.get('[role="status"]').text()).toContain("儲存失敗");
  });

  it("applies a spin class to the saving icon", () => {
    const wrapper = mount(StatusIndicator, { props: { state: "saving" } });

    expect(wrapper.get('[data-status-icon="saving"]').classes()).toContain(
      "gq-status-indicator__icon--spin",
    );
  });

  it("keeps existing status structure intact for saved state", () => {
    const wrapper = mount(StatusIndicator, { props: { state: "saved" } });

    const icon = wrapper.get('[data-status-icon="saved"]');
    expect(icon.attributes("aria-hidden")).toBe("true");
    // No transition into "saved" happened yet, so the pop animation must not play.
    expect(icon.classes()).not.toContain("gq-status-indicator__icon--pop");
    expect(wrapper.get('[role="status"]').text()).toContain("已儲存");
  });

  it("plays the saved pop-in once when transitioning from saving to saved", async () => {
    const wrapper = mount(StatusIndicator, { props: { state: "saving" } });

    await wrapper.setProps({ state: "saved" });

    expect(wrapper.get('[data-status-icon="saved"]').classes()).toContain(
      "gq-status-indicator__icon--pop",
    );
  });
});
