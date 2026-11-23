import { deleteTerminalRunReceipts } from "./personal-runner-receipts.js";
import { lockRunProjectionRows } from "./run-projection-locks.js";
import { refreshRequestState } from "./request-persistence.js";
import { ChannelConversationIdSchema } from "@opensteer/channel-core";
import { commitPersonalMutation, type PersonalMutation } from "./personal-mutation.js";
import {
  advancePersonalRunFinish,
  beginPersonalRunFinish,
  readFinishChildren,
} from "./personal-run-state.js";
import { interruptPersonalToolCalls } from "./personal-tool-calls.js";
import type { FinishIntent } from "./personal-state-schema.js";
import {
  publishExecutionInput,
  recordExecutionRunChange,
  updateExecutionThread,
  publishTranscriptRun,
} from "./execution-changes.js";
import { threadExecutionIsAvailableToUser } from "./store-primitives.js";
import { sql } from "kysely";
import { recordPersonWaited } from "./run-visibility.js";
import { publishThreadSummary } from "./thread-status.js";
import { pauseTriggerInTransaction } from "./trigger-store.js";
import { refreshInputQueue } from "./waiting-inputs.js";
import {
  OpensteerError,
  MessageContentSchema,
  harnessUsageLimitFailureCode,
  ReplyTargetSchema,
  type RequestCancellationReason,
  type RunId,
  type RunInterruptedCause,
  type RunAttemptId,
  type RunFailure,
} from "@opensteer/core";
import type { Kysely, Transaction } from "kysely";
import { ensureQueuedRun } from "./thread-inbox.js";
import { jsonValue, lockThreadRow, type ChannelLinks } from "./store-primitives.js";
import { enqueueChannelConversationStatus, enqueueChannelReply } from "./channel-deliveries.js";
import { runReply } from "./run-reply.js";
import type { CommandRow, DatabaseSchema, RunRow } from "./schema.js";
import { settleAssignmentAfterRun, threadOrAssignmentHasPendingWork } from "./assignment-store.js";
import { endLiveExecutionNodes } from "./execution-nodes.js";
import { endOpenAttempts } from "./run-attempts.js";
import { runWasStopped } from "./run-grants.js";
import { isOfflineSettlement } from "./personal-transaction.js";
import { completeRunReplacement } from "./run-recovery.js";
import { pendingReplacementAttempt } from "./run-attempts.js";
interface FinalizeRunRequest {
  readonly requestCancellationReason?: RequestCancellationReason;
  readonly completedAt: Date;
  readonly expectedCommandId?: CommandRow["id"];
  readonly failure?: RunFailure;
  readonly interruptedCause?: RunInterruptedCause;
  /** How a channel status message names the Thread it points at. */
  readonly links: ChannelLinks;
  /** The proof source determines both event authorship and execute receipt. */
  readonly source: "host" | "runner";
  readonly queuedInputCancellation: "activation-input" | "authority-cohort" | "seed-input";
  readonly runId: RunId;
  readonly status: "completed" | "failed" | "interrupted";
  readonly statement?: FinishIntent["statement"];
  readonly attemptId?: RunAttemptId;
}

