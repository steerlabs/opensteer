import { recoverLostRunTransaction } from "./run-recovery.js";
import { lockRunProjectionRows } from "./run-projection-locks.js";
import { withDatabaseTransaction } from "./connection.js";
import * as commandStore from "./command-store.js";
import { resendableControlCommandTypes } from "./command-delivery.js";
import {
  type EnvironmentId,
  type RunId,
  type ThreadId,
  type WorkspaceId,
  type Sequence,
  type AgentEvent,
  type RunFailure,
  type RunnerId,
  type UserId,
  createId,
  nonTerminalRunStatuses,
} from "@opensteer/core";
import { type Kysely, sql } from "kysely";
import {
  type CommandRow,
  type DatabaseSchema,
  type RunRow,
  type ProviderSessionTable,
} from "./schema.js";
import {
  type ChannelLinks,
  lockWorkspaceRow,
  lockThreadRow,
  jsonValue,
  principalIdForUser,
  returnRunToQueue,
  threadExecutionIsAvailableToUser,
  safeGeneration,
} from "./store-primitives.js";
import { endStoppedUnconfirmedRun, finalizeRunTransaction } from "./run-finalization.js";
import { revokeRunGrants, runWasStopped, type RevokedRunGrant } from "./run-grants.js";
import { cancelPending } from "./request-store.js";
import { appendHostWorkspaceEvent } from "./workspace-events.js";
import { threadInputFromRow } from "./thread-row-mappers.js";
import { ensureQueuedRun, settlePausedConversation } from "./thread-inbox.js";
import { projectThreadState } from "./thread-status.js";

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
  readonly workspaceId: WorkspaceId;
}

export interface ResumedExecution {
  readonly afterSequence: Sequence;
  readonly runId: RunId;
  readonly threadId: ThreadId;
  readonly workspaceId: WorkspaceId;
}

/** Whether an announced Run continues on its Runner's new connection. */
export type ExecutionAttachment =
  | { readonly nextOrdinal: number; readonly runId: RunId; readonly status: "attached" }
  | { readonly reason: string; readonly runId: RunId; readonly status: "revoked" };

export interface RunRecoveryOutcome {
  readonly revokedGrants?: readonly RevokedRunGrant[];
  readonly events: readonly AgentEvent[];
  /** Exactly the Runs terminalized by this recovery call, never inferred from projection events. */
  readonly terminatedRuns: readonly RecoveredRunTarget[];
}

/** Run states in which a Runner holds the Run under an execution binding. */
const executingRunStatuses = ["starting", "running", "waiting"] as const;

/** Provider-session states of a binding a Runner may still be executing under. */
const boundSessionStatuses = ["starting", "ready", "running"] as const;

type AbandonedRunRecovery =
  | {
      readonly activeRunIds: readonly RunId[];
      readonly code: "runner_disconnected";
      readonly kind: "runner-disconnect";
      readonly message: string;
      readonly runnerBootId: string;
      readonly runnerId: RunnerId;
    }
  | {
      readonly code: "workspace_access_revoked";
      readonly kind: "membership-revocation";
      readonly message: string;
      readonly userId: UserId;
      readonly workspaceId: WorkspaceId;
    }
  | {
      readonly code: "workspace_access_revoked";
      readonly kind: "workspace-deletion";
      readonly message: string;
      readonly workspaceId: WorkspaceId;
    };

