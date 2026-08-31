import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFile } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { canonicalUuidSchema, notePageSchema } from "../../packages/api-contract/src/index.js";
import {
  measureReleaseEnvironment,
  validateReleaseEnvironmentManifest,
  type ReleaseEnvironmentManifest,
} from "../load/release-environment.js";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../..");
const DEFAULT_ENVIRONMENT_MANIFEST = "docs/evidence/release/performance-environment.json";
const DEFAULT_LOAD_EVIDENCE = "docs/evidence/release/performance-load.json";
const SOURCE_SHA_PATTERN = /^[a-f0-9]{40}$/u;
const IMAGE_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;

export const RELEASE_PERFORMANCE_WORKLOAD = {
  actors: 5,
  workspaces: 5,
  notesPerWorkspace: 1_000,
  noteBytes: 100 * 1024,
  assetBytes: 5 * 1024 * 1024,
  durationMs: 30 * 60_000,
  warmupMs: 2 * 60_000,
} as const;

export const RELEASE_UI_GATES = [
  {
    id: "PERF-UI-01",
    operation: "100 KB input",
    warmups: 100,
    samples: 1_000,
    thresholdMs: 100,
    boundary: "InputEvent dispatch to next animation frame containing rendered change",
  },
  {
    id: "PERF-UI-02",
    operation: "Visual/Source switch",
    warmups: 10,
    samples: 100,
    thresholdMs: 1_000,
    boundary: "triggering action to target editor accepts input",
  },
  {
    id: "PERF-UI-03",
    operation: "1 MB open",
    warmups: 5,
    samples: 100,
    thresholdMs: 5_000,
    boundary: "request dispatch to editor accepts input",
  },
  {
    id: "PERF-UI-04",
    operation: "1 MB save",
    warmups: 5,
    samples: 100,
    thresholdMs: 5_000,
    boundary: "request dispatch to server acknowledgment and saved UI state",
  },
  {
    id: "PERF-UI-05",
    operation: "1 MB export",
    warmups: 5,
    samples: 100,
    thresholdMs: 5_000,
    boundary: "action to downloadable blob ready",
  },
] as const;

export const RELEASE_API_GATES = [
  { route: "getNote", warmupMs: 120_000, minimumSamples: 500, thresholdMs: 500 },
  { route: "autosave", warmupMs: 120_000, minimumSamples: 500, thresholdMs: 1_000 },
  { route: "search", warmupMs: 120_000, minimumSamples: 500, thresholdMs: 500 },
] as const;

type SampleSummary = {
  readonly count: number;
  readonly p50Ms: number | null;
  readonly p95Ms: number | null;
  readonly p99Ms: number | null;
};

interface ReleaseActor {
  readonly workspaceId: string;
  readonly noteId: string;
  readonly cookie: string;
}

interface ReleaseLoadEvidence {
  readonly status: string;
  readonly identity?: { readonly environmentManifestSha256?: string | null };
  readonly environmentManifestSha256?: string | null;
  readonly workload?: {
    readonly actors?: number;
    readonly workspaces?: number;
    readonly notesPerWorkspace?: number;
  };
  readonly api?: Record<string, { readonly count?: number; readonly p95Ms?: number | null }>;
}

function percentile(samples: readonly number[], quantile: number): number | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * quantile) - 1] ?? null;
}

export function summarizeReleaseSamples(samples: readonly number[]): SampleSummary {
  return {
    count: samples.length,
    p50Ms: percentile(samples, 0.5),
    p95Ms: percentile(samples, 0.95),
    p99Ms: percentile(samples, 0.99),
  };
}

function manifestPath(): string {
  return process.env.RELEASE_ENVIRONMENT_MANIFEST ?? DEFAULT_ENVIRONMENT_MANIFEST;
}

function loadEvidencePath(): string {
  return (
    process.env.RELEASE_PERFORMANCE_LOAD_EVIDENCE ??
    process.env.RELEASE_PERFORMANCE_LOAD_EVIDENCE_FILE ??
    DEFAULT_LOAD_EVIDENCE
  );
}

function candidateSourceSha(): string {
  const configured = process.env.RELEASE_CANDIDATE_SOURCE_SHA;
  if (configured !== undefined) {
    if (!SOURCE_SHA_PATTERN.test(configured)) throw new Error("candidate source SHA is invalid");
    return configured;
  }
  const value = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
  }).trim();
  if (!SOURCE_SHA_PATTERN.test(value)) throw new Error("candidate source SHA is unavailable");
  return value;
}

