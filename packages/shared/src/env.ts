import { z } from "zod";

export const databaseEnvSchema = z.object({
  DATABASE_URL: z.string().url(),
});

export const migrationEnvSchema = z.object({
  MIGRATION_DATABASE_URL: z.string().url(),
});

export const s3EnvSchema = z.object({
  S3_ENDPOINT: z.string().url(),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_BUCKET: z.string().min(1),
  S3_REGION: z.string().default("us-east-1"),
});

export const authEnvSchema = z.object({
  BETTER_AUTH_SECRET: z.string().min(1),
  BETTER_AUTH_URL: z.string().url(),
});

export const webOriginSchema = z.string().transform((value, context) => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "must be an absolute web origin" });
    return z.NEVER;
  }

  const isLoopback =
    parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "[::1]";
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.hostname.includes("*") ||
    (parsed.protocol === "http:" && !isLoopback)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "must be one exact HTTPS origin or an HTTP loopback development origin",
    });
    return z.NEVER;
  }
  return parsed;
});

export const appEnvSchema = z.object({
  API_PORT: z.coerce.number().default(3000),
  WEB_PORT: z.coerce.number().default(5173),
  WEB_ORIGIN: webOriginSchema.default("http://localhost:5173"),
  TRUSTED_PROXY_CIDRS: z.string().default(""),
  FORWARDED_IP_HEADER: z.string().default("x-forwarded-for"),
});

const integerEnv = (defaultValue: number, minimum: number, maximum: number) =>
  z.coerce.number().int().min(minimum).max(maximum).default(defaultValue);

const base64UrlKeySchema = z
  .string()
  .length(43)
  .regex(/^[A-Za-z0-9_-]{43}$/, "must be an unpadded base64url-encoded 32-byte key")
  .superRefine((value, context) => {
    try {
      const base64 = value.replaceAll("-", "+").replaceAll("_", "/") + "=";
      const decoded = atob(base64);
      let binary = "";
      for (let index = 0; index < decoded.length; index += 1) {
        binary += String.fromCharCode(decoded.charCodeAt(index));
      }
      const canonical = btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
      if (decoded.length !== 32 || canonical !== value) throw new Error("non-canonical key");
    } catch {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "must be an unpadded base64url-encoded 32-byte key",
      });
    }
  });

const operatorAllowlistSchema = z
  .string()
  .default("")
  .transform((value, context): string[] => {
    if (value === "") return [];
    const entries = value.split(",");
    if (entries.length > 20) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "must contain at most 20 ids" });
      return z.NEVER;
    }
    const seen = new Set<string>();
    for (const entry of entries) {
      if (
        entry.length === 0 ||
        /\s/u.test(entry) ||
        entry.includes("*") ||
        new TextEncoder().encode(entry).byteLength > 200 ||
        seen.has(entry)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "must contain unique, non-empty opaque ids without whitespace or wildcards",
        });
        return z.NEVER;
      }
      seen.add(entry);
    }
    return entries;
  });

/**
 * Shared Phase 5 operational bounds. Security-sensitive byte and batch caps
 * may be lowered by deployment configuration but can never be widened beyond
 * the reviewed limits here.
 */
export const phase5EnvSchema = z
  .object({
    IDEMPOTENCY_ENCRYPTION_KEY: base64UrlKeySchema,
    BACKUP_ENCRYPTION_KEY: base64UrlKeySchema,
    IDEMPOTENCY_LEASE_SECONDS: integerEnv(60, 1, 300),
    PHASE5_OPERATOR_IDS: operatorAllowlistSchema,

    JOB_LOCK_TIMEOUT_SECONDS: integerEnv(300, 1, 3_600),
    JOB_MAX_ATTEMPTS: integerEnv(5, 1, 20),
    JOB_BACKOFF_BASE_SECONDS: integerEnv(5, 1, 300),
    JOB_BACKOFF_CAP_SECONDS: integerEnv(300, 1, 3_600),

    THUMBNAIL_MAX_SOURCE_BYTES: integerEnv(5_242_880, 1, 5_242_880),
    THUMBNAIL_MAX_PIXELS: integerEnv(40_000_000, 1, 40_000_000),
    THUMBNAIL_MAX_OUTPUT_BYTES: integerEnv(262_144, 1, 262_144),
    ASSET_MAX_BYTES: integerEnv(5_242_880, 1, 5_242_880),
    ASSET_WORKSPACE_QUOTA_BYTES: integerEnv(104_857_600, 1, 104_857_600),

    ASSET_DELETE_GRACE_DAYS: integerEnv(30, 1, 3_650),
    EXPORT_RETENTION_DAYS: integerEnv(30, 1, 3_650),
    IMPORT_STAGING_GRACE_SECONDS: integerEnv(3_600, 1, 31_536_000),
    SHARE_DELETE_GRACE_SECONDS: integerEnv(3_600, 1, 31_536_000),
    VERSION_RETENTION_DAYS: integerEnv(30, 1, 3_650),
    IDEMPOTENCY_RETENTION_DAYS: integerEnv(30, 1, 3_650),
    WORKSPACE_PURGE_GRACE_SECONDS: integerEnv(86_400, 1, 31_536_000),
    AUDIT_LOG_RETENTION_DAYS: integerEnv(90, 1, 3_650),
    DELETION_DEADLINE_DAYS: integerEnv(30, 1, 365),

    SHARE_CLEANUP_BATCH_SIZE: integerEnv(100, 1, 100),
    ASSET_CLEANUP_BATCH_SIZE: integerEnv(100, 1, 100),
    EXPORT_CLEANUP_BATCH_SIZE: integerEnv(100, 1, 100),
    IMPORT_CLEANUP_BATCH_SIZE: integerEnv(100, 1, 100),
    VERSION_CLEANUP_BATCH_SIZE: integerEnv(100, 1, 100),
    IDEMPOTENCY_CLEANUP_BATCH_SIZE: integerEnv(100, 1, 100),
  })
  .superRefine((value, context) => {
    if (value.JOB_BACKOFF_BASE_SECONDS > value.JOB_BACKOFF_CAP_SECONDS) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["JOB_BACKOFF_BASE_SECONDS"],
        message: "must not exceed JOB_BACKOFF_CAP_SECONDS",
      });
    }
  });

export type Phase5Env = z.output<typeof phase5EnvSchema>;
