import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type { RouteLocationNormalized } from "vue-router";
import { useSessionStore } from "../stores/session.js";
import { resolveGuard } from "./guard.js";
import type { AuthGateway, AuthIdentity, AuthResult } from "../auth/AuthGateway.js";
import { type MeGateway } from "../api/MeClient.js";

const identity: AuthIdentity = { userId: "usr_1", email: "a@b.co" };
const workspaceId = "22222222-2222-4222-8222-222222222222";

class FakeAuth implements AuthGateway {
  constructor(public session: AuthIdentity | null) {}
  async signIn() {
    return { ok: true } as AuthResult;
  }
  async signUp() {
    return { ok: true } as AuthResult;
  }
  async signOut() {
    this.session = null;
  }
  async currentIdentity() {
    return this.session;
  }
}
class FakeMe implements MeGateway {
  async fetchMe() {
    return { userId: identity.userId, personalWorkspaceId: workspaceId };
  }
}
function route(path: string): RouteLocationNormalized {
  return { path, fullPath: path, name: undefined } as RouteLocationNormalized;
}
function storeWith(session: AuthIdentity | null) {
  const store = useSessionStore();
  store.configure(new FakeAuth(session), new FakeMe());
  return store;
}

describe("resolveGuard", () => {
  beforeEach(() => setActivePinia(createPinia()));

  it("sends an anonymous user from a protected route to /login", async () => {
    const store = storeWith(null);
    expect(await resolveGuard(store, route("/workspace/abc"))).toBe("/login");
  });

  it("allows an anonymous user to reach /login", async () => {
    const store = storeWith(null);
    expect(await resolveGuard(store, route("/login"))).toBe(true);
  });

  it("redirects an authenticated user away from /login to their workspace", async () => {
    const store = storeWith(identity);
    expect(await resolveGuard(store, route("/login"))).toBe(`/workspace/${workspaceId}`);
  });

  it("redirects an authenticated user from / to their workspace", async () => {
    const store = storeWith(identity);
    expect(await resolveGuard(store, route("/"))).toBe(`/workspace/${workspaceId}`);
  });

  it("allows an authenticated user to reach their workspace", async () => {
    const store = storeWith(identity);
    expect(await resolveGuard(store, route(`/workspace/${workspaceId}`))).toBe(true);
  });
});
