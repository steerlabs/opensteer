import { randomUUID } from "node:crypto";
import {
  ThreadAccessModeSchema,
  type AgentSessionId,
  type CommandId,
  type EnvironmentId,
  type MessageId,
  type RequestId,
  type RunId,
  type RunnerId,
  type ThreadAccessMode,
  type ThreadId,
  type TriggerId,
  type TriggerOccurrenceId,
  type TriggerWatchActivationId,
  type UserId,
} from "@opensteer/core";
import { sql, type Kysely } from "kysely";
import { cancelPending } from "./request-cancellation.js";
import { commitPersonalMutation } from "./personal-mutation.js";
import type { DatabaseSchema } from "./schema.js";

export interface ConnectionCleanup {
  readonly connectionId: string;
  readonly userId: UserId;
  readonly pending: boolean;
  readonly minimumGrantRevision: number | undefined;
  readonly reason: "revoked" | "expired" | "narrowed";
}

/** A stop target, or a terminal attempt retained as evidence of contact loss. */
export interface ConnectionAttempt<Kind extends string = string, Id extends string = string> {
  readonly kind: Kind;
  readonly id: Id;
  readonly generation: number | null;
  readonly threadId: ThreadId | null;
  readonly environmentId: EnvironmentId | null;
  readonly runnerId: RunnerId | null;
  readonly runnerBootId: string | null;
  readonly handedOff: boolean;
  readonly terminalEvidenceAt: Date | null;
  readonly contactLostAt: Date | null;
}
export type LineageAttempt =
  | ConnectionAttempt<"run", RunId>
  | (ConnectionAttempt<"run-attempt"> & { readonly runId: RunId })
  | ConnectionAttempt<"occurrence", TriggerOccurrenceId>
  | ConnectionAttempt<"watch", TriggerWatchActivationId>
  | ConnectionAttempt<"input", MessageId>
  | ConnectionAttempt<"request", RequestId>
  | ConnectionAttempt<"steer", CommandId>
  | ConnectionAttempt<"trigger", TriggerId>
  | ConnectionAttempt<"session", AgentSessionId>
  | ConnectionAttempt<"plugin" | "operation" | "standard-cdp">;

export interface ConnectionAttemptStopper {
  stop(attempt: LineageAttempt, cleanup: ConnectionCleanup): Promise<void>;
}

