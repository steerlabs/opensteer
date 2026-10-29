// Derived from github.com/UsefulSoftwareCo/executor packages/plugins/mcp/src/sdk/types.ts (MIT).
import { z } from "zod";

const CommonSchema = {
  timeoutMs: z.number().int().positive().max(120_000).default(30_000),
};

export const McpAdapterConfigSchema = z.discriminatedUnion("transport", [
  z.strictObject({
    ...CommonSchema,
    endpoint: z.url(),
    headers: z.record(z.string(), z.string()).optional(),
    query: z.record(z.string(), z.string()).optional(),
    transport: z.literal("remote"),
  }),
  z.strictObject({
    ...CommonSchema,
    args: z.array(z.string()).optional(),
    command: z.string().trim().min(1),
    cwd: z.string().min(1).optional(),
    env: z.record(z.string(), z.string()).optional(),
    transport: z.literal("stdio"),
  }),
]);

export type McpAdapterConfig = z.infer<typeof McpAdapterConfigSchema>;
