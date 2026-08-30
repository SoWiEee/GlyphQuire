import { randomUUID } from "node:crypto";
import {
  createDb,
  jobs,
  notes,
  user,
  workspaceMembers,
  workspaces,
  type Database,
} from "@glyphquire/database";
import {
  PostgresJobDispatcher,
  type CompleteJobInput,
  type DeadLetterJobInput,
  type JobStore,
  type PersistJobInput,
  type RetryJobInput,
  type StoredJob,
} from "@glyphquire/queue";
import { extractSearchableText, PostgresSearchAdapter } from "@glyphquire/search";
import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NoteWriter } from "./modules/notes/NoteWriter.js";
import { createOperatorAuthorizer } from "./modules/search/OperatorAuthorizer.js";
import { SearchServiceImpl } from "./modules/search/SearchService.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;
const FRESHNESS_BOUND_MS = 60_000;
const ACTOR_COUNT = 5;

/**
 * A JobStore view restricted to this test's workspaces. Full integration runs
 * share one database, so a generic dispatcher must not claim an unrelated
 * pending job and mutate another suite's evidence.
 */
class WorkspaceJobStore implements JobStore {
  constructor(
    private readonly db: Database,
    private readonly workspaceIds: readonly string[],
  ) {}

  async enqueue(_input: PersistJobInput): Promise<{ id: string; duplicate: boolean }> {
    throw new Error("Freshness store does not accept out-of-band enqueue");
  }

  async claimBatch(input: {
    dispatcherId: string;
    batchSize: number;
    now: Date;
    lockBefore: Date;
  }): Promise<StoredJob[]> {
    const claimed = await this.db
      .update(jobs)
      .set({
        status: "processing",
        attempts: sql`${jobs.attempts} + 1`,
        lockedAt: input.now,
        lockedBy: input.dispatcherId,
        updatedAt: input.now,
      })
      .where(
        and(
          inArray(jobs.workspaceId, [...this.workspaceIds]),
          eq(jobs.type, "search.index"),
          eq(jobs.status, "pending"),
          lte(jobs.availableAt, input.now),
        ),
      )
      .returning();
    if (claimed.length > input.batchSize) {
      throw new Error("Freshness workload exceeded its bounded dispatch batch");
    }
    return claimed as StoredJob[];
  }

  async markCompleted(input: CompleteJobInput): Promise<boolean> {
    const completed = await this.db
      .update(jobs)
      .set({
        status: "completed",
        completedAt: input.now,
        lockedAt: null,
        lockedBy: null,
        updatedAt: input.now,
      })
      .where(this.claimedJob(input))
      .returning({ id: jobs.id });
    return completed.length === 1;
  }

  async markRetry(input: RetryJobInput): Promise<boolean> {
    const retried = await this.db
      .update(jobs)
      .set({
        status: "pending",
        availableAt: input.availableAt,
        lastError: input.lastError,
        lockedAt: null,
        lockedBy: null,
        updatedAt: input.now,
      })
      .where(this.claimedJob(input))
      .returning({ id: jobs.id });
    return retried.length === 1;
  }

  async markDeadLetter(input: DeadLetterJobInput): Promise<boolean> {
    const deadLettered = await this.db
      .update(jobs)
      .set({
        status: "dead_letter",
        deadLetteredAt: input.now,
        lastError: input.lastError,
        lockedAt: null,
        lockedBy: null,
        updatedAt: input.now,
      })
      .where(this.claimedJob(input))
      .returning({ id: jobs.id });
    return deadLettered.length === 1;
  }

  private claimedJob(input: CompleteJobInput) {
    return and(
      eq(jobs.id, input.jobId),
      eq(jobs.status, "processing"),
      eq(jobs.lockedBy, input.dispatcherId),
      eq(jobs.attempts, input.claimGeneration),
      inArray(jobs.workspaceId, [...this.workspaceIds]),
    );
  }
}

