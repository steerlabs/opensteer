import type { UserId, WorkspaceId, WorkspaceKind } from "@opensteer/core";

export type WorkspaceNamespace = "single-owner" | "owner-scoped";

export function workspacePathSegments(
  workspace: {
    readonly createdBy: UserId;
    readonly id: WorkspaceId;
    readonly kind: WorkspaceKind;
  },
  namespace: WorkspaceNamespace,
): readonly string[] {
  const leaf = workspace.kind === "main" ? "main" : workspace.id;
  return namespace === "single-owner" ? [leaf] : [workspace.createdBy, leaf];
}
