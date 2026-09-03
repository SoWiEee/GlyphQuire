import type { Router, RouteLocationNormalized } from "vue-router";
import { useSessionStore } from "../stores/session.js";

type SessionStore = ReturnType<typeof useSessionStore>;

const PUBLIC_PATHS = new Set(["/login", "/register"]);

export async function resolveGuard(
  store: SessionStore,
  to: RouteLocationNormalized,
): Promise<true | string> {
  await store.restore();
  const isPublic = PUBLIC_PATHS.has(to.path);

  if (store.status === "authenticated") {
    const workspacePath = store.personalWorkspaceId
      ? `/workspace/${store.personalWorkspaceId}`
      : null;
    if ((isPublic || to.path === "/") && workspacePath) return workspacePath;
    return true;
  }

  // anonymous
  if (isPublic) return true;
  return "/login";
}

export function installAuthGuard(router: Router): void {
  router.beforeEach(async (to) => {
    const store = useSessionStore();
    return resolveGuard(store, to);
  });
}
