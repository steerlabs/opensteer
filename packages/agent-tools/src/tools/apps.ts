import { defineAgentTool } from "../registry.js";
import { AppPublishInputSchema, AppFetchInputSchema } from "@opensteer/core";

import { z } from "zod";

import { OperationKeySchema } from "./inputs.js";
import { AppPublishOutputSchema, AppListOutputSchema, AppFetchOutputSchema } from "./outputs.js";
export const app_publish = defineAgentTool({
  name: "app_publish",
  title: "Publish an app",
  description:
    "Show a task folder HTML file or server app inline and full-screen. Run-only. path names self-contained UTF-8 HTML, or a folder with start. Servers need full-access/local storage, listen on 127.0.0.1:$PORT and use relative URLs. Returns appId/version after verification. appId updates cards; HTML replaces/stops a server. Read opensteer:threads references/apps.md. Do not repeat the app in prose.",
  input: AppPublishInputSchema.safeExtend({ operationKey: OperationKeySchema.optional() }),
  output: AppPublishOutputSchema,
  access: "write",
  callers: ["run"] as const,
});

export const app_list = defineAgentTool({
  name: "app_list",
  title: "List apps",
  description:
    "Find published apps for the owner. Returns IDs and server folders/start commands; read the server README before app_fetch.",
  input: z.strictObject({}),
  output: AppListOutputSchema,
  access: "read",
  callers: ["run", "program", "connection"] as const,
});

export const app_fetch = defineAgentTool({
  name: "app_fetch",
  title: "Call an app",
  description:
    "Call a server app by appId and relative path starting with /. Full-access Run for the owner. May change data. Returns HTTP status/content type/text, including non-2xx, within 30 seconds/256 KiB. Read the app README for its API.",
  input: AppFetchInputSchema.safeExtend({ operationKey: OperationKeySchema.optional() }),
  output: AppFetchOutputSchema,
  access: "write",
  callers: ["run"] as const,
});
