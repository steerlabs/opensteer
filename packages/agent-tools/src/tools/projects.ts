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
  title: "Find Projects",
  description:
    "Find reachable Workspaces with IDs and paging window; pass window.nextBefore as before. Tasks use thread_list; engines/models use environment_list.",
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
  minimumReach: "user",
  title: "Create a Project",
  description:
    "Create a durable Project in the owner’s Main folder. Full-access; Main’s computer must be online. Returns id, immutable slug and absolute path. Write AGENTS.md there before first delegation. Grants no integration/browser access.",
  input: WorkspaceCreateInputSchema.safeExtend({ operationKey: OperationKeySchema.optional() }),
  output: ProjectCreateOutputSchema,
  access: "settings",
  callers: ["run", "program", "connection"] as const,
});

export const plugin_install = defineAgentTool({
  name: "plugin_install",
  title: "Install a plugin",
  description:
    "Install a Workspace-relative Agent Plugins 1.0 folder; symlinks refused. Full-access Run only. Call again on the same folder to update it. Returns installation/activation, issues and specialist state. Skills activate here; resource grants and local MCP launch approval need the person.",
  input: z
    .strictObject({ directory: z.string().min(1).max(4096) })
    .safeExtend({ operationKey: OperationKeySchema.optional() }),
  output: PluginInstallOutputSchema,
  access: "settings",
  callers: ["run"] as const,
});
