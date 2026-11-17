import { defineAgentTool } from "../registry.js";
import {
  TabIdSchema,
  PersonMessageSchema,
  requestChoiceTextMaxLength,
  requestLabelMaxLength,
  requestTextMaxLength,
  requestTitleMaxLength,
  ThreadIdSchema,
} from "@opensteer/core";

import { z } from "zod";

import { OperationKeySchema } from "./inputs.js";
import {
  PersonMessageOutputSchema,
  PersonShowOutputSchema,
  RequestCreationOutputSchema,
} from "./outputs.js";

export const send_to_person = defineAgentTool({
  name: "send_to_person",
  title: "Send to the person",
  description:
    "Send this Run’s requester a message in this task now, while work continues; it may notify their devices. It expects no answer: to get one, use ask_person. Refused on a delegation: ask the delegating task to tell the person. On a background wake, use it only for news worth interrupting the person for; send finds a task asked for to that task with opensteer_task_send queue, and otherwise just say briefly what happened in your final reply. Put the completed answer in your final reply without a duplicate message.",
  input: z.strictObject({ message: PersonMessageSchema }),
  output: PersonMessageOutputSchema,
  access: "write",
  callers: ["run"] as const,
});

export const show_to_person = defineAgentTool({
  name: "show_to_person",
  title: "Show a tab or task",
  description:
    "Ask devices viewing this task to bring an explicit tab or task into view. tabId comes from tab_list or tab_open; taskId comes from opensteer_task_list or opensteer_task_read. Asleep tabs may wake. A closed or unavailable target is not replaced. Delegated tasks send the destination to their delegating task. sent-unconfirmed means delivery, not proof the person saw it.",
  input: z.strictObject({
    target: z.union([
      z.strictObject({
        tabId: TabIdSchema.describe(
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

/** The most questions one ask may hold, and the most answers one question may offer. */
export const askPersonQuestionLimit = 4;
export const askPersonOptionLimit = 6;

const AskPersonOptionSchema = z.strictObject({
  label: z
    .string()
    .trim()
    .min(1)
    .max(requestLabelMaxLength)
    .describe("The answer the person taps, in a few words."),
  description: z
    .string()
    .trim()
    .min(1)
    .max(requestChoiceTextMaxLength)
    .optional()
    .describe("What choosing it means or does."),
});

const AskPersonQuestionSchema = z
  .strictObject({
    question: z.string().trim().min(1).max(requestTextMaxLength),
    options: z
      .array(AskPersonOptionSchema)
      .min(2)
      .max(askPersonOptionLimit)
      .optional()
      .describe("Answers to tap. Omit for an open question."),
    multiSelect: z.boolean().optional().describe("The person may choose several options."),
  })
  .superRefine((question, context) => {
    const labels = question.options?.map(({ label }) => label) ?? [];
    if (new Set(labels).size !== labels.length)
      context.addIssue({ code: "custom", message: "Option labels must differ", path: ["options"] });
    if (question.multiSelect === true && question.options === undefined)
      context.addIssue({
        code: "custom",
        message: "multiSelect needs options",
        path: ["multiSelect"],
      });
  });

export const ask_person = defineAgentTool({
  name: "ask_person",
  opensRequest: true,
  title: "Ask the person",
  description:
    "Ask the person for a decision or answer only they can give. It reaches Needs you and their devices. Prepare the work first and put it in detail, such as the exact draft or plan, so one answer settles it. The person can always type their own answer instead of an option. While they watch, the call waits for the answer; otherwise it returns pending and their answer later continues this task, even days later. A dismissed question means no: do not ask it again unless something changed. Never ask for passwords, codes or access: Request tools cover those. Refused on a delegation: ask the delegating task.",
  input: z.strictObject({
    title: z
      .string()
      .trim()
      .min(1)
      .max(requestTitleMaxLength)
      .describe("The decision in one short line, as Needs you and the notification show it."),
    detail: z
      .string()
      .trim()
      .min(1)
      .max(requestTextMaxLength)
      .optional()
      .describe("What you noticed, why it matters to the person, and the work you prepared."),
    questions: z.array(AskPersonQuestionSchema).min(1).max(askPersonQuestionLimit),
    operationKey: OperationKeySchema.optional(),
  }),
  output: RequestCreationOutputSchema,
  access: "write",
  callers: ["run"] as const,
});
