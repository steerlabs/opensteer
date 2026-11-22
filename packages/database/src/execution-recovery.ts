import { deleteTerminalRunReceipts } from "./personal-runner-receipts.js";
import { drainAssignmentCancellation } from "./assignment-store.js";
import { commitPersonalMutation, wakeExecutionCommands } from "./personal-mutation.js";
import { executionDate } from "./personal-transaction.js";
import { assertActiveGrant } from "./execution-authority.js";
import { recordPersonWaited } from "./run-visibility.js";
import { refreshInputQueue } from "./waiting-inputs.js";
import { recoverLostRunTransaction } from "./run-recovery.js";
import { lockRunProjectionRows, lockThreadProviderSession } from "./run-projection-locks.js";
import "./connection.js";
import * as commandStore from "./command-store.js";
import { resendableControlCommandTypes } from "./command-delivery.js";
import {
  type EnvironmentId,
  type RunId,
  type ThreadId,
  type Sequence,
  type RunFailure,
  type RunnerId,
  createId,
  OpensteerError,
} from "@opensteer/core";
import { type Kysely, type Transaction, sql } from "kysely";
import {
  type CommandRow,
  type DatabaseSchema,
  type RunRow,
  type ProviderSessionTable,
} from "./schema.js";
import {
  type ChannelLinks,
  lockThreadRow,
  jsonValue,
  principalIdForUser,
  returnRunToQueue,
  threadExecutionIsAvailableToUser,
} from "./store-primitives.js";
import { endStoppedUnconfirmedRun, finalizeRunTransaction } from "./run-finalization.js";
import { revokeRunGrants, runWasStopped, type RevokedRunGrant } from "./run-grants.js";
import { cancelPending } from "./request-store.js";
import { publishExecutionInput, updateExecutionThread } from "./execution-changes.js";
import { ensureQueuedRun } from "./thread-inbox.js";
export interface RecoveredRunTarget {
  readonly environmentId: EnvironmentId;
  readonly runId: RunId;
  readonly threadId: ThreadId;
}

/** A Run a Runner says it holds when it opens a connection. */
export interface AnnouncedExecution {
  readonly bindingGeneration: number;
  readonly environmentId: EnvironmentId;
  readonly nextOrdinal: number;
  readonly runId: RunId;
  readonly threadId: ThreadId;
}
export interface ResumedExecution {
  readonly afterSequence: Sequence;
  readonly runId: RunId;
  readonly threadId: ThreadId;
}

/** Whether an announced Run continues on its Runner's new connection. */
export type ExecutionAttachment =
  | {
      readonly nextOrdinal: number;
      readonly runId: RunId;
      readonly status: "attached";
    }
  | {
      readonly reason: string;
      readonly runId: RunId;
      readonly status: "revoked";
    };
export interface RunRecoveryOutcome {
  readonly revokedGrants?: readonly RevokedRunGrant[];

  /** Exactly the Runs terminalized by this recovery call, never inferred from projection events. */
  readonly terminatedRuns: readonly RecoveredRunTarget[];
}

/** Run states in which a Runner holds the Run under an execution binding. */
const executingRunStatuses = ["starting", "running", "waiting"] as const;

/** Provider-session states of a binding a Runner may still be executing under. */
const boundSessionStatuses = ["starting", "ready", "running"] as const;
type AbandonedRunRecovery = {
  readonly activeRunIds: readonly RunId[];
  readonly code: "runner_disconnected";
  readonly kind: "runner-disconnect";
  readonly message: string;
  readonly runnerBootId: string;
  readonly runnerId: RunnerId;
};
async function recoverAbandonedRuns(
  database: Kysely<DatabaseSchema>,
  links: ChannelLinks,
  recovery: AbandonedRunRecovery,
): Promise<RunRecoveryOutcome> {
  const activeStatuses = ["starting", "running", "waiting"] as const;
  const sessionStatuses = ["starting", "ready", "running"] as const;
  // Command status is a delivery receipt, not execution liveness. A Runner can
  // accept the execute command (making it succeeded) and then disappear while
  // the Run remains active; recovery is therefore fenced by the Run and its
  // exact provider-session binding instead of a stale command-state proxy.
  const candidates = await database
    .selectFrom("runs")
    .innerJoin("providerSessions", "providerSessions.id", "runs.providerSessionId")
    .select("runs.id")
    .distinct()
    .where("runs.status", "in", activeStatuses)
    .where("runs.id", "in", [...recovery.activeRunIds])
    .where("providerSessions.active", "=", true)
    .where("providerSessions.runnerId", "=", recovery.runnerId)
    .where("providerSessions.runnerBootId", "=", recovery.runnerBootId)
    .where("providerSessions.status", "in", sessionStatuses)
    .orderBy("runs.id")
    .execute();
  const terminatedRuns: RecoveredRunTarget[] = [];
  for (const candidate of candidates) {
    const recovered = await commitPersonalMutation(database, async (transaction) => {
      // Runner events and recovery both lock the Run first. Whichever terminal
      // outcome wins that lock is the only one projected or published. Recover

      const run = await transaction
        .selectFrom("runs")
        .innerJoin("threads", "threads.id", "runs.threadId")
        .select([
          "runs.environmentId",
          "runs.id",
          "runs.providerSessionId",
          "runs.status",
          "runs.threadId",
          "runs.voiceSessionId",
        ])
        .where("runs.id", "=", candidate.id)
        .forNoKeyUpdate("runs")
        .executeTakeFirst();
      if (!run || !new Set<string>(activeStatuses).has(run.status)) {
        return null;
      }
      await lockThreadRow(transaction, run.threadId);
      const session = await lockThreadProviderSession(
        transaction,
        run.threadId,
        run.providerSessionId,
      );
      if (
        recovery.kind === "runner-disconnect" &&
        (!session ||
          session.runnerId !== recovery.runnerId ||
          session.runnerBootId !== recovery.runnerBootId ||
          !sessionStatuses.includes(session.status as (typeof sessionStatuses)[number]))
      ) {
        return null;
      }
      const failure = {
        code: recovery.code,
        message: recovery.message,
        retryable: false,
        status: "failed" as const,
      };
      await finalizeRunTransaction(transaction, {
        requestCancellationReason: "process-lost",
        completedAt: new Date(),
        failure,
        links,
        source: "host",
        queuedInputCancellation: "seed-input",
        runId: run.id,
        status: "failed",
      });
      return {
        target: {
          environmentId: run.environmentId,
          runId: run.id,
          threadId: run.threadId,
        },
      };
    });
    if (recovered) {
      terminatedRuns.push(recovered.target);
    }
  }
  return {
    terminatedRuns,
  };
}
export async function failActiveRunsForRunnerDisconnect(
  database: Kysely<DatabaseSchema>,
  links: ChannelLinks,
  input: {
    readonly activeRunIds: readonly RunId[];
    readonly runnerBootId: string;
    readonly runnerId: RunnerId;
  },
): Promise<RunRecoveryOutcome> {
  if (input.activeRunIds.length === 0)
    return {
      terminatedRuns: [],
    };
  return recoverAbandonedRuns(database, links, {
    activeRunIds: input.activeRunIds,
    code: "runner_disconnected",
    kind: "runner-disconnect",
    message: `Runner ${input.runnerId} disconnected before the Run reached a terminal event`,
    runnerBootId: input.runnerBootId,
    runnerId: input.runnerId,
  });
}

