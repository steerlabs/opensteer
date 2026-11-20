import {
  nonTerminalRunStatuses,
  type AgentSessionId,
  type CommandId,
  type MessageId,
  type RequestId,
  type RunId,
  type ThreadId,
  type TriggerId,
  type UserId,
} from "@opensteer/core";
import { sql, type Kysely } from "kysely";
import { cancelPending } from "./request-cancellation.js";
import { commitPersonalMutation } from "./personal-mutation.js";
import type { DatabaseSchema } from "./schema.js";

/** Everything in a connection's lineage that could still act, read after its decision committed. */
export interface ConnectionLineageWork {
  readonly runs: readonly {
    readonly id: RunId;
    readonly threadId: ThreadId;
    /** The task itself is in the lineage; otherwise it is the person's, and keeps its queue. */
    readonly lineageTask: boolean;
  }[];
  readonly inputs: readonly { readonly messageId: MessageId; readonly threadId: ThreadId }[];
  readonly requests: readonly RequestId[];
  readonly triggers: readonly TriggerId[];
  /** Messages steered into a lineage Run that no Runner has taken yet. */
  readonly steers: readonly CommandId[];
  /** Lineage automations with occurrences that have not reached a computer. */
  readonly pendingOccurrenceTriggers: readonly TriggerId[];
  /** The connection's active direct-work sessions. */
  readonly sessions: readonly AgentSessionId[];
}

export async function connectionLineageWork(
  database: Kysely<DatabaseSchema>,
  userId: UserId,
  connectionId: string,
): Promise<ConnectionLineageWork> {
  const inLineage = (thread: "threads") =>
    database
      .selectFrom(thread)
      .select("id")
      .where("createdBy", "=", userId)
      .where("originConnectionId", "=", connectionId);
  const [runs, inputs, requests, triggers, steers, pendingOccurrenceTriggers, sessions] =
    await Promise.all([
    database
      .selectFrom("runs")
      .innerJoin("threads", "threads.id", "runs.threadId")
      .select(["runs.id", "runs.threadId", "threads.originConnectionId"])
      .where("runs.requestedBy", "=", userId)
      .where("runs.status", "in", nonTerminalRunStatuses)
      .where((eb) =>
        eb.or([
          eb("runs.connectionId", "=", connectionId),
          eb("threads.originConnectionId", "=", connectionId),
        ]),
      )
      .orderBy("runs.id")
      .execute(),
    database
      .selectFrom("threadInputs")
      .select(["messageId", "threadId"])
      .where("requestedBy", "=", userId)
      .where("state", "in", ["pending", "awaiting-approval"])
      .where("runId", "is", null)
      .where((eb) =>
        eb.or([eb("connectionId", "=", connectionId), eb("threadId", "in", inLineage("threads"))]),
      )
      // A queued Run already owns its seed; interrupting that Run settles it.
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom("runs")
              .select("runs.id")
              .whereRef("runs.seedInputId", "=", "threadInputs.messageId")
              .where("runs.status", "=", "queued"),
          ),
        ),
      )
      .orderBy("messageId")
      .execute(),
    database
      .selectFrom("requests")
      .select("id")
      .where("requestedBy", "=", userId)
      .where("status", "=", "pending")
      .where((eb) =>
        eb.or([
          eb("originatingThreadId", "in", inLineage("threads")),
          eb(
            "originatingRunId",
            "in",
            database.selectFrom("runs").select("runs.id").where("connectionId", "=", connectionId),
          ),
        ]),
      )
      .orderBy("id")
      .execute(),
    database
      .selectFrom("triggers")
      .select("id")
      .where("createdBy", "=", userId)
      .where("originConnectionId", "=", connectionId)
      .where("status", "=", "active")
      .orderBy("id")
      .execute(),
    database
      .selectFrom("commands")
      .innerJoin("runs", "runs.id", "commands.runId")
      .innerJoin("threads", "threads.id", "runs.threadId")
      .select("commands.id")
      .where("commands.requestedBy", "=", userId)
      .where("commands.type", "=", "run.steer")
      .where("commands.status", "=", "pending")
      .where((eb) =>
        eb.or([
          eb("runs.connectionId", "=", connectionId),
          eb("threads.originConnectionId", "=", connectionId),
        ]),
      )
      .orderBy("commands.id")
      .execute(),
    database
      .selectFrom("triggers")
      .select("triggers.id")
      .where("triggers.createdBy", "=", userId)
      .where("triggers.originConnectionId", "=", connectionId)
      .where(({ exists, selectFrom }) =>
        exists(
          selectFrom("triggerOccurrences")
            .select("triggerOccurrences.id")
            .whereRef("triggerOccurrences.triggerId", "=", "triggers.id")
            .where("triggerOccurrences.status", "=", "pending"),
        ),
      )
      .orderBy("triggers.id")
      .execute(),
    database
      .selectFrom("agentSessions")
      .select("id")
      .where("userId", "=", userId)
      .where("connectionId", "=", connectionId)
      .where("status", "=", "active")
      .orderBy("id")
      .execute(),
  ]);
  return {
    runs: runs.map((run) => ({
      id: run.id,
      threadId: run.threadId,
      lineageTask: run.originConnectionId === connectionId,
    })),
    inputs,
    requests: requests.map(({ id }) => id),
    triggers: triggers.map(({ id }) => id),
    steers: steers.map(({ id }) => id),
    pendingOccurrenceTriggers: pendingOccurrenceTriggers.map(({ id }) => id),
    sessions: sessions.map(({ id }) => id),
  };
}

