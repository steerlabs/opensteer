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

/** The sole durable transition from a nonterminal Run to a terminal Run. */
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
  } else if (replyTarget) {
    const threadUrl = input.links.threadUrl(run.threadId);
    await enqueueChannelConversationStatus(transaction, {
      conversationId: replyTarget.conversationId,
      text:
        input.status === "failed"
          ? `Something went wrong and the agent could not finish. ${failureSummary(input.failure)} Open the Thread in Opensteer: ${threadUrl}`
          : `The agent was stopped. Open the Thread in Opensteer: ${threadUrl}`,
    });
  }

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
        .set({ doneAt, inputQueuePaused: false, inputQueuePausedBy: null })
        .where("id", "=", run.threadId)
        .execute();
      thread.doneAt = doneAt;
      thread.inputQueuePaused = false;
      events.push(await appendDoneState(transaction, run.threadId));
    }
  }

  // A corrupt selection must not roll back an already accepted terminal event.
  // Pending work remains queued until an explicit engine selection repairs it.
  const followOn = await ensureQueuedRun(transaction, thread, { onInvalidSelection: "defer" });
  events.push(...followOn.events);
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
    ...(await cancelPending(transaction, {
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