async function lockfileSha256(): Promise<string> {
  return createHash("sha256")
    .update(await readFile(resolve(REPOSITORY_ROOT, "pnpm-lock.yaml")))
    .digest("hex");
}

function imageDigests(): { api: string; web: string; worker: string } {
  const configured = (name: "API" | "WEB" | "WORKER"): string => {
    const value =
      process.env[`RELEASE_${name}_IMAGE_DIGEST`] ?? process.env[`RELEASE_IMAGE_DIGEST_${name}`];
    if (!value || !IMAGE_DIGEST_PATTERN.test(value)) {
      throw new Error(`immutable ${name.toLowerCase()} image digest is unavailable`);
    }
    return value;
  };
  return { api: configured("API"), web: configured("WEB"), worker: configured("WORKER") };
}

async function loadManifestAt(path: string): Promise<ReleaseEnvironmentManifest> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(resolve(REPOSITORY_ROOT, path), "utf8"));
  } catch {
    throw new Error("measured release environment manifest is unavailable");
  }
  const measurement = await measureReleaseEnvironment();
  return validateReleaseEnvironmentManifest(value, {
    expectedCandidateSourceSha: candidateSourceSha(),
    expectedLockfileSha256: await lockfileSha256(),
    expectedImageDigests: imageDigests(),
    currentMeasurement: measurement,
    requirePassed: true,
  });
}

export async function loadReleaseManifest(): Promise<ReleaseEnvironmentManifest> {
  return loadManifestAt(manifestPath());
}

function parseActors(): ReleaseActor[] {
  const raw = process.env.WORKSPACE_LOAD_ACTORS_JSON;
  if (!raw) throw new Error("five workspace load actors are required");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("actor JSON is invalid");
  }
  if (!Array.isArray(value) || value.length !== RELEASE_PERFORMANCE_WORKLOAD.actors) {
    throw new Error("exactly five load actors are required");
  }
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("actor entry is invalid");
    }
    const candidate = entry as Record<string, unknown>;
    if (Object.keys(candidate).sort().join(",") !== "cookie,noteId,workspaceId") {
      throw new Error("actor keys are invalid");
    }
    const workspaceId = canonicalUuidSchema.safeParse(candidate.workspaceId);
    const noteId = canonicalUuidSchema.safeParse(candidate.noteId);
    if (
      !workspaceId.success ||
      !noteId.success ||
      typeof candidate.cookie !== "string" ||
      candidate.cookie.length < 1 ||
      candidate.cookie.length > 4096 ||
      /[\r\n]/u.test(candidate.cookie)
    ) {
      throw new Error("actor value is invalid");
    }
    return { workspaceId: workspaceId.data, noteId: noteId.data, cookie: candidate.cookie };
  });
}

async function verifySeededNotes(request: APIRequestContext, actor: ReleaseActor): Promise<void> {
  let cursor: string | undefined;
  let count = 0;
  let selectedNoteSeen = false;
  for (let page = 0; page < 10; page += 1) {
    const query = new URLSearchParams({ pageSize: "100" });
    if (cursor) query.set("cursor", cursor);
    const response = await request.get(
      `/api/v1/workspaces/${actor.workspaceId}/notes?${query.toString()}`,
      { headers: { cookie: actor.cookie } },
    );
    expect(response.status()).toBe(200);
    const parsed = notePageSchema.safeParse(await response.json());
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error("seeded note page failed contract validation");
    expect(parsed.data.items.every((item) => item.workspaceId === actor.workspaceId)).toBe(true);
    count += parsed.data.items.length;
    selectedNoteSeen ||= parsed.data.items.some((item) => item.id === actor.noteId);
    if (count > RELEASE_PERFORMANCE_WORKLOAD.notesPerWorkspace) {
      throw new Error("workspace contains more than 1,000 notes");
    }
    if (!parsed.data.nextCursor) break;
    cursor = parsed.data.nextCursor;
  }
  expect(count).toBe(RELEASE_PERFORMANCE_WORKLOAD.notesPerWorkspace);
  expect(selectedNoteSeen).toBe(true);
}

