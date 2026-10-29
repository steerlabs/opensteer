import { threadAccessModeAtMost, threadInReach, type Thread } from "@opensteer/core";

export type AuthorityThread = Pick<
  Thread,
  "accessMode" | "capabilityProfileId" | "lineageRootThreadId" | "workspaceId"
>;

export type TriggerAccess = "none" | "see" | "control" | "define";

export function triggerAccess(actor: AuthorityThread, anchor: AuthorityThread): TriggerAccess {
  if (!threadInReach(actor, anchor)) return "none";
  if (
    actor.accessMode === "full-access" &&
    (actor.capabilityProfileId === "main" ||
      (actor.capabilityProfileId === anchor.capabilityProfileId &&
        actor.workspaceId === anchor.workspaceId))
  ) {
    return "define";
  }
  return threadAccessModeAtMost(anchor.accessMode, actor.accessMode) ? "control" : "see";
}
