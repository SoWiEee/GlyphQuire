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
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
  assetResponseSchema,
  canonicalUuidSchema,
  deadLetterResponseSchema,
  noteResultSchema,
  notePageSchema,
  saveNoteInputSchema,
  searchResponseSchema,
} from "../../packages/api-contract/src/index.js";
import {
  measurePhase6Environment,
  validatePhase6EnvironmentManifest,
  type Phase6EnvironmentManifest,
  type Phase6ImageDigests,
} from "./phase6-environment.js";

const NOTE_BYTES = 100 * 1024;
const ASSET_BYTES = 5 * 1024 * 1024;
const AUTOSAVE_INTERVAL_MS = 2_000;
const SEARCH_INTERVAL_MS = 10_000;
const ASSET_INTERVAL_MS = 5 * 60_000;
const DEFAULT_DURATION_MS = 30 * 60_000;
const DEFAULT_USERS = 5;
const REQUIRED_RELEASE_USERS = 5;
const REQUIRED_NOTES_PER_WORKSPACE = 1_000;
const REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_PERFORMANCE_EVIDENCE_PATH = "docs/evidence/phase6/performance-load.json";
const REPOSITORY_ROOT = resolve(import.meta.dirname, "../..");
const SOURCE_SHA_PATTERN = /^[a-f0-9]{40}$/u;
const IMAGE_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;

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

export interface Phase5LoadConfig {
  readonly durationMs: number;
  readonly users: number;
  readonly environmentManifestPath?: string;
}

export interface Phase5LoadIdentity {
  readonly environmentManifestSha256: string | null;
  readonly candidateSourceSha: string | null;
  readonly lockfileSha256: string | null;
  readonly imageDigests: Phase6ImageDigests | null;
  readonly host: Phase6EnvironmentManifest["host"] | null;
}

export interface Phase5LoadReport {
  readonly schemaVersion: 1;
  readonly status: "blocked" | "failed" | "passed";
  readonly scrubbed: true;
  readonly producer: "phase6-performance-load";
  readonly recordedAt: string;
  readonly blockingReason?: string;
  readonly identity: Phase5LoadIdentity;
  readonly workload: {
    readonly durationMs: number;
    readonly actors: number;
    readonly workspaces: number;
    readonly notesPerWorkspace: number;
    readonly noteBytes: number;
    readonly assetBytes: number;
    readonly autosaveIntervalMs: number;
    readonly searchIntervalMs: number;
    readonly assetIntervalMs: number;
    readonly warmupMs: number;
  };
  readonly api: {
    readonly getNote: ReturnType<typeof summarizeSamples> & { readonly thresholdMs: 500 };
    readonly autosave: ReturnType<typeof summarizeSamples> & { readonly thresholdMs: 1_000 };
    readonly search: ReturnType<typeof summarizeSamples> & { readonly thresholdMs: 500 };
  };
  readonly integrity: {
    readonly uploads: number;
    readonly integrityChecks: number;
    readonly newDeadLetters: number;
    readonly errors: number;
    readonly searchFreshWithin60Seconds: boolean;
  };
}

export function parsePhase5Duration(value: string): number {
  const match = /^(\d+)(ms|s|m)$/u.exec(value);
  if (!match) throw new Error("duration must use ms, s, or m");
  const unit = match[2] === "m" ? 60_000 : match[2] === "s" ? 1_000 : 1;
  const milliseconds = Number(match[1]) * unit;
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1_000 || milliseconds > 1_800_000) {
    throw new Error("duration must be between 1s and 30m");
  }
  return milliseconds;
}

export function parsePhase5CliConfig(argumentsToParse: readonly string[]): Phase5LoadConfig {
  let durationMs = DEFAULT_DURATION_MS;
  let users = DEFAULT_USERS;
  let environmentManifestPath: string | undefined;
  for (const argument of argumentsToParse) {
    if (argument === "--") continue;
    if (argument.startsWith("--duration=")) durationMs = parsePhase5Duration(argument.slice(11));
    else if (argument.startsWith("--users=")) users = Number(argument.slice(8));
    else if (argument.startsWith("--environment-manifest=")) {
      const path = argument.slice("--environment-manifest=".length);
      if (
        !path ||
        path.length > 4096 ||
        path.includes("\0") ||
        environmentManifestPath !== undefined
      ) {
        throw new Error("environment manifest path is invalid");
      }
      environmentManifestPath = path;
    } else {
      throw new Error(
        "Only --duration=<time>, --users=<count>, and --environment-manifest=<path> are supported",
      );
    }
  }
  if (!Number.isInteger(users) || users < 1 || users > 5) {
    throw new Error("users must be an integer from 1 through 5");
  }
  return { durationMs, users, ...(environmentManifestPath ? { environmentManifestPath } : {}) };
}

