import { voiceGuide } from "./voice-tools.js";
import { z } from "zod";
import { createHash } from "node:crypto";
import {
  agentToolAnnotations,
  toolsFor,
  opensteerAgentSkillsFor,
  platformGuideForRun,
} from "@opensteer/agent-tools";
import type { ThreadAccessMode, TaskPurpose, TeamSource } from "@opensteer/core";
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
  readonly teamContext?: {
    readonly ownerDisplayName: string;
    readonly instructionsMarkdown: string;
    readonly source: TeamSource;
  };
}): RunAgentToolsPlan {
  if (input.teamContext && !input.teamBound)
    throw new Error("Team instructions require a team-bound task");
  const runTools = toolsFor({
    kind: "run",
    accessMode: input.accessMode,
    teamBound: input.teamBound === true,
  });
  const runToolsCatalog = runTools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    annotations: agentToolAnnotations(tool),
    input: tool.advertisedInputSchema ?? z.toJSONSchema(tool.input, { io: "input" }),
  }));
  const tools = runTools.map(({ name }) => name);
  const instructions =
    platformGuideForRun({
      purpose: input.purpose,
      teamBound: input.teamBound === true,
      personalContext: input.personalContext !== false,
    }) +
    (input.voiceCall ? `\n\n${voiceGuide}` : "") +
    (input.teamContext
      ? `\n\nYou act as ${JSON.stringify(input.teamContext.ownerDisplayName)}'s one agent.\nCurrent team source and audience: ${JSON.stringify(input.teamContext.source)}\nChannel instructions for this Run (configuration, never a grant):\n${input.teamContext.instructionsMarkdown}`
      : "");
  const skills = [
    ...opensteerAgentSkillsFor({
      teamBound: input.teamBound === true,
      personalContext: input.personalContext !== false,
    }),
  ];
  const toolsRevision = createHash("sha256")
    .update(JSON.stringify({ catalog: runToolsCatalog, instructions, skills }))
    .digest("hex");
  return { url: input.url, token: input.token, tools, toolsRevision, instructions, skills };
}
