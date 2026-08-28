import { createHash, randomUUID } from "node:crypto";
import {
  createDb,
  exports,
  jobs,
  notes,
  user,
  workspaceMembers,
  workspaces,
  type Database,
} from "@glyphquire/database";
import { PostgresJobDispatcher } from "@glyphquire/queue";
import { InMemoryObjectStorage } from "@glyphquire/storage";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PublicApiError } from "../../middleware/error-handler.js";
import { ExportServiceImpl } from "./ExportService.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;
const MARKDOWN = "---\nglyphquire-spec: 1\n---\n\n# Exact export\n\nbyte-for-byte source\n";

async function insertActor(db: Database, label: string): Promise<string> {
  const id = `${label}-${randomUUID()}`;
  await db.insert(user).values({ id, name: label, email: `${id}@example.test` });
  return id;
}

async function capturePublicError(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    if (error instanceof PublicApiError) return { code: error.code, status: error.status };
    throw error;
  }
  throw new Error("expected PublicApiError");
}

describeWithPostgres("ExportService", () => {
  let db: Database;

  beforeAll(() => {
    db = createDb(databaseUrl!);
  });

  afterAll(async () => {
    await db.$client.end();
  });

  it("creates a pending note export and its job atomically with server-derived scope and key", async () => {
    const actorId = await insertActor(db, "export-owner");
    const [workspace] = await db
      .insert(workspaces)
      .values({ personalOwnerId: actorId })
      .returning({ id: workspaces.id });
    await db.insert(workspaceMembers).values({
      workspaceId: workspace!.id,
      userId: actorId,
      role: "owner",
    });
    const [note] = await db
      .insert(notes)
      .values({
        workspaceId: workspace!.id,
        ownerId: actorId,
        title: "Exact export",
        contentMarkdown: MARKDOWN,
        contentHash: "export-source-hash",
      })
      .returning({ id: notes.id });
    const service = new ExportServiceImpl(
      db,
      new InMemoryObjectStorage(),
      new PostgresJobDispatcher(db),
    );

    const result = await service.start(actorId, { noteId: note!.id }, "markdown", randomUUID());

    expect(result).toMatchObject({
      workspaceId: workspace!.id,
      status: "pending",
      format: "markdown",
      scope: { type: "note", workspaceId: workspace!.id, noteId: note!.id },
    });
    const [row] = await db.select().from(exports).where(eq(exports.id, result.id)).limit(1);
    expect(row).toMatchObject({
      workspaceId: workspace!.id,
      requesterId: actorId,
      scopeType: "note",
      noteId: note!.id,
      format: "markdown",
      status: "pending",
      objectKey: `workspace/${workspace!.id}/exports/${result.id}/artifact`,
    });
    expect(row!.requestHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(row!.expiresAt.getTime() - row!.createdAt.getTime()).toBe(30 * 24 * 60 * 60 * 1_000);
    const [job] = await db
      .select()
      .from(jobs)
      .where(and(eq(jobs.type, "export"), eq(jobs.workspaceId, workspace!.id)))
      .orderBy(jobs.createdAt)
      .limit(1);
    expect(job?.payload).toEqual({ workspaceId: workspace!.id, exportId: result.id });
    expect(JSON.stringify(job?.payload)).not.toContain(MARKDOWN);
  });

  it("reveals status and a completed artifact URL only to its current requester-member", async () => {
    const owner = await insertActor(db, "export-status-owner");
    const otherMember = await insertActor(db, "export-status-member");
    const outsider = await insertActor(db, "export-status-outsider");
    const [workspace] = await db
      .insert(workspaces)
      .values({ personalOwnerId: owner })
      .returning({ id: workspaces.id });
    await db.insert(workspaceMembers).values([
      { workspaceId: workspace!.id, userId: owner, role: "owner" },
      { workspaceId: workspace!.id, userId: otherMember, role: "editor" },
    ]);
    const [note] = await db
      .insert(notes)
      .values({
        workspaceId: workspace!.id,
        ownerId: owner,
        title: "Status owner",
        contentMarkdown: MARKDOWN,
        contentHash: "export-status-hash",
      })
      .returning({ id: notes.id });
    const storage = new InMemoryObjectStorage();
    const service = new ExportServiceImpl(db, storage, new PostgresJobDispatcher(db));
    const started = await service.start(owner, { noteId: note!.id }, "markdown", randomUUID());
    const artifact = Buffer.from(MARKDOWN, "utf8");
    const objectKey = `workspace/${workspace!.id}/exports/${started.id}/artifact`;
    await storage.put({
      key: objectKey,
      body: artifact,
      contentType: "text/markdown; charset=utf-8",
      contentLength: artifact.byteLength,
      sha256: createHash("sha256").update(artifact).digest("hex"),
    });
    await db
      .update(exports)
      .set({ status: "completed" })
      .where(and(eq(exports.id, started.id), eq(exports.workspaceId, workspace!.id)));

    await expect(service.getStatus(owner, started.id)).resolves.toMatchObject({
      id: started.id,
      status: "completed",
    });
    await expect(service.getDownload(owner, started.id)).resolves.toMatchObject({
      id: started.id,
      status: "completed",
      downloadUrl: expect.stringContaining("memory://workspace/"),
    });
    await expect(
      capturePublicError(() => service.getStatus(otherMember, started.id)),
    ).resolves.toEqual({ code: "EXPORT_FAILED", status: 404 });
    await expect(
      capturePublicError(() => service.getDownload(outsider, started.id)),
    ).resolves.toEqual({ code: "EXPORT_FAILED", status: 404 });
  });

  it("durably expires status at the exact cutoff and fails download closed", async () => {
    const owner = await insertActor(db, "export-expiry-owner");
    const [workspace] = await db
      .insert(workspaces)
      .values({ personalOwnerId: owner })
      .returning({ id: workspaces.id });
    await db.insert(workspaceMembers).values({
      workspaceId: workspace!.id,
      userId: owner,
      role: "owner",
    });
    const [note] = await db
      .insert(notes)
      .values({
        workspaceId: workspace!.id,
        ownerId: owner,
        title: "Expiring export",
        contentMarkdown: MARKDOWN,
        contentHash: "export-expiry-hash",
      })
      .returning({ id: notes.id });
    let now = Date.parse("2026-08-28T00:00:00.000Z");
    const service = new ExportServiceImpl(
      db,
      new InMemoryObjectStorage(),
      new PostgresJobDispatcher(db),
      { expirySeconds: 60, clock: () => now },
    );
    const started = await service.start(owner, { noteId: note!.id }, "zip", randomUUID());

    now += 60_000;

    await expect(service.getStatus(owner, started.id)).resolves.toMatchObject({
      id: started.id,
      status: "expired",
      errorCode: "EXPORT_FAILED",
    });
    const [stored] = await db
      .select({ status: exports.status })
      .from(exports)
      .where(eq(exports.id, started.id))
      .limit(1);
    expect(stored?.status).toBe("expired");
    await expect(capturePublicError(() => service.getDownload(owner, started.id))).resolves.toEqual(
      { code: "EXPORT_FAILED", status: 404 },
    );
  });

  it("binds idempotency to requester, server-resolved scope, and format without leaking failures", async () => {
    const owner = await insertActor(db, "export-idempotency-owner");
    const outsider = await insertActor(db, "export-idempotency-outsider");
    const [workspace] = await db
      .insert(workspaces)
      .values({ personalOwnerId: owner })
      .returning({ id: workspaces.id });
    await db.insert(workspaceMembers).values({
      workspaceId: workspace!.id,
      userId: owner,
      role: "owner",
    });
    const service = new ExportServiceImpl(
      db,
      new InMemoryObjectStorage(),
      new PostgresJobDispatcher(db),
    );
    const key = randomUUID();

    const first = await service.start(owner, { workspaceId: workspace!.id }, "zip", key);
    await expect(service.start(owner, { workspaceId: workspace!.id }, "zip", key)).resolves.toEqual(
      first,
    );
    await expect(
      capturePublicError(() => service.start(owner, { workspaceId: workspace!.id }, "html", key)),
    ).resolves.toEqual({ code: "OPERATION_REUSED", status: 409 });
    await expect(
      capturePublicError(() =>
        service.start(outsider, { workspaceId: workspace!.id }, "zip", randomUUID()),
      ),
    ).resolves.toEqual({ code: "EXPORT_FAILED", status: 404 });

    await db
      .update(exports)
      .set({ status: "failed", lastError: "provider secret and private markdown" })
      .where(eq(exports.id, first.id));
    const status = await service.getStatus(owner, first.id);
    expect(status).toMatchObject({ status: "failed", errorCode: "EXPORT_FAILED" });
    expect(JSON.stringify(status)).not.toContain("provider secret");
    expect(JSON.stringify(status)).not.toContain("private markdown");
  });
});
