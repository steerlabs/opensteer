import type { ThreadAccessMode, ThreadReachScope } from "@opensteer/core";
import type { AgentCallerKind } from "./registry.js";
import { agentTools } from "./tools/index.js";

export function toolsFor(caller: {
  readonly kind: AgentCallerKind;
  readonly accessMode: ThreadAccessMode;
  readonly reach: { readonly kind: ThreadReachScope["kind"] };
}) {
  return agentTools.filter(
    (tool) =>
      tool.callers.some((kind) => kind === caller.kind) &&
      (tool.access !== "settings" || caller.accessMode === "full-access") &&
      (tool.minimumReach === "user"
        ? caller.reach.kind === "user"
        : tool.minimumReach !== "workspace" || caller.reach.kind !== "lineage"),
  );
}
