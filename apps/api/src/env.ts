import type { z } from "zod";
import {
  databaseEnvSchema,
  authEnvSchema,
  appEnvSchema,
  operatorAllowlistSchema,
} from "@glyphquire/shared";

const envSchema = databaseEnvSchema
  .merge(authEnvSchema)
  .merge(appEnvSchema)
  .extend({ PHASE5_OPERATOR_IDS: operatorAllowlistSchema });

export type EnvInput = z.input<typeof envSchema>;
type ParsedEnv = z.output<typeof envSchema>;
export type Env = ParsedEnv & { PRODUCTION: boolean };

export function parseEnv(source: unknown): Env {
  const candidate =
    source !== null &&
    typeof source === "object" &&
    !("WEB_ORIGIN" in source) &&
    "BETTER_AUTH_URL" in source &&
    typeof source.BETTER_AUTH_URL === "string"
      ? { ...source, WEB_ORIGIN: source.BETTER_AUTH_URL }
      : source;
  const result = envSchema.safeParse(candidate);
  if (!result.success) {
    const fields = [...new Set(result.error.issues.map((issue) => issue.path.join(".")))].sort();
    throw new Error(`Invalid environment variables: ${fields.join(", ")}`);
  }

  const production = result.data.WEB_ORIGIN.protocol === "https:";
  if (production && new URL(result.data.BETTER_AUTH_URL).origin !== result.data.WEB_ORIGIN.origin) {
    throw new Error("BETTER_AUTH_URL and WEB_ORIGIN must be same-origin in production");
  }
  return { ...result.data, PRODUCTION: production };
}

export function loadEnv(): Env {
  return parseEnv(process.env);
}
