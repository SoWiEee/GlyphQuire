import { migrate } from "drizzle-orm/postgres-js/migrator";
import { fileURLToPath } from "node:url";
import { migrationEnvSchema } from "@glyphquire/shared";
import { createDb } from "./client.js";
import { verifyMigrationBaseline } from "./migrations/verify-baseline.js";

const parsed = migrationEnvSchema.safeParse(process.env);
if (!parsed.success) {
  throw new Error("MIGRATION_DATABASE_URL environment variable is required");
}

const migrationsFolder = fileURLToPath(new URL("./migrations", import.meta.url));
await verifyMigrationBaseline(parsed.data.MIGRATION_DATABASE_URL, migrationsFolder);

const db = createDb(parsed.data.MIGRATION_DATABASE_URL);
try {
  await migrate(db, { migrationsFolder });
} finally {
  await db.$client.end();
}

console.log("Migrations complete");
