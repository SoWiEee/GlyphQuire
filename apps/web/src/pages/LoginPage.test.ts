import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import LoginPage from "./LoginPage.vue";
import { useSessionStore } from "../stores/session.js";

const push = vi.fn();
vi.mock("vue-router", () => ({
  RouterLink: { template: "<a><slot /></a>" },
  useRouter: () => ({ push }),
}));

describe("LoginPage", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    push.mockReset();
  });

  it("signs in and routes to the workspace on success", async () => {
    const store = useSessionStore();
    store.signIn = vi.fn(async () => {
      store.personalWorkspaceId = "22222222-2222-4222-8222-222222222222";
      return true;
    });
    const wrapper = mount(LoginPage);
    await wrapper.find("#email").setValue("a@b.co");
    await wrapper.find("#password").setValue("pw");
    await wrapper.find("form").trigger("submit.prevent");
    await Promise.resolve();
    expect(store.signIn).toHaveBeenCalledWith("a@b.co", "pw");
    expect(push).toHaveBeenCalledWith("/workspace/22222222-2222-4222-8222-222222222222");
  });

  it("shows the store error and does not route on failure", async () => {
    const store = useSessionStore();
    store.signIn = vi.fn(async () => {
      store.error = "Invalid credentials";
      return false;
    });
    const wrapper = mount(LoginPage);
    await wrapper.find("#email").setValue("a@b.co");
    await wrapper.find("#password").setValue("wrong");
    await wrapper.find("form").trigger("submit.prevent");
    await Promise.resolve();
    expect(push).not.toHaveBeenCalled();
    expect(wrapper.find('[role="alert"]').text()).toContain("Invalid credentials");
  });
});