/** Run failures that mean the Home lost contact with the engine mid-effect. */
const lostContactCodes = [
  "execution_binding_expired",
  "runner_disconnected",
  "runner_restarted",
  "runner_state_lost",
] as const;

/** Expired connections get the same durable cleanup record a Disconnect commits. */
export async function requestExpiredCleanups(
  database: Kysely<DatabaseSchema>,
  now = new Date(),
): Promise<void> {
  await database
    .updateTable("agentConnections")
    .set({ cleanupReason: "expired", cleanupRequestedAt: now })
    .where("revokedAt", "is", null)
    .where("expiresAt", "<=", now)
    .where("cleanupRequestedAt", "is", null)
    .execute();
}

/** Every cleanup not yet complete: the set a worker, and Host startup, drives to completion. */
export async function openCleanups(
  database: Kysely<DatabaseSchema>,
): Promise<readonly { readonly userId: UserId; readonly connectionId: string }[]> {
  return database
    .selectFrom("agentConnections")
    .select(["userId", "id as connectionId"])
    .where("cleanupRequestedAt", "is not", null)
    .where("cleanupCompletedAt", "is", null)
    .orderBy("cleanupRequestedAt")
    .orderBy("id")
    .execute();
}

export interface LineageOutstanding {
  /** Execution that may have left the Home and has not reported its end. */
  readonly handedOff: number;
  /** Work still at the Home: queued Runs and inputs, open Requests, active automations. */
  readonly waiting: number;
}

/** What a connection's lineage still holds, read in one statement. */
export async function lineageOutstanding(
  database: Kysely<DatabaseSchema>,
  connectionId: string,
): Promise<LineageOutstanding> {
  const { rows } = await sql<{ handedOff: string; waiting: string }>`
    with lineage_threads as (select id from threads where origin_connection_id = ${connectionId}),
    lineage_triggers as (select id from triggers where origin_connection_id = ${connectionId})
    select
      (select count(*) from runs
        where (connection_id = ${connectionId} or thread_id in (select id from lineage_threads))
          and status in ('starting', 'running', 'waiting'))
      + (select count(*) from trigger_occurrences
          where trigger_id in (select id from lineage_triggers) and status = 'running')
      + (select count(*) from trigger_watch_activations
          where trigger_id in (select id from lineage_triggers) and observed = 'running')
      + (select count(*) from agent_operations
          where connection_id = ${connectionId} and state = 'handed-off')
        as handed_off,
      (select count(*) from runs
        where (connection_id = ${connectionId} or thread_id in (select id from lineage_threads))
          and status = 'queued')
      + (select count(*) from thread_inputs
          where (connection_id = ${connectionId} or thread_id in (select id from lineage_threads))
            and state in ('pending', 'awaiting-approval') and run_id is null)
      + (select count(*) from requests
          where originating_thread_id in (select id from lineage_threads) and status = 'pending')
      + (select count(*) from triggers
          where origin_connection_id = ${connectionId} and status = 'active')
      + (select count(*) from trigger_occurrences
          where trigger_id in (select id from lineage_triggers) and status = 'pending')
      + (select count(*) from agent_sessions
          where connection_id = ${connectionId} and status = 'active')
      + (select count(*) from agent_operations
          where connection_id = ${connectionId} and state in ('admitted', 'pending', 'approved'))
        as waiting
  `.execute(database);
  const row = rows[0];
  if (!row) throw new Error("Lineage outstanding count returned no row");
  return { handedOff: Number(row.handedOff), waiting: Number(row.waiting) };
}

