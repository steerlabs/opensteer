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
}): RunAgentToolsPlan {
  const runTools = toolsFor({
    kind: "run",
    accessMode: input.accessMode,
    reach: { kind: input.reach },
  });
  const runToolsCatalog = runTools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    annotations: agentToolAnnotations(tool),
    input: tool.advertisedInputSchema ?? z.toJSONSchema(tool.input, { io: "input" }),
  }));
  const tools = runTools.map(({ name }) => name);
  const instructions =
    platformGuideForRun({ role: input.role, reach: input.reach }) +
    (input.voiceCall ? `\n\n${voiceGuide}` : "");
  const skills = [...opensteerAgentSkillsFor(input.reach)];
  const toolsRevision = createHash("sha256")
    .update(JSON.stringify({ catalog: runToolsCatalog, instructions, skills }))
    .digest("hex");
  return { url: input.url, token: input.token, tools, toolsRevision, instructions, skills };
}
