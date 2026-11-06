import { defineAgentTool } from "../registry.js";
import { PersonMessageSchema, PersonShowTargetSchema } from "@opensteer/core";

import { z } from "zod";

import { OperationKeySchema } from "./inputs.js";
import { PersonMessageOutputSchema, PersonShowOutputSchema } from "./outputs.js";
export const person_message = defineAgentTool({
  name: "person_message",
  title: "Update the person",
  description:
    "Send worthwhile news to this Run’s requester while work continues. May notify devices. Refused on Assignments: ask the assigner to tell the person. Put the completed answer in your final reply without a duplicate update.",
  input: z
    .strictObject({ message: PersonMessageSchema })
    .safeExtend({ operationKey: OperationKeySchema.optional() }),
  output: PersonMessageOutputSchema,
  access: "write",
  callers: ["run"] as const,
});

export const person_show = defineAgentTool({
  name: "person_show",
  title: "Show a place",
  description:
    "Bring your work into the person's view without waiting to be asked, on devices viewing this conversation. `{current: true}`: the page, Mac app or Agent Phone you are in, with no new browser attach or computer observation. `{runId}`: where a task's Run last worked, from `recentPlaces` in `thread_read`. `{tabId}`: a saved tab, even asleep, from `browser_tab_read` or a Browser Harness `surfaceId`. `{threadId}`: a Thread. Refused on Assignments: tell the assigner what to show. `sent-unconfirmed` is not proof anyone saw it.",
  input: z
    .strictObject({ target: PersonShowTargetSchema })
    .safeExtend({ operationKey: OperationKeySchema.optional() }),
  output: PersonShowOutputSchema,
  access: "write",
  callers: ["run"] as const,
});
