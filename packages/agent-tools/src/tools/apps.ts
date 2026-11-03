import { defineAgentTool } from "../registry.js";
import { AppPublishInputSchema, AppFetchInputSchema } from "@opensteer/core";

import { z } from "zod";

import { OperationKeySchema } from "./inputs.js";
import { AppPublishOutputSchema, AppListOutputSchema, AppFetchOutputSchema } from "./outputs.js";
export const app_publish = defineAgentTool({
  name: "app_publish",
  title: "Publish App",
  description:
    "Publish an app inline in this Thread and full-screen on every device. Pass a Workspace-relative self-contained UTF-8 HTML file, or a folder plus start (a shell command) for an app with data, APIs or several files. A server app requires a full-access Run and a local-directory Workspace on this computer; it listens on 127.0.0.1:$PORT, serves its UI at / and uses relative URLs. Publishing starts and verifies the server before saving; files run in place. Pass appId to update every card; publishing HTML instead stops the server. Read opensteer:threads, references/apps.md for layout, themes, logs and app APIs. Success already shows the app: do not repeat its contents in prose.",
  input: AppPublishInputSchema.safeExtend({ operationKey: OperationKeySchema.optional() }),
  output: AppPublishOutputSchema,
  access: "self",
  callers: ["run"] as const,
});

export const app_list = defineAgentTool({
  name: "app_list",
  title: "List Apps",
  description:
    "List published apps in this Run's reach and active Workspace memberships, including server folders and start commands. Requires a full-access Run. Read a server app's README for its API, then call app_fetch.",
  input: z.strictObject({}),
  output: AppListOutputSchema,
  access: "read",
  callers: ["run"] as const,
});

export const app_fetch = defineAgentTool({
  name: "app_fetch",
  title: "Call App",
  description:
    "Call a published server app's HTTP API using its appId and a relative HTTP path beginning with /. Requires a full-access Run with reach to the app's origin Thread and active Workspace membership. Returns status, content type and text, including non-2xx responses; bounded to 30 seconds and 256 KiB. Read the app folder's README for its API. Calling an app may change its data; app servers have the publishing computer user's authority.",
  input: AppFetchInputSchema.safeExtend({ operationKey: OperationKeySchema.optional() }),
  output: AppFetchOutputSchema,
  access: "work",
  callers: ["run"] as const,
});
