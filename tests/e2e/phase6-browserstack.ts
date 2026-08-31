import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";

export const BROWSER_MATRIX_SCHEMA_VERSION = 1 as const;
export const BROWSER_MATRIX_PRODUCER = "phase6-browserstack" as const;
export const BROWSER_MATRIX_PRODUCER_VERSION = "1.0.0" as const;

export type BrowserName = "Chrome" | "Firefox" | "Edge" | "Safari";
export type BrowserVersionAlias = "latest" | "latest-1";
export type BrowserOs = "Windows" | "OS X";
export type EvidenceStatus = "blocked" | "failed" | "passed";

export interface BrowserCapabilities {
  readonly browserName: BrowserName;
  readonly browserVersion: BrowserVersionAlias;
  readonly "bstack:options": {
    readonly os: BrowserOs;
    readonly osVersion: string;
    readonly projectName: "GlyphQuire";
    readonly sessionName: string;
    readonly buildName: "${PHASE6_BROWSERSTACK_BUILD}";
    readonly buildIdentifier: "${PHASE6_BROWSERSTACK_BUILD}";
  };
}

export interface BrowserMatrixTarget {
  readonly id: string;
  readonly browser: BrowserName;
  readonly browserVersion: BrowserVersionAlias;
  readonly os: BrowserOs;
  readonly osVersion: string;
  readonly capabilities: BrowserCapabilities;
}

export const EXPECTED_BROWSER_TARGETS = [
  {
    id: "chrome-latest",
    browser: "Chrome",
    browserVersion: "latest",
    os: "Windows",
    osVersion: "11",
    capabilities: {
      browserName: "Chrome",
      browserVersion: "latest",
      "bstack:options": {
        os: "Windows",
        osVersion: "11",
        projectName: "GlyphQuire",
        sessionName: "phase6-chrome-latest",
        buildName: "${PHASE6_BROWSERSTACK_BUILD}",
        buildIdentifier: "${PHASE6_BROWSERSTACK_BUILD}",
      },
    },
  },
  {
    id: "chrome-latest-1",
    browser: "Chrome",
    browserVersion: "latest-1",
    os: "Windows",
    osVersion: "11",
    capabilities: {
      browserName: "Chrome",
      browserVersion: "latest-1",
      "bstack:options": {
        os: "Windows",
        osVersion: "11",
        projectName: "GlyphQuire",
        sessionName: "phase6-chrome-latest-1",
        buildName: "${PHASE6_BROWSERSTACK_BUILD}",
        buildIdentifier: "${PHASE6_BROWSERSTACK_BUILD}",
      },
    },
  },
  {
    id: "firefox-latest",
    browser: "Firefox",
    browserVersion: "latest",
    os: "Windows",
    osVersion: "11",
    capabilities: {
      browserName: "Firefox",
      browserVersion: "latest",
      "bstack:options": {
        os: "Windows",
        osVersion: "11",
        projectName: "GlyphQuire",
        sessionName: "phase6-firefox-latest",
        buildName: "${PHASE6_BROWSERSTACK_BUILD}",
        buildIdentifier: "${PHASE6_BROWSERSTACK_BUILD}",
      },
    },
  },
  {
    id: "firefox-latest-1",
    browser: "Firefox",
    browserVersion: "latest-1",
    os: "Windows",
    osVersion: "11",
    capabilities: {
      browserName: "Firefox",
      browserVersion: "latest-1",
      "bstack:options": {
        os: "Windows",
        osVersion: "11",
        projectName: "GlyphQuire",
        sessionName: "phase6-firefox-latest-1",
        buildName: "${PHASE6_BROWSERSTACK_BUILD}",
        buildIdentifier: "${PHASE6_BROWSERSTACK_BUILD}",
      },
    },
  },
  {
    id: "edge-latest",
    browser: "Edge",
    browserVersion: "latest",
    os: "Windows",
    osVersion: "11",
    capabilities: {
      browserName: "Edge",
      browserVersion: "latest",
      "bstack:options": {
        os: "Windows",
        osVersion: "11",
        projectName: "GlyphQuire",
        sessionName: "phase6-edge-latest",
        buildName: "${PHASE6_BROWSERSTACK_BUILD}",
        buildIdentifier: "${PHASE6_BROWSERSTACK_BUILD}",
      },
    },
  },
  {
    id: "edge-latest-1",
    browser: "Edge",
    browserVersion: "latest-1",
    os: "Windows",
    osVersion: "11",
    capabilities: {
      browserName: "Edge",
      browserVersion: "latest-1",
      "bstack:options": {
        os: "Windows",
        osVersion: "11",
        projectName: "GlyphQuire",
        sessionName: "phase6-edge-latest-1",
        buildName: "${PHASE6_BROWSERSTACK_BUILD}",
        buildIdentifier: "${PHASE6_BROWSERSTACK_BUILD}",
      },
    },
  },
  {
    id: "safari-latest",
    browser: "Safari",
    browserVersion: "latest",
    os: "OS X",
    osVersion: "Sequoia",
    capabilities: {
      browserName: "Safari",
      browserVersion: "latest",
      "bstack:options": {
        os: "OS X",
        osVersion: "Sequoia",
        projectName: "GlyphQuire",
        sessionName: "phase6-safari-latest",
        buildName: "${PHASE6_BROWSERSTACK_BUILD}",
        buildIdentifier: "${PHASE6_BROWSERSTACK_BUILD}",
      },
    },
  },
  {
    id: "safari-latest-1",
    browser: "Safari",
    browserVersion: "latest-1",
    os: "OS X",
    osVersion: "Sonoma",
    capabilities: {
      browserName: "Safari",
      browserVersion: "latest-1",
      "bstack:options": {
        os: "OS X",
        osVersion: "Sonoma",
        projectName: "GlyphQuire",
        sessionName: "phase6-safari-latest-1",
        buildName: "${PHASE6_BROWSERSTACK_BUILD}",
        buildIdentifier: "${PHASE6_BROWSERSTACK_BUILD}",
      },
    },
  },
] as const satisfies readonly BrowserMatrixTarget[];

