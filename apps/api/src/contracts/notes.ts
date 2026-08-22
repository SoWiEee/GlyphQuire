import {
  noteApiContract as sharedNoteApiContract,
  saveNoteInputSchema as sharedSaveNoteInputSchema,
} from "@glyphquire/api-contract";

export type { SaveNoteInput } from "@glyphquire/api-contract";

export const noteApiContract = sharedNoteApiContract;
export const saveNoteInputSchema = sharedSaveNoteInputSchema;
