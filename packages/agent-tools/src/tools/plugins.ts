import { BlockedSchema } from "@opensteer/core";
import { z } from "zod";
import { defineAgentTool } from "../registry.js";
import { directInput, directOutput } from "./tabs.js";

const id = z.string().min(1).max(256);
const json = z.json();
const object = z.record(z.string(), json);
const searchInput = z.strictObject({
  query: z.string().max(2000).optional(),
  namespace: id.optional(),
  limit: z.number().int().min(1).max(100).optional().describe("At most 100. Page with next."),
  offset: z.number().int().nonnegative().optional(),
});
const executionOutput = z.object({
  executionId: id,
  status: z.enum(["pending", "completed", "cancelled", "expired", "interrupted", "failed"]),
  requestId: id.optional(),
  result: json.optional(),
  reason: z.string().optional(),
  next: z.string(),
  truncated: z.literal(true).optional(),
});
const pending =
  "If the plugin returns a pending executionId, wait for the person to answer in Needs you, then use plugin_resume with that id. Never answer it yourself or rerun the plugin. Earlier effects are not rolled back.";
const discoveryCallers = ["run", "program", "connection"] as const;
const executionCallers = ["run", "program", "connection"] as const;
const directExecutionOutput = z
  .object({
    ...executionOutput.partial().shape,
    ...directOutput,
    taskId: directOutput.taskId.unwrap(),
    operationId: directOutput.operationId.unwrap(),
    status: executionOutput.shape.status.or(z.literal("unknown")),
    next: executionOutput.shape.next.optional(),
  })
  .or(executionOutput);

export const pluginResumeConnectionOutput = executionOutput
  .extend({ status: z.literal("pending"), taskId: directOutput.taskId.unwrap() })
  .or(directExecutionOutput);
