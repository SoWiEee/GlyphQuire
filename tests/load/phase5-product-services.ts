#!/usr/bin/env tsx
/**
 * Reproducible SPEC §40.3 profile. The production gate is exactly 30 minutes
 * with five actors. Shorter runs are smoke-only and are labelled as such.
 * Secrets and Markdown are accepted only through environment variables and
 * are never written to the report.
 *
 * Required environment:
 *   PHASE5_LOAD_BASE_URL=https://staging.example
 *   PHASE5_LOAD_ACTORS_JSON='[{"workspaceId":"...","noteId":"...","cookie":"..."}, ...]'
 *   PHASE5_LOAD_OPERATOR_COOKIE='session=...'
 */
import { createHash, randomUUID } from "node:crypto";
import {
  assetResponseSchema,
  canonicalUuidSchema,
  deadLetterResponseSchema,
  noteResultSchema,
  saveNoteInputSchema,
  searchResponseSchema,
} from "../../packages/api-contract/src/index.js";

const NOTE_BYTES = 100 * 1024;
const ASSET_BYTES = 5 * 1024 * 1024;
const AUTOSAVE_INTERVAL_MS = 2_000;
const SEARCH_INTERVAL_MS = 10_000;
const ASSET_INTERVAL_MS = 5 * 60_000;
const DEFAULT_DURATION_MS = 30 * 60_000;
const DEFAULT_USERS = 5;
const REQUEST_TIMEOUT_MS = 10_000;

type MetricName = "getNote" | "autosave" | "search";

interface ActorInput {
  workspaceId: string;
  noteId: string;
  cookie: string;
}

interface ActorState extends ActorInput {
  marker: string;
  revision: number;
  tick: number;
  latestHash: string;
  nextAutosaveAt: number;
  nextSearchAt: number;
  nextAssetAt: number;
  latestSearchRevision: number;
}

interface Metrics {
  getNote: number[];
  autosave: number[];
  search: number[];
  uploads: number;
  integrityChecks: number;
  errors: string[];
}

function parseDuration(value: string): number {
  const match = /^(\d+)(ms|s|m)$/u.exec(value);
  if (!match) throw new Error("duration must use ms, s, or m");
  const unit = match[2] === "m" ? 60_000 : match[2] === "s" ? 1_000 : 1;
  const milliseconds = Number(match[1]) * unit;
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1_000 || milliseconds > 1_800_000) {
    throw new Error("duration must be between 1s and 30m");
  }
  return milliseconds;
}

function cliConfig(): { durationMs: number; users: number } {
  let durationMs = DEFAULT_DURATION_MS;
  let users = DEFAULT_USERS;
  for (const argument of process.argv.slice(2)) {
    if (argument === "--") continue;
    if (argument.startsWith("--duration=")) durationMs = parseDuration(argument.slice(11));
    else if (argument.startsWith("--users=")) users = Number(argument.slice(8));
    else throw new Error("Only --duration=<time> and --users=<count> are supported");
  }
  if (!Number.isInteger(users) || users < 1 || users > 5) {
    throw new Error("users must be an integer from 1 through 5");
  }
  return { durationMs, users };
}

function safeBaseUrl(raw: string): string {
  const url = new URL(raw);
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("base URL must be HTTPS or an HTTP loopback origin");
  }
  return url.origin;
}

function loadActors(raw: string, expected: number): ActorInput[] {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("actor JSON is invalid");
  }
  if (!Array.isArray(value) || value.length !== expected) {
    throw new Error(`actor JSON must contain exactly ${expected} actors`);
  }
  const actors = value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("actor entry is invalid");
    }
    const keys = Object.keys(entry).sort();
    if (keys.join(",") !== "cookie,noteId,workspaceId") throw new Error("actor keys are invalid");
    const candidate = entry as Record<string, unknown>;
    const workspaceId = canonicalUuidSchema.safeParse(candidate.workspaceId);
    const noteId = canonicalUuidSchema.safeParse(candidate.noteId);
    const cookie = candidate.cookie;
    if (
      !workspaceId.success ||
      !noteId.success ||
      typeof cookie !== "string" ||
      cookie.length < 1 ||
      cookie.length > 4096 ||
      /[\r\n]/u.test(cookie)
    ) {
      throw new Error("actor value is invalid");
    }
    return { workspaceId: workspaceId.data, noteId: noteId.data, cookie };
  });
  if (new Set(actors.map((actor) => actor.workspaceId)).size !== actors.length) {
    throw new Error("actor workspaces must be unique");
  }
  return actors;
}

