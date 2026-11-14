import { defineAgentTool } from "../registry.js";
import { AppPublishInputSchema, AppFetchInputSchema } from "@opensteer/core";

import { z } from "zod";

import { OperationKeySchema } from "./inputs.js";
import { AppPublishOutputSchema, AppListOutputSchema, AppFetchOutputSchema } from "./outputs.js";
export const opensteer_app_publish = defineAgentTool({
  name: "opensteer_app_publish",
  title: "Publish an app",
  description:
    "Publish an HTML file or server app from the agent home folder. Server apps require full access and listen on the assigned local port. Use opensteer_app_list to find published apps.",
  input: AppPublishInputSchema.safeExtend({ operationKey: OperationKeySchema.optional() }),
  output: AppPublishOutputSchema,
  access: "write",
  callers: ["run"] as const,
});

export const opensteer_app_list = defineAgentTool({
  name: "opensteer_app_list",
  title: "List apps",
  description:
    "List the owner’s published apps and server folders. Read the server README before opensteer_app_call.",
  input: z.strictObject({}),
  output: AppListOutputSchema,
  access: "read",
  callers: ["run", "program", "connection"] as const,
});

export const opensteer_app_call = defineAgentTool({
  name: "opensteer_app_call",
  title: "Call an app",
  description:
    "Call a server app by appId and a relative path. This requires a full-access Run and may change data.",
  input: AppFetchInputSchema,
  output: AppFetchOutputSchema,
  access: "write",
  callers: ["run"] as const,
});
