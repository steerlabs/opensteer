import { defineAgentTool } from "../registry.js";
import { z } from "zod";
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
