import { defineAgentTool } from "../registry.js";
import {
  AssignmentIdSchema,
  ExecutionNodeIdSchema,
  DelegationModelChoiceSchema,
  HarnessInstanceIdSchema,
  MessageIdSchema,
  RunIdSchema,
  ModelSelectionSchema,
  ProviderSessionIdSchema,
  PlaceContentPartSchema,
  ThreadIdSchema,
  ThreadTitleSchema,
} from "@opensteer/core";

import { z } from "zod";

import { OperationKeySchema, CursorSchema } from "./inputs.js";
import {
  TaskSchema,
  SubagentCancelOutputSchema,
  ThreadReadOutputSchema,
  ThreadListOutputSchema,
  ThreadMessageOutputSchema,
  ThreadInterruptOutputSchema,
  ThreadUpdateOutputSchema,
  ThreadWaitOutputSchema,
  ThreadConfigureOutputSchema,
  ThreadQueueOutputSchema,
} from "./outputs.js";
export const threadWaitMaxMs = 100_000;
const ThreadWaitTimeoutSchema = z.number().int().min(1).max(threadWaitMaxMs).default(50_000);

function validateReadWindow(
  input: {
    textOffset?: number | undefined;
    itemId?: string | undefined;
    cursor?: string | undefined;
    query?: string | undefined;
    aroundMessageId?: string | undefined;
    view: string;
  },
  ctx: z.RefinementCtx,
) {
  if (input.textOffset !== undefined && !input.itemId)
    ctx.addIssue({ code: "custom", message: "textOffset needs itemId" });
  if (input.itemId && (input.cursor || input.query || input.aroundMessageId))
    ctx.addIssue({ code: "custom", message: "itemId excludes paging and search" });
  if (input.view === "activity" && (input.query || input.aroundMessageId))
    ctx.addIssue({ code: "custom", message: "Search requires messages view" });
}
const readInput = z
  .strictObject({
    taskId: ThreadIdSchema.optional(),
    view: z.enum(["messages", "activity"]).default("messages"),
    limit: z.number().int().min(1).max(100).default(20),
    runLimit: z.number().int().min(1).max(50).default(10),
    maxCharsPerItem: z.number().int().min(1).max(50000).default(20000),
    itemId: z.string().trim().min(1).max(255).optional(),
    textOffset: z.number().int().nonnegative().optional(),
    cursor: CursorSchema.optional(),
    query: z.string().trim().min(1).max(256).optional(),
    aroundMessageId: MessageIdSchema.optional(),
  })
  .superRefine(validateReadWindow);
export const opensteer_task_read = defineAgentTool({
  name: "opensteer_task_read",
  targetFields: ["taskId"],
  title: "Read a task",
  description:
    "Read task messages, activity or one item and its current AI account, model and access mode. Omit taskId for this task.",
  input: readInput,
  output: ThreadReadOutputSchema,
  access: "read",
  callers: ["run", "program", "connection"] as const,
});

export const opensteer_task_list = defineAgentTool({
  name: "opensteer_task_list",
  title: "List tasks",
  description:
    "List reachable tasks, newest updated first. Use parentTaskId to list delegated tasks and cursor to page.",
  input: z.strictObject({
    cursor: CursorSchema.optional(),
    limit: z.number().int().min(1).max(50).default(25),
    parentTaskId: ThreadIdSchema.optional(),
    query: z.string().trim().min(1).max(256).optional().describe("Search titles."),
  }),
  output: ThreadListOutputSchema,
  access: "read",
  callers: ["run", "program", "connection"] as const,
});

export const opensteer_task_delegate = defineAgentTool({
  name: "opensteer_task_delegate",
  targetFields: ["taskId"],
  title: "Delegate work",
  description:
    "Start a delegated task or continue a finished task with taskId. Keep delegationId to read or wait for its result.",
  input: z
    .strictObject({
      mode: z.enum(["async", "wait"]).default("async"),
      timeoutMs: ThreadWaitTimeoutSchema,
      aiAccountId: HarnessInstanceIdSchema.optional().describe(
        "New task AI account from opensteer_ai_account_list.",
      ),
      model: DelegationModelChoiceSchema.optional().describe(
        "New task model selectors/options from opensteer_ai_account_list.",
      ),
      observationId: z
        .string()
        .trim()
        .min(1)
        .max(255)
        .optional()
        .describe("Watch observation identity; reuse for the same observation."),
      places: z
        .array(PlaceContentPartSchema)
        .max(63)
        .optional()
        .describe("Authorized page/app/phone content to forward; text IDs alone do not attach it."),
      message: z
        .string()
        .trim()
        .min(1)
        .max(64 * 1_024),
      title: z
        .string()
        .trim()
        .min(1)
        .max(240)
        .optional()
        .describe("New task: 2–5 words naming the outcome; defaults to the first task line."),
      specialist: z
        .string()
        .trim()
        .min(1)
        .max(256)
        .optional()
        .describe("Ready specialist registration ID or plugin name."),
      taskId: ThreadIdSchema.optional().describe(
        "Finished task to continue; omit new-task selectors.",
      ),
    })
    .superRefine((input, context) => {
      if (input.taskId && (input.aiAccountId || input.model)) {
        context.addIssue({
          code: "custom",
          message: "An existing task keeps its execution selection",
        });
      }
    })
    .safeExtend({ operationKey: OperationKeySchema.optional() }),
  output: TaskSchema.extend({ wait: ThreadWaitOutputSchema.optional() }),
  access: "write",
  callers: ["run", "program"] as const,
});

