import { defineAgentTool } from "../registry.js";
import { EnvironmentIdSchema, HarnessInstanceIdSchema } from "@opensteer/core";

import { z } from "zod";

import { CursorSchema } from "./inputs.js";
import { OrchestratorCapabilitiesSchema, EnvironmentDiscoverySchema } from "./outputs.js";
export const OrchestratorCapabilitiesInputSchema = z
  .strictObject({
    query: z
      .string()
      .trim()
      .max(256)
      .transform((query) => query || undefined)
      .optional(),
    harnessInstanceId: HarnessInstanceIdSchema.optional(),
    cursor: CursorSchema.optional(),
    harnessCursor: HarnessInstanceIdSchema.optional(),
  })
  .superRefine((input, context) => {
    if (input.cursor && !input.harnessInstanceId)
      context.addIssue({ code: "custom", message: "cursor requires harnessInstanceId" });
    if (input.harnessInstanceId && input.harnessCursor)
      context.addIssue({
        code: "custom",
        message: "Focus cannot be combined with directory cursors",
      });
  });
export type OrchestratorCapabilitiesInput = z.output<typeof OrchestratorCapabilitiesInputSchema>;
export const orchestrator_capabilities = defineAgentTool({
  name: "orchestrator_capabilities",
  title: "Discover orchestration choices",
  description:
    "Engine accounts, models/options for delegate_task and thread_configure, your access ceiling and enforced budgets. Copy selectors exactly; unavailable choices never imply substitution. Page with harnessesNextCursor as harnessCursor; for models keep query/harnessInstanceId and pass modelsNextCursor as cursor.",
  input: OrchestratorCapabilitiesInputSchema,
  output: OrchestratorCapabilitiesSchema,
  access: "read",
  callers: ["run", "program", "connection"] as const,
});

export const EnvironmentListInputSchema = z.strictObject({
  environmentCursor: EnvironmentIdSchema.optional(),
});
export type EnvironmentListInput = z.output<typeof EnvironmentListInputSchema>;
export const environment_list = defineAgentTool({
  name: "environment_list",
  title: "Find computers",
  description:
    "List the owner's computers, connection status and task execution eligibility. Browser, app, phone and shell tools use these computers. Engine/model choices: orchestrator_capabilities. Page with environmentsNextCursor as environmentCursor.",
  input: EnvironmentListInputSchema,
  output: EnvironmentDiscoverySchema,
  access: "read",
  callers: ["run", "program", "connection"] as const,
});