/** The same set drives the worker, the connection's state and Remove. */
export async function connectionAttempts(
  database: Kysely<DatabaseSchema>,
  connectionId: string,
): Promise<readonly LineageAttempt[]> {
  const belowFloor = (revision: string, mode: string) => {
    const modes = sql`${ThreadAccessModeSchema.options}::text[]`;
    return sql`(f.disconnected or ${sql.ref(revision)} < f.cleanup_minimum_grant_revision
      or (${sql.ref(revision)} = f.cleanup_minimum_grant_revision
        and array_position(${modes}, ${sql.ref(mode)}) > array_position(${modes}, f.cleanup_maximum_mode)))`;
  };
  const { rows } = await sql<LineageAttempt>`
    with floor as (
      select *, revoked_at is not null or expires_at <= now() as disconnected
      from agent_connections where id = ${connectionId}
    ),
    lineage_runs as (
      select r.*, t.origin_connection_id as task_connection_id
      from runs r join threads t on t.id = r.thread_id
      join floor f on f.id = coalesce(r.connection_id, t.origin_connection_id)
    ),
    lineage_occurrences as (
      select o.*, t.anchor_thread_id
      from trigger_occurrences o join triggers t on t.id = o.trigger_id
      join floor f on f.id = coalesce(o.connection_id, t.origin_connection_id)
    ),
    lineage_watches as (
      select w.* from trigger_watch_activations w join triggers t on t.id = w.trigger_id
      join floor f on f.id = coalesce(w.connection_id, t.origin_connection_id)
    ),
    held_attempts as (
      select a.*, r.thread_id, r.environment_id
      from run_attempts a join lineage_runs r on r.id = a.run_id cross join floor f
      where (a.admitted_grant_revision is not null or a.first_event_at is not null)
        and ${belowFloor("a.admitted_grant_revision", "a.admitted_access_mode")}
        and (a.terminal_evidence_at is null or a.contact_lost_at is not null)
    ),
    eligible_threads as (
      select t.id from threads t cross join floor f
      where not f.disconnected and (
        f.grant->>'scope' = 'everything' or
        (f.grant->>'tasks' = 'true' and t.origin_connection_id = f.id)
      )
    ),
    attempts as (
      select 'run-attempt' as kind, a.id, a.binding_generation as generation,
        a.thread_id, a.environment_id, a.runner_id, a.runner_boot_id, true as handed_off,
        a.terminal_evidence_at, a.contact_lost_at, a.run_id
      from held_attempts a
      union all
      select 'run', r.id, r.binding_generation,
        r.thread_id, r.environment_id, null, null, r.status in ('running','waiting'),
        null, null, null
      from lineage_runs r cross join floor f
      where r.status in ('queued','starting','running','waiting')
        and not exists (select 1 from held_attempts a where a.run_id = r.id
          and a.binding_generation = r.binding_generation)
        and (f.disconnected or r.thread_id not in (select id from eligible_threads))
      union all
      select 'occurrence', o.id, o.execution_generation,
        o.anchor_thread_id, o.environment_id, o.runner_id, o.runner_boot_id, o.runner_id is not null,
        o.terminal_evidence_at, o.contact_lost_at, null
      from lineage_occurrences o cross join floor f
      where (o.status in ('pending','running') or
        (o.runner_id is not null and (o.terminal_evidence_at is null or o.contact_lost_at is not null)))
        and (${belowFloor("o.admitted_grant_revision", "o.admitted_access_mode")}
          or (o.status = 'pending' and o.anchor_thread_id not in (select id from eligible_threads)))
      union all
      select 'watch', w.id, w.execution_generation::double precision,
        w.anchor_thread_id, w.environment_id, w.runner_id, w.runner_boot_id, w.runner_id is not null,
        w.terminal_evidence_at, w.contact_lost_at, null
      from lineage_watches w cross join floor f
      where (w.desired = 'active' or
        (w.runner_id is not null and (w.terminal_evidence_at is null or w.contact_lost_at is not null)))
        and (${belowFloor("w.admitted_grant_revision", "w.admitted_access_mode")}
          or w.anchor_thread_id not in (select id from eligible_threads))
      union all
      select 'input', i.message_id, null, i.thread_id, null, null, null, false, null, null, null
      from thread_inputs i join threads t on t.id = i.thread_id
      join floor f on f.id = coalesce(i.connection_id, t.origin_connection_id)
      where i.state in ('pending','awaiting-approval') and i.run_id is null
        and not exists (select 1 from runs r where r.seed_input_id = i.message_id and r.status = 'queued')
        and (f.disconnected or i.thread_id not in (select id from eligible_threads))
      union all
      select 'steer', c.id, r.binding_generation, r.thread_id, r.environment_id,
        null, null, c.status <> 'pending', null, null, null
      from commands c join lineage_runs r on r.id = c.run_id cross join floor f
      where c.type = 'run.steer' and c.status = 'pending'
        and ${belowFloor("r.admitted_grant_revision", "r.admitted_access_mode")}
      union all
      select 'request', q.id, null, q.originating_thread_id, null, null, null, false, null, null, null
      from requests q join threads t on t.id = q.originating_thread_id
      left join lineage_runs r on r.id = q.originating_run_id
      left join lineage_occurrences o on o.id = q.originating_occurrence_id
      left join lineage_watches w on w.id = q.originating_watch_activation_id
      left join agent_sessions s on s.id = q.originating_agent_session_id
      cross join floor f
      where q.status = 'pending' and (
        r.id is not null or o.id is not null or w.id is not null or s.connection_id = f.id
        or (q.originating_run_id is null and q.originating_occurrence_id is null
          and q.originating_watch_activation_id is null and q.originating_agent_session_id is null
          and t.origin_connection_id = f.id)
      ) and (f.disconnected or
        coalesce(r.admitted_grant_revision, o.admitted_grant_revision, w.admitted_grant_revision)
          < f.cleanup_minimum_grant_revision)
      union all
      select 'trigger', t.id, null, t.anchor_thread_id, null, null, null, false, null, null, null
      from triggers t join floor f on f.id = t.origin_connection_id
      where t.status = 'active' and f.disconnected
      union all
      select 'plugin', p.id, null, p.thread_id, null, null, null,
        p.connection_id is not null or p.handoff, p.terminal_evidence_at, p.contact_lost_at, null
      from plugin_executions p
      left join lineage_runs r on r.id = p.run_id
      left join lineage_occurrences o on o.id = p.occurrence_id
      left join lineage_watches w on w.id = p.watch_activation_id
      left join agent_sessions s on s.id = p.agent_session_id
      cross join floor f
      where (p.terminal_evidence_at is null or p.contact_lost_at is not null)
        and (p.connection_id = f.id or (p.connection_id is null
          and p.state in ('running','waiting','answered')
          and (r.id is not null or o.id is not null or w.id is not null or s.connection_id = f.id)))
        and (${belowFloor("p.admitted_grant_revision", "p.admitted_access_mode")} or
          (p.connection_id is null and
            coalesce(r.admitted_grant_revision, o.admitted_grant_revision, w.admitted_grant_revision)
              < f.cleanup_minimum_grant_revision))
      union all
      select 'session', s.id, null, s.thread_id, null, null, null, false, null, null, null
      from agent_sessions s join floor f on f.id = s.connection_id
      where s.status = 'active' and f.disconnected
      union all
      select 'operation', o.id, null, s.thread_id, null, null, null,
        o.handed_off_at is not null, null,
        case when o.outcome = 'unknown' then o.completed_at end, null
      from agent_operations o join floor f on f.id = o.connection_id
      join agent_sessions s on s.id = o.session_id
      where (o.outcome is null or (o.outcome = 'unknown' and o.handed_off_at is not null))
        and ${belowFloor("o.grant_revision", "o.mode")}
    )
    select * from attempts order by kind, id
  `.execute(database);
  return rows;
}

