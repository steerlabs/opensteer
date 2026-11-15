import { defineAgentTool } from "../registry.js";
import { LegacyAppPublishInputSchema, AppFetchInputSchema } from "@opensteer/core";

import { z } from "zod";

import { OperationKeySchema } from "./inputs.js";
import {
  LegacyAppPublishOutputSchema,
  LegacyAppListOutputSchema,
  AppFetchOutputSchema,
} from "./outputs.js";
export const opensteer_app_publish = defineAgentTool({
  name: "opensteer_app_publish",
  title: "Publish an app",
  description:
    "Show a self-contained UTF-8 HTML file, or a server app folder with start, from the agent home folder inline and full-screen. Read opensteer:tasks references/apps.md first. A server app requires full access, listens on 127.0.0.1 at process.env.PORT and uses relative URLs. Publish again with the returned appId to update its cards; publishing HTML there stops its server. Do not repeat the app in prose.",
  input: LegacyAppPublishInputSchema.safeExtend({ operationKey: OperationKeySchema.optional() }),
  output: LegacyAppPublishOutputSchema,
  access: "write",
  callers: ["run"] as const,
});

export const opensteer_app_list = defineAgentTool({
  name: "opensteer_app_list",
  title: "List apps",
  description:
    "List the owner’s published apps and server folders. Read the server README before opensteer_app_call.",
  input: z.strictObject({}),
  output: LegacyAppListOutputSchema,
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

import { AppPublishInputSchema, AppIdSchema } from "@opensteer/core";
import {
  AppPublishOutputSchema,
  AppListOutputSchema,
  AppLifecycleOutputSchema,
  AppDeleteOutputSchema,
} from "./outputs.js";
const appIdField = AppIdSchema.describe("App ID from app_list or app_publish.");
export const app_publish = defineAgentTool({
  name: "app_publish",
  title: "Publish an app",
  description:
    "Publish a UTF-8 HTML file or a server folder in Agent home. name labels its cards and Apps entry. Supply appId from app_list or an earlier publication to update it. With start, a full-access Run starts and verifies the server before publishing; the server listens on 127.0.0.1 at PORT. Its port stays fixed. Publishing HTML there stops its server. Publication adds a chat card, not a tab; tab_open with kind app opens one.",
  input: AppPublishInputSchema,
  output: AppPublishOutputSchema,
  access: "write",
  callers: ["run"] as const,
  capability: "apps",
});
export const app_list = defineAgentTool({
  name: "app_list",
  title: "List apps",
  description:
    "Find the person's published apps, including apps whose origin chat was deleted. Query matches name or folder. Server localUrl is on the app's hosting computer; call it there with curl or fetch, using the app's README for its API. app_start and app_stop control server lifetime; tab_close only removes a tab.",
  input: z.strictObject({ query: z.string().trim().min(1).max(200).optional() }),
  output: AppListOutputSchema,
  access: "read",
  callers: ["run", "program", "connection"] as const,
  capability: "apps",
});
export const app_start = defineAgentTool({
  name: "app_start",
  title: "Start an app server",
  description:
    "Start the server app from app_list on its saved computer and fixed port. It keeps running after this Run and restarts when that computer reconnects. Requires a full-access Run. Opening or viewing a stopped app does not start it.",
  input: z.strictObject({ appId: appIdField }),
  output: AppLifecycleOutputSchema,
  access: "write",
  callers: ["run"] as const,
  capability: "apps",
});
export const app_stop = defineAgentTool({
  name: "app_stop",
  title: "Stop an app server",
  description:
    "Stop the server app from app_list and keep it stopped across reconnects. Its folder and tabs remain. An offline computer records the stopped intent; it cannot start the app on reconnect. Use app_start to run it again.",
  input: z.strictObject({ appId: appIdField }),
  output: AppLifecycleOutputSchema,
  access: "write",
  callers: ["run"] as const,
  capability: "apps",
});
export const app_delete = defineAgentTool({
  name: "app_delete",
  title: "Delete an app",
  description:
    "Stop this app's server, close its tabs, revoke its viewing access and remove its publications. Its folder and data stay on disk. Get appId from app_list or app_publish. Deleting the origin chat does not delete an app.",
  input: z.strictObject({ appId: appIdField }),
  output: AppDeleteOutputSchema,
  access: "write",
  callers: ["run"] as const,
  capability: "apps",
  destructive: true,
});
export const appTools = [app_publish, app_list, app_start, app_stop, app_delete] as const;
