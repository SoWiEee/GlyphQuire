import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { ImportPayload, JobEnvelope } from "@glyphquire/api-contract/jobs";
import {
  assets,
  importResources,
  imports,
  notes,
  noteVersions,
  type Database,
  type Import,
  type ImportManifest,
  type ImportResource,
} from "@glyphquire/database";
import { createDocumentEngine, type NotebookDocument } from "@glyphquire/document-engine";
import { PostgresJobDispatcher, type JobHandler } from "@glyphquire/queue";
import type { ObjectStoragePort } from "@glyphquire/storage";
import { and, eq, inArray, isNull, ne, sql, sum } from "drizzle-orm";
import { strFromU8, unzipSync } from "fflate";

const MAX_ARCHIVE_BYTES = 25 * 1024 * 1024;
const MAX_ARCHIVE_FILES = 256;
const MAX_EXPANDED_BYTES = 100 * 1024 * 1024;
const MAX_ARCHIVE_ENTRY_BYTES = 5 * 1024 * 1024;
const MAX_MARKDOWN_BYTES = 2 * 1024 * 1024;
const DEFAULT_ASSET_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_WORKSPACE_QUOTA_BYTES = 100 * 1024 * 1024;
const DEFAULT_STAGING_GRACE_SECONDS = 3_600;
const MAX_PATH_BYTES = 1_024;
const MAX_PATH_SEGMENT_BYTES = 255;
const MAX_ZIP_COMMENT_BYTES = 65_535;
const MILLISECONDS_PER_SECOND = 1_000;

const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const UTF8_FLAG = 0x0800;
const ENCRYPTION_FLAGS = 0x2041;
const UNIX_FILE_TYPE_MASK = 0xf000;
const UNIX_DIRECTORY_TYPE = 0x4000;
const UNIX_REGULAR_TYPE = 0x8000;
const UNIX_SYMLINK_TYPE = 0xa000;
const DOS_DIRECTORY_ATTRIBUTE = 0x10;

type DbTransaction = Parameters<Database["transaction"]>[0] extends (tx: infer Tx) => unknown
  ? Tx
  : never;

interface SourceManifest {
  sizeBytes: number;
  sha256: string;
  contentType: string;
  kind?: "zip" | "markdown";
}

export interface ImportResourceManifest {
  id: string;
  assetId: string;
  objectKey: string;
  relativePath: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
}

interface WorkerManifest extends ImportManifest {
  version: 1;
  source: SourceManifest;
  progress: {
    completedItems: number;
    totalItems: number;
    processedBytes: number;
    totalBytes: number;
  };
  resources: ImportResourceManifest[];
  result?: { noteId: string; revision: number };
}

interface ArchiveEntryMetadata {
  rawName: string;
  relativePath: string;
  expandedSize: number;
  directory: boolean;
}

interface ParsedImport {
  markdown: string;
  markdownBytes: number;
  schemaVersion: number;
  title: string;
  resources: Array<ImportResourceManifest & { body: Buffer }>;
  referencedAssetIds: Set<string>;
}

export interface ImportHandlerHooks {
  afterResourceDeclaration?(): void | Promise<void>;
  afterResourcePut?(resourceId: string): void | Promise<void>;
  beforeFinalization?(): void | Promise<void>;
  beforeFinalizationCommit?(): void | Promise<void>;
  afterFinalizationCommit?(): void | Promise<void>;
}

export interface ImportHandlerDeps {
  database: Database;
  storage: ObjectStoragePort;
  maxAssetBytes?: number;
  workspaceQuotaBytes?: number;
  stagingGraceSeconds?: number;
  clock?: () => number;
  hooks?: ImportHandlerHooks;
}

class ImportInvalidError extends Error {
  constructor() {
    super("IMPORT_INVALID");
  }
}

function invalidImport(): never {
  throw new ImportInvalidError();
}

function positiveBoundedInteger(value: number, maximum: number, label: string): number {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function checkAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("JOB_FAILED");
}

function readUint16(view: DataView, offset: number): number {
  if (offset < 0 || offset + 2 > view.byteLength) invalidImport();
  return view.getUint16(offset, true);
}

function readUint32(view: DataView, offset: number): number {
  if (offset < 0 || offset + 4 > view.byteLength) invalidImport();
  return view.getUint32(offset, true);
}

function decodeZipName(bytes: Uint8Array, flags: number): string {
  try {
    const value = strFromU8(bytes, (flags & UTF8_FLAG) === 0);
    if (value.includes("\uFFFD")) invalidImport();
    return value;
  } catch {
    return invalidImport();
  }
}

