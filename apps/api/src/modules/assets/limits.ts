import { PublicApiError } from "../../middleware/error-handler.js";

/**
 * Allowlisted, non-active-content MIME types accepted for asset upload.
 * Anything not on this list is rejected -- assets never accept types capable
 * of executing as active content when served back to a browser.
 */
export const ALLOWED_ASSET_MIME_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
  "application/zip",
  "application/octet-stream",
]);

const BLOCKED_EXTENSIONS: ReadonlySet<string> = new Set([
  ".svg",
  ".html",
  ".htm",
  ".xhtml",
  ".js",
  ".mjs",
  ".cjs",
]);

interface MagicSignature {
  mime: string;
  matches(body: Buffer): boolean;
}

const MAGIC_SIGNATURES: readonly MagicSignature[] = [
  {
    mime: "image/png",
    matches: (body) => body.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])),
  },
  { mime: "image/jpeg", matches: (body) => body.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) },
  { mime: "image/gif", matches: (body) => body.subarray(0, 4).toString("latin1") === "GIF8" },
  {
    mime: "image/webp",
    matches: (body) =>
      body.subarray(0, 4).toString("latin1") === "RIFF" &&
      body.subarray(8, 12).toString("latin1") === "WEBP",
  },
  { mime: "application/pdf", matches: (body) => body.subarray(0, 4).toString("latin1") === "%PDF" },
];

/** Returns the sniffed MIME type from magic bytes, or null when unrecognized. */
export function sniffMimeType(body: Buffer): string | null {
  for (const signature of MAGIC_SIGNATURES) {
    if (signature.matches(body)) return signature.mime;
  }
  return null;
}

function invalidAsset(): never {
  throw new PublicApiError("ASSET_INVALID", 400);
}

/** Rejects MIME types that are not on the allowlist. */
export function assertAllowedMimeType(mimeType: string): void {
  if (!ALLOWED_ASSET_MIME_TYPES.has(mimeType)) invalidAsset();
}

/**
 * Rejects a declared MIME type that contradicts the asset's actual bytes.
 * Only fires when the bytes sniff to one of the recognized signatures -- an
 * unrecognized binary format is accepted at the declared, allowlisted type.
 */
export function assertNoMimeSpoof(declaredMimeType: string, body: Buffer): void {
  const sniffed = sniffMimeType(body);
  if (sniffed !== null && sniffed !== declaredMimeType) invalidAsset();
}

function isControlCodePoint(codePoint: number): boolean {
  return codePoint < 0x20 || codePoint === 0x7f;
}

/**
 * Normalizes a client-supplied filename into a safe display name: strips any
 * path components and control characters, collapses unsafe characters, and
 * bounds the result to 255 UTF-8 bytes. Never used to derive storage keys --
 * those are always server-generated UUIDs.
 */
export function normalizeFilename(rawName: string): string {
  const base = rawName.split(/[/\\]/u).pop() ?? "";
  const stripped = Array.from(base)
    .filter((char) => !isControlCodePoint(char.codePointAt(0) ?? 0))
    .join("")
    .trim();
  const safe = stripped.replace(/[^A-Za-z0-9._ -]/gu, "_");
  const bounded = Buffer.from(safe, "utf8").subarray(0, 255).toString("utf8");
  const dotIndex = bounded.lastIndexOf(".");
  const extension = dotIndex >= 0 ? bounded.slice(dotIndex).toLowerCase() : "";
  if (extension.length > 0 && BLOCKED_EXTENSIONS.has(extension)) invalidAsset();
  return bounded.length > 0 ? bounded : "file";
}

/** Rejects a declared size outside (0, maxBytes]. */
export function assertWithinMaxBytes(declaredSize: number, maxBytes: number): void {
  if (!Number.isInteger(declaredSize) || declaredSize <= 0 || declaredSize > maxBytes) {
    invalidAsset();
  }
}

/** Rejects an actual byte count that does not match the declared size. */
export function assertActualMatchesDeclared(actualBytes: number, declaredSize: number): void {
  if (actualBytes !== declaredSize) invalidAsset();
}

/** Rejects when adding `sizeBytes` would exceed the workspace's storage quota. */
export function assertWithinWorkspaceQuota(
  currentUsageBytes: number,
  sizeBytes: number,
  quotaBytes: number,
): void {
  if (currentUsageBytes + sizeBytes > quotaBytes) invalidAsset();
}

export function buildOriginalObjectKey(workspaceId: string, assetId: string): string {
  return `workspace/${workspaceId}/assets/${assetId}/original`;
}

export function buildThumbnailObjectKey(workspaceId: string, assetId: string): string {
  return `workspace/${workspaceId}/assets/${assetId}/thumbnail.webp`;
}
