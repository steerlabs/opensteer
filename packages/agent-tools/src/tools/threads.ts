import { defineAgentTool } from "../registry.js";
import {
  AssignmentIdSchema,
  DelegationModelChoiceSchema,
  EnvironmentIdSchema,
  HarnessInstanceIdSchema,
  MessageIdSchema,
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
    "Find reachable Threads, newest updated first; workspaceId and query narrow the list. Main reaches owned Workspaces, Workspace reaches its Workspace, delegated reaches its lineage. Pass window.nextBefore as before for more.",
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
    "Call a ready specialist with specialist (registration id or plugin name), defaulting to this Workspace. Start ordinary independent work with workspaceId, or continue a finished task with threadId. New tasks inherit this Thread's computer, engine and model; consult environment_list for other selectors. Existing Threads keep their selection. Copy needed structured places, omitting auto and documentId; the Host checks provenance and access. Forwarding grants no access or session; release a held phone before handoff. Returns threadId and assignmentId; the final reply returns automatically. Do independent work or end your turn without polling. Change active work with thread_message; stop it with assignment_cancel.",
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
  callers: ["run", "program"] as const,
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
    "Send an asynchronous message. report saves context without starting work or alerting the person. queue starts an idle Thread or waits for its next turn. steer directs a compatible active Run and fails if none exists. queue and steer join an active task; assignmentId is null if none exists. To continue a finished task and receive its result, use thread_delegate. home means Chat; reporting there is allowed, but queueing requires reach. disposition is steering, run-queued, pending or cancelled. Accepted does not mean read; cancelled means it will not run. Task updates go to the assigning Thread; final replies return automatically. The Host supplies authorship.",
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
  callers: ["run", "program"] as const,
});

export const thread_write = defineAgentTool({
  name: "thread_write",
  title: "Update Task",
  description:
    "To change a task as its person can, set action: rename with title, set_icon with icon (null for the default), done, or reopen. Omit threadId for this task. done stops the task and the work it handed out; it then refuses new messages until reopen. done on this task applies when this turn ends.",
  input: ThreadWriteInputSchema.safeExtend({ operationKey: OperationKeySchema.optional() }),
  output: ThreadWriteOutputSchema,
  access: "thread",
  callers: ["run"] as const,
});
