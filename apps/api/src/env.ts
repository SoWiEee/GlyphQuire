import type { z } from "zod";
import { databaseEnvSchema, authEnvSchema, appEnvSchema } from "@glyphquire/shared";

const envSchema = databaseEnvSchema.merge(authEnvSchema).merge(appEnvSchema);

export type Env = z.infer<typeof envSchema>;

export function loadEnv(): Env {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error("Invalid environment variables:", result.error.format());
    process.exit(1);
  }
  return result.data;
}