/**
 * Settles a cleanup once nothing is outstanding, recording what the person should check when the
 * Home lost contact with an execution after authority ended.
 */
export async function completeCleanupIfSettled(
  database: Kysely<DatabaseSchema>,
  connectionId: string,
): Promise<boolean> {
  const outstanding = await lineageOutstanding(database, connectionId);
  if (outstanding.handedOff || outstanding.waiting) return false;
  const connection = await database
    .selectFrom("agentConnections")
    .select("cleanupRequestedAt")
    .where("id", "=", connectionId)
    .executeTakeFirst();
  if (!connection?.cleanupRequestedAt) return false;
  const lost = await database
    .selectFrom("runs")
    .innerJoin("threads", "threads.id", "runs.threadId")
    .select([
      "runs.id",
      "runs.threadId",
      "threads.title",
      "runs.completedAt",
      sql<string | null>`(
        select runners.name from run_attempts join runners on runners.id = run_attempts.runner_id
        where run_attempts.run_id = runs.id order by run_attempts.ordinal desc limit 1
      )`.as("deviceName"),
      sql<string>`runs.failure->>'code'`.as("code"),
    ])
    .where((eb) =>
      eb.or([
        eb("runs.connectionId", "=", connectionId),
        eb("threads.originConnectionId", "=", connectionId),
      ]),
    )
    .where("runs.status", "=", "failed")
    .where("runs.completedAt", ">=", connection.cleanupRequestedAt)
    .where(sql<string>`runs.failure->>'code'`, "in", [...lostContactCodes])
    .orderBy("runs.completedAt", "desc")
    .executeTakeFirst();
  // A direct operation that left the Home and never reported how it ended.
  const unknown = await database
    .selectFrom("agentOperations")
    .innerJoin("agentSessions", "agentSessions.id", "agentOperations.sessionId")
    .innerJoin("threads", "threads.id", "agentSessions.threadId")
    .select([
      "agentOperations.id",
      "agentOperations.tool",
      "agentOperations.target",
      "agentOperations.completedAt",
      "agentSessions.threadId",
      "threads.title",
    ])
    .where("agentOperations.connectionId", "=", connectionId)
    .where("agentOperations.outcome", "=", "unknown")
    .where("agentOperations.completedAt", ">=", connection.cleanupRequestedAt)
    .orderBy("agentOperations.completedAt", "desc")
    .executeTakeFirst();
  const uncertain =
    unknown &&
    (!lost || (unknown.completedAt?.getTime() ?? 0) >= (lost.completedAt?.getTime() ?? 0))
      ? {
          at: unknown.completedAt ?? new Date(),
          fact: {
            kind: "operation",
            operationId: unknown.id,
            taskId: unknown.threadId,
            task: unknown.title,
            tool: unknown.tool,
            target: unknown.target.name,
            device: unknown.target.device?.name ?? null,
            reason: "contact-lost",
          },
        }
      : lost
        ? {
            at: lost.completedAt ?? new Date(),
            fact: {
              kind: "run",
              runId: lost.id,
              taskId: lost.threadId,
              task: lost.title,
              device: lost.deviceName,
              reason: lost.code,
            },
          }
        : null;
  await database
    .updateTable("agentConnections")
    .set({
      cleanupCompletedAt: new Date(),
      ...(uncertain
        ? { lastActionUncertainAt: uncertain.at, lastActionUncertain: uncertain.fact }
        : {}),
    })
    .where("id", "=", connectionId)
    .where("cleanupCompletedAt", "is", null)
    .execute();
  return true;
}

/** Settles a lineage's pending Requests by id: nothing it asked for can be answered any more. */
export async function settleLineageRequests(
  database: Kysely<DatabaseSchema>,
  requestIds: readonly RequestId[],
): Promise<void> {
  if (!requestIds.length) return;
  await commitPersonalMutation(database, (tx) =>
    cancelPending(tx, {
      reason: "authority-revoked",
      resolvedAt: new Date(),
      requestIds,
      cancelHandedOffPlugins: true,
    }),
  );
}