export const opensteer_delegation_status = defineAgentTool({
  name: "opensteer_delegation_status",
  title: "Read a delegation",
  description: "Read a delegation state and result. Reading a settled result counts as delivery.",
  input: z.strictObject({ delegationId: AssignmentIdSchema }),
  output: TaskSchema,
  access: "read",
  callers: ["run", "program", "connection"] as const,
});

export const opensteer_delegation_cancel = defineAgentTool({
  name: "opensteer_delegation_cancel",
  title: "Cancel a delegation",
  description: "Cancel delegated work and its Requests. A finished task keeps its result.",
  input: z.strictObject({ delegationId: AssignmentIdSchema }),
  output: TaskSchema,
  access: "write",
  callers: ["run"] as const,
  destructive: true,
});

export const opensteer_task_send = defineAgentTool({
  name: "opensteer_task_send",
  targetFields: ["taskId"],
  title: "Send to a task",
  description:
    "Report context, queue the next turn or steer the active Run. Steering never falls back to queueing.",
  input: z
    .strictObject({
      delivery: z.enum(["report", "queue", "steer"]).describe("report, queue or steer."),
      freshContext: z
        .boolean()
        .optional()
        .describe(
          "Queue only: start a fresh model session for this wake. Include criteria, destination and state path in the message.",
        ),
      message: z
        .string()
        .trim()
        .min(1)
        .max(256 * 1_024),
      observationId: z
        .string()
        .trim()
        .min(1)
        .max(255)
        .optional()
        .describe("Watch observation identity; reuse for the same observation."),
      taskId: ThreadIdSchema,
    })
    .safeExtend({ operationKey: OperationKeySchema.optional() })
    .refine((input) => !input.freshContext || input.delivery === "queue", {
      message: "freshContext requires queue delivery",
      path: ["freshContext"],
    }),
  output: ThreadMessageOutputSchema,
  access: "write",
  callers: ["run", "program", "connection"] as const,
});

export const opensteer_task_interrupt = defineAgentTool({
  name: "opensteer_task_interrupt",
  targetFields: ["taskId"],
  title: "Interrupt a task",
  description:
    "Stop the current Run and pause the task queue. Use opensteer_task_resume to release it.",
  input: z.strictObject({ taskId: ThreadIdSchema.optional() }),
  output: ThreadInterruptOutputSchema,
  access: "write",
  destructive: true,
  callers: ["run", "program", "connection"] as const,
});

export const opensteer_task_update = defineAgentTool({
  name: "opensteer_task_update",
  targetFields: ["taskId"],
  title: "Update a task",
  description: "Change a task title or mark it done. Set done to false to reopen it.",
  input: z
    .strictObject({
      taskId: ThreadIdSchema.optional(),
      title: ThreadTitleSchema.optional(),
      done: z.boolean().optional(),
    })
    .refine((i) => i.title !== undefined || i.done !== undefined, "Provide title or done"),
  output: ThreadUpdateOutputSchema,
  access: "write",
  callers: ["run", "program", "connection"] as const,
});

