import { voiceGuide } from "./voice-tools.js";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import { advertisedJsonSchema } from "@opensteer/shared/advertisedJsonSchema";
import { createHash } from "node:crypto";
import {
  agentToolAnnotations,
  toolsFor,
  opensteerAgentSkillsFor,
  platformGuideForRun,
} from "@opensteer/agent-tools";
import type { ThreadAccessMode, TaskPurpose } from "@opensteer/core";
import type { RunAgentToolsPlan } from "@opensteer/protocol";

/** The Host owns the complete engine-facing inventory and startup context. */
export function agentToolsPlanForRun(input: {
  readonly voiceCall?: boolean;
  readonly url: string;
  readonly token: string;
  readonly purpose: TaskPurpose;
  readonly accessMode: ThreadAccessMode;
  readonly teamBound?: boolean;
  readonly personalContext?: boolean;
}): RunAgentToolsPlan {
  const runTools = toolsFor({
    kind: "run",
    accessMode: input.accessMode,
    teamBound: input.teamBound === true,
    personalContext: input.personalContext !== false,
  });
  const runToolsCatalog = runTools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    annotations: agentToolAnnotations(tool),
    input: advertisedJsonSchema(
      tool.advertisedInputSchema ??
        toJsonSchemaCompat(tool.input, { strictUnions: true, pipeStrategy: "input" }),
    ),
  }));
  const tools = runTools.map(({ name }) => name);
  const instructions =
    platformGuideForRun({
      purpose: input.purpose,
      teamBound: input.teamBound === true,
      personalContext: input.personalContext !== false,
    }) + (input.voiceCall ? `\n\n${voiceGuide}` : "");
  const skills = [...opensteerAgentSkillsFor({ personalContext: input.personalContext !== false })];
  const toolsRevision = createHash("sha256")
    .update(JSON.stringify({ catalog: runToolsCatalog, instructions, skills }))
    .digest("hex");
  return { url: input.url, token: input.token, tools, toolsRevision, instructions, skills };
}
