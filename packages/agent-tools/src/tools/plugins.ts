import { defineAgentTool } from "../registry.js";
import { z } from "zod";
import { OperationKeySchema } from "./inputs.js";
import { PluginInstallOutputSchema } from "./outputs.js";
export const plugin_install = defineAgentTool({
  name: "plugin_install",
  title: "Install a plugin",
  description:
    "Install an Agent-home-relative Agent Plugins 1.0 folder; symlinks refused. Full-access Run only. Call again on the same folder to update it. Returns installation, issues and specialist state. Skills are available to the owner; resource grants and local MCP launch approval need the person.",
  input: z
    .strictObject({ directory: z.string().min(1).max(4096) })
    .safeExtend({ operationKey: OperationKeySchema.optional() }),
  output: PluginInstallOutputSchema,
  access: "settings",
  callers: ["run"] as const,
});