function canonicalArchivePath(rawName: string): string {
  if (!rawName || rawName.includes("\\") || rawName.startsWith("/")) invalidImport();
  if (/^[A-Za-z]:/u.test(rawName)) invalidImport();
  if (Array.from(rawName).some((character) => (character.codePointAt(0) ?? 0) <= 0x1f)) {
    invalidImport();
  }
  const segments: string[] = [];
  for (const rawSegment of rawName.split("/")) {
    if (rawSegment === "" || rawSegment === ".") continue;
    if (rawSegment === "..") invalidImport();
    const segment = rawSegment.normalize("NFC");
    if (Buffer.byteLength(segment, "utf8") > MAX_PATH_SEGMENT_BYTES) invalidImport();
    segments.push(segment);
  }
  if (segments.length === 0) invalidImport();
  const canonical = segments.join("/");
  if (Buffer.byteLength(canonical, "utf8") > MAX_PATH_BYTES) invalidImport();
  return canonical;
}

function findEndOfCentralDirectory(view: DataView): number {
  if (view.byteLength < 22) invalidImport();
  const minimum = Math.max(0, view.byteLength - 22 - MAX_ZIP_COMMENT_BYTES);
  for (let offset = view.byteLength - 22; offset >= minimum; offset -= 1) {
    if (readUint32(view, offset) !== END_OF_CENTRAL_DIRECTORY_SIGNATURE) continue;
    if (offset + 22 + readUint16(view, offset + 20) === view.byteLength) return offset;
  }
  return invalidImport();
}

function readArchiveMetadata(bytes: Buffer): ArchiveEntryMetadata[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const endOffset = findEndOfCentralDirectory(view);
  const diskNumber = readUint16(view, endOffset + 4);
  const centralDisk = readUint16(view, endOffset + 6);
  const diskEntries = readUint16(view, endOffset + 8);
  const entryCount = readUint16(view, endOffset + 10);
  const centralSize = readUint32(view, endOffset + 12);
  const centralOffset = readUint32(view, endOffset + 16);
  if (
    diskNumber !== 0 ||
    centralDisk !== 0 ||
    diskEntries !== entryCount ||
    entryCount === 0xffff ||
    entryCount > MAX_ARCHIVE_FILES ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff ||
    centralOffset + centralSize !== endOffset
  ) {
    invalidImport();
  }

  const entries: ArchiveEntryMetadata[] = [];
  let expandedBytes = 0;
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > endOffset || readUint32(view, cursor) !== CENTRAL_DIRECTORY_SIGNATURE) {
      invalidImport();
    }
    const createdBySystem = readUint16(view, cursor + 4) >>> 8;
    const flags = readUint16(view, cursor + 8);
    const compression = readUint16(view, cursor + 10);
    const compressedSize = readUint32(view, cursor + 20);
    const expandedSize = readUint32(view, cursor + 24);
    const nameLength = readUint16(view, cursor + 28);
    const extraLength = readUint16(view, cursor + 30);
    const commentLength = readUint16(view, cursor + 32);
    const diskStart = readUint16(view, cursor + 34);
    const externalAttributes = readUint32(view, cursor + 38);
    const localOffset = readUint32(view, cursor + 42);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (
      next > endOffset ||
      diskStart !== 0 ||
      localOffset === 0xffffffff ||
      compressedSize === 0xffffffff ||
      expandedSize === 0xffffffff ||
      (flags & ENCRYPTION_FLAGS) !== 0 ||
      (compression !== 0 && compression !== 8) ||
      expandedSize > MAX_ARCHIVE_ENTRY_BYTES
    ) {
      invalidImport();
    }
    expandedBytes += expandedSize;
    if (!Number.isSafeInteger(expandedBytes) || expandedBytes > MAX_EXPANDED_BYTES) invalidImport();

    const rawName = decodeZipName(bytes.subarray(cursor + 46, cursor + 46 + nameLength), flags);
    const relativePath = canonicalArchivePath(rawName);
    const unixType = (externalAttributes >>> 16) & UNIX_FILE_TYPE_MASK;
    if (unixType === UNIX_SYMLINK_TYPE) invalidImport();
    if (unixType !== 0 && unixType !== UNIX_REGULAR_TYPE && unixType !== UNIX_DIRECTORY_TYPE) {
      invalidImport();
    }
    const unixDirectory =
      (createdBySystem === 3 || createdBySystem === 19) && unixType === UNIX_DIRECTORY_TYPE;
    const directory =
      rawName.endsWith("/") ||
      unixDirectory ||
      (externalAttributes & DOS_DIRECTORY_ATTRIBUTE) !== 0;
    if (directory && (expandedSize !== 0 || !rawName.endsWith("/"))) invalidImport();
    entries.push({ rawName, relativePath, expandedSize, directory });
    cursor = next;
  }
  if (cursor !== endOffset) invalidImport();

  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.relativePath)) invalidImport();
    for (const prior of entries) {
      if (
        prior !== entry &&
        !prior.directory &&
        entry.relativePath.startsWith(`${prior.relativePath}/`)
      ) {
        invalidImport();
      }
    }
    seen.add(entry.relativePath);
  }
  return entries;
}

