import { z } from "zod";
import {
  canonicalUuidSchema,
  cursorSchema as paginationCursorSchema,
  revisionSchema,
  timestampSchema,
} from "../notes/schemas.js";
import type { Cursor, JobPayloadMap, JobType } from "./types.js";

export const MAX_JOB_PAYLOAD_BYTES = 64 * 1024;
export const MAX_IDEMPOTENCY_KEY_BYTES = 200;
export const MAX_AUTH_ID_BYTES = 200;

export const JOB_TYPES = [
  "search.index",
  "search.remove",
  "search.rebuild",
  "asset.cleanup",
  "asset.orphan_cleanup",
  "asset.thumbnail",
  "import",
  "import.cleanup",
  "export",
  "export.expire",
  "share.cleanup",
  "version.retention",
  "idempotency.cleanup",
  "backup.verify",
  "workspace.purge",
  "account.purge",
] as const satisfies readonly JobType[];

export const P0_JOB_TYPES = [
  "search.index",
  "search.remove",
  "search.rebuild",
  "asset.cleanup",
  "import",
  "import.cleanup",
  "export",
  "export.expire",
  "share.cleanup",
  "version.retention",
  "workspace.purge",
  "account.purge",
  "backup.verify",
] as const satisfies readonly JobType[];

export const P1_JOB_TYPES = [
  "asset.thumbnail",
  "asset.orphan_cleanup",
  "idempotency.cleanup",
] as const satisfies readonly JobType[];

const utf8ByteLength = (value: string) => new TextEncoder().encode(value).byteLength;

const boundedUtf8String = (label: string, maximum: number) =>
  z
    .string()
    .min(1)
    .superRefine((value, context) => {
      if (utf8ByteLength(value) > maximum) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${label} must be at most ${maximum} UTF-8 bytes`,
        });
      }
    });

export const opaqueAuthIdSchema = boundedUtf8String("Auth ID", MAX_AUTH_ID_BYTES);

export const idempotencyKeySchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9._~-]+$/, "Idempotency key contains unsupported characters")
  .superRefine((value, context) => {
    if (utf8ByteLength(value) > MAX_IDEMPOTENCY_KEY_BYTES) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Idempotency key must be at most ${MAX_IDEMPOTENCY_KEY_BYTES} UTF-8 bytes`,
      });
    }
  });

const scanBatchSizeSchema = z.number().int().min(1).max(100);

const searchMutationPayloadSchema = z
  .object({
    workspaceId: canonicalUuidSchema,
    noteId: canonicalUuidSchema,
    revision: revisionSchema,
    operationId: canonicalUuidSchema,
  })
  .strict();

const searchRebuildPayloadSchema = z.discriminatedUnion("scope", [
  z
    .object({
      workspaceId: canonicalUuidSchema,
      scope: z.literal("note"),
      noteId: canonicalUuidSchema,
      batchSize: z.literal(1),
      cursor: paginationCursorSchema.optional(),
    })
    .strict(),
  z
    .object({
      workspaceId: canonicalUuidSchema,
      scope: z.literal("workspace"),
      batchSize: scanBatchSizeSchema,
      cursor: paginationCursorSchema.optional(),
    })
    .strict(),
]);

const assetPayloadSchema = z
  .object({ workspaceId: canonicalUuidSchema, assetId: canonicalUuidSchema })
  .strict();

const scanPayloadSchema = z
  .object({
    workspaceId: canonicalUuidSchema,
    batchSize: scanBatchSizeSchema,
    cursor: paginationCursorSchema.optional(),
  })
  .strict();

const importPayloadSchema = z
  .object({
    workspaceId: canonicalUuidSchema,
    importId: canonicalUuidSchema,
    actorId: opaqueAuthIdSchema,
    noteId: canonicalUuidSchema.optional(),
    baseRevision: revisionSchema.optional(),
  })
  .strict();

const importCleanupPayloadSchema = z.discriminatedUnion("scope", [
  z
    .object({
      workspaceId: canonicalUuidSchema,
      scope: z.literal("one"),
      importId: canonicalUuidSchema,
    })
    .strict(),
  z
    .object({
      workspaceId: canonicalUuidSchema,
      scope: z.literal("staging"),
      batchSize: scanBatchSizeSchema,
      cursor: paginationCursorSchema.optional(),
    })
    .strict(),
]);

const exportPayloadSchema = z
  .object({ workspaceId: canonicalUuidSchema, exportId: canonicalUuidSchema })
  .strict();

const shareCleanupPayloadSchema = z.discriminatedUnion("scope", [
  z
    .object({
      workspaceId: canonicalUuidSchema,
      scope: z.literal("one"),
      shareLinkId: canonicalUuidSchema,
    })
    .strict(),
  z
    .object({
      workspaceId: canonicalUuidSchema,
      scope: z.literal("expired"),
      batchSize: scanBatchSizeSchema,
      cursor: paginationCursorSchema.optional(),
    })
    .strict(),
]);

