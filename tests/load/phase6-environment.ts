#!/usr/bin/env tsx
/**
 * Phase 6 §40.1 host probe.
 *
 * The release workload is only meaningful when the process can prove the
 * resources it was given.  This module deliberately reads the kernel and
 * cgroup values itself; CPU and memory values supplied through environment
 * variables are never consulted for the host minimum.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { arch as processArch, cpus, platform, totalmem } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";

export const PHASE6_ENVIRONMENT_SCHEMA_VERSION = 1;
export const PHASE6_ENVIRONMENT_PRODUCER = "phase6-performance-environment";
export const PHASE6_ENVIRONMENT_PATH = "docs/evidence/phase6/performance-environment.json";
export const PHASE6_MIN_VCPUS = 4;
export const PHASE6_MIN_MEMORY_BYTES = 8 * 1024 * 1024 * 1024;

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SOURCE_SHA_PATTERN = /^[a-f0-9]{40}$/u;
const IMAGE_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const REPOSITORY_ROOT = resolve(import.meta.dirname, "../..");

export interface Phase6ImageDigests {
  readonly api: string;
  readonly web: string;
  readonly worker: string;
}

export interface Phase6EnvironmentHost {
  readonly platform: "linux";
  readonly architecture: "x86-64";
  readonly cpuCount: number;
  readonly cpuQuotaVcpus: number | null;
  readonly effectiveVcpus: number;
  readonly memoryLimitBytes: number;
  readonly cgroupCpuMax: string;
  readonly cgroupMemoryMax: string;
}

export interface Phase6EnvironmentManifest {
  readonly schemaVersion: 1;
  readonly status: "blocked" | "failed" | "passed";
  readonly scrubbed: true;
  readonly producer: typeof PHASE6_ENVIRONMENT_PRODUCER;
  readonly measuredAt: string;
  readonly host: Phase6EnvironmentHost;
  readonly topology: {
    readonly sameHost: true;
    readonly compose: true;
    readonly network: "phase6-test-network";
    readonly services: readonly ["api", "worker", "postgres", "object-storage"];
  };
  readonly candidateSourceSha: string;
  readonly lockfileSha256: string;
  readonly nodeVersion: string;
  readonly pnpmVersion: string;
  readonly imageDigests: Phase6ImageDigests;
  /** SHA-256 over the canonical manifest with this property omitted. */
  readonly manifestSha256: string;
  readonly blockingReason?: string;
}

export interface Phase6EnvironmentMeasurement {
  readonly host: Phase6EnvironmentHost;
  readonly meetsMinimum: boolean;
}

export interface Phase6EnvironmentProbeOptions {
  readonly arch?: () => string;
  readonly cpus?: () => readonly unknown[];
  readonly platform?: () => string;
  readonly totalmem?: () => number;
  readonly readFile?: (path: string, encoding: "utf8") => Promise<string>;
  readonly cpuMaxPath?: string;
  readonly memoryMaxPath?: string;
}

export interface Phase6EnvironmentManifestOptions {
  readonly measurement: Phase6EnvironmentMeasurement;
  readonly candidateSourceSha: string;
  readonly lockfileSha256: string;
  readonly nodeVersion: string;
  readonly pnpmVersion: string;
  readonly imageDigests: Phase6ImageDigests;
  readonly measuredAt?: string;
  readonly status?: "blocked" | "failed" | "passed";
  readonly blockingReason?: string;
}

export interface Phase6EnvironmentValidationOptions {
  readonly expectedCandidateSourceSha?: string;
  readonly expectedLockfileSha256?: string;
  readonly expectedImageDigests?: Phase6ImageDigests;
  readonly currentMeasurement?: Phase6EnvironmentMeasurement;
  readonly requirePassed?: boolean;
}

export class Phase6EnvironmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Phase6EnvironmentError";
  }
}

function finitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function parseCpuQuota(raw: string): number | null {
  const fields = raw.trim().split(/\s+/u);
  if (fields.length !== 2) throw new Phase6EnvironmentError("cgroup CPU quota is unreadable");
  const [quota, period] = fields;
  if (period === undefined || !/^\d+$/u.test(period) || Number(period) <= 0) {
    throw new Phase6EnvironmentError("cgroup CPU period is unreadable");
  }
  if (quota === "max") return null;
  if (!/^\d+$/u.test(quota) || Number(quota) <= 0) {
    throw new Phase6EnvironmentError("cgroup CPU quota is unreadable");
  }
  const value = Number(quota) / Number(period);
  if (!finitePositive(value)) throw new Phase6EnvironmentError("cgroup CPU quota is unreadable");
  return value;
}

