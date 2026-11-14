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
    "Notify this Run’s requester while work continues. Delegated Runs must ask the parent task to notify the person.",
  input: z.strictObject({ message: PersonMessageSchema }),
  output: PersonMessageOutputSchema,
  access: "write",
  callers: ["run"] as const,
});

export const person_show = defineAgentTool({
  name: "person_show",
  title: "Show a place",
  description:
    "Show a task, browser tab or recent Run place to the person. Delegated Runs must ask the parent task to show it.",
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
