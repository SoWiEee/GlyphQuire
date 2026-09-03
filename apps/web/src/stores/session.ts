import { defineStore } from "pinia";
import { ref } from "vue";
import { MeClient, MeUnauthorizedError, type MeGateway } from "../api/MeClient.js";
import { createBetterAuthGateway } from "../auth/BetterAuthGateway.js";
import type { AuthGateway } from "../auth/AuthGateway.js";

type SessionStatus = "unknown" | "authenticated" | "anonymous";

export const useSessionStore = defineStore("session", () => {
  const status = ref<SessionStatus>("unknown");
  const userId = ref<string | null>(null);
  const personalWorkspaceId = ref<string | null>(null);
  const email = ref<string | null>(null);
  const error = ref<string | null>(null);
  const pending = ref(false);

  let gateway: AuthGateway | null = null;
  let meClient: MeGateway | null = null;
  let restorePromise: Promise<void> | null = null;

  function deps(): { gateway: AuthGateway; meClient: MeGateway } {
    if (!gateway) gateway = createBetterAuthGateway();
    if (!meClient) meClient = new MeClient();
    return { gateway, meClient };
  }

  /** Test/host seam: inject fakes before any action runs. */
  function configure(nextGateway: AuthGateway, nextMeClient: MeGateway): void {
    gateway = nextGateway;
    meClient = nextMeClient;
  }

  function clearIdentity(): void {
    userId.value = null;
    personalWorkspaceId.value = null;
    email.value = null;
  }

  // Never rejects. `currentIdentity()` (a network call) is inside the try so a
  // transient failure cannot escape into the router guard and wedge navigation.
  // Definite "no session" → anonymous; a transient error leaves status "unknown"
  // (retryable) so a later navigation re-attempts instead of stranding the user.
  async function bootstrap(): Promise<void> {
    const { gateway: gw, meClient: me } = deps();
    try {
      const identity = await gw.currentIdentity();
      if (!identity) {
        clearIdentity();
        status.value = "anonymous";
        return;
      }
      const meResult = await me.fetchMe();
      userId.value = identity.userId;
      email.value = identity.email;
      personalWorkspaceId.value = meResult.personalWorkspaceId;
      status.value = "authenticated";
    } catch (cause) {
      clearIdentity();
      if (cause instanceof MeUnauthorizedError) {
        status.value = "anonymous"; // definitively no/expired session
      } else {
        status.value = "unknown"; // transient — allow a retry on next navigation
        error.value = "Could not load your workspace. Please try again.";
      }
    }
  }

  /**
   * Idempotent: the first call resolves status; concurrent callers await it.
   * After a transient failure (status still "unknown") the memoized promise is
   * cleared so the next navigation retries. The router guard treats a lingering
   * "unknown" as not-authenticated (fail-closed → /login), so a transient error
   * never grants access and never wedges navigation.
   */
  async function restore(): Promise<void> {
    if (status.value !== "unknown") return;
    if (!restorePromise) restorePromise = bootstrap();
    await restorePromise;
    if (status.value === "unknown") restorePromise = null;
  }

  async function signIn(emailInput: string, password: string): Promise<boolean> {
    const { gateway: gw } = deps();
    pending.value = true;
    error.value = null;
    try {
      const result = await gw.signIn(emailInput, password);
      if (!result.ok) {
        status.value = "anonymous";
        error.value = result.message ?? "Sign in failed";
        return false;
      }
      await bootstrap();
      return status.value === "authenticated";
    } finally {
      pending.value = false;
    }
  }

  async function signUp(emailInput: string, password: string, name: string): Promise<boolean> {
    const { gateway: gw } = deps();
    pending.value = true;
    error.value = null;
    try {
      const result = await gw.signUp(emailInput, password, name);
      if (!result.ok) {
        status.value = "anonymous";
        error.value = result.message ?? "Sign up failed";
        return false;
      }
      await bootstrap();
      return status.value === "authenticated";
    } finally {
      pending.value = false;
    }
  }

  async function signOut(): Promise<void> {
    const { gateway: gw } = deps();
    try {
      await gw.signOut();
    } finally {
      clearIdentity();
      error.value = null;
      status.value = "anonymous";
    }
  }

  return {
    status,
    userId,
    personalWorkspaceId,
    email,
    error,
    pending,
    configure,
    restore,
    bootstrap,
    signIn,
    signUp,
    signOut,
  };
});