function parseMemoryLimit(raw: string, hostMemoryBytes: number): number {
  const value = raw.trim();
  if (value === "max") {
    if (!finitePositive(hostMemoryBytes)) {
      throw new Phase6EnvironmentError("host memory is unreadable");
    }
    return hostMemoryBytes;
  }
  if (!/^\d+$/u.test(value) || Number(value) <= 0 || !Number.isSafeInteger(Number(value))) {
    throw new Phase6EnvironmentError("cgroup memory limit is unreadable");
  }
  return Number(value);
}

/** Parse the cgroup v2 cpu.max value and return its effective vCPU quota. */
export function parsePhase6CpuMax(raw: string): number | null {
  return parseCpuQuota(raw);
}

/** Parse the cgroup v2 memory.max value, using host memory for an unlimited cgroup. */
export function parsePhase6MemoryMax(raw: string, hostMemoryBytes: number): number {
  return parseMemoryLimit(raw, hostMemoryBytes);
}

export async function measurePhase6Environment(
  options: Phase6EnvironmentProbeOptions = {},
): Promise<Phase6EnvironmentMeasurement> {
  const read = options.readFile ?? ((path: string, encoding: "utf8") => readFile(path, encoding));
  const getArch = options.arch ?? processArch;
  const getCpus = options.cpus ?? cpus;
  const getPlatform = options.platform ?? platform;
  const getTotalMemory = options.totalmem ?? totalmem;
  if (getPlatform() !== "linux") {
    throw new Phase6EnvironmentError("Phase 6 performance evidence requires Linux");
  }
  if (getArch() !== "x64") {
    throw new Phase6EnvironmentError("Phase 6 performance evidence requires x86-64");
  }

  const cpuInfo = getCpus();
  const cpuCount = cpuInfo.length;
  if (!Number.isInteger(cpuCount) || cpuCount < 1) {
    throw new Phase6EnvironmentError("host CPU information is unreadable");
  }
  const cpuPath = options.cpuMaxPath ?? "/sys/fs/cgroup/cpu.max";
  const memoryPath = options.memoryMaxPath ?? "/sys/fs/cgroup/memory.max";
  let cpuMax: string;
  let memoryMax: string;
  try {
    [cpuMax, memoryMax] = await Promise.all([read(cpuPath, "utf8"), read(memoryPath, "utf8")]);
  } catch {
    throw new Phase6EnvironmentError("cgroup CPU and memory limits are unreadable");
  }
  if (!cpuMax.trim() || !memoryMax.trim()) {
    throw new Phase6EnvironmentError("cgroup CPU and memory limits are unreadable");
  }
  const cpuQuotaVcpus = parseCpuQuota(cpuMax);
  const memoryLimitBytes = parseMemoryLimit(memoryMax, getTotalMemory());
  const effectiveVcpus = cpuQuotaVcpus === null ? cpuCount : Math.min(cpuCount, cpuQuotaVcpus);
  if (!finitePositive(effectiveVcpus) || !finitePositive(memoryLimitBytes)) {
    throw new Phase6EnvironmentError("host resource limits are unreadable");
  }
  return {
    host: {
      platform: "linux",
      architecture: "x86-64",
      cpuCount,
      cpuQuotaVcpus,
      effectiveVcpus,
      memoryLimitBytes,
      cgroupCpuMax: cpuMax.trim(),
      cgroupMemoryMax: memoryMax.trim(),
    },
    meetsMinimum: effectiveVcpus >= PHASE6_MIN_VCPUS && memoryLimitBytes >= PHASE6_MIN_MEMORY_BYTES,
  };
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalize(entry)).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== "manifestSha256")
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function phase6ManifestSha256(value: unknown): string {
  return createHash("sha256").update(canonicalize(value), "utf8").digest("hex");
}

function assertImageDigests(value: Phase6ImageDigests): void {
  if (
    !IMAGE_DIGEST_PATTERN.test(value.api) ||
    !IMAGE_DIGEST_PATTERN.test(value.web) ||
    !IMAGE_DIGEST_PATTERN.test(value.worker)
  ) {
    throw new Phase6EnvironmentError("immutable API, web, and worker image digests are required");
  }
}

function assertSourceSha(value: string): void {
  if (!SOURCE_SHA_PATTERN.test(value))
    throw new Phase6EnvironmentError("candidate source SHA is invalid");
}

function assertLockfileSha(value: string): void {
  if (!SHA256_PATTERN.test(value)) throw new Phase6EnvironmentError("lockfile SHA-256 is invalid");
}