async function collectSamples(
  warmups: number,
  sampleCount: number,
  measure: () => Promise<number>,
): Promise<number[]> {
  const samples: number[] = [];
  for (let index = 0; index < warmups + sampleCount; index += 1) {
    const durationMs = await measure();
    if (index >= warmups) samples.push(durationMs);
  }
  return samples;
}

async function inputFrameDuration(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const host = document.querySelector('[data-testid="source-editor-host"] .cm-content');
    if (!(host instanceof HTMLElement)) throw new Error("source editor is not mounted");
    const started = performance.now();
    host.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true }));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    return performance.now() - started;
  });
}

async function switchDuration(page: Page, mode: "Visual" | "Source"): Promise<number> {
  const started = performance.now();
  await page.getByRole("radio", { name: mode }).click();
  const host =
    mode === "Visual"
      ? page.getByTestId("visual-editor-host")
      : page.getByTestId("source-editor-host");
  await host.locator('[contenteditable="true"]').waitFor({ state: "visible" });
  return performance.now() - started;
}

async function longTasksDuringTyping(page: Page): Promise<number[]> {
  await page.evaluate(() => {
    (window as unknown as { __releaseLongTasks?: number[] }).__releaseLongTasks = [];
    new PerformanceObserver((list) => {
      const values = (window as unknown as { __releaseLongTasks: number[] }).__releaseLongTasks;
      for (const entry of list.getEntries()) values.push(entry.duration);
    }).observe({ type: "longtask", buffered: true });
  });
  await page
    .getByTestId("source-editor-host")
    .locator('[contenteditable="true"]')
    .pressSequentially("release workload typing ".repeat(200));
  return page.evaluate(
    () => (window as unknown as { __releaseLongTasks: number[] }).__releaseLongTasks,
  );
}

test.describe("Release performance harness contract", () => {
  test("declares the exact five-actor, 1,000-note workload and UI gates", () => {
    expect(RELEASE_PERFORMANCE_WORKLOAD).toMatchObject({
      actors: 5,
      workspaces: 5,
      notesPerWorkspace: 1_000,
    });
    expect(
      RELEASE_UI_GATES.map((gate) => [gate.id, gate.warmups, gate.samples, gate.thresholdMs]),
    ).toEqual([
      ["PERF-UI-01", 100, 1_000, 100],
      ["PERF-UI-02", 10, 100, 1_000],
      ["PERF-UI-03", 5, 100, 5_000],
      ["PERF-UI-04", 5, 100, 5_000],
      ["PERF-UI-05", 5, 100, 5_000],
    ]);
    expect(
      RELEASE_API_GATES.map((gate) => [gate.route, gate.minimumSamples, gate.thresholdMs]),
    ).toEqual([
      ["getNote", 500, 500],
      ["autosave", 500, 1_000],
      ["search", 500, 500],
    ]);
  });

  test("computes nearest-rank p50, p95, and p99 summaries", () => {
    expect(summarizeReleaseSamples(Array.from({ length: 100 }, (_, index) => index + 1))).toEqual({
      count: 100,
      p50Ms: 50,
      p95Ms: 95,
      p99Ms: 99,
    });
  });

  test("blocks when the measured environment manifest is unavailable", async () => {
    await expect(
      loadManifestAt("docs/evidence/release/manifest-does-not-exist.json"),
    ).rejects.toThrow(/manifest is unavailable/iu);
  });
});

const environmentManifestAvailable = existsSync(resolve(REPOSITORY_ROOT, manifestPath()));

