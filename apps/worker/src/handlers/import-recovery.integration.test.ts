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

function importJob(
  workspaceId: string,
  importId: string,
  actorId: string,
  options: { id?: string; attempts?: number } = {},
): JobEnvelope<"import"> {
  return {
    id: options.id ?? randomUUID(),
    workspaceId,
    type: "import",
    version: 1,
    attempts: options.attempts ?? 1,
    createdAt: new Date().toISOString(),
    payload: { workspaceId, importId, actorId },
  };
}

function cleanupJob(
  workspaceId: string,
  importId: string,
  options: { id?: string; attempts?: number } = {},
): JobEnvelope<"import.cleanup"> {
  return {
    id: options.id ?? randomUUID(),
    workspaceId,
    type: "import.cleanup",
    version: 1,
    attempts: options.attempts ?? 1,
    createdAt: new Date().toISOString(),
    payload: { workspaceId, scope: "one", importId },
  };
}

function stagingCleanupJob(
  workspaceId: string,
  options: { id?: string; attempts?: number; batchSize?: number } = {},
): JobEnvelope<"import.cleanup"> {
  return {
    id: options.id ?? randomUUID(),
    workspaceId,
    type: "import.cleanup",
    version: 1,
    attempts: options.attempts ?? 1,
    createdAt: new Date().toISOString(),
    payload: {
      workspaceId,
      scope: "staging",
      batchSize: options.batchSize ?? 10,
    },
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const malformedLifecycleOwners = [
  {
    name: "empty job id",
    create(now: number) {
      return {
        kind: "cleanup",
        jobId: "",
        attempt: 1,
        leaseExpiresAt: new Date(now - 1).toISOString(),
      };
    },
  },
  {
    name: "non-canonical job id",
    create(now: number) {
      return {
        kind: "cleanup",
        jobId: randomUUID().toUpperCase(),
        attempt: 1,
        leaseExpiresAt: new Date(now - 1).toISOString(),
      };
    },
  },
  {
    name: "non-integer attempt",
    create(now: number) {
      return {
        kind: "cleanup",
        jobId: randomUUID(),
        attempt: 1.5,
        leaseExpiresAt: new Date(now - 1).toISOString(),
      };
    },
  },
  {
    name: "non-canonical lease timestamp",
    create(now: number) {
      return {
        kind: "cleanup",
        jobId: randomUUID(),
        attempt: 1,
        leaseExpiresAt: new Date(now - 1).toISOString().replace("Z", "+00:00"),
      };
    },
  },
] as const;

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
    const jobId = randomUUID();
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
        importJob(staged.workspaceId, staged.importId, staged.actorId, { id: jobId, attempts: 1 }),
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
      importJob(staged.workspaceId, staged.importId, staged.actorId, { id: jobId, attempts: 2 }),
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

  it("recovers an exhausted processing import through the staging cleanup scan", async () => {
    const now = Date.now();
    const storage = new InMemoryObjectStorage();
    const staged = await stagedImport(storage, new Date(now - 3_600_001));
    const [row] = await db.select().from(imports).where(eq(imports.id, staged.importId));
    // A stale queue reclaim increments beyond max attempts and dead-letters before
    // re-entering the handler, so the last persisted lifecycle owner remains here.
    await db
      .update(imports)
      .set({
        status: "processing",
        compensationStatus: "none",
        manifest: {
          ...row!.manifest,
          _lifecycle: {
            kind: "import",
            jobId: randomUUID(),
            attempt: 5,
            leaseExpiresAt: new Date(now - 1).toISOString(),
          },
        },
      })
      .where(eq(imports.id, staged.importId));
    const cleanup = createImportCleanupHandler({
      database: db,
      storage,
      graceSeconds: 3_600,
      clock: () => now,
    });

    await cleanup(
      stagingCleanupJob(staged.workspaceId, { attempts: 1 }),
      new AbortController().signal,
    );

    expect(storage.has(staged.sourceObjectKey)).toBe(false);
    const [recovered] = await db.select().from(imports).where(eq(imports.id, staged.importId));
    expect(recovered).toMatchObject({ status: "expired", compensationStatus: "completed" });
    expect(recovered!.manifest).not.toHaveProperty("_lifecycle");
  });

  it("recovers an exhausted cleanup owner through the staging cleanup scan", async () => {
    const now = Date.now();
    const storage = new InMemoryObjectStorage();
    const staged = await stagedImport(storage, new Date(now - 3_600_001));
    const [row] = await db.select().from(imports).where(eq(imports.id, staged.importId));
    await db
      .update(imports)
      .set({
        status: "failed",
        compensationStatus: "running",
        manifest: {
          ...row!.manifest,
          _lifecycle: {
            kind: "cleanup",
            jobId: randomUUID(),
            attempt: 5,
            leaseExpiresAt: new Date(now - 1).toISOString(),
          },
        },
      })
      .where(eq(imports.id, staged.importId));
    const cleanup = createImportCleanupHandler({
      database: db,
      storage,
      graceSeconds: 3_600,
      clock: () => now,
    });

    await cleanup(
      stagingCleanupJob(staged.workspaceId, { attempts: 1 }),
      new AbortController().signal,
    );

    expect(storage.has(staged.sourceObjectKey)).toBe(false);
    const [recovered] = await db.select().from(imports).where(eq(imports.id, staged.importId));
    expect(recovered).toMatchObject({ status: "failed", compensationStatus: "completed" });
    expect(recovered!.manifest).not.toHaveProperty("_lifecycle");
  });

  for (const scope of ["one", "staging"] as const) {
    it.each(malformedLifecycleOwners)(
      `keeps a $name lifecycle owner fail-closed for scope:${scope}`,
      async ({ create }) => {
        const now = Date.now();
        const storage = new InMemoryObjectStorage();
        const staged = await stagedImport(storage, new Date(now - 3_600_001));
        const [row] = await db.select().from(imports).where(eq(imports.id, staged.importId));
        const malformedOwner = create(now);
        await db
          .update(imports)
          .set({
            status: "failed",
            compensationStatus: "running",
            manifest: { ...row!.manifest, _lifecycle: malformedOwner },
            updatedAt: new Date(now - 3_600_001),
          })
          .where(eq(imports.id, staged.importId));
        const cleanup = createImportCleanupHandler({
          database: db,
          storage,
          graceSeconds: 3_600,
          clock: () => now,
        });

        const cleanupRun = cleanup(
          scope === "one"
            ? cleanupJob(staged.workspaceId, staged.importId)
            : stagingCleanupJob(staged.workspaceId),
          new AbortController().signal,
        );
        if (scope === "one") await expect(cleanupRun).rejects.toThrow("JOB_FAILED");
        else await expect(cleanupRun).resolves.toBeUndefined();

        expect(storage.has(staged.sourceObjectKey)).toBe(true);
        const [preserved] = await db.select().from(imports).where(eq(imports.id, staged.importId));
        expect(preserved).toMatchObject({ status: "failed", compensationStatus: "running" });
        expect(preserved!.manifest).toHaveProperty("_lifecycle", malformedOwner);
      },
    );
  }

  it("keeps active lifecycle owners and completed imports out of the staging cleanup scan", async () => {
    const now = Date.now();
    const storage = new InMemoryObjectStorage();
    const processing = await stagedImport(storage, new Date(now - 3_600_001));
    const [processingRow] = await db
      .select()
      .from(imports)
      .where(eq(imports.id, processing.importId));
    await db
      .update(imports)
      .set({
        status: "processing",
        compensationStatus: "none",
        manifest: {
          ...processingRow!.manifest,
          _lifecycle: {
            kind: "import",
            jobId: randomUUID(),
            attempt: 5,
            leaseExpiresAt: new Date(now + 1).toISOString(),
          },
        },
      })
      .where(eq(imports.id, processing.importId));
    const cleanup = createImportCleanupHandler({
      database: db,
      storage,
      graceSeconds: 3_600,
      clock: () => now,
    });

    await cleanup(stagingCleanupJob(processing.workspaceId), new AbortController().signal);

    const [activeImport] = await db
      .select()
      .from(imports)
      .where(eq(imports.id, processing.importId));
    expect(activeImport).toMatchObject({ status: "processing", compensationStatus: "none" });
    expect(storage.has(processing.sourceObjectKey)).toBe(true);

    await db
      .update(imports)
      .set({
        status: "failed",
        compensationStatus: "running",
        manifest: {
          ...activeImport!.manifest,
          _lifecycle: {
            kind: "cleanup",
            jobId: randomUUID(),
            attempt: 5,
            leaseExpiresAt: new Date(now + 1).toISOString(),
          },
        },
      })
      .where(eq(imports.id, processing.importId));

    await cleanup(stagingCleanupJob(processing.workspaceId), new AbortController().signal);

    const [activeCleanup] = await db
      .select()
      .from(imports)
      .where(eq(imports.id, processing.importId));
    expect(activeCleanup).toMatchObject({ status: "failed", compensationStatus: "running" });
    expect(storage.has(processing.sourceObjectKey)).toBe(true);

    await db
      .update(imports)
      .set({
        status: "completed",
        compensationStatus: "none",
        manifest: processingRow!.manifest,
      })
      .where(eq(imports.id, processing.importId));

    await cleanup(stagingCleanupJob(processing.workspaceId), new AbortController().signal);

    const [completed] = await db.select().from(imports).where(eq(imports.id, processing.importId));
    expect(completed).toMatchObject({ status: "completed", compensationStatus: "none" });
    expect(storage.has(processing.sourceObjectKey)).toBe(true);
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

  it("reclaims a crashed processing owner only after its persisted lease expires", async () => {
    const startedAt = Date.now();
    let now = startedAt;
    const storage = new InMemoryObjectStorage();
    const staged = await stagedImport(storage);
    const [row] = await db.select().from(imports).where(eq(imports.id, staged.importId));
    const jobId = randomUUID();
    await db
      .update(imports)
      .set({
        status: "processing",
        manifest: {
          ...row!.manifest,
          _lifecycle: {
            kind: "import",
            jobId,
            attempt: 1,
            leaseExpiresAt: new Date(startedAt + 300_000).toISOString(),
          },
        },
      })
      .where(eq(imports.id, staged.importId));
    const handler = createImportHandler({ database: db, storage, clock: () => now });

    await expect(
      handler(
        importJob(staged.workspaceId, staged.importId, staged.actorId, {
          id: jobId,
          attempts: 2,
        }),
        new AbortController().signal,
      ),
    ).rejects.toThrow("JOB_FAILED");

    now = startedAt + 300_000;
    await handler(
      importJob(staged.workspaceId, staged.importId, staged.actorId, {
        id: jobId,
        attempts: 3,
      }),
      new AbortController().signal,
    );

    const [completed] = await db.select().from(imports).where(eq(imports.id, staged.importId));
    expect(completed).toMatchObject({ status: "completed", compensationStatus: "none" });
    expect(completed!.manifest).not.toHaveProperty("_lifecycle");
  });

  it("fences a reclaimed import attempt and cleanup while the original handler is active", async () => {
    const now = Date.now();
    const storage = new InMemoryObjectStorage();
    const staged = await stagedImport(storage, new Date(now - 3_600_000));
    const reachedFinalization = deferred();
    const releaseFinalization = deferred();
    const jobId = randomUUID();
    const first = createImportHandler({
      database: db,
      storage,
      hooks: {
        async beforeFinalization() {
          reachedFinalization.resolve();
          await releaseFinalization.promise;
        },
      },
    });
    const reclaimed = createImportHandler({ database: db, storage });
    const cleanup = createImportCleanupHandler({
      database: db,
      storage,
      graceSeconds: 3_600,
      clock: () => now,
    });
    const firstRun = first(
      importJob(staged.workspaceId, staged.importId, staged.actorId, { id: jobId, attempts: 1 }),
      new AbortController().signal,
    );
    await reachedFinalization.promise;

    try {
      await expect(
        reclaimed(
          importJob(staged.workspaceId, staged.importId, staged.actorId, {
            id: jobId,
            attempts: 2,
          }),
          new AbortController().signal,
        ),
      ).rejects.toThrow("JOB_FAILED");
      await expect(
        cleanup(cleanupJob(staged.workspaceId, staged.importId), new AbortController().signal),
      ).rejects.toThrow("JOB_FAILED");
    } finally {
      releaseFinalization.resolve();
      await firstRun.catch(() => undefined);
    }

    const [row] = await db.select().from(imports).where(eq(imports.id, staged.importId));
    expect(row).toMatchObject({ status: "completed", compensationStatus: "none" });
    expect(storage.has(staged.sourceObjectKey)).toBe(true);
  });

  it("rejects a cleaned resource after put, removes the orphan, and requires compensation", async () => {
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
    let resourceKey: string | undefined;
    const handler = createImportHandler({
      database: db,
      storage,
      hooks: {
        async afterResourcePut(resourceId) {
          const [resource] = await db
            .select()
            .from(importResources)
            .where(eq(importResources.id, resourceId));
          resourceKey = resource?.objectKey;
          await db
            .update(importResources)
            .set({ state: "cleaned" })
            .where(eq(importResources.id, resourceId));
        },
      },
    });

    await expect(
      handler(
        importJob(staged.workspaceId, staged.importId, staged.actorId),
        new AbortController().signal,
      ),
    ).rejects.toThrow("JOB_FAILED");

    expect(resourceKey).toBeDefined();
    expect(storage.has(resourceKey!)).toBe(false);
    const [row] = await db.select().from(imports).where(eq(imports.id, staged.importId));
    expect(row).toMatchObject({ status: "failed", compensationStatus: "required" });
  });

  it("lets only one cleanup attempt delete an import", async () => {
    const now = Date.now();
    const enteredDelete = deferred();
    const releaseDelete = deferred();
    let paused = false;
    const resource = { key: "" };
    const deleteCounts = new Map<string, number>();
    const storage = new InMemoryObjectStorage({
      async beforeDelete(key) {
        deleteCounts.set(key, (deleteCounts.get(key) ?? 0) + 1);
        if (key === resource.key && !paused) {
          paused = true;
          enteredDelete.resolve();
          await releaseDelete.promise;
        }
      },
    });
    const staged = await stagedImport(storage, new Date(now - 3_600_000));
    await db
      .update(imports)
      .set({ status: "failed", compensationStatus: "required" })
      .where(eq(imports.id, staged.importId));
    const resourceId = randomUUID();
    resource.key = `workspace/${staged.workspaceId}/imports/${staged.importId}/resources/${resourceId}`;
    await db.insert(importResources).values({
      id: resourceId,
      importId: staged.importId,
      workspaceId: staged.workspaceId,
      assetId: randomUUID(),
      objectKey: resource.key,
      state: "uploaded",
      createdAt: new Date(now - 3_600_000),
      updatedAt: new Date(now - 3_600_000),
    });
    const body = Buffer.from("resource");
    await storage.put({
      key: resource.key,
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
    const jobId = randomUUID();
    const firstRun = cleanup(
      cleanupJob(staged.workspaceId, staged.importId, { id: jobId, attempts: 1 }),
      new AbortController().signal,
    );
    await enteredDelete.promise;

    try {
      await expect(
        cleanup(
          cleanupJob(staged.workspaceId, staged.importId, { id: jobId, attempts: 2 }),
          new AbortController().signal,
        ),
      ).rejects.toThrow("JOB_FAILED");
    } finally {
      releaseDelete.resolve();
      await firstRun;
    }

    expect(deleteCounts.get(resource.key)).toBe(1);
    expect(deleteCounts.get(staged.sourceObjectKey)).toBe(1);
    const [row] = await db.select().from(imports).where(eq(imports.id, staged.importId));
    expect(row).toMatchObject({ compensationStatus: "completed" });
  });

  it("does not let cleanup failure overwrite a terminal completed state", async () => {
    const now = Date.now();
    const stagedRef: { value?: Awaited<ReturnType<typeof stagedImport>> } = {};
    const storage = new InMemoryObjectStorage({
      async beforeDelete(key) {
        if (key !== stagedRef.value?.sourceObjectKey) return;
        await db
          .update(imports)
          .set({ status: "completed", compensationStatus: "completed", lastError: null })
          .where(eq(imports.id, stagedRef.value.importId));
        throw new Error("simulated delete failure after terminal transition");
      },
    });
    const staged = await stagedImport(storage, new Date(now - 3_600_000));
    stagedRef.value = staged;
    await db
      .update(imports)
      .set({ status: "failed", compensationStatus: "required" })
      .where(eq(imports.id, staged.importId));
    const cleanup = createImportCleanupHandler({
      database: db,
      storage,
      graceSeconds: 3_600,
      clock: () => now,
    });

    await expect(
      cleanup(cleanupJob(staged.workspaceId, staged.importId), new AbortController().signal),
    ).rejects.toThrow("JOB_FAILED");

    const [row] = await db.select().from(imports).where(eq(imports.id, staged.importId));
    expect(row).toMatchObject({
      status: "completed",
      compensationStatus: "completed",
      lastError: null,
    });
  });
});
