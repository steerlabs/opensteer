import {
  WorkspaceIdSchema,
  type UserId,
  type WorkspaceId,
  type WorkspaceKind,
} from "@opensteer/core";

export type WorkspaceNamespace = "single-owner" | "owner-scoped" | "team-project";

export function workspacePathSegments(
  workspace: {
    readonly createdBy?: UserId | undefined;
    readonly id: WorkspaceId;
    readonly kind: WorkspaceKind;
    readonly slug?: string | null;
  },
  namespace: WorkspaceNamespace,
): readonly string[] {
  if (namespace === "team-project") {
    if (workspace.kind !== "project") throw new Error("Team storage holds only Projects");
    return ["projects", WorkspaceIdSchema.parse(workspace.id)];
  }
  if (!workspace.createdBy) throw new Error("Legacy Workspace storage requires its creator");
  if (workspace.kind === "project" && workspace.slug) {
    if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(workspace.slug)) {
      throw new Error("Invalid Project folder slug");
    }
    const nested = ["main", "Projects", workspace.slug];
    return namespace === "single-owner" ? nested : [workspace.createdBy, ...nested];
  }
  const leaf = workspace.kind === "main" ? "main" : workspace.id;
  return namespace === "single-owner" ? [leaf] : [workspace.createdBy, leaf];
}
