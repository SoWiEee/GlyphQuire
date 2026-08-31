import { z } from "zod";

export const releaseGates = [
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
export const releaseChecklistStatus = ["blocked", "in_progress", "passed"] as const;
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

export const releaseChecklistSchema = z
  .object({
    gate: z.enum(releaseGates),
    status: z.enum(releaseChecklistStatus),
    area: z.string().optional(),
    evidence: z.array(z.string()).optional(),
    command: z.string().optional(),
    owner: z.string().optional(),
    recordedAt: z.string().datetime({ offset: true }).optional(),
    notes: z.string().optional(),
  })
  .strict();

const releaseDecisionRowSchema = releaseChecklistSchema.extend({
  status: z.literal("passed"),
});

export const releaseArtifactManifestSchema = z
  .object({
    candidateSourceSha: gitSha,
    lockfileSha256: sha256,
    nodeVersion: z.string().min(1),
    pnpmVersion: z.string().min(1),
    migrationJournal: migrationJournalSchema,
    imageDigests: z.object({ api: imageDigest, web: imageDigest, worker: imageDigest }).strict(),
  })
  .strict();

export const releaseDecisionSchema = z
  .object({
    rows: z.array(releaseDecisionRowSchema).length(releaseGates.length),
    artifactManifest: releaseArtifactManifestSchema,
    evidencePublicationSha: gitSha,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.rows.length !== releaseGates.length)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rows"],
        message: "exactly fourteen P0 rows are required",
      });
    const gates = value.rows.map((row) => row.gate);
    if (
      new Set(gates).size !== releaseGates.length ||
      releaseGates.some((gate) => !gates.includes(gate))
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rows"],
        message: "P0-01 through P0-14 must appear exactly once",
      });
  });

export type ReleaseChecklist = z.infer<typeof releaseChecklistSchema>;
export type ReleaseArtifactManifest = z.infer<typeof releaseArtifactManifestSchema>;
export type ReleaseDecision = z.infer<typeof releaseDecisionSchema>;
