import { describe, expect, it, vi } from "vitest";
import {
  Phase5ApiError,
  Phase5Client,
  Phase5ClientConfigurationError,
  Phase5OfflineError,
  Phase5ValidationError,
} from "./Phase5Client.js";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const NOTE_ID = "22222222-2222-4222-8222-222222222222";
const ASSET_ID = "33333333-3333-4333-8333-333333333333";
const IMPORT_ID = "44444444-4444-4444-8444-444444444444";
const EXPORT_ID = "55555555-5555-4555-8555-555555555555";
const SHARE_ID = "66666666-6666-4666-8666-666666666666";
const REQUEST_ID = "77777777-7777-4777-8777-777777777777";
const IDEMPOTENCY_KEY = "phase5-test-key";
const NOW = "2026-08-30T00:00:00.000Z";

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function options(fetchImpl: typeof fetch) {
  return {
    fetchImpl,
    requestIdFactory: () => REQUEST_ID,
    idempotencyKeyFactory: () => IDEMPOTENCY_KEY,
  };
}

function assetResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: ASSET_ID,
    workspaceId: WORKSPACE_ID,
    originalName: "diagram.png",
    mimeType: "image/png",
    size: 8,
    sha256: "a".repeat(64),
    createdAt: NOW,
    deletedAt: null,
    thumbnailStatus: "pending",
    ...overrides,
  };
}

function importResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: IMPORT_ID,
    workspaceId: WORKSPACE_ID,
    status: "pending",
    progress: { completedItems: 0, totalItems: 1, processedBytes: 0, totalBytes: 12 },
    ...overrides,
  };
}

function exportResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: EXPORT_ID,
    workspaceId: WORKSPACE_ID,
    status: "pending",
    format: "zip",
    scope: { type: "workspace", workspaceId: WORKSPACE_ID },
    createdAt: NOW,
    expiresAt: "2026-09-29T00:00:00.000Z",
    ...overrides,
  };
}

