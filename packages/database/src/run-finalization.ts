import { assertProjectAuthority } from "./deployment-execution-authority.js";
import { readProjectRunBinding, projectWorkIsCurrent } from "./execution-authority.js";
import { ProjectExecutionStore } from "./project-execution-store.js";
import { projectAssignmentEventsInTransaction } from "./assignment-store.js";
import { sql } from "kysely";
import { recordPersonWaited } from "./run-visibility.js";
import { appendDoneState } from "./task-done.js";
import { pauseTriggerInTransaction } from "./trigger-store.js";
import { lockRunProjectionRows } from "./run-projection-locks.js";
import { resendableControlCommandTypes } from "./command-delivery.js";
import { projectThreadState } from "./thread-status.js";
import {
  OpensteerError,
  ReplyTargetSchema,
  type AgentEvent,
  type RequestCancellationReason,
  type RunId,
  type ThreadId,
  type WorkspaceId,
  type RunFailure,
} from "@opensteer/core";
import type { Transaction } from "kysely";
import { ensureQueuedRun, settleOutstandingSteersForRun } from "./thread-inbox.js";
import { threadInputFromRow } from "./thread-row-mappers.js";
import {
  jsonValue,
  lockThreadRow,
  lockWorkspaceRow,
  type ChannelLinks,
} from "./store-primitives.js";
import { enqueueChannelConversationStatus, enqueueChannelReply } from "./channel-deliveries.js";
import { runReply } from "./run-reply.js";
import type { CommandRow, DatabaseSchema, RunRow } from "./schema.js";
import { appendHostWorkspaceEvent } from "./workspace-events.js";
import { cancelPending } from "./request-store.js";
import { settleAssignmentAfterRun, threadOrAssignmentHasPendingWork } from "./assignment-store.js";
import { endLiveExecutionNodes } from "./execution-nodes.js";
import { endOpenAttempts } from "./run-attempts.js";
import { revokeRunGrants, type RevokedRunGrant, runWasStopped } from "./run-grants.js";

interface FinalizeRunRequest {
  readonly requestCancellationReason?: RequestCancellationReason;
  readonly completedAt: Date;
  readonly expectedCommandId?: CommandRow["id"];
  readonly failure?: RunFailure;
  /** How a channel status message names the Thread it points at. */
  readonly links: ChannelLinks;
  /** The proof source determines both event authorship and execute receipt. */
  readonly source: "host" | "runner";
  readonly queuedInputCancellation: "activation-input" | "authority-cohort" | "seed-input";
  readonly runId: RunId;
  readonly status: "completed" | "failed" | "interrupted";
}

