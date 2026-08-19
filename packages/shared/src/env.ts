import { z } from "zod";

export const databaseEnvSchema = z.object({
  DATABASE_URL: z.string().url(),
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

export const appEnvSchema = z.object({
  API_PORT: z.coerce.number().default(3000),
  WEB_PORT: z.coerce.number().default(5173),
  CORS_ORIGIN: z.string().url().default("http://localhost:5173"),
});
