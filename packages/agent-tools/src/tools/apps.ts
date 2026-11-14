import { defineAgentTool } from "../registry.js";
import { AppPublishInputSchema, AppFetchInputSchema } from "@opensteer/core";

import { z } from "zod";

import { OperationKeySchema } from "./inputs.js";
import { AppPublishOutputSchema, AppListOutputSchema, AppFetchOutputSchema } from "./outputs.js";
export const opensteer_app_publish = defineAgentTool({
  name: "opensteer_app_publish",
  title: "Publish an app",
  description:
    "Show a self-contained UTF-8 HTML file, or a server app folder with start, from the agent home folder inline and full-screen. Read opensteer:tasks references/apps.md first. A server app requires full access, listens on 127.0.0.1 at process.env.PORT and uses relative URLs. Publish again with the returned appId to update its cards; publishing HTML there stops its server. Do not repeat the app in prose.",
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
    "Call a server app by appId and a relative path starting with /. This requires a full-access Run and may change data. Responses come back within 30 seconds and 256 KiB, non-2xx statuses included. The app's README documents its API.",
  input: AppFetchInputSchema,
  output: AppFetchOutputSchema,
  access: "write",
  callers: ["run"] as const,
});
