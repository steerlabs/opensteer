import { assertRequestWorkspacesLocked } from "./request-workspace-locks.js";
import { markThreadStatePending } from "./thread-status.js";
import {
  AgentEventSchema,
  MessageAuthorSchema,
  createId,
  type AgentEvent,
  type AssignmentSummary,
  type EnvironmentId,
  type Message,
  type ProviderContinuationIdentity,
  type Request,
  type RequestCancellationReason,
  type RequestId,
  type RunId,
  type Thread,
  type ThreadAccessMode,
  type ThreadId,
  type ThreadStatus,
  type ThreadInput,
  type ThreadRunQueueEntry,
  type WorkspaceId,
  type UserId,
  type RunUsage,
} from "@opensteer/core";
import { sql, type Transaction } from "kysely";
import type { DatabaseSchema } from "./schema.js";

type HostWorkspaceEventInput =
  | Pick<
      Extract<AgentEvent, { readonly type: "place.entered" }>,
      "type" | "data" | "environmentId" | "runId" | "threadId" | "workspaceId"
    >
  | Pick<
      Extract<AgentEvent, { readonly type: "tool.started" }>,
      "type" | "data" | "environmentId" | "runId" | "threadId" | "workspaceId"
    >
  | Pick<
      Extract<AgentEvent, { readonly type: "tool.completed" }>,
      "type" | "data" | "environmentId" | "runId" | "threadId" | "workspaceId"
    >
  | {
      readonly data: {
        readonly status: ThreadStatus;
        readonly title: string;
        readonly icon: Thread["icon"];
        readonly doneAt?: Thread["doneAt"];
        readonly inputQueuePaused: boolean;
        readonly pendingRequests: number;
      };
      readonly environmentId: EnvironmentId;
      readonly runId: null;
      readonly threadId: ThreadId;
      readonly type: "thread.state-changed";
      readonly workspaceId: WorkspaceId;
    }
  | {
      readonly data: { readonly assignment: AssignmentSummary };
      readonly environmentId: EnvironmentId;
      readonly runId: RunId | null;
      readonly threadId: ThreadId;
      readonly type: "assignment.created" | "assignment.updated";
      readonly workspaceId: WorkspaceId;
    }
  | {
      readonly data: { readonly paused: boolean };
      readonly environmentId: EnvironmentId;
      readonly runId: null;
      readonly threadId: ThreadId;
      readonly type: "thread.input-queue-updated";
      readonly workspaceId: WorkspaceId;
    }
  | {
      readonly data: { readonly thread: Thread; readonly home?: true };
      readonly environmentId: EnvironmentId;
      readonly runId: null;
      readonly threadId: ThreadId;
      readonly type: "thread.created";
      readonly workspaceId: WorkspaceId;
    }
  | {
      readonly data: { readonly thread: Thread };
      readonly environmentId: EnvironmentId;
      readonly runId: null;
      readonly threadId: ThreadId;
      readonly type: "thread.execution-updated";
      readonly workspaceId: WorkspaceId;
    }
  | {
      readonly data: { readonly thread: Thread };
      readonly environmentId: EnvironmentId;
      readonly runId: null;
      readonly threadId: ThreadId;
      readonly type: "thread.listed";
      readonly workspaceId: WorkspaceId;
    }
  | {
      readonly data: { readonly accessMode: ThreadAccessMode };
      readonly environmentId: EnvironmentId;
      readonly runId: null;
      readonly threadId: ThreadId;
      readonly type: "thread.access-mode-updated";
      readonly workspaceId: WorkspaceId;
    }
  | {
      readonly data: { readonly continuationIdentity: ProviderContinuationIdentity };
      readonly environmentId: EnvironmentId;
      readonly runId: RunId;
      readonly threadId: ThreadId;
      readonly type: "thread.continuation-established";
      readonly workspaceId: WorkspaceId;
    }
  | {
      readonly data: {
        readonly input: ThreadInput | null;
        readonly message: Message;
        readonly addressedToUserId?: UserId;
      };
      readonly environmentId: EnvironmentId;
      readonly runId: RunId | null;
      readonly threadId: ThreadId;
      readonly type: "message.created";
      readonly workspaceId: WorkspaceId;
    }
  | {
      readonly data: { readonly message: Message };
      readonly environmentId: EnvironmentId;
      readonly runId: RunId;
      readonly threadId: ThreadId;
      readonly type: "message.placed";
      readonly workspaceId: WorkspaceId;
    }
  | {
      readonly data: { readonly input: ThreadInput };
      readonly environmentId: EnvironmentId;
      readonly runId: RunId | null;
      readonly threadId: ThreadId;
      readonly type: "thread-input.updated";
      readonly workspaceId: WorkspaceId;
    }
  | {
      readonly data: { readonly run: ThreadRunQueueEntry };
      readonly environmentId: EnvironmentId;
      readonly runId: RunId;
      readonly threadId: ThreadId;
      readonly type: "run.queued";
      readonly workspaceId: WorkspaceId;
    }
  | {
      readonly data: { readonly status: "queued" | "starting" };
      readonly environmentId: EnvironmentId;
      readonly runId: RunId;
      readonly threadId: ThreadId;
      readonly type: "run.status";
      readonly workspaceId: WorkspaceId;
    }
  | {
      readonly data: {
        readonly code: string;
        readonly message: string;
        readonly retryable: boolean;
        readonly status: "failed";
      };
      readonly environmentId: EnvironmentId;
      readonly runId: RunId;
      readonly threadId: ThreadId;
      readonly type: "run.failed";
      readonly workspaceId: WorkspaceId;
    }
  | {
      readonly data: { readonly status: "interrupted" };
      readonly environmentId: EnvironmentId;
      readonly runId: RunId;
      readonly threadId: ThreadId;
      readonly type: "run.interrupted";
      readonly workspaceId: WorkspaceId;
    }
  | {
      readonly data: {
        readonly attempt: number;
        readonly priorUsage?: RunUsage;
        readonly reason: "steer" | "recovery";
      };
      readonly environmentId: EnvironmentId;
      readonly runId: RunId;
      readonly threadId: ThreadId;
      readonly type: "run.restarted";
      readonly workspaceId: WorkspaceId;
    }
  | {
      readonly data: { readonly request: Request };
      readonly environmentId: EnvironmentId;
      readonly runId: RunId | null;
      readonly threadId: ThreadId;
      readonly type: "request.opened" | "request.resolved" | "request.updated";
      readonly workspaceId: WorkspaceId;
    }
  | {
      readonly data: { readonly reason: RequestCancellationReason; readonly requestId: RequestId };
      readonly environmentId: EnvironmentId;
      /** A Trigger-originated Request has no Run to attribute its cancellation to. */
      readonly runId: RunId | null;
      readonly threadId: ThreadId;
      readonly type: "request.cancelled";
      readonly workspaceId: WorkspaceId;
    };