/**
 * Ends a Run whose own engine reported an event the Host refused. Only the
 * Runner, boot and binding generation that currently hold the Run can cost
 * it its outcome: a refused event from anyone else changes nothing here, so a
 * stale or foreign frame can never fail somebody else's Run.
 */
export async function failRunForRefusedRunnerEvent(
  database: Kysely<DatabaseSchema>,
  links: ChannelLinks,
  input: {
    readonly bindingGeneration: number;
    readonly message: string;
    readonly runId: RunId;
    readonly runnerBootId: string;
    readonly runnerId: RunnerId;
  },
): Promise<void> {
  return commitPersonalMutation(database, async (transaction) => {
    const run = await transaction
      .selectFrom("runs")
      .innerJoin("threads", "threads.id", "runs.threadId")
      .select(["runs.providerSessionId", "runs.status", "runs.threadId"])
      .where("runs.id", "=", input.runId)
      .forNoKeyUpdate("runs")
      .executeTakeFirst();
    if (!run || !["starting", "running", "waiting"].includes(run.status)) return;
    await lockThreadRow(transaction, run.threadId);
    const session = await lockThreadProviderSession(
      transaction,
      run.threadId,
      run.providerSessionId,
    );
    if (
      !session?.active ||
      session.runnerId !== input.runnerId ||
      session.runnerBootId !== input.runnerBootId ||
      session.bindingGeneration !== input.bindingGeneration ||
      !["starting", "ready", "running"].includes(session.status)
    ) {
      return;
    }
    // A lease that ran out is the lease sweep's to classify. A report still being
    // committed when it ran out is refused for that alone and must not fail the Run first.
    if (session.leaseExpiresAt && session.leaseExpiresAt <= executionDate(database)) return;
    return finalizeRunTransaction(transaction, {
      completedAt: new Date(),
      failure: {
        code: "runner_event_refused",
        message: `The Host refused an event this Run's engine reported: ${input.message}`.slice(
          0,
          20_000,
        ),
        retryable: false,
        status: "failed",
      },
      links,
      queuedInputCancellation: "seed-input",
      runId: input.runId,
      source: "host",
      status: "failed",
    });
  });
}
export async function recoverThreadWorkQueues(database: Kysely<DatabaseSchema>): Promise<void> {
  await cancelLegacyChatInputs(database);
  const obsolete = await database
    .selectFrom("runs")
    .innerJoin("threadInputs", "threadInputs.messageId", "runs.seedInputId")
    .select("runs.id")
    .where("runs.status", "=", "queued")
    .where("threadInputs.policy", "=", "report")
    .orderBy("runs.id", "asc")
    .execute();
  for (const candidate of obsolete) {
    await commitPersonalMutation(database, async (transaction, mutation) => {
      const run = await transaction
        .selectFrom("runs")
        .selectAll()
        .where("id", "=", candidate.id)
        .forNoKeyUpdate()
        .executeTakeFirstOrThrow();
      if (run.status !== "queued") return;
      await lockThreadRow(transaction, run.threadId);
      await lockRunProjectionRows(transaction, {
        runIds: [run.id],
        threadIds: [run.threadId],
      });
      const now = new Date();
      await recordPersonWaited(transaction, run.id);
      await transaction
        .updateTable("runs")
        .set({
          status: "interrupted",
          completedAt: now,
        })
        .where("id", "=", run.id)
        .execute();
      deleteTerminalRunReceipts(transaction, mutation, run.id);
      await transaction
        .updateTable("commands")
        .set({
          status: "failed",
          updatedAt: now,
          lastError: jsonValue({
            message: "Replaced a legacy report-driven Run with the actual queued task",
          }),
        })
        .where("runId", "=", run.id)
        .where("type", "=", "run.execute")
        .where("status", "in", ["pending", "dispatched", "unknown"])
        .execute();
      const seedMessage = await transaction
        .selectFrom("messages")
        .select("kind")
        .where("id", "=", run.seedInputId)
        .executeTakeFirstOrThrow();
      if (seedMessage.kind !== "run-result" && seedMessage.kind !== "continuation") {
        await transaction
          .updateTable("causalChains")
          .set({
            usedAutonomousRuns: sql`greatest(used_autonomous_runs - 1, 0)`,
          })
          .where("id", "=", run.causalChainId)
          .execute();
      }
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
                updatedAt: now,
              }
            : {
                cancelReason: "owner-unavailable",
                state: "cancelled",
                updatedAt: now,
              },
        )
        .where("runId", "=", run.id)
        .where("policy", "=", "report")
        .where("state", "=", "claimed")
        .returningAll()
        .execute();
      for (const report of unconfirmedReports) await publishExecutionInput(transaction, report);
      const thread = await transaction
        .selectFrom("threads")
        .selectAll()
        .where("id", "=", run.threadId)
        .executeTakeFirstOrThrow();
      await ensureQueuedRun(transaction, thread);
      await updateExecutionThread(transaction, thread.id, now);
    });
  }
  // Pending work is itself the durable wake obligation. Reports are absent
  // from this view, including when a Host restarts with a large backlog.
  const pending = await database
    .selectFrom("threadWorkInputs")
    .select("threadId")
    .distinct()
    .where("state", "=", "pending")
    .execute();
  for (const { threadId } of pending) {
    await commitPersonalMutation(database, async (transaction) => {
      await lockThreadRow(transaction, threadId);
      const thread = await transaction
        .selectFrom("threads")
        .selectAll()
        .where("id", "=", threadId)
        .executeTakeFirstOrThrow();
      await ensureQueuedRun(transaction, thread);
    });
  }
}

