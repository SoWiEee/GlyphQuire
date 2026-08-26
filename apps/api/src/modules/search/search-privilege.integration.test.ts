import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PublicApiError } from "../../middleware/error-handler.js";
import { createOperatorAuthorizer } from "./OperatorAuthorizer.js";

/**
 * `OperatorAuthorizer` is deliberately not a workspace-membership check — an
 * owner or editor of a workspace is never implicitly an operator, and there
 * is no membership role that grants it. It is a flat, exact-match allowlist
 * check against the parsed `PHASE5_OPERATOR_IDS` env value, and it must fail
 * closed whenever that allowlist is empty.
 */
describe("OperatorAuthorizer", () => {
  it("allows an exact configured operator id", () => {
    const operatorId = `operator-${randomUUID()}`;
    const authorizer = createOperatorAuthorizer([operatorId]);
    expect(() => authorizer.authorize(operatorId)).not.toThrow();
  });

  it("denies an actor id that is not an exact allowlist member", () => {
    const operatorId = `operator-${randomUUID()}`;
    const otherId = `not-operator-${randomUUID()}`;
    const authorizer = createOperatorAuthorizer([operatorId]);
    expect(() => authorizer.authorize(otherId)).toThrow(PublicApiError);
  });

  it("denies a prefix/substring match against a configured id — the match is exact only", () => {
    const operatorId = `operator-${randomUUID()}`;
    const authorizer = createOperatorAuthorizer([operatorId]);
    expect(() => authorizer.authorize(operatorId.slice(0, -1))).toThrow(PublicApiError);
    expect(() => authorizer.authorize(`${operatorId}-extra`)).toThrow(PublicApiError);
  });

  it("fails closed when the allowlist is empty, denying every actor id including an empty one", () => {
    const authorizer = createOperatorAuthorizer([]);
    expect(() => authorizer.authorize(`someone-${randomUUID()}`)).toThrow(PublicApiError);
    expect(() => authorizer.authorize("")).toThrow(PublicApiError);
  });

  it("denies with the same public error and status on every path, never distinguishing why", () => {
    const operatorId = `operator-${randomUUID()}`;
    const emptyAllowlistAuthorizer = createOperatorAuthorizer([]);
    const configuredAuthorizer = createOperatorAuthorizer([operatorId]);

    const capture = (fn: () => void) => {
      try {
        fn();
      } catch (error) {
        if (error instanceof PublicApiError) return { code: error.code, status: error.status };
        throw error;
      }
      throw new Error("expected authorize() to throw");
    };

    const emptyAllowlistDenial = capture(() =>
      emptyAllowlistAuthorizer.authorize(`someone-${randomUUID()}`),
    );
    const nonMemberDenial = capture(() => configuredAuthorizer.authorize(`stranger-${randomUUID()}`));

    expect(emptyAllowlistDenial).toEqual(nonMemberDenial);
    expect(emptyAllowlistDenial).toEqual({ code: "NOTE_NOT_FOUND", status: 404 });
  });

  it("never includes the attempted actor id in the thrown error", () => {
    const secretActorId = `secret-actor-${randomUUID()}`;
    const authorizer = createOperatorAuthorizer([]);
    try {
      authorizer.authorize(secretActorId);
      throw new Error("expected authorize() to throw");
    } catch (error) {
      if (!(error instanceof PublicApiError)) throw error;
      expect(error.message).not.toContain(secretActorId);
      expect(error.publicMessage).not.toContain(secretActorId);
    }
  });
});
