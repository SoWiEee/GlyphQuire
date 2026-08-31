import { Hono } from "hono";
import { PublicApiError } from "../middleware/error-handler.js";
import { getRequestContext } from "../middleware/request-context.js";
import type { SecurityVariables } from "../middleware/security.js";
import type { OperatorAuthorizer } from "../modules/search/OperatorAuthorizer.js";

export const RELEASE_PREFLIGHT_PATH = "/internal/release/preflight";

export interface ReleasePreflightExpected {
  runtimeRole: string;
  migrationRole: string;
  workerId: string;
  bucket: string;
  imageDigest: string;
  migrationJournalSha: string;
}

export interface ReleasePreflightChecks {
  health: boolean;
  readiness: boolean;
  database: boolean;
  objectStorage: boolean;
  roles: boolean;
  worker: boolean;
  image: boolean;
  migrationJournal: boolean;
}

export type ReleasePreflightProbe = () => ReleasePreflightChecks | Promise<ReleasePreflightChecks>;

export interface ReleasePreflightRouteOptions {
  operatorAuthorizer: OperatorAuthorizer;
  expected: ReleasePreflightExpected;
  probe?: ReleasePreflightProbe;
  /** Optional vault-provided bearer credential for the internal CI probe. */
  probeToken?: string;
  /** Operator identity authorized for the internal CI probe credential. */
  probeOperatorId?: string;
}

export interface ReleasePreflightResponse {
  ok: boolean;
  checks: ReleasePreflightChecks;
  expected: ReleasePreflightExpected;
}

const falseChecks: ReleasePreflightChecks = {
  health: false,
  readiness: false,
  database: false,
  objectStorage: false,
  roles: false,
  worker: false,
  image: false,
  migrationJournal: false,
};

function scrubExpected(expected: ReleasePreflightExpected): ReleasePreflightExpected {
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

function scrubChecks(value: unknown): ReleasePreflightChecks {
  if (!value || typeof value !== "object") return falseChecks;
  const candidate = value as Partial<Record<keyof ReleasePreflightChecks, unknown>>;
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

function checksPass(checks: ReleasePreflightChecks) {
  return Object.values(checks).every((value) => value === true);
}

/**
 * Creates the authenticated, operator-only deployment preflight endpoint.
 * The probe is deliberately injected: providers can check their own database,
 * object-storage, worker, image, and migration-journal adapters without
 * coupling this internal route to a hosting vendor. Only booleans and the
 * validated expected identities cross the HTTP boundary.
 */
export function createReleasePreflightRoutes(options: ReleasePreflightRouteOptions) {
  const expected = scrubExpected(options.expected);
  const probe: ReleasePreflightProbe = options.probe ?? (() => falseChecks);
  if (options.probeToken !== undefined && !options.probeToken) {
    throw new Error("Release preflight probe token must not be empty");
  }
  if (options.probeToken !== undefined && !options.probeOperatorId) {
    throw new Error("Release preflight probe operator is required");
  }

  return new Hono<{ Variables: SecurityVariables }>().get(
    RELEASE_PREFLIGHT_PATH,
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

      let checks: ReleasePreflightChecks;
      try {
        checks = scrubChecks(await probe());
      } catch {
        throw new PublicApiError("SERVICE_UNAVAILABLE", 503);
      }

      const response: ReleasePreflightResponse = {
        ok: checksPass(checks),
        checks,
        expected,
      };
      return context.json(response, response.ok ? 200 : 503);
    },
  );
}
