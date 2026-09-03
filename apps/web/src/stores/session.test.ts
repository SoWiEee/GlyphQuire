import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useSessionStore } from "./session.js";
import type { AuthGateway, AuthIdentity, AuthResult } from "../auth/AuthGateway.js";
import { MeUnauthorizedError, type MeGateway } from "../api/MeClient.js";

const identity: AuthIdentity = { userId: "usr_1", email: "a@b.co", expiresAt: 1893456000000 };
const workspaceId = "22222222-2222-4222-8222-222222222222";

class FakeAuth implements AuthGateway {
  session: AuthIdentity | null = null;
  signInResult: AuthResult = { ok: true };
  throwOnIdentity = false;
  async signIn() {
    if (this.signInResult.ok) this.session = identity;
    return this.signInResult;
  }
  async signUp() {
    this.session = identity;
    return { ok: true } as AuthResult;
  }
  async signOut() {
    this.session = null;
  }
  async currentIdentity() {
    if (this.throwOnIdentity) throw new Error("network down");
    return this.session;
  }
}

class FakeMe implements MeGateway {
  unauthorized = false;
  async fetchMe() {
    if (this.unauthorized) throw new MeUnauthorizedError();
    return { userId: identity.userId, personalWorkspaceId: workspaceId };
  }
}

function setup() {
  const auth = new FakeAuth();
  const me = new FakeMe();
  const store = useSessionStore();
  store.configure(auth, me);
  return { auth, me, store };
}

describe("useSessionStore", () => {
  beforeEach(() => setActivePinia(createPinia()));

  it("restore resolves to anonymous when there is no session", async () => {
    const { store } = setup();
    await store.restore();
    expect(store.status).toBe("anonymous");
    expect(store.personalWorkspaceId).toBeNull();
  });

  it("restore resolves to authenticated and loads the workspace when a session exists", async () => {
    const { auth, store } = setup();
    auth.session = identity;
    await store.restore();
    expect(store.status).toBe("authenticated");
    expect(store.userId).toBe("usr_1");
    expect(store.email).toBe("a@b.co");
    expect(store.personalWorkspaceId).toBe(workspaceId);
    expect(store.sessionExpiresAt).toBe(1893456000000);
  });

  it("signIn success authenticates and bootstraps the workspace", async () => {
    const { store } = setup();
    const ok = await store.signIn("a@b.co", "pw");
    expect(ok).toBe(true);
    expect(store.status).toBe("authenticated");
    expect(store.personalWorkspaceId).toBe(workspaceId);
    expect(store.error).toBeNull();
  });

  it("signIn failure records the error and stays anonymous", async () => {
    const { auth, store } = setup();
    auth.signInResult = { ok: false, message: "Invalid credentials" };
    const ok = await store.signIn("a@b.co", "wrong");
    expect(ok).toBe(false);
    expect(store.status).toBe("anonymous");
    expect(store.error).toBe("Invalid credentials");
  });

  it("signOut clears identity to anonymous", async () => {
    const { store } = setup();
    await store.signIn("a@b.co", "pw");
    await store.signOut();
    expect(store.status).toBe("anonymous");
    expect(store.userId).toBeNull();
    expect(store.personalWorkspaceId).toBeNull();
  });

  it("bootstrap sets anonymous when /me is unauthorized", async () => {
    const { auth, me, store } = setup();
    auth.session = identity;
    me.unauthorized = true;
    await store.restore();
    expect(store.status).toBe("anonymous");
  });

  it("does not wedge on a transient currentIdentity() failure and stays retryable", async () => {
    const { auth, store } = setup();
    auth.session = identity;
    auth.throwOnIdentity = true;
    // restore() must resolve (not reject) even though the gateway threw.
    await expect(store.restore()).resolves.toBeUndefined();
    expect(store.status).toBe("unknown");
    expect(store.error).toBe("Could not load your workspace. Please try again.");
    // The failure is retryable: once the network recovers, restore() re-attempts.
    auth.throwOnIdentity = false;
    await store.restore();
    expect(store.status).toBe("authenticated");
    expect(store.personalWorkspaceId).toBe(workspaceId);
  });
});
