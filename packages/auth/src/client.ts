import { createAuthClient as createBetterAuthClient } from "better-auth/client";

export function createAuthClient(baseUrl: string) {
  return createBetterAuthClient({
    baseURL: baseUrl,
  });
}

export type AuthClient = ReturnType<typeof createAuthClient>;
