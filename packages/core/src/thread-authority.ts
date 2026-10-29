import type { ThreadId, WorkspaceId } from "./ids.js";
import type { Thread } from "./models.js";

export type ReachThread = Pick<
  Thread,
  "capabilityProfileId" | "lineageRootThreadId" | "workspaceId"
>;

export type ThreadReachScope =
  | { kind: "user" }
  | { kind: "workspace"; workspaceId: WorkspaceId }
  | { kind: "lineage"; lineageRootThreadId: ThreadId };

export function threadReachScope(actor: ReachThread): ThreadReachScope {
  if (actor.capabilityProfileId === "main") return { kind: "user" };
  if (actor.capabilityProfileId === "workspace") {
    return { kind: "workspace", workspaceId: actor.workspaceId };
  }
  return { kind: "lineage", lineageRootThreadId: actor.lineageRootThreadId };
}

export function threadInReach(actor: ReachThread, target: ReachThread): boolean {
  const scope = threadReachScope(actor);
  switch (scope.kind) {
    case "user":
      return true;
    case "workspace":
      return target.workspaceId === scope.workspaceId;
    case "lineage":
      return target.lineageRootThreadId === scope.lineageRootThreadId;
  }
}
