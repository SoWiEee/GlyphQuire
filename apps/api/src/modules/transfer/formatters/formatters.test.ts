import { createHash, randomUUID } from "node:crypto";
import {
  exportFormatSchema,
  exportResultSchema,
  type ExportResult,
} from "@glyphquire/api-contract";
import {
  createDb,
  exports,
  user,
  workspaceMembers,
  workspaces,
  type Database,
} from "@glyphquire/database";
import { PostgresJobDispatcher } from "@glyphquire/queue";
import { InMemoryObjectStorage } from "@glyphquire/storage";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PublicApiError } from "../../../middleware/error-handler.js";
import { ExportServiceImpl } from "../ExportService.js";
import { formatAstJson } from "./ast-json.js";
import { formatPlainText, type ExportDocumentSource } from "./plain-text.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;
const FIRST_NOTE_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_NOTE_ID = "22222222-2222-4222-8222-222222222222";
const MARKDOWN = [
  "---",
  "glyphquire-spec: 1",
  "---",
  "",
  "# Stable heading",
  "",
  "Line with   internal spacing.  ",
  "",
  ':::future-widget{z="last" a="first"}',
  "Unsupported **child**",
  ":::",
  "",
  '<script data-provider-token="SECRET">alert(1)</script>',
  "",
].join("\r\n");

function source(overrides: Partial<ExportDocumentSource> = {}): ExportDocumentSource {
  return {
    id: FIRST_NOTE_ID,
    title: "Stable export",
    revision: 3,
    schemaVersion: 1,
    contentMarkdown: MARKDOWN,
    ...overrides,
  };
}

function collectNodes(value: unknown, type: string, matches: Array<Record<string, unknown>>): void {
  if (Array.isArray(value)) {
    for (const child of value) collectNodes(child, type, matches);
    return;
  }
  if (!value || typeof value !== "object") return;
  const object = value as Record<string, unknown>;
  if (object.type === type) matches.push(object);
  for (const child of Object.values(object)) collectNodes(child, type, matches);
}

async function publicError(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    if (error instanceof PublicApiError) return { code: error.code, status: error.status };
    throw error;
  }
  throw new Error("expected PublicApiError");
}

describe("additional export formatters", () => {
  it("normalizes parsed plain text to deterministic LF bytes with one terminal newline", () => {
    const second = source({
      id: SECOND_NOTE_ID,
      title: "Second",
      contentMarkdown: "---\r\nglyphquire-spec: 1\r\n---\r\n\r\nSecond note\r\n",
    });

    const expected = Buffer.from(
      "Stable heading\nLine with   internal spacing.\nUnsupported child\n\nSecond note\n",
      "utf8",
    );
    expect(formatPlainText([second, source()])).toEqual(expected);
    expect(formatPlainText([source(), second])).toEqual(expected);
  });

  it("emits canonical schema-versioned AST JSON and preserves unsupported nodes as inert data", () => {
    const first = source();
    const second = source({
      id: SECOND_NOTE_ID,
      title: "Second",
      revision: 1,
      contentMarkdown: "---\nglyphquire-spec: 1\n---\n\nSecond note\n",
    });

    const forward = formatAstJson([first, second]);
    const reversed = formatAstJson([second, first]);
    expect(reversed).toEqual(forward);
    expect(forward.at(-1)).toBe(0x0a);

    const artifact = JSON.parse(forward.toString("utf8")) as {
      schemaVersion: number;
      notes: Array<{
        id: string;
        revision: number;
        schemaVersion: number;
        document: unknown;
      }>;
    };
    expect(artifact.schemaVersion).toBe(1);
    expect(artifact.notes.map((note) => note.id)).toEqual([FIRST_NOTE_ID, SECOND_NOTE_ID]);
    expect(artifact.notes[0]).toMatchObject({ revision: 3, schemaVersion: 1 });

    const unknown: Array<Record<string, unknown>> = [];
    const invalid: Array<Record<string, unknown>> = [];
    collectNodes(artifact.notes[0]?.document, "unknown-directive", unknown);
    collectNodes(artifact.notes[0]?.document, "invalid-block", invalid);
    expect(unknown).toEqual([
      expect.objectContaining({
        name: "future-widget",
        attributes: { a: "first", z: "last" },
      }),
    ]);
    expect(invalid).toEqual([
      expect.objectContaining({
        originalType: "html",
        source: '<script data-provider-token="SECRET">alert(1)</script>',
      }),
    ]);
  });

  it("fails closed on a Markdown/database schema-version mismatch without leaking source", () => {
    const mismatched = source({ schemaVersion: 2 });
    for (const formatter of [formatPlainText, formatAstJson]) {
      expect(() => formatter([mismatched])).toThrow("EXPORT_FAILED");
      try {
        formatter([mismatched]);
      } catch (error) {
        expect(String(error)).not.toMatch(/SECRET|provider-token|Stable heading/u);
      }
    }
  });

  it("shares strict request and response validation for both new formats", () => {
    for (const format of ["plain-text", "ast-json"] as const) {
      expect(exportFormatSchema.parse(format)).toBe(format);
      const result: ExportResult = {
        id: randomUUID(),
        workspaceId: randomUUID(),
        status: "pending",
        format,
        scope: { type: "workspace", workspaceId: randomUUID() },
        createdAt: "2026-08-30T00:00:00.000Z",
        expiresAt: "2026-08-30T00:01:00.000Z",
      };
      result.scope.workspaceId = result.workspaceId;
      expect(exportResultSchema.parse(result)).toEqual(result);
    }
    expect(exportFormatSchema.safeParse("javascript").success).toBe(false);
  });
});