function cliConfig(): Phase5LoadConfig {
  return parsePhase5CliConfig(process.argv.slice(2));
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

function hasExactKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return required.every((key) => keys.includes(key)) && keys.every((key) => allowed.has(key));
}

function assertStrictPhase6ManifestShape(
  value: unknown,
): asserts value is Phase6EnvironmentManifest {
  const required = [
    "schemaVersion",
    "status",
    "scrubbed",
    "producer",
    "measuredAt",
    "host",
    "topology",
    "candidateSourceSha",
    "lockfileSha256",
    "nodeVersion",
    "pnpmVersion",
    "imageDigests",
    "manifestSha256",
  ] as const;
  if (!hasExactKeys(value, required, ["blockingReason"])) {
    throw new Error("environment manifest failed strict shape validation");
  }
  const manifest = value as Record<string, unknown>;
  if (
    manifest.blockingReason !== undefined &&
    (typeof manifest.blockingReason !== "string" || manifest.blockingReason.length === 0)
  ) {
    throw new Error("environment manifest blocking reason is invalid");
  }
  if (typeof manifest.measuredAt !== "string" || Number.isNaN(Date.parse(manifest.measuredAt))) {
    throw new Error("environment manifest timestamp is invalid");
  }
  if (
    !hasExactKeys(manifest.host, [
      "platform",
      "architecture",
      "cpuCount",
      "cpuQuotaVcpus",
      "effectiveVcpus",
      "memoryLimitBytes",
      "cgroupCpuMax",
      "cgroupMemoryMax",
    ]) ||
    !hasExactKeys(manifest.topology, ["sameHost", "compose", "network", "services"]) ||
    !hasExactKeys(manifest.imageDigests, ["api", "web", "worker"])
  ) {
    throw new Error("environment manifest failed strict nested shape validation");
  }
  const topology = manifest.topology as Record<string, unknown>;
  if (
    !Array.isArray(topology.services) ||
    topology.services.length !== 4 ||
    topology.services.join(",") !== "api,worker,postgres,object-storage"
  ) {
    throw new Error("environment manifest service topology is invalid");
  }
}

function expectedCandidateSourceSha(): string {
  const configured = process.env.PHASE6_CANDIDATE_SOURCE_SHA;
  if (configured !== undefined) {
    if (!SOURCE_SHA_PATTERN.test(configured)) throw new Error("candidate source SHA is invalid");
    return configured;
  }
  try {
    const value = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
    }).trim();
    if (!SOURCE_SHA_PATTERN.test(value)) throw new Error();
    return value;
  } catch {
    throw new Error("candidate source SHA is unavailable");
  }
}

async function expectedLockfileSha256(): Promise<string> {
  try {
    return createHash("sha256")
      .update(await readFile(resolve(REPOSITORY_ROOT, "pnpm-lock.yaml")))
      .digest("hex");
  } catch {
    throw new Error("lockfile SHA-256 is unavailable");
  }
}

function expectedImageDigests(): Phase6ImageDigests {
  const configured = (name: "API" | "WEB" | "WORKER"): string => {
    const value =
      process.env[`PHASE6_${name}_IMAGE_DIGEST`] ?? process.env[`PHASE6_IMAGE_DIGEST_${name}`];
    if (!value || !IMAGE_DIGEST_PATTERN.test(value)) {
      throw new Error(`immutable ${name.toLowerCase()} image digest is unavailable`);
    }
    return value;
  };
  return { api: configured("API"), web: configured("WEB"), worker: configured("WORKER") };
}

export async function loadPhase6EnvironmentManifest(
  manifestPath: string,
): Promise<Phase6EnvironmentManifest> {
  const destination = isAbsolute(manifestPath)
    ? manifestPath
    : resolve(REPOSITORY_ROOT, manifestPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(destination, "utf8"));
  } catch {
    throw new Error("environment manifest is unavailable or invalid");
  }
  assertStrictPhase6ManifestShape(parsed);
  const measurement = await measurePhase6Environment();
  return validatePhase6EnvironmentManifest(parsed, {
    expectedCandidateSourceSha: expectedCandidateSourceSha(),
    expectedLockfileSha256: await expectedLockfileSha256(),
    expectedImageDigests: expectedImageDigests(),
    currentMeasurement: measurement,
    requirePassed: true,
  });
}