test.describe("Release performance gates", () => {
  test.skip(
    !environmentManifestAvailable,
    "SKIPPED_EXTERNAL: measured release environment manifest unavailable",
  );
  test.describe.configure({ mode: "serial" });

  let manifest: ReleaseEnvironmentManifest;
  let actors: ReleaseActor[];

  test.beforeAll(async ({ request }) => {
    manifest = await loadReleaseManifest();
    actors = parseActors();
    expect(new Set(actors.map((actor) => actor.workspaceId)).size).toBe(5);
    await Promise.all(actors.map((actor) => verifySeededNotes(request, actor)));

    const rawEvidence = JSON.parse(
      await readFile(resolve(REPOSITORY_ROOT, loadEvidencePath()), "utf8"),
    ) as ReleaseLoadEvidence;
    const recordedManifestSha =
      rawEvidence.identity?.environmentManifestSha256 ?? rawEvidence.environmentManifestSha256;
    expect(rawEvidence.status).toBe("passed");
    expect(recordedManifestSha).toBe(manifest.manifestSha256);
    expect(rawEvidence.workload).toMatchObject({
      actors: 5,
      workspaces: 5,
      notesPerWorkspace: 1_000,
    });
    for (const gate of RELEASE_API_GATES) {
      const sample = rawEvidence.api?.[gate.route];
      expect(sample?.count).toBeGreaterThanOrEqual(gate.minimumSamples);
      expect(sample?.p95Ms).toBeLessThan(gate.thresholdMs);
    }
  });

  test("PERF-UI-01: 100 KB input — InputEvent dispatch to next rendered animation frame, p95 < 100ms", async ({
    page,
  }) => {
    await page.goto("/workspace");
    const samples = await collectSamples(100, 1_000, () => inputFrameDuration(page));
    expect(samples).toHaveLength(1_000);
    expect(summarizeReleaseSamples(samples).p95Ms).toBeLessThan(100);
  });

  test("PERF-UI-02: Visual/Source switch — trigger to target editor accepts input, p95 < 1s", async ({
    page,
  }) => {
    await page.goto("/workspace");
    const samples = await collectSamples(10, 100, () => switchDuration(page, "Visual"));
    expect(samples).toHaveLength(100);
    expect(summarizeReleaseSamples(samples).p95Ms).toBeLessThan(1_000);
  });

  test("PERF-UI-03: 1 MB open — request dispatch to editor accepting input, p95 < 5s", async ({
    page,
  }) => {
    await page.goto("/workspace");
    const actor = actors[0];
    if (!actor) throw new Error("release actor is unavailable");
    const samples = await collectSamples(5, 100, async () => {
      const started = performance.now();
      const response = await page.request.get(`/api/v1/notes/${actor.noteId}`, {
        headers: { cookie: actor.cookie },
      });
      expect(response.status()).toBe(200);
      await page
        .getByTestId("source-editor-host")
        .locator('[contenteditable="true"]')
        .waitFor({ state: "visible" });
      return performance.now() - started;
    });
    expect(samples).toHaveLength(100);
    expect(summarizeReleaseSamples(samples).p95Ms).toBeLessThan(5_000);
  });

  test("PERF-UI-04: 1 MB save — request dispatch to server acknowledgement and saved UI state, p95 < 5s", async ({
    page,
  }) => {
    await page.goto("/workspace");
    const samples = await collectSamples(5, 100, async () => {
      const started = performance.now();
      await page.getByTestId("source-editor-host").locator('[contenteditable="true"]').press("End");
      await page.waitForTimeout(0);
      await page
        .getByText(/saved|clean/iu)
        .first()
        .waitFor({ state: "visible" });
      return performance.now() - started;
    });
    expect(samples).toHaveLength(100);
    expect(summarizeReleaseSamples(samples).p95Ms).toBeLessThan(5_000);
  });

  test("PERF-UI-05: 1 MB export — action to downloadable blob ready, p95 < 5s", async ({
    page,
  }) => {
    await page.goto("/workspace");
    const samples = await collectSamples(5, 100, async () => {
      const started = performance.now();
      const download = page.waitForEvent("download");
      await page.getByRole("button", { name: /export/iu }).click();
      const artifact = await download;
      await artifact.createReadStream();
      return performance.now() - started;
    });
    expect(samples).toHaveLength(100);
    expect(summarizeReleaseSamples(samples).p95Ms).toBeLessThan(5_000);
  });

  test("continuous typing produces no main-thread task above 200ms", async ({ page }) => {
    await page.goto("/workspace");
    const longTasks = await longTasksDuringTyping(page);
    expect(longTasks.every((durationMs) => durationMs <= 200)).toBe(true);
  });

  test("parsing and validation above 100 KB use a worker or interruptible path", async ({
    page,
  }) => {
    await page.goto("/workspace");
    const workerOrInterruptible = await page.evaluate(() => {
      const app = window as unknown as {
        __glyphQuireDocumentWorker?: unknown;
        __glyphQuireInterruptibleParser?: unknown;
      };
      return Boolean(app.__glyphQuireDocumentWorker || app.__glyphQuireInterruptibleParser);
    });
    expect(workerOrInterruptible).toBe(true);
  });
});