function buildMarkdown(marker: string, tick: number): string {
  const prefix = `# Phase 5 load ${marker}\n\ntick ${tick}\n\n`;
  const unit = "bounded workload content. ";
  const remaining = NOTE_BYTES - Buffer.byteLength(prefix, "utf8");
  return prefix + unit.repeat(Math.ceil(remaining / unit.length)).slice(0, remaining);
}

function hash(markdown: string): string {
  return createHash("sha256").update(markdown, "utf8").digest("hex");
}

function percentile(samples: readonly number[], quantile: number): number | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * quantile) - 1] ?? null;
}

async function jsonRequest(
  baseUrl: string,
  cookie: string,
  path: string,
  init: RequestInit,
  expectedStatus: number,
  metric: MetricName | null,
  metrics: Metrics,
  measure: boolean,
): Promise<unknown> {
  const started = performance.now();
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        accept: "application/json",
        origin: baseUrl,
        cookie,
        "x-request-id": randomUUID(),
        ...init.headers,
      },
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    metrics.errors.push(`${metric ?? "request"}:network`);
    throw new Error("load request failed");
  }
  if (metric && measure) metrics[metric].push(performance.now() - started);
  if (response.status !== expectedStatus) {
    metrics.errors.push(`${metric ?? "request"}:http-${response.status}`);
    throw new Error("load request returned an unexpected status");
  }
  if (!(response.headers.get("content-type") ?? "").includes("application/json")) {
    throw new Error("load response was not JSON");
  }
  try {
    return await response.json();
  } catch {
    throw new Error("load response JSON was invalid");
  }
}

async function initializeActor(
  baseUrl: string,
  input: ActorInput,
  index: number,
  metrics: Metrics,
): Promise<ActorState> {
  const raw = await jsonRequest(
    baseUrl,
    input.cookie,
    `/api/v1/notes/${input.noteId}`,
    { method: "GET" },
    200,
    null,
    metrics,
    false,
  );
  const note = noteResultSchema.safeParse(raw);
  if (
    !note.success ||
    note.data.id !== input.noteId ||
    note.data.workspaceId !== input.workspaceId
  ) {
    throw new Error("actor note response failed contract or identity validation");
  }
  const marker = `actor${index}${randomUUID().replaceAll("-", "")}`;
  return {
    ...input,
    marker,
    revision: note.data.revision,
    tick: 0,
    latestHash: hash(note.data.contentMarkdown),
    nextAutosaveAt: 0,
    nextSearchAt: 0,
    nextAssetAt: 0,
    latestSearchRevision: 0,
  };
}

async function autosaveAndRead(
  baseUrl: string,
  actor: ActorState,
  metrics: Metrics,
  measure: boolean,
): Promise<void> {
  actor.tick += 1;
  const markdown = buildMarkdown(actor.marker, actor.tick);
  const input = saveNoteInputSchema.parse({
    operationId: randomUUID(),
    baseRevision: actor.revision,
    contentMarkdown: markdown,
  });
  const rawSaved = await jsonRequest(
    baseUrl,
    actor.cookie,
    `/api/v1/notes/${actor.noteId}/content`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
    200,
    "autosave",
    metrics,
    measure,
  );
  const saved = noteResultSchema.safeParse(rawSaved);
  if (
    !saved.success ||
    saved.data.id !== actor.noteId ||
    saved.data.workspaceId !== actor.workspaceId ||
    saved.data.revision !== actor.revision + 1 ||
    saved.data.contentMarkdown !== markdown
  ) {
    throw new Error(
      "autosave response failed contract, identity, revision, or integrity validation",
    );
  }
  actor.revision = saved.data.revision;
  actor.latestHash = hash(markdown);

  const rawRead = await jsonRequest(
    baseUrl,
    actor.cookie,
    `/api/v1/notes/${actor.noteId}`,
    { method: "GET" },
    200,
    "getNote",
    metrics,
    measure,
  );
  const read = noteResultSchema.safeParse(rawRead);
  if (
    !read.success ||
    read.data.id !== actor.noteId ||
    read.data.revision !== actor.revision ||
    hash(read.data.contentMarkdown) !== actor.latestHash
  ) {
    throw new Error("read-after-write integrity validation failed");
  }
  metrics.integrityChecks += 1;
}