type JsonRecord = Record<string, unknown>;

export interface BrowserMatrixEvidenceTarget {
  readonly targetId: string;
  readonly browser: BrowserName;
  readonly browserVersion: BrowserVersionAlias;
  readonly os: BrowserOs;
  readonly osVersion: string;
  readonly status: EvidenceStatus;
  readonly blockingReason?: string;
  readonly sessionId?: string;
  readonly resolvedBrowserVersion?: string;
  readonly resolvedOsVersion?: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
}

export interface BrowserMatrixEvidence {
  readonly schemaVersion: typeof BROWSER_MATRIX_SCHEMA_VERSION;
  readonly status: EvidenceStatus;
  readonly scrubbed: true;
  readonly provider: "browserstack";
  readonly producer: typeof BROWSER_MATRIX_PRODUCER;
  readonly producerVersion: typeof BROWSER_MATRIX_PRODUCER_VERSION;
  readonly capturedAt: string;
  readonly externalEvidenceAvailable: boolean;
  readonly blockingReason?: string;
  readonly targets: readonly BrowserMatrixEvidenceTarget[];
  readonly summary: {
    readonly expectedTargets: 8;
    readonly passedTargets: number;
    readonly failedTargets: number;
    readonly blockedTargets: number;
    readonly providerSessionIds: number;
    readonly numericVersions: number;
  };
}

export type BrowserMatrixValidation =
  | { readonly valid: true; readonly errors: readonly [] }
  | { readonly valid: false; readonly errors: readonly string[] };

const EVIDENCE_KEYS = new Set([
  "schemaVersion",
  "status",
  "scrubbed",
  "provider",
  "producer",
  "producerVersion",
  "capturedAt",
  "externalEvidenceAvailable",
  "blockingReason",
  "targets",
  "summary",
]);
const TARGET_KEYS = new Set([
  "targetId",
  "browser",
  "browserVersion",
  "os",
  "osVersion",
  "status",
  "blockingReason",
  "sessionId",
  "resolvedBrowserVersion",
  "resolvedOsVersion",
  "startedAt",
  "finishedAt",
]);
const SUMMARY_KEYS = new Set([
  "expectedTargets",
  "passedTargets",
  "failedTargets",
  "blockedTargets",
  "providerSessionIds",
  "numericVersions",
]);
const SAFE_REASON = /^[A-Za-z0-9 .,;:_()/-]+$/u;
const VERSION = /^\d+(?:\.\d+){0,3}$/u;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;
const FORBIDDEN_EVIDENCE =
  /password|access[_-]?key|username|cookie|token|diagnostic|https?:\/\/|presigned|secret|markdown/iu;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: JsonRecord,
  allowed: ReadonlySet<string>,
  required: readonly string[],
) {
  const keys = Object.keys(value);
  return (
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    keys.every((key) => allowed.has(key))
  );
}

