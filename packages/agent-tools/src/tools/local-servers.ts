import { z } from "zod";
import { DeviceIdSchema } from "@opensteer/core";
import { OperationKeySchema } from "./inputs.js";
import { defineAgentTool } from "../registry.js";

const name = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u)
  .refine((value) => !value.includes("--"), "Use single hyphens")
  .describe("Lowercase letters, digits and single hyphens; its tools are found under this name.");
const secret = z.strictObject({
  name: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u)
    .describe("Environment variable the program reads."),
  title: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(240).optional(),
});
const server = z.object({
  name: z.string(),
  pluginId: z.string(),
  path: z.string(),
  computer: z.string().nullable(),
  computerId: DeviceIdSchema.nullable(),
  kind: z.enum(["program", "loopback"]),
  state: z.enum(["approved", "waiting", "declined", "unavailable"]),
  detail: z.string().optional(),
  device: z.object({ name: z.string(), kind: z.string() }).optional(),
});

export const local_server_add = defineAgentTool({
  name: "local_server_add",
  title: "Add a local server",
  access: "settings",
  callers: ["run"],
  description:
    "Register, or update by the same name, an MCP server that runs on one of the person's computers: a program to launch, or a loopback URL that computer serves. The person reviews the exact launch and computer and enters declared secrets; its tools then appear in plugin_search under its name. folder is a package inside Agent home whose snapshot that computer runs: start its program with ./path, and use ${PLUGIN_ROOT} and ${PLUGIN_DATA} in args, env or cwd. Declare secrets by name only, never values. device marks a TV, speaker or light it controls. A changed launch on the same computer keeps approval unless it adds secrets.",
  input: z
    .strictObject({
      name,
      operationKey: OperationKeySchema.optional(),
      description: z.string().trim().max(500).optional(),
      computerId: DeviceIdSchema.optional().describe(
        "Computer ID from computer_list. For a new server, omit to use the computer hosting tasks. An update keeps its existing computer while enrolled.",
      ),
      launch: z
        .strictObject({
          command: z
            .string()
            .min(1)
            .max(4096)
            .describe("One executable on PATH, or ./path inside folder."),
          args: z.array(z.string().max(32_768)).max(256).optional(),
          env: z
            .record(z.string().min(1).max(256), z.string().max(32_768))
            .optional()
            .describe("Non-secret settings only."),
          cwd: z.string().max(4096).optional().describe("./, ${PLUGIN_ROOT} or ${PLUGIN_DATA}."),
          secrets: z.array(secret).min(1).max(16).optional(),
        })
        .optional(),
      url: z
        .url()
        .optional()
        .describe("http://127.0.0.1:<port>/… or another loopback URL on that computer."),
      folder: z.string().min(1).max(4096).optional(),
      device: z
        .strictObject({
          name: z.string().trim().min(1).max(80),
          kind: z.enum(["tv", "speaker", "light", "camera", "other"]),
        })
        .optional(),
    })
    .refine((input) => (input.launch === undefined) !== (input.url === undefined), {
      message: "Pass launch or url",
      path: ["launch"],
    }),
  output: z.object({
    server: server.optional(),
    issues: z.array(z.string()),
    next: z.string(),
  }),
});
export const local_server_list = defineAgentTool({
  name: "local_server_list",
  title: "List local servers",
  access: "read",
  callers: ["run", "program", "connection"],
  description:
    "List registered local servers: computer, whether the person approved them there, and the path its tools have in plugin_search. Never shows launch details or secrets.",
  input: z.strictObject({}),
  output: z.object({ servers: z.array(server) }),
});
export const local_server_remove = defineAgentTool({
  name: "local_server_remove",
  title: "Remove a local server",
  access: "settings",
  callers: ["run"],
  destructive: true,
  description:
    "Remove a local server and its data, such as a device pairing, on the Host and on every computer that ran it. A computer that is offline removes it when it reconnects.",
  input: z.strictObject({ name, operationKey: OperationKeySchema.optional() }),
  output: z.object({ ok: z.literal(true) }),
});
export const localServerTools = [local_server_add, local_server_list, local_server_remove] as const;
