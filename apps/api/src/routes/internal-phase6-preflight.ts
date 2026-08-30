import { Hono } from "hono";
import { PublicApiError } from "../middleware/error-handler.js";
import { getRequestContext } from "../middleware/request-context.js";
import type { SecurityVariables } from "../middleware/security.js";
import type { OperatorAuthorizer } from "../modules/search/OperatorAuthorizer.js";

export const PHASE6_PREFLIGHT_PATH = "/internal/phase6/preflight";

export interface Phase6PreflightExpected {
  runtimeRole: string;
  migrationRole: string;
  workerId: string;
  bucket: string;
  imageDigest: string;
  migrationJournalSha: string;
}

export interface Phase6PreflightChecks {
  health: boolean;
  readiness: boolean;
  database: boolean;
  objectStorage: boolean;
  roles: boolean;
  worker: boolean;
  image: boolean;
  migrationJournal: boolean;
}

export type Phase6PreflightProbe = () => Phase6PreflightChecks | Promise<Phase6PreflightChecks>;

export interface Phase6PreflightRouteOptions {
  operatorAuthorizer: OperatorAuthorizer;
  expected: Phase6PreflightExpected;
  probe?: Phase6PreflightProbe;
  /** Optional vault-provided bearer credential for the internal CI probe. */
  probeToken?: string;
  /** Operator identity authorized for the internal CI probe credential. */
  probeOperatorId?: string;
}

export interface Phase6PreflightResponse {
  ok: boolean;
  checks: Phase6PreflightChecks;
  expected: Phase6PreflightExpected;
}

const falseChecks: Phase6PreflightChecks = {
  health: false,
  readiness: false,
  database: false,
  objectStorage: false,
  roles: false,
  worker: false,
  image: false,
  migrationJournal: false,
};

function scrubExpected(expected: Phase6PreflightExpected): Phase6PreflightExpected {
  const role = (value: string) => (/^[a-z_][a-z0-9_]{0,62}$/u.test(value) ? value : "unavailable");
  const worker = (value: string) =>
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value) ? value : "unavailable";
  const bucket = (value: string) =>
    /^[a-z0-9](?:[a-z0-9.-]{1,61}[a-z0-9])?$/u.test(value) ? value : "unavailable";
  const digest = (value: string) => (/^sha256:[a-f0-9]{64}$/u.test(value) ? value : "unavailable");
  const journal = (value: string) => (/^[a-f0-9]{64}$/u.test(value) ? value : "unavailable");

  return {
    runtimeRole: role(expected.runtimeRole),
    migrationRole: role(expected.migrationRole),
    workerId: worker(expected.workerId),
    bucket: bucket(expected.bucket),
    imageDigest: digest(expected.imageDigest),
    migrationJournalSha: journal(expected.migrationJournalSha),
  };
}

function scrubChecks(value: unknown): Phase6PreflightChecks {
  if (!value || typeof value !== "object") return falseChecks;
  const candidate = value as Partial<Record<keyof Phase6PreflightChecks, unknown>>;
  return {
    health: candidate.health === true,
    readiness: candidate.readiness === true,
    database: candidate.database === true,
    objectStorage: candidate.objectStorage === true,
    roles: candidate.roles === true,
    worker: candidate.worker === true,
    image: candidate.image === true,
    migrationJournal: candidate.migrationJournal === true,
  };
}

function checksPass(checks: Phase6PreflightChecks) {
  return Object.values(checks).every((value) => value === true);
}

/**
 * Creates the authenticated, operator-only deployment preflight endpoint.
 * The probe is deliberately injected: providers can check their own database,
 * object-storage, worker, image, and migration-journal adapters without
 * coupling this internal route to a hosting vendor. Only booleans and the
 * validated expected identities cross the HTTP boundary.
 */
export function createPhase6PreflightRoutes(options: Phase6PreflightRouteOptions) {
  const expected = scrubExpected(options.expected);
  const probe: Phase6PreflightProbe = options.probe ?? (() => falseChecks);
  if (options.probeToken !== undefined && !options.probeToken) {
    throw new Error("Phase 6 preflight probe token must not be empty");
  }
  if (options.probeToken !== undefined && !options.probeOperatorId) {
    throw new Error("Phase 6 preflight probe operator is required");
  }

  return new Hono<{ Variables: SecurityVariables }>().get(
    PHASE6_PREFLIGHT_PATH,
    async (context) => {
      if (options.probeToken !== undefined) {
        if (context.req.header("authorization") !== `Bearer ${options.probeToken}`) {
          throw new PublicApiError("NOTE_NOT_FOUND", 404);
        }
        options.operatorAuthorizer.authorize(options.probeOperatorId!);
      } else {
        const requestContext = getRequestContext(context);
        options.operatorAuthorizer.authorize(requestContext.actorId);
      }

      let checks: Phase6PreflightChecks;
      try {
        checks = scrubChecks(await probe());
      } catch {
        throw new PublicApiError("SERVICE_UNAVAILABLE", 503);
      }

      const response: Phase6PreflightResponse = {
        ok: checksPass(checks),
        checks,
        expected,
      };
      return context.json(response, response.ok ? 200 : 503);
    },
  );
}

export const createInternalPhase6PreflightRoutes = createPhase6PreflightRoutes;