export async function appendHostWorkspaceEvent(
  transaction: Transaction<DatabaseSchema>,
  input: HostWorkspaceEventInput,
): Promise<AgentEvent> {
  assertRequestWorkspacesLocked(transaction, [input.workspaceId]);
  const createdAt = new Date();
  const eventId = createId("event");
  const sequenceRow = await transaction
    .updateTable("workspaces")
    .set({ eventSequence: sql<string>`event_sequence + 1`, updatedAt: new Date() })
    .where("id", "=", input.workspaceId)
    .returning("eventSequence")
    .executeTakeFirstOrThrow();
  const event = AgentEventSchema.parse({
    createdAt: createdAt.toISOString(),
    data: await stampRunContext(transaction, input.type, input.runId, input.data),
    environmentId: input.environmentId,
    eventId,
    runId: input.runId,
    sequence: String(sequenceRow.eventSequence),
    threadId: input.threadId,
    type: input.type,
    workspaceId: input.workspaceId,
  });
  await transaction
    .insertInto("workspaceEvents")
    .values({
      createdAt,
      data: sql`${JSON.stringify(event.data)}::jsonb`,
      environmentId: event.environmentId,
      eventId,
      runId: event.runId,
      runnerBindingGeneration: null,
      runnerBootId: null,
      runnerId: null,
      runnerOrdinal: null,
      sequence: sequenceRow.eventSequence,
      threadId: event.threadId,
      type: event.type,
      workspaceId: event.workspaceId,
    })
    .executeTakeFirstOrThrow();
  if (event.type.startsWith("request.")) await markThreadStatePending(transaction, event.threadId);
  return event;
}

/** Lifecycle pages stand alone, including Host-written stops before execution. */
export async function stampRunContext(
  transaction: Transaction<DatabaseSchema>,
  type: string,
  runId: RunId | null,
  data: object,
): Promise<object> {
  if (
    ![
      "run.started",
      "run.status",
      "run.restarted",
      "run.phase",
      "run.completed",
      "run.failed",
      "run.interrupted",
    ].includes(type)
  )
    return data;
  if (runId === null) throw new Error("Run lifecycle event has no Run");
  const seed = await transaction
    .selectFrom("runs")
    .innerJoin("messages", "messages.id", "runs.seedInputId")
    .select(["messages.author", "runs.createdAt"])
    .select(
      sql<boolean>`exists (
      select 1 from messages input where input.run_id = runs.id
      and input.kind = 'input' and input.author->>'kind' = 'human'
    )`.as("personWaiting"),
    )
    .where("runs.id", "=", runId)
    .executeTakeFirstOrThrow();
  const startedBy = MessageAuthorSchema.parse(seed.author);
  return {
    ...data,
    startedBy,
    startedAt: seed.createdAt.toISOString(),
    personWaiting: startedBy.kind === "human" || seed.personWaiting,
  };
}
