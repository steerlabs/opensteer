import { voiceGuide } from "./voice-tools.js";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import { advertisedJsonSchema } from "@opensteer/shared/advertisedJsonSchema";
import { createHash } from "node:crypto";
import {
  type RunToolCapabilities,
  agentToolAnnotations,
  toolsFor,
  opensteerAgentSkillsFor,
  platformGuideForRun,
} from "@opensteer/agent-tools";
import type { AgentGrant, ThreadAccessMode, TaskPurpose } from "@opensteer/core";
import {
  agentHomeSettingsErrorText,
  type AgentHomeSettingsError,
  type RunAgentToolsPlan,
} from "@opensteer/protocol";

/** The Host owns the complete engine-facing inventory and startup context. */
export function agentToolsPlanForRun(input: {
  readonly voiceCall?: boolean;
  readonly capabilities: RunToolCapabilities;
  readonly url: string;
  readonly token: string;
  readonly purpose: TaskPurpose;
  readonly accessMode: ThreadAccessMode;
  readonly teamsAvailable?: boolean;
  readonly personalContext?: boolean;
  /** The owner is in a team and this Run may use their personal context. */
  readonly knowledge?: boolean;
  /** Why settings.json in Agent home is invalid, for the agent that can fix it. */
  readonly settingsError?: AgentHomeSettingsError | undefined;
  /** The grant of the connection whose lineage this Run is in. */
  readonly grant?: AgentGrant;
}): RunAgentToolsPlan {
  const runTools = toolsFor({
    kind: "run",
    ...(input.grant ? { grant: input.grant } : {}),
    capabilities: input.capabilities,
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
      capabilities: input.capabilities,
      teamsAvailable: input.teamsAvailable === true,
      personalContext: input.personalContext !== false,
      knowledge: input.knowledge === true,
    }) +
    (input.voiceCall ? `\n\n${voiceGuide}` : "") +
    (input.settingsError
      ? `\n\nsettings.json is invalid, so background models still use its last valid version: ${agentHomeSettingsErrorText(input.settingsError)}`
      : "");
  const skills = [
    ...opensteerAgentSkillsFor({
      personalContext: input.personalContext !== false,
      capabilities: input.capabilities,
    }),
  ];
  const toolsRevision = createHash("sha256")
    .update(
      JSON.stringify({
        catalog: runToolsCatalog,
        instructions,
        skills,
        capabilities: input.capabilities,
      }),
    )
    .digest("hex");
  return { url: input.url, token: input.token, tools, toolsRevision, instructions, skills };
}

/** The input schema engines see for a tool; the Run plan's revision hashes exactly this. */
export function advertisedToolInputSchema(tool: {
  readonly input: Parameters<typeof toJsonSchemaCompat>[0];
  readonly advertisedInputSchema?: Readonly<Record<string, unknown>>;
}): Record<string, unknown> {
  if (tool.advertisedInputSchema) return advertisedJsonSchema(tool.advertisedInputSchema);
  const schema = advertisedJsonSchema(
    toJsonSchemaCompat(tool.input, { strictUnions: true, pipeStrategy: "input" }),
  );
  const properties = schema.properties;
  // A receipt ID continues a connection's own work, outside the Run and program contract.
  if (properties && typeof properties === "object" && "operationId" in properties) {
    const { operationId: _operationId, ...remaining } = properties;
    return { ...schema, properties: remaining };
  }
  return schema;
}
