import { randomUUID } from "node:crypto";
import {
  createDb,
  imports,
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
import { ImportServiceImpl } from "./ImportService.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;
const MARKDOWN = "---\nglyphquire-spec: 1\n---\n\n# Imported\n\nprivate source marker";

async function insertActor(db: Database, label: string): Promise<string> {
  const id = `${label}-${randomUUID()}`;
  await db.insert(user).values({ id, name: label, email: `${id}@example.test` });
  return id;
}

async function fixture(db: Database) {
  const owner = await insertActor(db, "import-owner");
  const otherMember = await insertActor(db, "import-other-member");
  const viewer = await insertActor(db, "import-viewer");
  const outsider = await insertActor(db, "import-outsider");
  const [workspace] = await db
    .insert(workspaces)
    .values({ personalOwnerId: owner })
    .returning({ id: workspaces.id });
  await db.insert(workspaceMembers).values([
    { workspaceId: workspace!.id, userId: owner, role: "owner" },
    { workspaceId: workspace!.id, userId: otherMember, role: "editor" },
    { workspaceId: workspace!.id, userId: viewer, role: "viewer" },
  ]);
  return { owner, otherMember, viewer, outsider, workspaceId: workspace!.id };
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

describeWithPostgres("ImportService", () => {
  let db: Database;

  beforeAll(() => {
    db = createDb(databaseUrl!);
  });

  afterAll(async () => {
    await db.$client.end();
  });

  it("commits the staging owner before upload and atomically publishes pending plus its job", async () => {
    const scope = await fixture(db);
    let observedStaging = false;
    const storage = new InMemoryObjectStorage({
      async beforePut(input) {
        const [row] = await db
          .select()
          .from(imports)
          .where(eq(imports.sourceObjectKey, input.key))
          .limit(1);
        observedStaging = row?.status === "staging" && row.compensationStatus === "required";
      },
    });
    const service = new ImportServiceImpl(db, storage, new PostgresJobDispatcher(db));

    const result = await service.start(
      scope.owner,
      scope.workspaceId,
      { upload: new Blob([MARKDOWN], { type: "text/markdown" }) },
      randomUUID(),
    );

    expect(observedStaging).toBe(true);
    expect(result.status).toBe("pending");
    const [row] = await db.select().from(imports).where(eq(imports.id, result.id)).limit(1);
    expect(row).toMatchObject({
      workspaceId: scope.workspaceId,
      actorId: scope.owner,
      status: "pending",
      compensationStatus: "none",
    });
    expect(row!.sourceObjectKey).toBe(`workspace/${scope.workspaceId}/imports/${result.id}/source`);
    expect(JSON.stringify(row!.manifest)).not.toContain("private source marker");
    const queued = await db
      .select()
      .from(jobs)
      .where(and(eq(jobs.type, "import"), eq(jobs.workspaceId, scope.workspaceId)));
    expect(queued.some((job) => job.payload.importId === result.id)).toBe(true);
  });

  it("binds replay to source, noteId, and baseRevision and hides status from other actors", async () => {
    const scope = await fixture(db);
    const [target] = await db
      .insert(notes)
      .values({
        workspaceId: scope.workspaceId,
        ownerId: scope.owner,
        title: "Target",
        contentMarkdown: MARKDOWN,
        contentHash: "initial-hash",
      })
      .returning({ id: notes.id, revision: notes.revision });
    const storage = new InMemoryObjectStorage();
    const service = new ImportServiceImpl(db, storage, new PostgresJobDispatcher(db));
    const key = randomUUID();
    const input = {
      upload: new Blob([MARKDOWN], { type: "text/markdown" }),
      noteId: target!.id,
      baseRevision: target!.revision,
    };

    const first = await service.start(scope.owner, scope.workspaceId, input, key);
    const replay = await service.start(scope.owner, scope.workspaceId, input, key);
    expect(replay).toEqual(first);

    const conflicting = await capturePublicError(() =>
      service.start(
        scope.owner,
        scope.workspaceId,
        { ...input, upload: new Blob([`${MARKDOWN}\nchanged`], { type: "text/markdown" }) },
        key,
      ),
    );
    expect(conflicting).toEqual({ code: "OPERATION_REUSED", status: 409 });
    await expect(service.getStatus(scope.owner, first.id)).resolves.toEqual(first);
    await expect(
      capturePublicError(() => service.getStatus(scope.otherMember, first.id)),
    ).resolves.toEqual({ code: "IMPORT_INVALID", status: 404 });
    await expect(
      capturePublicError(() => service.getStatus(scope.outsider, first.id)),
    ).resolves.toEqual({ code: "IMPORT_INVALID", status: 404 });
  });

  it("validates identifiers, revision shape, role, and upload size before costly parsing", async () => {
    const scope = await fixture(db);
    const storage = new InMemoryObjectStorage();
    const service = new ImportServiceImpl(db, storage, new PostgresJobDispatcher(db));
    const upload = new Blob([MARKDOWN], { type: "text/markdown" });

    await expect(
      capturePublicError(() =>
        service.start(
          scope.owner,
          scope.workspaceId,
          { upload, noteId: "not-a-note-id", baseRevision: 1 },
          randomUUID(),
        ),
      ),
    ).resolves.toEqual({ code: "IMPORT_INVALID", status: 400 });
    await expect(
      capturePublicError(() => service.getStatus(scope.owner, "not-an-import-id")),
    ).resolves.toEqual({ code: "IMPORT_INVALID", status: 400 });
    await expect(
      capturePublicError(() =>
        service.start(scope.viewer, scope.workspaceId, { upload }, randomUUID()),
      ),
    ).resolves.toEqual({ code: "IMPORT_INVALID", status: 404 });

    let read = false;
    class OversizedBlob extends Blob {
      override get size() {
        return 25 * 1024 * 1024 + 1;
      }

      override async arrayBuffer(): Promise<ArrayBuffer> {
        read = true;
        return super.arrayBuffer();
      }
    }
    await expect(
      capturePublicError(() =>
        service.start(
          scope.owner,
          scope.workspaceId,
          { upload: new OversizedBlob([MARKDOWN]) },
          randomUUID(),
        ),
      ),
    ).resolves.toEqual({ code: "IMPORT_INVALID", status: 400 });
    expect(read).toBe(false);
  });
});
