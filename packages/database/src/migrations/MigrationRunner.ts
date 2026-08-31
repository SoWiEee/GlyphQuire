import { migrate as drizzleMigrate } from "drizzle-orm/postgres-js/migrator";
import { createDb, type Database } from "../client.js";
import {
  readRepositoryMigrations,
  verifyMigrationBaseline,
  type BaselineVerificationResult,
  type RepositoryMigration,
} from "./verify-baseline.js";

export interface MigrationCatalog {
  directory: string;
  migrations: readonly RepositoryMigration[];
}

export interface MigrationRunnerOptions {
  databaseUrl: string;
  migrationsDirectory: string;
}

/**
 * Single migration composition boundary. Catalog loading, baseline validation,
 * ordered Drizzle execution, and journal checks are intentionally coordinated
 * here so CLI and embedded callers cannot drift into separate migration paths.
 */
export class MigrationRunner {
  constructor(private readonly options: MigrationRunnerOptions) {}

  async loadCatalog(): Promise<MigrationCatalog> {
    return {
      directory: this.options.migrationsDirectory,
      migrations: await readRepositoryMigrations(this.options.migrationsDirectory),
    };
  }

  async verifyBaseline(): Promise<BaselineVerificationResult> {
    return verifyMigrationBaseline(this.options.databaseUrl, this.options.migrationsDirectory);
  }

  async execute(database: Database, catalog?: MigrationCatalog): Promise<void> {
    const resolvedCatalog = catalog ?? (await this.loadCatalog());
    await drizzleMigrate(database, { migrationsFolder: resolvedCatalog.directory });
  }

  async run(): Promise<BaselineVerificationResult> {
    const catalog = await this.loadCatalog();
    const baseline = await this.verifyBaseline();
    const database = createDb(this.options.databaseUrl);
    try {
      await this.execute(database, catalog);
    } finally {
      await database.$client.end();
    }
    return baseline;
  }
}
