export { createDb, type Database } from "./client.js";
export {
  user,
  session,
  account,
  verification,
  userRelations,
  sessionRelations,
  accountRelations,
  workspaceMembers,
  workspaces,
  workspaceMembersRelations,
  workspacesRelations,
  type WorkspaceRole,
} from "./schema/index.js";

export type { InferSelectModel, InferInsertModel } from "drizzle-orm";

import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import type { workspaceMembers, workspaces } from "./schema/index.js";

export type Workspace = InferSelectModel<typeof workspaces>;
export type NewWorkspace = InferInsertModel<typeof workspaces>;
export type WorkspaceMember = InferSelectModel<typeof workspaceMembers>;
export type NewWorkspaceMember = InferInsertModel<typeof workspaceMembers>;
