import {
  customBlockDefinitionSchema,
  customBlockListResultSchema,
  type CreateCustomBlockInput,
  type CustomBlockListResult,
  type CustomBlockRecord,
  type PublishCustomBlockInput,
  type UpdateCustomBlockDraftInput,
} from "@glyphquire/api-contract";
import {
  customBlockVersions,
  customBlocks,
  workspaceMembers,
  type Database,
} from "@glyphquire/database";
import { and, desc, eq } from "drizzle-orm";
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
  removeDraft(actorId: string, blockId: string): Promise<void>;
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

  private async replay(actorId: string, operationId: string) {
    const rows = await this.db
      .select({ block: customBlocks, version: customBlockVersions })
      .from(customBlockVersions)
      .innerJoin(customBlocks, eq(customBlocks.id, customBlockVersions.customBlockId))
      .where(
        and(
          eq(customBlockVersions.createdBy, actorId),
          eq(customBlockVersions.operationId, operationId),
        ),
      )
      .limit(1);
    const row = rows[0];
    return row;
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
    const replay = await this.replay(actorId, input.operationId);
    const definition = customBlockDefinitionSchema.safeParse(input.definition);
    if (!definition.success) invalid();
    if (replay) {
      if (
        replay.version.operationKind !== "create" ||
        replay.block.workspaceId !== workspaceId ||
        stableJson(replay.version.definition) !== stableJson(definition.data)
      ) {
        operationReused();
      }
      return toRecord(replay.block, replay.version);
    }
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
      return toRecord(block, version);
    });
    return result;
  }

  async updateDraft(
    actorId: string,
    blockId: string,
    input: UpdateCustomBlockDraftInput,
  ): Promise<CustomBlockRecord> {
    const { block, role } = await this.blockFor(actorId, blockId);
    this.assertMutable(role);
    const replay = await this.replay(actorId, input.operationId);
    const definition = customBlockDefinitionSchema.safeParse(input.definition);
    if (!definition.success || definition.data.name !== block.name) invalid();
    if (replay) {
      if (
        replay.block.id !== blockId ||
        replay.version.operationKind !== "update-draft" ||
        stableJson(replay.version.definition) !== stableJson(definition.data)
      ) {
        operationReused();
      }
      return toRecord(replay.block, replay.version);
    }
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
        return toRecord(updatedBlock, updatedVersion);
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
      return toRecord(updatedBlock, draft);
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
    const replay = await this.replay(actorId, input.operationId);
    if (replay) {
      if (replay.block.id !== blockId || replay.version.operationKind !== "publish") {
        operationReused();
      }
      return toRecord(replay.block, replay.version);
    }
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
      return toRecord(updatedBlock, published);
    });
    return result;
  }

  async removeDraft(actorId: string, blockId: string): Promise<void> {
    const { block, role } = await this.blockFor(actorId, blockId);
    this.assertMutable(role);
    const current = await this.latest(block.id);
    if (current.status !== "draft") invalid();
    const versions = await this.db
      .select({ id: customBlockVersions.id })
      .from(customBlockVersions)
      .where(eq(customBlockVersions.customBlockId, block.id));
    if (versions.length <= 1) {
      await this.db.delete(customBlocks).where(eq(customBlocks.id, block.id));
      return;
    }
    await this.db.delete(customBlockVersions).where(eq(customBlockVersions.id, current.id));
  }
}
