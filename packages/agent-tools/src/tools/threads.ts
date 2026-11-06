import { defineAgentTool } from "../registry.js";
import {
  AssignmentIdSchema,
  DelegationModelChoiceSchema,
  EnvironmentIdSchema,
  HarnessInstanceIdSchema,
  MessageIdSchema,
  RunIdSchema,
  ModelSelectionSchema,
  ProviderSessionIdSchema,
  PlaceContentPartSchema,
  ThreadIdSchema,
  ThreadTitleSchema,
  WorkspaceIdSchema,
} from "@opensteer/core";

import { z } from "zod";

import { OperationKeySchema, CursorSchema } from "./inputs.js";
import {
  TaskSchema,
  ThreadReadOutputSchema,
  ThreadListOutputSchema,
  ThreadMessageOutputSchema,
  ThreadInterruptOutputSchema,
  ThreadUpdateOutputSchema,
  ThreadWaitOutputSchema,
  ThreadConfigureOutputSchema,
  ThreadQueueOutputSchema,
} from "./outputs.js";
export const thread_read = defineAgentTool({
  name: "thread_read",
  targetFields: ["threadId"],
  title: "Read a Thread",
  description:
    "Read a reachable Thread; `home` means Chat, `self` this Thread. `messages` (default): published messages, newest first. `activity`: also its tools, places, apps and Requests. `recentRuns` and `recentPlaces` always come back; a place is recent, never proof it is still open, and its `runId` goes to `person_show`. Keep reads small: low `limit` and `maxCharsPerItem`. Page with `before=nextBefore`. Cut-off text: `itemId` with `textOffset=nextTextOffset`. Tool text is clipped unless you name its `itemId`; sign-in, card and `computer` calls show status only.",
  input: z
    .strictObject({
      threadId: z.union([ThreadIdSchema, z.literal("home"), z.literal("self")]),
      view: z.enum(["messages", "activity"]).default("messages"),
      limit: z.number().int().min(1).max(100).default(20).describe("Max items."),
      runLimit: z.number().int().min(1).max(50).default(10).describe("Max recent Runs."),
      maxCharsPerItem: z
        .number()
        .int()
        .min(1)
        .max(50_000)
        .default(20_000)
        .describe("Max chars per item."),
      itemId: z.string().trim().min(1).max(255).optional().describe("Read this one item."),
      textOffset: z.number().int().nonnegative().optional().describe("With itemId."),
      before: CursorSchema.optional().describe("From nextBefore; keep view and query."),
      query: z.string().trim().min(1).max(256).optional().describe("Search message text."),
      aroundMessageId: MessageIdSchema.optional().describe(
        "Messages around this one; excludes query and before.",
      ),
    })
    .superRefine((input, context) => {
      if (input.textOffset !== undefined && !input.itemId)
        context.addIssue({ code: "custom", message: "textOffset needs itemId" });
      if (input.itemId && (input.before || input.query || input.aroundMessageId))
        context.addIssue({
          code: "custom",
          message: "itemId reads one item; omit before, query and aroundMessageId",
        });
      if (input.view === "activity" && (input.query || input.aroundMessageId))
        context.addIssue({
          code: "custom",
          message: "query and aroundMessageId read messages; omit view",
        });
    }),
  output: ThreadReadOutputSchema,
  access: "read",
  callers: ["run", "program", "connection"] as const,
});

export const thread_list = defineAgentTool({
  name: "thread_list",
  title: "List Threads",
  description:
    "List reachable Threads, newest updated first. `parentThreadId`: the tasks that Thread delegated; `self` for yours. A task row has `assignmentId` and `taskStatus`. Up to 50 per page; page with `before=nextBefore`.",
  input: z.strictObject({
    before: CursorSchema.optional(),
    limit: z.number().int().min(1).max(50).default(25),
    parentThreadId: z.union([ThreadIdSchema, z.literal("self")]).optional(),
    query: z.string().trim().min(1).max(256).optional().describe("Search titles."),
    workspaceId: WorkspaceIdSchema.optional(),
  }),
  output: ThreadListOutputSchema,
  access: "read",
  callers: ["run", "program", "connection"] as const,
});