/**
 * Returns the control commands a stopped Host left in flight to the state a
 * new Host can act on. Runs outlive a Host restart on their leases, so a
 * command in `resendableControlCommandTypes` is sent again and a steer becomes
 * `unknown`.
 */
export async function recoverCommandsAfterHostRestart(
  database: Kysely<DatabaseSchema>,
  links: ChannelLinks,
): Promise<void> {
  await drainAssignmentCancellation(database, links);

  await commitPersonalMutation(database, async (tx) => {
    await tx
      .updateTable("commands")
      .set({
        dispatcherId: null,
        status: "pending",
        updatedAt: new Date(),
      })
      .where("status", "=", "dispatched")
      .where("type", "in", resendableControlCommandTypes)
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom("runs")
              .select("id")
              .whereRef("runs.id", "=", "commands.runId")
              .where("finishIntent", "is not", null),
          ),
        ),
      )
      .execute();
  });
  const steers = await database
    .selectFrom("commands")
    .select("id")
    .where("status", "=", "dispatched")
    .where("type", "=", "run.steer")
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom("runs")
            .select("id")
            .whereRef("runs.id", "=", "commands.runId")
            .where("finishIntent", "is not", null),
        ),
      ),
    )
    .orderBy("id", "asc")
    .execute();
  for (const steer of steers) {
    await commandStore.markSteerUnknown(
      database,
      steer.id,
      "The Host restarted before the Runner confirmed the steer",
    );
  }
  // A Run the stopped Host claimed but never bound has no lease and no
  // Runner that could announce it, so it goes back to its Thread's queue. A
  // bound one may be running, and its Runner's attach settles it.
  const claimed = await database
    .selectFrom("commands")
    .select("id")
    .where("status", "=", "dispatched")
    .where("type", "=", "run.execute")
    .orderBy("id", "asc")
    .execute();
  for (const { id } of claimed) {
    await commitPersonalMutation(database, async (transaction) => {
      const command = await transaction
        .selectFrom("commands")
        .select("runId")
        .where("id", "=", id)
        .executeTakeFirst();
      if (!command?.runId) return null;
      const run = await transaction
        .selectFrom("runs")
        .innerJoin("threads", "threads.id", "runs.threadId")
        .select([
          "runs.bindingGeneration",
          "runs.environmentId",
          "runs.id",
          "runs.providerSessionId",
          "runs.status",
          "runs.finishIntent",
          "runs.threadId",
          "runs.voiceSessionId",
        ])
        .where("runs.id", "=", command.runId)
        .forNoKeyUpdate("runs")
        .executeTakeFirst();
      if (run?.status !== "starting" || run.finishIntent) return null;
      await lockThreadRow(transaction, run.threadId);
      const session = await lockThreadProviderSession(
        transaction,
        run.threadId,
        run.providerSessionId,
      );
      if (
        session &&
        session.runnerId !== null &&
        run.bindingGeneration !== null &&
        run.bindingGeneration === session.bindingGeneration
      )
        return null;
      if (run.voiceSessionId)
        return finalizeRunTransaction(transaction, {
          runId: run.id,
          completedAt: new Date(),
          links,
          source: "host",
          status: "interrupted",
          queuedInputCancellation: "seed-input",
        });
      if (await runWasStopped(transaction, run.id)) {
        return endStoppedUnconfirmedRun(transaction, {
          links,
          runId: run.id,
        });
      }
      await lockRunProjectionRows(transaction, {
        runIds: [run.id],
        threadIds: [run.threadId],
      });
      const returned = await transaction
        .updateTable("commands")
        .set({
          dispatcherId: null,
          lastError: jsonValue({
            message: "The Host restarted before dispatching this Run",
          }),
          status: "pending",
          updatedAt: new Date(),
        })
        .where("id", "=", id)
        .where("status", "=", "dispatched")
        .executeTakeFirst();
      if (returned.numUpdatedRows !== 1n) return null;
      return returnRunToQueue(transaction, {
        run,
      });
    });
  }
}