async function recoverAbandonedRuns(
  database: Kysely<DatabaseSchema>,
  links: ChannelLinks,
  recovery: AbandonedRunRecovery,
): Promise<RunRecoveryOutcome> {
  const activeStatuses =
    recovery.kind === "membership-revocation" || recovery.kind === "workspace-deletion"
      ? nonTerminalRunStatuses
      : (["starting", "running", "waiting"] as const);
  const sessionStatuses = ["starting", "ready", "running"] as const;
  // Command status is a delivery receipt, not execution liveness. A Runner can
  // accept the execute command (making it succeeded) and then disappear while
  // the Run remains active; recovery is therefore fenced by the Run and its
  // exact provider-session binding instead of a stale command-state proxy.
  const candidates =
    recovery.kind === "membership-revocation"
      ? await database
          .selectFrom("runs")
          .innerJoin("threads", "threads.id", "runs.threadId")
          .select("runs.id")
          .distinct()
          .where("runs.status", "in", activeStatuses)
          .where("runs.requestedBy", "=", recovery.userId)
          .where("threads.workspaceId", "=", recovery.workspaceId)
          .orderBy("runs.id", "asc")
          .execute()
      : recovery.kind === "workspace-deletion"
        ? await database
            .selectFrom("runs")
            .innerJoin("threads", "threads.id", "runs.threadId")
            .select("runs.id")
            .distinct()
            .where("runs.status", "in", activeStatuses)
            .where("threads.workspaceId", "=", recovery.workspaceId)
            .orderBy("runs.id", "asc")
            .execute()
        : recovery.kind === "runner-disconnect"
          ? await database
              .selectFrom("runs")
              .innerJoin("providerSessions", "providerSessions.id", "runs.providerSessionId")
              .select("runs.id")
              .distinct()
              .where("runs.status", "in", activeStatuses)
              .where("runs.id", "in", recovery.activeRunIds)
              .where("providerSessions.active", "=", true)
              .where("providerSessions.runnerId", "=", recovery.runnerId)
              .where("providerSessions.runnerBootId", "=", recovery.runnerBootId)
              .where("providerSessions.status", "in", sessionStatuses)
              .orderBy("runs.id", "asc")
              .execute()
          : await database
              .selectFrom("runs")
              .select("runs.id")
              .distinct()
              .where("runs.status", "in", activeStatuses)
              .orderBy("runs.id", "asc")
              .execute();
  const events: AgentEvent[] = [];
  const terminatedRuns: RecoveredRunTarget[] = [];
  for (const candidate of candidates) {
    const recovered = await withDatabaseTransaction(database, async (transaction) => {
      // Runner events and recovery both lock the Run first. Whichever terminal
      // outcome wins that lock is the only one projected or published. Recover
      // one Run per transaction so unrelated Runs in one workspace cannot form
      // a Run-lock/workspace-sequence deadlock with terminal Runner events.
      const run = await transaction
        .selectFrom("runs")
        .innerJoin("threads", "threads.id", "runs.threadId")
        .select([
          "runs.environmentId",
          "runs.id",
          "runs.providerSessionId",
          "runs.status",
          "runs.threadId",
          "threads.workspaceId",
        ])
        .where("runs.id", "=", candidate.id)
        .forNoKeyUpdate("runs")
        .executeTakeFirst();
      if (!run || !new Set<string>(activeStatuses).has(run.status)) {
        return null;
      }
      await lockWorkspaceRow(transaction, run.workspaceId);
      await lockThreadRow(transaction, run.threadId);
      const session = await transaction
        .selectFrom("providerSessions")
        .select(["id", "runnerBootId", "runnerId", "status"])
        .where("id", "=", run.providerSessionId)
        .forNoKeyUpdate()
        .executeTakeFirst();
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
      const events = await finalizeRunTransaction(transaction, {
        requestCancellationReason: "process-lost",
        completedAt: new Date(),
        failure,
        links,
        source: "host",
        queuedInputCancellation:
          recovery.kind === "membership-revocation" || recovery.kind === "workspace-deletion"
            ? "authority-cohort"
            : "seed-input",
        runId: run.id,
        status: "failed",
      });
      return {
        events,
        target: { environmentId: run.environmentId, runId: run.id, threadId: run.threadId },
      };
    });
    if (recovered) {
      events.push(...recovered.events);
      terminatedRuns.push(recovered.target);
    }
  }
  return { events, terminatedRuns };
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
  if (input.activeRunIds.length === 0) return { events: [], terminatedRuns: [] };
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
): Promise<readonly AgentEvent[]> {
  return withDatabaseTransaction(database, async (transaction) => {
    const run = await transaction
      .selectFrom("runs")
      .innerJoin("threads", "threads.id", "runs.threadId")
      .select(["runs.providerSessionId", "runs.status", "runs.threadId", "threads.workspaceId"])
      .where("runs.id", "=", input.runId)
      .forNoKeyUpdate("runs")
      .executeTakeFirst();
    if (!run || !["starting", "running", "waiting"].includes(run.status)) return [];
    await lockWorkspaceRow(transaction, run.workspaceId);
    await lockThreadRow(transaction, run.threadId);
    const session = await transaction
      .selectFrom("providerSessions")
      .select(["active", "bindingGeneration", "runnerBootId", "runnerId", "status"])
      .where("id", "=", run.providerSessionId)
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (
      !session?.active ||
      session.runnerId !== input.runnerId ||
      session.runnerBootId !== input.runnerBootId ||
      session.bindingGeneration !== input.bindingGeneration ||
      !["starting", "ready", "running"].includes(session.status)
    ) {
      return [];
    }
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

export async function recoverThreadWorkQueues(
  database: Kysely<DatabaseSchema>,
): Promise<readonly AgentEvent[]> {
  const obsolete = await database
    .selectFrom("runs")
    .innerJoin("threadInputs", "threadInputs.messageId", "runs.seedInputId")
    .select("runs.id")
    .where("runs.status", "=", "queued")
    .where("threadInputs.policy", "=", "report")
    .orderBy("runs.id", "asc")
    .execute();
  const events: AgentEvent[] = [];
  for (const candidate of obsolete) {
    events.push(
      ...(await withDatabaseTransaction(database, async (transaction) => {
        const run = await transaction
          .selectFrom("runs")
          .selectAll()
          .where("id", "=", candidate.id)
          .forNoKeyUpdate()
          .executeTakeFirstOrThrow();
        if (run.status !== "queued") return [];
        const observed = await transaction
          .selectFrom("threads")
          .select("workspaceId")
          .where("id", "=", run.threadId)
          .executeTakeFirstOrThrow();
        await lockWorkspaceRow(transaction, observed.workspaceId);
        await lockThreadRow(transaction, run.threadId);
        await lockRunProjectionRows(transaction, { runIds: [run.id], threadIds: [run.threadId] });
        const now = new Date();
        await transaction
          .updateTable("runs")
          .set({ status: "interrupted", completedAt: now })
          .where("id", "=", run.id)
          .execute();
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
            .set({ usedAutonomousRuns: sql`greatest(used_autonomous_runs - 1, 0)` })
            .where("id", "=", run.causalChainId)
            .execute();
        }
        const event = await appendHostWorkspaceEvent(transaction, {
          data: { status: "interrupted" },
          environmentId: run.environmentId,
          runId: run.id,
          threadId: run.threadId,
          type: "run.interrupted",
          workspaceId: observed.workspaceId,
        });
        const membership = await transaction
          .selectFrom("workspaceMemberships")
          .select(["generation", "state"])
          .where("workspaceId", "=", observed.workspaceId)
          .where("userId", "=", run.requestedBy)
          .executeTakeFirst();
        const reportAuthorityCurrent =
          membership?.state === "active" && membership.generation === run.membershipGeneration;
        const unconfirmedReports = await transaction
          .updateTable("threadInputs")
          .set(
            reportAuthorityCurrent
              ? { state: "unknown", updatedAt: now }
              : { cancelReason: "membership-changed", state: "cancelled", updatedAt: now },
          )
          .where("runId", "=", run.id)
          .where("policy", "=", "report")
          .where("state", "=", "claimed")
          .returningAll()
          .execute();
        const receiptEvents: AgentEvent[] = [];
        for (const report of unconfirmedReports) {
          receiptEvents.push(
            await appendHostWorkspaceEvent(transaction, {
              data: { input: threadInputFromRow(report) },
              environmentId: run.environmentId,
              runId: run.id,
              threadId: run.threadId,
              type: "thread-input.updated",
              workspaceId: observed.workspaceId,
            }),
          );
        }
        const thread = await transaction
          .selectFrom("threads")
          .selectAll()
          .where("id", "=", run.threadId)
          .executeTakeFirstOrThrow();
        const queued = await ensureQueuedRun(transaction, thread);
        const statusEvents = await projectThreadState(transaction, thread.id, now);
        return [event, ...receiptEvents, ...queued.events, ...statusEvents];
      })),
    );
  }
  // An earlier Host paused a conversation on Stop; nothing pauses one now.
  const pausedConversations = await database
    .selectFrom("threads")
    .select("id")
    .where("role", "=", "conversation")
    .where("inputQueuePaused", "=", true)
    .orderBy("id", "asc")
    .execute();
  for (const { id } of pausedConversations) {
    events.push(
      ...(await withDatabaseTransaction(database, (transaction) =>
        settlePausedConversation(transaction, id),
      )),
    );
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
    events.push(
      ...(await withDatabaseTransaction(database, async (transaction) => {
        const observed = await transaction
          .selectFrom("threads")
          .select("workspaceId")
          .where("id", "=", threadId)
          .executeTakeFirstOrThrow();
        await lockWorkspaceRow(transaction, observed.workspaceId);
        await lockThreadRow(transaction, threadId);
        const thread = await transaction
          .selectFrom("threads")
          .selectAll()
          .where("id", "=", threadId)
          .executeTakeFirstOrThrow();
        return (await ensureQueuedRun(transaction, thread)).events;
      })),
    );
  }
  return events;
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
): Promise<readonly AgentEvent[]> {
  await database
    .updateTable("commands")
    .set({ dispatcherId: null, status: "pending", updatedAt: new Date() })
    .where("status", "=", "dispatched")
    .where("type", "in", resendableControlCommandTypes)
    .execute();
  const steers = await database
    .selectFrom("commands")
    .select("id")
    .where("status", "=", "dispatched")
    .where("type", "=", "run.steer")
    .orderBy("id", "asc")
    .execute();
  const events: AgentEvent[] = [];
  for (const steer of steers) {
    events.push(
      ...(await commandStore.markSteerUnknown(
        database,
        steer.id,
        "The Host restarted before the Runner confirmed the steer",
      )),
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
    const requeued = await withDatabaseTransaction(database, async (transaction) => {
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
          "runs.threadId",
          "threads.workspaceId",
        ])
        .where("runs.id", "=", command.runId)
        .forNoKeyUpdate("runs")
        .executeTakeFirst();
      if (run?.status !== "starting") return null;
      await lockWorkspaceRow(transaction, run.workspaceId);
      await lockThreadRow(transaction, run.threadId);
      const session = await transaction
        .selectFrom("providerSessions")
        .select(["bindingGeneration", "runnerId"])
        .where("id", "=", run.providerSessionId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (
        session &&
        session.runnerId !== null &&
        run.bindingGeneration !== null &&
        run.bindingGeneration === session.bindingGeneration
      )
        return null;
      if (await runWasStopped(transaction, run.id)) {
        return endStoppedUnconfirmedRun(transaction, { links, runId: run.id });
      }
      await lockRunProjectionRows(transaction, { runIds: [run.id], threadIds: [run.threadId] });
      const returned = await transaction
        .updateTable("commands")
        .set({
          dispatcherId: null,
          lastError: jsonValue({ message: "The Host restarted before dispatching this Run" }),
          status: "pending",
          updatedAt: new Date(),
        })
        .where("id", "=", id)
        .where("status", "=", "dispatched")
        .executeTakeFirst();
      if (returned.numUpdatedRows !== 1n) return null;
      return returnRunToQueue(transaction, { run, workspaceId: run.workspaceId });
    });
    if (requeued) events.push(...requeued);
  }
  return events;
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
    readonly leaseExpiresAt: Date;
    readonly runnerBootId: string;
    readonly runnerId: RunnerId;
  },
  onRevoked: (grants: readonly RevokedRunGrant[]) => void,
  executionNow: () => number = Date.now,
): Promise<{
  readonly revokedGrants: readonly RevokedRunGrant[];
  readonly events: readonly AgentEvent[];
  /** Each attached Run, with the sequence its Workspace had reached. */
  readonly resumed: readonly ResumedExecution[];
  readonly results: readonly ExecutionAttachment[];
}> {
  const now = new Date(executionNow());
  const events: AgentEvent[] = [];
  const revokedGrants: RevokedRunGrant[] = [];
  const resumed: ResumedExecution[] = [];
  const results: ExecutionAttachment[] = [];
  for (const execution of input.executions) {
    const settled = await withDatabaseTransaction(database, async (transaction) => {
      const revoked = (reason: string, terminal: readonly AgentEvent[] = []) => ({
        events: terminal,
        revokedGrants: [] as readonly RevokedRunGrant[],
        result: { reason, runId: execution.runId, status: "revoked" as const },
      });
      const run = await transaction
        .selectFrom("runs")
        .innerJoin("threads", "threads.id", "runs.threadId")
        .select([
          "runs.environmentId",
          "runs.membershipGeneration",
          "runs.nextRunnerOrdinal",
          "runs.providerSessionId",
          "runs.requestedBy",
          "runs.status",
          "runs.threadId",
          "threads.workspaceId",
        ])
        .where("runs.id", "=", execution.runId)
        .forNoKeyUpdate("runs")
        .executeTakeFirst();
      if (
        !run ||
        run.threadId !== execution.threadId ||
        run.workspaceId !== execution.workspaceId ||
        run.environmentId !== execution.environmentId
      ) {
        return revoked("The Host has no such Run");
      }
      if (!executingRunStatuses.includes(run.status as (typeof executingRunStatuses)[number])) {
        return revoked("The Run has ended");
      }
      await lockWorkspaceRow(transaction, run.workspaceId);
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
          failure: { code, message, retryable: false, status: "failed" },
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
          ...revoked("The Run's execution lease expired", recovered.events),
          revokedGrants: recovered.revokedGrants,
        };
      }
      if (
        !(await threadExecutionIsAvailableToUser(
          transaction,
          run.threadId,
          run.requestedBy,
          safeGeneration(run.membershipGeneration),
        ))
      ) {
        return revoked(
          "The Run's execution authority ended",
          await fail(
            "workspace_access_revoked",
            "Workspace access was revoked before the Run reached a terminal event",
          ),
        );
      }
      // The Runner numbers events densely from zero, so it can never have
      // fewer than the Host committed; one that does is not this Run's.
      if (execution.nextOrdinal < run.nextRunnerOrdinal) {
        return revoked(
          "The Runner holds fewer events than the Host committed",
          await fail("runner_state_lost", "The Runner lost events this Run had reported"),
        );
      }
      await transaction
        .updateTable("providerSessions")
        .set({ leaseExpiresAt: input.leaseExpiresAt, updatedAt: now })
        .where("id", "=", run.providerSessionId)
        .executeTakeFirstOrThrow();
      const workspace = await transaction
        .selectFrom("workspaces")
        .select("eventSequence")
        .where("id", "=", run.workspaceId)
        .executeTakeFirstOrThrow();
      return {
        resumed: {
          afterSequence: workspace.eventSequence as Sequence,
          runId: execution.runId,
          threadId: run.threadId,
          workspaceId: run.workspaceId,
        },
        events: [],
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
    events.push(...settled.events);
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
  );
  events.push(...lost.events);
  revokedGrants.push(...lost.revokedGrants);
  return { events, resumed, results, revokedGrants };
}

async function recoverLostExecutions(
  database: Kysely<DatabaseSchema>,
  links: ChannelLinks,
  runnerId: RunnerId,
  runnerBootId: string,
  excludedRunIds: readonly RunId[],
  onRevoked: (grants: readonly RevokedRunGrant[]) => void,
  executionNow: () => number = Date.now,
): Promise<{
  readonly events: readonly AgentEvent[];
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
  const events: AgentEvent[] = [];
  const revokedGrants: RevokedRunGrant[] = [];
  for (const candidate of candidates) {
    const recovered = await withDatabaseTransaction(database, async (transaction) => {
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
          "threads.workspaceId",
        ])
        .where("runs.id", "=", candidate.id)
        .forNoKeyUpdate("runs")
        .executeTakeFirst();
      if (
        !run ||
        !executingRunStatuses.includes(run.status as (typeof executingRunStatuses)[number])
      ) {
        return { events: [], revokedGrants: [] };
      }
      await lockWorkspaceRow(transaction, run.workspaceId);
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
        session.runnerId !== runnerId ||
        run.bindingGeneration === null ||
        run.bindingGeneration !== session.bindingGeneration ||
        !boundSessionStatuses.includes(session.status as (typeof boundSessionStatuses)[number])
      ) {
        return { events: [], revokedGrants: [] };
      }
      const now = new Date(executionNow());
      const recovery = lostExecutionRecovery({
        expired: !session.leaseExpiresAt || session.leaseExpiresAt <= now,
        restarted: session.runnerBootId !== runnerBootId,
        runStatus: run.status,
        sessionStatus: session.status,
      });
      if (recovery.mayRequeue) {
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
          return {
            events: await endStoppedUnconfirmedRun(transaction, { links, runId: run.id }),
            revokedGrants: [],
          };
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
              lastError: jsonValue({ message: "The Runner did not receive this Run" }),
              status: "pending",
              updatedAt: new Date(),
            })
            .where("id", "=", unconfirmed.id)
            .executeTakeFirstOrThrow();
          return {
            events: await returnRunToQueue(transaction, { run, workspaceId: run.workspaceId }),
            revokedGrants: [],
          };
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
    events.push(...recovered.events);
    revokedGrants.push(...recovered.revokedGrants);
  }
  return { events, revokedGrants };
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
    .set({ leaseExpiresAt, updatedAt: new Date() })
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

/** One overdue Run whose stop committed, and everything it owes after commit. */
export interface BackgroundDeadlineStop {
  readonly commandId: CommandRow["id"] | null;
  readonly events: readonly AgentEvent[];
  readonly revokedGrants: readonly RevokedRunGrant[];
}

/**
 * Stops each Run whose background work outran its deadline, the way a Stop
 * does — its tools end now, its questions close, its Runner is told to wind
 * it down — but without pausing its Thread's queue: the work ran out of time,
 * nobody asked to hold the Thread.
 *
 * Each Run is stopped in a transaction of its own and handed to `onStopped`
 * as soon as that transaction commits: a later Run's failure ends the sweep,
 * and must not hide a stop that already happened.
 */
export async function stopRunsPastBackgroundDeadline(
  database: Kysely<DatabaseSchema>,
  onStopped: (stop: BackgroundDeadlineStop) => void,
  links: ChannelLinks,
  now = new Date(),
): Promise<void> {
  const candidates = await database
    .selectFrom("runs")
    .select("id")
    .where("phase", "=", "background")
    .where("backgroundDeadlineAt", "<", now)
    .where("status", "in", ["queued", "starting", "running", "waiting"])
    .orderBy("id", "asc")
    .execute();
  for (const candidate of candidates) {
    const stopped = await withDatabaseTransaction(database, async (transaction) => {
      const run = await transaction
        .selectFrom("runs")
        .innerJoin("threads", "threads.id", "runs.threadId")
        .select([
          "runs.bindingGeneration",
          "runs.backgroundDeadlineAt",
          "runs.environmentId",
          "runs.id",
          "runs.phase",
          "runs.requestedBy",
          "runs.status",
          "runs.threadId",
          "threads.workspaceId",
        ])
        .where("runs.id", "=", candidate.id)
        .forNoKeyUpdate("runs")
        .executeTakeFirst();
      if (
        !run ||
        run.phase !== "background" ||
        !["queued", "starting", "running", "waiting"].includes(run.status) ||
        run.backgroundDeadlineAt === null ||
        run.backgroundDeadlineAt >= now ||
        (await runWasStopped(transaction, run.id))
      ) {
        return null;
      }
      await lockWorkspaceRow(transaction, run.workspaceId);
      await lockThreadRow(transaction, run.threadId);
      if (
        run.status === "queued" ||
        (run.status === "starting" && run.bindingGeneration === null)
      ) {
        return {
          commandId: null,
          events: await finalizeRunTransaction(transaction, {
            completedAt: now,
            links,
            queuedInputCancellation: "seed-input",
            runId: run.id,
            source: "host",
            status: "interrupted",
          }),
          revokedGrants: [],
        };
      }
      const runEvents = [
        ...(await cancelPending(transaction, {
          reason: "run-ended",
          resolvedAt: now,
          runId: run.id,
        })),
      ];
      await transaction
        .updateTable("runs")
        .set({ status: "running" })
        .where("id", "=", run.id)
        .where("status", "=", "waiting")
        .execute();
      runEvents.push(...(await projectThreadState(transaction, run.threadId, now)));
      const command = await transaction
        .insertInto("commands")
        .values({
          actorPrincipalId: await principalIdForUser(transaction, run.requestedBy),
          authoritySource: jsonValue({ kind: "background-deadline", runId: run.id }),
          dispatcherId: null,
          environmentId: run.environmentId,
          id: createId("command"),
          idempotencyKey: `background-deadline:${run.id}`,
          lastError: null,
          payload: jsonValue({ runId: run.id, threadId: run.threadId, type: "run.interrupt" }),
          requestedBy: run.requestedBy,
          runId: run.id,
          status: "pending",
          threadId: run.threadId,
          type: "run.interrupt",
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      return {
        commandId: command.id,
        events: runEvents,
        revokedGrants: await revokeRunGrants(transaction, [run.id], "stopped"),
      };
    });
    if (stopped) onStopped(stopped);
  }
}

export async function recoverRunsWithExpiredExecutionBindings(
  database: Kysely<DatabaseSchema>,
  links: ChannelLinks,
  onRevoked: (grants: readonly RevokedRunGrant[]) => void,
  now = new Date(),
): Promise<RunRecoveryOutcome> {
  const candidates = await database
    .selectFrom("runs")
    .innerJoin("providerSessions", "providerSessions.id", "runs.providerSessionId")
    .select("runs.id")
    .distinct()
    .where("runs.status", "in", ["starting", "running", "waiting"])
    .where("providerSessions.active", "=", true)
    .where("providerSessions.leaseExpiresAt", "<", now)
    // A session keeps its last Run's lease after that Run ends; only the Run
    // that acquired the current binding is judged by it.
    .whereRef("runs.bindingGeneration", "=", "providerSessions.bindingGeneration")
    .orderBy("runs.id", "asc")
    .execute();
  const events: AgentEvent[] = [];
  const revokedGrants: RevokedRunGrant[] = [];
  const terminatedRuns: RecoveredRunTarget[] = [];
  for (const candidate of candidates) {
    const terminal = await withDatabaseTransaction(database, async (transaction) => {
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
          "threads.workspaceId",
        ])
        .where("runs.id", "=", candidate.id)
        .forNoKeyUpdate("runs")
        .executeTakeFirst();
      if (!run || !["starting", "running", "waiting"].includes(run.status)) return null;
      if (run.bindingGeneration === null) return null;
      await lockWorkspaceRow(transaction, run.workspaceId);
      await lockThreadRow(transaction, run.threadId);
      const expired = await transaction
        .selectFrom("providerSessions")
        .select("id")
        .where("id", "=", run.providerSessionId)
        .where("bindingGeneration", "=", run.bindingGeneration)
        .where("leaseExpiresAt", "<", now)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!expired) return null;
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
        target: { environmentId: run.environmentId, runId: run.id, threadId: run.threadId },
      };
    });
    if (terminal) {
      onRevoked(terminal.revokedGrants);
      events.push(...terminal.events);
      revokedGrants.push(...terminal.revokedGrants);
      if (terminal.status === "terminal") terminatedRuns.push(terminal.target);
    }
  }
  return { events, terminatedRuns, revokedGrants };
}

export async function failActiveRunsForMembershipRevocation(
  database: Kysely<DatabaseSchema>,
  links: ChannelLinks,
  input: {
    readonly userId: UserId;
    readonly workspaceId: WorkspaceId;
  },
): Promise<RunRecoveryOutcome> {
  return recoverAbandonedRuns(database, links, {
    code: "workspace_access_revoked",
    kind: "membership-revocation",
    message: "Workspace access was revoked before the Run reached a terminal event",
    userId: input.userId,
    workspaceId: input.workspaceId,
  });
}

export async function failActiveRunsForWorkspaceDeletion(
  database: Kysely<DatabaseSchema>,
  links: ChannelLinks,
  workspaceId: WorkspaceId,
): Promise<RunRecoveryOutcome> {
  return recoverAbandonedRuns(database, links, {
    code: "workspace_access_revoked",
    kind: "workspace-deletion",
    message: "Workspace deletion was requested before the Run reached a terminal event",
    workspaceId,
  });
}

function lostExecutionRecovery(facts: {
  readonly expired: boolean;
  readonly restarted: boolean;
  readonly runStatus: RunRow["status"];
  readonly sessionStatus: ProviderSessionTable["status"];
}): { readonly mayRequeue: boolean; readonly failure: RunFailure } {
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