export const thread_delegate = defineAgentTool({
  name: "thread_delegate",
  targetFields: ["threadId"],
  title: "Start or continue a task",
  description:
    "Start one task, or give a finished one more work with `threadId`, which keeps its engine and model. Omit `workspaceId` for this Workspace; connections must name it. It gets only `task` and `places`, no history. No secrets in `task`. Returns the task; keep `assignmentId` for `task_status` and `task_cancel`. Runs and programs get its result automatically: do other work or end your turn. A task that ends with no reply returns nothing, so ask conditional checks to end that way when nothing merits passing on. Connections get no Assignment: use `thread_wait`. Change active work with `thread_message`.",
  input: z
    .strictObject({
      environmentId: EnvironmentIdSchema.optional().describe("New task computer; omit to inherit."),
      harnessInstanceId: HarnessInstanceIdSchema.optional().describe(
        "New task engine account from environment_list.",
      ),
      model: DelegationModelChoiceSchema.optional().describe(
        "New task model selectors/options from environment_list.",
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
      task: z
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
      workspaceId: WorkspaceIdSchema.optional().describe(
        "New task Workspace; omit when reusing threadId.",
      ),
      threadId: ThreadIdSchema.optional().describe(
        "Finished task to continue; omit new-task selectors.",
      ),
    })
    .superRefine((input, context) => {
      if (input.threadId && input.workspaceId) {
        context.addIssue({
          code: "custom",
          message: "Choose workspaceId for a new task or threadId to reuse a task",
        });
      }
      if (input.threadId && (input.environmentId || input.harnessInstanceId || input.model)) {
        context.addIssue({
          code: "custom",
          message: "An existing Thread keeps its execution selection",
        });
      }
    })
    .safeExtend({ operationKey: OperationKeySchema.optional() }),
  output: TaskSchema,
  access: "write",
  callers: ["run", "program", "connection"] as const,
});

export const task_status = defineAgentTool({
  name: "task_status",
  title: "Read a task",
  description:
    "Read one task. In a Run or program, results of tasks you delegated reach you automatically, so do not poll. Check once when someone asks or you need its state now.",
  input: z.strictObject({ assignmentId: AssignmentIdSchema }),
  output: TaskSchema,
  access: "read",
  callers: ["run", "program", "connection"] as const,
});

export const task_cancel = defineAgentTool({
  name: "task_cancel",
  title: "Cancel a task",
  description:
    "Stop one task for good: its Runs, its Requests and the tasks it delegated. A finished task keeps its result; its Thread stays reusable. Confirm the returned `status` before saying it stopped. To stop and resume later: `thread_interrupt`.",
  input: z
    .strictObject({ assignmentId: AssignmentIdSchema })
    .safeExtend({ operationKey: OperationKeySchema.optional() }),
  output: TaskSchema,
  access: "write",
  callers: ["run"] as const,
  destructive: true,
});

export const thread_message = defineAgentTool({
  name: "thread_message",
  targetFields: ["threadId"],
  title: "Message a Thread",
  description:
    "Send to a Thread; `home` means Chat. `report`: context for its next turn, starts nothing. `queue`: starts its next turn, or waits for it. `steer`: its active Run now, never falls back. `assignmentId` names the task it joined. Null means nothing returns on its own, so to get a result from a finished task use `thread_delegate` with `threadId` instead. Accepted is not read; `cancelled` will not run, so do not resend.",
  input: z
    .strictObject({
      delivery: z.enum(["report", "queue", "steer"]).describe("report, queue or steer."),
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
      threadId: z.union([ThreadIdSchema, z.literal("home")]),
    })
    .safeExtend({ operationKey: OperationKeySchema.optional() }),
  output: ThreadMessageOutputSchema,
  access: "write",
  callers: ["run", "program", "connection"] as const,
});

export const thread_interrupt = defineAgentTool({
  name: "thread_interrupt",
  targetFields: ["threadId"],
  title: "Interrupt a Thread",
  description:
    "Stop a Thread's current Run and pause a task's queue; waiting inputs stay. Omit `threadId` for this Thread. No effect when idle. Resume with `thread_queue`. For a task no longer wanted: `task_cancel`.",
  input: z
    .strictObject({ threadId: ThreadIdSchema.optional() })
    .safeExtend({ operationKey: OperationKeySchema.optional() }),
  output: ThreadInterruptOutputSchema,
  access: "write",
  destructive: true,
  callers: ["run", "program", "connection"] as const,
});

export const thread_update = defineAgentTool({
  name: "thread_update",
  targetFields: ["threadId"],
  title: "Update a Thread",
  description:
    "Rename a Thread with `title`, or mark it `done` or `reopen` it. Omit `threadId` for this Thread. `done` stops its work; on this Thread it applies at turn end.",
  input: z
    .strictObject({
      action: z.enum(["rename", "done", "reopen"]),
      threadId: ThreadIdSchema.optional(),
      title: ThreadTitleSchema.optional(),
    })
    .superRefine((input, context) => {
      if ((input.action === "rename") !== (input.title !== undefined))
        context.addIssue({ code: "custom", message: "rename takes title; no other action does" });
    })
    .safeExtend({ operationKey: OperationKeySchema.optional() }),
  output: ThreadUpdateOutputSchema,
  access: "write",
  destructive: true,
  callers: ["run", "program", "connection"] as const,
});

export const thread_wait = defineAgentTool({
  name: "thread_wait",
  targetFields: ["threadId"],
  title: "Wait for a Thread",
  description:
    "Wait for a Run to settle, a pending Request, or a message after `afterMessageId`, up to 100 seconds. A timeout stops nothing; call again. `hasMore`: wait again with `afterMessageId` set to the last item's `itemId`.",
  input: z.strictObject({
    threadId: ThreadIdSchema,
    afterMessageId: MessageIdSchema.optional().describe(
      "Return published messages after this ID; omit to wait for Run settlement.",
    ),
    timeoutMs: z
      .number()
      .int()
      .min(1)
      .max(100_000)
      .default(50_000)
      .describe("Maximum wait in milliseconds; timeout never cancels work."),
  }),
  output: ThreadWaitOutputSchema,
  access: "read",
  callers: ["program", "connection"] as const,
});
export const thread_configure = defineAgentTool({
  name: "thread_configure",
  targetFields: ["threadId"],
  title: "Configure a Thread",
  description:
    "Read a Thread's engine and model, or set them with `harnessInstanceId` or `modelSelection`. Omit `threadId` for this Thread. Access mode stays. Values from `environment_list`; never substitute after a refusal. `continuation` confirms a known native-session switch.",
  input: z
    .strictObject({
      threadId: ThreadIdSchema.optional(),
      harnessInstanceId: HarnessInstanceIdSchema.optional(),
      modelSelection: ModelSelectionSchema.optional(),
      continuation: z
        .strictObject({ expectedProviderSessionId: ProviderSessionIdSchema.nullable() })
        .optional(),
      operationKey: OperationKeySchema.optional(),
    })
    .superRefine((input, ctx) => {
      if (input.continuation && !input.harnessInstanceId && !input.modelSelection)
        ctx.addIssue({ code: "custom", message: "continuation needs a new selection" });
    }),
  output: ThreadConfigureOutputSchema,
  access: "write",
  readsOnly: (input) => !input.harnessInstanceId && !input.modelSelection,
  callers: ["run", "program", "connection"] as const,
});
export const thread_queue = defineAgentTool({
  name: "thread_queue",
  targetFields: ["threadId"],
  title: "Manage queued inputs",
  description:
    "Manage a Thread's waiting inputs. Omit `threadId` for this Thread. list: in order, with what you may do to each. cancel. move: before `beforeMessageId`, or to the end with null. steer: send one to the active `expectedRunId`. resume: release a paused queue. Keep a person's pause unless told to resume.",
  input: z
    .strictObject({
      action: z.enum(["list", "cancel", "move", "steer", "resume"]),
      threadId: ThreadIdSchema.optional(),
      messageId: MessageIdSchema.optional(),
      beforeMessageId: MessageIdSchema.nullable().optional(),
      expectedRunId: RunIdSchema.optional(),
      operationKey: OperationKeySchema.optional(),
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
  destructive: true,
});
