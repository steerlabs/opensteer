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
  ThreadWriteInputSchema,
  WorkspaceIconNameSchema,
  WorkspaceIdSchema,
} from "@opensteer/core";

import { z } from "zod";

import { OperationKeySchema, CursorSchema } from "./inputs.js";
import {
  ThreadReadOutputSchema,
  ThreadListOutputSchema,
  ThreadDelegateOutputSchema,
  AssignmentCancelOutputSchema,
  ThreadMessageOutputSchema,
  ThreadWriteOutputSchema,
  ThreadWaitOutputSchema,
  ThreadConfigureOutputSchema,
  ThreadQueueOutputSchema,
} from "./outputs.js";
export const thread_read = defineAgentTool({
  name: "thread_read",
  title: "Read Thread",
  description:
    "Read reachable Thread history and assigned tasks. Use query to search or aroundMessageId for a known message. Pass window.nextBefore as before, keeping query, for earlier messages; use assignmentBefore for earlier tasks. An anchored read cannot also search or page.",
  input: z.strictObject({
    before: CursorSchema.optional(),
    maxMessages: z.number().int().min(1).max(100).default(100),
    query: z.string().trim().min(1).max(256).optional(),
    aroundMessageId: MessageIdSchema.optional(),
    assignmentBefore: CursorSchema.optional(),
    threadId: ThreadIdSchema,
  }),
  output: ThreadReadOutputSchema,
  access: "read",
  callers: ["run", "program", "connection"] as const,
});

export const thread_list = defineAgentTool({
  name: "thread_list",
  title: "List Threads",
  description:
    "Find reachable Threads, newest updated first; workspaceId and query narrow the list. Reach follows the caller’s current authority. Pass window.nextBefore as before for more.",
  input: z.strictObject({
    before: CursorSchema.optional(),
    limit: z.number().int().min(1).max(50).default(25),
    query: z.string().trim().min(1).max(256).optional(),
    workspaceId: WorkspaceIdSchema.optional(),
  }),
  output: ThreadListOutputSchema,
  access: "read",
  callers: ["run", "program", "connection"] as const,
});