async function searchActor(
  baseUrl: string,
  actor: ActorState,
  metrics: Metrics,
  measure: boolean,
): Promise<boolean> {
  const query = new URLSearchParams({
    workspaceId: actor.workspaceId,
    q: actor.marker,
    pageSize: "20",
  });
  const raw = await jsonRequest(
    baseUrl,
    actor.cookie,
    `/api/v1/search?${query.toString()}`,
    { method: "GET" },
    200,
    "search",
    metrics,
    measure,
  );
  const result = searchResponseSchema.safeParse(raw);
  if (!result.success || result.data.items.some((item) => item.workspaceId !== actor.workspaceId)) {
    throw new Error("search response failed contract or tenant validation");
  }
  const own = result.data.items.find((item) => item.noteId === actor.noteId);
  if (own && own.revision < actor.latestSearchRevision)
    throw new Error("search revision regressed");
  if (own) actor.latestSearchRevision = own.revision;
  return own?.revision === actor.revision;
}

async function uploadAsset(
  baseUrl: string,
  actor: ActorState,
  actorIndex: number,
  metrics: Metrics,
): Promise<void> {
  const bytes = new Uint8Array(ASSET_BYTES);
  bytes.fill(actorIndex + 1);
  const form = new FormData();
  form.set("file", new Blob([bytes], { type: "image/png" }), `load-${actorIndex}.png`);
  const raw = await jsonRequest(
    baseUrl,
    actor.cookie,
    `/api/v1/workspaces/${actor.workspaceId}/assets`,
    { method: "POST", headers: { "idempotency-key": randomUUID() }, body: form },
    201,
    null,
    metrics,
    false,
  );
  const asset = assetResponseSchema.safeParse(raw);
  if (
    !asset.success ||
    asset.data.workspaceId !== actor.workspaceId ||
    asset.data.size !== ASSET_BYTES ||
    asset.data.deletedAt !== null
  ) {
    throw new Error("asset response failed contract, identity, or size validation");
  }
  metrics.uploads += 1;
}

async function deadLetterIds(
  baseUrl: string,
  operatorCookie: string,
  metrics: Metrics,
): Promise<Set<string>> {
  const ids = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const query = new URLSearchParams({ pageSize: "100" });
    if (cursor) query.set("cursor", cursor);
    const raw = await jsonRequest(
      baseUrl,
      operatorCookie,
      `/api/v1/maintenance/dead-letters?${query.toString()}`,
      { method: "GET" },
      200,
      null,
      metrics,
      false,
    );
    const parsed = deadLetterResponseSchema.safeParse(raw);
    if (!parsed.success) throw new Error("dead-letter response failed contract validation");
    parsed.data.items.forEach((item) => ids.add(item.id));
    if (!parsed.data.nextCursor) return ids;
    cursor = parsed.data.nextCursor;
  }
  throw new Error("dead-letter pagination exceeded its bounded page count");
}