function isStatus(value: unknown): value is EvidenceStatus {
  return value === "blocked" || value === "failed" || value === "passed";
}

function isDateTime(value: unknown): value is string {
  return typeof value === "string" && ISO_DATE.test(value) && !Number.isNaN(Date.parse(value));
}

function isSafeReason(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= 240 && SAFE_REASON.test(value)
  );
}

function expectedTarget(targetId: unknown): BrowserMatrixTarget | undefined {
  return EXPECTED_BROWSER_TARGETS.find((target) => target.id === targetId);
}

function validateTarget(value: unknown, index: number, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push(`targets[${index}] must be an object`);
    return;
  }
  if (
    !hasExactKeys(value, TARGET_KEYS, [
      "targetId",
      "browser",
      "browserVersion",
      "os",
      "osVersion",
      "status",
    ])
  ) {
    errors.push(`targets[${index}] has unknown or missing fields`);
    return;
  }

  const expected = expectedTarget(value.targetId);
  if (expected === undefined) {
    errors.push(`targets[${index}] is not one of the expected provider targets`);
    return;
  }
  if (
    value.browser !== expected.browser ||
    value.browserVersion !== expected.browserVersion ||
    value.os !== expected.os ||
    value.osVersion !== expected.osVersion
  ) {
    errors.push(`targets[${index}] capability identity does not match the matrix`);
  }
  if (!isStatus(value.status)) errors.push(`targets[${index}].status is invalid`);

  if (value.blockingReason !== undefined && !isSafeReason(value.blockingReason)) {
    errors.push(`targets[${index}].blockingReason is not sanitized`);
  }
  for (const field of ["startedAt", "finishedAt"] as const) {
    if (value[field] !== undefined && !isDateTime(value[field])) {
      errors.push(`targets[${index}].${field} is not a UTC timestamp`);
    }
  }
  for (const field of ["resolvedBrowserVersion", "resolvedOsVersion"] as const) {
    if (
      value[field] !== undefined &&
      (typeof value[field] !== "string" || !VERSION.test(value[field]))
    ) {
      errors.push(`targets[${index}].${field} must be numeric`);
    }
  }
  if (
    value.sessionId !== undefined &&
    (typeof value.sessionId !== "string" || !SESSION_ID.test(value.sessionId))
  ) {
    errors.push(`targets[${index}].sessionId is not a safe provider id`);
  }
  if (value.status === "blocked" && !isSafeReason(value.blockingReason)) {
    errors.push(`targets[${index}] blocked status requires a sanitized reason`);
  }
  if (value.status === "passed") {
    if (typeof value.sessionId !== "string" || !SESSION_ID.test(value.sessionId)) {
      errors.push(`targets[${index}] passed status requires a provider session id`);
    }
    if (
      typeof value.resolvedBrowserVersion !== "string" ||
      !VERSION.test(value.resolvedBrowserVersion)
    ) {
      errors.push(`targets[${index}] passed status requires a numeric browser version`);
    }
    if (typeof value.resolvedOsVersion !== "string" || !VERSION.test(value.resolvedOsVersion)) {
      errors.push(`targets[${index}] passed status requires a numeric OS version`);
    }
  }
}

