import type { ThreadAccessMode } from "@opensteer/core";
import type { AgentCallerKind } from "./registry.js";
import { agentTools } from "./tools/index.js";

export function toolsFor(caller: {
  readonly kind: AgentCallerKind;
  readonly accessMode: ThreadAccessMode;
  readonly teamBound?: boolean;
}) {
  return agentTools.filter(
    (tool) =>
      tool.callers.some((kind) => kind === caller.kind) &&
      (tool.access !== "settings" || caller.accessMode === "full-access") &&
      (!("team" in tool) || (caller.kind === "run" && caller.teamBound === true)),
  );
}
