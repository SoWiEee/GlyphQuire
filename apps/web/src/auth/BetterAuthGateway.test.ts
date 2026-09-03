import { describe, expect, it } from "vitest";
import { BetterAuthGateway } from "./BetterAuthGateway.js";

// Minimal fake matching the better-auth client shape the adapter touches.
function fakeAuthClient(overrides: Record<string, unknown> = {}) {
  return {
    signIn: { email: async () => ({ data: { user: {} }, error: null }) },
    signUp: { email: async () => ({ data: { user: {} }, error: null }) },
    signOut: async () => ({ data: null, error: null }),
    getSession: async () => ({ data: null, error: null }),
    ...overrides,
  } as never;
}

describe("BetterAuthGateway", () => {
  it("signIn returns ok on success", async () => {
    const gw = new BetterAuthGateway(fakeAuthClient());
    expect(await gw.signIn("a@b.co", "pw")).toEqual({ ok: true });
  });

  it("signIn returns the error message on failure", async () => {
    const gw = new BetterAuthGateway(
      fakeAuthClient({
        signIn: { email: async () => ({ data: null, error: { message: "Invalid credentials" } }) },
      }),
    );
    expect(await gw.signIn("a@b.co", "pw")).toEqual({ ok: false, message: "Invalid credentials" });
  });

  it("currentIdentity maps a live session to { userId, email, expiresAt }", async () => {
    const expires = new Date("2030-01-01T00:00:00.000Z");
    const gw = new BetterAuthGateway(
      fakeAuthClient({
        getSession: async () => ({
          data: { user: { id: "usr_1", email: "a@b.co" }, session: { expiresAt: expires } },
          error: null,
        }),
      }),
    );
    expect(await gw.currentIdentity()).toEqual({
      userId: "usr_1",
      email: "a@b.co",
      expiresAt: expires.getTime(),
    });
  });

  it("currentIdentity returns null when there is no session", async () => {
    const gw = new BetterAuthGateway(fakeAuthClient());
    expect(await gw.currentIdentity()).toBeNull();
  });
});
