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
    "Find plugin tools by words in their paths, descriptions and labels. Returns exact paths, one-line descriptions and input types, with plugins and linked accounts listed once. Pass a path to plugin_call or plugin_describe, or use tools.<plugin>.<tool>() in plugin_execute. Omit query to list a namespace. Read the following page by passing next as the whole input; null ends paging.",
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
    "List installed plugins, active versions, connected account links, agent access and status. Use plugin_search for callable tools.",
  input: z.strictObject({}),
  output: z.object({
    plugins: z.array(
      z.object({
        id,
        name: z.string(),
        slug: z.string(),
        activeVersion: z.string().nullable(),
        versions: z.array(z.object({ id, active: z.boolean() })),
        requirements: z.record(
          z.string(),
          z.object({ scope: z.enum(["app", "user"]), provider: z.string() }),
        ),
        access: z.enum(["all", "read-only"]),
        links: z.array(object),
        status: z.string(),
      }),
    ),
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
export const pluginTools = [
  plugin_search,
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