export function createPhase6EnvironmentManifest(
  options: Phase6EnvironmentManifestOptions,
): Phase6EnvironmentManifest {
  assertSourceSha(options.candidateSourceSha);
  assertLockfileSha(options.lockfileSha256);
  assertImageDigests(options.imageDigests);
  const status = options.status ?? (options.measurement.meetsMinimum ? "passed" : "blocked");
  if (status === "passed" && !options.measurement.meetsMinimum) {
    throw new Phase6EnvironmentError("host is below the Phase 6 performance minimum");
  }
  const base = {
    schemaVersion: PHASE6_ENVIRONMENT_SCHEMA_VERSION,
    status,
    scrubbed: true,
    producer: PHASE6_ENVIRONMENT_PRODUCER,
    measuredAt: options.measuredAt ?? new Date().toISOString(),
    host: options.measurement.host,
    topology: {
      sameHost: true,
      compose: true,
      network: "phase6-test-network" as const,
      services: ["api", "worker", "postgres", "object-storage"] as const,
    },
    candidateSourceSha: options.candidateSourceSha,
    lockfileSha256: options.lockfileSha256,
    nodeVersion: options.nodeVersion,
    pnpmVersion: options.pnpmVersion,
    imageDigests: options.imageDigests,
    ...(options.blockingReason ? { blockingReason: options.blockingReason } : {}),
  };
  return { ...base, manifestSha256: phase6ManifestSha256(base) } as Phase6EnvironmentManifest;
}

function validHost(host: unknown): host is Phase6EnvironmentHost {
  if (!host || typeof host !== "object") return false;
  const value = host as Partial<Phase6EnvironmentHost>;
  return (
    value.platform === "linux" &&
    value.architecture === "x86-64" &&
    typeof value.cpuCount === "number" &&
    Number.isInteger(value.cpuCount) &&
    value.cpuCount > 0 &&
    (value.cpuQuotaVcpus === null ||
      (typeof value.cpuQuotaVcpus === "number" && finitePositive(value.cpuQuotaVcpus))) &&
    typeof value.effectiveVcpus === "number" &&
    finitePositive(value.effectiveVcpus) &&
    typeof value.memoryLimitBytes === "number" &&
    Number.isSafeInteger(value.memoryLimitBytes) &&
    value.memoryLimitBytes > 0 &&
    typeof value.cgroupCpuMax === "string" &&
    value.cgroupCpuMax.length > 0 &&
    typeof value.cgroupMemoryMax === "string" &&
    value.cgroupMemoryMax.length > 0
  );
}

function sameHost(left: Phase6EnvironmentHost, right: Phase6EnvironmentHost): boolean {
  return (
    left.platform === right.platform &&
    left.architecture === right.architecture &&
    left.cpuCount === right.cpuCount &&
    left.cpuQuotaVcpus === right.cpuQuotaVcpus &&
    left.effectiveVcpus === right.effectiveVcpus &&
    left.memoryLimitBytes === right.memoryLimitBytes &&
    left.cgroupCpuMax === right.cgroupCpuMax &&
    left.cgroupMemoryMax === right.cgroupMemoryMax
  );
}

export function validatePhase6EnvironmentManifest(
  value: unknown,
  options: Phase6EnvironmentValidationOptions = {},
): Phase6EnvironmentManifest {
  if (!value || typeof value !== "object")
    throw new Phase6EnvironmentError("environment manifest is invalid");
  const candidate = value as Partial<Phase6EnvironmentManifest>;
  if (
    candidate.schemaVersion !== 1 ||
    candidate.scrubbed !== true ||
    candidate.producer !== PHASE6_ENVIRONMENT_PRODUCER ||
    typeof candidate.measuredAt !== "string" ||
    !validHost(candidate.host) ||
    !candidate.topology ||
    candidate.topology.sameHost !== true ||
    candidate.topology.compose !== true ||
    candidate.topology.network !== "phase6-test-network" ||
    candidate.topology.services?.join(",") !== "api,worker,postgres,object-storage" ||
    typeof candidate.candidateSourceSha !== "string" ||
    !SOURCE_SHA_PATTERN.test(candidate.candidateSourceSha) ||
    typeof candidate.lockfileSha256 !== "string" ||
    !SHA256_PATTERN.test(candidate.lockfileSha256) ||
    typeof candidate.nodeVersion !== "string" ||
    candidate.nodeVersion.length === 0 ||
    typeof candidate.pnpmVersion !== "string" ||
    candidate.pnpmVersion.length === 0 ||
    !candidate.imageDigests ||
    !IMAGE_DIGEST_PATTERN.test(candidate.imageDigests.api) ||
    !IMAGE_DIGEST_PATTERN.test(candidate.imageDigests.web) ||
    !IMAGE_DIGEST_PATTERN.test(candidate.imageDigests.worker) ||
    typeof candidate.manifestSha256 !== "string" ||
    !SHA256_PATTERN.test(candidate.manifestSha256) ||
    phase6ManifestSha256(candidate) !== candidate.manifestSha256
  ) {
    throw new Phase6EnvironmentError("environment manifest failed schema or hash validation");
  }
  if (options.requirePassed !== false && candidate.status !== "passed") {
    throw new Phase6EnvironmentError("environment manifest is not a passed release manifest");
  }
  if (
    candidate.status !== "blocked" &&
    candidate.status !== "failed" &&
    candidate.status !== "passed"
  ) {
    throw new Phase6EnvironmentError("environment manifest status is invalid");
  }
  if (!candidate.host || candidate.host.effectiveVcpus < PHASE6_MIN_VCPUS) {
    throw new Phase6EnvironmentError("environment manifest is below the four-vCPU minimum");
  }
  if (!candidate.host || candidate.host.memoryLimitBytes < PHASE6_MIN_MEMORY_BYTES) {
    throw new Phase6EnvironmentError("environment manifest is below the eight-GiB minimum");
  }
  if (
    options.expectedCandidateSourceSha !== undefined &&
    candidate.candidateSourceSha !== options.expectedCandidateSourceSha
  ) {
    throw new Phase6EnvironmentError(
      "environment manifest source SHA does not match the candidate",
    );
  }
  if (
    options.expectedLockfileSha256 !== undefined &&
    candidate.lockfileSha256 !== options.expectedLockfileSha256
  ) {
    throw new Phase6EnvironmentError(
      "environment manifest lockfile SHA does not match the candidate",
    );
  }
  if (options.expectedImageDigests) {
    if (JSON.stringify(candidate.imageDigests) !== JSON.stringify(options.expectedImageDigests)) {
      throw new Phase6EnvironmentError(
        "environment manifest image digests do not match the candidate",
      );
    }
  }
  if (options.currentMeasurement && !sameHost(candidate.host, options.currentMeasurement.host)) {
    throw new Phase6EnvironmentError("environment manifest does not describe this process host");
  }
  return candidate as Phase6EnvironmentManifest;
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  const destination = isAbsolute(path) ? path : resolve(REPOSITORY_ROOT, path);
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, destination);
}