/** The durable terminal transition for person execution. */
export async function finalizeRunTransaction(
  transaction: Transaction<DatabaseSchema>,
  requested: FinalizeRunRequest,
): Promise<readonly AgentEvent[]> {
  if (requested.status === "failed" && !requested.failure) {
    throw new OpensteerError({ code: "internal", message: "Failed Run has no failure record" });
  }
  const run = await transaction
    .selectFrom("runs")
    .innerJoin("threads", "threads.id", "runs.threadId")
    .select([
      "runs.assignmentId",
      "runs.doneWhenFinished",
      "runs.bindingGeneration",
      "runs.environmentId",
      "runs.activationInputId",
      "runs.harnessInstanceId",
      "runs.id",
      "runs.providerSessionId",
      "runs.membershipGeneration",
      "runs.replyTarget",
      "runs.requestedBy",
      "runs.status as runStatus",
      "runs.threadId",
      "runs.seedInputId",
      "runs.turnReplyMessageId",
      "threads.workspaceId",
    ])
    .where("runs.id", "=", requested.runId)
    .forNoKeyUpdate("runs")
    .executeTakeFirst();
  if (!run || !["queued", "starting", "running", "waiting"].includes(run.runStatus)) return [];
  // A Run someone stopped ended because they stopped it, whatever the Host
  // found first: a lost Runner, an expired lease, a refused dispatch. What a
  // Runner reports is its own record and stands.
  const input: FinalizeRunRequest =
    requested.source === "host" &&
    requested.status === "failed" &&
    (await runWasStopped(transaction, run.id))
      ? stoppedOutcome(requested)
      : requested;
  await lockWorkspaceRow(transaction, run.workspaceId);
  await lockThreadRow(transaction, run.threadId);
  const thread = await transaction
    .selectFrom("threads")
    .selectAll()
    .where("id", "=", run.threadId)
    .executeTakeFirstOrThrow();
  await lockRunProjectionRows(transaction, { runIds: [run.id], threadIds: [run.threadId] });
  if (input.expectedCommandId) {
    const command = await transaction
      .selectFrom("commands")
      .select(["runId", "status", "type"])
      .where("id", "=", input.expectedCommandId)
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (
      !command ||
      command.runId !== run.id ||
      command.type !== "run.execute" ||
      command.status !== "dispatched"
    ) {
      return [];
    }
  }
  const events: AgentEvent[] = [];
  if (input.source === "host") {
    if (input.status === "completed") {
      throw new OpensteerError({
        code: "internal",
        message: "A Host cannot prove a successful Run completion",
      });
    }
    events.push(
      input.status === "failed"
        ? await appendHostWorkspaceEvent(transaction, {
            data: input.failure as {
              readonly code: string;
              readonly message: string;
              readonly retryable: boolean;
              readonly status: "failed";
            },
            environmentId: run.environmentId,
            runId: run.id,
            threadId: run.threadId,
            type: "run.failed",
            workspaceId: run.workspaceId,
          })
        : await appendHostWorkspaceEvent(transaction, {
            data: { status: "interrupted" },
            environmentId: run.environmentId,
            runId: run.id,
            threadId: run.threadId,
            type: "run.interrupted",
            workspaceId: run.workspaceId,
          }),
    );
  }

  // A person who started this from a channel never sees the Thread, so how it
  // ended has to reach them where they wrote: the Run's reply when it
  // completed, which is all they are sent of what the agent wrote, and a
  // notice when it did not.
  const replyTarget = run.replyTarget ? ReplyTargetSchema.parse(run.replyTarget) : null;
  if (replyTarget && input.status === "completed") {
    const reply = await runReply(transaction, {
      id: run.id,
      threadId: run.threadId,
    });
    // A reply its channel already heard when a turn ended in the background.
    if (reply && reply.id !== run.turnReplyMessageId) {
      await enqueueChannelReply(transaction, {
        content: reply.content,
        conversationId: replyTarget.conversationId,
        links: input.links,
        messageId: reply.id,
        threadId: run.threadId,
      });
    }
  } else if (
    replyTarget &&
    (input.status !== "interrupted" ||
      !(await transaction
        .selectFrom("commands")
        .select("id")
        .where("runId", "=", run.id)
        .where("type", "=", "run.interrupt")
        .where(sql<string>`authority_source->>'kind'`, "=", "request-hold")
        .executeTakeFirst()))
  ) {
    const threadUrl = input.links.threadUrl(run.threadId);
    await enqueueChannelConversationStatus(transaction, {
      conversationId: replyTarget.conversationId,
      text:
        input.status === "failed"
          ? `Something went wrong and the agent could not finish. ${failureSummary(input.failure)} Open the Thread in Opensteer: ${threadUrl}`
          : `The agent was stopped. Open the Thread in Opensteer: ${threadUrl}`,
    });
  }

  await recordPersonWaited(transaction, run.id);
  const cleanup = await cleanupRunAttemptTransaction(transaction, {
    completedAt: input.completedAt,
    failure: input.failure,
    requestCancellationReason: input.requestCancellationReason ?? "run-ended",
    run: { ...run, status: run.runStatus },
    source: input.source,
    status: input.status,
  });
  events.push(...cleanup.events);
  const cancelled =
    run.runStatus === "queued"
      ? await transaction
          .updateTable("threadInputs")
          .set({
            cancelReason:
              input.queuedInputCancellation === "authority-cohort"
                ? "execution-authority-unavailable"
                : "run-ended-before-start",
            state: "cancelled",
            updatedAt: input.completedAt,
          })
          .where("threadId", "=", run.threadId)
          .where("policy", "!=", "report")
          .$if(input.queuedInputCancellation === "authority-cohort", (query) =>
            query
              .where("requestedBy", "=", run.requestedBy)
              .where("membershipGeneration", "=", run.membershipGeneration),
          )
          .$if(input.queuedInputCancellation === "seed-input", (query) =>
            query.where("messageId", "=", run.seedInputId),
          )
          .$if(input.queuedInputCancellation === "activation-input", (query) =>
            query.where("messageId", "=", run.activationInputId),
          )
          .where("state", "=", "pending")
          .returningAll()
          .execute()
      : await transaction
          .updateTable("threadInputs")
          .set({
            cancelReason: "run-ended-before-start",
            state: "cancelled",
            updatedAt: input.completedAt,
          })
          .where("runId", "=", run.id)
          .where("policy", "!=", "report")
          .where("steerCommandId", "is", null)
          .where("state", "=", "claimed")
          .returningAll()
          .execute();
  if (run.runStatus === "queued") {
    cancelled.push(
      ...(await transaction
        .updateTable("threadInputs")
        .set({
          cancelReason:
            input.queuedInputCancellation === "authority-cohort"
              ? "execution-authority-unavailable"
              : "run-ended-before-start",
          state: "cancelled",
          updatedAt: input.completedAt,
        })
        .where("runId", "=", run.id)
        .where("policy", "!=", "report")
        .where("steerCommandId", "is", null)
        .where("state", "=", "claimed")
        .returningAll()
        .execute()),
    );
  }
  if (run.runStatus !== "queued" && input.queuedInputCancellation === "activation-input") {
    cancelled.push(
      ...(await transaction
        .updateTable("threadInputs")
        .set({
          cancelReason: "run-ended-before-start",
          state: "cancelled",
          updatedAt: input.completedAt,
        })
        .where("messageId", "=", run.activationInputId)
        .where("state", "=", "pending")
        .returningAll()
        .execute()),
    );
  }
  // A terminal event without a start receipt cannot prove whether the provider
  // saw the frozen reports. Retain that uncertainty; only later real work may
  // deliver them again, with the same IDs and the old snapshot still on its Run.
  const membership = await transaction
    .selectFrom("workspaceMemberships")
    .select(["generation", "state"])
    .where("workspaceId", "=", run.workspaceId)
    .where("userId", "=", run.requestedBy)
    .executeTakeFirst();
  const reportAuthorityCurrent =
    membership?.state === "active" && membership.generation === run.membershipGeneration;
  const unconfirmedReports = await transaction
    .updateTable("threadInputs")
    .set(
      reportAuthorityCurrent
        ? { state: "unknown", updatedAt: input.completedAt }
        : {
            cancelReason: "membership-changed",
            state: "cancelled",
            updatedAt: input.completedAt,
          },
    )
    .where("runId", "=", run.id)
    .where("policy", "=", "report")
    .where("state", "=", "claimed")
    .returningAll()
    .execute();
  for (const row of [...cancelled, ...unconfirmedReports]) {
    events.push(
      await appendHostWorkspaceEvent(transaction, {
        data: { input: threadInputFromRow(row) },
        environmentId: run.environmentId,
        runId: run.id,
        threadId: run.threadId,
        type: "thread-input.updated",
        workspaceId: run.workspaceId,
      }),
    );
  }
  await transaction
    .updateTable("runs")
    .set({
      completedAt: input.completedAt,
      failure: input.status === "failed" ? jsonValue(input.failure!) : null,
      status: input.status,
    })
    .where("id", "=", run.id)
    .executeTakeFirstOrThrow();
  if (run.assignmentId) {
    events.push(
      ...(await settleAssignmentAfterRun(transaction, {
        assignmentId: run.assignmentId,
        failureSummary: input.status === "failed" ? failureSummary(input.failure) || null : null,
        finishedAt: input.completedAt,
        run: { id: run.id, threadId: run.threadId },
        status: input.status,
      })),
    );
  }

  if (run.doneWhenFinished) {
    await transaction
      .updateTable("runs")
      .set({ doneWhenFinished: false })
      .where("id", "=", run.id)
      .execute();
    if (!(await threadOrAssignmentHasPendingWork(transaction, { threadId: run.threadId }))) {
      const triggers = await transaction
        .selectFrom("triggers")
        .selectAll()
        .where("anchorThreadId", "=", run.threadId)
        .where("status", "=", "active")
        .execute();
      for (const trigger of triggers) await pauseTriggerInTransaction(transaction, trigger);
      const doneAt = input.completedAt;
      await transaction
        .updateTable("threads")
        .set({ doneAt, doneReason: null, inputQueuePaused: false, inputQueuePausedBy: null })
        .where("id", "=", run.threadId)
        .execute();
      thread.doneAt = doneAt;
      thread.doneReason = null;
      thread.inputQueuePaused = false;
      events.push(await appendDoneState(transaction, run.threadId));
    }
  }

  // A corrupt selection must not roll back an already accepted terminal event.
  // Pending work remains queued until an explicit engine selection repairs it.
  const followOn = await ensureQueuedRun(transaction, thread, { onInvalidSelection: "defer" });
  events.push(...followOn.events);
  if (run.doneWhenFinished) {
    await transaction
      .updateTable("runs")
      .set({ doneWhenFinished: false })
      .where("id", "=", run.id)
      .execute();
    if (!(await threadOrAssignmentHasPendingWork(transaction, { threadId: run.threadId }))) {
      const triggers = await transaction
        .selectFrom("triggers")
        .selectAll()
        .where("anchorThreadId", "=", run.threadId)
        .where("status", "=", "active")
        .execute();
      for (const trigger of triggers) await pauseTriggerInTransaction(transaction, trigger);
      await transaction
        .updateTable("threads")
        .set({
          doneAt: input.completedAt,
          doneReason: null,
          inputQueuePaused: false,
          inputQueuePausedBy: null,
        })
        .where("id", "=", run.threadId)
        .execute();
      events.push(await appendDoneState(transaction, run.threadId));
    }
  }
  events.push(...(await projectThreadState(transaction, run.threadId, input.completedAt)));
  // Nodes and attempts rank last; the Run's lock already orders these writes.
  await cleanup.finish(() => endOpenAttempts(transaction, run.id, input.status));
  return events;
}

