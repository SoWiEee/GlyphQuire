import {
  workspaceMembers,
  workspaces,
  type Database,
  type WorkspaceRole,
} from "@glyphquire/database";

export type WorkspaceSummary = {
  id: string;
  name: "Personal";
  role: "owner";
};

export interface PersonalWorkspaceProvisioner {
  ensurePersonalWorkspace(actorId: string): Promise<WorkspaceSummary>;
}

interface WorkspaceServiceOptions {
  afterWorkspaceInserted?(workspaceId: string): void | Promise<void>;
}

export class WorkspaceService implements PersonalWorkspaceProvisioner {
  constructor(
    private readonly db: Database,
    private readonly options: WorkspaceServiceOptions = {},
  ) {}

  async ensurePersonalWorkspace(actorId: string): Promise<WorkspaceSummary> {
    return this.db.transaction(async (tx) => {
      const [createdWorkspace] = await tx
        .insert(workspaces)
        .values({ name: "Personal", personalOwnerId: actorId })
        .onConflictDoNothing({ target: workspaces.personalOwnerId })
        .returning({ id: workspaces.id, name: workspaces.name });

      const workspace =
        createdWorkspace ??
        (await tx.query.workspaces.findFirst({
          columns: { id: true, name: true },
          where: (table, { eq }) => eq(table.personalOwnerId, actorId),
        }));

      if (!workspace || workspace.name !== "Personal") {
        throw new Error("Personal workspace invariant violated");
      }

      if (createdWorkspace) {
        await this.options.afterWorkspaceInserted?.(workspace.id);
      }

      await tx
        .insert(workspaceMembers)
        .values({
          workspaceId: workspace.id,
          userId: actorId,
          role: "owner",
        })
        .onConflictDoUpdate({
          target: [workspaceMembers.workspaceId, workspaceMembers.userId],
          set: { role: "owner" satisfies WorkspaceRole, updatedAt: new Date() },
        });

      const membership = await tx.query.workspaceMembers.findFirst({
        columns: { role: true },
        where: (table, { and, eq }) =>
          and(eq(table.workspaceId, workspace.id), eq(table.userId, actorId)),
      });

      if (membership?.role !== "owner") {
        throw new Error("Personal workspace owner membership invariant violated");
      }

      return { id: workspace.id, name: "Personal", role: "owner" };
    });
  }
}
