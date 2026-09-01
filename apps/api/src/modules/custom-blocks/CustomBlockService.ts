import {
  customBlockDefinitionSchema,
  customBlockListResultSchema,
  type CreateCustomBlockInput,
  type CustomBlockListResult,
  type CustomBlockRecord,
  type DeleteCustomBlockInput,
  type PublishCustomBlockInput,
  type UpdateCustomBlockDraftInput,
} from "@glyphquire/api-contract";
import {
  customBlockOperations,
  customBlockVersions,
  customBlocks,
  workspaceMembers,
  type Database,
} from "@glyphquire/database";
import { and, desc, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { PublicApiError } from "../../middleware/error-handler.js";

export interface CustomBlockService {
  list(actorId: string, workspaceId: string): Promise<CustomBlockListResult>;
  create(
    actorId: string,
    workspaceId: string,
    input: CreateCustomBlockInput,
  ): Promise<CustomBlockRecord>;
  updateDraft(
    actorId: string,
    blockId: string,
    input: UpdateCustomBlockDraftInput,
  ): Promise<CustomBlockRecord>;
  publish(
    actorId: string,
    blockId: string,
    input: PublishCustomBlockInput,
  ): Promise<CustomBlockRecord>;
  removeDraft(actorId: string, blockId: string, input: DeleteCustomBlockInput): Promise<void>;
}

function invalid(): never {
  throw new PublicApiError("DOCUMENT_INVALID", 400);
}
function notFound(): never {
  throw new PublicApiError("NOTE_NOT_FOUND", 404);
}

function operationReused(): never {
  throw new PublicApiError("OPERATION_REUSED", 409);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function requestHash(value: unknown): string {
  return createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}

function isUniqueViolation(error: unknown): boolean {
  const candidate = error as { code?: string; cause?: { code?: string } };
  return candidate?.code === "23505" || candidate?.cause?.code === "23505";
}

function toRecord(
  block: typeof customBlocks.$inferSelect,
  version: typeof customBlockVersions.$inferSelect,
): CustomBlockRecord {
  return customBlockListResultSchema.shape.items.element.parse({
    id: block.id,
    workspaceId: block.workspaceId,
    name: block.name,
    revision: block.revision,
    version: version.version,
    status: version.status,
    definition: version.definition,
    createdAt: block.createdAt.toISOString(),
    updatedAt: block.updatedAt.toISOString(),
    publishedAt: version.publishedAt?.toISOString() ?? null,
  });
}

export class CustomBlockServiceImpl implements CustomBlockService {
  constructor(private readonly db: Database) {}

  private async member(
    actorId: string,
    workspaceId: string,
  ): Promise<"owner" | "editor" | "viewer"> {
    const [row] = await this.db
      .select({ role: workspaceMembers.role })
      .from(workspaceMembers)
      .where(
        and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, actorId)),
      )
      .limit(1);
    if (!row) notFound();
    return row.role;
  }

  private async blockFor(
    actorId: string,
    blockId: string,
  ): Promise<{ block: typeof customBlocks.$inferSelect; role: "owner" | "editor" | "viewer" }> {
    const [row] = await this.db
      .select({ block: customBlocks, role: workspaceMembers.role })
      .from(customBlocks)
      .innerJoin(
        workspaceMembers,
        and(
          eq(workspaceMembers.workspaceId, customBlocks.workspaceId),
          eq(workspaceMembers.userId, actorId),
        ),
      )
      .where(eq(customBlocks.id, blockId))
      .limit(1);
    if (!row) notFound();
    return { block: row.block, role: row.role };
  }

  private assertMutable(role: "owner" | "editor" | "viewer"): void {
    if (role === "viewer") notFound();
  }

  private async latest(blockId: string) {
    const [version] = await this.db
      .select()
      .from(customBlockVersions)
      .where(eq(customBlockVersions.customBlockId, blockId))
      .orderBy(desc(customBlockVersions.version))
      .limit(1);
    if (!version) notFound();
    return version;
  }

  private async replay(
    actorId: string,
    workspaceId: string | null,
    operationId: string,
    operationKind: "create" | "update-draft" | "publish" | "delete-draft",
    blockId: string | null,
    payload: unknown,
  ): Promise<CustomBlockRecord | null | undefined> {
    const predicates = [
      eq(customBlockOperations.actorId, actorId),
      eq(customBlockOperations.operationId, operationId),
    ];
    if (workspaceId !== null) {
      predicates.push(eq(customBlockOperations.workspaceId, workspaceId));
    } else if (blockId !== null) {
      predicates.push(eq(customBlockOperations.targetBlockId, blockId));
    }
    const rows = await this.db
      .select()
      .from(customBlockOperations)
      .where(and(...predicates))
      .limit(1);
    const operation = rows[0];
    if (!operation) return undefined;
    if (
      operation.operationKind !== operationKind ||
      (blockId !== null && operation.targetBlockId !== blockId) ||
      operation.requestHash !== requestHash(payload)
    ) {
      operationReused();
    }
    if (operationKind === "delete-draft") return null;
    return customBlockListResultSchema.shape.items.element.parse(operation.recordedResponse);
  }

  async list(actorId: string, workspaceId: string): Promise<CustomBlockListResult> {
    await this.member(actorId, workspaceId);
    const blocks = await this.db
      .select()
      .from(customBlocks)
      .where(eq(customBlocks.workspaceId, workspaceId));
    const items: CustomBlockRecord[] = [];
    for (const block of blocks) {
      const version = await this.latest(block.id);
      items.push(toRecord(block, version));
    }
    return customBlockListResultSchema.parse({ items });
  }

  async create(
    actorId: string,
    workspaceId: string,
    input: CreateCustomBlockInput,
  ): Promise<CustomBlockRecord> {
    if ((await this.member(actorId, workspaceId)) === "viewer") notFound();
    const definition = customBlockDefinitionSchema.safeParse(input.definition);
    if (!definition.success) invalid();
    const payload = { definition: definition.data };
    const replay = await this.replay(
      actorId,
      workspaceId,
      input.operationId,
      "create",
      null,
      payload,
    );
    if (replay !== undefined) return replay as CustomBlockRecord;
    try {
      const result = await this.db.transaction(async (tx) => {
        const [block] = await tx
          .insert(customBlocks)
          .values({
            workspaceId,
            name: definition.data.name,
            revision: 1,
            createdBy: actorId,
          })
          .returning();
        if (!block) throw new Error("Custom Block insert returned no row");
        const [version] = await tx
          .insert(customBlockVersions)
          .values({
            customBlockId: block.id,
            version: definition.data.version,
            status: "draft",
            definition: definition.data,
            createdBy: actorId,
            operationId: input.operationId,
            operationKind: "create",
          })
          .returning();
        if (!version) throw new Error("Custom Block version insert returned no row");
        const record = toRecord(block, version);
        await tx.insert(customBlockOperations).values({
          workspaceId,
          customBlockId: block.id,
          targetBlockId: block.id,
          actorId,
          operationId: input.operationId,
          operationKind: "create",
          baseRevision: null,
          requestHash: requestHash(payload),
          recordedResponse: record,
        });
        return record;
      });
      return result;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const replay = await this.replay(
        actorId,
        workspaceId,
        input.operationId,
        "create",
        null,
        payload,
      );
      if (replay) return replay;
      invalid();
    }
  }

  async updateDraft(
    actorId: string,
    blockId: string,
    input: UpdateCustomBlockDraftInput,
  ): Promise<CustomBlockRecord> {
    const { block, role } = await this.blockFor(actorId, blockId);
    this.assertMutable(role);
    const definition = customBlockDefinitionSchema.safeParse(input.definition);
    if (!definition.success || definition.data.name !== block.name) invalid();
    const payload = { baseRevision: input.baseRevision, definition: definition.data };
    const replay = await this.replay(
      actorId,
      block.workspaceId,
      input.operationId,
      "update-draft",
      blockId,
      payload,
    );
    if (replay) return replay;
    if (block.revision !== input.baseRevision) throw new PublicApiError("REVISION_CONFLICT", 409);
    const current = await this.latest(block.id);
    const expectedVersion = current.status === "draft" ? current.version : current.version + 1;
    if (definition.data.version !== expectedVersion) invalid();
    const now = new Date();
    const result = await this.db.transaction(async (tx) => {
      const [updatedBlock] = await tx
        .update(customBlocks)
        .set({ revision: block.revision + 1, updatedAt: now })
        .where(and(eq(customBlocks.id, block.id), eq(customBlocks.revision, input.baseRevision)))
        .returning();
      if (!updatedBlock) throw new PublicApiError("REVISION_CONFLICT", 409);
      if (current.status === "draft") {
        const [updatedVersion] = await tx
          .update(customBlockVersions)
          .set({
            definition: definition.data,
            operationId: input.operationId,
            operationKind: "update-draft",
          })
          .where(
            and(eq(customBlockVersions.id, current.id), eq(customBlockVersions.status, "draft")),
          )
          .returning();
        if (!updatedVersion) throw new PublicApiError("REVISION_CONFLICT", 409);
        const record = toRecord(updatedBlock, updatedVersion);
        await tx.insert(customBlockOperations).values({
          workspaceId: block.workspaceId,
          customBlockId: block.id,
          targetBlockId: block.id,
          actorId,
          operationId: input.operationId,
          operationKind: "update-draft",
          baseRevision: input.baseRevision,
          requestHash: requestHash(payload),
          recordedResponse: record,
        });
        return record;
      }
      const [draft] = await tx
        .insert(customBlockVersions)
        .values({
          customBlockId: block.id,
          version: current.version + 1,
          status: "draft",
          definition: definition.data,
          createdBy: actorId,
          operationId: input.operationId,
          operationKind: "update-draft",
        })
        .returning();
      if (!draft) throw new Error("Custom Block draft insert returned no row");
      const record = toRecord(updatedBlock, draft);
      await tx.insert(customBlockOperations).values({
        workspaceId: block.workspaceId,
        customBlockId: block.id,
        targetBlockId: block.id,
        actorId,
        operationId: input.operationId,
        operationKind: "update-draft",
        baseRevision: input.baseRevision,
        requestHash: requestHash(payload),
        recordedResponse: record,
      });
      return record;
    });
    return result;
  }

  async publish(
    actorId: string,
    blockId: string,
    input: PublishCustomBlockInput,
  ): Promise<CustomBlockRecord> {
    const { block, role } = await this.blockFor(actorId, blockId);
    this.assertMutable(role);
    const payload = { baseRevision: input.baseRevision };
    const replay = await this.replay(
      actorId,
      block.workspaceId,
      input.operationId,
      "publish",
      blockId,
      payload,
    );
    if (replay) return replay;
    if (block.revision !== input.baseRevision) throw new PublicApiError("REVISION_CONFLICT", 409);
    const current = await this.latest(block.id);
    if (current.status !== "draft") invalid();
    const now = new Date();
    const result = await this.db.transaction(async (tx) => {
      const [updatedBlock] = await tx
        .update(customBlocks)
        .set({ revision: block.revision + 1, updatedAt: now })
        .where(and(eq(customBlocks.id, block.id), eq(customBlocks.revision, input.baseRevision)))
        .returning();
      if (!updatedBlock) throw new PublicApiError("REVISION_CONFLICT", 409);
      const [published] = await tx
        .update(customBlockVersions)
        .set({
          status: "published",
          publishedAt: now,
          operationId: input.operationId,
          operationKind: "publish",
        })
        .where(and(eq(customBlockVersions.id, current.id), eq(customBlockVersions.status, "draft")))
        .returning();
      if (!published) throw new PublicApiError("REVISION_CONFLICT", 409);
      const record = toRecord(updatedBlock, published);
      await tx.insert(customBlockOperations).values({
        workspaceId: block.workspaceId,
        customBlockId: block.id,
        targetBlockId: block.id,
        actorId,
        operationId: input.operationId,
        operationKind: "publish",
        baseRevision: input.baseRevision,
        requestHash: requestHash(payload),
        recordedResponse: record,
      });
      return record;
    });
    return result;
  }

  async removeDraft(
    actorId: string,
    blockId: string,
    input: DeleteCustomBlockInput,
  ): Promise<void> {
    const payload = { baseRevision: input.baseRevision };
    const replay = await this.replay(
      actorId,
      null,
      input.operationId,
      "delete-draft",
      blockId,
      payload,
    );
    if (replay !== undefined) return;
    const { block, role } = await this.blockFor(actorId, blockId);
    this.assertMutable(role);
    const scopedReplay = await this.replay(
      actorId,
      block.workspaceId,
      input.operationId,
      "delete-draft",
      blockId,
      payload,
    );
    if (scopedReplay !== undefined) return;
    if (block.revision !== input.baseRevision) throw new PublicApiError("REVISION_CONFLICT", 409);
    const current = await this.latest(block.id);
    if (current.status !== "draft") invalid();
    const versions = await this.db
      .select({ id: customBlockVersions.id })
      .from(customBlockVersions)
      .where(eq(customBlockVersions.customBlockId, block.id));
    if (versions.length <= 1) {
      await this.db.transaction(async (tx) => {
        await tx.insert(customBlockOperations).values({
          workspaceId: block.workspaceId,
          customBlockId: block.id,
          targetBlockId: block.id,
          actorId,
          operationId: input.operationId,
          operationKind: "delete-draft",
          baseRevision: input.baseRevision,
          requestHash: requestHash(payload),
          recordedResponse: { ok: true },
        });
        const deleted = await tx
          .delete(customBlocks)
          .where(and(eq(customBlocks.id, block.id), eq(customBlocks.revision, input.baseRevision)))
          .returning({ id: customBlocks.id });
        if (deleted.length !== 1) throw new PublicApiError("REVISION_CONFLICT", 409);
      });
      return;
    }
    await this.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(customBlocks)
        .set({ revision: block.revision + 1, updatedAt: new Date() })
        .where(and(eq(customBlocks.id, block.id), eq(customBlocks.revision, input.baseRevision)))
        .returning();
      if (!updated) throw new PublicApiError("REVISION_CONFLICT", 409);
      await tx.delete(customBlockVersions).where(eq(customBlockVersions.id, current.id));
      await tx.insert(customBlockOperations).values({
        workspaceId: block.workspaceId,
        customBlockId: block.id,
        targetBlockId: block.id,
        actorId,
        operationId: input.operationId,
        operationKind: "delete-draft",
        baseRevision: input.baseRevision,
        requestHash: requestHash(payload),
        recordedResponse: { ok: true },
      });
    });
  }
}