/** One sentence a person can act on, never a stack trace. */
function failureSummary(failure: RunFailure | undefined): string {
  const message = failure?.message.trim() ?? "";
  if (message.length === 0) return "";
  const sentence = message.length > 240 ? `${message.slice(0, 239).trimEnd()}\u2026` : message;
  return /[.!?\u2026]$/u.test(sentence) ? sentence : `${sentence}.`;
}

function stoppedOutcome(requested: FinalizeRunRequest): FinalizeRunRequest {
  const { failure: _failure, ...stopped } = requested;
  return { ...stopped, status: "interrupted" };
}

/**
 * Ends a stopped starting Run that no Runner holds, where it would otherwise
 * go back to its Thread's queue: a stop is final. The caller holds the Run,
 * Workspace and Thread locks and has not touched its commands.
 */
export async function endStoppedUnconfirmedRun(
  transaction: Transaction<DatabaseSchema>,
  input: { readonly links: ChannelLinks; readonly runId: RunId },
): Promise<readonly AgentEvent[]> {
  const events = await finalizeRunTransaction(transaction, {
    completedAt: new Date(),
    links: input.links,
    queuedInputCancellation: "activation-input",
    runId: input.runId,
    source: "host",
    status: "interrupted",
  });
  // No Runner holds it, which proves no native start as surely as a Run that
  // was never bound, so it cannot make a later Run's start uncertain.
  await transaction
    .updateTable("runs")
    .set({ bindingGeneration: null })
    .where("id", "=", input.runId)
    .execute();
  return events;
}

