import { createHash, randomUUID } from "node:crypto";
import {
  assets,
  createDb,
  exports,
  notes,
  user,
  workspaceMembers,
  workspaces,
  type Database,
} from "@glyphquire/database";
import { InMemoryObjectStorage } from "@glyphquire/storage";
import { eq } from "drizzle-orm";
import { unzipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createExportHandler } from "./export.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;
const NOW = Date.parse("2026-08-28T00:00:00.000Z");
const MARKDOWN = Buffer.from(
  "---\nglyphquire-spec: 1\n---\n\n# Exact bytes\n\nTrailing spaces stay.  \n",
  "utf8",
);
const NEWER_MARKDOWN = Buffer.from(
  "---\nglyphquire-spec: 1\n---\n\n# Newer bytes\n\nThe reclaimed attempt must win.\n",
  "utf8",
);

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

async function insertActor(db: Database, label: string): Promise<string> {
  const id = `${label}-${randomUUID()}`;
  await db.insert(user).values({ id, name: label, email: `${id}@example.test` });
  return id;
}

describeWithPostgres("export worker", () => {
  let db: Database;

  beforeAll(() => {
    db = createDb(databaseUrl!);
  });

  afterAll(async () => {
    await db.$client.end();
  });

  it("uploads the exact canonical note Markdown before durably completing and replays safely", async () => {
    const actorId = await insertActor(db, "worker-export-owner");
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
        title: "Exact bytes",
        contentMarkdown: MARKDOWN.toString("utf8"),
        contentHash: "worker-export-source",
      })
      .returning({ id: notes.id });
    const exportId = randomUUID();
    const objectKey = `workspace/${workspace!.id}/exports/${exportId}/artifact`;
    await db.insert(exports).values({
      id: exportId,
      workspaceId: workspace!.id,
      requesterId: actorId,
      scopeType: "note",
      noteId: note!.id,
      format: "markdown",
      status: "pending",
      idempotencyKey: randomUUID(),
      requestHash: "a".repeat(64),
      objectKey,
      createdAt: new Date(NOW),
      updatedAt: new Date(NOW),
      expiresAt: new Date(NOW + 60_000),
    });
    const storage = new InMemoryObjectStorage();
    const handler = createExportHandler({ database: db, storage, clock: () => NOW });
    const job = {
      id: randomUUID(),
      workspaceId: workspace!.id,
      type: "export" as const,
      version: 1,
      attempts: 1,
      createdAt: new Date(NOW).toISOString(),
      payload: { workspaceId: workspace!.id, exportId },
    };

    await handler(job, new AbortController().signal);
    await handler({ ...job, attempts: 2 }, new AbortController().signal);

    expect(await readAll(await storage.get(objectKey))).toEqual(MARKDOWN);
    const [row] = await db.select().from(exports).where(eq(exports.id, exportId)).limit(1);
    expect(row).toMatchObject({ status: "completed", lastError: null, objectKey });
  });

  it("does not let a superseded attempt overwrite the reclaimed attempt artifact", async () => {
    const actorId = await insertActor(db, "worker-export-race-owner");
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
        title: "Raced export",
        contentMarkdown: MARKDOWN.toString("utf8"),
        contentHash: "worker-export-race-old",
      })
      .returning({ id: notes.id });
    const exportId = randomUUID();
    const objectKey = `workspace/${workspace!.id}/exports/${exportId}/artifact`;
    await db.insert(exports).values({
      id: exportId,
      workspaceId: workspace!.id,
      requesterId: actorId,
      scopeType: "note",
      noteId: note!.id,
      format: "markdown",
      status: "pending",
      idempotencyKey: randomUUID(),
      requestHash: "1".repeat(64),
      objectKey,
      createdAt: new Date(NOW),
      updatedAt: new Date(NOW),
      expiresAt: new Date(NOW + 60_000),
    });
    const oldPutReached = deferred();
    const releaseOldPut = deferred();
    const canonicalPuts: Buffer[] = [];
    let pausedOldPut = false;
    const storage = new InMemoryObjectStorage({
      async beforePut(input) {
        if (input.key === objectKey) canonicalPuts.push(Buffer.from(input.body));
        if (!pausedOldPut && input.body.equals(MARKDOWN)) {
          pausedOldPut = true;
          oldPutReached.resolve();
          await releaseOldPut.promise;
        }
      },
    });
    const handler = createExportHandler({ database: db, storage, clock: () => NOW });
    const job = {
      id: randomUUID(),
      workspaceId: workspace!.id,
      type: "export" as const,
      version: 1,
      attempts: 1,
      createdAt: new Date(NOW).toISOString(),
      payload: { workspaceId: workspace!.id, exportId },
    };
    const staleRun = handler(job, new AbortController().signal);
    await oldPutReached.promise;

    await db
      .update(notes)
      .set({
        contentMarkdown: NEWER_MARKDOWN.toString("utf8"),
        contentHash: "worker-export-race-new",
        revision: 2,
        updatedAt: new Date(NOW + 1),
      })
      .where(eq(notes.id, note!.id));
    let completedUpdatedAt: Date | undefined;
    try {
      await handler({ ...job, attempts: 2 }, new AbortController().signal);
      const [completed] = await db
        .select({ status: exports.status, updatedAt: exports.updatedAt })
        .from(exports)
        .where(eq(exports.id, exportId))
        .limit(1);
      expect(completed?.status).toBe("completed");
      completedUpdatedAt = completed?.updatedAt;
    } finally {
      releaseOldPut.resolve();
      await staleRun;
    }

    expect(await readAll(await storage.get(objectKey))).toEqual(NEWER_MARKDOWN);
    expect(canonicalPuts).toEqual([NEWER_MARKDOWN]);
    const [row] = await db.select().from(exports).where(eq(exports.id, exportId)).limit(1);
    expect(row).toMatchObject({ status: "completed", lastError: null, objectKey });
    expect(row?.updatedAt).toEqual(completedUpdatedAt);
  });

  it("builds a path-safe ZIP with exact Markdown, referenced asset bytes, and bounded metadata", async () => {
    const actorId = await insertActor(db, "worker-export-zip-owner");
    const [workspace] = await db
      .insert(workspaces)
      .values({ personalOwnerId: actorId })
      .returning({ id: workspaces.id });
    await db.insert(workspaceMembers).values({
      workspaceId: workspace!.id,
      userId: actorId,
      role: "owner",
    });
    const assetId = randomUUID();
    const assetBody = Buffer.from("referenced asset bytes", "utf8");
    const assetKey = `workspace/${workspace!.id}/assets/${assetId}/original`;
    await db.insert(assets).values({
      id: assetId,
      workspaceId: workspace!.id,
      ownerId: actorId,
      objectKey: assetKey,
      originalName: "../../escape.html",
      mimeType: "text/plain",
      sizeBytes: assetBody.byteLength,
      sha256: createHash("sha256").update(assetBody).digest("hex"),
      thumbnailStatus: "metadata_only",
    });
    const markdown = Buffer.from(
      `---\nglyphquire-spec: 1\n---\n\n# Bundle\n\n![asset](asset://${assetId})\n`,
      "utf8",
    );
    const [note] = await db
      .insert(notes)
      .values({
        workspaceId: workspace!.id,
        ownerId: actorId,
        title: "Bundle",
        contentMarkdown: markdown.toString("utf8"),
        contentHash: "worker-export-zip-source",
      })
      .returning({ id: notes.id });
    const exportId = randomUUID();
    const objectKey = `workspace/${workspace!.id}/exports/${exportId}/artifact`;
    await db.insert(exports).values({
      id: exportId,
      workspaceId: workspace!.id,
      requesterId: actorId,
      scopeType: "note",
      noteId: note!.id,
      format: "zip",
      status: "pending",
      idempotencyKey: randomUUID(),
      requestHash: "b".repeat(64),
      objectKey,
      createdAt: new Date(NOW),
      updatedAt: new Date(NOW),
      expiresAt: new Date(NOW + 60_000),
    });
    const storage = new InMemoryObjectStorage();
    await storage.put({
      key: assetKey,
      body: assetBody,
      contentType: "text/plain",
      contentLength: assetBody.byteLength,
      sha256: createHash("sha256").update(assetBody).digest("hex"),
    });
    const handler = createExportHandler({ database: db, storage, clock: () => NOW });

    await handler(
      {
        id: randomUUID(),
        workspaceId: workspace!.id,
        type: "export",
        version: 1,
        attempts: 1,
        createdAt: new Date(NOW).toISOString(),
        payload: { workspaceId: workspace!.id, exportId },
      },
      new AbortController().signal,
    );

    const archive = unzipSync(await readAll(await storage.get(objectKey)));
    expect(Buffer.from(archive[`notes/${note!.id}.md`]!)).toEqual(markdown);
    expect(Buffer.from(archive[`assets/${assetId}/original`]!)).toEqual(assetBody);
    expect(Object.keys(archive).sort()).toEqual([
      `assets/${assetId}/original`,
      "metadata.json",
      `notes/${note!.id}.md`,
    ]);
    expect(
      Object.keys(archive).every((path) => !path.includes("..") && !path.startsWith("/")),
    ).toBe(true);
    const metadata = JSON.parse(Buffer.from(archive["metadata.json"]!).toString("utf8")) as {
      assets: Array<{ id: string; originalName: string }>;
      notes: Array<{ id: string }>;
    };
    expect(metadata).toMatchObject({
      assets: [{ id: assetId, originalName: "../../escape.html" }],
      notes: [{ id: note!.id }],
    });
  });

  it("renders HTML as an inert self-contained artifact without executable or remote URLs", async () => {
    const actorId = await insertActor(db, "worker-export-html-owner");
    const [workspace] = await db
      .insert(workspaces)
      .values({ personalOwnerId: actorId })
      .returning({ id: workspaces.id });
    await db.insert(workspaceMembers).values({
      workspaceId: workspace!.id,
      userId: actorId,
      role: "owner",
    });
    const dangerousMarkdown =
      "---\nglyphquire-spec: 1\n---\n\n# Safe title\n\n<script>alert(1)</script>\n\n[run](javascript:alert(2))\n\n![remote](https://evil.example/x.png)\n";
    const [note] = await db
      .insert(notes)
      .values({
        workspaceId: workspace!.id,
        ownerId: actorId,
        title: "</title><script>alert(3)</script>",
        contentMarkdown: dangerousMarkdown,
        contentHash: "worker-export-html-source",
      })
      .returning({ id: notes.id });
    const exportId = randomUUID();
    const objectKey = `workspace/${workspace!.id}/exports/${exportId}/artifact`;
    await db.insert(exports).values({
      id: exportId,
      workspaceId: workspace!.id,
      requesterId: actorId,
      scopeType: "note",
      noteId: note!.id,
      format: "html",
      status: "pending",
      idempotencyKey: randomUUID(),
      requestHash: "c".repeat(64),
      objectKey,
      createdAt: new Date(NOW),
      updatedAt: new Date(NOW),
      expiresAt: new Date(NOW + 60_000),
    });
    const storage = new InMemoryObjectStorage();
    const handler = createExportHandler({ database: db, storage, clock: () => NOW });

    await handler(
      {
        id: randomUUID(),
        workspaceId: workspace!.id,
        type: "export",
        version: 1,
        attempts: 1,
        createdAt: new Date(NOW).toISOString(),
        payload: { workspaceId: workspace!.id, exportId },
      },
      new AbortController().signal,
    );

    const html = (await readAll(await storage.get(objectKey))).toString("utf8");
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("<h1>Safe title</h1>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toMatch(/<script\b/iu);
    expect(html).not.toMatch(/(?:href|src)=["'](?:javascript:|https?:)/iu);
    expect(html).not.toContain("</title><script>");
  });

  it("retries safely after the artifact upload succeeds but completion does not", async () => {
    const actorId = await insertActor(db, "worker-export-retry-owner");
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
        title: "Retry",
        contentMarkdown: MARKDOWN.toString("utf8"),
        contentHash: "worker-export-retry-source",
      })
      .returning({ id: notes.id });
    const exportId = randomUUID();
    const objectKey = `workspace/${workspace!.id}/exports/${exportId}/artifact`;
    await db.insert(exports).values({
      id: exportId,
      workspaceId: workspace!.id,
      requesterId: actorId,
      scopeType: "note",
      noteId: note!.id,
      format: "markdown",
      status: "pending",
      idempotencyKey: randomUUID(),
      requestHash: "d".repeat(64),
      objectKey,
      createdAt: new Date(NOW),
      updatedAt: new Date(NOW),
      expiresAt: new Date(NOW + 60_000),
    });
    let failAfterPut = true;
    const storage = new InMemoryObjectStorage({
      afterPut(input) {
        if (failAfterPut && input.key === objectKey) {
          failAfterPut = false;
          throw new Error("provider detail that must never persist");
        }
      },
    });
    const handler = createExportHandler({ database: db, storage, clock: () => NOW });
    const job = {
      id: randomUUID(),
      workspaceId: workspace!.id,
      type: "export" as const,
      version: 1,
      attempts: 1,
      createdAt: new Date(NOW).toISOString(),
      payload: { workspaceId: workspace!.id, exportId },
    };

    await expect(handler(job, new AbortController().signal)).rejects.toThrow("JOB_FAILED");
    expect(storage.has(objectKey)).toBe(true);
    const [failed] = await db.select().from(exports).where(eq(exports.id, exportId)).limit(1);
    expect(failed).toMatchObject({ status: "failed", lastError: "JOB_FAILED" });
    expect(failed?.lastError).not.toContain("provider detail");

    await handler({ ...job, attempts: 2 }, new AbortController().signal);

    expect(await readAll(await storage.get(objectKey))).toEqual(MARKDOWN);
    const [completed] = await db.select().from(exports).where(eq(exports.id, exportId)).limit(1);
    expect(completed).toMatchObject({ status: "completed", lastError: null });
  });

  it("exports every active workspace note without treating code examples as asset references", async () => {
    const actorId = await insertActor(db, "worker-export-workspace-owner");
    const [workspace] = await db
      .insert(workspaces)
      .values({ personalOwnerId: actorId })
      .returning({ id: workspaces.id });
    await db.insert(workspaceMembers).values({
      workspaceId: workspace!.id,
      userId: actorId,
      role: "owner",
    });
    const codeOnlyAssetId = randomUUID();
    const noteSources = [
      `---\nglyphquire-spec: 1\n---\n\n# First\n\n\`\`\`text\nasset://${codeOnlyAssetId}\n\`\`\`\n`,
      "---\nglyphquire-spec: 1\n---\n\n# Second\n\nworkspace source\n",
    ];
    const insertedNotes = await db
      .insert(notes)
      .values(
        noteSources.map((contentMarkdown, index) => ({
          workspaceId: workspace!.id,
          ownerId: actorId,
          title: `Workspace ${index + 1}`,
          contentMarkdown,
          contentHash: `worker-export-workspace-${index}`,
        })),
      )
      .returning({ id: notes.id, contentMarkdown: notes.contentMarkdown });
    const exportId = randomUUID();
    const objectKey = `workspace/${workspace!.id}/exports/${exportId}/artifact`;
    await db.insert(exports).values({
      id: exportId,
      workspaceId: workspace!.id,
      requesterId: actorId,
      scopeType: "workspace",
      format: "zip",
      status: "pending",
      idempotencyKey: randomUUID(),
      requestHash: "e".repeat(64),
      objectKey,
      createdAt: new Date(NOW),
      updatedAt: new Date(NOW),
      expiresAt: new Date(NOW + 60_000),
    });
    const storage = new InMemoryObjectStorage();
    const handler = createExportHandler({ database: db, storage, clock: () => NOW });

    await handler(
      {
        id: randomUUID(),
        workspaceId: workspace!.id,
        type: "export",
        version: 1,
        attempts: 1,
        createdAt: new Date(NOW).toISOString(),
        payload: { workspaceId: workspace!.id, exportId },
      },
      new AbortController().signal,
    );

    const archive = unzipSync(await readAll(await storage.get(objectKey)));
    for (const note of insertedNotes) {
      expect(Buffer.from(archive[`notes/${note.id}.md`]!).toString("utf8")).toBe(
        note.contentMarkdown,
      );
    }
    expect(Object.keys(archive).filter((path) => path.startsWith("assets/"))).toEqual([]);
  });

  it("expires at the exact cutoff without writing an artifact", async () => {
    const actorId = await insertActor(db, "worker-export-expiry-owner");
    const [workspace] = await db
      .insert(workspaces)
      .values({ personalOwnerId: actorId })
      .returning({ id: workspaces.id });
    await db.insert(workspaceMembers).values({
      workspaceId: workspace!.id,
      userId: actorId,
      role: "owner",
    });
    const exportId = randomUUID();
    const objectKey = `workspace/${workspace!.id}/exports/${exportId}/artifact`;
    await db.insert(exports).values({
      id: exportId,
      workspaceId: workspace!.id,
      requesterId: actorId,
      scopeType: "workspace",
      format: "zip",
      status: "pending",
      idempotencyKey: randomUUID(),
      requestHash: "f".repeat(64),
      objectKey,
      createdAt: new Date(NOW - 1_000),
      updatedAt: new Date(NOW - 1_000),
      expiresAt: new Date(NOW),
    });
    const storage = new InMemoryObjectStorage();
    const handler = createExportHandler({ database: db, storage, clock: () => NOW });

    await handler(
      {
        id: randomUUID(),
        workspaceId: workspace!.id,
        type: "export",
        version: 1,
        attempts: 1,
        createdAt: new Date(NOW).toISOString(),
        payload: { workspaceId: workspace!.id, exportId },
      },
      new AbortController().signal,
    );

    expect(storage.size()).toBe(0);
    const [row] = await db.select().from(exports).where(eq(exports.id, exportId)).limit(1);
    expect(row).toMatchObject({ status: "expired", lastError: null, objectKey });
  });
});
