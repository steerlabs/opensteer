import { defineAgentTool } from "../registry.js";
import { PersonMessageSchema, PersonShowTargetSchema } from "@opensteer/core";

import { z } from "zod";

import { OperationKeySchema } from "./inputs.js";
import { PersonMessageOutputSchema, PersonShowOutputSchema } from "./outputs.js";
export const person_message = defineAgentTool({
  name: "person_message",
  title: "Update the person",
  description:
    "Send worthwhile news to this Run’s requester while work continues. Returns messageId; may notify devices. Run-only, refused on Assignments: ask the assigner to tell the person. Put the completed answer in your final reply without a duplicate update.",
  input: z
    .strictObject({ message: PersonMessageSchema })
    .safeExtend({ operationKey: OperationKeySchema.optional() }),
  output: PersonMessageOutputSchema,
  access: "self",
  callers: ["run"] as const,
});

export const person_show = defineAgentTool({
  name: "person_show",
  title: "Show a place",
  description:
    "Ask devices viewing this conversation to open a saved tab, Thread or current Run place. Run-only, refused on Assignments. Copy tabId from browser_tab_read or use {current: true}; never invent native IDs. Returns sent-unconfirmed/device count, not proof of viewing.",
  input: z
    .strictObject({ target: PersonShowTargetSchema })
    .safeExtend({ operationKey: OperationKeySchema.optional() }),
  output: PersonShowOutputSchema,
  access: "self",
  callers: ["run"] as const,
});
