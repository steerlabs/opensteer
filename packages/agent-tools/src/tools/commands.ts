import { RequestIdSchema, ThreadIdSchema } from "@opensteer/core";
import { z } from "zod";
import { defineAgentTool } from "../registry.js";

/** How the Home answers a command for this caller: it runs, it asks the person, or it depends. */
const CommandAnswerSchema = z.enum(["now", "ask", "now or ask"]);

export const opensteer_commands = defineAgentTool({
  name: "opensteer_commands",
  title: "List what you can change",
  description:
    "List what you can change in Opensteer. No input: the families. family: its commands, each now or asks the person. type: one command's input. A command not listed is unavailable. What is set up now is in opensteer_state.",
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
] as const;

export type StateArea = (typeof stateAreas)[number];

/**
 * What a connection's grant lets it see of `opensteer_state`, the one function its listing, its
 * description and the Home's answer read (rule 5): no chats for any connection (they are other
 * connections), and for a selected grant no settings or engines, and devices
 * only with a computer app it was given.
 */
export function connectionStateAreas(
  grant:
    | { readonly scope: "everything" }
    | { readonly scope: "selected"; readonly resources: readonly { readonly kind: string }[] },
): readonly StateArea[] {
  return stateAreas.filter((area) => {
    if (area === "chats") return false;
    if (grant.scope === "everything") return true;
    if (area === "settings" || area === "engines") return false;
    if (area === "devices")
      return grant.resources.some((resource) => resource.kind === "computer-app");
    return true;
  });
}

const stateAreaWords: Readonly<Record<StateArea, string>> = {
  settings: "settings: the person's settings.",
  connections:
    "connections: connected agents (the other AI apps the person connected) and what each may use.",
  devices: "devices: the person's devices and what each allows.",
  chats: "chats: chat accounts and their chats.",
  engines: "engines: AI engine accounts.",
  requests: "requests: what waits for the person.",
  activity: "activity: what agents did.",
};
const stateLead =
  "See what is set up in Opensteer now, as the person's apps show it, cut to what you may see.";

/** The state tool's description for a connection: only the areas it may read. */
export function connectionStateDescription(areas: readonly StateArea[]): string {
  const words = areas.map((area) =>
    area === "connections"
      ? "connections: this connection and what it may use."
      : area === "devices"
        ? "devices: the devices of the apps you were given."
        : stateAreaWords[area],
  );
  return [stateLead, ...words, "An area you cannot see is unavailable."].join(" ");
}

export const opensteer_state = defineAgentTool({
  name: "opensteer_state",
  title: "See what is set up",
  description:
    "See what is set up in Opensteer now, as the person's apps show it, cut to what you may see. connections: connected agents (the other AI apps the person connected) and what each may use. devices: the person's devices and what each allows. chats: chat accounts and their chats. engines: AI engine accounts. requests: what waits for the person. activity: what agents did. settings. Read here what another agent, a device or a chat can use. An area you cannot see is unavailable.",
  input: z.strictObject({ area: z.enum(stateAreas) }),
  output: z.object({ area: z.string(), view: z.record(z.string(), z.unknown()) }),
  access: "read",
  callers: ["run", "program", "connection"] as const,
});

export const commandTools = [opensteer_commands, opensteer_command, opensteer_state] as const;
