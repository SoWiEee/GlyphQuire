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

function installButtonKeyboardActivationShim(): () => void {
  const activateButton = (event: Event): void => {
    if (!(event instanceof KeyboardEvent) || event.key !== "Enter") return;
    const target = event.target;
    if (
      event.defaultPrevented ||
      !(target instanceof HTMLButtonElement) ||
      target.disabled ||
      target !== document.activeElement
    ) {
      return;
    }

    // happy-dom dispatches keyboard events but does not implement the browser
    // default action that activates a focused button on Enter.
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  };
  document.addEventListener("keydown", activateButton);
  return () => document.removeEventListener("keydown", activateButton);
}

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

    expect(wrapper.get('button[role="tab"][aria-label="Shared"]').isDisabled()).toBe(true);

    const removeKeyboardActivationShim = installButtonKeyboardActivationShim();
    const accountButton = wrapper.get('button[aria-label="Open account menu"]').element;
    accountButton.focus();
    expect(document.activeElement).toBe(accountButton);
    accountButton.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    await nextTick();
    expect(wrapper.get('[role="menu"][aria-label="Account menu"]').exists()).toBe(true);
    expect(document.activeElement).toBe(wrapper.get('button[aria-label="Sign out"]').element);

    await wrapper.get('button[aria-label="Close menu"]').trigger("click");
    await nextTick();
    expect(wrapper.find('[role="menu"][aria-label="Account menu"]').exists()).toBe(false);
    expect(document.activeElement).toBe(accountButton);

    accountButton.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    await nextTick();
    expect(document.activeElement).toBe(wrapper.get('button[aria-label="Sign out"]').element);

    const signOutButton = wrapper.get('button[aria-label="Sign out"]').element;
    signOutButton.focus();
    expect(document.activeElement).toBe(signOutButton);
    signOutButton.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    await nextTick();
    expect(wrapper.find('[role="menu"][aria-label="Account menu"]').exists()).toBe(false);
    expect(document.activeElement).toBe(accountButton);

    accountButton.focus();
    accountButton.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    await nextTick();
    expect(wrapper.get('[role="menu"][aria-label="Account menu"]').exists()).toBe(true);
    expect(document.activeElement).toBe(wrapper.get('button[aria-label="Sign out"]').element);

    const reopenedSignOutButton = wrapper.get('button[aria-label="Sign out"]').element;
    reopenedSignOutButton.focus();
    expect(document.activeElement).toBe(reopenedSignOutButton);
    reopenedSignOutButton.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    await nextTick();
    expect(wrapper.emitted("account-action")).toEqual([["sign-out"]]);
    expect(document.activeElement).toBe(accountButton);

    removeKeyboardActivationShim();
    wrapper.unmount();
  });
});
