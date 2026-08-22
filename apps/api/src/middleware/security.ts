import { BlockList, isIP } from "node:net";
import { randomUUID } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { PublicApiError } from "./error-handler.js";
import type { RequestContext } from "./request-context.js";

export const MAX_JSON_BODY_BYTES = 2.25 * 1024 * 1024;

const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);
const requestIdPattern = /^[A-Za-z0-9._:-]{1,128}$/;
const headerNamePattern = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

export interface SecurityVariables {
  requestId: string;
  clientIp: string;
  requestContext: RequestContext;
}

export interface TrustedProxyPolicy {
  readonly forwardedIpHeader: string;
  isTrusted(address: string): boolean;
}

function normalizeIp(value: string) {
  const trimmed = value.trim();
  const unwrapped =
    trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
  const mappedIpv4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(unwrapped)?.[1];
  const normalized = mappedIpv4 ?? unwrapped;
  return isIP(normalized) === 0 ? null : normalized.toLowerCase();
}

export function createTrustedProxyPolicy(
  configuredCidrs: string,
  forwardedIpHeader: string,
): TrustedProxyPolicy {
  const normalizedHeader = forwardedIpHeader.trim().toLowerCase();
  if (!headerNamePattern.test(normalizedHeader)) {
    throw new Error("FORWARDED_IP_HEADER must be a valid HTTP field name");
  }

  const blockList = new BlockList();
  const entries =
    configuredCidrs.trim() === "" ? [] : configuredCidrs.split(",").map((entry) => entry.trim());

  for (const entry of entries) {
    const match = /^(.+?)(?:\/(\d{1,3}))?$/.exec(entry);
    const address = match ? normalizeIp(match[1] ?? "") : null;
    const family = address ? isIP(address) : 0;
    const maximumPrefix = family === 4 ? 32 : family === 6 ? 128 : -1;
    const prefix = match?.[2] === undefined ? maximumPrefix : Number(match[2]);
    if (!address || !Number.isInteger(prefix) || prefix < 0 || prefix > maximumPrefix) {
      throw new Error(`TRUSTED_PROXY_CIDRS contains an invalid entry: ${entry}`);
    }
    blockList.addSubnet(address, prefix, family === 4 ? "ipv4" : "ipv6");
  }

  return {
    forwardedIpHeader: normalizedHeader,
    isTrusted(value) {
      const address = normalizeIp(value);
      if (!address) return false;
      return blockList.check(address, isIP(address) === 4 ? "ipv4" : "ipv6");
    },
  };
}

export function deriveClientIp(directPeer: string, headers: Headers, policy: TrustedProxyPolicy) {
  const directAddress = normalizeIp(directPeer);
  if (!directAddress) return "unknown";
  if (!policy.isTrusted(directAddress)) return directAddress;

  const forwarded = headers.get(policy.forwardedIpHeader);
  if (!forwarded) return directAddress;
  const chain = forwarded.split(",").map(normalizeIp);
  if (chain.length === 0 || chain.some((address) => address === null)) return directAddress;

  let furthestTrustedAddress = directAddress;
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const address = chain[index]!;
    furthestTrustedAddress = address;
    if (!policy.isTrusted(address)) return address;
  }
  return furthestTrustedAddress;
}

export function createClientIpMiddleware(
  policy: TrustedProxyPolicy,
  getDirectPeer: (context: Context) => string | undefined,
): MiddlewareHandler<{ Variables: SecurityVariables }> {
  return async (context, next) => {
    const directPeer = getDirectPeer(context) ?? "unknown";
    context.set("clientIp", deriveClientIp(directPeer, context.req.raw.headers, policy));
    await next();
  };
}

function acceptedRequestId(headers: Headers) {
  const supplied = headers.get("x-request-id");
  return supplied && requestIdPattern.test(supplied) ? supplied : randomUUID();
}

export function createSecurityHeadersMiddleware(): MiddlewareHandler<{
  Variables: SecurityVariables;
}> {
  return async (context, next) => {
    const requestId = acceptedRequestId(context.req.raw.headers);
    context.set("requestId", requestId);
    context.req.raw.headers.set("x-request-id", requestId);
    context.header("x-request-id", requestId);
    context.header(
      "content-security-policy",
      "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    context.header("x-frame-options", "DENY");
    context.header("referrer-policy", "no-referrer");
    context.header("x-content-type-options", "nosniff");
    await next();
  };
}

function contentLength(headers: Headers) {
  const raw = headers.get("content-length");
  if (raw === null) return null;
  if (!/^(?:0|[1-9]\d*)$/.test(raw)) {
    throw new PublicApiError("DOCUMENT_INVALID", 400);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) {
    throw new PublicApiError("DOCUMENT_INVALID", 400);
  }
  return parsed;
}

async function assertRawBodyWithinLimit(request: Request) {
  const declaredLength = contentLength(request.headers);
  if (declaredLength !== null && declaredLength > MAX_JSON_BODY_BYTES) {
    throw new PublicApiError("DOCUMENT_TOO_LARGE", 413);
  }
  if (request.body === null) return;

  const inspectionBody = request.clone().body;
  if (inspectionBody === null) return;
  const reader = inspectionBody.getReader();
  let received = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += chunk.value.byteLength;
      if (received > MAX_JSON_BODY_BYTES) {
        await reader.cancel();
        throw new PublicApiError("DOCUMENT_TOO_LARGE", 413);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function hasJsonContentType(headers: Headers) {
  const value = headers.get("content-type");
  if (!value) return false;
  return value.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

function hasExactOrigin(headers: Headers, webOrigin: URL) {
  const supplied = headers.get("origin");
  if (!supplied || supplied === "null") return false;
  try {
    const parsed = new URL(supplied);
    return supplied === parsed.origin && parsed.origin === webOrigin.origin;
  } catch {
    return false;
  }
}

export function createRawBodyLimitMiddleware(): MiddlewareHandler {
  return async (context, next) => {
    if (!safeMethods.has(context.req.method)) {
      await assertRawBodyWithinLimit(context.req.raw);
    }
    await next();
  };
}

export function createRequestSecurityMiddleware(options: { webOrigin: URL }): MiddlewareHandler {
  return async (context, next) => {
    if (!safeMethods.has(context.req.method)) {
      await assertRawBodyWithinLimit(context.req.raw);
      if (!hasExactOrigin(context.req.raw.headers, options.webOrigin)) {
        throw new PublicApiError("DOCUMENT_INVALID", 403, "The request is not allowed");
      }
      if (context.req.header("sec-fetch-site") === "cross-site") {
        throw new PublicApiError("DOCUMENT_INVALID", 403, "The request is not allowed");
      }
      if (!hasJsonContentType(context.req.raw.headers)) {
        throw new PublicApiError("DOCUMENT_INVALID", 415);
      }
    }
    await next();
  };
}
