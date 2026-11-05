import type { ThreadId, WorkspaceId } from "./ids.js";
import type { Thread } from "./models.js";

export type ReachThread = Pick<
  Thread,
  "inheritsMain" | "specialistId" | "lineageRootThreadId" | "workspaceId"
>;

export type ThreadReachScope =
  | { kind: "user" }
  | { kind: "workspace"; workspaceId: WorkspaceId }
  | { kind: "lineage"; lineageRootThreadId: ThreadId };

export function threadReachScope(actor: ReachThread): ThreadReachScope {
  if (actor.specialistId) {
    return { kind: "lineage", lineageRootThreadId: actor.lineageRootThreadId };
  }
  if (actor.inheritsMain) return { kind: "user" };
  return { kind: "workspace", workspaceId: actor.workspaceId };
}

export function threadInReach(
  actor: ReachThread | ThreadReachScope,
  target: Pick<ReachThread, "workspaceId" | "lineageRootThreadId">,
): boolean {
  const scope = "kind" in actor ? actor : threadReachScope(actor);
  switch (scope.kind) {
    case "user":
      return true;
    case "workspace":
      return target.workspaceId === scope.workspaceId;
    case "lineage":
      return target.lineageRootThreadId === scope.lineageRootThreadId;
  }
}

export function lineageCompatibleForReuse(
  caller: Pick<ReachThread, "inheritsMain" | "specialistId">,
  target: Pick<ReachThread, "inheritsMain" | "specialistId">,
): boolean {
  return (
    (caller.inheritsMain || !target.inheritsMain) &&
    (!caller.specialistId || caller.specialistId === target.specialistId)
  );
}
