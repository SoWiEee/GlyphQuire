import { defineComponent, h } from "vue";
import { createPinia } from "pinia";
import { flushPromises, mount } from "@vue/test-utils";
import { createMemoryHistory, createRouter } from "vue-router";
import { describe, expect, it, vi } from "vitest";
import type { WorkbenchSessionFactory } from "../components/workbench/types.js";
import WorkbenchPage from "./WorkbenchPage.vue";
import AppLayout from "../layouts/AppLayout.vue";
import {
  provideAuthenticatedWorkbenchHost,
  type AuthenticatedWorkbenchHostOptions,
} from "../providers/AuthenticatedWorkbenchHost.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "33333333-3333-4333-8333-333333333333";

describe("WorkbenchPage", () => {
  it("passes authenticated host context to Workbench and forwards account actions", async () => {
    const onAccountAction = vi.fn();
    const sessionFactory = vi.fn() as unknown as WorkbenchSessionFactory;
    const options: AuthenticatedWorkbenchHostOptions = {
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      workspaceName: "Research",
      accountLabel: "AL",
      sessionFactory,
      onAccountAction,
    };
    const WorkbenchStub = defineComponent({
      props: {
        sessionFactory: { type: Function, required: false },
        phase5WorkspaceId: { type: String, required: false },
        workspaceName: { type: String, required: false },
        accountLabel: { type: String, required: false },
      },
      emits: ["account-action"],
      setup(props, { emit }) {
        return () =>
          h("button", {
            "data-testid": "emit-account-action",
            "data-workspace-id": props.phase5WorkspaceId,
            "data-account-label": props.accountLabel,
            "data-workspace-name": props.workspaceName,
            onClick: () => emit("account-action", "sign-out"),
          });
      },
    });
    const Host = defineComponent({
      setup() {
        provideAuthenticatedWorkbenchHost(options);
        return () => h(WorkbenchPage);
      },
    });

    const wrapper = mount(Host, {
      global: {
        plugins: [createPinia()],
        stubs: { Workbench: WorkbenchStub, ConflictWorkspace: true },
      },
    });
    const actionButton = wrapper.get('[data-testid="emit-account-action"]');
    expect(actionButton.attributes("data-workspace-id")).toBe(WORKSPACE_ID);
    expect(actionButton.attributes("data-account-label")).toBe("AL");
    expect(actionButton.attributes("data-workspace-name")).toBe("Research");

    await actionButton.trigger("click");
    expect(onAccountAction).toHaveBeenCalledWith("sign-out");
  });

  it("keeps the default AppLayout provider fail-closed", async () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: "/", component: WorkbenchPage }],
    });
    await router.push("/");
    await router.isReady();

    const wrapper = mount(AppLayout, {
      global: { plugins: [createPinia(), router] },
    });
    await flushPromises();

    expect(wrapper.find('button[aria-label="Open account menu"]').exists()).toBe(false);
    expect(wrapper.get('button[aria-label="Search notes"]').isDisabled()).toBe(true);

    wrapper.unmount();
  });
});
