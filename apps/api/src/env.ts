import { z } from "zod";
import {
  databaseEnvSchema,
  authEnvSchema,
  appEnvSchema,
  operatorAllowlistSchema,
  phase5EnvSchema,
  s3EnvSchema,
} from "@glyphquire/shared";

const baseEnvSchema = databaseEnvSchema
  .merge(authEnvSchema)
  .merge(appEnvSchema)
  .extend({ PHASE5_OPERATOR_IDS: operatorAllowlistSchema });

const booleanEnvironmentSchema = z.preprocess((value) => {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return value;
}, z.boolean());

const alertWebhookSchema = z
  .string()
  .url()
  .transform((value, context) => {
    const parsed = new URL(value);
    const loopback =
      parsed.hostname === "localhost" ||
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "[::1]";
    if (
      (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.hash !== ""
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "must be HTTPS or an HTTP loopback webhook without credentials or fragments",
      });
      return z.NEVER;
    }
    return parsed;
  });

const phase5ApiEnvSchema = s3EnvSchema.extend({
  S3_FORCE_PATH_STYLE: booleanEnvironmentSchema,
  PHASE5_ALERT_WEBHOOK_URL: alertWebhookSchema,
  PHASE5_ALERT_DELIVERY_SECONDS: z.coerce.number().int().min(1).max(300).default(300),
});

const PHASE5_ENABLE_FIELDS = [
  "S3_ENDPOINT",
  "S3_ACCESS_KEY",
  "S3_SECRET_KEY",
  "S3_BUCKET",
  "IDEMPOTENCY_ENCRYPTION_KEY",
  "BACKUP_ENCRYPTION_KEY",
  "PHASE5_ALERT_WEBHOOK_URL",
] as const;

export type EnvInput = z.input<typeof baseEnvSchema> &
  Partial<z.input<typeof phase5ApiEnvSchema>> &
  Partial<z.input<typeof phase5EnvSchema>>;
type ParsedBaseEnv = z.output<typeof baseEnvSchema>;
type ParsedPhase5Env = z.output<typeof phase5ApiEnvSchema> & z.output<typeof phase5EnvSchema>;
export type Env = ParsedBaseEnv & { PRODUCTION: boolean } & (
    | { PHASE5_ENABLED: false }
    | ({ PHASE5_ENABLED: true } & ParsedPhase5Env)
  );

function invalidEnvironment(issues: readonly z.ZodIssue[]): never {
  const fields = [...new Set(issues.map((issue) => issue.path.join(".")))].sort();
  throw new Error(`Invalid environment variables: ${fields.join(", ")}`);
}

export function parseEnv(source: unknown): Env {
  const candidate =
    source !== null &&
    typeof source === "object" &&
    !("WEB_ORIGIN" in source) &&
    "BETTER_AUTH_URL" in source &&
    typeof source.BETTER_AUTH_URL === "string"
      ? { ...source, WEB_ORIGIN: source.BETTER_AUTH_URL }
      : source;
  const base = baseEnvSchema.safeParse(candidate);
  if (!base.success) invalidEnvironment(base.error.issues);

  const production = base.data.WEB_ORIGIN.protocol === "https:";
  if (production && new URL(base.data.BETTER_AUTH_URL).origin !== base.data.WEB_ORIGIN.origin) {
    throw new Error("BETTER_AUTH_URL and WEB_ORIGIN must be same-origin in production");
  }

  const phase5Requested =
    candidate !== null &&
    typeof candidate === "object" &&
    PHASE5_ENABLE_FIELDS.some((field) => field in candidate);
  if (!phase5Requested) {
    return { ...base.data, PRODUCTION: production, PHASE5_ENABLED: false };
  }

  const apiPhase5 = phase5ApiEnvSchema.safeParse(candidate);
  const phase5 = phase5EnvSchema.safeParse(candidate);
  if (!apiPhase5.success || !phase5.success) {
    invalidEnvironment([
      ...(apiPhase5.success ? [] : apiPhase5.error.issues),
      ...(phase5.success ? [] : phase5.error.issues),
    ]);
  }
  return {
    ...base.data,
    ...apiPhase5.data,
    ...phase5.data,
    PRODUCTION: production,
    PHASE5_ENABLED: true,
  };
}

export function loadEnv(): Env {
  const env = parseEnv(process.env);
  if (!env.PHASE5_ENABLED) {
    throw new Error("Invalid environment variables: Phase 5 configuration is required");
  }
  return env;
}
