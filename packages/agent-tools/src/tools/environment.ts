import { defineAgentTool } from "../registry.js";
import { EnvironmentIdSchema, HarnessInstanceIdSchema } from "@opensteer/core";

import { z } from "zod";

import { CursorSchema } from "./inputs.js";
import { EnvironmentDiscoverySchema } from "./outputs.js";
export const EnvironmentListInputSchema = z
  .strictObject({
    query: z
      .string()
      .trim()
      .max(256)
      .transform((query) => query || undefined)
      .optional(),
    harnessInstanceId: HarnessInstanceIdSchema.optional(),
    cursor: CursorSchema.optional(),
    environmentCursor: EnvironmentIdSchema.optional(),
    harnessCursor: HarnessInstanceIdSchema.optional(),
  })
  .superRefine((input, context) => {
    if (input.cursor && !input.harnessInstanceId)
      context.addIssue({ code: "custom", message: "cursor requires harnessInstanceId" });
    if (input.harnessInstanceId && (input.environmentCursor || input.harnessCursor))
      context.addIssue({
        code: "custom",
        message: "Focus cannot be combined with directory cursors",
      });
  });
export type EnvironmentListInput = z.output<typeof EnvironmentListInputSchema>;
export const environment_list = defineAgentTool({
  name: "environment_list",
  title: "Find engines and models",
  description:
    "Find computers, engine accounts, models/options before choosing execution settings. Copy selectors; report unavailable catalogs without substitution. query matches all words across IDs/names/engines. Page directories with environmentsNextCursor as environmentCursor and harnessesNextCursor as harnessCursor. For model pages, keep query/harnessInstanceId; pass modelsNextCursor as cursor.",
  input: EnvironmentListInputSchema,
  output: EnvironmentDiscoverySchema,
  access: "read",
  callers: ["run", "program"] as const,
});
