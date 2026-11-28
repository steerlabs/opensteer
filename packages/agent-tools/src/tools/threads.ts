import { defineAgentTool } from "../registry.js";
import {
  AssignmentIdSchema,
  ExecutionNodeIdSchema,
  DelegationModelChoiceSchema,
  HarnessInstanceIdSchema,
  IsoDateTimeSchema,
  MessageIdSchema,
  RunIdSchema,
  ModelSelectionSchema,
  ProviderSessionIdSchema,
  PlaceContentPartSchema,
  ThreadIdSchema,
  ThreadTitleSchema,
} from "@opensteer/core";
import { TranscriptItemIdSchema } from "@opensteer/protocol/transcript";

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
    limit: z.number().int().min(1).max(100).default(20).describe("Max items."),
    runLimit: z.number().int().min(1).max(50).default(10).describe("Max recent Runs."),
    maxCharsPerItem: z
      .number()
      .int()
      .min(1)
      .max(50000)
      .default(20000)
      .describe("Max characters per item."),
    itemId: z
      .string()
      .trim()
      .pipe(TranscriptItemIdSchema)
      .optional()
      .describe("Read one item using its returned itemId."),
    textOffset: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("nextTextOffset of a cut-off item, with its itemId."),
    cursor: CursorSchema.optional().describe(
      "nextCursor from the previous page; keep view and query.",
    ),
    query: z.string().trim().min(1).max(256).optional().describe("Search message text."),
    aroundMessageId: MessageIdSchema.optional().describe(
      "Messages around this one; excludes query and cursor.",
    ),
  })
  .superRefine(validateReadWindow);
export const opensteer_task_read = defineAgentTool({
  name: "opensteer_task_read",
  targetFields: ["taskId"],
  title: "Read a task",
  description:
    "Read a task with its AI account, model, access mode, doneBy, lastVisitedAt and pendingRequests; omit taskId for this task. The messages view returns published messages and settled non-secret questions, newest first; activity adds places, apps, all settled Requests and one item per tool call. recentRuns and recentPlaces always come back: a place is recent, never proof it is still open, and its tabId goes to show_to_person. Keep reads small with a low limit and maxCharsPerItem. Tool text is clipped unless you name its itemId; sign-in, card and computer_use calls show status only. Mention returned items by their `link`, verbatim.",
  input: readInput,
  output: ThreadReadOutputSchema,
  access: "read",
  callers: ["run", "program", "connection"] as const,
});

