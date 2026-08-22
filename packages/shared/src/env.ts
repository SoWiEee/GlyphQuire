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