describeWithPostgres("additional export service contract", () => {
  let db: Database;

  beforeAll(() => {
    db = createDb(databaseUrl!);
  });

  afterAll(async () => {
    await db.$client.end();
  });

  it("keeps new-format replay, authorization, expiry, and download behavior fail-closed", async () => {
    const owner = `export-format-owner-${randomUUID()}`;
    const outsider = `export-format-outsider-${randomUUID()}`;
    await db.insert(user).values([
      { id: owner, name: "Owner", email: `${owner}@example.test` },
      { id: outsider, name: "Outsider", email: `${outsider}@example.test` },
    ]);
    const [workspace] = await db
      .insert(workspaces)
      .values({ personalOwnerId: owner })
      .returning({ id: workspaces.id });
    await db.insert(workspaceMembers).values({
      workspaceId: workspace!.id,
      userId: owner,
      role: "owner",
    });

    let now = Date.parse("2026-08-30T00:00:00.000Z");
    const storage = new InMemoryObjectStorage();
    const service = new ExportServiceImpl(db, storage, new PostgresJobDispatcher(db), {
      expirySeconds: 60,
      clock: () => now,
    });
    const key = randomUUID();
    const first = await service.start(owner, { workspaceId: workspace!.id }, "ast-json", key);
    await expect(
      service.start(owner, { workspaceId: workspace!.id }, "ast-json", key),
    ).resolves.toEqual(first);
    await expect(publicError(() => service.getDownload(outsider, first.id))).resolves.toEqual({
      code: "EXPORT_FAILED",
      status: 404,
    });

    await db.update(exports).set({ status: "completed" }).where(eq(exports.id, first.id));
    const body = Buffer.from('{"schemaVersion":1}\n', "utf8");
    await storage.put({
      key: `workspace/${workspace!.id}/exports/${first.id}/artifact`,
      body,
      contentType: "application/json; charset=utf-8",
      contentLength: body.byteLength,
      sha256: createHash("sha256").update(body).digest("hex"),
    });
    await expect(service.getDownload(owner, first.id)).resolves.toMatchObject({
      id: first.id,
      format: "ast-json",
      downloadUrl: expect.stringContaining("memory://workspace/"),
    });

    now += 60_000;
    await expect(service.getStatus(owner, first.id)).resolves.toMatchObject({
      status: "expired",
      errorCode: "EXPORT_FAILED",
    });
    await expect(publicError(() => service.getDownload(owner, first.id))).resolves.toEqual({
      code: "EXPORT_FAILED",
      status: 404,
    });
  });
});