function readVersion(command: string, args: readonly string[], fallback: string): string {
  try {
    const output = execFileSync(command, [...args], {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
    }).trim();
    return output || fallback;
  } catch {
    return fallback;
  }
}

function gitSourceSha(): string {
  const configured = process.env.PHASE6_CANDIDATE_SOURCE_SHA;
  if (configured && SOURCE_SHA_PATTERN.test(configured)) return configured;
  const value = readVersion("git", ["rev-parse", "HEAD"], "");
  if (!SOURCE_SHA_PATTERN.test(value))
    throw new Phase6EnvironmentError("candidate source SHA is unavailable");
  return value;
}

function imageDigestFromEnvironment(name: "API" | "WEB" | "WORKER"): string {
  const configured =
    process.env[`PHASE6_${name}_IMAGE_DIGEST`] ?? process.env[`PHASE6_IMAGE_DIGEST_${name}`];
  if (!configured || !IMAGE_DIGEST_PATTERN.test(configured)) {
    throw new Phase6EnvironmentError(`immutable ${name.toLowerCase()} image digest is unavailable`);
  }
  return configured;
}

export async function runPhase6EnvironmentProbe(): Promise<Phase6EnvironmentManifest> {
  const measurement = await measurePhase6Environment();
  if (!measurement.meetsMinimum) {
    throw new Phase6EnvironmentError(
      "host is below the required Linux x86-64 4-vCPU/8-GiB minimum",
    );
  }
  const lockfileSha256 = createHash("sha256")
    .update(await readFile(resolve(REPOSITORY_ROOT, "pnpm-lock.yaml")))
    .digest("hex");
  const manifest = createPhase6EnvironmentManifest({
    measurement,
    candidateSourceSha: gitSourceSha(),
    lockfileSha256,
    nodeVersion: process.versions.node,
    pnpmVersion: readVersion("pnpm", ["--version"], "unknown"),
    imageDigests: {
      api: imageDigestFromEnvironment("API"),
      web: imageDigestFromEnvironment("WEB"),
      worker: imageDigestFromEnvironment("WORKER"),
    },
  });
  await atomicWriteJson(PHASE6_ENVIRONMENT_PATH, manifest);
  return manifest;
}

async function main(): Promise<void> {
  try {
    const manifest = await runPhase6EnvironmentProbe();
    console.log(
      JSON.stringify({
        status: manifest.status,
        manifestSha256: manifest.manifestSha256,
        effectiveVcpus: manifest.host.effectiveVcpus,
        memoryLimitBytes: manifest.host.memoryLimitBytes,
      }),
    );
  } catch (error) {
    const reason =
      error instanceof Phase6EnvironmentError ? error.message : "environment probe failed";
    console.error(`PHASE6_ENVIRONMENT_SKIPPED_RELEASE_BLOCKER: ${reason}`);
    process.exitCode = 2;
  }
}

const invokedScript = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedScript === resolve(import.meta.filename)) {
  void main();
}
