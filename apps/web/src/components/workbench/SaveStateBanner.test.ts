import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import SaveStateBanner from "./SaveStateBanner.vue";

describe("SaveStateBanner", () => {
  it("offers retry only for recoverable save failures", () => {
    const wrapper = mount(SaveStateBanner, {
      props: {
        state: "offline",
        message: "Changes are queued locally.",
        canRetry: true,
        canOpenConflict: false,
      },
    });

    expect(wrapper.get('button[aria-label="Retry save"]').exists()).toBe(true);
  });

  it("never offers conflict recovery without a validated page context", () => {
    const wrapper = mount(SaveStateBanner, {
      props: {
        state: "conflict",
        message: "Another version was saved.",
        canRetry: false,
        canOpenConflict: false,
      },
    });

    expect(wrapper.find('button[aria-label="Open conflict recovery"]').exists()).toBe(false);
  });
});
