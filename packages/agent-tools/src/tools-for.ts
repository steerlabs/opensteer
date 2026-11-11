import type { ThreadAccessMode, ThreadReachScope } from "@opensteer/core";
import type { AgentCallerKind } from "./registry.js";
import { agentTools } from "./tools/index.js";

const projectToolNames = new Set<string>([
  "thread_read",
  "thread_list",
  "thread_delegate",
  "thread_message",
  "task_status",
  "task_cancel",
]);

export function toolsFor(caller: {
  readonly kind: AgentCallerKind | "project";
  readonly accessMode: ThreadAccessMode;
  readonly reach: { readonly kind: ThreadReachScope["kind"] };
}) {
  return agentTools.filter(
    (tool) =>
      (caller.kind === "project"
        ? projectToolNames.has(tool.name)
        : tool.callers.some((kind) => kind === caller.kind)) &&
      (tool.access !== "settings" || caller.accessMode === "full-access") &&
      (tool.minimumReach === "user"
        ? caller.reach.kind === "user"
        : tool.minimumReach !== "workspace" || caller.reach.kind !== "lineage"),
  );
}