export const plugin_search = defineAgentTool({
  name: "plugin_search",
  title: "Find plugin tools",
  access: "read",
  callers: discoveryCallers,
  description:
    "Find plugin tools by words in their paths, descriptions and labels. Returns exact paths, one-line descriptions and input types, with plugins and linked accounts listed once. Pass a path to plugin_call or plugin_describe, or use tools.<plugin>.<tool>() in plugin_execute. Omit query to list a namespace. Read the following page by passing next as the whole input; null ends paging. Approved device data apps (Calendar, Contacts, Reminders, Messages, iPhone Location and Photos) and local servers are plugins too, with stable namespaces returned by discovery; blocked namespaces and tool items carry code, message and next; follow the target's next step. Read tools remain usable when a write needs more access. A task's ceiling and the person's access are separate. Only the person can change Read-only or Off in Plugins.",
  input: searchInput,
  output: z.object({
    items: z.array(
      z.object({
        path: id,
        description: z.string(),
        input: z.string().optional(),
        inputTruncated: z.literal(true).optional(),
        blocked: BlockedSchema.optional(),
      }),
    ),
    namespaces: z.array(object),
    remaining: z.number(),
    next: searchInput.nullable(),
    unavailableApps: z
      .array(z.object({ app: id, name: z.string(), reason: z.string(), blocked: BlockedSchema }))
      .optional(),
  }),
});
export const plugin_describe = defineAgentTool({
  name: "plugin_describe",
  title: "Describe plugin tools",
  access: "read",
  callers: discoveryCallers,
  description:
    "Read the whole description and TypeScript signature, including input and output types, for exact paths from plugin_search. Blocked tools explain why. Unknown paths appear in missing with closest paths.",
  input: z.strictObject({ paths: z.array(id).min(1).max(100) }),
  output: z.object({
    items: z.array(
      z.object({
        path: id,
        description: z.string(),
        signature: z.string().optional(),
        blocked: BlockedSchema.optional(),
      }),
    ),
    namespaces: z.array(object),
    missing: z.array(z.object({ path: id, matches: z.array(z.string()) })),
    unavailableApps: z
      .array(z.object({ app: id, name: z.string(), reason: z.string(), blocked: BlockedSchema }))
      .optional(),
  }),
});
const call = z.strictObject({ path: id, input: json });
export const plugin_call = defineAgentTool({
  name: "plugin_call",
  title: "Call plugin tools",
  access: "write",
  callers: executionCallers,
  openWorld: true,
  description: `Call plugin tools at exact paths from plugin_search. Pass one {path,input} as calls, or an array of independent calls to run concurrently; results keep that order with ok and value or error. Use plugin_execute when output feeds another call or to filter large results. Connected agents call one plugin per operation. Accounts connect through plugin_account_request; never collect secrets in chat. ${pending}`,
  input: z.strictObject({ ...directInput, calls: z.union([call, z.array(call).min(1).max(100)]) }),
  output: directExecutionOutput,
});
export const plugin_execute = defineAgentTool({
  name: "plugin_execute",
  title: "Run a plugin program",
  access: "write",
  callers: executionCallers,
  openWorld: true,
  description: `Run a short JavaScript program over tools.<plugin>.<tool>() when one result feeds another call or large results should be filtered before reaching you. For one or a few independent calls use plugin_call. Discover with plugin_search or tools.search, and full signatures with plugin_describe or tools.search.describe({paths}). First read opensteer:plugins and its code mode reference. A blocked plugin setting returns {kind:'blocked',blocked:{code,message,next}}. Return only the result needed. Connected agents supply the one plugin namespace the program may use, as shown by plugin_search. No filesystem, process or direct network APIs. ${pending}`,
  input: z.strictObject({
    ...directInput,
    namespace: id.optional(),
    code: z.string().min(1).max(65536),
  }),
  output: directExecutionOutput,
});
export const plugin_resume = defineAgentTool({
  name: "plugin_resume",
  title: "Resume a plugin execution",
  access: "write",
  callers: executionCallers,
  description:
    "Collect or continue an execution by executionId after the person answers in Needs you. Pass no approval or input answer; only the person can provide those. An id belongs to the task or program that started it. Connected agents include the originating taskId. Pending means wait, without polling. Interrupted or expired means check current state before starting any new work; never rerun blindly.",
  input: z.strictObject({ ...directInput, executionId: id }),
  output: directExecutionOutput,
});
export const opensteer_plugin_list = defineAgentTool({
  name: "opensteer_plugin_list",
  title: "List plugins",
  access: "read",
  callers: ["run", "program", "connection"],
  description:
    "List installed plugins, newest versions, connected account links, agent access and status, and local tools (device data apps and local servers) sharing the tools.<slug> namespace, with tool counts; a server awaiting launch approval appears only here. One list: pass cursor to continue; null ends it. Pass pluginId for that plugin with every kept version. Use plugin_search for callable tools.",
  input: z.strictObject({
    pluginId: id.optional(),
    cursor: z.string().min(1).max(2048).optional(),
  }),
  output: z.object({
    local: z.array(
      z.object({
        id,
        name: z.string(),
        slug: z.string(),
        access: z.enum(["all", "read-only"]),
        status: z.enum(["active", "unavailable"]),
        blocked: BlockedSchema.optional(),
        toolCount: z.number().int().nonnegative(),
        readOnlyToolCount: z.number().int().nonnegative(),
      }),
    ),
    plugins: z.array(
      z.object({
        id,
        name: z.string(),
        slug: z.string(),
        activeVersion: z.string().nullable(),
        versions: z.array(z.object({ id, active: z.boolean() })),
        versionCount: z.number().int().nonnegative(),
        requirements: z.record(
          z.string(),
          z.object({ scope: z.enum(["app", "user"]), provider: z.string() }),
        ),
        access: z.enum(["all", "read-only"]),
        links: z.array(
          z.object({ requirement: z.string(), scope: z.string(), account: z.string() }),
        ),
        status: z.string(),
        blocked: BlockedSchema.optional(),
      }),
    ),
    cursor: z.string().nullable(),
  }),
});
export const opensteer_plugin_install = defineAgentTool({
  name: "opensteer_plugin_install",
  title: "Install a plugin",
  access: "settings",
  callers: ["run", "program"],
  description:
    "Install without approval from a catalog id, a URL (MCP, OpenAPI or GraphQL), or a folder inside Agent home. A folder contains sandboxed TypeScript plugin source, not the old Agent Plugins folder format. Pass pluginId with a folder to deploy a new version. Build errors return as data. OpenAPI warnings explain which operations were left out. The deployed version is the truth. Installation never links an account; that always needs the person. Read opensteer:plugins before writing a plugin.",
  input: z.strictObject({
    source: z.enum(["catalog", "mcp", "openapi", "graphql", "folder"]),
    catalogId: id.optional(),
    url: z.url().optional(),
    name: id.optional(),
    directory: z.string().min(1).max(4096).optional(),
    pluginId: id.optional(),
  }),
  output: z.object({
    status: z.enum(["installed", "build-error"]),
    plugin: object.optional(),
    version: object.optional(),
    error: object.optional(),
    warnings: z.array(z.string()).optional(),
    next: z.string().optional(),
  }),
});
export const opensteer_plugin_export = defineAgentTool({
  name: "opensteer_plugin_export",
  title: "Export plugin source",
  access: "settings",
  callers: ["run", "program"],
  description:
    "Write a deployed plugin version's source into a new folder inside Agent home. Edit that draft and install the folder with pluginId to deploy a new version. Existing folders are refused.",
  input: z.strictObject({
    pluginId: id,
    versionId: id.optional(),
    directory: z.string().min(1).max(4096),
  }),
  output: z.object({ directory: z.string(), files: z.number().int(), next: z.string() }),
});
export const opensteer_plugin_activate = defineAgentTool({
  name: "opensteer_plugin_activate",
  title: "Activate a plugin version",
  access: "settings",
  callers: ["run", "program"],
  description:
    "Make an installed earlier version the running plugin version. Rollback changes code, not plugin data; widened credential destinations require the person to consent again.",
  input: z.strictObject({ pluginId: id, versionId: id }),
  output: z.object({ ok: z.literal(true) }),
});
export const opensteer_plugin_remove = defineAgentTool({
  name: "opensteer_plugin_remove",
  title: "Remove a plugin",
  access: "settings",
  callers: ["run", "program"],
  destructive: true,
  description:
    "Remove an installed plugin. This does not authorize account linking or change another plugin's access.",
  input: z.strictObject({ pluginId: id }),
  output: z.object({ ok: z.literal(true) }),
});
export const plugin_account_request = defineAgentTool({
  name: "plugin_account_request",
  title: "Request a plugin account",
  access: "read",
  callers: ["run", "program"],
  opensRequest: true,
  description:
    "Ask the person in Needs you to connect or link an account to a plugin requirement. Installation needs no approval; account linking always does, including reusing an existing saved account. Never enter, collect or link credentials yourself. Pending is waiting on the person, not permission; continue other work and do not repeat the request.",
  input: z.strictObject({
    pluginId: id,
    requirement: id,
    scope: z.enum(["app", "user"]),
    reason: z.string().min(1).max(4000),
  }),
  output: z.object({ status: z.string(), requestId: id, next: z.string() }),
});
export const opensteer_plugin_catalog = defineAgentTool({
  name: "opensteer_plugin_catalog",
  title: "Find catalog plugins",
  access: "read",
  callers: ["run", "program", "connection"],
  description:
    "Find plugins available to install by service name or purpose. Returns catalog ids, names, one-line descriptions and required account methods. Pass cursor to continue; null ends paging. Use the returned id with opensteer_plugin_install; installation never links an account.",
  input: z.strictObject({
    search: z.string().max(2000).optional(),
    cursor: id.optional(),
    limit: z.number().int().min(1).max(30).optional(),
  }),
  output: z.object({
    items: z.array(
      z.object({ id, name: z.string(), description: z.string(), accounts: z.array(z.string()) }),
    ),
    cursor: z.string().nullable(),
  }),
});
export const plugin_skills = defineAgentTool({
  name: "plugin_skills",
  title: "Read plugin skills",
  access: "read",
  callers: discoveryCallers,
  description:
    "List live plugin skills with {} or {app:namespace}; read one with {app,name}, and a referenced file with {app,name,file}. Use the namespace from plugin_search or opensteer_plugin_list. These skills may depend on linked accounts; a read never links one. Native packaged skills remain available without starting the plugin engine.",
  input: z.strictObject({
    app: id.optional(),
    name: id.optional(),
    file: id.optional(),
    version: id.optional(),
    revision: id.optional(),
  }),
  output: json,
});
export const plugin_resources = defineAgentTool({
  name: "plugin_resources",
  title: "Read plugin background work",
  access: "read",
  callers: ["run", "program", "connection"],
  description:
    "Read a plugin's schedules and runs, workflow declarations and runs (newest first, even if current declarations fail), or webhook subscriptions. The first page carries schedule/workflow definitions with names and input schemas for configuration and starting; null means current definitions could not be evaluated, while durable runs remain readable. Pass the returned next cursor for older runs. Run outputs are shown only to your own tasks while the plugin is on; otherwise a run shows what ran, when and how it ended. These reads do not start work or reveal webhook setup secrets. Scheduled approval answers and manual webhook setup/cleanup confirmation belong to the person in Plugins.",
  input: z.strictObject({
    pluginId: id,
    resource: z.enum(["schedules", "workflows", "webhooks"]),
    cursor: z.string().max(512).optional(),
  }),
  output: json,
});
export const opensteer_plugin_resource_update = defineAgentTool({
  name: "opensteer_plugin_resource_update",
  title: "Manage plugin background work",
  access: "settings",
  callers: ["run", "program"],
  openWorld: true,
  description:
    "Configure a declared schedule, run it now, start or stop a workflow, or remove a webhook subscription. Read plugin_resources first for current identities; cursor paging keeps every live workflow reachable. Starting a workflow needs a unique key: reusing that key recovers the same start. Manual provider cleanup and its confirmation, scheduled approval settings and answers, webhook secret setup and account links remain person-only.",
  input: z.strictObject({
    pluginId: id,
    change: z.discriminatedUnion("action", [
      z.strictObject({
        action: z.literal("schedule.configure"),
        schedule: id,
        enabled: z.boolean(),
      }),
      z.strictObject({ action: z.literal("schedule.run"), schedule: id, scheduleId: id }),
      z.strictObject({ action: z.literal("workflow.start"), workflow: id, input: json, key: id }),
      z.strictObject({ action: z.literal("workflow.stop"), runId: id }),
      z.strictObject({ action: z.literal("webhook.remove"), webhookId: id }),
    ]),
  }),
  output: json,
});
export const pluginTools = [
  plugin_search,
  opensteer_plugin_catalog,
  plugin_skills,
  plugin_resources,
  opensteer_plugin_resource_update,
  plugin_describe,
  plugin_call,
  plugin_execute,
  plugin_resume,
  opensteer_plugin_list,
  opensteer_plugin_install,
  opensteer_plugin_export,
  opensteer_plugin_activate,
  opensteer_plugin_remove,
  plugin_account_request,
] as const;
