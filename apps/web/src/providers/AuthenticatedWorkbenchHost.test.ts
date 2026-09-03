import { defineComponent, h } from "vue";
import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import type { EditorSession } from "../editors/editor-session.types.js";
import {
  provideAuthenticatedWorkbenchHost,
  type AuthenticatedWorkbenchHostOptions,
} from "./AuthenticatedWorkbenchHost.js";
import { useWorkbenchHostContext } from "../components/workbench/WorkbenchContext.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "33333333-3333-4333-8333-333333333333";
const sessionFactory = vi.fn(async () => ({}) as EditorSession);

const Probe = defineComponent({
  setup() {
    const context = useWorkbenchHostContext();
    return () => h("output", { "data-context": JSON.stringify(context) });
  },
});

describe("AuthenticatedWorkbenchHost", () => {
  it("rejects a non-canonical workspaceId before providing a host", () => {
    const invalid: AuthenticatedWorkbenchHostOptions = {
      userId: USER_ID,
      workspaceId: "not-a-uuid",
      sessionFactory,
    };

    expect(() => provideAuthenticatedWorkbenchHost(invalid)).toThrow(
      "canonical authenticated identity: workspaceId",
    );
  });

  it("rejects an invalid userId (empty or containing a colon) before providing a host", () => {
    const invalid: AuthenticatedWorkbenchHostOptions = {
      userId: "evil:user",
      workspaceId: WORKSPACE_ID,
      sessionFactory,
    };

    expect(() => provideAuthenticatedWorkbenchHost(invalid)).toThrow("identity: userId");
  });

  it("forwards authenticated context unchanged", () => {
    const context: AuthenticatedWorkbenchHostOptions = {
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      workspaceName: "Research",
      accountLabel: "AL",
      sessionFactory,
    };
    const Host = defineComponent({
      setup() {
        provideAuthenticatedWorkbenchHost(context);
        return () => h(Probe);
      },
    });

    const wrapper = mount(Host);
    const provided = JSON.parse(wrapper.get("output").attributes("data-context") ?? "null");

    expect(provided).toMatchObject({
      workspaceId: context.workspaceId,
      workspaceName: context.workspaceName,
      accountLabel: context.accountLabel,
    });
    expect(provided.sessionFactory).toBeUndefined();
  });

  it("binds validated identity into the session handle seam", async () => {
    const bareSession = {} as EditorSession;
    const factory = vi.fn(async () => bareSession);
    let provided: ReturnType<typeof provideAuthenticatedWorkbenchHost> | undefined;
    const Host = defineComponent({
      setup() {
        provided = provideAuthenticatedWorkbenchHost({
          userId: USER_ID,
          workspaceId: WORKSPACE_ID,
          sessionFactory: factory,
        });
        return () => h(Probe);
      },
    });
    mount(Host);

    const handle = await provided!.sessionFactory!({ id: "note", title: "Note", markdown: "" });
    expect(handle).toEqual({
      session: bareSession,
      context: { userId: USER_ID, workspaceId: WORKSPACE_ID },
    });
  });
});