export function outstandingAttempts(attempts: readonly LineageAttempt[]) {
  return attempts.filter((attempt) => attempt.terminalEvidenceAt === null);
}

/** Expiry and pre-record revocations use the same sorted, per-connection claim. */
export async function requestExpiredCleanups(
  database: Kysely<DatabaseSchema>,
  now = new Date(),
): Promise<void> {
  const candidates = await database
    .selectFrom("agentConnections")
    .select(["id", "revokedAt"])
    .where((eb) => eb.or([eb("revokedAt", "is not", null), eb("expiresAt", "<=", now)]))
    .where((eb) => eb.or([eb("cleanupReason", "is", null), eb("cleanupReason", "=", "narrowed")]))
    .orderBy("id")
    .execute();
  for (const candidate of candidates)
    await commitPersonalMutation(database, async (tx) => {
      const row = await tx
        .selectFrom("agentConnections")
        .select(["id", "revokedAt", "expiresAt", "cleanupReason"])
        .where("id", "=", candidate.id)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!row || (row.cleanupReason && row.cleanupReason !== "narrowed")) return;
      if (row.revokedAt === null && row.expiresAt > now) return;
      await tx
        .updateTable("agentConnections")
        .set({
          cleanupReason: row.revokedAt ? "revoked" : "expired",
          cleanupRequestedAt: row.revokedAt ?? now,
          cleanupCompletedAt: null,
        })
        .where("id", "=", row.id)
        .execute();
    });
}

export async function openCleanups(database: Kysely<DatabaseSchema>): Promise<ConnectionCleanup[]> {
  const rows = await database
    .selectFrom("agentConnections")
    .select(["userId", "id as connectionId", "cleanupReason as reason", "cleanupMinimumGrantRevision"])
    .select(sql<boolean>`cleanup_completed_at is null`.as("pending"))
    .where("cleanupRequestedAt", "is not", null)
    .where("cleanupReason", "is not", null)
    .$narrowType<{ reason: NonNullable<ConnectionCleanup["reason"]> }>()
    .orderBy("cleanupRequestedAt")
    .orderBy("id")
    .execute();
  return rows.map(({ cleanupMinimumGrantRevision, ...row }) => ({
    ...row, minimumGrantRevision: cleanupMinimumGrantRevision ?? undefined,
  }));
}

const cleanupClaimDurationMs = 30_000;

export async function claimConnectionCleanup(
  database: Kysely<DatabaseSchema>, connectionId: string,
): Promise<string | null> {
  const token = randomUUID();
  const now = new Date();
  const result = await database.updateTable("agentConnections")
    .set({ cleanupClaimToken: token, cleanupClaimExpiresAt: new Date(now.getTime() + cleanupClaimDurationMs) })
    .where("id", "=", connectionId)
    .where("removedAt", "is", null)
    .where((eb) => eb.or([
      eb("cleanupClaimExpiresAt", "is", null),
      eb("cleanupClaimExpiresAt", "<=", now),
    ]))
    .executeTakeFirst();
  return result.numUpdatedRows === 1n ? token : null;
}

export async function renewConnectionCleanupClaim(
  database: Kysely<DatabaseSchema>, connectionId: string, token: string,
): Promise<boolean> {
  const result = await database.updateTable("agentConnections")
    .set({ cleanupClaimExpiresAt: new Date(Date.now() + cleanupClaimDurationMs) })
    .where("id", "=", connectionId)
    .where("cleanupClaimToken", "=", token)
    .executeTakeFirst();
  return result.numUpdatedRows === 1n;
}

export async function releaseConnectionCleanupClaim(
  database: Kysely<DatabaseSchema>, connectionId: string, token: string,
): Promise<void> {
  await database.updateTable("agentConnections")
    .set({ cleanupClaimToken: null, cleanupClaimExpiresAt: null })
    .where("id", "=", connectionId)
    .where("cleanupClaimToken", "=", token)
    .execute();
}