export const opensteer_task_list = defineAgentTool({
  name: "opensteer_task_list",
  title: "List tasks",
  description:
    "List reachable tasks, newest updated first, up to 50 per page; page with cursor. Filter by done, hasPendingRequests, parentTaskId or query (titles and messages). parentTaskId lists the tasks that task delegated, with delegationId and taskStatus. changedSince lists tasks with new messages, settled questions or non-quiet Done changes after that time, most recent first; read them with opensteer_task_read. Mention returned items by their `link`, verbatim.",
  input: z.strictObject({
    changedSince: IsoDateTimeSchema.optional(),
    cursor: CursorSchema.optional(),
    done: z.boolean().optional().describe("Filter by whether the task is marked Done."),
    hasPendingRequests: z
      .boolean()
      .optional()
      .describe("Filter by whether the task has pending Requests."),
    limit: z.number().int().min(1).max(50).default(25),
    parentTaskId: ThreadIdSchema.optional(),
    query: z.string().trim().min(1).max(256).optional().describe("Search titles and messages."),
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
    "Start a delegated task, or continue a finished one with taskId. Its starting context is only message and places, so never include secrets. Keep delegationId for status, wait or cancel. Mode async returns once admitted; mode wait waits up to timeoutMs. When delegating a check, ask for a brief result, including when nothing changed. Change a task's active work with opensteer_task_send instead. Mention returned items by their `link`, verbatim.",
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
  description:
    "Read one delegation's state and result. Reading a settled result counts as delivery and suppresses its automatic return; a result already claimed for return arrives in the delegating task's inbox instead.",
  input: z.strictObject({ delegationId: AssignmentIdSchema }),
  output: TaskSchema,
  access: "read",
  callers: ["run", "program", "connection"] as const,
});

export const opensteer_delegation_cancel = defineAgentTool({
  name: "opensteer_delegation_cancel",
  title: "Cancel a delegation",
  description:
    "Stop a delegation for good: its task's Runs, its Requests and the tasks it delegated. A finished task keeps its result and can be continued later. Confirm the returned status before saying it stopped. To stop work and resume it later, use opensteer_task_interrupt.",
  input: z.strictObject({ delegationId: AssignmentIdSchema }),
  output: TaskSchema,
  access: "write",
  callers: ["run", "program"] as const,
  destructive: true,
});

export const opensteer_task_send = defineAgentTool({
  name: "opensteer_task_send",
  targetFields: ["taskId"],
  title: "Send to a task",
  description:
    "Send to a task. report leaves context for its next turn and starts nothing; queue starts its next turn or waits for one; steer reaches its active Run now and never falls back to queueing. The returned delegationId names the delegation it joined; when it is null nothing returns on its own, so give a finished task more work with opensteer_task_delegate and taskId. Accepted is not read, and cancelled will never run, so do not resend. Mention returned items by their `link`, verbatim.",
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
    "Stop a task's current Run and pause its queue; waiting inputs stay and an idle task is unaffected. Omit taskId for this task. Release it with opensteer_task_resume; to stop a delegation for good, use opensteer_delegation_cancel.",
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
  description:
    "Rename a task with title, set done to true to mark it Done and stop its work, or false to reopen it. Omit taskId for this task; on this task, done applies at the end of the turn.",
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
    "Wait until a task's Run settles, a Request is pending or the timeout passes. You cannot wait on this task or a task you work for. A timeout stops no work; when hasMore is true, wait again after the last itemId.",
  input: z.strictObject({
    taskId: ThreadIdSchema,
    afterMessageId: MessageIdSchema.optional().describe(
      "Return published messages after this ID; omit to wait for the Run to settle.",
    ),
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
  description:
    "Set a task's AI account or model with values copied from opensteer_ai_account_list; never substitute another after a refusal. Omit taskId for this task. Its access mode stays. continuation confirms a known native-session switch.",
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
        ctx.addIssue({ code: "custom", message: "Provide aiAccountId or modelSelection" });
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
    "List, cancel, move or steer a task's waiting inputs; omit taskId for this task. list shows them in order with what you may do to each. move puts one before beforeMessageId, or last with null. steer sends one to the active expectedRunId. opensteer_task_resume releases a paused queue.",
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
  description:
    "Start a top-level task of its own, such as one per scheduled run, with no parent or delegation. Its starting context is only message, so never include secrets. Nothing returns automatically: wait on its taskId with opensteer_task_wait. Mention returned items by their `link`, verbatim.",
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
    "Wait up to timeoutMs for a delegation to settle or raise a pending Request. Reading a settled result counts as delivery and suppresses its automatic return. A timeout stops no work.",
  input: z.strictObject({ delegationId: AssignmentIdSchema, timeoutMs: ThreadWaitTimeoutSchema }),
  output: ThreadWaitOutputSchema,
  access: "read",
  callers: ["run", "program", "connection"] as const,
});
export const opensteer_subagent_read = defineAgentTool({
  name: "opensteer_subagent_read",
  title: "Read a subagent",
  description:
    "Read a reachable subagent's messages and activity without reasoning. Each tool call has one itemId.",
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
  description:
    "Ask one subagent of this Run to stop; this needs engine support and never stops the parent. stopping means requested; opensteer_subagent_read shows interrupted once it ended.",
  input: z.strictObject({ subagentId: ExecutionNodeIdSchema }),
  output: SubagentCancelOutputSchema,
  access: "write",
  callers: ["run"] as const,
  destructive: true,
});
export const opensteer_task_resume = defineAgentTool({
  name: "opensteer_task_resume",
  title: "Resume a task",
  description:
    "Release a task's paused queue; omit taskId for this task. Keep a person's pause unless they ask to resume.",
  input: z.strictObject({ taskId: ThreadIdSchema.optional() }),
  targetFields: ["taskId"],
  output: ThreadQueueOutputSchema,
  access: "write",
  callers: ["run", "program", "connection"] as const,
});