describeWithPostgres("Phase 5 five-actor search freshness", () => {
  let db: Database;

  beforeAll(() => {
    db = createDb(databaseUrl!);
  });

  afterAll(async () => {
    await db.$client.end();
  });

  it(
    "makes five committed mutations searchable within 60 seconds without a dead letter",
    { timeout: FRESHNESS_BOUND_MS + 5_000 },
    async () => {
      const fixtures = await Promise.all(
        Array.from({ length: ACTOR_COUNT }, async (_, index) => {
          const actorId = `freshness-${index}-${randomUUID()}`;
          await db.insert(user).values({
            id: actorId,
            name: `Freshness actor ${index}`,
            email: `${actorId}@example.test`,
          });
          const [workspace] = await db
            .insert(workspaces)
            .values({ name: "Personal", personalOwnerId: actorId })
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
              title: `Freshness seed ${index}`,
              contentMarkdown: "# Seed",
              contentHash: "seed",
            })
            .returning({ id: notes.id, revision: notes.revision });
          return {
            actorId,
            workspaceId: workspace!.id,
            noteId: note!.id,
            revision: note!.revision,
            marker: `freshness${randomUUID().replaceAll("-", "")}`,
          };
        }),
      );

      const writer = new NoteWriter(db);
      const committed = await Promise.all(
        fixtures.map((fixture) =>
          writer.save(fixture.actorId, fixture.noteId, {
            operationId: randomUUID(),
            baseRevision: fixture.revision,
            contentMarkdown: `# ${fixture.marker}\n\nCommitted search mutation.`,
          }),
        ),
      );

      const workspaceIds = fixtures.map((fixture) => fixture.workspaceId);
      const search = new PostgresSearchAdapter(db);
      const dispatcher = new PostgresJobDispatcher(new WorkspaceJobStore(db, workspaceIds), {
        batchSize: ACTOR_COUNT,
        maxAttempts: 1,
      });
      const searchService = new SearchServiceImpl(
        db,
        search,
        dispatcher,
        createOperatorAuthorizer([]),
      );
      const startedAt = Date.now();
      let visible = false;

      while (Date.now() - startedAt <= FRESHNESS_BOUND_MS) {
        const summary = await dispatcher.dispatchBatch({
          "search.index": async (job) => {
            const [source] = await db
              .select({
                id: notes.id,
                workspaceId: notes.workspaceId,
                revision: notes.revision,
                title: notes.title,
                contentMarkdown: notes.contentMarkdown,
                deletedAt: notes.deletedAt,
              })
              .from(notes)
              .where(eq(notes.id, job.payload.noteId))
              .limit(1);
            if (
              !source ||
              source.workspaceId !== job.payload.workspaceId ||
              source.revision !== job.payload.revision ||
              source.deletedAt !== null
            ) {
              throw new Error("JOB_INVALID: search source mismatch");
            }
            const extracted = extractSearchableText(source.title, source.contentMarkdown);
            await search.indexNoteIfCurrent({
              noteId: source.id,
              workspaceId: source.workspaceId,
              revision: source.revision,
              title: extracted.title,
              headings: extracted.headings,
              body: extracted.body,
              tags: extracted.tags,
              normalizedText: extracted.normalizedText,
            });
          },
        });
        expect(summary.deadLettered).toBe(0);

        const results = await Promise.all(
          fixtures.map((fixture) =>
            searchService.search(fixture.actorId, {
              workspaceId: fixture.workspaceId,
              q: fixture.marker,
              pageSize: 10,
              ranking: "relevance",
            }),
          ),
        );
        visible = results.every((result, index) =>
          result.items.some(
            (item) =>
              item.noteId === fixtures[index]!.noteId &&
              item.revision === committed[index]!.revision,
          ),
        );
        if (visible) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      const relevantJobs = await db
        .select({ status: jobs.status, lastError: jobs.lastError })
        .from(jobs)
        .where(and(inArray(jobs.workspaceId, workspaceIds), eq(jobs.type, "search.index")));
      expect(visible).toBe(true);
      expect(Date.now() - startedAt).toBeLessThanOrEqual(FRESHNESS_BOUND_MS);
      expect(relevantJobs).toHaveLength(ACTOR_COUNT);
      expect(relevantJobs.every((job) => job.status === "completed")).toBe(true);
      expect(relevantJobs.every((job) => job.lastError === null)).toBe(true);
    },
  );
});
