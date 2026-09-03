import { z } from "zod";

const MAX_USER_ID_BYTES = 200;
const utf8ByteLength = (value: string) => new TextEncoder().encode(value).byteLength;

/**
 * User id accepted by cross-tab coordination scope (NoteScope, LiveBrowserSession).
 * A better-auth user id is opaque text, NOT a canonical UUID — unlike workspaceId
 * and noteId, which are real UUID database columns. This schema accepts any
 * non-empty, byte-bounded string EXCEPT one containing `:`, because userId is
 * interpolated into `:`-delimited BroadcastChannel/LockManager names
 * (`noteLockName`, `tabChannelName`); an unconstrained value could otherwise
 * make that delimited name ambiguous. A canonical UUID satisfies this schema
 * (it contains no `:`), so existing UUID-based fixtures remain valid unchanged.
 */
export const coordinationUserIdSchema = z
  .string()
  .min(1)
  .refine((value) => !value.includes(":"), {
    message: "User id must not contain \":\"",
  })
  .superRefine((value, context) => {
    if (utf8ByteLength(value) > MAX_USER_ID_BYTES) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `User id must be at most ${MAX_USER_ID_BYTES} UTF-8 bytes`,
      });
    }
  });