/**
 * Terminal cleanup of one execution, without deciding the Run's outcome.
 * The caller holds lockRunProjectionRows. Finish only after all projections:
 * nodes, attempts and grants acquire the final ranks in lock-order.ts.
 */
export async function cleanupRunAttemptTransaction(
  transaction: Transaction<DatabaseSchema>,
  input: {
    readonly completedAt: Date;
    readonly failure?: RunFailure | undefined;
    readonly requestCancellationReason: RequestCancellationReason;
    readonly retireBinding?: boolean;
    readonly cancelRequests?: (() => Promise<readonly AgentEvent[]>) | undefined;
    readonly run: Pick<RunRow, "id" | "providerSessionId" | "bindingGeneration" | "status">;
    readonly source: "host" | "runner";
    readonly status: "completed" | "failed" | "interrupted";
  },
): Promise<{
  readonly events: readonly AgentEvent[];
  readonly finish: (endAttempts: () => Promise<void>) => Promise<readonly RevokedRunGrant[]>;
}> {
  const { run } = input;
  const events = [
    ...(await settleOutstandingSteersForRun(transaction, run.id, input.retireBinding)),
  ];
  events.push(
    ...(input.cancelRequests
      ? await input.cancelRequests()
      : await cancelPending(transaction, {
          reason: input.requestCancellationReason,
          resolvedAt: input.completedAt,
          runId: run.id,
        })),
  );
  // A terminal Run proves that its execute command ran, but it does not prove
  // delivery of unrelated controls.  Steers were settled above; unresolved
  // Request responses and interrupts fail closed instead of receiving a
  // fabricated success receipt.
  await transaction
    .updateTable("commands")
    .set({
      ...(input.source === "host" && input.failure ? { lastError: jsonValue(input.failure) } : {}),
      status: input.source === "host" ? "failed" : "succeeded",
      updatedAt: input.completedAt,
    })
    .where("runId", "=", run.id)
    .where("type", "=", "run.execute")
    .where("status", "in", ["pending", "dispatched", "unknown"])
    .execute();
  await transaction
    .updateTable("commands")
    .set({
      lastError: jsonValue({ message: "The Run ended before control delivery was confirmed" }),
      status: "failed",
      updatedAt: input.completedAt,
    })
    .where("runId", "=", run.id)
    .where("type", "in", resendableControlCommandTypes)
    .where("status", "in", ["pending", "dispatched", "unknown"])
    .execute();
  // A Run stopped before it was bound never reached its session.
  if (
    run.status !== "queued" &&
    !(input.status === "interrupted" && run.bindingGeneration === null)
  ) {
    await transaction
      .updateTable("providerSessions")
      .set({
        status: input.status === "failed" ? "broken" : "ready",
        updatedAt: input.completedAt,
      })
      .where("id", "=", run.providerSessionId)
      .execute();
  }

  if (input.retireBinding) {
    await transaction
      .updateTable("providerSessions")
      .set((expression) => ({
        bindingGeneration: expression("bindingGeneration", "+", 1),
        leaseExpiresAt: null,
        leaseTokenHash: null,
        runnerId: null,
        runnerBootId: null,
        status: "ready",
        updatedAt: input.completedAt,
      }))
      .where("id", "=", run.providerSessionId)
      .execute();
    // Unknown describes the input's receipt, not a command that may still act.
    await transaction
      .updateTable("commands")
      .set({
        lastError: jsonValue({
          message: "The execution was lost before control delivery completed",
        }),
        status: "failed",
        updatedAt: input.completedAt,
      })
      .where("runId", "=", run.id)
      .where("status", "in", ["pending", "dispatched", "unknown"])
      .execute();
  }
  return {
    events,
    finish: async (endAttempts) => {
      await endLiveExecutionNodes(transaction, { endedAt: input.completedAt, runId: run.id });
      await endAttempts();
      return input.retireBinding ? revokeRunGrants(transaction, [run.id], "superseded") : [];
    },
  };
}

