import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import * as apiContract from "./index.js";
import {
  MAINTENANCE_CAPABILITIES,
  assetCleanupRequestSchema,
  backupVerificationQuerySchema,
  backupVerificationResponseSchema,
  deadLetterQuerySchema,
  deadLetterReplayParamsSchema,
  deadLetterResponseSchema,
  deletionConfirmationSchema,
  deletionResponseSchema,
  maintenanceCapabilitiesResponseSchema,
  maintenanceJobMutationResponseSchema,
  maintenanceSearchRebuildRequestSchema,
} from "./maintenance/schemas.js";

const workspaceId = randomUUID();

describe("Maintenance contracts", () => {
  it("accepts only the exact destructive confirmation", () => {
    expect(deletionConfirmationSchema.parse({ confirm: "DELETE_WORKSPACE" })).toEqual({
      confirm: "DELETE_WORKSPACE",
    });
    expect(deletionConfirmationSchema.safeParse({ confirm: "delete_workspace" }).success).toBe(
      false,
    );
    expect(
      deletionConfirmationSchema.safeParse({ confirm: "DELETE_WORKSPACE", accountId: "victim" })
        .success,
    ).toBe(false);
  });

  it("strictly bounds operator mutation requests", () => {
    expect(maintenanceSearchRebuildRequestSchema.parse({ workspaceId, batchSize: 100 })).toEqual({
      workspaceId,
      batchSize: 100,
    });
    expect(
      maintenanceSearchRebuildRequestSchema.safeParse({ workspaceId, batchSize: 101 }).success,
    ).toBe(false);
    expect(assetCleanupRequestSchema.safeParse({ workspaceId, batchSize: 0 }).success).toBe(false);
    expect(
      assetCleanupRequestSchema.safeParse({ workspaceId, batchSize: 1, objectKey: "attacker/key" })
        .success,
    ).toBe(false);
  });

  it("never exposes capabilities to a denied actor", () => {
    expect(
      maintenanceCapabilitiesResponseSchema.parse({
        operator: true,
        capabilities: [...MAINTENANCE_CAPABILITIES],
      }),
    ).toEqual({ operator: true, capabilities: [...MAINTENANCE_CAPABILITIES] });
    expect(
      maintenanceCapabilitiesResponseSchema.parse({ operator: false, capabilities: [] }),
    ).toEqual({ operator: false, capabilities: [] });
    expect(
      maintenanceCapabilitiesResponseSchema.safeParse({
        operator: false,
        capabilities: [MAINTENANCE_CAPABILITIES[0]],
      }).success,
    ).toBe(false);
    expect(
      maintenanceCapabilitiesResponseSchema.safeParse({
        operator: true,
        capabilities: ["shell.exec"],
      }).success,
    ).toBe(false);
  });

  it("keeps dead-letter and backup diagnostics bounded and scrubbed", () => {
    const cursor = Buffer.from(
      JSON.stringify({ createdAt: "2026-08-26T00:00:00.000Z", id: randomUUID() }),
    ).toString("base64url");
    expect(deadLetterQuerySchema.parse({ pageSize: 100, cursor })).toEqual({
      pageSize: 100,
      cursor,
    });
    expect(deadLetterQuerySchema.safeParse({ pageSize: 101 }).success).toBe(false);
    expect(deadLetterReplayParamsSchema.safeParse({ id: "not-a-uuid" }).success).toBe(false);

    const deadLetter = {
      items: [
        {
          id: randomUUID(),
          workspaceId,
          type: "export",
          attempts: 5,
          maxAttempts: 5,
          createdAt: "2026-08-26T00:00:00.000Z",
          deadLetteredAt: "2026-08-26T00:05:00.000Z",
          errorCode: "JOB_FAILED",
        },
      ],
      nextCursor: null,
    };
    expect(deadLetterResponseSchema.safeParse(deadLetter).success).toBe(true);
    expect(
      deadLetterResponseSchema.safeParse({
        ...deadLetter,
        items: [{ ...deadLetter.items[0], payload: { token: "secret" } }],
      }).success,
    ).toBe(false);

    expect(backupVerificationQuerySchema.safeParse({ pageSize: 0 }).success).toBe(false);
    const verification = {
      items: [
        {
          jobId: randomUUID(),
          backupId: randomUUID(),
          status: "dead_letter",
          createdAt: "2026-08-26T00:00:00.000Z",
          completedAt: null,
          errorCode: "JOB_FAILED",
        },
      ],
      nextCursor: null,
    };
    expect(backupVerificationResponseSchema.safeParse(verification).success).toBe(true);
    expect(
      backupVerificationResponseSchema.safeParse({
        ...verification,
        items: [{ ...verification.items[0], lastError: "s3 secret" }],
      }).success,
    ).toBe(false);
  });

  it("strictly validates lifecycle and mutation responses", () => {
    const deletion = {
      id: randomUUID(),
      status: "pending",
      confirmedAt: "2026-08-26T00:00:00.000Z",
      executeAfter: "2026-08-27T00:00:00.000Z",
    };
    expect(deletionResponseSchema.safeParse(deletion).success).toBe(true);
    expect(deletionResponseSchema.safeParse({ ...deletion, accountId: "secret" }).success).toBe(
      false,
    );
    expect(
      maintenanceJobMutationResponseSchema.safeParse({
        jobId: randomUUID(),
        duplicate: false,
      }).success,
    ).toBe(true);
  });

  it("exports every public maintenance contract from the package root", () => {
    for (const key of [
      "MAINTENANCE_CAPABILITIES",
      "deletionConfirmationSchema",
      "deletionResponseSchema",
      "maintenanceCapabilitiesResponseSchema",
      "maintenanceSearchRebuildRequestSchema",
      "maintenanceJobMutationResponseSchema",
      "deadLetterQuerySchema",
      "deadLetterResponseSchema",
      "assetCleanupRequestSchema",
      "backupVerificationResponseSchema",
    ]) {
      expect(apiContract).toHaveProperty(key);
    }
  });
});
