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
  title: "Read a Thread",
  description:
    "Read reachable history/assigned tasks before answering about earlier work. Returns thread/messages/assignments and paging windows. query searches; aroundMessageId excludes search/paging. Page messages with window.nextBefore as before, keeping query; tasks with assignmentWindow.nextBefore as assignmentBefore.",
  input: z.strictObject({
    before: CursorSchema.optional().describe("Message cursor from window.nextBefore; keep query."),
    maxMessages: z.number().int().min(1).max(100).default(100),
    query: z.string().trim().min(1).max(256).optional(),
    aroundMessageId: MessageIdSchema.optional().describe(
      "Exact message anchor; excludes query and paging.",
    ),
    assignmentBefore: CursorSchema.optional().describe(
      "Assignment cursor from assignmentWindow.nextBefore.",
    ),
    threadId: ThreadIdSchema,
  }),
  output: ThreadReadOutputSchema,
  access: "read",
  callers: ["run", "program", "connection"] as const,
});

export const thread_list = defineAgentTool({
  name: "thread_list",
  title: "Find Threads",
  description:
    "Find reachable Threads by query/workspaceId, newest updated first. Returns Threads/window; pass window.nextBefore as before. Delegated work inherits its root’s reach.",
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
  title: "Start or continue a task",
  description:
    "Start independent work in workspaceId (or specialist), or continue a finished threadId. Reuse keeps engine/model; change those with thread_configure. Returns thread/input/message, nullable run/assignmentId. Runs/programs receive the result automatically; connections use thread_wait/thread_read. Work fits your reach/access ceiling. Active changes use thread_message; Stop uses thread_write interrupt.",
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
      icon: WorkspaceIconNameSchema.optional().describe(
        "New task symbol; omit for automatic choice.",
      ),
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
  title: "Cancel an Assignment",
  description:
    "Permanently cancel assignmentId and descendants: interrupts work, withdraws Requests and fences continuations. Run-only; Thread stays reusable. Confirm returned assignment.status before reporting stopped. Resumable Stop: thread_write interrupt.",
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
  title: "Message a Thread",
  description:
    "Send within reach/access ceiling. report: passive context; queue: next turn; steer: compatible active Run, never falls back. Returns disposition/joined assignmentId; null means no automatic return. Accepted is not read; cancelled will not execute. Continue finished work with thread_delegate for a returned result. home means Chat; Host supplies authorship.",
  input: z
    .strictObject({
      delivery: z
        .enum(["report", "queue", "steer"])
        .describe("report: context only; queue: next turn; steer: active Run only."),
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
  access: "work",
  callers: ["run", "program", "connection"] as const,
});

export const thread_write = defineAgentTool({
  name: "thread_write",
  title: "Update or interrupt a Thread",
  description:
    "interrupt stops the current Run and pauses a work queue; pending inputs remain. Inspect/resume with thread_queue. Connections need threadId; Runs/programs default to their Thread. Rename/set_icon/done/reopen are Run-only; own done applies at turn end. Returns Thread/doneWhenRunEnds/interruptedRunId. Targets must fit reach/access ceiling.",
  input: ThreadWriteInputSchema.safeExtend({ operationKey: OperationKeySchema.optional() }),
  output: ThreadWriteOutputSchema,
  access: "thread",
  destructive: true,
  callers: ["run", "program", "connection"] as const,
});

export const thread_wait = defineAgentTool({
  name: "thread_wait",
  title: "Wait for a Thread",
  description:
    "Wait for a Run to settle or a message after afterMessageId. Programs/connections only; Runs end their turn for continuation. Returns running/settled/offline/timed_out, messages and optional Run state. At most 100 seconds; disconnect ends only the wait. Use thread_read for missing history.",
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
      .default(100_000)
      .describe("Maximum wait in milliseconds; timeout never cancels work."),
  }),
  output: ThreadWaitOutputSchema,
  access: "read",
  callers: ["program", "connection"] as const,
});
export const thread_configure = defineAgentTool({
  name: "thread_configure",
  title: "Configure a Thread",
  description:
    "Read/set a reachable Thread’s engine/model/options within your access ceiling. set needs harnessInstanceId or modelSelection; returns saved selectors. Copy environment_list choices when available; never substitute after refusal. continuation confirms a known native-session switch. Access mode stays.",
  input: z
    .strictObject({
      action: z.enum(["read", "set"]),
      threadId: ThreadIdSchema,
      harnessInstanceId: HarnessInstanceIdSchema.optional().describe(
        "Engine account to set; omit to keep current.",
      ),
      modelSelection: ModelSelectionSchema.optional().describe(
        "Exact provider/model IDs and typed options; omit to keep current.",
      ),
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
  title: "Manage queued inputs",
  description:
    "List/change waiting inputs within reach/access ceiling. list returns paused/items and canCancel/canMove/canSteer. Changes return queue state/input. cancel/move/steer need messageId; move needs beforeMessageId, steer expectedRunId. Steering preserves authorship. resume retains original authority; preserve a person’s pause unless told to resume.",
  input: z
    .strictObject({
      action: z.enum(["list", "cancel", "move", "steer", "resume"]),
      threadId: ThreadIdSchema,
      messageId: MessageIdSchema.optional().describe(
        "Queued input for cancel, move or steer only.",
      ),
      beforeMessageId: MessageIdSchema.nullable()
        .optional()
        .describe("For move: destination message ID, or null for end."),
      expectedRunId: RunIdSchema.optional().describe("For steer: exact currently active Run."),
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