export function validateBrowserMatrixEvidence(value: unknown): BrowserMatrixValidation {
  const errors: string[] = [];
  if (
    !isRecord(value) ||
    !hasExactKeys(value, EVIDENCE_KEYS, [
      "schemaVersion",
      "status",
      "scrubbed",
      "provider",
      "producer",
      "producerVersion",
      "capturedAt",
      "externalEvidenceAvailable",
      "targets",
      "summary",
    ])
  ) {
    return { valid: false, errors: ["evidence has unknown or missing top-level fields"] };
  }

  if (value.schemaVersion !== BROWSER_MATRIX_SCHEMA_VERSION)
    errors.push("schemaVersion is invalid");
  if (!isStatus(value.status)) errors.push("status is invalid");
  if (value.scrubbed !== true) errors.push("scrubbed must be true");
  if (value.provider !== "browserstack") errors.push("provider is invalid");
  if (value.producer !== BROWSER_MATRIX_PRODUCER) errors.push("producer is invalid");
  if (value.producerVersion !== BROWSER_MATRIX_PRODUCER_VERSION)
    errors.push("producerVersion is invalid");
  if (!isDateTime(value.capturedAt)) errors.push("capturedAt is not a UTC timestamp");
  if (typeof value.externalEvidenceAvailable !== "boolean") {
    errors.push("externalEvidenceAvailable must be a boolean");
  }
  if (value.blockingReason !== undefined && !isSafeReason(value.blockingReason)) {
    errors.push("blockingReason is not sanitized");
  }

  if (!Array.isArray(value.targets) || value.targets.length !== EXPECTED_BROWSER_TARGETS.length) {
    errors.push("targets must contain exactly eight entries");
  } else {
    const targetIds = new Set<string>();
    value.targets.forEach((target, index) => {
      validateTarget(target, index, errors);
      if (isRecord(target) && typeof target.targetId === "string") targetIds.add(target.targetId);
    });
    if (targetIds.size !== EXPECTED_BROWSER_TARGETS.length)
      errors.push("targets contain duplicates");
  }

  if (!isRecord(value.summary) || !hasExactKeys(value.summary, SUMMARY_KEYS, [...SUMMARY_KEYS])) {
    errors.push("summary has unknown or missing fields");
  } else {
    const summary = value.summary;
    const counters = [
      "expectedTargets",
      "passedTargets",
      "failedTargets",
      "blockedTargets",
      "providerSessionIds",
      "numericVersions",
    ] as const;
    for (const counter of counters) {
      if (
        typeof summary[counter] !== "number" ||
        !Number.isInteger(summary[counter]) ||
        summary[counter] < 0 ||
        summary[counter] > EXPECTED_BROWSER_TARGETS.length
      ) {
        errors.push(`summary.${counter} must be a bounded integer`);
      }
    }
    if (summary.expectedTargets !== EXPECTED_BROWSER_TARGETS.length) {
      errors.push("summary.expectedTargets must be eight");
    }
    if (
      summary.passedTargets + summary.failedTargets + summary.blockedTargets !==
      EXPECTED_BROWSER_TARGETS.length
    ) {
      errors.push("summary status counters do not add up to eight");
    }
  }

  if (value.status === "blocked") {
    if (value.externalEvidenceAvailable !== false)
      errors.push("blocked evidence cannot claim external availability");
    if (!isSafeReason(value.blockingReason))
      errors.push("blocked evidence requires a sanitized reason");
    if (
      Array.isArray(value.targets) &&
      value.targets.some((target) => !isRecord(target) || target.status !== "blocked")
    ) {
      errors.push("blocked evidence requires every target to be blocked");
    }
  }
  if (value.status === "passed") {
    if (value.externalEvidenceAvailable !== true)
      errors.push("passed evidence requires external availability");
    if (
      Array.isArray(value.targets) &&
      value.targets.some((target) => !isRecord(target) || target.status !== "passed")
    ) {
      errors.push("passed evidence requires every target to pass");
    }
  }
  if (value.status === "failed" && value.externalEvidenceAvailable !== true) {
    errors.push("failed evidence must distinguish an available provider from blocked preflight");
  }

  if (FORBIDDEN_EVIDENCE.test(JSON.stringify(value)))
    errors.push("evidence contains forbidden diagnostics or secrets");
  return errors.length === 0 ? { valid: true, errors: [] } : { valid: false, errors };
}

function blockedTarget(target: BrowserMatrixTarget, reason: string): BrowserMatrixEvidenceTarget {
  return {
    targetId: target.id,
    browser: target.browser,
    browserVersion: target.browserVersion,
    os: target.os,
    osVersion: target.osVersion,
    status: "blocked",
    blockingReason: reason,
  };
}

function safeReason(reason: string): string {
  const cleaned = reason
    .replace(/[^A-Za-z0-9 .,;:_()/-]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!cleaned || FORBIDDEN_EVIDENCE.test(cleaned))
    return "external BrowserStack evidence is unavailable";
  return cleaned.slice(0, 240);
}

