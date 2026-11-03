import { defineAgentTool } from "../registry.js";

import { TriggerReadInputSchema, TriggerWriteInputSchema } from "@opensteer/triggers";

import { OperationKeySchema } from "./inputs.js";
import { TriggerOutputSchema } from "./outputs.js";
export const trigger_read = defineAgentTool({
  name: "trigger_read",
  title: "Read Triggers",
  description:
    "Read reachable schedule, webhook and watch Triggers. list accepts workspaceId and limit. get needs triggerId and returns the Trigger and recent occurrences, bounded by occurrenceLimit.",
  input: TriggerReadInputSchema,
  output: TriggerOutputSchema,
  access: "read",
  callers: ["run", "program"] as const,
});

export const trigger_write = defineAgentTool({
  name: "trigger_write",
  title: "Write Triggers",
  description:
    "Create or control schedules, webhooks and watches. Before writing or changing a program, load opensteer:triggers. Timing controls require anchor access no higher than yours. Creation, program/source changes, manual runs and archiving require full access within the caller’s reach and Workspace. create needs name, anchorThreadId (home is Chat), program and source. update needs triggerId, expectedRevisionId and changed fields. set_status needs triggerId and status. set_next_fire needs triggerId and future ISO nextFireAt; it moves an active cron's next unclaimed run, then cadence resumes, leaving queued/running work untouched. run needs a non-archived schedule/webhook triggerId; it queues a real occurrence with optional payload. cancel needs triggerId and optional occurrenceId; omission cancels all pending occurrences. Started work keeps running. Tell the person when creating or changing what runs.",
  input: TriggerWriteInputSchema.safeExtend({ operationKey: OperationKeySchema.optional() }),
  output: TriggerOutputSchema,
  access: "work",
  callers: ["run", "program"] as const,
});
