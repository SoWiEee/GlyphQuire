import { describe, expect, it } from "vitest";
import { MeClient, MeUnauthorizedError, MeRequestError } from "./MeClient.js";

const validMe = {
  userId: "usr_2N4kQb8fVxErq7wZ",
  personalWorkspaceId: "22222222-2222-4222-8222-222222222222",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("MeClient", () => {
  it("GETs /api/v1/me same-origin with credentials and returns the parsed result", async () => {
    let seenUrl = "";
    let seenInit: RequestInit | undefined;
    const client = new MeClient(async (url, init) => {
      seenUrl = url;
      seenInit = init;
      return jsonResponse(validMe);
    });
    const result = await client.fetchMe();
    expect(result).toEqual(validMe);
    expect(seenUrl).toBe("/api/v1/me");
    expect(seenInit?.method).toBe("GET");
    expect(seenInit?.credentials).toBe("same-origin");
  });

  it("throws MeUnauthorizedError on 404 (no session)", async () => {
    const client = new MeClient(async () => jsonResponse({ code: "NOTE_NOT_FOUND" }, 404));
    await expect(client.fetchMe()).rejects.toBeInstanceOf(MeUnauthorizedError);
  });

  it("throws MeUnauthorizedError on 401", async () => {
    const client = new MeClient(async () => jsonResponse({}, 401));
    await expect(client.fetchMe()).rejects.toBeInstanceOf(MeUnauthorizedError);
  });

  it("throws MeRequestError on 503", async () => {
    const client = new MeClient(async () => jsonResponse({}, 503));
    await expect(client.fetchMe()).rejects.toBeInstanceOf(MeRequestError);
  });

  it("throws MeRequestError when the body fails schema validation", async () => {
    const client = new MeClient(async () => jsonResponse({ userId: "", personalWorkspaceId: "x" }));
    await expect(client.fetchMe()).rejects.toBeInstanceOf(MeRequestError);
  });
});
