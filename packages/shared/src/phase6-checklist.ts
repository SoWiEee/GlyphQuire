import { z } from "zod";

export const phase6Gates = [
  "P0-01",
  "P0-02",
  "P0-03",
  "P0-04",
  "P0-05",
  "P0-06",
  "P0-07",
  "P0-08",
  "P0-09",
  "P0-10",
  "P0-11",
  "P0-12",
  "P0-13",
  "P0-14",
] as const;
export const phase6ChecklistStatus = ["blocked", "in_progress", "passed"] as const;
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const gitSha = z.string().regex(/^[a-f0-9]{40}$/);
const imageDigest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const migrationJournalSchema = z
  .object({
    "0000": sha256,
    "0001": sha256,
    "0002": sha256,
    "0003": sha256,
    "0004": sha256,
    "0005": sha256,
    "0006": sha256,
    "0007": sha256,
    "0008": sha256,
    "0009": sha256,
    "0010": sha256,
    "0011": sha256,
  })
  .strict();

export const phase6ChecklistSchema = z
  .object({
    gate: z.enum(phase6Gates),
    status: z.enum(phase6ChecklistStatus),
    area: z.string().optional(),
    evidence: z.array(z.string()).optional(),
    command: z.string().optional(),
    owner: z.string().optional(),
    recordedAt: z.string().datetime({ offset: true }).optional(),
    notes: z.string().optional(),
  })
  .strict();

export const phase6ArtifactManifestSchema = z
  .object({
    candidateSourceSha: gitSha,
    lockfileSha256: sha256,
    nodeVersion: z.string().min(1),
    pnpmVersion: z.string().min(1),
    migrationJournal: migrationJournalSchema,
    imageDigests: z.object({ api: imageDigest, web: imageDigest, worker: imageDigest }).strict(),
  })
  .strict();

export const phase6ReleaseDecisionSchema = z
  .object({
    rows: z.array(phase6ChecklistSchema),
    artifactManifest: phase6ArtifactManifestSchema,
    evidencePublicationSha: gitSha,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.rows.length !== phase6Gates.length)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rows"],
        message: "exactly fourteen P0 rows are required",
      });
    const gates = value.rows.map((row) => row.gate);
    if (
      new Set(gates).size !== phase6Gates.length ||
      phase6Gates.some((gate) => !gates.includes(gate))
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rows"],
        message: "P0-01 through P0-14 must appear exactly once",
      });
    value.rows.forEach((row, index) => {
      if (row.status !== "passed")
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["rows", index, "status"],
          message: "release decisions require passed rows",
        });
    });
  });

export type Phase6Checklist = z.infer<typeof phase6ChecklistSchema>;
export type Phase6ArtifactManifest = z.infer<typeof phase6ArtifactManifestSchema>;
export type Phase6ReleaseDecision = z.infer<typeof phase6ReleaseDecisionSchema>;