describe("Phase5Client request and response boundary", () => {
  it("uploads through a root-relative same-origin URL with bounded request headers", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(assetResponse(), 201));
    const client = new Phase5Client(options(fetchImpl));
    const file = new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], "diagram.png", {
      type: "image/png",
    });

    await expect(client.uploadAsset({ workspaceId: WORKSPACE_ID, file })).resolves.toMatchObject({
      id: ASSET_ID,
      workspaceId: WORKSPACE_ID,
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(`/api/v1/workspaces/${WORKSPACE_ID}/assets`);
    expect(init).toMatchObject({
      method: "POST",
      credentials: "same-origin",
      redirect: "error",
      cache: "no-store",
      referrerPolicy: "same-origin",
    });
    const headers = new Headers(init?.headers);
    expect(headers.get("x-request-id")).toBe(REQUEST_ID);
    expect(headers.get("idempotency-key")).toBe(IDEMPOTENCY_KEY);
    expect(headers.has("authorization")).toBe(false);
    expect(headers.has("content-type")).toBe(false);
    const body = init?.body;
    expect(body).toBeInstanceOf(FormData);
    if (!(body instanceof FormData)) throw new Error("Expected multipart request body");
    expect(body.get("file")).toBe(file);
  });

  it("validates search input and rejects cross-workspace response identities", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        items: [
          {
            noteId: NOTE_ID,
            workspaceId: "88888888-8888-4888-8888-888888888888",
            revision: 1,
            title: "Wrong workspace",
            snippet: "inert text",
            updatedAt: NOW,
          },
        ],
        nextCursor: null,
      }),
    );
    const client = new Phase5Client(options(fetchImpl));

    await expect(
      client.search({ workspaceId: WORKSPACE_ID, q: "needle", pageSize: 20 }),
    ).rejects.toBeInstanceOf(Phase5ValidationError);
    await expect(
      client.search({ workspaceId: "not-a-uuid", q: "needle", pageSize: 20 }),
    ).rejects.toBeInstanceOf(Phase5ValidationError);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      `/api/v1/search?workspaceId=${WORKSPACE_ID}&q=needle&pageSize=20&ranking=relevance`,
    );
  });

  it("starts and polls imports using validated logical identifiers only", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(importResponse({ noteId: NOTE_ID }), 202))
      .mockResolvedValueOnce(
        jsonResponse(importResponse({ status: "completed", noteId: NOTE_ID })),
      );
    const client = new Phase5Client(options(fetchImpl));
    const file = new File(["# Imported"], "note.md", { type: "text/markdown" });

    await client.startImport({
      workspaceId: WORKSPACE_ID,
      file,
      noteId: NOTE_ID,
      baseRevision: 3,
    });
    await expect(client.getImport(IMPORT_ID)).resolves.toMatchObject({
      status: "completed",
      noteId: NOTE_ID,
    });

    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      `/api/v1/workspaces/${WORKSPACE_ID}/import`,
      `/api/v1/imports/${IMPORT_ID}`,
    ]);
    const form = fetchImpl.mock.calls[0]?.[1]?.body as FormData;
    expect(form.get("file")).toBe(file);
    expect(form.get("noteId")).toBe(NOTE_ID);
    expect(form.get("baseRevision")).toBe("3");
  });

  it("rejects an existing-note import response that loses its target identity", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(importResponse(), 202));
    const client = new Phase5Client(options(fetchImpl));
    const file = new File(["# Imported"], "note.md", { type: "text/markdown" });

    await expect(
      client.startImport({
        workspaceId: WORKSPACE_ID,
        file,
        noteId: NOTE_ID,
        baseRevision: 3,
      }),
    ).rejects.toBeInstanceOf(Phase5ValidationError);
  });

  it("starts workspace and note exports and obtains a validated download projection", async () => {
    const downloadUrl = "https://objects.example/export?signature=opaque";
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(exportResponse(), 202))
      .mockResolvedValueOnce(
        jsonResponse(
          exportResponse({
            status: "completed",
            downloadUrl,
          }),
        ),
      );
    const client = new Phase5Client(options(fetchImpl));

    await client.startExport({
      scope: { type: "workspace", workspaceId: WORKSPACE_ID },
      format: "zip",
    });
    await expect(client.getExport(EXPORT_ID, { download: true })).resolves.toMatchObject({
      id: EXPORT_ID,
      downloadUrl,
    });

    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      `/api/v1/workspaces/${WORKSPACE_ID}/export`,
      `/api/v1/exports/${EXPORT_ID}/download`,
    ]);
    expect(await new Request("http://local", fetchImpl.mock.calls[0]?.[1]).json()).toEqual({
      format: "zip",
    });
  });

  it("rejects a note export response whose workspace identity does not match", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        exportResponse({
          workspaceId: "88888888-8888-4888-8888-888888888888",
          scope: {
            type: "note",
            workspaceId: "88888888-8888-4888-8888-888888888888",
            noteId: NOTE_ID,
          },
        }),
        202,
      ),
    );
    const client = new Phase5Client(options(fetchImpl));

    await expect(
      client.startExport({
        scope: { type: "note", workspaceId: WORKSPACE_ID, noteId: NOTE_ID },
        format: "markdown",
      }),
    ).rejects.toBeInstanceOf(Phase5ValidationError);
  });

  it("binds share response identity and same-origin public URL to its note and token", async () => {
    const token = "A".repeat(43);
    const shareUrl = `${globalThis.location.origin}/api/v1/shared/${token}`;
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        {
          id: SHARE_ID,
          workspaceId: WORKSPACE_ID,
          noteId: NOTE_ID,
          token,
          url: shareUrl,
          expiresAt: null,
          createdAt: NOW,
        },
        201,
      ),
    );
    const client = new Phase5Client(options(fetchImpl));

    await expect(client.createShareLink(NOTE_ID, {})).resolves.toMatchObject({
      id: SHARE_ID,
      noteId: NOTE_ID,
      url: shareUrl,
    });
  });

  it("revokes only canonical link ids and accepts exactly an empty 204 response", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const client = new Phase5Client(options(fetchImpl));

    await expect(client.revokeShareLink(SHARE_ID)).resolves.toBeUndefined();
    await expect(client.revokeShareLink("not-an-id")).rejects.toBeInstanceOf(Phase5ValidationError);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(`/api/v1/share-links/${SHARE_ID}`);
  });

  it("maps a shared error envelope without retaining provider or Markdown details", async () => {
    const providerSecret = "s3://bucket/private.md token=VERY_SECRET markdown=# private";
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        {
          error: {
            code: "ASSET_INVALID",
            message: providerSecret,
            requestId: REQUEST_ID,
          },
        },
        403,
      ),
    );
    const client = new Phase5Client(options(fetchImpl));

    const rejection = await client
      .uploadAsset({
        workspaceId: WORKSPACE_ID,
        file: new File(["x"], "x.txt", { type: "text/plain" }),
      })
      .catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(Phase5ApiError);
    expect(rejection).toMatchObject({ code: "ASSET_INVALID", status: 403, requestId: REQUEST_ID });
    expect(String(rejection)).not.toContain(providerSecret);
    expect(JSON.stringify(rejection)).not.toContain(providerSecret);
  });

  it("maps network failures to one stable public offline error without echoing the cause", async () => {
    const secretCause = new Error("DNS failed for secret.internal?token=TOP_SECRET");
    const client = new Phase5Client(
      options(
        vi.fn(async () => {
          throw secretCause;
        }),
      ),
    );

    const rejection = await client.getImport(IMPORT_ID).catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(Phase5OfflineError);
    expect(String(rejection)).toBe("Phase5OfflineError: Phase 5 request could not be completed");
    expect(JSON.stringify(rejection)).not.toContain("TOP_SECRET");
  });

  it("rejects malformed success payloads rather than returning unvalidated data", async () => {
    const client = new Phase5Client(
      options(vi.fn(async () => jsonResponse(assetResponse({ objectKey: "private/key" }), 201))),
    );

    await expect(
      client.uploadAsset({
        workspaceId: WORKSPACE_ID,
        file: new File(["x"], "x.png", { type: "image/png" }),
      }),
    ).rejects.toBeInstanceOf(Phase5ValidationError);
  });

  it.each([
    "https://evil.example/api/v1",
    "//evil.example/api/v1",
    "/api/../v1",
    "/api/%2e%2e/v1",
    "/api\\v1",
  ])("rejects a client base that can escape same origin: %s", (baseUrl) => {
    expect(() => new Phase5Client({ baseUrl })).toThrow(Phase5ClientConfigurationError);
  });
});
