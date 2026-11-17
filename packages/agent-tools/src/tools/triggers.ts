import { defineAgentTool } from "../registry.js";
import {
  TriggerProgramSchema,
  TriggerSourceInputSchema,
  TriggerSystemRoleSchema,
} from "@opensteer/triggers";
import {
  ThreadIdSchema,
  TriggerIdSchema,
  TriggerRevisionIdSchema,
  TriggerOccurrenceIdSchema,
  IsoDateTimeSchema,
} from "@opensteer/core";
import { z } from "zod";
import { OperationKeySchema } from "./inputs.js";
import { TriggerOutputSchema, TriggerWriteOutputSchema } from "./outputs.js";
export const opensteer_automation_list = defineAgentTool({
  name: "opensteer_automation_list",
  title: "List automations",
  description:
    "List reachable schedule, reminder, cron, webhook and watch automations. Seeing one is not authority to change it. Mention returned items by their `link`, verbatim.",
  input: z.strictObject({
    systemRole: TriggerSystemRoleSchema.optional(),
    limit: z.number().int().min(1).max(100).default(50),
  }),
  output: TriggerOutputSchema,
  access: "read",
  callers: ["run", "program", "connection"] as const,
});
export const opensteer_automation_read = defineAgentTool({
  name: "opensteer_automation_read",
  title: "Read an automation",
  description:
    "Read an automation's current revision and recent occurrences. Seeing one is not authority to change it. Mention returned items by their `link`, verbatim.",
  input: z.strictObject({
    automationId: TriggerIdSchema,
    occurrenceLimit: z.number().int().min(1).max(100).default(25),
  }),
  output: TriggerOutputSchema,
  access: "read",
  callers: ["run", "program", "connection"] as const,
});
export const opensteer_automation_create = defineAgentTool({
  name: "opensteer_automation_create",
  title: "Create an automation",
  description:
    "Create a schedule, reminder, cron, webhook or watch on a task; this requires full access and a program with tool contract version 5. Connections must name taskId. ownTask: true runs it in a new task linked under that task and kept off the task list: it keeps running after that task is Done, its failures and Requests reach that task, and nothing returns automatically.",
  targetFields: ["taskId"],
  input: z.strictObject({
    taskId: ThreadIdSchema.optional(),
    name: z.string().trim().min(1).max(160),
    program: TriggerProgramSchema,
    source: TriggerSourceInputSchema,
    ownTask: z.literal(true).optional(),
    operationKey: OperationKeySchema.optional(),
  }),
  output: TriggerWriteOutputSchema,
  access: "write",
  callers: ["run", "program", "connection"] as const,
});
export const opensteer_automation_update = defineAgentTool({
  name: "opensteer_automation_update",
  title: "Update an automation",
  description:
    "Change an automation's name, program or source with the expectedRevisionId you read; program changes require full access. Opensteer's memory passes refuse name and program changes and sources other than cron.",
  input: z
    .strictObject({
      automationId: TriggerIdSchema,
      expectedRevisionId: TriggerRevisionIdSchema,
      name: z.string().trim().min(1).max(160).optional(),
      program: TriggerProgramSchema.optional(),
      source: TriggerSourceInputSchema.optional(),
    })
    .refine(
      (i) => i.name !== undefined || i.program !== undefined || i.source !== undefined,
      "Provide a change",
    ),
  output: TriggerWriteOutputSchema,
  access: "write",
  callers: ["run", "program", "connection"] as const,
});
export const opensteer_automation_control = defineAgentTool({
  name: "opensteer_automation_control",
  title: "Control an automation",
  description:
    "Pause, resume, archive, reschedule, run now or cancel pending occurrences. These timing controls need the automation's task access mode to be no higher than yours; run_now and archive also require full access. reschedule moves the next unclaimed cron run to a future nextFireAt, then the cadence resumes. run_now works on a non-archived schedule or webhook and has real effects. cancel_pending without occurrenceId cancels every pending occurrence. Started work keeps running. Opensteer's memory passes refuse archive and run_now.",
  input: z
    .strictObject({
      automationId: TriggerIdSchema,
      action: z.enum(["pause", "resume", "archive", "reschedule", "run_now", "cancel_pending"]),
      nextFireAt: IsoDateTimeSchema.optional(),
      payload: z.unknown().optional(),
      occurrenceId: TriggerOccurrenceIdSchema.optional(),
    })
    .superRefine((i, c) => {
      if ((i.action === "reschedule") !== (i.nextFireAt !== undefined))
        c.addIssue({ code: "custom", message: "reschedule requires nextFireAt" });
      if (i.payload !== undefined && i.action !== "run_now")
        c.addIssue({ code: "custom", message: "payload requires run_now" });
      if (i.occurrenceId !== undefined && i.action !== "cancel_pending")
        c.addIssue({ code: "custom", message: "occurrenceId requires cancel_pending" });
    }),
  output: TriggerWriteOutputSchema,
  access: "write",
  callers: ["run", "program", "connection"] as const,
});
