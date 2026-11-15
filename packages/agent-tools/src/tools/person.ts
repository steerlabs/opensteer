import { defineAgentTool } from "../registry.js";
import { PersonMessageSchema, ThreadIdSchema, BrowserSurfaceIdSchema } from "@opensteer/core";

import { z } from "zod";

import { PersonMessageOutputSchema, PersonShowOutputSchema } from "./outputs.js";
export const person_notify = defineAgentTool({
  name: "person_notify",
  title: "Update the person",
  description:
    "Send worthwhile news to this Run’s requester while work continues; it may notify their devices. Refused on a delegation: ask the delegating task to tell the person. On a background wake, use it only for news worth interrupting the person for; send finds a task asked for to that task with opensteer_task_send queue, and otherwise just say briefly what happened in your final reply. Put the completed answer in your final reply without a duplicate update.",
  input: z.strictObject({ message: PersonMessageSchema }),
  output: PersonMessageOutputSchema,
  access: "write",
  callers: ["run"] as const,
});

export const person_show = defineAgentTool({
  name: "person_show",
  title: "Show a tab or task",
  description:
    "Ask devices viewing this task to bring an explicit tab or task into view. tabId comes from tab_list or tab_open; taskId comes from opensteer_task_list or opensteer_task_read. Asleep tabs may wake. A closed or unavailable target is not replaced. Delegated tasks send the destination to their delegating task. sent-unconfirmed means delivery, not proof the person saw it.",
  input: z.strictObject({
    target: z.union([
      z.strictObject({
        tabId: BrowserSurfaceIdSchema.describe(
          "Tab ID(s) from tab_list, tab_open, or a bound computer_use handle.",
        ),
      }),
      z.strictObject({
        taskId: ThreadIdSchema.describe("Task ID from opensteer_task_list or opensteer_task_read."),
      }),
    ]),
  }),
  output: PersonShowOutputSchema,
  access: "write",
  callers: ["run"] as const,
  capability: "tabs",
});
