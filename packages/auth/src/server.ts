import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
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
    databaseHooks: {
      user: {
        create: {
          after: async (createdUser) => {
            try {
              await options.onUserCreated(createdUser.id);
            } catch {
              throw new APIError("SERVICE_UNAVAILABLE", {
                code: "SERVICE_UNAVAILABLE",
                message: "Account setup is temporarily unavailable",
              });
            }
          },
        },
      },
    },
  });
}

export interface AuthOptions {
  baseUrl: string;
  secret: string;
  onUserCreated(userId: string): Promise<void>;
}

export type Auth = ReturnType<typeof createAuth>;
