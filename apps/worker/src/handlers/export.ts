import { createHash } from "node:crypto";
import type { ExportPayload, JobEnvelope } from "@glyphquire/api-contract/jobs";
import { createDocumentEngine } from "@glyphquire/document-engine";
import {
  assets,
  exports,
  notes,
  workspaceMembers,
  type Asset,
  type Database,
  type Export,
} from "@glyphquire/database";
import type { JobHandler } from "@glyphquire/queue";
import type { ObjectStoragePort } from "@glyphquire/storage";
import { and, asc, eq, gt, inArray, isNull, lte } from "drizzle-orm";
import { zipSync } from "fflate";

const MAX_EXPORT_FILES = 256;
const MAX_EXPORT_SOURCE_BYTES = 100 * 1024 * 1024;
const MAX_HTML_SOURCE_BYTES = 25 * 1024 * 1024;
const MAX_EXPORT_ARTIFACT_BYTES = 140 * 1024 * 1024;
const CANONICAL_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const EXPORT_PROCESSING_OWNER_PATTERN =
  /^EXPORT_PROCESSING:([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):([1-9][0-9]*)$/u;
const UUID_ASSET_URI =
  /^asset:\/\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/iu;
const ZIP_EPOCH = new Date("1980-01-01T00:00:00.000Z");
const documentEngine = createDocumentEngine();

interface ExportNote {
  id: string;
  title: string;
  contentMarkdown: string;
  revision: number;
  schemaVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

interface LoadedAsset {
  row: Asset;
  body: Buffer;
}

interface ExportArtifact {
  body: Buffer;
  contentType: string;
}

interface ExportAttemptOwner {
  jobId: string;
  attempt: number;
  token: string;
}

export interface ExportHandlerDeps {
  database: Database;
  storage: ObjectStoragePort;
  clock?: () => number;
}

function expectedObjectKey(row: Pick<Export, "id" | "workspaceId">): string {
  return `workspace/${row.workspaceId}/exports/${row.id}/artifact`;
}

function attemptObjectKey(
  row: Pick<Export, "id" | "workspaceId">,
  owner: ExportAttemptOwner,
): string {
  return `workspace/${row.workspaceId}/exports/${row.id}/attempts/${owner.jobId}/${owner.attempt}`;
}

function exportAttemptOwner(job: JobEnvelope<"export">): ExportAttemptOwner {
  if (
    !CANONICAL_UUID_PATTERN.test(job.id) ||
    !Number.isSafeInteger(job.attempts) ||
    job.attempts < 1
  ) {
    throw new Error("JOB_FAILED");
  }
  return {
    jobId: job.id,
    attempt: job.attempts,
    token: `EXPORT_PROCESSING:${job.id}:${job.attempts}`,
  };
}

function readExportAttemptOwner(value: string | null): ExportAttemptOwner | undefined {
  if (value === null) return undefined;
  const match = EXPORT_PROCESSING_OWNER_PATTERN.exec(value);
  if (!match?.[1] || !match[2]) return undefined;
  const attempt = Number.parseInt(match[2], 10);
  if (!Number.isSafeInteger(attempt)) return undefined;
  return { jobId: match[1], attempt, token: value };
}

function nextUpdatedAt(previous: Date, now: number): Date {
  const next = Math.max(now, previous.getTime() + 1);
  if (!Number.isFinite(next)) throw new Error("JOB_FAILED");
  return new Date(next);
}

function observedExportPredicate(row: Export) {
  return and(
    eq(exports.id, row.id),
    eq(exports.workspaceId, row.workspaceId),
    eq(exports.status, row.status),
    eq(exports.updatedAt, row.updatedAt),
    row.lastError === null ? isNull(exports.lastError) : eq(exports.lastError, row.lastError),
  );
}

function ownedProcessingPredicate(row: Pick<Export, "id" | "workspaceId">, token: string) {
  return and(
    eq(exports.id, row.id),
    eq(exports.workspaceId, row.workspaceId),
    eq(exports.status, "processing"),
    eq(exports.lastError, token),
  );
}

function checkAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("JOB_FAILED");
}

function collectAssetReferences(value: unknown, ids: Set<string>): void {
  if (Array.isArray(value)) {
    for (const child of value) collectAssetReferences(child, ids);
    return;
  }
  if (!value || typeof value !== "object") return;
  const node = value as Record<string, unknown>;
  if (
    (node.type === "link" || node.type === "image" || node.type === "definition") &&
    typeof node.url === "string"
  ) {
    const match = UUID_ASSET_URI.exec(node.url);
    if (match?.[1]) ids.add(match[1].toLowerCase());
  }
  for (const [key, child] of Object.entries(node)) {
    if (key !== "source" && key !== "value" && key !== "url") {
      collectAssetReferences(child, ids);
    }
  }
}

function referencedAssetIds(exportNotes: readonly ExportNote[]): string[] {
  const ids = new Set<string>();
  for (const note of exportNotes) {
    const parsed = documentEngine.parse(note.contentMarkdown);
    if (!parsed.ok) throw new Error("JOB_FAILED");
    collectAssetReferences(parsed.document, ids);
  }
  return [...ids].sort();
}

async function loadNotes(database: Database, row: Export): Promise<ExportNote[]> {
  const conditions = [eq(notes.workspaceId, row.workspaceId), isNull(notes.deletedAt)];
  if (row.scopeType === "note") {
    if (!row.noteId) throw new Error("JOB_FAILED");
    conditions.push(eq(notes.id, row.noteId));
  }
  const rows = await database
    .select({
      id: notes.id,
      title: notes.title,
      contentMarkdown: notes.contentMarkdown,
      revision: notes.revision,
      schemaVersion: notes.schemaVersion,
      createdAt: notes.createdAt,
      updatedAt: notes.updatedAt,
    })
    .from(notes)
    .where(and(...conditions))
    .orderBy(asc(notes.id))
    .limit(MAX_EXPORT_FILES + 1);
  if (rows.length > MAX_EXPORT_FILES || (row.scopeType === "note" && rows.length !== 1)) {
    throw new Error("JOB_FAILED");
  }
  let totalBytes = 0;
  for (const note of rows) {
    totalBytes += Buffer.byteLength(note.contentMarkdown, "utf8");
    if (totalBytes > MAX_EXPORT_SOURCE_BYTES) throw new Error("JOB_FAILED");
  }
  return rows;
}

async function readBoundedAsset(
  storage: ObjectStoragePort,
  asset: Asset,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<Buffer> {
  if (asset.sizeBytes < 1 || asset.sizeBytes > maximumBytes) throw new Error("JOB_FAILED");
  const reader = (await storage.get(asset.objectKey)).getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      checkAborted(signal);
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > asset.sizeBytes || size > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("JOB_FAILED");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  const body = Buffer.concat(chunks);
  if (
    body.byteLength !== asset.sizeBytes ||
    createHash("sha256").update(body).digest("hex") !== asset.sha256
  ) {
    throw new Error("JOB_FAILED");
  }
  return body;
}

async function loadAssets(
  database: Database,
  storage: ObjectStoragePort,
  row: Export,
  exportNotes: readonly ExportNote[],
  signal: AbortSignal,
): Promise<LoadedAsset[]> {
  const ids = referencedAssetIds(exportNotes);
  if (ids.length === 0) return [];
  if (exportNotes.length + ids.length + 1 > MAX_EXPORT_FILES) throw new Error("JOB_FAILED");
  const rows = await database
    .select()
    .from(assets)
    .where(
      and(
        eq(assets.workspaceId, row.workspaceId),
        inArray(assets.id, ids),
        isNull(assets.deletedAt),
      ),
    )
    .orderBy(asc(assets.id));
  if (rows.length !== ids.length) throw new Error("JOB_FAILED");
  const loaded: LoadedAsset[] = [];
  let totalBytes = exportNotes.reduce(
    (total, note) => total + Buffer.byteLength(note.contentMarkdown, "utf8"),
    0,
  );
  for (const asset of rows) {
    const expectedKey = `workspace/${row.workspaceId}/assets/${asset.id}/original`;
    if (asset.objectKey !== expectedKey) throw new Error("JOB_FAILED");
    const body = await readBoundedAsset(
      storage,
      asset,
      MAX_EXPORT_SOURCE_BYTES - totalBytes,
      signal,
    );
    totalBytes += body.byteLength;
    loaded.push({ row: asset, body });
  }
  return loaded;
}

function exportMetadata(
  row: Export,
  exportNotes: readonly ExportNote[],
  loadedAssets: readonly LoadedAsset[],
) {
  return {
    version: 1,
    export: {
      id: row.id,
      workspaceId: row.workspaceId,
      scopeType: row.scopeType,
      noteId: row.noteId,
      format: row.format,
      createdAt: row.createdAt.toISOString(),
    },
    notes: exportNotes.map((note) => ({
      id: note.id,
      title: note.title,
      revision: note.revision,
      schemaVersion: note.schemaVersion,
      createdAt: note.createdAt.toISOString(),
      updatedAt: note.updatedAt.toISOString(),
    })),
    assets: loadedAssets.map(({ row: asset }) => ({
      id: asset.id,
      originalName: asset.originalName,
      mimeType: asset.mimeType,
      sizeBytes: asset.sizeBytes,
      sha256: asset.sha256,
    })),
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderChildren(node: Record<string, unknown>): string {
  return renderSafeNode(node.children);
}

function renderSafeNode(value: unknown): string {
  if (Array.isArray(value)) return value.map(renderSafeNode).join("");
  if (!value || typeof value !== "object") return "";
  const node = value as Record<string, unknown>;
  const type = typeof node.type === "string" ? node.type : "";
  const children = () => renderChildren(node);
  const source = () =>
    typeof node.source === "string"
      ? node.source
      : typeof node.value === "string"
        ? node.value
        : "";

  switch (type) {
    case "text":
      return escapeHtml(typeof node.value === "string" ? node.value : "");
    case "paragraph":
      return `<p>${children()}</p>`;
    case "heading": {
      const depth =
        typeof node.depth === "number" &&
        Number.isInteger(node.depth) &&
        node.depth >= 1 &&
        node.depth <= 6
          ? node.depth
          : 2;
      return `<h${depth}>${children()}</h${depth}>`;
    }
    case "emphasis":
      return `<em>${children()}</em>`;
    case "strong":
      return `<strong>${children()}</strong>`;
    case "delete":
      return `<del>${children()}</del>`;
    case "inlineCode":
      return `<code>${escapeHtml(source())}</code>`;
    case "break":
      return "<br>";
    case "link":
    case "linkReference":
      return `<span>${children()}</span>`;
    case "image":
    case "imageReference": {
      const alt = typeof node.alt === "string" ? node.alt : "image";
      const match = typeof node.url === "string" ? UUID_ASSET_URI.exec(node.url) : null;
      return match?.[1]
        ? `<span data-asset-id="${match[1].toLowerCase()}">${escapeHtml(alt)}</span>`
        : `<span>${escapeHtml(alt)}</span>`;
    }
    case "quote":
    case "blockquote":
      return `<blockquote>${children()}</blockquote>`;
    case "list": {
      const tag = node.ordered === true ? "ol" : "ul";
      return `<${tag}>${children()}</${tag}>`;
    }
    case "listItem":
      return `<li>${children()}</li>`;
    case "code":
      return `<pre><code>${escapeHtml(source())}</code></pre>`;
    case "table":
      return `<table><tbody>${children()}</tbody></table>`;
    case "tableRow":
      return `<tr>${children()}</tr>`;
    case "tableCell":
      return `<td>${children()}</td>`;
    case "thematicBreak":
      return "<hr>";
    case "footnoteDefinition":
      return `<aside>${children()}</aside>`;
    case "footnoteReference":
      return `<sup>${escapeHtml(typeof node.label === "string" ? node.label : "footnote")}</sup>`;
    case "definition":
      return "";
    case "callout":
    case "sticky":
    case "tab":
    case "column":
      return `<section>${children()}</section>`;
    case "toggle": {
      const props =
        node.props && typeof node.props === "object"
          ? (node.props as Record<string, unknown>)
          : undefined;
      const title = typeof props?.title === "string" ? props.title : "Details";
      return `<details${props?.open === true ? " open" : ""}><summary>${escapeHtml(title)}</summary>${children()}</details>`;
    }
    case "tabs":
    case "columns":
      return `<div>${children()}</div>`;
    case "runtime":
      return `<pre><code>${escapeHtml(source())}</code></pre>`;
    case "unknown-directive":
    case "invalid-block":
      return source() ? `<pre>${escapeHtml(source())}</pre>` : `<section>${children()}</section>`;
    default:
      return children();
  }
}

function renderCanonicalMarkdown(markdown: string): string {
  const parsed = documentEngine.parse(markdown);
  if (!parsed.ok) throw new Error("JOB_FAILED");
  return renderSafeNode(parsed.document.children);
}

function buildInertHtml(
  row: Export,
  exportNotes: readonly ExportNote[],
  loadedAssets: readonly LoadedAsset[],
): Buffer {
  const title = exportNotes.length === 1 ? exportNotes[0]!.title : "GlyphQuire workspace export";
  const renderedNotes = exportNotes
    .map(
      (note) =>
        `<article data-note-id="${note.id}"><h1>${escapeHtml(note.title)}</h1>` +
        `${renderCanonicalMarkdown(note.contentMarkdown)}</article>`,
    )
    .join("");
  const embeddedAssets = loadedAssets
    .map(
      ({ row: asset, body }) =>
        `<details data-asset-id="${asset.id}"><summary>${escapeHtml(asset.originalName)} ` +
        `(${escapeHtml(asset.mimeType)}, ${asset.sizeBytes} bytes)</summary>` +
        `<pre data-encoding="base64">${body.toString("base64")}</pre></details>`,
    )
    .join("");
  return Buffer.from(
    '<!doctype html><html><head><meta charset="utf-8">' +
      '<meta http-equiv="Content-Security-Policy" ' +
      "content=\"default-src 'none'; base-uri 'none'; form-action 'none'\">" +
      `<meta name="glyphquire-export-id" content="${row.id}">` +
      `<title>${escapeHtml(title)}</title></head><body>${renderedNotes}` +
      `<section aria-label="Embedded assets">${embeddedAssets}</section></body></html>`,
    "utf8",
  );
}

function buildArtifact(
  row: Export,
  exportNotes: readonly ExportNote[],
  loadedAssets: readonly LoadedAsset[],
): ExportArtifact {
  if (row.format === "markdown") {
    const separator = Buffer.from("\n\n", "utf8");
    return {
      body:
        exportNotes.length === 1
          ? Buffer.from(exportNotes[0]!.contentMarkdown, "utf8")
          : Buffer.concat(
              exportNotes.flatMap((note, index) => [
                ...(index === 0 ? [] : [separator]),
                Buffer.from(note.contentMarkdown, "utf8"),
              ]),
            ),
      contentType: "text/markdown; charset=utf-8",
    };
  }
  if (row.format === "zip") {
    if (exportNotes.length + loadedAssets.length + 1 > MAX_EXPORT_FILES) {
      throw new Error("JOB_FAILED");
    }
    const entries: Record<string, Uint8Array> = {
      "metadata.json": Buffer.from(
        `${JSON.stringify(exportMetadata(row, exportNotes, loadedAssets), null, 2)}\n`,
        "utf8",
      ),
    };
    for (const note of exportNotes) {
      entries[`notes/${note.id}.md`] = Buffer.from(note.contentMarkdown, "utf8");
    }
    for (const asset of loadedAssets) {
      entries[`assets/${asset.row.id}/original`] = asset.body;
    }
    return {
      body: Buffer.from(zipSync(entries, { level: 6, mtime: ZIP_EPOCH })),
      contentType: "application/zip",
    };
  }
  if (row.format === "html") {
    const sourceBytes =
      exportNotes.reduce(
        (total, note) => total + Buffer.byteLength(note.contentMarkdown, "utf8"),
        0,
      ) + loadedAssets.reduce((total, asset) => total + asset.body.byteLength, 0);
    if (sourceBytes > MAX_HTML_SOURCE_BYTES) throw new Error("JOB_FAILED");
    return {
      body: buildInertHtml(row, exportNotes, loadedAssets),
      contentType: "text/html; charset=utf-8",
    };
  }
  throw new Error("JOB_FAILED");
}

function mayClaimExport(row: Export, owner: ExportAttemptOwner): boolean {
  if (row.status === "pending" || row.status === "failed") return true;
  if (row.status !== "processing") return false;
  if (row.lastError === null) return true;
  const previous = readExportAttemptOwner(row.lastError);
  return (
    previous !== undefined && previous.jobId === owner.jobId && previous.attempt < owner.attempt
  );
}

async function claimExport(
  database: Database,
  row: Export,
  owner: ExportAttemptOwner,
  now: number,
): Promise<Export | undefined> {
  return database.transaction(async (transaction) => {
    const [current] = await transaction
      .select()
      .from(exports)
      .where(and(eq(exports.id, row.id), eq(exports.workspaceId, row.workspaceId)))
      .limit(1)
      .for("update");
    if (!current || current.status === "completed" || current.status === "expired") {
      return undefined;
    }
    if (current.objectKey !== expectedObjectKey(current)) throw new Error("JOB_FAILED");
    if (current.expiresAt.getTime() <= now) {
      await transaction
        .update(exports)
        .set({
          status: "expired",
          lastError: null,
          updatedAt: nextUpdatedAt(current.updatedAt, now),
        })
        .where(and(observedExportPredicate(current), lte(exports.expiresAt, new Date(now))));
      return undefined;
    }
    if (!mayClaimExport(current, owner)) return undefined;
    const [claimed] = await transaction
      .update(exports)
      .set({
        status: "processing",
        lastError: owner.token,
        updatedAt: nextUpdatedAt(current.updatedAt, now),
      })
      .where(and(observedExportPredicate(current), gt(exports.expiresAt, new Date(now))))
      .returning();
    return claimed;
  });
}

async function expireObservedExport(database: Database, row: Export, now: number): Promise<void> {
  await database
    .update(exports)
    .set({
      status: "expired",
      lastError: null,
      updatedAt: nextUpdatedAt(row.updatedAt, now),
    })
    .where(and(observedExportPredicate(row), lte(exports.expiresAt, new Date(now))));
}

async function markFailed(
  database: Database,
  row: Export,
  owner: ExportAttemptOwner,
  failedAt: number,
): Promise<void> {
  await database
    .update(exports)
    .set({
      status: "failed",
      lastError: "JOB_FAILED",
      updatedAt: nextUpdatedAt(row.updatedAt, failedAt),
    })
    .where(ownedProcessingPredicate(row, owner.token))
    .catch(() => undefined);
}

async function publishArtifact(
  deps: ExportHandlerDeps,
  claimed: Export,
  owner: ExportAttemptOwner,
  artifact: ExportArtifact,
  signal: AbortSignal,
  clock: () => number,
): Promise<void> {
  await deps.database.transaction(async (transaction) => {
    const [current] = await transaction
      .select()
      .from(exports)
      .where(and(eq(exports.id, claimed.id), eq(exports.workspaceId, claimed.workspaceId)))
      .limit(1)
      .for("update");
    if (!current || current.status !== "processing" || current.lastError !== owner.token) {
      return;
    }
    if (current.objectKey !== expectedObjectKey(current)) throw new Error("JOB_FAILED");
    checkAborted(signal);
    const beforePutAt = clock();
    if (!Number.isFinite(beforePutAt)) throw new Error("JOB_FAILED");
    if (current.expiresAt.getTime() <= beforePutAt) {
      await transaction
        .update(exports)
        .set({
          status: "expired",
          lastError: null,
          updatedAt: nextUpdatedAt(current.updatedAt, beforePutAt),
        })
        .where(ownedProcessingPredicate(current, owner.token));
      return;
    }
    await deps.storage.put({
      key: expectedObjectKey(current),
      body: artifact.body,
      contentType: artifact.contentType,
      contentLength: artifact.body.byteLength,
      sha256: createHash("sha256").update(artifact.body).digest("hex"),
    });
    checkAborted(signal);
    const completedAt = clock();
    if (!Number.isFinite(completedAt)) throw new Error("JOB_FAILED");
    if (current.expiresAt.getTime() <= completedAt) {
      await transaction
        .update(exports)
        .set({
          status: "expired",
          lastError: null,
          updatedAt: nextUpdatedAt(current.updatedAt, completedAt),
        })
        .where(ownedProcessingPredicate(current, owner.token));
      return;
    }
    const [completed] = await transaction
      .update(exports)
      .set({
        status: "completed",
        lastError: null,
        updatedAt: nextUpdatedAt(current.updatedAt, completedAt),
      })
      .where(
        and(
          ownedProcessingPredicate(current, owner.token),
          gt(exports.expiresAt, new Date(completedAt)),
        ),
      )
      .returning({ id: exports.id });
    if (!completed) throw new Error("JOB_FAILED");
  });
}

export function createExportHandler(deps: ExportHandlerDeps): JobHandler<"export"> {
  const clock = deps.clock ?? Date.now;

  return async (job: JobEnvelope<"export">, signal: AbortSignal) => {
    const payload: ExportPayload = job.payload;
    const [row] = await deps.database
      .select()
      .from(exports)
      .where(eq(exports.id, payload.exportId))
      .limit(1)
      .catch(() => {
        throw new Error("JOB_FAILED");
      });
    if (!row) return;
    if (
      row.workspaceId !== payload.workspaceId ||
      job.workspaceId !== payload.workspaceId ||
      row.objectKey !== expectedObjectKey(row)
    ) {
      throw new Error("JOB_INVALID: export source mismatch");
    }
    if (row.status === "completed" || row.status === "expired") return;

    const now = clock();
    if (!Number.isFinite(now)) throw new Error("JOB_FAILED");
    if (row.expiresAt.getTime() <= now) {
      await expireObservedExport(deps.database, row, now).catch(() => {
        throw new Error("JOB_FAILED");
      });
      return;
    }

    const owner = exportAttemptOwner(job);
    let claimed: Export | undefined;
    let candidateKey: string | undefined;
    try {
      checkAborted(signal);
      const [member] = await deps.database
        .select({ workspaceId: workspaceMembers.workspaceId })
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, row.workspaceId),
            eq(workspaceMembers.userId, row.requesterId),
          ),
        )
        .limit(1);
      if (!member) throw new Error("JOB_FAILED");
      claimed = await claimExport(deps.database, row, owner, now);
      if (!claimed) {
        return;
      }
      const exportNotes = await loadNotes(deps.database, claimed);
      const loadedAssets = await loadAssets(
        deps.database,
        deps.storage,
        claimed,
        exportNotes,
        signal,
      );
      const artifact = buildArtifact(claimed, exportNotes, loadedAssets);
      if (artifact.body.byteLength > MAX_EXPORT_ARTIFACT_BYTES) throw new Error("JOB_FAILED");
      checkAborted(signal);
      candidateKey = attemptObjectKey(claimed, owner);
      await deps.storage.put({
        key: candidateKey,
        body: artifact.body,
        contentType: artifact.contentType,
        contentLength: artifact.body.byteLength,
        sha256: createHash("sha256").update(artifact.body).digest("hex"),
      });
      checkAborted(signal);
      await publishArtifact(deps, claimed, owner, artifact, signal, clock);
    } catch {
      if (claimed) await markFailed(deps.database, claimed, owner, now);
      throw new Error("JOB_FAILED");
    } finally {
      if (candidateKey) await deps.storage.delete(candidateKey).catch(() => undefined);
    }
  };
}