export function loadActors(raw: string, expected: number): ActorInput[] {
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

function summarizeSamples(samples: readonly number[]) {
  return {
    count: samples.length,
    p50Ms: percentile(samples, 0.5),
    p95Ms: percentile(samples, 0.95),
    p99Ms: percentile(samples, 0.99),
  };
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

async function verifySeededNotes(
  baseUrl: string,
  actor: ActorInput,
  metrics: Metrics,
): Promise<void> {
  let cursor: string | undefined;
  let count = 0;
  let selectedNoteSeen = false;
  for (let page = 0; page < REQUIRED_NOTES_PER_WORKSPACE / 100; page += 1) {
    const query = new URLSearchParams({ pageSize: "100" });
    if (cursor) query.set("cursor", cursor);
    const raw = await jsonRequest(
      baseUrl,
      actor.cookie,
      `/api/v1/workspaces/${actor.workspaceId}/notes?${query.toString()}`,
      { method: "GET" },
      200,
      null,
      metrics,
      false,
    );
    const result = notePageSchema.safeParse(raw);
    if (
      !result.success ||
      result.data.items.some((item) => item.workspaceId !== actor.workspaceId)
    ) {
      throw new Error("seeded note page failed contract or tenant validation");
    }
    count += result.data.items.length;
    if (result.data.items.some((item) => item.id === actor.noteId)) selectedNoteSeen = true;
    if (count > REQUIRED_NOTES_PER_WORKSPACE) {
      throw new Error("workspace contains more than the required seeded note count");
    }
    if (!result.data.nextCursor) break;
    cursor = result.data.nextCursor;
  }
  if (count !== REQUIRED_NOTES_PER_WORKSPACE || !selectedNoteSeen) {
    throw new Error("workspace does not contain exactly the required seeded note count");
  }
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

function emptyLoadIdentity(): Phase5LoadIdentity {
  return {
    environmentManifestSha256: null,
    candidateSourceSha: null,
    lockfileSha256: null,
    imageDigests: null,
    host: null,
  };
}

function manifestLoadIdentity(manifest: Phase6EnvironmentManifest): Phase5LoadIdentity {
  return {
    environmentManifestSha256: manifest.manifestSha256,
    candidateSourceSha: manifest.candidateSourceSha,
    lockfileSha256: manifest.lockfileSha256,
    imageDigests: manifest.imageDigests,
    host: manifest.host,
  };
}

function buildPerformanceReport(
  config: Phase5LoadConfig,
  identity: Phase5LoadIdentity,
  metrics: Metrics,
  warmupMs: number,
  newDeadLetters: number,
  searchFreshWithin60Seconds: boolean,
  status: Phase5LoadReport["status"],
  blockingReason?: string,
): Phase5LoadReport {
  return {
    schemaVersion: 1,
    status,
    scrubbed: true,
    producer: "phase6-performance-load",
    recordedAt: new Date().toISOString(),
    ...(blockingReason ? { blockingReason } : {}),
    identity,
    workload: {
      durationMs: config.durationMs,
      actors: config.users,
      workspaces: config.users,
      notesPerWorkspace: REQUIRED_NOTES_PER_WORKSPACE,
      noteBytes: NOTE_BYTES,
      assetBytes: ASSET_BYTES,
      autosaveIntervalMs: AUTOSAVE_INTERVAL_MS,
      searchIntervalMs: SEARCH_INTERVAL_MS,
      assetIntervalMs: ASSET_INTERVAL_MS,
      warmupMs,
    },
    api: {
      getNote: { ...summarizeSamples(metrics.getNote), thresholdMs: 500 },
      autosave: { ...summarizeSamples(metrics.autosave), thresholdMs: 1_000 },
      search: { ...summarizeSamples(metrics.search), thresholdMs: 500 },
    },
    integrity: {
      uploads: metrics.uploads,
      integrityChecks: metrics.integrityChecks,
      newDeadLetters,
      errors: metrics.errors.length,
      searchFreshWithin60Seconds,
    },
  };
}

async function writePerformanceReport(
  report: Phase5LoadReport,
  path = process.env.PHASE6_PERFORMANCE_LOAD_EVIDENCE_FILE ?? DEFAULT_PERFORMANCE_EVIDENCE_PATH,
): Promise<void> {
  const destination = isAbsolute(path) ? path : resolve(REPOSITORY_ROOT, path);
  await mkdir(resolve(destination, ".."), { recursive: true });
  const temporary = `${destination}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, destination);
}

class Phase5LoadBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Phase5LoadBlockedError";
  }
}

async function run(): Promise<void> {
  const config = cliConfig();
  const productionProfile =
    config.durationMs === DEFAULT_DURATION_MS && config.users === REQUIRED_RELEASE_USERS;
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
  if (productionProfile && !config.environmentManifestPath) {
    const metrics: Metrics = {
      getNote: [],
      autosave: [],
      search: [],
      uploads: 0,
      integrityChecks: 0,
      errors: [],
    };
    await writePerformanceReport(
      buildPerformanceReport(
        config,
        emptyLoadIdentity(),
        metrics,
        120_000,
        0,
        false,
        "blocked",
        "measured Phase 6 environment manifest is required for the release profile",
      ),
    );
    console.error(
      "PHASE5_LOAD_SKIPPED_RELEASE_BLOCKER: --environment-manifest=<path> is required for the 30m/5-user release profile",
    );
    process.exitCode = 2;
    return;
  }
  if (operatorCookie.length > 4096 || /[\r\n]/u.test(operatorCookie)) {
    throw new Error("operator cookie is invalid");
  }
  const baseUrl = safeBaseUrl(baseRaw);
  let manifest: Phase6EnvironmentManifest | undefined;
  if (config.environmentManifestPath) {
    try {
      manifest = await loadPhase6EnvironmentManifest(config.environmentManifestPath);
    } catch {
      if (productionProfile) {
        const metrics: Metrics = {
          getNote: [],
          autosave: [],
          search: [],
          uploads: 0,
          integrityChecks: 0,
          errors: [],
        };
        await writePerformanceReport(
          buildPerformanceReport(
            config,
            emptyLoadIdentity(),
            metrics,
            120_000,
            0,
            false,
            "blocked",
            "measured Phase 6 environment manifest is unavailable or invalid",
          ),
        );
        console.error(
          "PHASE5_LOAD_SKIPPED_RELEASE_BLOCKER: measured Phase 6 environment manifest is unavailable or invalid",
        );
        process.exitCode = 2;
        return;
      }
      throw new Error("environment manifest is unavailable or invalid");
    }
  }
  const identity = manifest ? manifestLoadIdentity(manifest) : emptyLoadIdentity();
  const inputs = loadActors(actorsRaw, productionProfile ? REQUIRED_RELEASE_USERS : config.users);
  const metrics: Metrics = {
    getNote: [],
    autosave: [],
    search: [],
    uploads: 0,
    integrityChecks: 0,
    errors: [],
  };
  if (productionProfile) {
    await Promise.all(inputs.map((input) => verifySeededNotes(baseUrl, input, metrics)));
  }
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
  const report = buildPerformanceReport(
    config,
    identity,
    metrics,
    warmupEndsAt - startedAt,
    newDeadLetters.length,
    fresh,
    productionProfile ? (passed ? "passed" : "failed") : "blocked",
    productionProfile || passed ? undefined : "short load is smoke-only and cannot satisfy P0-08",
  );
  if (productionProfile) await writePerformanceReport(report);
  console.log(
    JSON.stringify({
      status: productionProfile ? (passed ? "PASS" : "FAIL") : "SMOKE_ONLY",
      durationMs: config.durationMs,
      users: config.users,
      warmupMs: warmupEndsAt - startedAt,
      noteBytes: NOTE_BYTES,
      assetBytes: ASSET_BYTES,
      getNote: report.api.getNote,
      autosave: report.api.autosave,
      search: report.api.search,
      uploads: metrics.uploads,
      integrityChecks: metrics.integrityChecks,
      newDeadLetters: newDeadLetters.length,
      errors: metrics.errors.length,
      searchFreshWithin60Seconds: fresh,
    }),
  );
  if (!passed) process.exitCode = 1;
}

const invokedScript = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedScript === resolve(import.meta.filename)) {
  run().catch((error: unknown) => {
    if (error instanceof Phase5LoadBlockedError) {
      console.error(`PHASE5_LOAD_SKIPPED_RELEASE_BLOCKER: ${error.message}`);
      process.exitCode = 2;
      return;
    }
    console.error(
      "PHASE5_LOAD_FAILED: see sanitized counters; credentials and document content omitted",
    );
    process.exitCode = 1;
  });
}
