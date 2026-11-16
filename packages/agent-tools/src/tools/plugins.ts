import { RunnerIdSchema } from "@opensteer/core";
import { z } from "zod";
import { defineAgentTool } from "../registry.js";
import { PluginInstallOutputSchema } from "./outputs.js";

const pluginId = z.string().min(1).max(256);
export const opensteer_plugin_list = defineAgentTool({
  name: "opensteer_plugin_list",
  title: "List plugins",
  description: "List the person's installed plugins.",
  input: z.strictObject({}),
  output: z.object({
    plugins: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        currentVersionId: z.string().nullable().optional(),
      }),
    ),
  }),
  access: "read",
  callers: ["run", "connection"] as const,
});

export const opensteer_plugin_install = defineAgentTool({
  name: "opensteer_plugin_install",
  title: "Install a plugin",
  description:
    "Install an Agent Plugins 1.0 folder from Agent home, or install it again to update it; symlinks are refused. To update a plugin the person installed, also pass its pluginId and, if its folder is on another computer, that computerId. Skills become available to the owner; resource grants and local MCP launch approval need the person.",
  input: z
    .strictObject({
      directory: z
        .string()
        .min(1)
        .max(4096)
        .describe("Plugin folder, relative to Agent home unless pluginId is given."),
      pluginId: pluginId.optional().describe("A person-installed plugin to update."),
      computerId: RunnerIdSchema.optional().describe(
        "With pluginId: the computer holding the folder; omit to keep its current place.",
      ),
    })
    .refine((input) => input.pluginId !== undefined || input.computerId === undefined, {
      message: "computerId is only for updating a plugin by pluginId",
      path: ["computerId"],
    }),
  output: PluginInstallOutputSchema,
  access: "settings",
  callers: ["run", "connection"] as const,
});

export const opensteer_plugin_update = defineAgentTool({
  name: "opensteer_plugin_update",
  title: "Turn a plugin on or off",
  description:
    "Turn an installed plugin on or off. Turning it on grants no resource access; local MCP launch approval needs the person.",
  input: z.strictObject({ pluginId, enabled: z.boolean() }),
  output: z.object({ ok: z.literal(true) }),
  access: "settings",
  callers: ["run", "connection"] as const,
});

export const opensteer_plugin_remove = defineAgentTool({
  name: "opensteer_plugin_remove",
  title: "Remove a plugin",
  description: "Remove an installed plugin.",
  input: z.strictObject({ pluginId }),
  output: z.object({ ok: z.literal(true) }),
  access: "settings",
  callers: ["run", "connection"] as const,
  destructive: true,
});

export const pluginTools = [
  opensteer_plugin_list,
  opensteer_plugin_install,
  opensteer_plugin_update,
  opensteer_plugin_remove,
] as const;
