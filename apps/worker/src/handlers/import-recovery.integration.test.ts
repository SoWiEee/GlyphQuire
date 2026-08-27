import { createHash, randomUUID } from "node:crypto";
import type { JobEnvelope } from "@glyphquire/api-contract/jobs";
import {
  assets,
  createDb,
  importResources,
  imports,
  notes,
  user,
  workspaceMembers,
  workspaces,
  type Database,
} from "@glyphquire/database";
import { InMemoryObjectStorage } from "@glyphquire/storage";
import { eq } from "drizzle-orm";
import { strToU8, zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createImportCleanupHandler } from "./import-cleanup.js";
import { createImportHandler } from "./import.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;
const MARKDOWN = "---\nglyphquire-spec: 1\n---\n\n# Imported note\n\nbody";

function importJob(workspaceId: string, importId: string, actorId: string): JobEnvelope<"import"> {
  return {
    id: randomUUID(),
    workspaceId,
    type: "import",
    version: 1,
    attempts: 1,
    createdAt: new Date().toISOString(),
    payload: { workspaceId, importId, actorId },
  };
}

describeWithPostgres("import crash recovery", () => {
  let db: Database;

  beforeAll(() => {
    db = createDb(databaseUrl!);
  });

  afterAll(async () => {
    await db.$client.end();
  });

  async function stagedImport(storage: InMemoryObjectStorage, createdAt = new Date()) {
    const actorId = `worker-import-${randomUUID()}`;
    await db.insert(user).values({
      id: actorId,
      name: "Worker import",
      email: `${actorId}@example.test`,
    });
    const [workspace] = await db
      .insert(workspaces)
      .values({ personalOwnerId: actorId })
      .returning({ id: workspaces.id });
    await db
      .insert(workspaceMembers)
      .values({ workspaceId: workspace!.id, userId: actorId, role: "owner" });
    const importId = randomUUID();
    const sourceObjectKey = `workspace/${workspace!.id}/imports/${importId}/source`;
    const body = Buffer.from(MARKDOWN);
    const sourceSha256 = createHash("sha256").update(body).digest("hex");
    await db.insert(imports).values({
      id: importId,
      workspaceId: workspace!.id,
      actorId,
      sourceObjectKey,
      status: "pending",
      compensationStatus: "none",
      expiresAt: new Date(createdAt.getTime() + 86_400_000),
      idempotencyKey: randomUUID(),
      requestHash: "a".repeat(64),
      manifest: {
        version: 1,
        source: {
          sizeBytes: body.byteLength,
          sha256: sourceSha256,
          contentType: "text/markdown",
        },
        progress: { completedItems: 0, totalItems: 0, processedBytes: 0, totalBytes: 0 },
      },
      createdAt,
      updatedAt: createdAt,
    });
    await storage.put({
      key: sourceObjectKey,
      body,
      contentType: "text/markdown",
      contentLength: body.byteLength,
      sha256: sourceSha256,
    });
    return { actorId, workspaceId: workspace!.id, importId, sourceObjectKey };
  }

  it("keeps the note invisible until finalization and treats post-commit replay as completed", async () => {
    const storage = new InMemoryObjectStorage();
    const staged = await stagedImport(storage);
    let finalized = false;
    const handler = createImportHandler({
      database: db,
      storage,
      hooks: {
        async beforeFinalization() {
          const visible = await db
            .select({ id: notes.id })
            .from(notes)
            .where(eq(notes.workspaceId, staged.workspaceId));
          expect(visible).toHaveLength(0);
        },
        afterFinalizationCommit() {
          if (!finalized) {
            finalized = true;
            throw new Error("simulated process crash after commit");
          }
        },
      },
    });

    await expect(
      handler(
        importJob(staged.workspaceId, staged.importId, staged.actorId),
        new AbortController().signal,
      ),
    ).resolves.toBeUndefined();
    await expect(
      handler(
        importJob(staged.workspaceId, staged.importId, staged.actorId),
        new AbortController().signal,
      ),
    ).resolves.toBeUndefined();

    const [row] = await db.select().from(imports).where(eq(imports.id, staged.importId)).limit(1);
    expect(row).toMatchObject({ status: "completed", compensationStatus: "none" });
    expect(JSON.stringify(row!.manifest)).not.toContain(MARKDOWN);
    const created = await db.select().from(notes).where(eq(notes.workspaceId, staged.workspaceId));
    expect(created).toHaveLength(1);
    expect(created[0]!.contentMarkdown).toContain("# Imported note");
  });

  it("cleans only an owned, grace-aged staging resource", async () => {
    const now = Date.now();
    const storage = new InMemoryObjectStorage();
    const staged = await stagedImport(storage, new Date(now - 3_600_000));
    await db
      .update(imports)
      .set({ status: "failed", compensationStatus: "required" })
      .where(eq(imports.id, staged.importId));
    const resourceId = randomUUID();
    const resourceKey = `workspace/${staged.workspaceId}/imports/${staged.importId}/resources/${resourceId}`;
    await db.insert(importResources).values({
      id: resourceId,
      importId: staged.importId,
      workspaceId: staged.workspaceId,
      assetId: randomUUID(),
      objectKey: resourceKey,
      state: "uploaded",
      createdAt: new Date(now - 3_600_000),
      updatedAt: new Date(now - 3_600_000),
    });
    const body = Buffer.from("resource");
    await storage.put({
      key: resourceKey,
      body,
      contentType: "application/octet-stream",
      contentLength: body.byteLength,
      sha256: createHash("sha256").update(body).digest("hex"),
    });
    const cleanup = createImportCleanupHandler({
      database: db,
      storage,
      graceSeconds: 3_600,
      clock: () => now,
    });

    await cleanup(
      {
        id: randomUUID(),
        workspaceId: staged.workspaceId,
        type: "import.cleanup",
        version: 1,
        attempts: 1,
        createdAt: new Date().toISOString(),
        payload: { workspaceId: staged.workspaceId, scope: "one", importId: staged.importId },
      },
      new AbortController().signal,
    );

    expect(storage.has(resourceKey)).toBe(false);
    expect(storage.has(staged.sourceObjectKey)).toBe(false);
    const [resource] = await db
      .select()
      .from(importResources)
      .where(eq(importResources.id, resourceId));
    expect(resource!.state).toBe("cleaned");
    const [row] = await db.select().from(imports).where(eq(imports.id, staged.importId));
    expect(row!.compensationStatus).toBe("completed");
  });

  it("declares ZIP resources before upload and resumes idempotently after an external-put crash", async () => {
    const storage = new InMemoryObjectStorage();
    const staged = await stagedImport(storage);
    const archive = Buffer.from(
      zipSync({
        "note.md": strToU8("---\nglyphquire-spec: 1\n---\n\n# ZIP import\n\n![pixel](pixel.png)"),
        "pixel.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]),
      }),
    );
    const sha256 = createHash("sha256").update(archive).digest("hex");
    await storage.put({
      key: staged.sourceObjectKey,
      body: archive,
      contentType: "application/zip",
      contentLength: archive.byteLength,
      sha256,
    });
    await db
      .update(imports)
      .set({
        manifest: {
          version: 1,
          source: {
            sizeBytes: archive.byteLength,
            sha256,
            contentType: "application/zip",
            kind: "zip",
          },
          progress: { completedItems: 0, totalItems: 0, processedBytes: 0, totalBytes: 0 },
        },
      })
      .where(eq(imports.id, staged.importId));
    let crashed = false;
    const handler = createImportHandler({
      database: db,
      storage,
      hooks: {
        afterResourcePut() {
          if (!crashed) {
            crashed = true;
            throw new Error("simulated crash after resource put");
          }
        },
      },
    });

    await expect(
      handler(
        importJob(staged.workspaceId, staged.importId, staged.actorId),
        new AbortController().signal,
      ),
    ).rejects.toThrow("JOB_FAILED");
    const [declared] = await db
      .select()
      .from(importResources)
      .where(eq(importResources.importId, staged.importId));
    expect(declared?.state).toBe("declared");
    expect(declared && storage.has(declared.objectKey)).toBe(true);

    await handler(
      importJob(staged.workspaceId, staged.importId, staged.actorId),
      new AbortController().signal,
    );

    const [completed] = await db.select().from(imports).where(eq(imports.id, staged.importId));
    expect(completed).toMatchObject({ status: "completed", compensationStatus: "none" });
    const [resource] = await db
      .select()
      .from(importResources)
      .where(eq(importResources.importId, staged.importId));
    expect(resource?.state).toBe("promoted");
    const [asset] = await db
      .select()
      .from(assets)
      .where(eq(assets.workspaceId, staged.workspaceId));
    expect(asset).toMatchObject({ id: resource?.assetId, objectKey: resource?.objectKey });
    const [note] = await db.select().from(notes).where(eq(notes.workspaceId, staged.workspaceId));
    expect(note?.contentMarkdown).toContain(`asset://${resource?.assetId}`);
    expect(JSON.stringify(completed!.manifest)).not.toContain("ZIP import");
  });

  it("does not let cleanup claim an active processing import", async () => {
    const now = Date.now();
    const storage = new InMemoryObjectStorage();
    const staged = await stagedImport(storage, new Date(now - 3_600_000));
    await db
      .update(imports)
      .set({ status: "processing", compensationStatus: "none" })
      .where(eq(imports.id, staged.importId));
    const cleanup = createImportCleanupHandler({
      database: db,
      storage,
      graceSeconds: 3_600,
      clock: () => now,
    });

    await cleanup(
      {
        id: randomUUID(),
        workspaceId: staged.workspaceId,
        type: "import.cleanup",
        version: 1,
        attempts: 1,
        createdAt: new Date().toISOString(),
        payload: { workspaceId: staged.workspaceId, scope: "one", importId: staged.importId },
      },
      new AbortController().signal,
    );

    expect(storage.has(staged.sourceObjectKey)).toBe(true);
    const [row] = await db.select().from(imports).where(eq(imports.id, staged.importId));
    expect(row).toMatchObject({ status: "processing", compensationStatus: "none" });
  });

  it("does not restart an import while its compensator owns the row", async () => {
    const storage = new InMemoryObjectStorage();
    const staged = await stagedImport(storage);
    await db
      .update(imports)
      .set({ status: "failed", compensationStatus: "running" })
      .where(eq(imports.id, staged.importId));
    const handler = createImportHandler({ database: db, storage });

    await handler(
      importJob(staged.workspaceId, staged.importId, staged.actorId),
      new AbortController().signal,
    );

    const [row] = await db.select().from(imports).where(eq(imports.id, staged.importId));
    expect(row).toMatchObject({ status: "failed", compensationStatus: "running" });
    const visible = await db
      .select({ id: notes.id })
      .from(notes)
      .where(eq(notes.workspaceId, staged.workspaceId));
    expect(visible).toHaveLength(0);
  });

  it("preserves the expired terminal status when scheduling compensation", async () => {
    const now = Date.now();
    const storage = new InMemoryObjectStorage();
    const staged = await stagedImport(storage, new Date(now - 2 * 86_400_000));
    const handler = createImportHandler({ database: db, storage, clock: () => now });

    await handler(
      importJob(staged.workspaceId, staged.importId, staged.actorId),
      new AbortController().signal,
    );

    const [row] = await db.select().from(imports).where(eq(imports.id, staged.importId));
    expect(row).toMatchObject({
      status: "expired",
      compensationStatus: "required",
      lastError: "IMPORT_INVALID",
    });
  });
});
