import { defineAgentTool } from "../registry.js";

import { z } from "zod";

import { OperationKeySchema, CursorSchema, WorkspaceCreateInputSchema } from "./inputs.js";
import {
  ProjectListOutputSchema,
  ProjectCreateOutputSchema,
  PluginInstallOutputSchema,
} from "./outputs.js";
export const project_list = defineAgentTool({
  name: "project_list",
  title: "List Projects",
  description:
    "To find accessible Workspaces, use project_list; pass window.nextBefore as before for earlier entries.",
  input: z.strictObject({
    before: CursorSchema.optional(),
    limit: z.number().int().min(1).max(50).default(25),
  }),
  output: ProjectListOutputSchema,
  access: "read",
  callers: ["run", "program", "connection"] as const,
});

export const project_create = defineAgentTool({
  name: "project_create",
  title: "Create Project",
  description:
    "Create a Project inside its owner's Main folder. Main's computer must be connected. Returns the Project id, immutable slug and absolute folder path. Use ordinary file tools at that path to write AGENTS.md before delegating the first task.",
  input: WorkspaceCreateInputSchema.safeExtend({ operationKey: OperationKeySchema.optional() }),
  output: ProjectCreateOutputSchema,
  access: "settings",
  callers: ["run", "program", "connection"] as const,
});

export const plugin_install = defineAgentTool({
  name: "plugin_install",
  title: "Install plugin",
  description:
    "Install an Agent Plugins 1.0 folder inside your own Workspace and activate its skills here. Use a relative path; symlinks are refused. Installing grants no connection access. Local MCP servers require the computer owner's approval.",
  input: z
    .strictObject({ directory: z.string().min(1).max(4096) })
    .safeExtend({ operationKey: OperationKeySchema.optional() }),
  output: PluginInstallOutputSchema,
  access: "settings",
  callers: ["run"] as const,
});
