import type { z } from "zod";
import type {
  createShareLinkInputSchema,
  shareLinkResponseSchema,
  sharedNoteResponseSchema,
} from "./schemas.js";

export type CreateShareLinkInput = z.infer<typeof createShareLinkInputSchema>;
export type ShareLinkResponse = z.infer<typeof shareLinkResponseSchema>;
export type SharedNoteResponse = z.infer<typeof sharedNoteResponseSchema>;