export type ProjectRunRequestCancellation = (
  transaction: Transaction<DatabaseSchema>,
  input: {
    readonly runId: RunId;
    readonly reason: RequestCancellationReason;
    readonly resolvedAt: Date;
  },
) => Promise<readonly AgentEvent[]>;

export async function cancelProjectRunRequests(
  transaction: Transaction<DatabaseSchema>,
  input: Parameters<ProjectRunRequestCancellation>[1],
  cancel?: ProjectRunRequestCancellation,
): Promise<readonly AgentEvent[]> {
  const events = cancel ? await cancel(transaction, input) : [];
  if (
    await transaction
      .selectFrom("requests")
      .select("id")
      .where("originatingRunId", "=", input.runId)
      .where("status", "=", "pending")
      .executeTakeFirst()
  )
    throw new OpensteerError({
      code: "conflict",
      reason: "project-request-cancellation-unavailable",
      message: "Project Run termination requires Q's Request cancellation boundary",
    });
  return events;
}

export interface ProjectRunFinalization {
  readonly runId: RunId;
  readonly source: "host" | "runner";
  readonly status: "completed" | "failed" | "interrupted";
  readonly completedAt: Date;
  readonly failure?: RunFailure | undefined;
  readonly stopReason?: "authority-revoked" | "no-eligible-manager";
  readonly deferAttemptCleanup?: boolean;
  readonly cancelRequests?: ProjectRunRequestCancellation | undefined;
}