export const thread_delegate = defineAgentTool({
  name: "thread_delegate",
  title: "Delegate Work",
  description:
    "Start work in workspaceId or reuse threadId. Runs and programs receive an Assignment and its result; connected agents create independent work and observe it with thread_read or thread_wait. Stop work with thread_write interrupt and inspect or resume it with thread_queue. New work stays within your approved access mode.",
  input: z
    .strictObject({
      environmentId: EnvironmentIdSchema.optional(),
      harnessInstanceId: HarnessInstanceIdSchema.optional(),
      model: DelegationModelChoiceSchema.optional(),
      observationId: z.string().trim().min(1).max(255).optional(),
      places: z.array(PlaceContentPartSchema).max(63).optional(),
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
        .describe(
          "For a new Thread: two to five words naming the outcome; defaults to task's first line.",
        ),
      icon: WorkspaceIconNameSchema.optional().describe(
        "For a new Thread: choose a symbol matching the task; otherwise the engine chooses.",
      ),
      specialist: z.string().trim().min(1).max(256).optional(),
      workspaceId: WorkspaceIdSchema.optional(),
      threadId: ThreadIdSchema.optional(),
    })
    .superRefine((input, context) => {
      if (
        input.threadId ? input.workspaceId !== undefined : !input.workspaceId && !input.specialist
      ) {
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
      if (input.threadId && input.icon) {
        context.addIssue({ code: "custom", message: "An existing Thread keeps its symbol" });
      }
    })
    .safeExtend({ operationKey: OperationKeySchema.optional() }),
  output: ThreadDelegateOutputSchema,
  access: "work",
  callers: ["run", "program", "connection"] as const,
});

export const assignment_cancel = defineAgentTool({
  name: "assignment_cancel",
  title: "Stop Task",
  description:
    "To stop a task durably, pass assignmentId. Cancels its descendants, interrupts running work and withdraws pending Requests; nothing restarts it. Its Thread remains reusable. Confirm the returned status before saying it stopped.",
  input: z
    .strictObject({ assignmentId: AssignmentIdSchema })
    .safeExtend({ operationKey: OperationKeySchema.optional() }),
  output: AssignmentCancelOutputSchema,
  access: "thread",
  callers: ["run"] as const,
  destructive: true,
});

export const thread_message = defineAgentTool({
  name: "thread_message",
  title: "Message Thread",
  description:
    "Send an asynchronous message. report saves context without starting work or alerting the person. queue starts an idle Thread or waits for its next turn. steer directs a compatible active Run and fails if none exists. queue and steer join an active task; assignmentId is null if none exists. To continue a finished task and receive its result, use thread_delegate. home means Chat; every destination must remain within the caller’s live reach and access mode. disposition is steering, run-queued, pending or cancelled. Accepted does not mean read; cancelled means it will not run. Task updates go to the assigning Thread; final replies return automatically. The Host supplies authorship.",
  input: z
    .strictObject({
      delivery: z.enum(["report", "queue", "steer"]),
      message: z
        .string()
        .trim()
        .min(1)
        .max(256 * 1_024),
      observationId: z.string().trim().min(1).max(255).optional(),
      threadId: z.union([ThreadIdSchema, z.literal("home")]),
    })
    .safeExtend({ operationKey: OperationKeySchema.optional() }),
  output: ThreadMessageOutputSchema,
  access: "work",
  callers: ["run", "program", "connection"] as const,
});

export const thread_write = defineAgentTool({
  name: "thread_write",
  title: "Update Task",
  description:
    "Interrupt a reachable Thread’s current Run; thread_queue shows and resumes paused work. A live Run can also rename, set_icon, mark done or reopen. Omit threadId for your own Thread; own done applies when the turn ends.",
  input: ThreadWriteInputSchema.safeExtend({ operationKey: OperationKeySchema.optional() }),
  output: ThreadWriteOutputSchema,
  access: "thread",
  destructive: true,
  callers: ["run", "program", "connection"] as const,
});

export const thread_wait = defineAgentTool({
  name: "thread_wait",
  title: "Wait for Thread",
  description:
    "Wait for the current Run to settle or a published message after afterMessageId. Waits at most 100 seconds. Disconnecting stops only the wait; work continues.",
  input: z.strictObject({
    threadId: ThreadIdSchema,
    afterMessageId: MessageIdSchema.optional(),
    timeoutMs: z.number().int().min(1).max(100_000).default(100_000),
  }),
  output: ThreadWaitOutputSchema,
  access: "read",
  callers: ["program", "connection"] as const,
});
export const thread_configure = defineAgentTool({
  name: "thread_configure",
  title: "Configure Thread",
  description:
    "Read or set a Thread's engine, model and options. Uses the same execution checks as the client. Access mode stays unchanged.",
  input: z
    .strictObject({
      action: z.enum(["read", "set"]),
      threadId: ThreadIdSchema,
      harnessInstanceId: HarnessInstanceIdSchema.optional(),
      modelSelection: ModelSelectionSchema.optional(),
      continuation: z
        .strictObject({ expectedProviderSessionId: ProviderSessionIdSchema.nullable() })
        .optional(),
      operationKey: OperationKeySchema.optional(),
    })
    .superRefine((input, ctx) => {
      if (
        input.action === "read" &&
        (input.harnessInstanceId || input.modelSelection || input.continuation)
      )
        ctx.addIssue({ code: "custom", message: "read takes no execution changes" });
      if (input.action === "set" && !input.harnessInstanceId && !input.modelSelection)
        ctx.addIssue({ code: "custom", message: "set requires an engine or model selection" });
    }),
  output: ThreadConfigureOutputSchema,
  access: "thread",
  callers: ["run", "program", "connection"] as const,
});
export const thread_queue = defineAgentTool({
  name: "thread_queue",
  title: "Manage Thread Queue",
  description:
    "List waiting inputs, cancel or move one, steer a queued input into the active Run, or resume a paused queue. Steering preserves the original message and requester.",
  input: z
    .strictObject({
      action: z.enum(["list", "cancel", "move", "steer", "resume"]),
      threadId: ThreadIdSchema,
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
  access: "thread",
  callers: ["run", "program", "connection"] as const,
  destructive: true,
});
