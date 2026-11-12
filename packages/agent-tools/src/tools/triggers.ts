import { defineAgentTool } from "../registry.js";

import { TriggerReadInputSchema, TriggerWriteInputSchema } from "@opensteer/triggers";

import { OperationKeySchema } from "./inputs.js";
import { TriggerOutputSchema, TriggerWriteOutputSchema } from "./outputs.js";
export const trigger_read = defineAgentTool({
  name: "trigger_read",
  title: "Inspect Triggers",
  description:
    "List reachable schedules, webhooks and watches, or get one Trigger’s current revision and recent occurrences. list accepts systemRole/limit; get needs triggerId and accepts occurrenceLimit. Visibility is not authority to change it.",
  input: TriggerReadInputSchema,
  output: TriggerOutputSchema,
  access: "read",
  callers: ["run", "program", "connection"] as const,
});

export const trigger_write = defineAgentTool({
  name: "trigger_write",
  targetFields: ["anchorThreadId"],
  title: "Manage Triggers",
  description:
    "Create or control schedules, webhooks and watches. Before writing or changing a program, load opensteer:triggers. Timing controls require anchor access no higher than yours. Creation, code changes, manual runs and archiving require full-access. create: name, program, source; anchorThreadId defaults to this task, and connections must name it. ownTask: true runs it in a new task linked under the anchor (the returned anchorThreadId), off the task list; it keeps running when the anchor is Done, its failures and Requests reach the anchor, and nothing returns automatically. update: triggerId, expectedRevisionId, changed fields. set_status: triggerId, status. set_next_fire: triggerId, future ISO nextFireAt; moves the next unclaimed cron run, then cadence resumes. run: non-archived schedule/webhook triggerId, optional payload. cancel: triggerId, optional occurrenceId (omit for all pending). Started work keeps running. Managed memory passes refuse archive, run, name/program edits and non-cron sources. Returns Trigger/occurrence state; webhook creation also returns its setup URL and secret. Use the secret only for authorized setup.",
  input: TriggerWriteInputSchema.safeExtend({ operationKey: OperationKeySchema.optional() }),
  output: TriggerWriteOutputSchema,
  access: "write",
  callers: ["run", "program", "connection"] as const,
});
