import { config, flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it } from "vitest";
import { nextTick } from "vue";
import Workbench from "./Workbench.vue";

const notes = [
  {
    id: "welcome",
    title: "Welcome",
    markdown: "# Welcome\n\nStart writing.",
  },
];

describe("Workbench accessibility smoke", () => {
  beforeEach(() => {
    const pinia = createPinia();
    setActivePinia(pinia);
    config.global.plugins = [pinia];
  });

  it("supports keyboard navigation across the workbench shell", async () => {
    const wrapper = mount(Workbench, {
      props: { initialNotes: notes },
      attachTo: document.body,
    });
    await flushPromises();

    await wrapper.get('[aria-label="Open command palette"]').trigger("click");
    await nextTick();
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Filter commands");
    await wrapper.get('[aria-label="Filter commands"]').trigger("keydown", { key: "Escape" });
    expect(wrapper.find('[role="dialog"][aria-label="Command palette"]').exists()).toBe(false);

    wrapper.unmount();
  });

  it("keeps workspace actions disabled without identity and forwards account actions", async () => {
    const wrapper = mount(Workbench, {
      props: { initialNotes: notes, accountLabel: "Writer" },
      attachTo: document.body,
    });
    await flushPromises();

    expect(wrapper.get('button[aria-label="Open shared links"]').isDisabled()).toBe(true);

    const accountButton = wrapper.get('button[aria-label="Open account menu"]').element;
    accountButton.focus();
    accountButton.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    // happy-dom does not synthesize a native button click from keydown; this is
    // the browser's default Enter activation represented explicitly in the smoke.
    accountButton.click();
    await nextTick();
    expect(wrapper.get('[role="menu"][aria-label="Account menu"]').exists()).toBe(true);

    const accountMenu = wrapper.get('[role="menu"][aria-label="Account menu"]').element;
    accountMenu.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    await nextTick();
    expect(wrapper.find('[role="menu"][aria-label="Account menu"]').exists()).toBe(false);

    accountButton.focus();
    accountButton.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    accountButton.click();
    await nextTick();
    const signOutButton = wrapper.get('button[aria-label="Sign out"]').element;
    signOutButton.focus();
    signOutButton.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    signOutButton.click();
    await nextTick();
    expect(wrapper.emitted("account-action")).toEqual([["sign-out"]]);

    wrapper.unmount();
  });
});
