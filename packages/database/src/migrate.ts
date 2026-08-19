import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb } from "./client.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL environment variable is required");
  process.exit(1);
}

const db = createDb(databaseUrl);

await migrate(db, { migrationsFolder: "./src/migrations" });

console.log("Migrations complete");
process.exit(0);
