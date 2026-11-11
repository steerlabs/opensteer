import type { ThreadAccessMode, ThreadReachScope } from "@opensteer/core";
import type { AgentCallerKind } from "./registry.js";
import { agentTools } from "./tools/index.js";

const projectToolNames = new Set<string>([
  "thread_read",
  "thread_list",
  "delegate_task",
  "thread_send",
  "task_status",
  "task_cancel",
]);

export function projectToolIsSupported(name: string): boolean {
  return projectToolNames.has(name);
}

export function toolsFor(caller: {
  readonly kind: AgentCallerKind | "project";
  readonly accessMode: ThreadAccessMode;
  readonly reach: { readonly kind: ThreadReachScope["kind"] };
  readonly knowledge?: boolean;
}) {
  return agentTools.filter(
    (tool) =>
      (caller.kind === "project"
        ? projectToolIsSupported(tool.name)
        : tool.callers.some((kind) => kind === caller.kind)) &&
      (tool.access !== "settings" || caller.accessMode === "full-access") &&
      (!("knowledge" in tool) || caller.knowledge === true) &&
      (tool.minimumReach === "user"
        ? caller.reach.kind === "user"
        : tool.minimumReach !== "workspace" || caller.reach.kind !== "lineage"),
  );
}
