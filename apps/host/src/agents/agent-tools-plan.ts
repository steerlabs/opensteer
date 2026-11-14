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
  readonly teamsAvailable?: boolean;
  readonly personalContext?: boolean;
  /** The owner is in a team and this Run may use their personal context. */
  readonly knowledge?: boolean;
}): RunAgentToolsPlan {
  const runTools = toolsFor({
    kind: "run",
    accessMode: input.accessMode,
    teamsAvailable: input.teamsAvailable === true,
    knowledge: input.knowledge === true,
  });
  const runToolsCatalog = runTools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    annotations: agentToolAnnotations(tool),
    input: advertisedToolInputSchema(tool),
  }));
  const tools = runTools.map(({ name }) => name);
  const instructions =
    platformGuideForRun({
      purpose: input.purpose,
      teamsAvailable: input.teamsAvailable === true,
      personalContext: input.personalContext !== false,
      knowledge: input.knowledge === true,
    }) + (input.voiceCall ? `\n\n${voiceGuide}` : "");
  const skills = [...opensteerAgentSkillsFor({ personalContext: input.personalContext !== false })];
  const toolsRevision = createHash("sha256")
    .update(JSON.stringify({ catalog: runToolsCatalog, instructions, skills }))
    .digest("hex");
  return { url: input.url, token: input.token, tools, toolsRevision, instructions, skills };
}

/** The input schema engines see for a tool; the Run plan's revision hashes exactly this. */
export function advertisedToolInputSchema(tool: {
  readonly input: Parameters<typeof toJsonSchemaCompat>[0];
  readonly advertisedInputSchema?: Readonly<Record<string, unknown>>;
}): Record<string, unknown> {
  return advertisedJsonSchema(
    tool.advertisedInputSchema ??
      toJsonSchemaCompat(tool.input, { strictUnions: true, pipeStrategy: "input" }),
  );
}
