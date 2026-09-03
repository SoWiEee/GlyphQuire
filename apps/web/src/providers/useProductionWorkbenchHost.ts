import { onBeforeUnmount } from "vue";
import { BrowserSessionLifecycleCoordinator } from "../coordination/SessionLifecycleCoordinator.js";
import type { EditorSessionLifecycle } from "../coordination/SessionLifecycleCoordinator.js";
import { IndexedDbDraftStore } from "../persistence/DraftStore.js";
import type { DraftStore } from "../editors/editor-session.types.js";
import { useSessionStore } from "../stores/session.js";
import { provideAuthenticatedWorkbenchHost } from "./AuthenticatedWorkbenchHost.js";
import { createWorkbenchSessionFactory } from "./workbenchSessionFactory.js";
import type {
  WorkbenchAccountAction,
  WorkbenchHostContext,
} from "../components/workbench/WorkbenchContext.js";

/**
 * The coordinator surface this composable needs: the `EditorSessionLifecycle`
 * the factory consumes, plus `logout` (local-draft scrub + scoped cross-tab
 * logout broadcast, run before the network sign-out) and `dispose`.
 */
export interface SessionCoordinatorLike extends EditorSessionLifecycle {
  logout(networkLogout: () => Promise<void>): Promise<void>;
  dispose(): void;
}

/** Injectable seams for tests; production builds the real coordinator + store. */
export interface ProductionWorkbenchHostDeps {
  createDraftStore: () => DraftStore;
  createLifecycle: (
    session: { userId: string; expiresAt: number; workspaceIds: string[] },
    draftStore: DraftStore,
  ) => SessionCoordinatorLike;
}

function defaultHostDeps(): ProductionWorkbenchHostDeps {
  return {
    createDraftStore: () => new IndexedDbDraftStore(),
    createLifecycle: (initialSession, draftStore) =>
      new BrowserSessionLifecycleCoordinator({ initialSession, draftStore }),
  };
}

/**
 * Provides the authenticated workbench host (real session factory) for the
 * current signed-in session. No-op when the session store is not authenticated
 * (the router guard has already redirected an anonymous user to /login). The
 * lifecycle coordinator + draft store are created once here and shared across
 * every note session opened during this mount; both are torn down on unmount.
 *
 * Sign-out is routed through the coordinator's `logout(...)` so the departing
 * user's local drafts are scrubbed and a scoped cross-tab logout is broadcast
 * BEFORE the network sign-out — `dispose()` alone does not do this.
 */
export function useProductionWorkbenchHost(
  deps: ProductionWorkbenchHostDeps = defaultHostDeps(),
): WorkbenchHostContext | null {
  const session = useSessionStore();
  const userId = session.userId;
  const workspaceId = session.personalWorkspaceId;
  const expiresAt = session.sessionExpiresAt;

  if (
    session.status !== "authenticated" ||
    !userId ||
    !workspaceId ||
    expiresAt === null ||
    expiresAt <= 0
  ) {
    return null;
  }

  const draftStore = deps.createDraftStore();
  const lifecycle = deps.createLifecycle(
    { userId, expiresAt, workspaceIds: [workspaceId] },
    draftStore,
  );

  const sessionFactory = createWorkbenchSessionFactory(
    {
      userId,
      workspaceId,
      workspaceName: "Personal",
      ...(session.email ? { accountLabel: session.email } : {}),
    },
    { lifecycle, draftStore },
  );

  const onAccountAction = (action: WorkbenchAccountAction): void => {
    if (action !== "sign-out") return;
    // Local scrub (drafts + locks + scoped logout broadcast) THEN network sign-out;
    // session.signOut() also clears the Pinia store in its own finally.
    void lifecycle.logout(() => session.signOut()).catch(() => undefined);
  };

  // Also provide it (for any descendant that injects), but the caller uses the
  // RETURNED context directly — Vue's `inject` never sees the current
  // component's own `provide`, so the consumer must not re-inject this.
  const context = provideAuthenticatedWorkbenchHost({
    userId,
    workspaceId,
    workspaceName: "Personal",
    ...(session.email ? { accountLabel: session.email } : {}),
    sessionFactory,
    onAccountAction,
  });

  onBeforeUnmount(() => {
    lifecycle.dispose();
  });

  return context;
}
