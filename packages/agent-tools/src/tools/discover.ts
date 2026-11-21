import { ThreadIdSchema } from "@opensteer/core";
import { z } from "zod";
import { defineAgentTool } from "../registry.js";

const item = z.object({
  id: z.string(),
  kind: z.enum([
    "browser-profile",
    "chrome-tabs",
    "app",
    "phone",
    "plugin",
    "task",
    "tab",
    "device",
    "tool",
    "document",
  ]),
  name: z.string(),
  use: z.object({
    tool: z.enum(["discover", "browser_use", "computer_use", "plugin_call", "opensteer_task_read"]),
    argument: z.string(),
    value: z.string(),
    computerId: z.string().optional(),
  }),
  computer: z.string().optional(),
  appId: z.string().optional(),
  reachable: z.boolean().optional(),
  access: z.enum(["read-only", "read-write"]).optional(),
  status: z.string().optional(),
  description: z.string().optional(),
  input: z.string().optional(),
  signature: z.string().optional(),
  text: z.string().optional(),
  untrusted: z.literal(true).optional(),
});

export type DiscoverItem = z.output<typeof item>;

export const discover = defineAgentTool({
  name: "discover",
  title: "Discover shared resources",
  description:
    "Find what is shared with you. Pass back an id to see details, or the cursor for more.",
  input: z.strictObject({
    id: z.string().optional(),
    query: z.string().trim().min(1).max(200).optional(),
    cursor: z.string().min(1).max(4096).optional(),
    taskId: ThreadIdSchema.optional(),
  }),
  output: z.object({
    item: item.optional(),
    items: z.array(item),
    nextCursor: z.string().nullable(),
    status: z.enum(["completed", "pending", "failed", "unknown"]).optional(),
    taskId: ThreadIdSchema.optional(),
    operationId: z.string().optional(),
  }),
  access: "read",
  callers: ["connection"],
});