/** The sole durable transition from a nonterminal Run to a terminal Run. */
export async function finalizeRunTransaction(
  transaction: Transaction<DatabaseSchema>,
  requested: FinalizeRunRequest,
): Promise<void> {
  if (requested.status === "failed" && !requested.failure) {
    throw new OpensteerError({
      code: "internal",
      message: "Failed Run has no failure record",
    });
  }
  const run = await transaction
    .selectFrom("runs")
    .innerJoin("threads", "threads.id", "runs.threadId")
    .select([
      "runs.finishIntent",
      "runs.assignmentId",
      "runs.doneWhenFinished",
      "runs.bindingGeneration",
      "runs.environmentId",
      "runs.activationInputId",
      "runs.harnessInstanceId",
      "runs.id",
      "runs.providerSessionId",
      "runs.replyTarget",
      "runs.requestedBy",
      "runs.status as runStatus",
      "runs.threadId",
      "runs.seedInputId",
      "runs.turnReplyMessageId",
    ])
    .where("runs.id", "=", requested.runId)
    .forNoKeyUpdate("runs")
    .executeTakeFirst();
  if (!run || !["queued", "starting", "running", "waiting"].includes(run.runStatus)) return;
  const offline = isOfflineSettlement(transaction);
  if (!offline && run.finishIntent) return;
  if (requested.source === "host" && requested.status === "completed")
    throw new OpensteerError({
      code: "internal",
      message: "A Host cannot prove a successful Run completion",
    });
  // A Run someone stopped ended because they stopped it, whatever the Host
  // found first: a lost Runner, an expired lease, a refused dispatch. What a
  // Runner reports is its own record and stands.
  const input: FinalizeRunRequest =
    requested.source === "host" &&
    requested.status === "failed" &&
    (await runWasStopped(transaction, run.id))
      ? stoppedOutcome(requested)
      : requested;
  await lockThreadRow(transaction, run.threadId);
  const thread = await transaction
    .selectFrom("threads")
    .selectAll()
    .where("id", "=", run.threadId)
    .executeTakeFirstOrThrow();
  const children = offline ? undefined : await readFinishChildren(transaction, run.id);
  if (children && !children.hasMore)
    await lockRunProjectionRows(transaction, {
      threadIds: [run.threadId],
      runIds: [run.id],
      ...(input.expectedCommandId ? { commandIds: [input.expectedCommandId] } : {}),
    });
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
      return;
    }
  }
  const reply = input.status === "completed" ? await runReply(transaction, run) : null;
  if (!children) return finalizeRunOutcome(transaction, input, run, thread, null, null);
  return commitPersonalMutation(transaction, async (tx, mutation) => {
    if (!children.hasMore) {
      await settleFinishChildren(tx, mutation, run.id, input, children);
      await finalizeRunOutcome(tx, input, run, thread, reply?.id ?? null, mutation);
      mutation.react({
        type: "runFinished",
        runId: run.id,
        threadId: run.threadId,
        attemptId: input.attemptId ?? (await finishAttemptId(tx, run.id, run.bindingGeneration)),
        bindingGeneration: run.bindingGeneration,
        outcome: input.status,
      });
      return;
    }
    await beginPersonalRunFinish(tx, mutation, {
      runId: run.id,
      intent: {
        attemptId: input.attemptId ?? (await finishAttemptId(tx, run.id, run.bindingGeneration)),
        bindingGeneration: run.bindingGeneration,
        outcome: input.status,
        mode: input.source,
        completedAt: input.completedAt.toISOString(),
        replyMessageId: reply?.id ?? null,
        ...(input.failure ? { failure: input.failure } : {}),
        ...(input.interruptedCause ? { interruptedCause: input.interruptedCause } : {}),
        ...(input.statement ? { statement: input.statement } : {}),
        ...(input.requestCancellationReason
          ? { requestCancellationReason: input.requestCancellationReason }
          : {}),
        queuedInputCancellation: input.queuedInputCancellation,
      },
    });
    await recordExecutionRunChange(tx, mutation, {
      runId: run.id,
      threadId: run.threadId,
      transition: "finishing",
    });
    return;
  });
}

async function finishAttemptId(
  tx: Transaction<DatabaseSchema>,
  runId: RunId,
  bindingGeneration: number | null,
) {
  if (bindingGeneration === null) return null;
  const attempt = await tx
    .selectFrom("runAttempts")
    .select("id")
    .where("runId", "=", runId)
    .where("bindingGeneration", "=", bindingGeneration)
    .limit(1)
    .executeTakeFirst();
  return attempt?.id ?? null;
}

