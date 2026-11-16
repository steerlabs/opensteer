import type { ThreadAccessMode } from "@opensteer/core";
import type { AgentCallerKind, RunToolCapabilities } from "./registry.js";
import { agentTools } from "./tools/index.js";

export function toolsFor(caller: {
  readonly kind: AgentCallerKind;
  readonly capabilities?: RunToolCapabilities;
  readonly accessMode: ThreadAccessMode;
  readonly teamsAvailable?: boolean;
  readonly knowledge?: boolean;
}) {
  return agentTools.filter(
    (tool) =>
      tool.callers.some((kind) => kind === caller.kind) &&
      (!("capability" in tool) ||
        !caller.capabilities ||
        caller.capabilities[tool.capability] === true) &&
      (tool.access !== "settings" || caller.accessMode === "full-access") &&
      (!("team" in tool) || (caller.kind === "run" && caller.teamsAvailable === true)) &&
      (!("knowledge" in tool) || (caller.kind === "run" && caller.knowledge === true)),
  );
}
