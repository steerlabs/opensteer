import type { ThreadAccessMode } from "@opensteer/core";
import type { AgentCallerKind, RunToolCapabilities } from "./registry.js";
import { agentTools } from "./tools/index.js";

export function toolsFor(caller: {
  readonly kind: AgentCallerKind;
  readonly program?: { readonly kind: "trigger" | "watch" };
  readonly capabilities?: RunToolCapabilities;
  readonly accessMode: ThreadAccessMode;
  readonly teamsAvailable?: boolean;
  readonly knowledge?: boolean;
}) {
  return agentTools.filter(
    (tool) =>
      tool.callers.some((kind) => kind === caller.kind) &&
      (caller.program?.kind !== "watch" || tool.name !== "app_access_request") &&
      (!("capability" in tool) ||
        !caller.capabilities ||
        caller.capabilities[tool.capability] === true) &&
      (tool.access !== "settings" || caller.accessMode === "full-access") &&
      (!("team" in tool) || (caller.kind === "run" && caller.teamsAvailable === true)) &&
      (!("knowledge" in tool) || (caller.kind === "run" && caller.knowledge === true)),
  );
}