export async function settleFinishChildren(
  tx: Transaction<DatabaseSchema>,
  mutation: PersonalMutation,
  runId: RunId,
  input: Pick<
    FinalizeRunRequest,
    "completedAt" | "source" | "requestCancellationReason" | "failure"
  >,
  children: Awaited<ReturnType<typeof readFinishChildren>>,
  recovering = false,
) {
  if (children.steers.length) {
    const run = await tx
      .selectFrom("runs")
      .select("threadId")
      .where("id", "=", runId)
      .executeTakeFirstOrThrow();
    const work = tx
      .selectFrom("threadWorkInputs")
      .select("causalChainId")
      .where("threadId", "=", run.threadId)
      .where("state", "=", "pending")
      .orderBy("queueRank")
      .limit(100);
    const steers = tx
      .selectFrom("threadInputs")
      .select("causalChainId")
      .where("messageId", "in", children.steers);
    await tx
      .selectFrom("causalChains")
      .select("id")
      .where((eb) => eb.or([eb("id", "in", work), eb("id", "in", steers)]))
      .orderBy("id")
      .forNoKeyUpdate()
      .execute();
  }
  for (const id of children.requests) {
    const request = await tx
      .updateTable("requests")
      .set({
        status: "cancelled",
        cancellationReason: input.requestCancellationReason ?? "run-ended",
        resolvedAt: input.completedAt,
        resolvedBy: null,
        responseCommandId: null,
      })
      .where("id", "=", id)
      .where("status", "=", "pending")
      .returning("responseCommandId")
      .executeTakeFirst();
    if (request) await refreshRequestState(tx, id);
  }
  if (children.commands.length)
    await tx
      .selectFrom("commands")
      .select("id")
      .where("id", "in", children.commands)
      .orderBy("id")
      .forNoKeyUpdate()
      .execute();
  if (children.steers.length) {
    await tx
      .selectFrom("threadInputs")
      .select("messageId")
      .where("messageId", "in", children.steers)
      .orderBy("messageId")
      .forNoKeyUpdate()
      .execute();
    await tx
      .selectFrom("messages")
      .select("id")
      .where("id", "in", children.steers)
      .orderBy("id")
      .forNoKeyUpdate()
      .execute();
  }
  const replacement = children.steers.length ? await pendingReplacementAttempt(tx, runId) : null;
  const stoppedConversation =
    children.steers.length > 0 && (await stoppedConversationReply(tx, runId));
  for (const id of children.steers) {
    const current = await tx
      .selectFrom("threadInputs")
      .innerJoin("commands", "commands.id", "threadInputs.steerCommandId")
      .select([
        "commands.status",
        "commands.type",
        "threadInputs.authoritySource",
        "threadInputs.policy",
        "threadInputs.state",
      ])
      .where("threadInputs.messageId", "=", id)
      .executeTakeFirst();
    if (!current) continue;
    const delivered = current.type === "run.steer" && current.status === "succeeded";
    const unclaimed =
      current.type === "run.restart"
        ? replacement?.dispatchedAt == null
        : current.status === "pending" || current.status === "failed";
    const unknown = current.state === "unknown" || (recovering && !unclaimed);
    const requeue = current.policy === "queue" && unclaimed && !delivered && !unknown;
    const stopped =
      requeue &&
      stoppedConversation &&
      (current.authoritySource.kind === "user-session" ||
        current.authoritySource.kind === "channel-ingress");
    if (requeue && !stopped)
      await tx.updateTable("messages").set({ runId: null }).where("id", "=", id).execute();
    const row = await tx
      .updateTable("threadInputs")
      .set({
        ...(delivered
          ? { state: "delivered", deliveredAt: input.completedAt }
          : stopped
            ? { state: "cancelled", cancelReason: "stopped" }
            : requeue
              ? { state: "pending", runId: null, steerCommandId: null }
              : current.policy === "queue" || unknown
                ? { state: "unknown" }
                : {
                    state: "cancelled",
                    cancelReason: unclaimed ? "steer-not-delivered" : "run-ended-delivery-unknown",
                  }),
        updatedAt: input.completedAt,
      })
      .where("messageId", "=", id)
      .returningAll()
      .executeTakeFirstOrThrow();
    await publishExecutionInput(tx, row);
  }
  if (children.commands.length) {
    await tx
      .updateTable("commands")
      .set((eb) => ({
        status:
          input.source === "runner"
            ? eb
                .case()
                .when("type", "=", "run.execute")
                .then("succeeded" as const)
                .else("failed" as const)
                .end()
            : "failed",
        lastError:
          input.failure && input.source === "host"
            ? jsonValue(input.failure)
            : sql`case when type = 'run.execute' and ${input.source} = 'runner' then null else
            '{"message":"The Run ended before control delivery was confirmed"}'::jsonb end`,
        updatedAt: input.completedAt,
      }))
      .where("id", "in", children.commands)
      .execute();
  }
  await endLiveExecutionNodes(tx, { runId, endedAt: input.completedAt, ids: children.nodes });
  // The terminal outcome or replacement may still end an existing attempt.
  await tx
    .selectFrom("runAttempts")
    .select("id")
    .where("runId", "=", runId)
    .where("endedAt", "is", null)
    .orderBy("id")
    .forNoKeyUpdate()
    .execute();
  if (children.grants.length) {
    await tx
      .selectFrom("grants")
      .select("id")
      .where("id", "in", children.grants)
      .orderBy("id")
      .forNoKeyUpdate()
      .execute();
    await tx
      .updateTable("grants")
      .set({ revokedAt: input.completedAt, revokedReason: "superseded", status: "revoked" })
      .where("id", "in", children.grants)
      .execute();
  }
  await interruptPersonalToolCalls(tx, mutation, runId, children.tools, input.completedAt);
}

