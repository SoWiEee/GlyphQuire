import { assetResponseSchema, canonicalUuidSchema } from "@glyphquire/api-contract";

const MAX_ASSET_BYTES = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const ASSET_REFERENCE_PATTERN =
  /^asset:\/\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u;
const CANONICAL_RELATIVE_API_BASE = /^\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/u;
const PASSIVE_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export class AssetResolutionError extends Error {
  constructor() {
    super("Asset image could not be resolved");
    this.name = "AssetResolutionError";
  }
}

export interface ResolvedAssetImage {
  /** A browser-created blob URL; never the persisted asset:// or provider URL. */
  readonly src: string;
  readonly mimeType: string;
  readonly release: () => void;
}

export interface VisualAssetResolver {
  resolve(reference: string): Promise<ResolvedAssetImage>;
}

let activeVisualAssetResolver: VisualAssetResolver | undefined;

/**
 * Registers the resolver for the single active workbench. The disposer is
 * identity-bound so a stale workbench cannot clear a newer workspace seam.
 */
export function registerVisualAssetResolver(resolver: VisualAssetResolver): () => void {
  activeVisualAssetResolver = resolver;
  return () => {
    if (activeVisualAssetResolver === resolver) activeVisualAssetResolver = undefined;
  };
}

export function getActiveVisualAssetResolver(): VisualAssetResolver | undefined {
  return activeVisualAssetResolver;
}

export interface AssetResolverOptions {
  workspaceId: string;
  apiBaseUrl?: string;
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  createObjectURL?: (blob: Blob) => string;
  revokeObjectURL?: (url: string) => void;
  requestTimeoutMs?: number;
}

export function parseAssetReference(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = ASSET_REFERENCE_PATTERN.exec(value);
  if (!match) return null;
  const assetId = match[1]!;
  return canonicalUuidSchema.safeParse(assetId).success ? assetId : null;
}

function parseApiBase(value: unknown): string {
  if (
    typeof value !== "string" ||
    !CANONICAL_RELATIVE_API_BASE.test(value) ||
    value.split("/").some((segment) => segment === "." || segment === "..") ||
    /%(?:2e|2f|5c)/iu.test(value)
  ) {
    throw new AssetResolutionError();
  }
  return value;
}

function canonicalContentType(value: string | null): string | null {
  if (!value) return null;
  const mime = value.split(";", 1)[0]?.trim().toLowerCase();
  return mime && PASSIVE_IMAGE_MIME_TYPES.has(mime) ? mime : null;
}

function safeDownloadUrl(value: string): boolean {
  if (value.length > 2_048) return false;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  const loopback =
    parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "[::1]";
  return (
    (parsed.protocol === "https:" || (parsed.protocol === "http:" && loopback)) &&
    parsed.username === "" &&
    parsed.password === "" &&
    parsed.hash === ""
  );
}

async function boundedBytes(response: Response, expectedSize: number): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    if (!/^(?:0|[1-9]\d*)$/u.test(declared)) throw new AssetResolutionError();
    const parsed = Number(declared);
    if (!Number.isSafeInteger(parsed) || parsed !== expectedSize || parsed > MAX_ASSET_BYTES) {
      throw new AssetResolutionError();
    }
  }
  if (!response.body) throw new AssetResolutionError();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > expectedSize || total > MAX_ASSET_BYTES) {
        await reader.cancel();
        throw new AssetResolutionError();
      }
      chunks.push(next.value);
    }
  } catch (error) {
    if (error instanceof AssetResolutionError) throw error;
    throw new AssetResolutionError();
  }
  if (total !== expectedSize) throw new AssetResolutionError();
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function defaultCreateObjectURL(blob: Blob): string {
  if (typeof URL.createObjectURL !== "function") throw new AssetResolutionError();
  return URL.createObjectURL(blob);
}

function defaultRevokeObjectURL(url: string): void {
  if (typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(url);
}

export function createAssetResolver(options: AssetResolverOptions): VisualAssetResolver {
  const workspace = canonicalUuidSchema.safeParse(options.workspaceId);
  if (!workspace.success) throw new AssetResolutionError();
  const apiBaseUrl = parseApiBase(options.apiBaseUrl ?? "/api/v1");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const createObjectURL = options.createObjectURL ?? defaultCreateObjectURL;
  const revokeObjectURL = options.revokeObjectURL ?? defaultRevokeObjectURL;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 100 || requestTimeoutMs > 30_000) {
    throw new AssetResolutionError();
  }

  async function fetchBounded(input: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = globalThis.setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      return await fetchImpl(input, { ...init, signal: controller.signal });
    } catch {
      throw new AssetResolutionError();
    } finally {
      globalThis.clearTimeout(timeout);
    }
  }

  return {
    async resolve(reference: string): Promise<ResolvedAssetImage> {
      const assetId = parseAssetReference(reference);
      if (!assetId) throw new AssetResolutionError();

      const metadataResponse = await fetchBounded(
        `${apiBaseUrl}/assets/${encodeURIComponent(assetId)}/download`,
        {
          method: "GET",
          credentials: "same-origin",
          redirect: "error",
          cache: "no-store",
          referrerPolicy: "same-origin",
          headers: { accept: "application/json" },
        },
      );
      if (!metadataResponse.ok || !metadataResponse.headers.get("content-type")?.includes("json")) {
        throw new AssetResolutionError();
      }
      let rawMetadata: unknown;
      try {
        rawMetadata = await metadataResponse.json();
      } catch {
        throw new AssetResolutionError();
      }
      const metadata = assetResponseSchema.safeParse(rawMetadata);
      if (
        !metadata.success ||
        metadata.data.id !== assetId ||
        metadata.data.workspaceId !== workspace.data ||
        metadata.data.deletedAt !== null ||
        metadata.data.size > MAX_ASSET_BYTES ||
        !PASSIVE_IMAGE_MIME_TYPES.has(metadata.data.mimeType) ||
        !metadata.data.downloadUrl ||
        !safeDownloadUrl(metadata.data.downloadUrl)
      ) {
        throw new AssetResolutionError();
      }

      const objectResponse = await fetchBounded(metadata.data.downloadUrl, {
        method: "GET",
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        headers: { accept: metadata.data.mimeType },
      });
      const responseMime = canonicalContentType(objectResponse.headers.get("content-type"));
      if (!objectResponse.ok || responseMime !== metadata.data.mimeType) {
        throw new AssetResolutionError();
      }
      const bytes = await boundedBytes(objectResponse, metadata.data.size);
      const src = createObjectURL(new Blob([bytes], { type: responseMime }));
      if (!src.startsWith("blob:")) {
        revokeObjectURL(src);
        throw new AssetResolutionError();
      }
      let released = false;
      return {
        src,
        mimeType: responseMime,
        release() {
          if (released) return;
          released = true;
          revokeObjectURL(src);
        },
      };
    },
  };
}