function extractArchive(bytes: Buffer): Map<string, Buffer> {
  if (bytes.byteLength > MAX_ARCHIVE_BYTES) invalidImport();
  const metadata = readArchiveMetadata(bytes);
  let extracted: Record<string, Uint8Array>;
  try {
    extracted = unzipSync(bytes);
  } catch {
    return invalidImport();
  }
  const output = new Map<string, Buffer>();
  for (const entry of metadata) {
    if (entry.directory) continue;
    const body = extracted[entry.rawName];
    if (!body || body.byteLength !== entry.expandedSize) invalidImport();
    output.set(entry.relativePath, Buffer.from(body));
  }
  if (output.size !== metadata.filter((entry) => !entry.directory).length) invalidImport();
  return output;
}

async function readBoundedStream(
  stream: ReadableStream<Uint8Array>,
  maximumBytes: number,
): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        invalidImport();
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0) invalidImport();
  return Buffer.concat(chunks, total);
}

function decodeMarkdown(bytes: Buffer): string {
  if (bytes.byteLength > MAX_MARKDOWN_BYTES) invalidImport();
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return invalidImport();
  }
}

function deterministicUuid(importId: string, purpose: string): string {
  const bytes = createHash("sha256")
    .update(`${importId}\0${purpose}`, "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function safeOriginalName(relativePath: string): string {
  const raw = posix.basename(relativePath).normalize("NFC");
  const cleaned = Array.from(raw)
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint >= 0x20 && codePoint !== 0x7f;
    })
    .join("")
    .replace(/[^A-Za-z0-9._ -]/gu, "_")
    .trim();
  const bounded = Buffer.from(cleaned || "file", "utf8")
    .subarray(0, 255)
    .toString("utf8");
  return bounded || "file";
}

const BLOCKED_EXTENSIONS = new Set([".svg", ".html", ".htm", ".xhtml", ".js", ".mjs", ".cjs"]);

function assetMime(relativePath: string, body: Buffer): string {
  const extension = posix.extname(relativePath).toLowerCase();
  if (BLOCKED_EXTENSIONS.has(extension)) invalidImport();
  if (body.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return "image/png";
  if (body.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "image/jpeg";
  if (body.subarray(0, 4).toString("latin1") === "GIF8") return "image/gif";
  if (
    body.subarray(0, 4).toString("latin1") === "RIFF" &&
    body.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return "image/webp";
  }
  if (body.subarray(0, 4).toString("latin1") === "%PDF") return "application/pdf";
  if (body.subarray(0, 4).readUInt32LE(0) === 0x04034b50) return "application/zip";

  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf", ".zip"].includes(extension)) {
    invalidImport();
  }
  if ([".txt", ".md", ".markdown", ".csv", ".json"].includes(extension)) {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(body);
    } catch {
      invalidImport();
    }
    const byExtension: Record<string, string> = {
      ".txt": "text/plain",
      ".md": "text/markdown",
      ".markdown": "text/markdown",
      ".csv": "text/csv",
      ".json": "application/json",
    };
    return byExtension[extension]!;
  }
  return "application/octet-stream";
}

function pathFromMarkdownUrl(url: string, markdownPath: string): string | undefined {
  if (
    !url ||
    url.startsWith("#") ||
    url.startsWith("/") ||
    url.startsWith("//") ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(url)
  ) {
    return undefined;
  }
  const pathOnly = url.split(/[?#]/u, 1)[0]!;
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathOnly);
  } catch {
    invalidImport();
  }
  if (decoded.includes("\\") || decoded.includes("\0")) invalidImport();
  const resolved = posix.normalize(posix.join(posix.dirname(markdownPath), decoded));
  if (resolved === ".." || resolved.startsWith("../") || posix.isAbsolute(resolved))
    invalidImport();
  return resolved;
}

