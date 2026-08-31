import { randomUUID } from "node:crypto";
import { Hono, type Context } from "../../apps/api/node_modules/hono/dist/index.js";
import { describe, expect, it, vi } from "vitest";
import { createErrorHandler } from "../../apps/api/src/middleware/error-handler.js";
import type { SecurityVariables } from "../../apps/api/src/middleware/security.js";
import type {
  ReleasePreflightChecks,
  ReleasePreflightExpected,
  ReleasePreflightProbe,
} from "../../apps/api/src/routes/internal-release-preflight.js";
import { createReleasePreflightRoutes } from "../../apps/api/src/routes/internal-release-preflight.js";

const baseUrl = "http://localhost:3000";
const actorId = "configured-release-operator";

const expected: ReleasePreflightExpected = {
  runtimeRole: "glyphquire_app",
  migrationRole: "glyphquire_migration",
  workerId: "worker-release-01",
  bucket: "glyphquire-private",
  imageDigest: `sha256:${"a".repeat(64)}`,
  migrationJournalSha: "b".repeat(64),
};

const passingChecks: ReleasePreflightChecks = {
  health: true,
  readiness: true,
  database: true,
  objectStorage: true,
  roles: true,
  worker: true,
  image: true,
  migrationJournal: true,
};

function auth(actor = actorId) {
  return async (context: Context<{ Variables: SecurityVariables }>, next: () => Promise<void>) => {
    context.set("requestId", randomUUID());
    context.set("requestContext", {
      requestId: context.get("requestId"),
      actorId: actor,
      session: {} as never,
    });
    await next();
  };
}

function app(options: {
  authorize?: (actorId: string) => void;
  probe?: ReleasePreflightProbe;
  actor?: string;
  probeToken?: string;
  probeOperatorId?: string;
}) {
  const authorize = vi.fn(options.authorize ?? (() => undefined));
  const probe = options.probe ?? vi.fn().mockResolvedValue(passingChecks);
  const routes = createReleasePreflightRoutes({
    operatorAuthorizer: { authorize },
    expected,
    probe,
    probeToken: options.probeToken,
    probeOperatorId: options.probeOperatorId,
  });
  const instance = new Hono<{ Variables: SecurityVariables }>();
  instance.use("*", auth(options.actor));
  instance.onError(createErrorHandler());
  instance.route("/api", routes);
  return { app: instance, authorize, probe };
}

describe("internal release preflight route", () => {
  it("returns only passing booleans and expected identities to an exact operator", async () => {
    const { app: instance, authorize, probe } = app({});

    const response = await instance.request(`${baseUrl}/api/internal/release/preflight`);

    expect(response.status).toBe(200);
    expect(authorize).toHaveBeenCalledWith(actorId);
    expect(probe).toHaveBeenCalledOnce();
    expect(await response.json()).toEqual({
      ok: true,
      checks: passingChecks,
      expected,
    });
  });

  it("uses one indistinguishable not-found response for non-operators", async () => {
    const {
      app: instance,
      authorize,
      probe,
    } = app({
      authorize: () => {
        throw new Error("operator denied");
      },
      actor: "ordinary-member",
    });

    const response = await instance.request(`${baseUrl}/api/internal/release/preflight`);

    expect(response.status).toBe(503);
    expect(authorize).toHaveBeenCalledWith("ordinary-member");
    expect(probe).not.toHaveBeenCalled();
    expect(await response.json()).toMatchObject({
      error: { code: "SERVICE_UNAVAILABLE", message: "The service is temporarily unavailable" },
    });
  });

  it("accepts only the vault probe bearer and still applies operator authorization", async () => {
    const probeToken = "release-probe-token";
    const { app: instance, authorize } = app({
      probeToken,
      probeOperatorId: actorId,
    });

    const denied = await instance.request(`${baseUrl}/api/internal/release/preflight`, {
      headers: { authorization: "Bearer wrong-token" },
    });
    expect(denied.status).toBe(404);

    const accepted = await instance.request(`${baseUrl}/api/internal/release/preflight`, {
      headers: { authorization: `Bearer ${probeToken}` },
    });
    expect(accepted.status).toBe(200);
    expect(authorize).toHaveBeenCalledWith(actorId);
    expect((await accepted.json()).expected).not.toHaveProperty("probeToken");
  });

  it("fails closed when a preflight check fails and never returns diagnostics", async () => {
    const secretDiagnostic = "postgres://operator:secret@db.internal/glyphquire";
    const { app: instance } = app({
      probe: async () => {
        throw new Error(secretDiagnostic);
      },
    });

    const response = await instance.request(`${baseUrl}/api/internal/release/preflight`);
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(body).not.toContain(secretDiagnostic);
    expect(body).not.toContain("operator");
    expect(body).not.toContain("db.internal");
  });
});
