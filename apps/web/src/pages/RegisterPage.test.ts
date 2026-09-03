import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import RegisterPage from "./RegisterPage.vue";
import { useSessionStore } from "../stores/session.js";

const push = vi.fn();
vi.mock("vue-router", () => ({
  RouterLink: { template: "<a><slot /></a>" },
  useRouter: () => ({ push }),
}));

describe("RegisterPage", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    push.mockReset();
  });

  it("signs up and routes to the workspace on success", async () => {
    const store = useSessionStore();
    store.signUp = vi.fn(async () => {
      store.personalWorkspaceId = "22222222-2222-4222-8222-222222222222";
      return true;
    });
    const wrapper = mount(RegisterPage);
    await wrapper.find("#name").setValue("Ada");
    await wrapper.find("#email").setValue("a@b.co");
    await wrapper.find("#password").setValue("pw");
    await wrapper.find("form").trigger("submit.prevent");
    await Promise.resolve();
    expect(store.signUp).toHaveBeenCalledWith("a@b.co", "pw", "Ada");
    expect(push).toHaveBeenCalledWith("/workspace/22222222-2222-4222-8222-222222222222");
  });

  it("shows the store error on failure", async () => {
    const store = useSessionStore();
    store.signUp = vi.fn(async () => {
      store.error = "Email already registered";
      return false;
    });
    const wrapper = mount(RegisterPage);
    await wrapper.find("#name").setValue("Ada");
    await wrapper.find("#email").setValue("a@b.co");
    await wrapper.find("#password").setValue("pw");
    await wrapper.find("form").trigger("submit.prevent");
    await Promise.resolve();
    expect(push).not.toHaveBeenCalled();
    expect(wrapper.find('[role="alert"]').text()).toContain("Email already registered");
  });
});