/**
 * Settles every Run bound to a Runner when it opens a connection.
 *
 * Each Run it announces continues when its binding, lease and authority all
 * still hold, from the first event the Host has not committed; otherwise the
 * Runner is told to stop it, and a Run that was still active fails here.
 * Every other active Run bound to this Runner is one it no longer holds: a
 * Run its current boot left out of the complete announcement, or one an
 * earlier boot was running. Only the same boot's omission under a live lease,
 * without an execute acknowledgement or native binding, permits redispatch;
 * a settled Run's journal may have been discarded after lease expiry.
 */
export async function attachRunnerExecutions(
  database: Kysely<DatabaseSchema>,
  links: ChannelLinks,
  input: {
    /** Runs this Host is dispatching now; their dispatch settles them. */
    readonly dispatchingRunIds: readonly RunId[];
    readonly executions: readonly AnnouncedExecution[];
    readonly stoppedComputerName?: string;
    readonly leaseExpiresAt: Date;
    readonly runnerBootId: string;
    readonly runnerId: RunnerId;
  },
  onRevoked: (grants: readonly RevokedRunGrant[]) => void,
  executionNow: () => number = Date.now,
): Promise<{
  readonly revokedGrants: readonly RevokedRunGrant[];

  readonly resumed: readonly ResumedExecution[];
  readonly results: readonly ExecutionAttachment[];
}> {
  const now = new Date(executionNow());
  const revokedGrants: RevokedRunGrant[] = [];
  const resumed: ResumedExecution[] = [];
  const results: ExecutionAttachment[] = [];
  for (const execution of input.executions) {
    const settled = await commitPersonalMutation(database, async (transaction) => {
      const revoked = (reason: string) => ({
        revokedGrants: [] as readonly RevokedRunGrant[],
        result: {
          reason,
          runId: execution.runId,
          status: "revoked" as const,
        },
      });
      const run = await transaction
        .selectFrom("runs")
        .innerJoin("threads", "threads.id", "runs.threadId")
        .select([
          "runs.environmentId",
          "runs.nextRunnerOrdinal",
          "runs.providerSessionId",
          "runs.requestedBy",
          "runs.status",
          "runs.threadId",
          "runs.voiceSessionId",
        ])
        .where("runs.id", "=", execution.runId)
        .forNoKeyUpdate("runs")
        .executeTakeFirst();
      if (
        !run ||
        run.threadId !== execution.threadId ||
        run.environmentId !== execution.environmentId
      ) {
        return revoked("The Host has no such Run");
      }
      if (!executingRunStatuses.includes(run.status as (typeof executingRunStatuses)[number])) {
        return revoked("The Run has ended");
      }
      await lockThreadRow(transaction, run.threadId);
      const session = await transaction
        .selectFrom("providerSessions")
        .select([
          "active",
          "bindingGeneration",
          "leaseExpiresAt",
          "runnerBootId",
          "runnerId",
          "status",
        ])
        .where("id", "=", run.providerSessionId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (
        !session?.active ||
        session.runnerId !== input.runnerId ||
        session.runnerBootId !== input.runnerBootId ||
        session.bindingGeneration !== execution.bindingGeneration ||
        !boundSessionStatuses.includes(session.status as (typeof boundSessionStatuses)[number])
      ) {
        return revoked("Another execution binding holds this Run");
      }
      const fail = (code: string, message: string) =>
        finalizeRunTransaction(transaction, {
          requestCancellationReason: "process-lost",
          completedAt: now,
          failure: {
            code,
            message,
            retryable: false,
            status: "failed",
          },
          links,
          source: "host",
          queuedInputCancellation: "seed-input",
          runId: execution.runId,
          status: "failed",
        });
      if (!session.leaseExpiresAt || session.leaseExpiresAt < now) {
        const recovered = await recoverLostRunTransaction(transaction, {
          failure: {
            code: "execution_binding_expired",
            message: "The Runner stopped renewing this Run's execution binding",
            retryable: false,
            status: "failed",
          },
          links,
          now,
          runId: execution.runId,
        });
        return {
          ...revoked("The Run's execution lease expired"),
          revokedGrants: recovered.revokedGrants,
        };
      }
      if (!(await threadExecutionIsAvailableToUser(transaction, run.threadId, run.requestedBy))) {
        await fail(
          "owner_unavailable",
          "Personal execution authority ended before the Run reached a terminal event",
        );
        return revoked("The Run's execution authority ended");
      }
      // The Runner numbers events densely from zero, so it can never have
      // fewer than the Host committed; one that does is not this Run's.
      if (execution.nextOrdinal < run.nextRunnerOrdinal) {
        await fail("runner_state_lost", "The Runner lost events this Run had reported");
        return revoked("The Runner holds fewer events than the Host committed");
      }
      await transaction
        .updateTable("providerSessions")
        .set({
          leaseExpiresAt: sql<Date>`greatest(lease_expires_at, ${input.leaseExpiresAt})`,
          updatedAt: now,
        })
        .where("id", "=", run.providerSessionId)
        .executeTakeFirstOrThrow();
      const state = await transaction
        .selectFrom("clientSyncState")
        .select("sequence")
        .executeTakeFirstOrThrow();
      return {
        resumed: {
          afterSequence: state.sequence as Sequence,
          runId: execution.runId,
          threadId: run.threadId,
        },

        revokedGrants: [],
        result: {
          nextOrdinal: run.nextRunnerOrdinal,
          runId: execution.runId,
          status: "attached" as const,
        },
      };
    });
    onRevoked(settled.revokedGrants);
    if ("resumed" in settled) resumed.push(settled.resumed);
    revokedGrants.push(...settled.revokedGrants);
    results.push(settled.result);
  }
  const held = results.flatMap((result) => (result.status === "attached" ? [result.runId] : []));
  const lost = await recoverLostExecutions(
    database,
    links,
    input.runnerId,
    input.runnerBootId,
    [...held, ...input.dispatchingRunIds],
    onRevoked,
    executionNow,
    input.stoppedComputerName,
  );
  revokedGrants.push(...lost.revokedGrants);
  return {
    resumed,
    results,
    revokedGrants,
  };
}
async function recoverLostExecutions(
  database: Kysely<DatabaseSchema>,
  links: ChannelLinks,
  runnerId: RunnerId,
  runnerBootId: string,
  excludedRunIds: readonly RunId[],
  onRevoked: (grants: readonly RevokedRunGrant[]) => void,
  executionNow: () => number = Date.now,
  stoppedComputerName?: string,
): Promise<{
  readonly revokedGrants: readonly RevokedRunGrant[];
}> {
  const candidates = await database
    .selectFrom("runs")
    .innerJoin("providerSessions", "providerSessions.id", "runs.providerSessionId")
    .select("runs.id")
    .where("runs.status", "in", executingRunStatuses)
    .where("providerSessions.active", "=", true)
    .where("providerSessions.runnerId", "=", runnerId)
    .whereRef("runs.bindingGeneration", "=", "providerSessions.bindingGeneration")
    .where("providerSessions.status", "in", boundSessionStatuses)
    .$if(excludedRunIds.length > 0, (query) => query.where("runs.id", "not in", excludedRunIds))
    .orderBy("runs.id", "asc")
    .execute();
  const revokedGrants: RevokedRunGrant[] = [];
  for (const candidate of candidates) {
    const recovered = await commitPersonalMutation(database, async (transaction) => {
      const run = await transaction
        .selectFrom("runs")
        .innerJoin("threads", "threads.id", "runs.threadId")
        .select([
          "runs.bindingGeneration",
          "runs.environmentId",
          "runs.id",
          "runs.providerSessionId",
          "runs.status",
          "runs.threadId",
          "runs.voiceSessionId",
        ])
        .where("runs.id", "=", candidate.id)
        .forNoKeyUpdate("runs")
        .executeTakeFirst();
      if (
        !run ||
        !executingRunStatuses.includes(run.status as (typeof executingRunStatuses)[number])
      ) {
        return {
          revokedGrants: [],
        };
      }
      await lockThreadRow(transaction, run.threadId);
      const session = await lockThreadProviderSession(
        transaction,
        run.threadId,
        run.providerSessionId,
      );
      if (
        !session?.active ||
        session.runnerId !== runnerId ||
        run.bindingGeneration === null ||
        run.bindingGeneration !== session.bindingGeneration ||
        !boundSessionStatuses.includes(session.status as (typeof boundSessionStatuses)[number])
      ) {
        return {
          revokedGrants: [],
        };
      }
      const now = new Date(executionNow());
      if (stoppedComputerName && session.runnerBootId !== runnerBootId) {
        await finalizeRunTransaction(transaction, {
          completedAt: now,
          failure: {
            code: "computer_stopped",
            message: `Stopped on ${stoppedComputerName}.`,
            retryable: false,
            status: "failed",
          },
          links,
          queuedInputCancellation: "seed-input",
          runId: run.id,
          source: "host",
          status: "failed",
        });
        return { revokedGrants: [] };
      }
      const recovery = lostExecutionRecovery({
        expired: !session.leaseExpiresAt || session.leaseExpiresAt <= now,
        restarted: session.runnerBootId !== runnerBootId,
        runStatus: run.status,
        sessionStatus: session.status,
      });
      if (recovery.mayRequeue && !run.voiceSessionId) {
        // The boot the Run was sent to is still running and does not hold
        // it, and never confirmed it or bound a native session for it: it
        // refused the Run or never received it. After expiry it may have
        // discarded a settled Run's journal, and a replaced boot may have
        // started work before it stopped. Neither omission proves safety.
        // The Run lock orders this read after any confirmation.
        const unconfirmed = await transaction
          .selectFrom("commands")
          .select("id")
          .where("runId", "=", run.id)
          .where("type", "=", "run.execute")
          .where("status", "=", "dispatched")
          .executeTakeFirst();
        if (unconfirmed && (await runWasStopped(transaction, run.id))) {
          await endStoppedUnconfirmedRun(transaction, {
            links,
            runId: run.id,
          });
          return { revokedGrants: [] };
        }
        if (unconfirmed) {
          await lockRunProjectionRows(transaction, {
            runIds: [run.id],
            threadIds: [run.threadId],
          });
          await transaction
            .selectFrom("commands")
            .select("id")
            .where("id", "=", unconfirmed.id)
            .forNoKeyUpdate()
            .executeTakeFirstOrThrow();
          await transaction
            .updateTable("commands")
            .set({
              dispatcherId: null,
              lastError: jsonValue({
                message: "The Runner did not receive this Run",
              }),
              status: "pending",
              updatedAt: new Date(),
            })
            .where("id", "=", unconfirmed.id)
            .executeTakeFirstOrThrow();
          await returnRunToQueue(transaction, {
            run,
          });
          return { revokedGrants: [] };
        }
      }
      return recoverLostRunTransaction(transaction, {
        failure: recovery.failure,
        links,
        now,
        runId: run.id,
      });
    });
    onRevoked(recovered.revokedGrants);
    revokedGrants.push(...recovered.revokedGrants);
  }
  return {
    revokedGrants,
  };
}

/**
 * A lease measures how long a Runner has been silent while the Host was
 * listening. A Host that was down heard nothing, so at boot each live binding
 * gets one fresh lease to reattach in; the sweep recovers a resumable Run
 * when that lease runs out. Runs the Runner stopped on its
 * own deadline meanwhile report that when it reattaches.
 */
export async function restartExecutionLeases(
  database: Kysely<DatabaseSchema>,
  leaseExpiresAt: Date,
): Promise<void> {
  await database
    .updateTable("providerSessions")
    .set({
      leaseExpiresAt,
      updatedAt: new Date(),
    })
    .where("active", "=", true)
    .where("runnerId", "is not", null)
    .where("leaseExpiresAt", "<", leaseExpiresAt)
    .where((expression) =>
      expression.exists(
        expression
          .selectFrom("runs")
          .select("runs.id")
          .whereRef("runs.providerSessionId", "=", "providerSessions.id")
          .whereRef("runs.bindingGeneration", "=", "providerSessions.bindingGeneration")
          .where("runs.status", "in", ["starting", "running", "waiting"]),
      ),
    )
    .execute();
}

function unstoppedBackgroundRuns(database: Kysely<DatabaseSchema>) {
  return database
    .selectFrom("runs")
    .where("phase", "=", "background")
    .where("finishIntent", "is", null)
    .where("status", "in", ["queued", "starting", "running", "waiting"])
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom("commands")
            .select("commands.id")
            .whereRef("commands.runId", "=", "runs.id")
            .where("commands.type", "=", "run.interrupt"),
        ),
      ),
    );
}

