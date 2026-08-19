import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import type { Database } from "@glyphquire/database";

export function createAuth(db: Database, options: AuthOptions) {
  return betterAuth({
    database: drizzleAdapter(db, {
      provider: "pg",
    }),
    baseURL: options.baseUrl,
    secret: options.secret,
    emailAndPassword: {
      enabled: true,
    },
  });
}

export interface AuthOptions {
  baseUrl: string;
  secret: string;
}

export type Auth = ReturnType<typeof createAuth>;