async function stoppedConversationReply(tx: Transaction<DatabaseSchema>, runId: RunId) {
  const stopped = await tx
    .selectFrom("commands")
    .select("id")
    .where("runId", "=", runId)
    .where("type", "=", "run.interrupt")
    .where(sql<string>`authority_source->>'kind'`, "=", "user-session")
    .limit(1)
    .executeTakeFirst();
  if (!stopped) return false;
  const run = await tx
    .selectFrom("runs")
    .innerJoin("threads", "threads.id", "runs.threadId")
    .select(["threads.purpose", "runs.replyTarget"])
    .where("runs.id", "=", runId)
    .executeTakeFirstOrThrow();
  if (run.purpose === "voice") return true;
  if (run.replyTarget?.kind !== "channel") return false;
  const conversation = await tx
    .selectFrom("channelConversations")
    .select("personalContext")
    .where("id", "=", ChannelConversationIdSchema.parse(run.replyTarget.conversationId))
    .executeTakeFirst();
  return conversation?.personalContext === true;
}

export function createRunFinishDrain(
  database: Kysely<DatabaseSchema>,
  links: ChannelLinks,
  options: { readonly now: () => number; readonly onError: (error: unknown) => void },
) {
  let retries = new Map<RunId, number>();
  return async (): Promise<Date | null> => {
    const nextRetries = new Map<RunId, number>();
    let nextDue = Infinity;
    let after: RunId | undefined;
    const pageSize = 64;
    for (;;) {
      const page = await database
        .selectFrom("runs")
        .select("id")
        .where("finishIntent", "is not", null)
        .$if(after !== undefined, (query) => query.where("id", ">", after!))
        .orderBy("id")
        .limit(pageSize)
        .execute();
      for (const { id } of page) {
        let due = retries.get(id) ?? 0;
        if (due <= options.now()) {
          try {
            await drainRunFinish(database, links, id);
            retries.delete(id);
            continue;
          } catch (error) {
            due = options.now() + 5_000;
            retries.set(id, due);
            options.onError(error);
          }
        }
        nextRetries.set(id, due);
        nextDue = Math.min(nextDue, due);
      }
      if (page.length < pageSize) break;
      after = page.at(-1)!.id;
    }
    retries = nextRetries;
    return Number.isFinite(nextDue) ? new Date(nextDue) : null;
  };
}

export async function drainRunFinish(
  database: Kysely<DatabaseSchema>,
  links: ChannelLinks,
  runId: RunId,
) {
  let result: "more" | "settled";
  do {
    result = await commitPersonalMutation(database, async (tx, mutation) => {
      const run = await tx
        .selectFrom("runs")
        .selectAll()
        .where("id", "=", runId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!run?.finishIntent) return "settled";
      await lockThreadRow(tx, run.threadId);
      const thread = await tx
        .selectFrom("threads")
        .selectAll()
        .where("id", "=", run.threadId)
        .executeTakeFirstOrThrow();
      const request = (intent: FinishIntent): FinalizeRunRequest => ({
        status: intent.outcome,
        completedAt: new Date(intent.completedAt),
        runId,
        links,
        queuedInputCancellation: intent.queuedInputCancellation ?? "seed-input",
        source:
          (intent.mode ?? (intent.statement ? "runner" : "host")) === "runner" ? "runner" : "host",
        ...(intent.failure ? { failure: intent.failure } : {}),
        ...(intent.interruptedCause ? { interruptedCause: intent.interruptedCause } : {}),
        ...(intent.requestCancellationReason
          ? { requestCancellationReason: intent.requestCancellationReason }
          : {}),
      });
      return advancePersonalRunFinish(tx, mutation, runId, {
        settle: async (children, intent) => {
          if (!children.hasMore)
            await lockRunProjectionRows(tx, { threadIds: [run.threadId], runIds: [runId] });
          await settleFinishChildren(
            tx,
            mutation,
            runId,
            request(intent),
            children,
            intent.mode === "recovery",
          );
        },
        finalize: async (intent) => {
          if (intent.mode === "steer" || intent.mode === "recovery") {
            if (!intent.attemptId) throw new Error("A replacement must name the old attempt");
            await completeRunReplacement(
              tx,
              mutation,
              run,
              intent.attemptId,
              intent.mode,
              new Date(intent.completedAt),
            );
          } else {
            await finalizeRunOutcome(
              tx,
              request(intent),
              { ...run, runStatus: run.status },
              thread,
              intent.replyMessageId,
              mutation,
            );
          }
        },
      });
    });
  } while (result === "more");
}