function leasedRuns(database: Kysely<DatabaseSchema>) {
  return database
    .selectFrom("runs")
    .innerJoin("providerSessions", "providerSessions.id", "runs.providerSessionId")
    .where("runs.status", "in", ["starting", "running", "waiting"])
    .where("runs.finishIntent", "is", null)
    .where("providerSessions.active", "=", true)
    .whereRef("runs.bindingGeneration", "=", "providerSessions.bindingGeneration");
}

export async function nextExecutionDeadline(
  database: Kysely<DatabaseSchema>,
): Promise<Date | null> {
  const row = await leasedRuns(database)
    .select("providerSessions.leaseExpiresAt as deadline")
    .where("providerSessions.leaseExpiresAt", "is not", null)
    .unionAll(
      unstoppedBackgroundRuns(database)
        .select("backgroundDeadlineAt as deadline")
        .where("backgroundDeadlineAt", "is not", null),
    )
    .orderBy("deadline")
    .limit(1)
    .executeTakeFirst();
  // Both recovery sweeps consider the stored instant itself inside the lease.
  return row?.deadline ? new Date(row.deadline.getTime() + 1) : null;
}

/** One overdue Run whose stop committed, and everything it owes after commit. */
export interface BackgroundDeadlineStop {
  readonly commandId: CommandRow["id"] | null;

