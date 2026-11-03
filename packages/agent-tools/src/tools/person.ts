import { defineAgentTool } from "../registry.js";
import { PersonMessageSchema, PersonShowTargetSchema } from "@opensteer/core";

import { z } from "zod";

import { OperationKeySchema } from "./inputs.js";
import { PersonMessageOutputSchema, PersonShowOutputSchema } from "./outputs.js";
export const person_message = defineAgentTool({
  name: "person_message",
  title: "Message Person",
  description:
    "Post a message to this Run's requester as its own row in this Thread while work continues. It may alert their devices; a client already showing this Thread's latest activity stays silent. Put the final answer in your final reply.",
  input: z
    .strictObject({ message: PersonMessageSchema })
    .safeExtend({ operationKey: OperationKeySchema.optional() }),
  output: PersonMessageOutputSchema,
  access: "self",
  callers: ["run"] as const,
});

export const person_show = defineAgentTool({
  name: "person_show",
  title: "Show Person",
  description:
    "Open a saved tab (tabId from browser_tab_read), a Thread, or {current: true} (this Run's current tab, app or phone) on the person's devices showing this conversation. Delivery is unconfirmed.",
  input: z
    .strictObject({ target: PersonShowTargetSchema })
    .safeExtend({ operationKey: OperationKeySchema.optional() }),
  output: PersonShowOutputSchema,
  access: "self",
  callers: ["run"] as const,
});
