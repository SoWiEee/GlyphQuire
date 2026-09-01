import type { z } from "zod";
import type {
  createCustomBlockInputSchema,
  customBlockListResultSchema,
  customBlockRecordSchema,
  publishCustomBlockInputSchema,
  updateCustomBlockDraftInputSchema,
} from "./schemas.js";

export type CustomBlockRecord = z.infer<typeof customBlockRecordSchema>;
export type CustomBlockListResult = z.infer<typeof customBlockListResultSchema>;
export type CreateCustomBlockInput = z.infer<typeof createCustomBlockInputSchema>;
export type UpdateCustomBlockDraftInput = z.infer<typeof updateCustomBlockDraftInputSchema>;
export type PublishCustomBlockInput = z.infer<typeof publishCustomBlockInputSchema>;