export async function completeCleanupIfSettled(
  database: Kysely<DatabaseSchema>,
  connectionId: string,
  token: string,
): Promise<boolean> {
  return commitPersonalMutation(database, async (tx) => {
    const connection = await tx
      .selectFrom("agentConnections")
      .select(["cleanupRequestedAt", "cleanupCompletedAt", "lastActionUncertainAt", "acknowledgedUncertaintyAt"])
      .where("id", "=", connectionId)
      .where("cleanupClaimToken", "=", token)
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (!connection?.cleanupRequestedAt) return false;
    const attempts = await connectionAttempts(tx, connectionId);
    const latest = attempts.reduce<LineageAttempt | undefined>((previous, attempt) =>
      attempt.contactLostAt && (!previous || attempt.contactLostAt > previous.contactLostAt!)
        ? attempt : previous, undefined);
    if (latest?.contactLostAt &&
      (!connection.acknowledgedUncertaintyAt || latest.contactLostAt > connection.acknowledgedUncertaintyAt) &&
      (!connection.lastActionUncertainAt || latest.contactLostAt > connection.lastActionUncertainAt)) {
      await tx.updateTable("agentConnections").set({
        lastActionUncertainAt: latest.contactLostAt,
        lastActionUncertain: {
          attemptId: latest.id,
          generation: latest.generation,
          taskId: latest.threadId,
          reason: "The computer disconnected before confirming that this attempt ended.",
        },
      }).where("id", "=", connectionId).execute();
    }
    const outstanding = outstandingAttempts(attempts);
    if (outstanding.length) {
      if (connection.cleanupCompletedAt)
        await tx
          .updateTable("agentConnections")
          .set({ cleanupCompletedAt: null })
          .where("id", "=", connectionId)
          .execute();
      return false;
    }
    if (connection.cleanupCompletedAt) return false;
    const result = await tx
      .updateTable("agentConnections")
      .set({ cleanupCompletedAt: new Date() })
      .where("id", "=", connectionId)
      .where("cleanupCompletedAt", "is", null)
      .executeTakeFirst();
    return result.numUpdatedRows === 1n;
  });
}

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
      cancelHandedOffPlugins: false,
    }),
  );
}

export async function recordConnectionRunHandoff(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly runId: RunId;
    readonly bindingGeneration: number;
    readonly connectionId: string;
    readonly grantRevision: number;
    readonly mode: ThreadAccessMode;
  },
): Promise<void> {
  await commitPersonalMutation(database, async (tx) => {
    const connection = await tx.selectFrom("agentConnections")
      .select(["grantRevision", "revokedAt", "expiresAt"])
      .where("id", "=", input.connectionId).forShare().executeTakeFirst();
    if (!connection || connection.revokedAt || connection.expiresAt <= new Date() ||
      connection.grantRevision !== input.grantRevision)
      throw new Error("The agent connection changed before this Run could be sent");
    const witness = {
      admittedGrantRevision: input.grantRevision,
      admittedAccessMode: input.mode,
    };
    const updated = await tx.updateTable("runs").set(witness)
      .where("id", "=", input.runId)
      .where("connectionId", "=", input.connectionId)
      .where("bindingGeneration", "=", input.bindingGeneration)
      .where("status", "=", "starting")
      .executeTakeFirst();
    if (updated.numUpdatedRows !== 1n)
      throw new Error("The Run binding changed before it could be sent");
    const attempt = await tx.updateTable("runAttempts")
      .set({ ...witness, connectionId: input.connectionId })
      .where("runId", "=", input.runId)
      .where("bindingGeneration", "=", input.bindingGeneration)
      .executeTakeFirst();
    if (attempt.numUpdatedRows !== 1n)
      throw new Error("The Run attempt disappeared before it could be sent");
  });
}

export async function markConnectionAttemptsContactLost(
  database: Kysely<DatabaseSchema>,
  input: { readonly runnerId: RunnerId; readonly runnerBootId: string },
): Promise<void> {
  await commitPersonalMutation(database, async (tx) => {
    const now = new Date();
    for (const table of ["triggerOccurrences", "triggerWatchActivations", "runAttempts"] as const) {
      await tx.updateTable(table)
        .set({ contactLostAt: now })
        .where("connectionId", "is not", null)
        .where("runnerId", "=", input.runnerId)
        .where("runnerBootId", "=", input.runnerBootId)
        .where("terminalEvidenceAt", "is", null)
        .where("contactLostAt", "is", null)
        .execute();
    }
  });
}
