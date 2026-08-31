import { inject, provide, type InjectionKey } from "vue";
import type { WorkbenchAccountAction, WorkbenchSessionFactory } from "./types.js";

export type { WorkbenchAccountAction } from "./types.js";

export interface WorkbenchHostContext {
  readonly sessionFactory?: WorkbenchSessionFactory;
  readonly workspaceId?: string;
  readonly workspaceName?: string;
  readonly accountLabel?: string;
  readonly onAccountAction?: (action: WorkbenchAccountAction) => void;
}

export const WORKBENCH_HOST_CONTEXT: InjectionKey<WorkbenchHostContext> =
  Symbol("gq-workbench-host");

const EMPTY_WORKBENCH_HOST_CONTEXT: WorkbenchHostContext = Object.freeze({});

export function provideWorkbenchHostContext(context: WorkbenchHostContext): void {
  provide(WORKBENCH_HOST_CONTEXT, context);
}

export function useWorkbenchHostContext(): WorkbenchHostContext {
  return inject(WORKBENCH_HOST_CONTEXT, EMPTY_WORKBENCH_HOST_CONTEXT);
}