export const opensteer_task_wait = defineAgentTool({
  name: "opensteer_task_wait",
  targetFields: ["taskId"],
  title: "Wait for a task",
  description:
    "Wait for the task Run to settle, a pending Request or new messages. Timeout stops no work.",
  input: z.strictObject({
    taskId: ThreadIdSchema,
    afterMessageId: MessageIdSchema.optional(),
    timeoutMs: ThreadWaitTimeoutSchema,
  }),
  output: ThreadWaitOutputSchema,
  access: "read",
  callers: ["run", "program", "connection"] as const,
});
export const opensteer_task_configure = defineAgentTool({
  name: "opensteer_task_configure",
  targetFields: ["taskId"],
  title: "Configure a task",
  description: "Set the task AI account or model selection. Its access mode stays unchanged.",
  input: z
    .strictObject({
      taskId: ThreadIdSchema.optional(),
      aiAccountId: HarnessInstanceIdSchema.optional(),
      modelSelection: ModelSelectionSchema.optional(),
      continuation: z
        .strictObject({ expectedProviderSessionId: ProviderSessionIdSchema.nullable() })
        .optional(),
    })
    .superRefine((input, ctx) => {
      if (!input.aiAccountId && !input.modelSelection)
        ctx.addIssue({ code: "custom", message: "continuation needs a new selection" });
    }),
  output: ThreadConfigureOutputSchema,
  access: "write",

  callers: ["run", "program", "connection"] as const,
});
export const opensteer_task_queue = defineAgentTool({
  name: "opensteer_task_queue",
  targetFields: ["taskId"],
  title: "Manage a task queue",
  description:
    "List, cancel, move or steer queued inputs. Use opensteer_task_resume to release a paused queue.",
  input: z
    .strictObject({
      action: z.enum(["list", "cancel", "move", "steer"]),
      taskId: ThreadIdSchema.optional(),
      messageId: MessageIdSchema.optional(),
      beforeMessageId: MessageIdSchema.nullable().optional(),
      expectedRunId: RunIdSchema.optional(),
    })
    .superRefine((input, ctx) => {
      if (["cancel", "move", "steer"].includes(input.action) !== !!input.messageId)
        ctx.addIssue({ code: "custom", message: "cancel, move and steer require messageId" });
      if ((input.action === "move") !== (input.beforeMessageId !== undefined))
        ctx.addIssue({
          code: "custom",
          message: "move requires beforeMessageId (null for the end)",
        });
      if ((input.action === "steer") !== !!input.expectedRunId)
        ctx.addIssue({ code: "custom", message: "steer requires expectedRunId" });
    }),
  output: ThreadQueueOutputSchema,
  access: "write",
  readsOnly: (input) => input.action === "list",
  callers: ["run", "program", "connection"] as const,
});

export const opensteer_task_create = defineAgentTool({
  name: "opensteer_task_create",
  title: "Create a task",
  description: "Start a top-level task. Nothing returns to the calling task automatically.",
  input: z
    .strictObject(opensteer_task_delegate.input.shape)
    .omit({ taskId: true, places: true })
    .safeExtend({ operationKey: OperationKeySchema.optional() }),
  output: opensteer_task_delegate.output,
  access: "write",
  callers: ["run", "program", "connection"] as const,
});
export const opensteer_delegation_wait = defineAgentTool({
  name: "opensteer_delegation_wait",
  title: "Wait for a delegation",
  description:
    "Wait for a delegation result or a pending Request. Reading a result counts as delivery.",
  input: z.strictObject({ delegationId: AssignmentIdSchema, timeoutMs: ThreadWaitTimeoutSchema }),
  output: ThreadWaitOutputSchema,
  access: "read",
  callers: ["run", "program", "connection"] as const,
});
export const opensteer_subagent_read = defineAgentTool({
  name: "opensteer_subagent_read",
  title: "Read a subagent",
  description: "Read a reachable subagent's messages and activity without reasoning.",
  input: z
    .strictObject(readInput.shape)
    .omit({ taskId: true, query: true, aroundMessageId: true })
    .safeExtend({ subagentId: ExecutionNodeIdSchema })
    .superRefine(validateReadWindow),
  output: ThreadReadOutputSchema,
  access: "read",
  callers: ["run", "program", "connection"] as const,
});
export const opensteer_subagent_stop = defineAgentTool({
  name: "opensteer_subagent_stop",
  title: "Stop a subagent",
  description: "Request a stop for one subagent of this Run. The parent keeps running.",
  input: z.strictObject({ subagentId: ExecutionNodeIdSchema }),
  output: SubagentCancelOutputSchema,
  access: "write",
  callers: ["run"] as const,
  destructive: true,
});
export const opensteer_task_resume = defineAgentTool({
  name: "opensteer_task_resume",
  title: "Resume a task",
  description: "Release a paused task queue when the person asks to resume.",
  input: z.strictObject({ taskId: ThreadIdSchema.optional() }),
  targetFields: ["taskId"],
  output: ThreadQueueOutputSchema,
  access: "write",
  callers: ["run", "program", "connection"] as const,
});
