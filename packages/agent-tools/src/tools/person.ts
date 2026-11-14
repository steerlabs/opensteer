import { defineAgentTool } from "../registry.js";
import {
  PersonMessageSchema,
  ThreadIdSchema,
  RunIdSchema,
  BrowserSurfaceIdSchema,
} from "@opensteer/core";

import { z } from "zod";

import { PersonMessageOutputSchema, PersonShowOutputSchema } from "./outputs.js";
export const person_notify = defineAgentTool({
  name: "person_notify",
  title: "Update the person",
  description:
    "Send worthwhile news to this Run’s requester while work continues; it may notify their devices. Refused on a delegation: ask the delegating task to tell the person. On a background wake, briefly say what happened in your final reply; send real finds to the asking task with opensteer_task_send queue, or by email through a connected integration. Put the completed answer in your final reply without a duplicate update.",
  input: z.strictObject({ message: PersonMessageSchema }),
  output: PersonMessageOutputSchema,
  access: "write",
  callers: ["run"] as const,
});

export const person_show = defineAgentTool({
  name: "person_show",
  title: "Show a place",
  description:
    "Bring your work into the person's view without waiting to be asked, on devices viewing this task. {current: true}: the page, Mac app or Agent Phone you are in, without a new browser attach or computer observation. {runId}: where a task's Run last worked, from recentPlaces in opensteer_task_read. {tabId}: a tab, even asleep, from Browser Harness listTabs(). {taskId}: a task. Refused on a delegation: tell the delegating task what to show. sent-unconfirmed is not proof anyone saw it.",
  input: z.strictObject({
    target: z.union([
      z.strictObject({ current: z.literal(true) }),
      z.strictObject({ runId: RunIdSchema }),
      z.strictObject({ tabId: BrowserSurfaceIdSchema }),
      z.strictObject({ taskId: ThreadIdSchema }),
    ]),
  }),
  output: PersonShowOutputSchema,
  access: "write",
  callers: ["run"] as const,
});
