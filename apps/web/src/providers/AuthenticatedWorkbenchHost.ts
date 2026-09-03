import { canonicalUuidSchema } from "@glyphquire/api-contract";
import { coordinationUserIdSchema } from "../coordination/userIdSchema.js";
import {
  provideWorkbenchHostContext,
  type WorkbenchAccountAction,
  type WorkbenchHostContext,
} from "../components/workbench/WorkbenchContext.js";
import type {
  WorkbenchSessionFactory,
  WorkbenchSessionHandle,
} from "../components/workbench/types.js";

export interface AuthenticatedWorkbenchHostOptions {
  readonly userId?: string;
  readonly workspaceId?: string;
  readonly workspaceName?: string;
  readonly accountLabel?: string;
  readonly sessionFactory?: WorkbenchSessionFactory;
  readonly onAccountAction?: (action: WorkbenchAccountAction) => void;
}

function assertCanonicalIdentity(value: string | undefined, label: string): string {
  if (!value || !canonicalUuidSchema.safeParse(value).success) {
    throw new Error(`Missing or non-canonical authenticated identity: ${label}`);
  }
  return value;
}

/** `userId` is a better-auth user id — opaque text, not a UUID — unlike `workspaceId`. */
function assertOpaqueUserIdentity(value: string | undefined, label: string): string {
  if (!value || !coordinationUserIdSchema.safeParse(value).success) {
    throw new Error(`Missing or invalid authenticated identity: ${label}`);
  }
  return value;
}

/**
 * Bridges a deployment's already-authenticated route into the workbench.
 * Authentication itself is intentionally outside this adapter: callers must
 * provide validated identity and a session factory explicitly.
 */
export function provideAuthenticatedWorkbenchHost(
  options: AuthenticatedWorkbenchHostOptions,
): WorkbenchHostContext {
  const userId = assertOpaqueUserIdentity(options.userId, "userId");
  const workspaceId = assertCanonicalIdentity(options.workspaceId, "workspaceId");
  if (!options.sessionFactory) {
    throw new Error("Authenticated workbench host requires a session factory");
  }

  const sessionFactory = options.sessionFactory;
  const authenticatedSessionFactory: WorkbenchSessionFactory = async (note) => {
    const value = await sessionFactory(note);
    const handle: WorkbenchSessionHandle = "session" in value ? value : { session: value };
    const accountLabel = options.accountLabel ?? handle.context?.accountLabel;
    const workspaceName = options.workspaceName ?? handle.context?.workspaceName;
    return {
      session: handle.session,
      context: {
        userId,
        workspaceId,
        ...(accountLabel === undefined ? {} : { accountLabel }),
        ...(workspaceName === undefined ? {} : { workspaceName }),
      },
    };
  };

  const context: WorkbenchHostContext = {
    sessionFactory: authenticatedSessionFactory,
    workspaceId,
    ...(options.workspaceName === undefined ? {} : { workspaceName: options.workspaceName }),
    ...(options.accountLabel === undefined ? {} : { accountLabel: options.accountLabel }),
    ...(options.onAccountAction === undefined ? {} : { onAccountAction: options.onAccountAction }),
  };

  provideWorkbenchHostContext(context);
  return context;
}

/** Alias kept for route adapters that prefer a verb describing construction. */
export const createAuthenticatedWorkbenchHost = provideAuthenticatedWorkbenchHost;