  readonly revokedGrants: readonly RevokedRunGrant[];
}

/**
 * Stops each Run whose background work outran its deadline, the way a Stop
 * does — its tools end now, its questions close, its Runner is told to wind
 * it down — but without pausing its Thread's queue: the work ran out of time,
 * nobody asked to hold the Thread.
 *
 * Each Run is stopped in a transaction of its own and handed to `onStopped`
 * as soon as that transaction commits. A Run whose stop fails does not end the
 * sweep: every overdue Run gets its turn, so one that keeps failing cannot
 * starve the rest, and the failures are thrown together at the end.
 */
export async function stopRunsPastBackgroundDeadline(
  database: Kysely<DatabaseSchema>,
  onStopped: (stop: BackgroundDeadlineStop) => void,
  links: ChannelLinks,
  now = new Date(),
): Promise<number> {
  const candidates = await unstoppedBackgroundRuns(database)
    .select("runs.id")
    .where("backgroundDeadlineAt", "<", now)
    .orderBy("runs.id")
    .execute();
  // How many this sweep itself stopped: its owner's measure of progress.
  let settled = 0;
  const failures: unknown[] = [];
  for (const candidate of candidates) {
    const stopped = await commitPersonalMutation(database, async (transaction) => {
      const run = await transaction
        .selectFrom("runs")
        .innerJoin("threads", "threads.id", "runs.threadId")
        .select([
          "runs.bindingGeneration",
          "runs.backgroundDeadlineAt",
          "runs.finishIntent",
          "runs.environmentId",
          "runs.id",
          "runs.phase",
          "runs.requestedBy",
          "runs.status",
          "runs.threadId",
          "runs.voiceSessionId",
        ])
        .where("runs.id", "=", candidate.id)
        .forNoKeyUpdate("runs")
        .executeTakeFirst();
      if (
        !run ||
        run.finishIntent !== null ||
        run.phase !== "background" ||
        !["queued", "starting", "running", "waiting"].includes(run.status) ||
        run.backgroundDeadlineAt === null ||
        run.backgroundDeadlineAt >= now ||
        (await runWasStopped(transaction, run.id))
      ) {
        return null;
      }
      return stopRunWithoutPausing(
        transaction,
        run,
        links,
        now,
        {
          kind: "background-deadline",
          runId: run.id,
        },
        `background-deadline:${run.id}`,
      );
    }).catch((error: unknown) => {
      failures.push(error);
      return null;
    });
    if (stopped) {
      onStopped(stopped);
      settled += 1;
    }
  }
  if (failures.length > 0)
    throw new AggregateError(failures, "Stopping Runs past their background deadline failed");
  return settled;
}
export async function stopHeldRun(
  database: Kysely<DatabaseSchema>,
  claims: Parameters<typeof assertActiveGrant>[1],
  reason: "limit" | "queued-input" | "device-access",
  links: ChannelLinks,
  executionNow: () => number = Date.now,
): Promise<BackgroundDeadlineStop | null> {
  return commitPersonalMutation(database, async (transaction) => {
    const run = await transaction
      .selectFrom("runs")
      .innerJoin("threads", "threads.id", "runs.threadId")
      .select([
        "runs.bindingGeneration",
        "runs.environmentId",
        "runs.id",
        "runs.phase",
        "runs.requestedBy",
        "runs.status",
        "runs.threadId",
        "runs.voiceSessionId",
      ])
      .where("runs.id", "=", claims.runId)
      .forNoKeyUpdate("runs")
      .executeTakeFirst();
    if (!run || run.phase !== "turn" || run.voiceSessionId !== null) return null;
    try {
      await assertActiveGrant(transaction, claims, executionNow);
    } catch (error) {
      if (error instanceof OpensteerError && error.code === "forbidden") return null;
      throw error;
    }
    if (await runWasStopped(transaction, run.id)) return null;
    return stopRunWithoutPausing(
      transaction,
      run,
      links,
      new Date(executionNow()),
      {
        kind: "request-hold",
        runId: run.id,
        reason,
      },
      `request-hold:${run.id}:${claims.bindingGeneration}`,
    );
  });
}
async function stopRunWithoutPausing(
  transaction: Transaction<DatabaseSchema>,
  run: Pick<
    RunRow,
    "bindingGeneration" | "environmentId" | "id" | "requestedBy" | "status" | "threadId"
  > & {},
  links: ChannelLinks,
  now: Date,
  authoritySource: Readonly<Record<string, unknown>>,
  idempotencyKey: string,
): Promise<BackgroundDeadlineStop> {
  await lockThreadRow(transaction, run.threadId);
  if (run.status === "queued" || (run.status === "starting" && run.bindingGeneration === null)) {
    await finalizeRunTransaction(transaction, {
      completedAt: now,
      links,
      queuedInputCancellation: "seed-input",
      runId: run.id,
      source: "host",
      status: "interrupted",
    });
    return { commandId: null, revokedGrants: [] };
  }
  await cancelPending(transaction, {
    reason: "run-ended",
    resolvedAt: now,
    runId: run.id,
  });
  await transaction
    .updateTable("runs")
    .set({
      status: "running",
    })
    .where("id", "=", run.id)
    .where("status", "=", "waiting")
    .execute();
  await updateExecutionThread(transaction, run.threadId, now);
  const command = await transaction
    .insertInto("commands")
    .values({
      actorPrincipalId: await principalIdForUser(transaction, run.requestedBy),
      authoritySource: jsonValue(authoritySource),
      dispatcherId: null,
      environmentId: run.environmentId,
      id: createId("command"),
      idempotencyKey: idempotencyKey,
      lastError: null,
      payload: jsonValue({
        runId: run.id,
        threadId: run.threadId,
        type: "run.interrupt",
      }),
      requestedBy: run.requestedBy,
      runId: run.id,
      status: "pending",
      threadId: run.threadId,
      type: "run.interrupt",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  await wakeExecutionCommands(transaction);
  return {
    commandId: command.id,
    revokedGrants: await revokeRunGrants(transaction, [run.id], "stopped"),
  };
}
export async function recoverRunsWithExpiredExecutionBindings(
  database: Kysely<DatabaseSchema>,
  links: ChannelLinks,
  onRevoked: (grants: readonly RevokedRunGrant[]) => void,
  now = new Date(),
): Promise<RunRecoveryOutcome & { readonly settled: number }> {
  // A session keeps its last Run's lease after that Run ends; only the Run
  // that acquired the current binding is judged by it.
  const candidates = await leasedRuns(database)
    .select("runs.id")
    .where("providerSessions.leaseExpiresAt", "<", now)
    .orderBy("runs.id")
    .execute();
  const revokedGrants: RevokedRunGrant[] = [];
  const terminatedRuns: RecoveredRunTarget[] = [];
  // Every expired binding this sweep itself recovered, requeued or ended. A
  // Run whose recovery fails does not end the sweep, so it cannot starve the rest.
  let settled = 0;
  const failures: unknown[] = [];
  for (const candidate of candidates) {
    const terminal = await commitPersonalMutation(database, async (transaction) => {
      const run = await transaction
        .selectFrom("runs")
        .innerJoin("threads", "threads.id", "runs.threadId")
        .select([
          "runs.bindingGeneration",
          "runs.environmentId",
          "runs.id",
          "runs.providerSessionId",
          "runs.status",
          "runs.threadId",
          "runs.voiceSessionId",
        ])
        .where("runs.id", "=", candidate.id)
        .forNoKeyUpdate("runs")
        .executeTakeFirst();
      if (!run || !["starting", "running", "waiting"].includes(run.status)) return null;
      if (run.bindingGeneration === null) return null;
      await lockThreadRow(transaction, run.threadId);
      const session = await lockThreadProviderSession(
        transaction,
        run.threadId,
        run.providerSessionId,
      );
      if (
        !session ||
        session.bindingGeneration !== run.bindingGeneration ||
        session.leaseExpiresAt === null ||
        session.leaseExpiresAt >= now
      )
        return null;
      const recovered = await recoverLostRunTransaction(transaction, {
        now,
        failure: {
          code: "execution_binding_expired",
          message: "The Runner stopped renewing this Run's execution binding",
          retryable: false,
          status: "failed",
        },
        links,
        runId: run.id,
      });
      return {
        ...recovered,
        target: {
          environmentId: run.environmentId,
          runId: run.id,
          threadId: run.threadId,
        },
      };
    }).catch((error: unknown) => {
      failures.push(error);
      return null;
    });
    if (terminal) {
      settled += 1;
      onRevoked(terminal.revokedGrants);
      revokedGrants.push(...terminal.revokedGrants);
      if (terminal.status === "terminal") terminatedRuns.push(terminal.target);
    }
  }
  if (failures.length > 0)
    throw new AggregateError(failures, "Recovering expired execution bindings failed");
  return {
    terminatedRuns,
    revokedGrants,
    settled,
  };
}

function lostExecutionRecovery(facts: {
  readonly expired: boolean;
  readonly restarted: boolean;
  readonly runStatus: RunRow["status"];
  readonly sessionStatus: ProviderSessionTable["status"];
}): {
  readonly mayRequeue: boolean;
  readonly failure: RunFailure;
} {
  return {
    mayRequeue:
      !facts.expired &&
      !facts.restarted &&
      facts.runStatus === "starting" &&
      facts.sessionStatus === "starting",
    failure: facts.expired
      ? {
          code: "execution_binding_expired",
          message: "The Runner stopped renewing this Run's execution binding",
          retryable: false,
          status: "failed",
        }
      : facts.restarted
        ? {
            code: "runner_restarted",
            message: "The Runner restarted before the Run reached a terminal event",
            retryable: false,
            status: "failed",
          }
        : {
            code: "runner_state_lost",
            message: "The Runner no longer holds this Run",
            retryable: false,
            status: "failed",
          },
  };
}

/**
 * Messages a chat queued before the update were admitted by routes that no longer exist; they
 * never run. Each start cancels any still waiting (`pending` only: one whose outcome is unknown
 * may already have been acted on, and stays unknown), a batch per transaction, refreshing their
 * task's queue like any other cancellation. Nothing writes such an input any more.
 */
export async function cancelLegacyChatInputs(database: Kysely<DatabaseSchema>): Promise<void> {
  for (;;) {
    const retired = await commitPersonalMutation(database, async (tx) => {
      const rows = await tx
        .selectFrom("threadInputs")
        .select(["messageId", "threadId"])
        .where("state", "=", "pending")
        .where(sql<boolean>`thread_inputs.authority_source->>'kind' = 'channel-ingress'`)
        .orderBy("messageId")
        .limit(32)
        .execute();
      if (!rows.length) return 0;
      await tx
        .selectFrom("threads")
        .select("id")
        .where(
          "id",
          "in",
          rows.map(({ threadId }) => threadId),
        )
        .orderBy("id")
        .forNoKeyUpdate()
        .execute();
      const waiting = await tx
        .selectFrom("threadInputs")
        .select("messageId")
        .where(
          "messageId",
          "in",
          rows.map(({ messageId }) => messageId),
        )
        .where("state", "=", "pending")
        .orderBy("messageId")
        .forNoKeyUpdate()
        .execute();
      if (!waiting.length) return 0;
      const cancelled = await tx
        .updateTable("threadInputs")
        .set({ state: "cancelled", cancelReason: "channel-access-changed", updatedAt: new Date() })
        .where(
          "messageId",
          "in",
          waiting.map(({ messageId }) => messageId),
        )
        .returning(["threadId", "messageId"])
        .execute();
      for (const row of cancelled) await refreshInputQueue(tx, row.threadId, row.messageId);
      return cancelled.length;
    });
    if (!retired) return;
  }
}
