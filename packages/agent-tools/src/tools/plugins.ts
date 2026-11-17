import { z } from "zod";
import { defineAgentTool } from "../registry.js";

const id = z.string().min(1).max(256);
const json = z.json();
const object = z.record(z.string(), json);
const searchInput = z.strictObject({
  query: z.string().max(2000).optional(),
  namespace: id.optional(),
  limit: z.number().int().min(1).max(100).optional(),
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
  "Waiting on the person opens Needs you. Never answer it yourself or repeat a call/program to continue it; after the person answers use plugin_resume with executionId. Earlier effects are not rolled back.";
const discoveryCallers = ["run", "program", "connection"] as const;
const executionCallers = ["run", "program"] as const;
export const plugin_search = defineAgentTool({
  name: "plugin_search",
  title: "Find plugin tools",
  access: "read",
  callers: discoveryCallers,
  description:
    "Find plugin tools by words in their paths, descriptions and labels. Returns exact paths, one-line descriptions and input types, with plugins and linked accounts listed once. Pass a path to plugin_call or plugin_describe, or use tools.<plugin>.<tool>() in plugin_execute. Omit query to list a namespace. Read the following page by passing next as the whole input; null ends paging. Approved device data apps (Calendar, Contacts, Reminders, Messages, iPhone Location and Photos) and local servers are plugins too, with stable namespaces returned by discovery; an unavailable one says why.",
  input: searchInput,
  output: z.object({
    items: z.array(
      z.object({
        path: id,
        description: z.string(),
        input: z.string(),
        inputTruncated: z.literal(true).optional(),
      }),
    ),
    namespaces: z.array(object),
    remaining: z.number(),
    next: searchInput.nullable(),
    unavailableApps: z.array(object).optional(),
  }),
});
export const plugin_describe = defineAgentTool({
  name: "plugin_describe",
  title: "Describe plugin tools",
  access: "read",
  callers: discoveryCallers,
  description:
    "Read the whole description and TypeScript signature, including input and output types, for exact paths from plugin_search. Unknown paths appear in missing with closest paths.",
  input: z.strictObject({ paths: z.array(id).min(1).max(100) }),
  output: z.object({
    items: z.array(z.object({ path: id, description: z.string(), signature: z.string() })),
    namespaces: z.array(object),
    missing: z.array(z.object({ path: id, matches: z.array(z.string()) })),
  }),
});
const call = z.strictObject({ path: id, input: json });
export const plugin_call = defineAgentTool({
  name: "plugin_call",
  title: "Call plugin tools",
  access: "write",
  callers: executionCallers,
  openWorld: true,
  description: `Call plugin tools at exact paths from plugin_search. Pass one {path,input} as calls, or an array of independent calls to run concurrently; results keep that order with ok and value or error. Use plugin_execute when output feeds another call or to filter large results. Accounts connect through plugin_account_request; never collect secrets in chat. ${pending}`,
  input: z.strictObject({ calls: z.union([call, z.array(call).min(1).max(100)]) }),
  output: executionOutput,
});
export const plugin_execute = defineAgentTool({
  name: "plugin_execute",
  title: "Run a plugin program",
  access: "write",
  callers: executionCallers,
  openWorld: true,
  description: `Run a short JavaScript program over tools.<plugin>.<tool>() when one result feeds another call or large results should be filtered before reaching you. For one or a few independent calls use plugin_call. Discover with plugin_search or tools.search, and full signatures with plugin_describe or tools.search.describe({paths}). First read opensteer:plugins and its code mode reference. Return only the result needed. No filesystem, process or direct network APIs. ${pending}`,
  input: z.strictObject({ code: z.string().min(1).max(65536) }),
  output: executionOutput,
});
export const plugin_resume = defineAgentTool({
  name: "plugin_resume",
  title: "Resume a plugin execution",
  access: "write",
  callers: executionCallers,
  description:
    "Collect or continue an execution by executionId after the person answers in Needs you. Pass no approval or input answer; only the person can provide those. An id belongs to the task or program that started it; a later Run of that task can resume. Pending means wait, without polling. Interrupted or expired means check current state before starting any new work; never rerun blindly.",
  input: z.strictObject({ executionId: id }),
  output: executionOutput,
});
export const opensteer_plugin_list = defineAgentTool({
  name: "opensteer_plugin_list",
  title: "List plugins",
  access: "read",
  callers: ["run", "connection"],
  description:
    "List installed plugins, newest versions, connected account links, agent access and status, and the person's local tools (device data apps and local servers) that share the tools.<slug> namespace, with tool counts. Plugins page: pass cursor to continue; null ends it, and local tools come with the first page. Pass pluginId for that plugin with every kept version. Use plugin_search for callable tools.",
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
        unavailable: z.string().optional(),
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
      }),
    ),
    cursor: z.string().nullable(),
  }),
});
export const opensteer_plugin_install = defineAgentTool({
  name: "opensteer_plugin_install",
  title: "Install a plugin",
  access: "settings",
  callers: ["run"],
  description:
    "Install without approval from a catalog id, a URL (MCP, OpenAPI or GraphQL), or a folder inside Agent home. A folder contains sandboxed TypeScript plugin source, not the old Agent Plugins folder format. Pass pluginId with a folder to deploy a new version. Build errors return as data: fix the draft and install again. The deployed version is the truth. Installation never links an account; that always needs the person. Read opensteer:plugins before writing a plugin.",
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
    next: z.string().optional(),
  }),
});
export const opensteer_plugin_export = defineAgentTool({
  name: "opensteer_plugin_export",
  title: "Export plugin source",
  access: "settings",
  callers: ["run"],
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
  callers: ["run"],
  description:
    "Make an installed earlier version the running plugin version. Rollback changes code, not plugin data; widened credential destinations require the person to consent again.",
  input: z.strictObject({ pluginId: id, versionId: id }),
  output: z.object({ ok: z.literal(true) }),
});
export const opensteer_plugin_remove = defineAgentTool({
  name: "opensteer_plugin_remove",
  title: "Remove a plugin",
  access: "settings",
  callers: ["run"],
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
  callers: ["run"],
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
  callers: ["run", "connection"],
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
  callers: ["run", "connection"],
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
  callers: ["run"],
  openWorld: true,
  description:
    "Configure a declared schedule, run it now, start or stop a workflow, or remove a webhook subscription. Read plugin_resources first for current identities; cursor paging keeps every live workflow reachable. Starting a workflow needs a unique key: reusing that key recovers the same start. Manual provider cleanup and its confirmation, scheduled approval answers, webhook secret setup and account links remain person-only.",
  input: z.strictObject({
    pluginId: id,
    change: z.discriminatedUnion("action", [
      z.strictObject({
        action: z.literal("schedule.configure"),
        schedule: id,
        enabled: z.boolean(),
        approvalMode: z.enum(["browser", "automatic"]).optional(),
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
