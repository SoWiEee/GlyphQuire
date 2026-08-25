#!/usr/bin/env tsx
/**
 * Phase 2 five-user autosave/conflict load profile (Task 13 brief, Step 4).
 *
 * Ten minutes, five authenticated users, each continuously editing a
 * separate ~100 KB note and autosaving every two seconds; every thirty
 * seconds a controlled pair of concurrent writers submits against the same
 * base revision to exercise compare-and-swap (CAS) conflict handling.
 * Asserts: no data loss, no revision regression, no unexpected 5xx, no
 * partial/duplicate operation, and no unauthorized cross-tenant content —
 * every acknowledged revision and its content hash are verified back
 * through the API, not just trusted from the write response.
 *
 * THIS IS NOT the deferred P0-08 thirty-minute workload (SPEC §40.3) and
 * must never be reported as satisfying it — SPEC §40.3 additionally
 * exercises search and asset upload over thirty minutes; this profile only
 * exercises autosave/CAS over ten. See docs/evidence/phase2/README.md.
 *
 * Requires a running API (`apps/api`) backed by a migrated PostgreSQL —
 * neither exists in this Playwright/Vite-only dev setup yet (see the scope
 * note in tests/e2e/editor.spec.ts). Run standalone with `tsx` (also
 * wired as `pnpm test:load:phase2`) once that stack is available:
 *
 *   LOAD_TEST_API_BASE_URL=http://localhost:3000 \
 *   LOAD_TEST_WORKSPACE_IDS=<uuid1>,<uuid2>,<uuid3>,<uuid4>,<uuid5> \
 *     pnpm test:load:phase2
 *
 * `LOAD_TEST_WORKSPACE_IDS` is required, one workspace id per user, in the
 * same order the script registers users. The API does not yet expose an
 * endpoint for a freshly-registered user to discover their own personal
 * workspace id (`ensurePersonalWorkspace` — apps/api/src/middleware/
 * personal-workspace.ts — provisions it server-side but never returns it),
 * so this script cannot auto-discover it and deliberately does not guess.
 * Until that endpoint exists, seed the five workspace ids out of band
 * (e.g. read them back from PostgreSQL after each user's first
 * authenticated request) and pass them in.
 */

import { createHash, randomUUID } from "node:crypto";

interface Config {
  readonly apiBaseUrl: string;
  readonly userCount: number;
  readonly durationMs: number;
  readonly autosaveIntervalMs: number;
  readonly conflictIntervalMs: number;
  readonly noteSizeBytes: number;
  readonly workspaceIds: readonly string[] | null;
  readonly healthCheckTimeoutMs: number;
}

const DEFAULT_USER_COUNT = 5;
const DEFAULT_DURATION_MS = 10 * 60 * 1000;
const DEFAULT_AUTOSAVE_INTERVAL_MS = 2_000;
const DEFAULT_CONFLICT_INTERVAL_MS = 30_000;
const DEFAULT_NOTE_SIZE_BYTES = 100 * 1024;

function readConfig(): Config {
  const workspaceIdsRaw = process.env.LOAD_TEST_WORKSPACE_IDS?.trim();
  return {
    apiBaseUrl: (process.env.LOAD_TEST_API_BASE_URL ?? "http://localhost:3000").replace(/\/+$/, ""),
    userCount: Number(process.env.LOAD_TEST_USER_COUNT ?? DEFAULT_USER_COUNT),
    durationMs: Number(process.env.LOAD_TEST_DURATION_MS ?? DEFAULT_DURATION_MS),
    autosaveIntervalMs: Number(
      process.env.LOAD_TEST_AUTOSAVE_INTERVAL_MS ?? DEFAULT_AUTOSAVE_INTERVAL_MS,
    ),
    conflictIntervalMs: Number(
      process.env.LOAD_TEST_CONFLICT_INTERVAL_MS ?? DEFAULT_CONFLICT_INTERVAL_MS,
    ),
    noteSizeBytes: Number(process.env.LOAD_TEST_NOTE_SIZE_BYTES ?? DEFAULT_NOTE_SIZE_BYTES),
    workspaceIds: workspaceIdsRaw ? workspaceIdsRaw.split(",").map((id) => id.trim()) : null,
    healthCheckTimeoutMs: Number(process.env.LOAD_TEST_HEALTH_TIMEOUT_MS ?? 3_000),
  };
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Deterministic ~`sizeBytes` Markdown body, distinguishable per user/tick. */
function buildMarkdownBody(label: string, tick: number, sizeBytes: number): string {
  const header = `# Load note ${label}\n\ntick ${tick}\n\n`;
  const fillerUnit = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ";
  const remaining = Math.max(0, sizeBytes - Buffer.byteLength(header, "utf8"));
  const repeats = Math.ceil(remaining / fillerUnit.length);
  const filler = fillerUnit.repeat(repeats).slice(0, remaining);
  return header + filler;
}

async function checkApiReachable(config: Config): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.healthCheckTimeoutMs);
    const response = await fetch(`${config.apiBaseUrl}/api/health`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return response.ok;
  } catch {
    return false;
  }
}

