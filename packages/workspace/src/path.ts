import type { UserId, WorkspaceId, WorkspaceKind } from "@opensteer/core";

export type WorkspaceNamespace = "single-owner" | "owner-scoped";

export function workspacePathSegments(
  workspace: {
    readonly createdBy: UserId;
    readonly id: WorkspaceId;
    readonly kind: WorkspaceKind;
    readonly slug?: string | null;
  },
  namespace: WorkspaceNamespace,
): readonly string[] {
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
