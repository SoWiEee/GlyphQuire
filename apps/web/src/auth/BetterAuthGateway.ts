import { createAuthClient } from "@glyphquire/auth/client";
import type { AuthGateway, AuthIdentity, AuthResult } from "./AuthGateway.js";

type BetterAuthClient = ReturnType<typeof createAuthClient>;

// better-auth client calls resolve to { data, error }; error carries a message.
interface BetterAuthError {
  message?: string;
}
function errorMessage(error: unknown): string {
  const message = (error as BetterAuthError | null)?.message;
  return typeof message === "string" && message.length > 0 ? message : "Authentication failed";
}

export class BetterAuthGateway implements AuthGateway {
  constructor(private readonly client: BetterAuthClient) {}

  async signIn(email: string, password: string): Promise<AuthResult> {
    const { error } = await this.client.signIn.email({ email, password });
    return error ? { ok: false, message: errorMessage(error) } : { ok: true };
  }

  async signUp(email: string, password: string, name: string): Promise<AuthResult> {
    const { error } = await this.client.signUp.email({ email, password, name });
    return error ? { ok: false, message: errorMessage(error) } : { ok: true };
  }

  async signOut(): Promise<void> {
    await this.client.signOut();
  }

  async currentIdentity(): Promise<AuthIdentity | null> {
    const { data } = await this.client.getSession();
    const user = data?.user;
    if (!user?.id || typeof user.email !== "string") return null;
    return { userId: user.id, email: user.email };
  }
}

/** Builds a gateway against the same-origin better-auth handler (`/api/auth`). */
export function createBetterAuthGateway(
  baseUrl: string = window.location.origin,
): BetterAuthGateway {
  return new BetterAuthGateway(createAuthClient(baseUrl));
}