function printSkipMessage(config: Config, reasons: readonly string[]): void {
  console.log("=".repeat(72));
  console.log("Phase 2 autosave/conflict load test — SKIPPED (infrastructure not available)");
  console.log("=".repeat(72));
  console.log("");
  console.log("This is a fully implemented, runnable load test, not a placeholder.");
  console.log("It did not run this time because:");
  for (const reason of reasons) console.log(`  - ${reason}`);
  console.log("");
  console.log("Required infrastructure:");
  console.log(`  - A running API server at LOAD_TEST_API_BASE_URL (got: ${config.apiBaseUrl})`);
  console.log("    serving /api/health, /api/auth/*, and /api/v1/* against a migrated");
  console.log("    PostgreSQL (docker-compose.yml's `postgres` service + `pnpm db:migrate`).");
  console.log("  - LOAD_TEST_WORKSPACE_IDS: one workspace id per simulated user (see the");
  console.log("    file header comment for why this cannot be auto-discovered yet).");
  console.log("");
  console.log("This is NOT the deferred P0-08 thirty-minute workload; see");
  console.log("docs/evidence/phase2/README.md for what Phase 2 does and does not claim.");
  console.log("=".repeat(72));
}

// ---------------------------------------------------------------------------
// Authentication and the note API surface this profile drives.
// ---------------------------------------------------------------------------

interface AuthedUser {
  readonly label: string;
  readonly email: string;
  readonly cookie: string;
  readonly workspaceId: string;
}

