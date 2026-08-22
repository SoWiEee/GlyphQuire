import {
  noteApiContract as sharedNoteApiContract,
  saveNoteInputSchema as sharedSaveNoteInputSchema,
} from "@glyphquire/api-contract";
import type { SaveNoteInput as SharedSaveNoteInput } from "@glyphquire/api-contract";
import { describe, expect, expectTypeOf, it } from "vitest";
import { noteApiContract, saveNoteInputSchema } from "./notes.js";
import type { SaveNoteInput } from "./notes.js";

describe("API note contract seam", () => {
  it("uses the shared contract and save schema by object identity and type", () => {
    expect(noteApiContract).toBe(sharedNoteApiContract);
    expect(saveNoteInputSchema).toBe(sharedSaveNoteInputSchema);
    expect(noteApiContract.saveNote.request.shape.body).toBe(sharedSaveNoteInputSchema);
    expectTypeOf<typeof noteApiContract>().toEqualTypeOf<typeof sharedNoteApiContract>();
    expectTypeOf<typeof saveNoteInputSchema>().toEqualTypeOf<typeof sharedSaveNoteInputSchema>();
    expectTypeOf<SaveNoteInput>().toEqualTypeOf<SharedSaveNoteInput>();
  });
});
