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

    await wrapper.get('[aria-label="開啟命令面板"]').trigger("click");
    await nextTick();
    expect(document.activeElement?.getAttribute("aria-label")).toBe("篩選命令");
    await wrapper.get('[aria-label="篩選命令"]').trigger("keydown", { key: "Escape" });
    expect(wrapper.find('[role="dialog"][aria-label="命令面板"]').exists()).toBe(false);

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
    const accountButton = wrapper.get('button[aria-label="開啟帳號選單"]').element;
    accountButton.focus();
    expect(document.activeElement).toBe(accountButton);
    accountButton.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    await nextTick();
    expect(wrapper.get('[role="menu"][aria-label="帳號選單"]').exists()).toBe(true);
    expect(document.activeElement).toBe(wrapper.get('button[aria-label="登出"]').element);

    await wrapper.get('button[aria-label="關閉選單"]').trigger("click");
    await nextTick();
    expect(wrapper.find('[role="menu"][aria-label="帳號選單"]').exists()).toBe(false);
    expect(document.activeElement).toBe(accountButton);

    accountButton.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    await nextTick();
    expect(document.activeElement).toBe(wrapper.get('button[aria-label="登出"]').element);

    const signOutButton = wrapper.get('button[aria-label="登出"]').element;
    signOutButton.focus();
    expect(document.activeElement).toBe(signOutButton);
    signOutButton.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    await nextTick();
    expect(wrapper.find('[role="menu"][aria-label="帳號選單"]').exists()).toBe(false);
    expect(document.activeElement).toBe(accountButton);

    accountButton.focus();
    accountButton.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    await nextTick();
    expect(wrapper.get('[role="menu"][aria-label="帳號選單"]').exists()).toBe(true);
    expect(document.activeElement).toBe(wrapper.get('button[aria-label="登出"]').element);

    const reopenedSignOutButton = wrapper.get('button[aria-label="登出"]').element;
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
