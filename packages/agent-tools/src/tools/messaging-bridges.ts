import { z } from "zod";
import { IntegrationConnectionIdSchema } from "@opensteer/integration-core";
import { defineAgentTool } from "../registry.js";

export const opensteer_messaging_bridge_list = defineAgentTool({
  name: "opensteer_messaging_bridge_list",
  title: "List messaging bridges",
  description:
    "List the person's messaging bridges, which bring outside messages into tasks, and the routes each one has.",
  input: z.strictObject({}),
  output: z.object({
    bridges: z.array(
      z.object({
        bridgeId: z.string(),
        name: z.string(),
        provider: z.string().optional(),
        status: z.string(),
        routes: z.array(z.object({ routeId: z.string(), status: z.string() })),
      }),
    ),
  }),
  access: "read",
  callers: ["run", "connection"] as const,
});

export const opensteer_messaging_bridge_update = defineAgentTool({
  name: "opensteer_messaging_bridge_update",
  title: "Pause a messaging bridge",
  description:
    "Pause a messaging bridge so its messages stop reaching tasks, or resume it. New bridges, identity links, credentials and route grants need the person.",
  input: z.strictObject({ bridgeId: IntegrationConnectionIdSchema, paused: z.boolean() }),
  output: z.object({ ok: z.literal(true) }),
  access: "settings",
  callers: ["run", "connection"] as const,
});

export const opensteer_messaging_bridge_remove = defineAgentTool({
  name: "opensteer_messaging_bridge_remove",
  title: "Remove a messaging route",
  description:
    "Remove one route of a messaging bridge, so the chats it matched stop reaching tasks. Adding it back needs the person.",
  input: z.strictObject({ routeId: z.string().min(1).max(256) }),
  output: z.object({ ok: z.literal(true) }),
  access: "settings",
  callers: ["run", "connection"] as const,
  destructive: true,
});

export const messagingBridgeTools = [
  opensteer_messaging_bridge_list,
  opensteer_messaging_bridge_update,
  opensteer_messaging_bridge_remove,
] as const;
