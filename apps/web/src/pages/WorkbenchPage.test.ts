import { defineComponent, h } from "vue";
import { createPinia } from "pinia";
import { flushPromises, mount } from "@vue/test-utils";
import { createMemoryHistory, createRouter } from "vue-router";
import { describe, expect, it, vi } from "vitest";
import type { NoteConflict } from "@glyphquire/api-contract";
import type { EditorSession } from "../editors/editor-session.types.js";
import type { WorkbenchSessionFactory } from "../components/workbench/types.js";
import WorkbenchPage from "./WorkbenchPage.vue";
import AppLayout from "../layouts/AppLayout.vue";
import {
  provideAuthenticatedWorkbenchHost,
  type AuthenticatedWorkbenchHostOptions,
} from "../providers/AuthenticatedWorkbenchHost.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "33333333-3333-4333-8333-333333333333";
const CONFLICT_WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const NOTE_ID = "44444444-4444-4444-8444-444444444444";

function conflictFixture(): NoteConflict {
  return {
    code: "REVISION_CONFLICT",
    noteId: NOTE_ID,
    serverRevision: 2,
    serverMarkdown: "# Server version",
    serverUpdatedAt: "2026-08-01T00:00:00.000Z",
    lastEditedBy: null,
    requestId: "task4-conflict",
  };
}

function ConflictWorkspaceStub() {
  return defineComponent({
    setup() {
      return () => h("div", { "aria-label": "Resolve conflicting edits" });
    },
  });
}

function ConflictWorkbenchStub() {
  return defineComponent({
    props: {
      sessionFactory: { type: Function, required: false },
    },
    emits: ["request-conflict-recovery"],
    setup(props, { emit }) {
      return () =>
        h(
          "button",
          {
            type: "button",
            "aria-label": "Open conflict recovery",
            onClick: async () => {
              const factory = props.sessionFactory as WorkbenchSessionFactory | undefined;
              if (!factory) return;
              const result = await factory({ id: NOTE_ID, title: "Note", markdown: "# Local" });
              if (!("session" in result) || !result.context) return;
              emit("request-conflict-recovery", {
                userId: result.context.userId,
                workspaceId: result.context.workspaceId,
                noteId: NOTE_ID,
                conflict: conflictFixture(),
                localMarkdown: "# Local",
                localBaseRevision: 1,
              });
            },
          },
          "Review conflict",
        );
    },
  });
}

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
        workspaceId: { type: String, required: false },
        workspaceName: { type: String, required: false },
        accountLabel: { type: String, required: false },
      },
      emits: ["account-action"],
      setup(props, { emit }) {
        return () =>
          h("button", {
            "data-testid": "emit-account-action",
            "data-workspace-id": props.workspaceId,
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
    expect(wrapper.get('button[role="tab"][aria-label="Search"]').isDisabled()).toBe(true);

    wrapper.unmount();
  });

  it("opens the full-screen recovery workspace for a validated conflict context", async () => {
    const sessionFactory: WorkbenchSessionFactory = vi.fn(async () => ({
      session: {} as EditorSession,
      context: { userId: USER_ID, workspaceId: CONFLICT_WORKSPACE_ID },
    }));
    const wrapper = mount(WorkbenchPage, {
      props: { sessionFactory },
      global: {
        plugins: [createPinia()],
        stubs: {
          Workbench: ConflictWorkbenchStub(),
          ConflictWorkspace: ConflictWorkspaceStub(),
        },
      },
    });

    await wrapper.get('button[aria-label="Open conflict recovery"]').trigger("click");
    await flushPromises();

    expect(wrapper.get('[aria-label="Resolve conflicting edits"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it("does not mount recovery when the session context is not canonical", async () => {
    const sessionFactory: WorkbenchSessionFactory = vi.fn(async () => ({
      session: {} as EditorSession,
      context: { userId: "not-a-uuid", workspaceId: CONFLICT_WORKSPACE_ID },
    }));
    const wrapper = mount(WorkbenchPage, {
      props: { sessionFactory },
      global: {
        plugins: [createPinia()],
        stubs: {
          Workbench: ConflictWorkbenchStub(),
          ConflictWorkspace: ConflictWorkspaceStub(),
        },
      },
    });

    await wrapper.get('button[aria-label="Open conflict recovery"]').trigger("click");
    await flushPromises();

    expect(wrapper.find('[aria-label="Resolve conflicting edits"]').exists()).toBe(false);
    wrapper.unmount();
  });
});
