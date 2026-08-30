import { randomUUID } from "node:crypto";
import {
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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createExportHandler,
  formatAdditionalExportArtifact,
  type AdditionalExportFormat,
  type ExportFormatSource,
} from "./export.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;
const NOW = Date.parse("2026-08-30T00:00:00.000Z");
const FIRST_NOTE_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_NOTE_ID = "22222222-2222-4222-8222-222222222222";
const UNSUPPORTED_MARKDOWN = [
  "---",
  "glyphquire-spec: 1",
  "---",
  "",
  "# Worker export",
  "",
  ':::future-widget{provider="not-a-credential"}',
  "Preserved child",
  ":::",
  "",
  "<script>alert(1)</script>",
  "",
].join("\n");

function source(overrides: Partial<ExportFormatSource> = {}): ExportFormatSource {
  return {
    id: FIRST_NOTE_ID,
    title: "Worker export",
    revision: 2,
    schemaVersion: 1,
    contentMarkdown: UNSUPPORTED_MARKDOWN,
    ...overrides,
  };
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

describe("additional export artifact selection", () => {
  it("selects stable plain-text bytes and content type from the static format map", () => {
    const second = source({
      id: SECOND_NOTE_ID,
      title: "Second",
      revision: 1,
      contentMarkdown: "---\r\nglyphquire-spec: 1\r\n---\r\n\r\nSecond note\r\n",
    });
    const forward = formatAdditionalExportArtifact("plain-text", [source(), second]);
    const reversed = formatAdditionalExportArtifact("plain-text", [second, source()]);

    expect(forward).toEqual(reversed);
    expect(forward.contentType).toBe("text/plain; charset=utf-8");
    expect(forward.body.toString("utf8")).toBe("Worker export\nPreserved child\n\nSecond note\n");
  });

  it("selects deterministic canonical JSON that retains unsupported AST nodes", () => {
    const first = formatAdditionalExportArtifact("ast-json", [source()]);
    const replay = formatAdditionalExportArtifact("ast-json", [source()]);

    expect(replay.body).toEqual(first.body);
    expect(first.contentType).toBe("application/json; charset=utf-8");
    const artifact = JSON.parse(first.body.toString("utf8")) as {
      schemaVersion: number;
      notes: Array<{ schemaVersion: number; document: unknown }>;
    };
    expect(artifact).toMatchObject({ schemaVersion: 1, notes: [{ schemaVersion: 1 }] });
    expect(JSON.stringify(artifact.notes[0]?.document)).toContain("future-widget");
    expect(JSON.stringify(artifact.notes[0]?.document)).toContain("<script>alert(1)</script>");
  });

  it("rejects invalid formats and schema mismatches with a stable sanitized failure", () => {
    expect(() =>
      formatAdditionalExportArtifact("javascript" as AdditionalExportFormat, [source()]),
    ).toThrow("JOB_FAILED");
    expect(() =>
      formatAdditionalExportArtifact("ast-json", [source({ schemaVersion: 2 })]),
    ).toThrow("JOB_FAILED");
    try {
      formatAdditionalExportArtifact("plain-text", [source({ schemaVersion: 2 })]);
    } catch (error) {
      expect(String(error)).toBe("Error: JOB_FAILED");
      expect(String(error)).not.toMatch(/future-widget|script|provider/u);
    }
  });
});

describeWithPostgres("additional export worker persistence", () => {
  let db: Database;

  beforeAll(() => {
    db = createDb(databaseUrl!);
  });

  afterAll(async () => {
    await db.$client.end();
  });

  for (const format of ["plain-text", "ast-json"] as const) {
    it(`publishes deterministic ${format} bytes and replays a completed job without mutation`, async () => {
      const actorId = await insertActor(db, `worker-${format}`);
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
          title: "Worker format",
          contentMarkdown: UNSUPPORTED_MARKDOWN,
          contentHash: `worker-${format}-source`,
        })
        .returning({
          id: notes.id,
          title: notes.title,
          revision: notes.revision,
          schemaVersion: notes.schemaVersion,
          contentMarkdown: notes.contentMarkdown,
        });
      const exportId = randomUUID();
      const objectKey = `workspace/${workspace!.id}/exports/${exportId}/artifact`;
      await db.insert(exports).values({
        id: exportId,
        workspaceId: workspace!.id,
        requesterId: actorId,
        scopeType: "note",
        noteId: note!.id,
        format,
        status: "pending",
        idempotencyKey: randomUUID(),
        requestHash: "f".repeat(64),
        objectKey,
        createdAt: new Date(NOW),
        updatedAt: new Date(NOW),
        expiresAt: new Date(NOW + 60_000),
      });
      const canonicalContentTypes: string[] = [];
      const storage = new InMemoryObjectStorage({
        beforePut(input) {
          if (input.key === objectKey) canonicalContentTypes.push(input.contentType);
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

      await handler(job, new AbortController().signal);
      const first = await readAll(await storage.get(objectKey));
      await handler({ ...job, attempts: 2 }, new AbortController().signal);
      const replay = await readAll(await storage.get(objectKey));

      expect(replay).toEqual(first);
      expect(first).toEqual(formatAdditionalExportArtifact(format, [note!]).body);
      expect(canonicalContentTypes).toEqual([
        format === "plain-text" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
      ]);
      const [row] = await db.select().from(exports).where(eq(exports.id, exportId)).limit(1);
      expect(row).toMatchObject({ status: "completed", format, lastError: null });
    });
  }

  it("expires a new-format export before reading private note content", async () => {
    const actorId = await insertActor(db, "worker-format-expired");
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
      format: "plain-text",
      status: "pending",
      idempotencyKey: randomUUID(),
      requestHash: "e".repeat(64),
      objectKey,
      createdAt: new Date(NOW - 60_000),
      updatedAt: new Date(NOW - 60_000),
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

    expect(storage.has(objectKey)).toBe(false);
    const [row] = await db.select().from(exports).where(eq(exports.id, exportId)).limit(1);
    expect(row).toMatchObject({ status: "expired", lastError: null });
  });
});