export function createBlockedBrowserMatrixEvidence(
  reason: string,
  capturedAt = new Date().toISOString(),
): BrowserMatrixEvidence {
  const sanitizedReason = safeReason(reason);
  const targets = EXPECTED_BROWSER_TARGETS.map((target) => blockedTarget(target, sanitizedReason));
  return {
    schemaVersion: BROWSER_MATRIX_SCHEMA_VERSION,
    status: "blocked",
    scrubbed: true,
    provider: "browserstack",
    producer: BROWSER_MATRIX_PRODUCER,
    producerVersion: BROWSER_MATRIX_PRODUCER_VERSION,
    capturedAt,
    externalEvidenceAvailable: false,
    blockingReason: sanitizedReason,
    targets,
    summary: {
      expectedTargets: 8,
      passedTargets: 0,
      failedTargets: 0,
      blockedTargets: 8,
      providerSessionIds: 0,
      numericVersions: 0,
    },
  };
}

export interface BrowserMatrixConfig {
  readonly schemaVersion: typeof BROWSER_MATRIX_SCHEMA_VERSION;
  readonly provider: "browserstack";
  readonly targets: readonly BrowserMatrixTarget[];
  readonly preflight: {
    readonly allowWebKitSubstitution: false;
    readonly requireProviderResolution: true;
    readonly requireSessionMetadata: true;
  };
}

export function parseBrowserMatrix(value: unknown): BrowserMatrixConfig {
  if (
    !isRecord(value) ||
    value.schemaVersion !== BROWSER_MATRIX_SCHEMA_VERSION ||
    value.provider !== "browserstack"
  ) {
    throw new Error("browser matrix configuration is invalid");
  }
  if (!Array.isArray(value.targets) || value.targets.length !== EXPECTED_BROWSER_TARGETS.length) {
    throw new Error("browser matrix must contain exactly eight targets");
  }
  if (
    !Array.isArray(value.targets) ||
    JSON.stringify(value.targets) !== JSON.stringify(EXPECTED_BROWSER_TARGETS)
  ) {
    throw new Error(
      "browser matrix targets do not match the required latest/latest-1 provider matrix",
    );
  }
  if (
    !isRecord(value.preflight) ||
    value.preflight.allowWebKitSubstitution !== false ||
    value.preflight.requireProviderResolution !== true ||
    value.preflight.requireSessionMetadata !== true
  ) {
    throw new Error("browser matrix preflight is not fail-closed");
  }
  return value as unknown as BrowserMatrixConfig;
}

interface ProviderSession {
  readonly sessionId: string;
  readonly browserVersion: string;
  readonly osVersion: string;
}

interface BrowserMatrixRunOptions {
  readonly sdkConfigPath: string;
  readonly matrixPath: string;
  readonly specPath: string;
  readonly evidencePath: string;
  readonly baseUrl?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchImpl?: typeof fetch;
}

interface BrowserMatrixRunResult {
  readonly evidence: BrowserMatrixEvidence;
  readonly exitCode: 0 | 1;
}

async function writeEvidence(path: string, evidence: BrowserMatrixEvidence): Promise<void> {
  const validation = validateBrowserMatrixEvidence(evidence);
  if (!validation.valid) throw new Error("refusing to write invalid browser evidence");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporaryPath, path);
}

function hasBrowserStackSdk(): boolean {
  try {
    createRequire(import.meta.url).resolve("browserstack-node-sdk");
    return true;
  } catch {
    return existsSync(resolve(process.cwd(), "node_modules/.bin/browserstack-node-sdk"));
  }
}

function hasProviderCredentials(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.BROWSERSTACK_USERNAME && env.BROWSERSTACK_ACCESS_KEY);
}

function safeBuildName(env: NodeJS.ProcessEnv): string {
  const requested = env.PHASE6_BROWSERSTACK_BUILD ?? "phase6-release";
  const normalized = requested.replace(/[^A-Za-z0-9._-]/gu, "-").slice(0, 80);
  return normalized || "phase6-release";
}