const versionRetentionPayloadSchema = z.discriminatedUnion("scope", [
  z
    .object({
      workspaceId: canonicalUuidSchema,
      scope: z.literal("note"),
      noteId: canonicalUuidSchema,
      batchSize: z.literal(1),
    })
    .strict(),
  z
    .object({
      workspaceId: canonicalUuidSchema,
      scope: z.literal("workspace"),
      batchSize: scanBatchSizeSchema,
      cursor: paginationCursorSchema.optional(),
    })
    .strict(),
]);

const backupVerifyPayloadSchema = z
  .object({ workspaceId: canonicalUuidSchema.nullable(), backupId: canonicalUuidSchema })
  .strict();

const workspacePurgePayloadSchema = z
  .object({ workspaceId: canonicalUuidSchema, deletionId: canonicalUuidSchema })
  .strict();

const accountPurgePayloadSchema = z
  .object({
    workspaceId: canonicalUuidSchema.nullable(),
    accountDeletionId: canonicalUuidSchema,
    accountId: opaqueAuthIdSchema,
  })
  .strict();

export const jobPayloadSchemas = {
  "search.index": searchMutationPayloadSchema,
  "search.remove": searchMutationPayloadSchema,
  "search.rebuild": searchRebuildPayloadSchema,
  "asset.cleanup": assetPayloadSchema,
  "asset.orphan_cleanup": scanPayloadSchema,
  "asset.thumbnail": assetPayloadSchema,
  import: importPayloadSchema,
  "import.cleanup": importCleanupPayloadSchema,
  export: exportPayloadSchema,
  "export.expire": scanPayloadSchema,
  "share.cleanup": shareCleanupPayloadSchema,
  "version.retention": versionRetentionPayloadSchema,
  "idempotency.cleanup": scanPayloadSchema,
  "backup.verify": backupVerifyPayloadSchema,
  "workspace.purge": workspacePurgePayloadSchema,
  "account.purge": accountPurgePayloadSchema,
} as const satisfies { [K in JobType]: z.ZodType<JobPayloadMap[K]> };

export const jobTypeSchema = z.enum(JOB_TYPES);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

const envelopeShapeSchema = z
  .object({
    id: canonicalUuidSchema,
    workspaceId: canonicalUuidSchema.nullable(),
    type: jobTypeSchema,
    version: z.literal(1),
    attempts: z.number().int().positive(),
    createdAt: timestampSchema,
    payload: z.unknown(),
  })
  .strict()
  .superRefine((value, context) => {
    const payloadResult = jobPayloadSchemas[value.type].safeParse(value.payload);
    if (!payloadResult.success) {
      for (const issue of payloadResult.error.issues) {
        context.addIssue({ ...issue, path: ["payload", ...issue.path] });
      }
      return;
    }

    let payloadBytes: number;
    try {
      payloadBytes = utf8ByteLength(JSON.stringify(payloadResult.data));
    } catch {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["payload"],
        message: "Invalid payload",
      });
      return;
    }
    if (payloadBytes > MAX_JOB_PAYLOAD_BYTES) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["payload"],
        message: `Job payload must be at most ${MAX_JOB_PAYLOAD_BYTES} UTF-8 bytes`,
      });
    }

    const payloadWorkspaceId = payloadResult.data.workspaceId;
    const nullableRoutingType = ["workspace.purge", "account.purge", "backup.verify"].includes(
      value.type,
    );
    if (!nullableRoutingType && value.workspaceId === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["workspaceId"],
        message: "Workspace-scoped job requires a routing workspace",
      });
    } else if (value.workspaceId !== null && value.workspaceId !== payloadWorkspaceId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["workspaceId"],
        message: "Routing workspace does not match payload workspace",
      });
    }
  });

export const jobEnvelopeSchema = z.preprocess((value, context) => {
  if (!isPlainRecord(value) || !isPlainRecord(value.payload)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Job envelope and payload must be plain objects",
    });
    return z.NEVER;
  }
  return value;
}, envelopeShapeSchema);

const cursorValueSchema = z
  .object({ createdAt: timestampSchema, id: canonicalUuidSchema })
  .strict();
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export const cursorSchema = paginationCursorSchema.pipe(
  z.string().regex(BASE64URL_PATTERN, "Cursor must use unpadded base64url encoding"),
);

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function fromBase64Url(value: string): Uint8Array {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(base64 + padding);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function encodeCursor(value: Cursor): string {
  const parsed = cursorValueSchema.parse(value);
  return toBase64Url(new TextEncoder().encode(JSON.stringify(parsed)));
}

export function decodeCursor(value: string): Cursor {
  try {
    const parsedCursor = cursorSchema.parse(value);
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(fromBase64Url(parsedCursor));
    const parsed = cursorValueSchema.parse(JSON.parse(decoded));
    if (encodeCursor(parsed) !== parsedCursor) throw new Error("non-canonical cursor");
    return parsed;
  } catch {
    throw new Error("Invalid canonical cursor");
  }
}
