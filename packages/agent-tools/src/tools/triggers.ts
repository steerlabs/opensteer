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
  description: "List reachable schedule, reminder, cron, webhook and watch automations.",
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
  description: "Read an automation's current revision and recent occurrences.",
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
    "Create a schedule, reminder, cron, webhook or watch on a task. Programs require full access and tool contract version 4.",
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
  description: "Change an automation name, program or source using the revision you read.",
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
    "Pause, resume, archive, reschedule, run now or cancel pending occurrences. Started work keeps running.",
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