async function providerRequest(
  path: string,
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  const username = env.BROWSERSTACK_USERNAME;
  const accessKey = env.BROWSERSTACK_ACCESS_KEY;
  if (!username || !accessKey) throw new Error("provider credentials unavailable");
  const response = await fetchImpl(`https://api.browserstack.com${path}`, {
    headers: {
      Authorization: `Basic ${Buffer.from(`${username}:${accessKey}`).toString("base64")}`,
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error("provider preflight request failed");
  return response.json();
}

async function preflightResolveTargets(
  matrix: BrowserMatrixConfig,
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch,
): Promise<void> {
  const response = await providerRequest("/automate/browsers.json", env, fetchImpl);
  if (!Array.isArray(response)) throw new Error("provider browser inventory is invalid");
  for (const target of matrix.targets) {
    const supported = response.some((entry) => {
      if (!isRecord(entry)) return false;
      const browser = entry.browser ?? entry.browser_name;
      const os = entry.os;
      const osVersion = entry.os_version;
      return browser === target.browser && os === target.os && osVersion === target.osVersion;
    });
    if (!supported) throw new Error("provider target resolution failed");
  }
}

function runSdkTarget(
  options: BrowserMatrixRunOptions,
  target: BrowserMatrixTarget,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  // The BrowserStack Node SDK owns the remote Playwright transport. This
  // deliberately invokes its Playwright integration instead of connecting a
  // local browser (including local WebKit) to a provider endpoint.
  return new Promise((resolveRun) => {
    const child = spawn(
      "pnpm",
      [
        "exec",
        "browserstack-node-sdk",
        "playwright",
        "test",
        options.specPath,
        "--config",
        options.sdkConfigPath,
      ],
      {
        cwd: process.cwd(),
        env: {
          ...env,
          PHASE6_BROWSERSTACK_TARGET: target.id,
          PHASE6_BROWSERSTACK_BUILD: safeBuildName(env),
          PHASE6_BASE_URL: options.baseUrl ?? env.PHASE6_BASE_URL,
        },
        stdio: ["ignore", "ignore", "ignore"],
      },
    );
    child.once("error", () => resolveRun(false));
    child.once("exit", (code, signal) => resolveRun(code === 0 && signal === null));
  });
}

function numericVersion(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && VERSION.test(value)) return value;
  return undefined;
}

async function readProviderSession(
  target: BrowserMatrixTarget,
  buildName: string,
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch,
): Promise<ProviderSession | undefined> {
  const response = await providerRequest("/automate/sessions.json?limit=100", env, fetchImpl);
  const sessions = Array.isArray(response)
    ? response
    : isRecord(response) && Array.isArray(response.sessions)
      ? response.sessions
      : [];
  const candidate = sessions.find((entry) => {
    if (!isRecord(entry)) return false;
    const name = entry.name ?? entry.session_name;
    const build = entry.build_name ?? entry.buildName;
    const browser = entry.browser;
    const os = entry.os;
    return (
      (name === target.capabilities["bstack:options"].sessionName || name === target.id) &&
      (build === buildName || build === undefined) &&
      browser === target.browser &&
      os === target.os
    );
  });
  if (!isRecord(candidate)) return undefined;
  const sessionId = candidate.hashed_id ?? candidate.hashedId ?? candidate.id;
  const browserVersion = numericVersion(candidate.browser_version ?? candidate.browserVersion);
  const osVersion = numericVersion(candidate.os_version ?? candidate.osVersion);
  if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId) || !browserVersion || !osVersion)
    return undefined;
  return { sessionId, browserVersion, osVersion };
}