function rewriteAssetUrls(
  document: NotebookDocument,
  markdownPath: string,
  resourcesByPath: Map<string, ImportResourceManifest>,
): Set<string> {
  const referenced = new Set<string>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    const record = value as Record<string, unknown>;
    if (typeof record.url === "string") {
      const logical =
        /^asset:\/\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/iu.exec(
          record.url,
        );
      if (logical) {
        referenced.add(logical[1]!.toLowerCase());
      } else {
        const path = pathFromMarkdownUrl(record.url, markdownPath);
        const resource = path ? resourcesByPath.get(path) : undefined;
        if (resource) {
          record.url = `asset://${resource.assetId}`;
          referenced.add(resource.assetId);
        }
      }
    }
    for (const [key, child] of Object.entries(record)) {
      if (key !== "url") visit(child);
    }
  };
  visit(document);
  return referenced;
}

function inlineText(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  if (Array.isArray(value)) return value.map(inlineText).join("");
  const record = value as Record<string, unknown>;
  if (
    typeof record.value === "string" &&
    (record.type === "text" || record.type === "inlineCode")
  ) {
    return record.value;
  }
  return inlineText(record.children);
}

function importedTitle(document: NotebookDocument): string {
  const heading = document.children.find((node) => node.type === "heading");
  const raw = heading ? inlineText(heading.children).replace(/\s+/gu, " ").trim() : "";
  const selected = raw || "Imported note";
  const bytes = Buffer.from(selected, "utf8");
  return bytes.byteLength <= 200 ? selected : bytes.subarray(0, 200).toString("utf8");
}

function sourceManifest(row: Import): SourceManifest {
  const source = (row.manifest as { source?: Partial<SourceManifest> }).source;
  if (
    !source ||
    typeof source.sizeBytes !== "number" ||
    !Number.isInteger(source.sizeBytes) ||
    source.sizeBytes < 1 ||
    source.sizeBytes > MAX_ARCHIVE_BYTES ||
    typeof source.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(source.sha256) ||
    typeof source.contentType !== "string"
  ) {
    invalidImport();
  }
  return {
    sizeBytes: source.sizeBytes,
    sha256: source.sha256,
    contentType: source.contentType,
    ...(source.kind === "zip" || source.kind === "markdown" ? { kind: source.kind } : {}),
  };
}