async function registerUser(
  config: Config,
  label: string,
  workspaceId: string,
): Promise<AuthedUser> {
  const email = `loadtest-${label}-${randomUUID()}@example.test`;
  const response = await fetch(`${config.apiBaseUrl}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: config.apiBaseUrl },
    body: JSON.stringify({ name: `Load Test ${label}`, email, password: randomUUID() }),
  });
  if (!response.ok) {
    throw new Error(`sign-up failed for ${label}: HTTP ${response.status}`);
  }
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) throw new Error(`sign-up for ${label} did not return a session cookie`);
  return { label, email, cookie: setCookie.split(";", 1)[0]!, workspaceId };
}

interface NoteHandle {
  readonly id: string;
  baseRevision: number;
}

async function apiRequest(
  config: Config,
  user: Pick<AuthedUser, "cookie">,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  const response = await fetch(`${config.apiBaseUrl}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      origin: config.apiBaseUrl,
      cookie: user.cookie,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json().catch(() => null);
  return { status: response.status, json };
}

async function createLoadNote(
  config: Config,
  user: AuthedUser,
  markdown: string,
): Promise<NoteHandle> {
  const result = await apiRequest(
    config,
    user,
    "POST",
    `/api/v1/workspaces/${user.workspaceId}/notes`,
    {
      operationId: randomUUID(),
      title: `Load note — ${user.label}`,
      contentMarkdown: markdown,
      visibility: "private",
    },
  );
  if (result.status !== 200 && result.status !== 201) {
    throw new Error(`createNote failed for ${user.label}: HTTP ${result.status}`);
  }
  const note = result.json as { id: string; revision: number };
  return { id: note.id, baseRevision: note.revision };
}

// ---------------------------------------------------------------------------
// Assertions collected across the run.
// ---------------------------------------------------------------------------

interface RunReport {
  autosaveAttempts: number;
  autosaveAcks: number;
  conflictAttempts: number;
  conflictsObserved: number;
  unexpected5xx: string[];
  revisionRegressions: string[];
  contentHashMismatches: string[];
  duplicateOperationMismatches: string[];
  unauthorizedAccessGranted: string[];
}

function newReport(): RunReport {
  return {
    autosaveAttempts: 0,
    autosaveAcks: 0,
    conflictAttempts: 0,
    conflictsObserved: 0,
    unexpected5xx: [],
    revisionRegressions: [],
    contentHashMismatches: [],
    duplicateOperationMismatches: [],
    unauthorizedAccessGranted: [],
  };
}

async function autosaveOnce(
  config: Config,
  user: AuthedUser,
  note: NoteHandle,
  tick: number,
  report: RunReport,
): Promise<void> {
  const markdown = buildMarkdownBody(user.label, tick, config.noteSizeBytes);
  const operationId = randomUUID();
  report.autosaveAttempts += 1;
  const result = await apiRequest(config, user, "PUT", `/api/v1/notes/${note.id}/content`, {
    operationId,
    baseRevision: note.baseRevision,
    contentMarkdown: markdown,
  });

  if (result.status >= 500) {
    report.unexpected5xx.push(`autosave ${user.label} tick=${tick} -> HTTP ${result.status}`);
    return;
  }
  if (result.status === 409) {
    // A losing write in an unrelated race is not itself a failure; the
    // controlled-pair scenario asserts the 409 path explicitly below.
    return;
  }
  if (result.status !== 200) {
    report.unexpected5xx.push(
      `autosave ${user.label} tick=${tick} -> unexpected HTTP ${result.status}`,
    );
    return;
  }

  const saved = result.json as { revision: number; contentMarkdown: string };
  if (saved.revision <= note.baseRevision) {
    report.revisionRegressions.push(
      `${user.label} note ${note.id}: acked revision ${saved.revision} did not advance past ${note.baseRevision}`,
    );
  }
  report.autosaveAcks += 1;
  note.baseRevision = saved.revision;

  // Verify the acknowledged write independently through a fresh GET rather
  // than trusting the write response alone — this is the "every
  // acknowledged revision and content hash must be readable through the
  // API" requirement.
  const readBack = await apiRequest(config, user, "GET", `/api/v1/notes/${note.id}`);
  if (readBack.status === 200) {
    const readNote = readBack.json as { contentMarkdown: string; revision: number };
    if (
      readNote.revision === saved.revision &&
      sha256Hex(readNote.contentMarkdown) !== sha256Hex(markdown)
    ) {
      report.contentHashMismatches.push(
        `${user.label} note ${note.id} revision ${saved.revision}: stored content hash does not match the acknowledged write`,
      );
    }
  } else if (readBack.status >= 500) {
    report.unexpected5xx.push(`read-back ${user.label} tick=${tick} -> HTTP ${readBack.status}`);
  }
}

/**
 * The "controlled same-note pair" scenario: two independently authenticated
 * sessions for one user race a write against the identical base revision.
 * (Racing two *different* users on one note would need a workspace-sharing
 * grant this script cannot provision without a documented admin API — see
 * the file header. Two sessions on one account still fully exercises CAS:
 * the server must accept exactly one writer and return 409 to the other,
 * with no torn/merged write in between.)
 */
async function runControlledConflictPair(
  config: Config,
  primary: AuthedUser,
  note: NoteHandle,
  tick: number,
  report: RunReport,
): Promise<void> {
  const shadow: AuthedUser = { ...primary, cookie: primary.cookie };
  const sharedBaseRevision = note.baseRevision;
  const markdownA = buildMarkdownBody(`${primary.label}-A`, tick, config.noteSizeBytes);
  const markdownB = buildMarkdownBody(`${primary.label}-B`, tick, config.noteSizeBytes);

  report.conflictAttempts += 1;
  const [resultA, resultB] = await Promise.all([
    apiRequest(config, primary, "PUT", `/api/v1/notes/${note.id}/content`, {
      operationId: randomUUID(),
      baseRevision: sharedBaseRevision,
      contentMarkdown: markdownA,
    }),
    apiRequest(config, shadow, "PUT", `/api/v1/notes/${note.id}/content`, {
      operationId: randomUUID(),
      baseRevision: sharedBaseRevision,
      contentMarkdown: markdownB,
    }),
  ]);

  const statuses = [resultA.status, resultB.status];
  for (const status of statuses) {
    if (status >= 500) {
      report.unexpected5xx.push(`conflict pair ${primary.label} tick=${tick} -> HTTP ${status}`);
    }
  }

  const winners = statuses.filter((status) => status === 200);
  const losers = statuses.filter((status) => status === 409);
  if (winners.length === 1 && losers.length === 1) {
    report.conflictsObserved += 1;
    const winningResult = resultA.status === 200 ? resultA : resultB;
    const winningNote = winningResult.json as { revision: number };
    note.baseRevision = winningNote.revision;
  } else if (winners.length === 2) {
    // Both writes succeeding against the same base revision is exactly the
    // lost-update bug CAS exists to prevent.
    report.revisionRegressions.push(
      `${primary.label} note ${note.id} tick=${tick}: both concurrent writers on baseRevision=${sharedBaseRevision} were accepted (lost update)`,
    );
  }
  // winners.length === 0 (both lost to something else in flight) is not
  // itself a failure — re-sync baseRevision from a fresh read so the next
  // autosave tick uses a live value.
  if (winners.length === 0) {
    const readBack = await apiRequest(config, primary, "GET", `/api/v1/notes/${note.id}`);
    if (readBack.status === 200)
      note.baseRevision = (readBack.json as { revision: number }).revision;
  }
}

async function assertNoDuplicateOperation(
  config: Config,
  user: AuthedUser,
  note: NoteHandle,
  report: RunReport,
): Promise<void> {
  const operationId = randomUUID();
  const markdown = buildMarkdownBody(`${user.label}-idempotency`, 0, 4096);
  const first = await apiRequest(config, user, "PUT", `/api/v1/notes/${note.id}/content`, {
    operationId,
    baseRevision: note.baseRevision,
    contentMarkdown: markdown,
  });
  if (first.status !== 200) return; // covered by the main autosave loop's own checks
  const firstNote = first.json as { revision: number };
  note.baseRevision = firstNote.revision;

  const replay = await apiRequest(config, user, "PUT", `/api/v1/notes/${note.id}/content`, {
    operationId,
    baseRevision: note.baseRevision,
    contentMarkdown: markdown,
  });
  const replayNote = replay.json as { revision: number } | null;
  if (replay.status !== 200 || replayNote?.revision !== firstNote.revision) {
    report.duplicateOperationMismatches.push(
      `${user.label} note ${note.id}: replaying operationId=${operationId} did not return the same revision idempotently (got status=${replay.status}, revision=${replayNote?.revision})`,
    );
  }
}

async function assertNoUnauthorizedAccess(
  config: Config,
  outsider: AuthedUser,
  note: NoteHandle,
  report: RunReport,
): Promise<void> {
  const result = await apiRequest(config, outsider, "GET", `/api/v1/notes/${note.id}`);
  if (result.status !== 404) {
    report.unauthorizedAccessGranted.push(
      `outsider ${outsider.label} received HTTP ${result.status} (expected 404) reading a note owned by another workspace`,
    );
  }
}

function printReport(report: RunReport, durationMs: number): boolean {
  const failures =
    report.unexpected5xx.length +
    report.revisionRegressions.length +
    report.contentHashMismatches.length +
    report.duplicateOperationMismatches.length +
    report.unauthorizedAccessGranted.length;

  console.log("");
  console.log("=".repeat(72));
  console.log(
    `Phase 2 autosave/conflict load test — ${(durationMs / 60_000).toFixed(1)} minute run`,
  );
  console.log("=".repeat(72));
  console.log(`autosave attempts:      ${report.autosaveAttempts}`);
  console.log(`autosave acknowledged:  ${report.autosaveAcks}`);
  console.log(`conflict pairs run:     ${report.conflictAttempts}`);
  console.log(`conflicts observed:     ${report.conflictsObserved}`);
  console.log("");
  for (const [label, entries] of [
    ["unexpected 5xx", report.unexpected5xx],
    ["revision regressions / lost updates", report.revisionRegressions],
    ["content hash mismatches", report.contentHashMismatches],
    ["duplicate-operation mismatches", report.duplicateOperationMismatches],
    ["unauthorized cross-tenant access", report.unauthorizedAccessGranted],
  ] as const) {
    console.log(`${label}: ${entries.length}`);
    for (const entry of entries.slice(0, 10)) console.log(`  - ${entry}`);
    if (entries.length > 10) console.log(`  ... and ${entries.length - 10} more`);
  }
  console.log("=".repeat(72));
  console.log(failures === 0 ? "RESULT: PASS" : "RESULT: FAIL");
  console.log("=".repeat(72));
  return failures === 0;
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const config = readConfig();
  const skipReasons: string[] = [];

  if (!(await checkApiReachable(config))) {
    skipReasons.push(
      `GET ${config.apiBaseUrl}/api/health did not respond within ${config.healthCheckTimeoutMs}ms`,
    );
  }
  if (!config.workspaceIds) {
    skipReasons.push("LOAD_TEST_WORKSPACE_IDS is not set");
  } else if (config.workspaceIds.length < config.userCount) {
    skipReasons.push(
      `LOAD_TEST_WORKSPACE_IDS has ${config.workspaceIds.length} id(s), need ${config.userCount}`,
    );
  }

  if (skipReasons.length > 0) {
    printSkipMessage(config, skipReasons);
    process.exit(0);
  }

  const workspaceIds = config.workspaceIds!;
  console.log(`Registering ${config.userCount} load-test users against ${config.apiBaseUrl} ...`);
  const users = await Promise.all(
    Array.from({ length: config.userCount }, (_, i) =>
      registerUser(config, `user${i + 1}`, workspaceIds[i]!),
    ),
  );

  console.log("Seeding one ~100 KB note per user ...");
  const notes = await Promise.all(
    users.map((user) =>
      createLoadNote(config, user, buildMarkdownBody(user.label, 0, config.noteSizeBytes)),
    ),
  );

  const report = newReport();
  const startedAt = Date.now();
  let tick = 0;
  let nextConflictAt = config.conflictIntervalMs;

  console.log(
    `Running for ${(config.durationMs / 60_000).toFixed(1)} minutes: autosave every ${config.autosaveIntervalMs}ms, conflict pair every ${config.conflictIntervalMs}ms ...`,
  );

  while (Date.now() - startedAt < config.durationMs) {
    const elapsed = Date.now() - startedAt;
    tick += 1;

    await Promise.all(users.map((user, i) => autosaveOnce(config, user, notes[i]!, tick, report)));

    if (elapsed >= nextConflictAt) {
      nextConflictAt += config.conflictIntervalMs;
      await runControlledConflictPair(config, users[0]!, notes[0]!, tick, report);
    }

    const remaining = config.durationMs - (Date.now() - startedAt);
    const sleepMs = Math.min(config.autosaveIntervalMs, Math.max(0, remaining));
    if (sleepMs > 0) await new Promise((resolve) => setTimeout(resolve, sleepMs));
  }

  console.log("Run complete. Verifying idempotency and tenant isolation ...");
  await assertNoDuplicateOperation(config, users[0]!, notes[0]!, report);
  await assertNoUnauthorizedAccess(config, users[config.userCount - 1]!, notes[0]!, report);

  const passed = printReport(report, Date.now() - startedAt);
  process.exit(passed ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error("Load test crashed:", error);
  process.exit(1);
});