/** The caller reserves the complete projection prefix before Q cancellation or late person fences. */
export async function finalizeProjectRunTransaction(
  transaction: Transaction<DatabaseSchema>,
  input: ProjectRunFinalization,
): Promise<readonly AgentEvent[]> {
  await assertProjectAuthority(transaction);
  if (
    (input.status === "failed" && !input.failure) ||
    (input.source === "host" && input.status === "completed")
  )
    throw new OpensteerError({
      code: "bad_request",
      message: "Project terminal state has no valid completion proof",
    });
  const run = await transaction
    .selectFrom("runs")
    .innerJoin("threads", "threads.id", "runs.threadId")
    .innerJoin("principals", "principals.id", "runs.actorPrincipalId")
    .selectAll("runs")
    .select([
      "threads.workspaceId",
      "principals.kind as principalKind",
      "principals.workspaceId as principalWorkspaceId",
    ])
    .where("runs.id", "=", input.runId)
    .forNoKeyUpdate("runs")
    .executeTakeFirst();
  if (!run) return [];
  if (run.principalKind !== "project" || run.principalWorkspaceId !== run.workspaceId)
    throw new OpensteerError({ code: "forbidden", message: "Terminal work is not a Project Run" });
  if (input.stopReason === "no-eligible-manager" && run.requestedBy !== null)
    throw new OpensteerError({
      code: "bad_request",
      message: "Planned managerless cancellation only stops unattended work",
    });
  if (!["queued", "starting", "running", "waiting"].includes(run.status)) return [];
  if (run.replyTarget !== null)
    throw new OpensteerError({
      code: "forbidden",
      reason: "channel-not-supported",
      message: "Project work does not route channel replies",
    });
  const derivedThreads = input.stopReason
    ? await transaction
        .selectFrom("threadInputs")
        .select("threadId")
        .where(sql<string>`authority_source->>'parentRunId'`, "=", run.id)
        .where("state", "in", ["pending", "claimed", "unknown"])
        .execute()
    : [];
  await lockWorkspaceRow(transaction, run.workspaceId);
  const assignment = run.assignmentId
    ? await transaction
        .selectFrom("delegations")
        .selectAll()
        .where("id", "=", run.assignmentId)
        .executeTakeFirst()
    : null;
  const threadIds = [
    ...new Set([
      run.threadId,
      ...(assignment ? [assignment.parentThreadId] : []),
      ...derivedThreads.map((row) => row.threadId),
    ]),
  ];
  const threads = await transaction
    .selectFrom("threads")
    .select(["id", "workspaceId"])
    .where("id", "in", threadIds)
    .where("workspaceId", "=", run.workspaceId)
    .orderBy("id")
    .forNoKeyUpdate()
    .execute();
  if (threads.length !== threadIds.length)
    throw new OpensteerError({
      code: "forbidden",
      message: "Project terminal work crosses a Workspace boundary",
    });
  await lockRunProjectionRows(transaction, { runIds: [run.id], threadIds });
  const grant =
    run.bindingGeneration === null
      ? null
      : await transaction
          .selectFrom("grants")
          .select("id")
          .where("runId", "=", run.id)
          .where("bindingGeneration", "=", run.bindingGeneration)
          .executeTakeFirst();
  const original = grant
    ? await readProjectRunBinding(transaction, { runId: run.id, grantId: grant.id })
    : null;
  const cleanup = await cleanupRunAttemptTransaction(transaction, {
    run,
    source: input.source,
    status: input.status,
    completedAt: input.completedAt,
    failure: input.failure,
    requestCancellationReason: input.stopReason ? "authority-revoked" : "run-ended",
    cancelRequests: () =>
      cancelProjectRunRequests(
        transaction,
        {
          runId: run.id,
          reason: input.stopReason ? "authority-revoked" : "run-ended",
          resolvedAt: input.completedAt,
        },
        input.cancelRequests,
      ),
  });
  const events: AgentEvent[] = [...cleanup.events];
  const sourceCurrent =
    input.stopReason === undefined && (await projectWorkIsCurrent(transaction, run));
  const receipts = await transaction
    .selectFrom("threadInputs")
    .selectAll()
    .where((eb) =>
      eb.or([
        eb("runId", "=", run.id),
        eb("messageId", "=", run.seedInputId),
        ...(input.stopReason
          ? [eb(sql<string>`authority_source->>'parentRunId'`, "=", run.id)]
          : []),
      ]),
    )
    .where("state", "in", ["pending", "claimed", "unknown"])
    .orderBy("messageId")
    .execute();
  for (const receipt of receipts) {
    const steerCommand = receipt.steerCommandId
      ? await transaction
          .selectFrom("commands")
          .select("status")
          .where("id", "=", receipt.steerCommandId)
          .executeTakeFirst()
      : null;
    const reportUnknown =
      sourceCurrent &&
      ((receipt.policy === "report" && receipt.state !== "pending") ||
        (receipt.policy === "steer" &&
          (receipt.state === "unknown" ||
            (steerCommand &&
              ["dispatched", "unknown", "succeeded"].includes(steerCommand.status)))));
    const updated = await transaction
      .updateTable("threadInputs")
      .set(
        reportUnknown
          ? { state: "unknown", updatedAt: input.completedAt }
          : {
              state: "cancelled",
              cancelReason: input.stopReason
                ? "execution-authority-unavailable"
                : "run-ended-before-start",
              updatedAt: input.completedAt,
            },
      )
      .where("messageId", "=", receipt.messageId)
      .returningAll()
      .executeTakeFirstOrThrow();
    events.push(
      await appendHostWorkspaceEvent(transaction, {
        type: "thread-input.updated",
        data: { input: threadInputFromRow(updated) },
        environmentId: run.environmentId,
        workspaceId: run.workspaceId,
        threadId: receipt.threadId,
        runId: updated.runId,
      }),
    );
  }
  await transaction
    .updateTable("commands")
    .set({
      status: input.source === "runner" ? "succeeded" : "failed",
      lastError: input.failure ? jsonValue(input.failure) : null,
      updatedAt: input.completedAt,
    })
    .where("runId", "=", run.id)
    .where("type", "=", "run.execute.project")
    .where("status", "in", ["pending", "dispatched", "unknown"])
    .execute();
  await transaction
    .updateTable("commands")
    .set({
      status: "failed",
      lastError: jsonValue({
        code: "project_control_unavailable",
        message: "Project Run ended before control delivery was confirmed",
      }),
      updatedAt: input.completedAt,
    })
    .where("runId", "=", run.id)
    .where("type", "=", "run.control.project")
    .where(sql<string>`payload->'control'->>'kind'`, "!=", "run.interrupt")
    .where("status", "in", ["pending", "dispatched"])
    .execute();
  await transaction
    .updateTable("runs")
    .set({
      status: input.status,
      completedAt: input.completedAt,
      failure: input.failure ? jsonValue(input.failure) : null,
    })
    .where("id", "=", run.id)
    .execute();
  if (input.source === "host") {
    if (input.status === "failed" && input.failure)
      events.push(
        await appendHostWorkspaceEvent(transaction, {
          type: "run.failed",
          data: input.failure,
          environmentId: run.environmentId,
          workspaceId: run.workspaceId,
          threadId: run.threadId,
          runId: run.id,
        }),
      );
    else
      events.push(
        await appendHostWorkspaceEvent(transaction, {
          type: "run.interrupted",
          data: { status: "interrupted" },
          environmentId: run.environmentId,
          workspaceId: run.workspaceId,
          threadId: run.threadId,
          runId: run.id,
        }),
      );
  }
  if (assignment) {
    if (input.stopReason && assignment.status === "open") {
      const cancelled = await transaction
        .updateTable("delegations")
        .set((eb) => ({
          status: "cancelled",
          finishedAt: input.completedAt,
          resultStatus: "undeliverable",
          completedAt: input.completedAt,
          resultReason: input.stopReason,
          resultAttemptedAt: input.completedAt,
          revision: eb("revision", "+", 1),
          updatedAt: input.completedAt,
        }))
        .where("id", "=", assignment.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      events.push(
        ...(await projectAssignmentEventsInTransaction(
          transaction,
          cancelled,
          "assignment.updated",
          run.id,
        )),
      );
    } else {
      const settled = await settleAssignmentAfterRun(transaction, {
        assignmentId: assignment.id,
        status: input.status,
        finishedAt: input.completedAt,
        failureSummary: input.failure?.message ?? null,
        run,
      });
      events.push(...settled);
      for (const event of settled)
        if (event.type === "assignment.updated") {
          const parent = threads.find((thread) => thread.id === assignment.parentThreadId);
          if (!parent)
            throw new OpensteerError({
              code: "forbidden",
              message: "Project Assignment parent is unavailable",
            });
          events.push(
            await appendHostWorkspaceEvent(transaction, {
              type: "assignment.updated",
              data: event.data,
              environmentId: run.environmentId,
              workspaceId: parent.workspaceId,
              threadId: parent.id,
              runId: assignment.parentRunId,
            }),
          );
        }
    }
  }
  events.push(...(await projectThreadState(transaction, run.threadId, input.completedAt)));
  if (input.source === "host" && original)
    await new ProjectExecutionStore().enqueue(transaction, {
      binding: original.binding,
      idempotencyKey: `terminal:${run.id}:${original.binding.bindingGeneration}`,
      control: { kind: "run.interrupt" },
    });
  if (!input.deferAttemptCleanup)
    await cleanup.finish(() => endOpenAttempts(transaction, run.id, input.status));
  return events;
}

/** Authority writers finish late-ranked engine projections through the durable interrupt worker. */
export async function finishTerminalProjectRunTransaction(
  transaction: Transaction<DatabaseSchema>,
  runId: RunId,
): Promise<void> {
  const run = await transaction
    .selectFrom("runs")
    .select(["status", "completedAt"])
    .where("id", "=", runId)
    .executeTakeFirst();
  if (
    !run ||
    (run.status !== "completed" && run.status !== "failed" && run.status !== "interrupted")
  )
    return;
  await endLiveExecutionNodes(transaction, { runId, endedAt: run.completedAt ?? new Date() });
  await endOpenAttempts(transaction, runId, run.status);
}

export interface ProjectRequestStopPort {
  stop(
    transaction: Transaction<DatabaseSchema>,
    input: {
      readonly runIds: readonly RunId[];
      readonly reason: "authority-revoked" | "no-eligible-manager";
      readonly requestEvents: readonly AgentEvent[];
    },
  ): Promise<void>;
}

/** Collect into the authority mutation's publication batch, which its owner publishes only after commit. */
export class ProjectWorkStopStore implements ProjectRequestStopPort {
  readonly collectEvents: (
    transaction: Transaction<DatabaseSchema>,
    events: readonly AgentEvent[],
  ) => void;
  constructor(collectEvents: ProjectWorkStopStore["collectEvents"]) {
    this.collectEvents = collectEvents;
  }

  async stop(
    transaction: Transaction<DatabaseSchema>,
    input: Parameters<ProjectRequestStopPort["stop"]>[1],
  ): Promise<void> {
    const events = [...input.requestEvents];
    for (const runId of [...new Set(input.runIds)].sort()) {
      events.push(
        ...(await finalizeProjectRunTransaction(transaction, {
          runId,
          source: "host",
          status: "failed",
          completedAt: new Date(),
          stopReason: input.reason,
          deferAttemptCleanup: true,
          failure: {
            code:
              input.reason === "authority-revoked"
                ? "workspace_access_revoked"
                : "no_eligible_manager",
            message:
              input.reason === "authority-revoked"
                ? "The captured Project work origin lost authority"
                : "The planned final Project has no eligible manager",
            retryable: false,
            status: "failed",
          },
        })),
      );
    }
    this.collectEvents(transaction, events);
  }
}

/** Reserve before Request cancellation or user fences; rediscover growth before calling this prefix. */
export async function reserveProjectWorkStop(
  transaction: Transaction<DatabaseSchema>,
  input: {
    readonly runIds: readonly RunId[];
    readonly workspaceIds?: readonly WorkspaceId[];
    readonly threadIds?: readonly ThreadId[];
  },
): Promise<void> {
  if (!input.runIds.length && !input.threadIds?.length) return;
  const runs = input.runIds.length
    ? await transaction
        .selectFrom("runs")
        .innerJoin("threads", "threads.id", "runs.threadId")
        .innerJoin("principals", "principals.id", "runs.actorPrincipalId")
        .select([
          "runs.id",
          "runs.threadId",
          "runs.assignmentId",
          "threads.workspaceId",
          "principals.kind as principalKind",
          "principals.workspaceId as principalWorkspaceId",
        ])
        .where("runs.id", "in", [...input.runIds])
        .orderBy("runs.id")
        .forNoKeyUpdate("runs")
        .execute()
    : [];
  if (
    runs.some(
      (row) => row.principalKind !== "project" || row.principalWorkspaceId !== row.workspaceId,
    )
  )
    throw new OpensteerError({
      code: "forbidden",
      message: "Work cancellation scope includes a non-Project Run",
    });
  const assignments = runs.flatMap((row) => (row.assignmentId ? [row.assignmentId] : []));
  const parents = assignments.length
    ? await transaction
        .selectFrom("delegations")
        .select("parentThreadId")
        .where("id", "in", assignments)
        .execute()
    : [];
  const derived = runs.length
    ? await transaction
        .selectFrom("threadInputs")
        .select("threadId")
        .where(
          sql<string>`authority_source->>'parentRunId'`,
          "in",
          runs.map((row) => row.id),
        )
        .where("state", "in", ["pending", "claimed", "unknown"])
        .execute()
    : [];
  const threadIds = [
    ...new Set([
      ...runs.map((row) => row.threadId),
      ...parents.map((row) => row.parentThreadId),
      ...derived.map((row) => row.threadId),
      ...(input.threadIds ?? []),
    ]),
  ].sort();
  const threads = threadIds.length
    ? await transaction
        .selectFrom("threads")
        .select(["id", "workspaceId"])
        .where("id", "in", threadIds)
        .execute()
    : [];
  const workspaceIds = [
    ...new Set([...runs.map((row) => row.workspaceId), ...(input.workspaceIds ?? [])]),
  ].sort();
  if (
    threads.length !== threadIds.length ||
    threads.some((row) => !workspaceIds.includes(row.workspaceId))
  )
    throw new OpensteerError({
      code: "conflict",
      message: "Work cancellation reservation needs its complete Workspace scope",
    });
  if (workspaceIds.length)
    await transaction
      .selectFrom("workspaces")
      .select("id")
      .where("id", "in", workspaceIds)
      .orderBy("id")
      .forNoKeyUpdate()
      .execute();
  if (threadIds.length)
    await transaction
      .selectFrom("threads")
      .select("id")
      .where("id", "in", threadIds)
      .orderBy("id")
      .forNoKeyUpdate()
      .execute();
  await lockRunProjectionRows(transaction, { runIds: runs.map((row) => row.id), threadIds });
  if (threadIds.length)
    await transaction
      .selectFrom("threadStatePending")
      .select("threadId")
      .where("threadId", "in", threadIds)
      .orderBy("threadId")
      .forNoKeyUpdate()
      .execute();
}