async function run(): Promise<void> {
  const config = cliConfig();
  const baseRaw = process.env.PHASE5_LOAD_BASE_URL;
  const actorsRaw = process.env.PHASE5_LOAD_ACTORS_JSON;
  const operatorCookie = process.env.PHASE5_LOAD_OPERATOR_COOKIE;
  if (!baseRaw || !actorsRaw || !operatorCookie) {
    console.error(
      "PHASE5_LOAD_SKIPPED_RELEASE_BLOCKER: PHASE5_LOAD_BASE_URL, PHASE5_LOAD_ACTORS_JSON, and PHASE5_LOAD_OPERATOR_COOKIE are required",
    );
    process.exitCode = 2;
    return;
  }
  if (operatorCookie.length > 4096 || /[\r\n]/u.test(operatorCookie)) {
    throw new Error("operator cookie is invalid");
  }
  const baseUrl = safeBaseUrl(baseRaw);
  const inputs = loadActors(actorsRaw, config.users);
  const metrics: Metrics = {
    getNote: [],
    autosave: [],
    search: [],
    uploads: 0,
    integrityChecks: 0,
    errors: [],
  };
  const baselineDeadLetters = await deadLetterIds(baseUrl, operatorCookie, metrics);
  const actors = await Promise.all(
    inputs.map((input, index) => initializeActor(baseUrl, input, index, metrics)),
  );
  const startedAt = Date.now();
  const endsAt = startedAt + config.durationMs;
  const warmupEndsAt = startedAt + Math.min(120_000, Math.floor(config.durationMs / 5));

  while (Date.now() < endsAt) {
    const elapsed = Date.now() - startedAt;
    const measure = Date.now() >= warmupEndsAt;
    await Promise.all(
      actors.map(async (actor, index) => {
        if (elapsed >= actor.nextAutosaveAt) {
          await autosaveAndRead(baseUrl, actor, metrics, measure);
          actor.nextAutosaveAt += AUTOSAVE_INTERVAL_MS;
        }
        if (elapsed >= actor.nextSearchAt) {
          await searchActor(baseUrl, actor, metrics, measure);
          actor.nextSearchAt += SEARCH_INTERVAL_MS;
        }
        if (elapsed >= actor.nextAssetAt) {
          await uploadAsset(baseUrl, actor, index, metrics);
          actor.nextAssetAt += ASSET_INTERVAL_MS;
        }
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  const drainDeadline = Date.now() + 60_000;
  let fresh = false;
  while (Date.now() <= drainDeadline) {
    fresh = (
      await Promise.all(actors.map((actor) => searchActor(baseUrl, actor, metrics, false)))
    ).every(Boolean);
    if (fresh) break;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  if (!fresh) throw new Error("search/index queue did not become fresh within 60 seconds");

  const finalDeadLetters = await deadLetterIds(baseUrl, operatorCookie, metrics);
  const newDeadLetters = [...finalDeadLetters].filter((id) => !baselineDeadLetters.has(id));
  const productionProfile =
    config.durationMs === DEFAULT_DURATION_MS && config.users === DEFAULT_USERS;
  const p95 = {
    getNote: percentile(metrics.getNote, 0.95),
    autosave: percentile(metrics.autosave, 0.95),
    search: percentile(metrics.search, 0.95),
  };
  const minimumSamples = productionProfile
    ? metrics.getNote.length >= 500 &&
      metrics.autosave.length >= 500 &&
      metrics.search.length >= 500
    : false;
  const passed =
    metrics.errors.length === 0 &&
    newDeadLetters.length === 0 &&
    (!productionProfile ||
      (minimumSamples &&
        p95.getNote !== null &&
        p95.getNote < 500 &&
        p95.search !== null &&
        p95.search < 500 &&
        p95.autosave !== null &&
        p95.autosave < 1_000));
  const summarize = (samples: readonly number[]) => ({
    count: samples.length,
    p50Ms: percentile(samples, 0.5),
    p95Ms: percentile(samples, 0.95),
    p99Ms: percentile(samples, 0.99),
  });
  console.log(
    JSON.stringify({
      status: productionProfile ? (passed ? "PASS" : "FAIL") : "SMOKE_ONLY",
      durationMs: config.durationMs,
      users: config.users,
      warmupMs: warmupEndsAt - startedAt,
      noteBytes: NOTE_BYTES,
      assetBytes: ASSET_BYTES,
      getNote: summarize(metrics.getNote),
      autosave: summarize(metrics.autosave),
      search: summarize(metrics.search),
      uploads: metrics.uploads,
      integrityChecks: metrics.integrityChecks,
      newDeadLetters: newDeadLetters.length,
      errors: metrics.errors.length,
      searchFreshWithin60Seconds: fresh,
    }),
  );
  if (!passed) process.exitCode = 1;
}

run().catch(() => {
  console.error(
    "PHASE5_LOAD_FAILED: see sanitized counters; credentials and document content omitted",
  );
  process.exitCode = 1;
});
