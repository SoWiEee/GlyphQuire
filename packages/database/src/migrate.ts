import { fileURLToPath } from "node:url";
import { migrationEnvSchema } from "@glyphquire/shared";
import { MigrationRunner } from "./migrations/MigrationRunner.js";

const parsed = migrationEnvSchema.safeParse(process.env);
if (!parsed.success) {
  throw new Error("MIGRATION_DATABASE_URL environment variable is required");
}

const migrationsFolder = fileURLToPath(new URL("./migrations", import.meta.url));
const runner = new MigrationRunner({
  databaseUrl: parsed.data.MIGRATION_DATABASE_URL,
  migrationsDirectory: migrationsFolder,
});
await runner.run();

console.log("Migrations complete");
