import { voiceGuide } from "./voice-tools.js";
import { z } from "zod";
import { createHash } from "node:crypto";
import {
  agentToolAnnotations,
  toolsFor,
  opensteerAgentSkillsFor,
  platformGuideForRun,
} from "@opensteer/agent-tools";
import type { ThreadAccessMode, ThreadReachScope, ThreadRole } from "@opensteer/core";
import type { RunAgentToolsPlan } from "@opensteer/protocol";

/** The Host owns the complete engine-facing inventory and startup context. */
export function agentToolsPlanForRun(input: {
  readonly voiceCall?: boolean;
  readonly url: string;
  readonly token: string;
  readonly role: ThreadRole;
  readonly accessMode: ThreadAccessMode;
  readonly reach: ThreadReachScope["kind"];
  readonly knowledge?: boolean;
}): RunAgentToolsPlan {
  return principalToolsPlan({ ...input, kind: "run" });
}

export function agentToolsPlanForProject(input: {
  readonly url: string;
  readonly token: string;
  readonly role: ThreadRole;
  readonly accessMode: ThreadAccessMode;
}): RunAgentToolsPlan {
  return principalToolsPlan({ ...input, kind: "project", reach: "workspace" });
}

function principalToolsPlan(
  input: Parameters<typeof agentToolsPlanForRun>[0] & { readonly kind: "run" | "project" },
): RunAgentToolsPlan {
  const runTools = toolsFor({
    kind: input.kind,
    accessMode: input.accessMode,
    reach: { kind: input.reach },
    knowledge: input.knowledge === true,
  });
  const runToolsCatalog = runTools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    annotations: agentToolAnnotations(tool),
    input: tool.advertisedInputSchema ?? z.toJSONSchema(tool.input, { io: "input" }),
  }));
  const tools = runTools.map(({ name }) => name);
  const instructions =
    input.kind === "project"
      ? "You work for this Project. Stay in this Project. Use its configured engine, model and instructions. Use delegate_task only in async mode. Child tasks receive only the task you send them and return their result as a message to the original parent exchange. task_status is informational and does not suppress that return. Waiting, holds, pending_request and reading or stopping one subagent are unavailable; do not poll. Ask questions through the engine's question or approval interface. Personal sign-in, Browser, apps, phones, integrations, memory, plugins and administration are unavailable. Creatorless child tasks are not supported yet."
      : platformGuideForRun({ role: input.role, reach: input.reach }) +
        (input.voiceCall ? `\n\n${voiceGuide}` : "");
  const skills =
    input.kind === "project"
      ? []
      : [...opensteerAgentSkillsFor(input.reach, { knowledge: input.knowledge === true })];
  const toolsRevision = createHash("sha256")
    .update(JSON.stringify({ catalog: runToolsCatalog, instructions, skills }))
    .digest("hex");
  return { url: input.url, token: input.token, tools, toolsRevision, instructions, skills };
}
