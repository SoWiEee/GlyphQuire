import type { z } from "zod";
import type {
  assetCleanupRequestSchema,
  backupVerificationItemSchema,
  backupVerificationQuerySchema,
  backupVerificationResponseSchema,
  deadLetterItemSchema,
  deadLetterQuerySchema,
  deadLetterResponseSchema,
  deletionConfirmationSchema,
  deletionResponseSchema,
  maintenanceCapabilitiesResponseSchema,
  maintenanceJobMutationResponseSchema,
  maintenanceSearchRebuildRequestSchema,
} from "./schemas.js";

export type DeletionConfirmation = z.infer<typeof deletionConfirmationSchema>;
export type DeletionResponse = z.infer<typeof deletionResponseSchema>;
export type MaintenanceCapabilitiesResponse = z.infer<
  typeof maintenanceCapabilitiesResponseSchema
>;
export type MaintenanceSearchRebuildRequest = z.infer<
  typeof maintenanceSearchRebuildRequestSchema
>;
export type AssetCleanupRequest = z.infer<typeof assetCleanupRequestSchema>;
export type MaintenanceJobMutationResponse = z.infer<
  typeof maintenanceJobMutationResponseSchema
>;
export type DeadLetterQuery = z.infer<typeof deadLetterQuerySchema>;
export type DeadLetterItem = z.infer<typeof deadLetterItemSchema>;
export type DeadLetterResponse = z.infer<typeof deadLetterResponseSchema>;
export type BackupVerificationQuery = z.infer<typeof backupVerificationQuerySchema>;
export type BackupVerificationItem = z.infer<typeof backupVerificationItemSchema>;
export type BackupVerificationResponse = z.infer<typeof backupVerificationResponseSchema>;
