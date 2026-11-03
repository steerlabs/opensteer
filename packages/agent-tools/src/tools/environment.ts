import { defineAgentTool } from "../registry.js";
import { EnvironmentIdSchema, HarnessInstanceIdSchema } from "@opensteer/core";

import { z } from "zod";

import { CursorSchema } from "./inputs.js";
import { EnvironmentDiscoverySchema } from "./outputs.js";
export const environment_list = defineAgentTool({
  name: "environment_list",
  title: "List Environments",
  description:
    "Find environments, engine accounts, models and options. query filters offered models by every word across model/provider IDs, names, engines and drivers; blank lists all. Copy selectors; report unavailable catalogs. Page with environmentsNextCursor as environmentCursor and harnessesNextCursor as harnessCursor. For more models, keep query, focus harnessInstanceId and pass modelsNextCursor as cursor.",
  input: z.strictObject({
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
  }),
  output: EnvironmentDiscoverySchema,
  access: "read",
  callers: ["run", "program"] as const,
});