async function finalizeRunOutcome(
  transaction: Transaction<DatabaseSchema>,
  input: FinalizeRunRequest,
  run: Pick<
    RunRow,
    | "assignmentId"
    | "doneWhenFinished"
    | "bindingGeneration"
    | "activationInputId"
    | "id"
    | "providerSessionId"
    | "replyTarget"
    | "requestedBy"
    | "threadId"
    | "seedInputId"
    | "turnReplyMessageId"
  > & { runStatus: RunRow["status"] },
  thread: import("./schema.js").ThreadRow,
  replyId: import("@opensteer/core").MessageId | null,
  mutation: PersonalMutation | null,
): Promise<void> {
  const offline = mutation === null;
  // A person who started this from a channel never sees the Thread, so how it
  // ended has to reach them where they wrote: the Run's reply when it
  // completed, which is all they are sent of what the agent wrote, and a
  // notice when it did not.
  const replyTarget = run.replyTarget ? ReplyTargetSchema.parse(run.replyTarget) : null;
  if (replyTarget?.kind === "channel" && input.status === "completed") {
    const reply = replyId
      ? await transaction
          .selectFrom("messages")
          .select(["id", "content"])
          .where("id", "=", replyId)
          .executeTakeFirst()
      : null;
    // A reply its channel already heard when a turn ended in the background.
    if (reply && reply.id !== run.turnReplyMessageId) {
      await enqueueChannelReply(transaction, {
        content: MessageContentSchema.parse(reply.content),
        conversationId: replyTarget.conversationId,
        links: input.links,
        messageId: reply.id,
        threadId: run.threadId,
      });
    }
  } else if (
    replyTarget?.kind === "channel" &&
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
          : input.interruptedCause === "engine-retired"
            ? `This Run was cut short: Opensteer had to restart its engine to make sure another task had stopped. What it was doing at that moment may not have finished; send a message to continue. Open the Thread in Opensteer: ${threadUrl}`
            : `The agent was stopped. Open the Thread in Opensteer: ${threadUrl}`,
    });
  }
  await recordPersonWaited(transaction, run.id);
  if (run.runStatus !== "queued")
    await transaction
      .updateTable("providerSessions")
      .set({
        status: input.status === "failed" ? "broken" : "ready",
        updatedAt: input.completedAt,
        ...(offline && run.bindingGeneration !== null
          ? {
              bindingGeneration: sql<number>`binding_generation + 1`,
              leaseExpiresAt: null,
              leaseTokenHash: null,
              runnerId: null,
              runnerBootId: null,
            }
          : {}),
      })
      .where("id", "=", run.providerSessionId)
      .execute();
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
            query.where("requestedBy", "=", run.requestedBy),
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
  const reportAuthorityCurrent = await threadExecutionIsAvailableToUser(
    transaction,
    run.threadId,
    run.requestedBy,
  );
  const unconfirmedReports = await transaction
    .updateTable("threadInputs")
    .set(
      reportAuthorityCurrent
        ? {
            state: "unknown",
            updatedAt: input.completedAt,
          }
        : {
            cancelReason: "execution-authority-unavailable",
            state: "cancelled",
            updatedAt: input.completedAt,
          },
    )
    .where("runId", "=", run.id)
    .where("policy", "=", "report")
    .where("state", "=", "claimed")
    .returningAll()
    .execute();
  for (const row of [...cancelled, ...unconfirmedReports])
    await publishExecutionInput(transaction, row);
  await transaction
    .updateTable("runs")
    .set({
      completedAt: input.completedAt,
      terminalReplyMessageId: replyId,
      runnerSafetyTerminal: input.source === "runner" && input.status !== "completed",
      ...(mutation ? { revision: mutation.sequence } : {}),
      failure: input.status === "failed" ? jsonValue(input.failure!) : null,
      interruptedCause: input.status === "interrupted" ? (input.interruptedCause ?? null) : null,
      startHoldReason: null,
      providerRetry: null,
      status: input.status,
    })
    .where("id", "=", run.id)
    .executeTakeFirstOrThrow();
  if (mutation) deleteTerminalRunReceipts(transaction, mutation, run.id);
  if (run.assignmentId) {
    await settleAssignmentAfterRun(transaction, {
      assignmentId: run.assignmentId,
      failureSummary: input.status === "failed" ? failureSummary(input.failure) || null : null,
      finishedAt: input.completedAt,
      run: {
        id: run.id,
        threadId: run.threadId,
      },
      status: input.status,
    });
  }
  if (run.doneWhenFinished) {
    await transaction
      .updateTable("runs")
      .set({
        doneWhenFinished: false,
      })
      .where("id", "=", run.id)
      .execute();
    if (
      thread.doneAt === null &&
      !(await threadOrAssignmentHasPendingWork(transaction, {
        threadId: run.threadId,
      }))
    ) {
      const triggers = await transaction
        .selectFrom("triggers")
        .selectAll()
        .where("anchorThreadId", "=", run.threadId)
        .where("status", "=", "active")
        .execute();
      for (const trigger of triggers) await pauseTriggerInTransaction(transaction, trigger);
      const doneAt = input.completedAt;
      const updated = await transaction
        .updateTable("threads")
        .set({
          doneAt,
          doneReason: null,
          doneBy: "agent",
          inputQueuePaused: false,
          inputQueuePausedBy: null,
        })
        .where("id", "=", run.threadId)
        .where("doneAt", "is", null)
        .executeTakeFirst();
      if (updated.numUpdatedRows > 0n) {
        thread.doneAt = doneAt;
        thread.doneReason = null;
        thread.doneBy = "agent";
        thread.inputQueuePaused = false;
        if (!offline) await publishThreadSummary(transaction, run.threadId);
      }
    }
  }

  // A corrupt selection must not roll back an already accepted terminal event.
  // Pending work remains queued until an explicit engine selection repairs it.
  if (!offline) {
    // When a shared engine had to retire under an innocent neighbour, pause
    // queued follow-ups rather than silently continuing over work whose state
    // may be partial.
    if (
      input.status === "interrupted" &&
      input.interruptedCause === "engine-retired" &&
      thread.purpose !== "voice" &&
      !thread.doneAt &&
      !thread.inputQueuePaused
    ) {
      await transaction
        .updateTable("threads")
        .set({
          inputQueuePaused: true,
          inputQueuePausedBy: null,
          updatedAt: input.completedAt,
        })
        .where("id", "=", run.threadId)
        .execute();
      thread.inputQueuePaused = true;
      await refreshInputQueue(transaction, run.threadId);
    }
    await ensureQueuedRun(transaction, thread, {
      onInvalidSelection: "defer",
    });
    await updateExecutionThread(transaction, run.threadId, input.completedAt);
    if (input.status === "failed" && input.failure?.code === harnessUsageLimitFailureCode)
      await recordExecutionRunChange(transaction, mutation, {
        runId: run.id,
        threadId: run.threadId,
        transition: "usage-limit",
      });
    await publishTranscriptRun(transaction, mutation, run.id);
  }
  // Nodes and attempts rank last; the Run's lock already orders these writes.
  await endOpenAttempts(transaction, run.id, input.status);
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
  return {
    ...stopped,
    status: "interrupted",
  };
}

export async function endStoppedUnconfirmedRun(
  transaction: Transaction<DatabaseSchema>,
  input: {
    readonly links: ChannelLinks;
    readonly runId: RunId;
  },
): Promise<void> {
  await finalizeRunTransaction(transaction, {
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
    .set({
      bindingGeneration: null,
    })
    .where("id", "=", input.runId)
    .execute();
}
