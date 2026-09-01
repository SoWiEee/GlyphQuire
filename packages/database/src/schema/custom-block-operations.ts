import { relations, sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { user } from "./auth.js";
import { customBlocks, type CustomBlockOperationKind } from "./custom-blocks.js";
import { workspaces } from "./workspaces.js";

export const customBlockOperations = pgTable(
  "custom_block_operations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    customBlockId: uuid("custom_block_id").references(() => customBlocks.id, {
      onDelete: "set null",
    }),
    targetBlockId: uuid("target_block_id").notNull(),
    actorId: text("actor_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    operationId: text("operation_id").notNull(),
    operationKind: varchar("operation_kind", { length: 12 })
      .$type<CustomBlockOperationKind>()
      .notNull(),
    baseRevision: integer("base_revision"),
    requestHash: text("request_hash").notNull(),
    recordedResponse: jsonb("recorded_response").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("custom_block_operations_actor_scope_unique").on(
      table.actorId,
      table.workspaceId,
      table.operationId,
    ),
    index("custom_block_operations_block_idx").on(table.customBlockId),
    index("custom_block_operations_target_idx").on(table.targetBlockId),
    check(
      "custom_block_operations_kind_check",
      sql`${table.operationKind} in ('create', 'update-draft', 'publish', 'delete-draft')`,
    ),
    check(
      "custom_block_operations_base_revision_check",
      sql`(${table.operationKind} = 'create' and ${table.baseRevision} is null) or (${table.operationKind} <> 'create' and ${table.baseRevision} > 0)`,
    ),
    check(
      "custom_block_operations_request_hash_check",
      sql`char_length(${table.requestHash}) = 64`,
    ),
    check(
      "custom_block_operations_response_object_check",
      sql`jsonb_typeof(${table.recordedResponse}) = 'object'`,
    ),
  ],
);

export const customBlockOperationsRelations = relations(customBlockOperations, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [customBlockOperations.workspaceId],
    references: [workspaces.id],
  }),
  block: one(customBlocks, {
    fields: [customBlockOperations.customBlockId],
    references: [customBlocks.id],
  }),
  actor: one(user, {
    fields: [customBlockOperations.actorId],
    references: [user.id],
  }),
}));
