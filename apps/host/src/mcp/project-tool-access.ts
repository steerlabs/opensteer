import { projectToolIsSupported } from "@opensteer/agent-tools";
import { OpensteerError } from "@opensteer/core";

export function assertProjectToolCall(name: string, input: object): void {
  if ("subagentId" in input)
    throw new OpensteerError({
      code: "forbidden",
      reason: "project-subagent-not-supported",
      message: "Reading or stopping one subagent requires person execution authority",
    });
  if (!projectToolIsSupported(name))
    throw new OpensteerError({
      code: "forbidden",
      reason: "project-tool-not-supported",
      message: "This tool is unavailable to a Project caller",
    });
  if (name === "delegate_task" && "mode" in input && input.mode === "wait")
    throw new OpensteerError({
      code: "forbidden",
      reason: "project-wait-not-supported",
      message: "Project tasks return their result as a message; waiting is unavailable",
    });
}