async function runTarget(
  options: BrowserMatrixRunOptions,
  target: BrowserMatrixTarget,
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch,
): Promise<BrowserMatrixEvidenceTarget> {
  const startedAt = new Date().toISOString();
  const passed = await runSdkTarget(options, target, env);
  if (!passed) {
    return {
      targetId: target.id,
      browser: target.browser,
      browserVersion: target.browserVersion,
      os: target.os,
      osVersion: target.osVersion,
      status: "failed",
      blockingReason: "provider test execution failed",
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }
  let session: ProviderSession | undefined;
  try {
    session = await readProviderSession(target, safeBuildName(env), env, fetchImpl);
  } catch {
    session = undefined;
  }
  if (!session) {
    return {
      targetId: target.id,
      browser: target.browser,
      browserVersion: target.browserVersion,
      os: target.os,
      osVersion: target.osVersion,
      status: "failed",
      blockingReason: "provider session metadata was unavailable",
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }
  return {
    targetId: target.id,
    browser: target.browser,
    browserVersion: target.browserVersion,
    os: target.os,
    osVersion: target.osVersion,
    status: "passed",
    sessionId: session.sessionId,
    resolvedBrowserVersion: session.browserVersion,
    resolvedOsVersion: session.osVersion,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}

function evidenceFromResults(
  results: readonly BrowserMatrixEvidenceTarget[],
  capturedAt: string,
): BrowserMatrixEvidence {
  const passedTargets = results.filter((target) => target.status === "passed").length;
  const failedTargets = results.filter((target) => target.status === "failed").length;
  const blockedTargets = results.filter((target) => target.status === "blocked").length;
  return {
    schemaVersion: BROWSER_MATRIX_SCHEMA_VERSION,
    status: passedTargets === EXPECTED_BROWSER_TARGETS.length ? "passed" : "failed",
    scrubbed: true,
    provider: "browserstack",
    producer: BROWSER_MATRIX_PRODUCER,
    producerVersion: BROWSER_MATRIX_PRODUCER_VERSION,
    capturedAt,
    externalEvidenceAvailable: true,
    targets: results,
    summary: {
      expectedTargets: 8,
      passedTargets,
      failedTargets,
      blockedTargets,
      providerSessionIds: results.filter((target) => target.sessionId !== undefined).length,
      numericVersions: results.filter(
        (target) =>
          target.resolvedBrowserVersion !== undefined && target.resolvedOsVersion !== undefined,
      ).length,
    },
  };
}

export async function runBrowserStackMatrix(
  options: BrowserMatrixRunOptions,
): Promise<BrowserMatrixRunResult> {
  const env = options.env ?? process.env;
  let matrix: BrowserMatrixConfig;
  try {
    matrix = parseBrowserMatrix(JSON.parse(await readFile(options.matrixPath, "utf8")));
  } catch {
    const evidence = createBlockedBrowserMatrixEvidence(
      "browser matrix configuration is unavailable",
    );
    await writeEvidence(options.evidencePath, evidence);
    return { evidence, exitCode: 1 };
  }

  if (!hasProviderCredentials(env)) {
    const evidence = createBlockedBrowserMatrixEvidence("BrowserStack credentials are unavailable");
    await writeEvidence(options.evidencePath, evidence);
    return { evidence, exitCode: 1 };
  }
  if (!hasBrowserStackSdk()) {
    const evidence = createBlockedBrowserMatrixEvidence("BrowserStack SDK is unavailable");
    await writeEvidence(options.evidencePath, evidence);
    return { evidence, exitCode: 1 };
  }
  if (!options.baseUrl && !env.PHASE6_BASE_URL) {
    const evidence = createBlockedBrowserMatrixEvidence("Phase 6 base URL is unavailable");
    await writeEvidence(options.evidencePath, evidence);
    return { evidence, exitCode: 1 };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    await preflightResolveTargets(matrix, env, fetchImpl);
  } catch {
    const evidence = createBlockedBrowserMatrixEvidence(
      "BrowserStack target resolution is unavailable",
    );
    await writeEvidence(options.evidencePath, evidence);
    return { evidence, exitCode: 1 };
  }

  const results: BrowserMatrixEvidenceTarget[] = [];
  for (const target of matrix.targets) {
    // Safari is always a BrowserStack target. There is intentionally no
    // branch that maps it to Playwright's local WebKit project.
    results.push(await runTarget(options, target, env, fetchImpl));
  }
  const evidence = evidenceFromResults(results, new Date().toISOString());
  await writeEvidence(options.evidencePath, evidence);
  return { evidence, exitCode: evidence.status === "passed" ? 0 : 1 };
}

interface CliOptions {
  readonly sdkConfigPath?: string;
  readonly matrixPath?: string;
  readonly specPath?: string;
  readonly evidencePath?: string;
}

function parseCliArgs(args: readonly string[]): CliOptions {
  const options: CliOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error("invalid BrowserStack harness arguments");
    }
    if (key === "--sdk-config") options.sdkConfigPath = value;
    else if (key === "--matrix") options.matrixPath = value;
    else if (key === "--spec") options.specPath = value;
    else if (key === "--evidence") options.evidencePath = value;
    else throw new Error("unknown BrowserStack harness argument");
    index += 1;
  }
  return options;
}

async function main(): Promise<void> {
  const cli = parseCliArgs(process.argv.slice(2));
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const result = await runBrowserStackMatrix({
    sdkConfigPath: resolve(root, cli.sdkConfigPath ?? "configs/phase6-browserstack.yml"),
    matrixPath: resolve(root, cli.matrixPath ?? "configs/phase6-browser-matrix.json"),
    specPath: resolve(root, cli.specPath ?? "tests/e2e/phase6-browser-matrix.spec.ts"),
    evidencePath: resolve(root, cli.evidencePath ?? "docs/evidence/phase6/browser-matrix.json"),
  });
  process.stdout.write(`PHASE6_BROWSERSTACK_${result.evidence.status.toUpperCase()}\n`);
  process.exitCode = result.exitCode;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) void main();
