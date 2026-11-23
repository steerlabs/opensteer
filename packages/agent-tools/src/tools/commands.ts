import { RequestIdSchema, ThreadIdSchema } from "@opensteer/core";
import { z } from "zod";
import { defineAgentTool } from "../registry.js";

/** How the Home answers a command for this caller: it runs, it asks the person, or it depends. */
const CommandAnswerSchema = z.enum(["now", "ask", "now or ask"]);

export const opensteer_commands = defineAgentTool({
  name: "opensteer_commands",
  title: "List what you can change",
  description:
    "List what you can change in Opensteer. No input: the families. family: its commands, each now or asks the person. type: one command's input. A command not listed is unavailable.",
  input: z.strictObject({
    family: z.string().min(1).max(40).optional(),
    type: z.string().min(1).max(100).optional(),
  }),
  output: z.union([
    z.object({
      families: z.array(
        z.object({
          family: z.string(),
          title: z.string(),
          now: z.number().int(),
          ask: z.number().int(),
        }),
      ),
    }),
    z.object({
      family: z.string(),
      commands: z.array(
        z.object({ type: z.string(), title: z.string(), answer: CommandAnswerSchema }),
      ),
    }),
    z.object({
      type: z.string(),
      title: z.string(),
      answer: CommandAnswerSchema,
      input: z.record(z.string(), z.unknown()),
    }),
  ]),
  access: "read",
  callers: ["run", "program", "connection"] as const,
});

export const opensteer_command = defineAgentTool({
  name: "opensteer_command",
  title: "Change Opensteer",
  description:
    "Send one command from opensteer_commands. One that asks the person returns pending with a Request; they may change it before approving. Leave secret fields out. withdraw: take back your own pending Request.",
  input: z.strictObject({
    command: z
      .object({ type: z.string().min(1).max(100) })
      .catchall(z.unknown())
      .optional(),
    reason: z.string().trim().min(1).max(500).optional(),
    withdraw: RequestIdSchema.optional(),
    /** A connected agent: its direct-work task, and the operation a pending call returned. */
    taskId: ThreadIdSchema.optional(),
  }),
  output: z.union([
    z.object({ status: z.literal("done"), result: z.unknown().optional() }),
    z.object({
      status: z.literal("pending"),
      requestId: RequestIdSchema,
      next: z.string(),
    }),
    z.object({
      status: z.enum(["declined", "withdrawn", "closed"]),
      requestId: RequestIdSchema,
    }),
    z.object({
      status: z.literal("answered"),
      requestId: RequestIdSchema,
      outcome: z.object({ status: z.string() }).catchall(z.unknown()),
    }),
  ]),
  access: "write",
  callers: ["run", "program", "connection"] as const,
  opensRequest: true,
});

/** The areas of Opensteer an agent may read, each as the person's apps read it. */
export const stateAreas = [
  "settings",
  "connections",
  "devices",
  "chats",
  "engines",
  "requests",
  "activity",
  "policy",
] as const;

export const opensteer_state = defineAgentTool({
  name: "opensteer_state",
  title: "Read Opensteer",
  description:
    "Read one area of Opensteer as the person's apps show it, cut to what you may see: settings, connections, devices, chats, engines, requests, activity or policy. An area you cannot see is unavailable.",
  input: z.strictObject({ area: z.enum(stateAreas) }),
  output: z.object({ area: z.string(), view: z.record(z.string(), z.unknown()) }),
  access: "read",
  callers: ["run", "program", "connection"] as const,
});

export const commandTools = [opensteer_commands, opensteer_command, opensteer_state] as const;
