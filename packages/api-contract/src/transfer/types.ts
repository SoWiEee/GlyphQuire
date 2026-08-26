import type { z } from "zod";
import type {
  exportFormatSchema,
  exportResultSchema,
  importJobResultSchema,
  transferProgressSchema,
} from "./schemas.js";

export type TransferProgress = z.infer<typeof transferProgressSchema>;
export type ImportJobResult = z.infer<typeof importJobResultSchema>;
export type ExportFormat = z.infer<typeof exportFormatSchema>;
export type ExportResult = z.infer<typeof exportResultSchema>;
