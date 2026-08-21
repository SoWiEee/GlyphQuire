import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import { account } from "./auth.js";
import { workspaceMembers, workspaces, type WorkspaceRole } from "./workspaces.js";
import {
  PHASE0_AUTH_SNAPSHOT_SHA256,
  PHASE0_AUTH_SQL_SHA256,
  PHASE0_AUTH_TABLES,
  readRepositoryMigrations,
} from "../migrations/verify-baseline.js";

const migrationsDirectory = fileURLToPath(new URL("../migrations/", import.meta.url));

async function copyMigrationRepository(
  temporaryDirectory: string,
  changes: { sqlSuffix?: string; snapshotSuffix?: string },
) {
  const temporaryMetaDirectory = join(temporaryDirectory, "meta");
  await mkdir(temporaryMetaDirectory);
  await Promise.all([
    writeFile(
      join(temporaryMetaDirectory, "_journal.json"),
      await readFile(join(migrationsDirectory, "meta", "_journal.json")),
    ),
    writeFile(
      join(temporaryMetaDirectory, "0000_snapshot.json"),
      Buffer.concat([
        await readFile(join(migrationsDirectory, "meta", "0000_snapshot.json")),
        Buffer.from(changes.snapshotSuffix ?? ""),
      ]),
    ),
    writeFile(
      join(temporaryDirectory, "0000_phase0_auth.sql"),
      `${await readFile(join(migrationsDirectory, "0000_phase0_auth.sql"), "utf8")}${changes.sqlSuffix ?? ""}`,
    ),
    writeFile(
      join(temporaryDirectory, "0001_phase2_workspaces.sql"),
      await readFile(join(migrationsDirectory, "0001_phase2_workspaces.sql")),
    ),
  ]);
}

describe("workspace schema", () => {
  it("scopes Better Auth account identity to issuer and account ID", () => {
    const accountConfig = getTableConfig(account);
    const issuer = accountConfig.columns.find((column) => column.name === "issuer");
    const identityIndex = accountConfig.indexes.find(
      (index) => index.config.name === "account_issuer_accountId_uidx",
    );

    expect(issuer?.notNull).toBe(true);
    expect(issuer?.hasDefault).toBe(false);
    expect(identityIndex?.config.unique).toBe(true);
    expect(
      identityIndex?.config.columns.map((column) => ("name" in column ? column.name : undefined)),
    ).toEqual(["issuer", "account_id"]);
  });

  it("uses random UUID public identifiers", () => {
    const workspaceConfig = getTableConfig(workspaces);
    const memberConfig = getTableConfig(workspaceMembers);

    const workspaceId = workspaceConfig.columns.find((column) => column.name === "id");
    const membershipId = memberConfig.columns.find((column) => column.name === "id");

    expect(workspaceId?.getSQLType()).toBe("uuid");
    expect(workspaceId?.hasDefault).toBe(true);
    expect(membershipId?.getSQLType()).toBe("uuid");
    expect(membershipId?.hasDefault).toBe(true);
  });

  it("constrains membership roles and personal workspace ownership", () => {
    const workspaceConfig = getTableConfig(workspaces);
    const memberConfig = getTableConfig(workspaceMembers);

    expect(workspaceConfig.indexes.map((index) => index.config.name)).toContain(
      "workspaces_personal_owner_id_unique",
    );
    expect(memberConfig.indexes.map((index) => index.config.name)).toContain(
      "workspace_members_workspace_user_unique",
    );
    expect(memberConfig.checks.map((check) => check.name)).toContain(
      "workspace_members_role_check",
    );

    const supportedRoles: WorkspaceRole[] = ["owner", "editor", "viewer"];
    expect(supportedRoles).toEqual(["owner", "editor", "viewer"]);
  });
});

describe("workspace migrations", () => {
  it("commits the exact ordered Phase 0 and Phase 2 journal", async () => {
    const migrations = await readRepositoryMigrations(migrationsDirectory);

    expect(migrations.map(({ idx, tag }) => ({ idx, tag }))).toEqual([
      { idx: 0, tag: "0000_phase0_auth" },
      { idx: 1, tag: "0001_phase2_workspaces" },
    ]);
    expect(migrations.every((migration) => /^[a-f0-9]{64}$/.test(migration.hash))).toBe(true);
    expect(new Set(migrations.map((migration) => migration.when)).size).toBe(2);
    expect(migrations[0]?.hash).toBe(PHASE0_AUTH_SQL_SHA256);
    expect(PHASE0_AUTH_SNAPSHOT_SHA256).toBe(
      "ddbdd01656f226667fc4e9b8533d946d8d57ed643d580ade86d4451a27c0be66",
    );
  });

  it("rejects a changed Phase 0 SQL file even when the journal identity is unchanged", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "glyphquire-migrations-"));

    try {
      await copyMigrationRepository(temporaryDirectory, { sqlSuffix: "\n-- changed\n" });

      await expect(readRepositoryMigrations(temporaryDirectory)).rejects.toThrow(
        "Phase 0 auth SQL hash",
      );
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("rejects a changed Phase 0 snapshot", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "glyphquire-migrations-"));

    try {
      await copyMigrationRepository(temporaryDirectory, { snapshotSuffix: "\n" });
      await expect(readRepositoryMigrations(temporaryDirectory)).rejects.toThrow(
        "Phase 0 auth snapshot hash",
      );
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("locks the Phase 0 fingerprint to all four Better Auth tables", () => {
    expect(PHASE0_AUTH_TABLES).toEqual(["account", "session", "user", "verification"]);
  });

  it("encodes database-enforced race and role constraints", async () => {
    const sql = await readFile(
      new URL("../migrations/0001_phase2_workspaces.sql", import.meta.url),
      "utf8",
    );

    expect(sql).toContain('"workspaces_personal_owner_id_unique"');
    expect(sql).toContain('"workspace_members_workspace_user_unique"');
    expect(sql).toContain('"workspace_members_role_check"');
    expect(sql).toMatch(/role.+owner.+editor.+viewer/s);
  });
});
