import { z } from "zod";
import { opaqueAuthIdSchema } from "../jobs/schemas.js";
import { canonicalUuidSchema } from "../notes/schemas.js";

// `userId` is a better-auth user id — an opaque text primary key
// (`user.id = text("id")`), NOT a UUID — so it is validated with the shared
// `opaqueAuthIdSchema` (bounded UTF-8 auth id), the same schema used for
// actor ids elsewhere in the contract. `personalWorkspaceId` IS a UUID
// (`workspaces.id = uuid(...)`), so it keeps `canonicalUuidSchema`.
export const meResultSchema = z
  .object({
    userId: opaqueAuthIdSchema,
    personalWorkspaceId: canonicalUuidSchema,
  })
  .strict();

export type MeResult = z.infer<typeof meResultSchema>;

export const meApiContract = {
  getMe: {
    method: "GET",
    path: "/api/v1/me",
    response: meResultSchema,
  },
} as const;
