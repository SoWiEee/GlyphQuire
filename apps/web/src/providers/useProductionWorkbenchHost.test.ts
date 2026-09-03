import { beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h } from "vue";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import {
  useProductionWorkbenchHost,
  type ProductionWorkbenchHostDeps,
  type SessionCoordinatorLike,
} from "./useProductionWorkbenchHost.js";
import type { WorkbenchHostContext } from "../components/workbench/WorkbenchContext.js";
import { useSessionStore } from "../stores/session.js";

const userId = "usr_2N4kQb8fVxErq7wZ";
const workspaceId = "22222222-2222-4222-8222-222222222222";

function fakeCoordinator(): SessionCoordinatorLike {
  return {
    authorizeEditor: vi.fn(async () => undefined),
    assertEditorAuthorized: vi.fn(),
    registerEditor: vi.fn(() => () => undefined),
    logout: vi.fn(async (networkLogout: () => Promise<void>) => {
      await networkLogout();
    }),
    dispose: vi.fn(),
  };
}

// Captures the composable's RETURN value for assertions.
let captured: WorkbenchHostContext | null = null;

function probeWith(deps: ProductionWorkbenchHostDeps) {
  return defineComponent({
    setup() {
      captured = useProductionWorkbenchHost(deps);
      return () =>
        h("output", {
          "data-has-factory": captured?.sessionFactory ? "yes" : "no",
          "data-ws": captured?.workspaceId ?? "",
          onClick: () => captured?.onAccountAction?.("sign-out"),
        });
    },
  });
}

function authenticatedStore() {
  const store = useSessionStore();
  store.status = "authenticated";
  store.userId = userId;
  store.personalWorkspaceId = workspaceId;
  store.email = "a@b.co";
  store.sessionExpiresAt = 1893456000000;
  return store;
}

describe("useProductionWorkbenchHost", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    captured = null;
  });

  it("returns a real host context with a session factory when authenticated", () => {
    authenticatedStore();
    const coordinator = fakeCoordinator();
    const deps: ProductionWorkbenchHostDeps = {
      createDraftStore: () => ({}) as never,
      createLifecycle: () => coordinator,
    };
    const wrapper = mount(probeWith(deps));
    expect(captured?.sessionFactory).toBeTypeOf("function");
    expect(captured?.workspaceId).toBe(workspaceId);
    expect(wrapper.get("output").attributes("data-has-factory")).toBe("yes");
    wrapper.unmount();
    expect(coordinator.dispose).toHaveBeenCalledOnce();
  });

  it("routes sign-out through the coordinator's logout (local scrub) then network sign-out", async () => {
    const store = authenticatedStore();
    store.signOut = vi.fn(async () => undefined);
    const coordinator = fakeCoordinator();
    const deps: ProductionWorkbenchHostDeps = {
      createDraftStore: () => ({}) as never,
      createLifecycle: () => coordinator,
    };
    const wrapper = mount(probeWith(deps));
    await wrapper.get("output").trigger("click");
    await Promise.resolve();
    expect(coordinator.logout).toHaveBeenCalledOnce();
    // The logout networkLogout callback is the store sign-out.
    expect(store.signOut).toHaveBeenCalledOnce();
    wrapper.unmount();
  });

  it("returns null when the session is not authenticated", () => {
    const store = useSessionStore();
    store.status = "anonymous";
    const deps: ProductionWorkbenchHostDeps = {
      createDraftStore: () => ({}) as never,
      createLifecycle: () => fakeCoordinator(),
    };
    const wrapper = mount(probeWith(deps));
    expect(captured).toBeNull();
    expect(wrapper.get("output").attributes("data-has-factory")).toBe("no");
    wrapper.unmount();
  });
});
