import { z } from "zod";
import { createHash } from "node:crypto";
import {
  agentToolAnnotations,
  agentTools,
  opensteerAgentSkillNames,
  platformGuideForRun,
} from "@opensteer/agent-tools";
import type { ThreadReachScope, ThreadRole } from "@opensteer/core";
import type { RunAgentToolsPlan } from "@opensteer/protocol";

const runTools = agentTools.filter((tool) => tool.callers.some((caller) => caller === "run"));

/** Every advertised field of the Run inventory, so a changed tool changes the revision. */
const runToolsCatalog = runTools.map((tool) => ({
  name: tool.name,
  description: tool.description,
  annotations: agentToolAnnotations(tool),
  input:
    ("advertisedInputSchema" in tool ? tool.advertisedInputSchema : undefined) ??
    z.toJSONSchema(tool.input, { io: "input" }),
}));

/** The Host owns the complete engine-facing inventory and startup context. */
export function agentToolsPlanForRun(input: {
  readonly url: string;
  readonly token: string;
  readonly role: ThreadRole;
  readonly reach: ThreadReachScope["kind"];
}): RunAgentToolsPlan {
  const tools = runTools.map(({ name }) => name);
  const instructions = platformGuideForRun({ role: input.role, reach: input.reach });
  const skills = [...opensteerAgentSkillNames];
  const toolsRevision = createHash("sha256")
    .update(JSON.stringify({ catalog: runToolsCatalog, instructions, skills }))
    .digest("hex");
  return { url: input.url, token: input.token, tools, toolsRevision, instructions, skills };
}