function buildResourceIntents(
  importRow: Import,
  entries: Map<string, Buffer>,
  markdownPath: string,
  maxAssetBytes: number,
): Array<ImportResourceManifest & { body: Buffer }> {
  const resources: Array<ImportResourceManifest & { body: Buffer }> = [];
  for (const [relativePath, body] of [...entries.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (relativePath === markdownPath) continue;
    if (body.byteLength < 1 || body.byteLength > maxAssetBytes) invalidImport();
    const id = deterministicUuid(importRow.id, `resource:${relativePath}`);
    const assetId = deterministicUuid(importRow.id, `asset:${relativePath}`);
    resources.push({
      id,
      assetId,
      objectKey: `workspace/${importRow.workspaceId}/imports/${importRow.id}/resources/${id}`,
      relativePath,
      originalName: safeOriginalName(relativePath),
      mimeType: assetMime(relativePath, body),
      sizeBytes: body.byteLength,
      sha256: createHash("sha256").update(body).digest("hex"),
      body,
    });
  }
  return resources;
}

function parseImportSource(importRow: Import, source: Buffer, maxAssetBytes: number): ParsedImport {
  const declared = sourceManifest(importRow);
  if (
    source.byteLength !== declared.sizeBytes ||
    createHash("sha256").update(source).digest("hex") !== declared.sha256
  ) {
    invalidImport();
  }

  const zip = source.byteLength >= 4 && source.readUInt32LE(0) === 0x04034b50;
  if (declared.kind && declared.kind !== (zip ? "zip" : "markdown")) invalidImport();
  let markdownPath = "note.md";
  let markdownBody = source;
  let entries = new Map<string, Buffer>([[markdownPath, source]]);
  if (zip) {
    entries = extractArchive(source);
    const markdownFiles = [...entries.keys()].filter((path) => /\.(md|markdown)$/iu.test(path));
    if (markdownFiles.length !== 1) invalidImport();
    markdownPath = markdownFiles[0]!;
    markdownBody = entries.get(markdownPath)!;
  }

  const resources = buildResourceIntents(importRow, entries, markdownPath, maxAssetBytes);
  const byPath = new Map(resources.map((resource) => [resource.relativePath, resource]));
  const engine = createDocumentEngine();
  const parsed = engine.parse(decodeMarkdown(markdownBody));
  if (!parsed.ok || parsed.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    invalidImport();
  }
  const referencedAssetIds = rewriteAssetUrls(parsed.document, markdownPath, byPath);
  const markdown = engine.serialize(parsed.document);
  const markdownBytes = Buffer.byteLength(markdown, "utf8");
  if (markdownBytes > MAX_MARKDOWN_BYTES) invalidImport();
  return {
    markdown,
    markdownBytes,
    schemaVersion: parsed.specVersion,
    title: importedTitle(parsed.document),
    resources,
    referencedAssetIds,
  };
}

function publicResource(
  resource: ImportResourceManifest & { body?: Buffer },
): ImportResourceManifest {
  return {
    id: resource.id,
    assetId: resource.assetId,
    objectKey: resource.objectKey,
    relativePath: resource.relativePath,
    originalName: resource.originalName,
    mimeType: resource.mimeType,
    sizeBytes: resource.sizeBytes,
    sha256: resource.sha256,
  };
}

function cleanManifest(
  row: Import,
  parsed: ParsedImport,
  completedResources: number,
  processedResourceBytes: number,
  result?: { noteId: string; revision: number },
): WorkerManifest {
  const source = sourceManifest(row);
  const totalItems = 1 + parsed.resources.length;
  const totalBytes =
    parsed.markdownBytes + parsed.resources.reduce((sum, item) => sum + item.sizeBytes, 0);
  if (totalItems > MAX_ARCHIVE_FILES || totalBytes > MAX_EXPANDED_BYTES) invalidImport();
  return {
    version: 1,
    source,
    progress: {
      completedItems: Math.min(totalItems, 1 + completedResources),
      totalItems,
      processedBytes: Math.min(totalBytes, parsed.markdownBytes + processedResourceBytes),
      totalBytes,
    },
    resources: parsed.resources.map(publicResource),
    ...(result ? { result } : {}),
  };
}

async function declareResources(
  db: Database,
  row: Import,
  parsed: ParsedImport,
  hooks: ImportHandlerHooks,
): Promise<void> {
  await db.transaction(async (tx) => {
    if (parsed.resources.length > 0) {
      await tx
        .insert(importResources)
        .values(
          parsed.resources.map((resource) => ({
            id: resource.id,
            importId: row.id,
            workspaceId: row.workspaceId,
            assetId: resource.assetId,
            objectKey: resource.objectKey,
            state: "declared" as const,
          })),
        )
        .onConflictDoNothing();
    }
    const owned = await tx
      .select()
      .from(importResources)
      .where(
        and(eq(importResources.importId, row.id), eq(importResources.workspaceId, row.workspaceId)),
      );
    const byId = new Map(owned.map((resource) => [resource.id, resource]));
    for (const expected of parsed.resources) {
      const actual = byId.get(expected.id);
      if (
        !actual ||
        actual.assetId !== expected.assetId ||
        actual.objectKey !== expected.objectKey ||
        actual.state === "cleaned"
      ) {
        invalidImport();
      }
    }
    const completed = owned.filter(
      (resource) => resource.state === "uploaded" || resource.state === "promoted",
    );
    const completedIds = new Set(completed.map((resource) => resource.id));
    const completedBytes = parsed.resources
      .filter((resource) => completedIds.has(resource.id))
      .reduce((total, resource) => total + resource.sizeBytes, 0);
    await tx
      .update(imports)
      .set({ manifest: cleanManifest(row, parsed, completed.length, completedBytes) })
      .where(and(eq(imports.id, row.id), eq(imports.workspaceId, row.workspaceId)));
    await hooks.afterResourceDeclaration?.();
  });
}

async function uploadResources(
  db: Database,
  storage: ObjectStoragePort,
  row: Import,
  parsed: ParsedImport,
  hooks: ImportHandlerHooks,
  signal: AbortSignal,
): Promise<void> {
  let completed = 0;
  let completedBytes = 0;
  for (const resource of parsed.resources) {
    checkAborted(signal);
    const [current] = await db
      .select()
      .from(importResources)
      .where(
        and(
          eq(importResources.id, resource.id),
          eq(importResources.importId, row.id),
          eq(importResources.workspaceId, row.workspaceId),
        ),
      )
      .limit(1);
    if (
      !current ||
      current.objectKey !== resource.objectKey ||
      current.assetId !== resource.assetId
    ) {
      invalidImport();
    }
    if (current.state === "cleaned") invalidImport();
    if (current.state === "declared") {
      await storage.put({
        key: resource.objectKey,
        body: resource.body,
        contentType: resource.mimeType,
        contentLength: resource.sizeBytes,
        sha256: resource.sha256,
      });
      await hooks.afterResourcePut?.(resource.id);
      await db
        .update(importResources)
        .set({ state: "uploaded" })
        .where(
          and(
            eq(importResources.id, resource.id),
            eq(importResources.importId, row.id),
            eq(importResources.workspaceId, row.workspaceId),
            eq(importResources.state, "declared"),
          ),
        );
    }
    completed += 1;
    completedBytes += resource.sizeBytes;
    await db
      .update(imports)
      .set({ manifest: cleanManifest(row, parsed, completed, completedBytes) })
      .where(and(eq(imports.id, row.id), eq(imports.workspaceId, row.workspaceId)));
  }
}

async function verifyLiveReferences(
  tx: DbTransaction,
  row: Import,
  parsed: ParsedImport,
): Promise<void> {
  const importedIds = new Set(parsed.resources.map((resource) => resource.assetId));
  const existingIds = [...parsed.referencedAssetIds].filter((id) => !importedIds.has(id));
  if (existingIds.length === 0) return;
  const found = await tx
    .select({ id: assets.id })
    .from(assets)
    .where(
      and(
        eq(assets.workspaceId, row.workspaceId),
        inArray(assets.id, existingIds),
        isNull(assets.deletedAt),
      ),
    );
  if (new Set(found.map((asset) => asset.id)).size !== new Set(existingIds).size) invalidImport();
}

async function finalizeImport(
  deps: Required<Pick<ImportHandlerDeps, "maxAssetBytes" | "workspaceQuotaBytes">> &
    Pick<ImportHandlerDeps, "database" | "hooks">,
  row: Import,
  parsed: ParsedImport,
): Promise<{ noteId: string; revision: number }> {
  const db = deps.database;
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select id from imports where id = ${row.id} and workspace_id = ${row.workspaceId} for update`,
    );
    const [current] = await tx
      .select()
      .from(imports)
      .where(and(eq(imports.id, row.id), eq(imports.workspaceId, row.workspaceId)))
      .limit(1);
    if (!current) invalidImport();
    const priorResult = (current.manifest as { result?: { noteId?: unknown; revision?: unknown } })
      .result;
    if (
      current.status === "completed" &&
      typeof priorResult?.noteId === "string" &&
      typeof priorResult.revision === "number"
    ) {
      return { noteId: priorResult.noteId, revision: priorResult.revision };
    }

    const resources = await tx
      .select()
      .from(importResources)
      .where(
        and(eq(importResources.importId, row.id), eq(importResources.workspaceId, row.workspaceId)),
      );
    if (resources.length !== parsed.resources.length) invalidImport();
    const expectedById = new Map(parsed.resources.map((resource) => [resource.id, resource]));
    for (const resource of resources) {
      const expected = expectedById.get(resource.id);
      if (
        !expected ||
        resource.state !== "uploaded" ||
        resource.objectKey !== expected.objectKey ||
        resource.assetId !== expected.assetId
      ) {
        invalidImport();
      }
    }
    await verifyLiveReferences(tx, row, parsed);

    const [{ currentBytes } = { currentBytes: "0" }] = await tx
      .select({ currentBytes: sum(assets.sizeBytes) })
      .from(assets)
      .where(and(eq(assets.workspaceId, row.workspaceId), isNull(assets.deletedAt)));
    const importedBytes = parsed.resources.reduce(
      (total, resource) => total + resource.sizeBytes,
      0,
    );
    if (Number(currentBytes ?? 0) + importedBytes > deps.workspaceQuotaBytes) invalidImport();

    if (parsed.resources.length > 0) {
      await tx.insert(assets).values(
        parsed.resources.map((resource) => ({
          id: resource.assetId,
          workspaceId: row.workspaceId,
          ownerId: row.actorId,
          objectKey: resource.objectKey,
          originalName: resource.originalName,
          mimeType: resource.mimeType,
          sizeBytes: resource.sizeBytes,
          sha256: resource.sha256,
          thumbnailStatus: "pending" as const,
        })),
      );
    }

    let noteId: string;
    let revision: number;
    if (row.targetNoteId && row.baseRevision) {
      const [target] = await tx
        .select()
        .from(notes)
        .where(
          and(
            eq(notes.id, row.targetNoteId),
            eq(notes.workspaceId, row.workspaceId),
            eq(notes.revision, row.baseRevision),
            isNull(notes.deletedAt),
          ),
        )
        .limit(1);
      if (!target) invalidImport();
      await tx
        .insert(noteVersions)
        .values({
          workspaceId: target.workspaceId,
          noteId: target.id,
          revision: target.revision,
          schemaVersion: target.schemaVersion,
          contentMarkdown: target.contentMarkdown,
          contentHash: target.contentHash,
          reason: "import",
          createdById: row.actorId,
        })
        .onConflictDoNothing();
      const [updated] = await tx
        .update(notes)
        .set({
          contentMarkdown: parsed.markdown,
          contentHash: createHash("sha256").update(parsed.markdown, "utf8").digest("hex"),
          schemaVersion: parsed.schemaVersion,
          revision: row.baseRevision + 1,
        })
        .where(
          and(
            eq(notes.id, target.id),
            eq(notes.workspaceId, row.workspaceId),
            eq(notes.revision, row.baseRevision),
            isNull(notes.deletedAt),
          ),
        )
        .returning({ id: notes.id, revision: notes.revision });
      if (!updated) invalidImport();
      noteId = updated.id;
      revision = updated.revision;
    } else {
      noteId = deterministicUuid(row.id, "note");
      const [created] = await tx
        .insert(notes)
        .values({
          id: noteId,
          workspaceId: row.workspaceId,
          ownerId: row.actorId,
          title: parsed.title,
          contentMarkdown: parsed.markdown,
          contentHash: createHash("sha256").update(parsed.markdown, "utf8").digest("hex"),
          schemaVersion: parsed.schemaVersion,
        })
        .returning({ id: notes.id, revision: notes.revision });
      if (!created) invalidImport();
      revision = created.revision;
      await tx.insert(noteVersions).values({
        workspaceId: row.workspaceId,
        noteId,
        revision,
        schemaVersion: parsed.schemaVersion,
        contentMarkdown: parsed.markdown,
        contentHash: createHash("sha256").update(parsed.markdown, "utf8").digest("hex"),
        reason: "import",
        createdById: row.actorId,
      });
    }

    if (resources.length > 0) {
      await tx
        .update(importResources)
        .set({ state: "promoted" })
        .where(
          and(
            eq(importResources.importId, row.id),
            eq(importResources.workspaceId, row.workspaceId),
          ),
        );
    }
    await new PostgresJobDispatcher(tx).enqueue({
      workspaceId: row.workspaceId,
      type: "search.index",
      payload: { workspaceId: row.workspaceId, noteId, revision, operationId: row.id },
      idempotencyKey: `import-${row.id}-note-${noteId}-revision-${revision}`,
    });
    const result = { noteId, revision };
    const [completed] = await tx
      .update(imports)
      .set({
        status: "completed",
        compensationStatus: "none",
        manifest: cleanManifest(row, parsed, parsed.resources.length, importedBytes, result),
        lastError: null,
      })
      .where(and(eq(imports.id, row.id), eq(imports.workspaceId, row.workspaceId)))
      .returning({ id: imports.id });
    if (!completed) invalidImport();
    await deps.hooks?.beforeFinalizationCommit?.();
    return result;
  });
}

async function loadOwnedImport(db: Database, payload: ImportPayload): Promise<Import | undefined> {
  const [row] = await db.select().from(imports).where(eq(imports.id, payload.importId)).limit(1);
  if (!row) return undefined;
  if (
    row.workspaceId !== payload.workspaceId ||
    row.actorId !== payload.actorId ||
    row.targetNoteId !== (payload.noteId ?? null) ||
    row.baseRevision !== (payload.baseRevision ?? null) ||
    row.sourceObjectKey !== `workspace/${row.workspaceId}/imports/${row.id}/source`
  ) {
    throw new Error("JOB_INVALID: import source mismatch");
  }
  return row;
}

async function markCompensationRequired(
  db: Database,
  row: Import,
  stagingGraceSeconds: number,
  clock: () => number,
  status: "failed" | "expired",
  errorCode: "IMPORT_INVALID" | "JOB_FAILED",
): Promise<void> {
  const now = new Date(clock());
  await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(imports)
      .set({ status, compensationStatus: "required", lastError: errorCode })
      .where(
        and(
          eq(imports.id, row.id),
          eq(imports.workspaceId, row.workspaceId),
          ne(imports.status, "completed"),
          ne(imports.compensationStatus, "completed"),
        ),
      )
      .returning({ id: imports.id });
    if (!updated) return;
    const graceAt = new Date(
      row.createdAt.getTime() + stagingGraceSeconds * MILLISECONDS_PER_SECOND,
    );
    await new PostgresJobDispatcher(tx).enqueue({
      workspaceId: row.workspaceId,
      type: "import.cleanup",
      payload: { workspaceId: row.workspaceId, scope: "one", importId: row.id },
      idempotencyKey: `import-cleanup-${row.id}`,
      runAt: graceAt > now ? graceAt : now,
    });
  });
}

export function createImportHandler(deps: ImportHandlerDeps): JobHandler<"import"> {
  const maxAssetBytes = positiveBoundedInteger(
    deps.maxAssetBytes ?? DEFAULT_ASSET_MAX_BYTES,
    DEFAULT_ASSET_MAX_BYTES,
    "import asset byte limit",
  );
  const workspaceQuotaBytes = positiveBoundedInteger(
    deps.workspaceQuotaBytes ?? DEFAULT_WORKSPACE_QUOTA_BYTES,
    DEFAULT_WORKSPACE_QUOTA_BYTES,
    "import workspace quota",
  );
  const stagingGraceSeconds = positiveBoundedInteger(
    deps.stagingGraceSeconds ?? DEFAULT_STAGING_GRACE_SECONDS,
    31_536_000,
    "import staging grace",
  );
  const clock = deps.clock ?? Date.now;
  const hooks = deps.hooks ?? {};

  return async (job: JobEnvelope<"import">, signal: AbortSignal) => {
    const payload = job.payload;
    const row = await loadOwnedImport(deps.database, payload).catch((error) => {
      if (error instanceof Error && error.message.startsWith("JOB_INVALID")) throw error;
      throw new Error("JOB_FAILED");
    });
    if (!row || row.status === "completed" || row.status === "expired") return;
    if (row.compensationStatus === "running" || row.compensationStatus === "completed") return;

    try {
      checkAborted(signal);
      const now = clock();
      if (!Number.isFinite(now)) throw new Error("JOB_FAILED");
      if (row.expiresAt.getTime() <= now) {
        await markCompensationRequired(
          deps.database,
          row,
          stagingGraceSeconds,
          clock,
          "expired",
          "IMPORT_INVALID",
        );
        return;
      }
      const [claimed] = await deps.database
        .update(imports)
        .set({ status: "processing", compensationStatus: "none", lastError: null })
        .where(
          and(
            eq(imports.id, row.id),
            eq(imports.workspaceId, row.workspaceId),
            inArray(imports.status, ["pending", "processing", "failed"]),
            inArray(imports.compensationStatus, ["none", "required", "failed"]),
          ),
        )
        .returning();
      if (!claimed) return;

      const stream = await deps.storage.get(row.sourceObjectKey);
      const source = await readBoundedStream(stream, MAX_ARCHIVE_BYTES);
      const parsed = parseImportSource(row, source, maxAssetBytes);
      await declareResources(deps.database, row, parsed, hooks);
      await uploadResources(deps.database, deps.storage, row, parsed, hooks, signal);
      checkAborted(signal);
      await hooks.beforeFinalization?.();
      await finalizeImport(
        { database: deps.database, hooks, maxAssetBytes, workspaceQuotaBytes },
        row,
        parsed,
      );
      try {
        await hooks.afterFinalizationCommit?.();
      } catch {
        const [completed] = await deps.database
          .select({ status: imports.status })
          .from(imports)
          .where(and(eq(imports.id, row.id), eq(imports.workspaceId, row.workspaceId)))
          .limit(1);
        if (completed?.status === "completed") return;
        throw new Error("JOB_FAILED");
      }
    } catch (error) {
      const [completed] = await deps.database
        .select({ status: imports.status })
        .from(imports)
        .where(and(eq(imports.id, row.id), eq(imports.workspaceId, row.workspaceId)))
        .limit(1)
        .catch(() => []);
      if (completed?.status === "completed") return;
      const permanent = error instanceof ImportInvalidError;
      await markCompensationRequired(
        deps.database,
        row,
        stagingGraceSeconds,
        clock,
        "failed",
        permanent ? "IMPORT_INVALID" : "JOB_FAILED",
      ).catch(() => undefined);
      if (!permanent) throw new Error("JOB_FAILED");
    }
  };
}

export function isOwnedImportResource(
  row: Pick<ImportResource, "id" | "importId" | "workspaceId" | "objectKey">,
): boolean {
  return (
    row.objectKey === `workspace/${row.workspaceId}/imports/${row.importId}/resources/${row.id}`
  );
}
