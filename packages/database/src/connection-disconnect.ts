import { createHash, randomUUID } from "node:crypto";
import {
  AgentGrantSchema,
  OpensteerError,
  CommandIdSchema,
  ThreadAccessModeSchema,
  agentGrantAccess,
  type AgentOperationId,
  type AgentOperationTarget,
  type AgentSessionId,
  type BrowserSessionId,
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
import type { StandardCdpAttemptReconciliation } from "@opensteer/protocol/standard-cdp";
import { sql, type Kysely } from "kysely";
import { cancelPending } from "./request-cancellation.js";
import { senderUnlinkedFailure } from "./bridge-admission.js";
import { commitPersonalMutation } from "./personal-mutation.js";
import { publishThreadSummary } from "./thread-status.js";
import type { DatabaseSchema } from "./schema.js";
import {
  chatEndReason,
  chatEndedUnrevoked,
  connectionActive,
  connectionState,
  liveConnection,
} from "./connection-liveness.js";
import { ConnectionWaiting } from "./resource-access.js";

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
  | ConnectionAttempt<"operation", AgentOperationId>
  | (ConnectionAttempt<"standard-cdp"> & {
      readonly standardCdpRecovery?: StandardCdpAttemptReconciliation;
    })
  | ConnectionAttempt<"plugin" | "shared-chrome">
  /** A message to a bridge's chat: written before it is sent, its status is its evidence. */
  | ConnectionAttempt<"chat">
  /** A command acting outside the database (G4): written before it acts, settled after. */
  | ConnectionAttempt<"command">;

export interface ConnectionAttemptStopper {
  stop(
    attempt: LineageAttempt,
    cleanup: ConnectionCleanup,
  ): Promise<void | "ended" | "contact-lost">;
  stopDirectOperation?(
    attempt: ConnectionAttempt<"operation", AgentOperationId>,
    cleanup: ConnectionCleanup,
  ): Promise<void>;
}

export function connectionStopId(attempt: LineageAttempt): CommandId {
  const hash = createHash("sha256")
    .update(JSON.stringify([attempt.kind, attempt.id, attempt.generation]))
    .digest("hex");
  return CommandIdSchema.parse(
    `cmd_${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`,
  );
}

/** The same set drives the worker, the connection's state and Remove. */
export async function connectionAttempts(
  database: Kysely<DatabaseSchema>,
  connectionId: string,
): Promise<readonly LineageAttempt[]> {
  const belowFloor = (
    revision: string | ReturnType<typeof sql>,
    mode: string | ReturnType<typeof sql>,
  ) => {
    const modes = sql`${ThreadAccessModeSchema.options}::text[]`;
    return sql`(f.disconnected or ${typeof revision === "string" ? sql.ref(revision) : revision} < f.cleanup_minimum_grant_revision
      or (${typeof revision === "string" ? sql.ref(revision) : revision} = f.cleanup_minimum_grant_revision
        and array_position(${modes}, ${typeof mode === "string" ? sql.ref(mode) : mode}) > array_position(${modes}, f.cleanup_maximum_mode)))`;
  };
  const runHandoff = sql`(a.admitted_grant_revision is not null or a.first_event_at is not null)`;
  const { rows } = await sql<
    LineageAttempt & {
      readonly disconnected: boolean;
      readonly recovery: StandardCdpAttemptReconciliation | null;
      readonly grant: unknown;
      readonly sessionTargets:
        readonly { grant: AgentOperationTarget["grant"]; effect: string }[] | null;
    }
  >`
    with floor as (
      select *, revoked_at is not null
        or (bridge_account_id is null and expires_at <= now()) as disconnected
      from agent_connections where id = ${connectionId}
    ),
    lineage_runs as (
      select r.* from runs r join floor f on f.id = r.connection_id
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
      where ${runHandoff}
        and ${belowFloor("a.admitted_grant_revision", "a.admitted_access_mode")}
        and (a.terminal_evidence_at is null or a.contact_lost_at is not null)
    ),
    eligible_threads as (
      select t.id from threads t cross join floor f
      where not f.disconnected and (
        (f.grant->>'scope' = 'everything' and t.origin_connection_id is null) or
        t.origin_connection_id = f.id
      )
    ),
    cdp_attempts as (
      select c.id, c.witness, b.runner_id
      from browser_sessions b
      cross join lateral jsonb_each(b.standard_cdp_attempts) c(id, witness)
      join floor f on f.id = c.witness->>'connectionId'
      where b.standard_cdp_attempts <> '{}'
        and (f.disconnected or (c.witness->>'grantRevision')::integer < f.cleanup_minimum_grant_revision)
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
        and not exists (select 1 from run_attempts a where a.run_id = r.id
          and a.binding_generation = r.binding_generation and ${runHandoff})
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
      select 'occurrence', a.occurrence_id, a.execution_generation,
        t.anchor_thread_id, o.environment_id, a.runner_id, a.runner_boot_id, true,
        a.terminal_evidence_at, a.contact_lost_at, null
      from trigger_occurrence_attempts a join floor f on f.id = a.connection_id
      join trigger_occurrences o on o.id = a.occurrence_id join triggers t on t.id = o.trigger_id
      where ${belowFloor("a.admitted_grant_revision", "a.admitted_access_mode")}
        and (a.terminal_evidence_at is null or a.contact_lost_at is not null)
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
      from thread_inputs i
      join threads t on t.id = i.thread_id
      cross join floor f
      where i.state in ('pending', 'awaiting-approval') and i.run_id is null
        and (i.connection_id = f.id or (f.disconnected and t.origin_connection_id = f.id))
        and not exists (select 1 from runs r where r.seed_input_id = i.message_id and r.status = 'queued')
        and (f.disconnected or i.thread_id not in (select id from eligible_threads))
      union all
      select 'steer', c.id, r.binding_generation, r.thread_id, r.environment_id,
        null, null, c.status <> 'pending', null, null, null
      from commands c join lineage_runs r on r.id = c.run_id cross join floor f
      where c.type = 'run.steer'
        and (c.status = 'pending' or (c.status in ('dispatched','unknown')
          and exists (select 1 from held_attempts a where a.run_id = r.id
            and a.terminal_evidence_at is null)))
        and ${belowFloor("r.admitted_grant_revision", "r.admitted_access_mode")}
      union all
      select 'request', q.id, null, q.originating_thread_id, null, null, null, false, null, null, null
      from requests q join threads t on t.id = q.originating_thread_id
      left join lineage_runs r on r.id = q.originating_run_id
      left join lineage_occurrences o on o.id = q.originating_occurrence_id
      left join lineage_watches w on w.id = q.originating_watch_activation_id
      left join agent_sessions s on s.id = q.originating_agent_session_id
      left join agent_operations op on op.request_id = q.id
      cross join floor f
      where q.status = 'pending' and (
        r.id is not null or o.id is not null or w.id is not null or s.connection_id = f.id
        or (f.disconnected and t.origin_connection_id = f.id)
        or (q.originating_run_id is null and q.originating_occurrence_id is null
          and q.originating_watch_activation_id is null and q.originating_agent_session_id is null
          and t.origin_connection_id = f.id)
      ) and (f.disconnected or
        coalesce(r.admitted_grant_revision, o.admitted_grant_revision, w.admitted_grant_revision,
          op.grant_revision, (q.command->'proposer'->>'grantRevision')::integer)
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
          and (r.id is not null or o.id is not null or w.id is not null or s.connection_id = f.id)))
        and (${belowFloor("p.admitted_grant_revision", "p.admitted_access_mode")} or
          (p.admitted_grant_revision is null and f.cleanup_minimum_grant_revision is not null) or
          (p.connection_id is null and
            coalesce(r.admitted_grant_revision, o.admitted_grant_revision, w.admitted_grant_revision)
              < f.cleanup_minimum_grant_revision))
      union all
      select 'standard-cdp', c.id, null, (c.witness->>'threadId'), null, c.runner_id,
        null, true, (c.witness->>'terminalEvidenceAt')::timestamptz,
        (c.witness->>'contactLostAt')::timestamptz, null
      from cdp_attempts c
      union all
      select 'shared-chrome', c.id, null, c.witness->>'threadId', null, null,
        null, true, (c.witness->>'terminalEvidenceAt')::timestamptz,
        (c.witness->>'contactLostAt')::timestamptz, null
      from floor f cross join lateral jsonb_each(f.shared_chrome_attempts) c(id, witness)
      where ${belowFloor(sql`(c.witness->>'grantRevision')::integer`, sql`c.witness->>'mode'`)}
      union all
      -- A reply or notice to a disconnected bridge's chat: unsent ones are cancelled; one that
      -- may have left is unknown and counts as ended with contact lost, never sent again.
      select 'chat', d.id, null, c.thread_id, null, channel.runner_id, null,
        d.status = 'attempt-started',
        case when d.status in ('sent', 'dead', 'cancelled', 'unknown') then d.updated_at end,
        case when d.status = 'unknown' then d.updated_at end, null
      from bridge_deliveries d join floor f on f.id = d.bridge_id
      join bridge_conversations c on c.id = d.conversation_id
      join channel_accounts account on account.id = d.account_id
      join integration_connections channel on channel.id = account.connection_id
      where f.disconnected and (
        d.status in ('pending', 'leased', 'attempt-started', 'retryable-failed')
        or (d.status = 'unknown' and d.updated_at >= f.cleanup_requested_at))
      union all
      -- A command with an effect outside the database, acting now in this Home's process: its
      -- settled state is its evidence; one that may have acted is unknown, contact lost (G4). A
      -- narrowed grant waits on it as a Disconnect does, as it does on sessions (K4).
      select 'command', a.id, null, null, null, null, null, a.state = 'running',
        case when a.state <> 'running' then a.settled_at end,
        case when a.state = 'unknown' then a.settled_at end, null
      from command_attempts a join floor f on f.id = a.connection_id
      where (f.disconnected or f.cleanup_reason = 'narrowed') and (
        a.state = 'running' or (a.state = 'unknown' and a.settled_at >= f.cleanup_requested_at))
      union all
      select 'session', s.id, null, s.thread_id, null, null, null, false, null, null, null
      from agent_sessions s join floor f on f.id = s.connection_id
      where s.status = 'active' and (f.disconnected or f.cleanup_reason = 'narrowed')
      union all
      select 'operation', o.id, o.grant_revision, s.thread_id, null, null, null,
        o.handed_off_at is not null, o.terminal_evidence_at, o.contact_lost_at, null
      from agent_operations o join floor f on f.id = o.connection_id
      join agent_sessions s on s.id = o.session_id
      -- Its executor runs in this process: it ends when the executor returns or the process
      -- that handed it off is gone; a lost one stays only as evidence of contact loss.
      where (o.terminal_evidence_at is null or o.contact_lost_at is not null)
        and ${belowFloor("o.grant_revision", "o.mode")}
    )
    select attempts.*, floor.disconnected, cdp_attempts.witness->'recovery' as recovery,
      case when kind = 'session' and not floor.disconnected then floor.grant end as grant,
      case when kind = 'session' and not floor.disconnected then (
        select jsonb_agg(distinct jsonb_build_object('grant', o.target->'grant', 'effect', o.effect))
        from agent_operations o where o.session_id = attempts.id and o.state <> 'refused'
      ) end as session_targets
    from attempts cross join floor
    left join cdp_attempts on attempts.kind = 'standard-cdp' and cdp_attempts.id = attempts.id
    order by case when kind = 'session' then 0 else 1 end, kind, attempts.id
  `.execute(database);
  return rows.flatMap(({ disconnected, grant, sessionTargets, recovery, ...attempt }) => {
    if (attempt.kind === "standard-cdp" && recovery)
      return [{ ...attempt, standardCdpRecovery: recovery }];
    if (attempt.kind !== "session" || disconnected) return [attempt];
    const currentGrant = AgentGrantSchema.parse(grant);
    const withdrawn = sessionTargets?.some(({ grant: target, effect }) => {
      if (target.kind === "device") return false;
      const access = agentGrantAccess(currentGrant, target);
      return !access || (effect === "write" && access !== "read-write");
    });
    return withdrawn ? [attempt] : [];
  });
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
    .where((eb) =>
      eb.or([
        eb("revokedAt", "is not", null),
        eb.and([eb("bridgeAccountId", "is", null), eb("expiresAt", "<=", now)]),
        // A chat ends by what it is (its account, its computer, its grant), read by the one
        // state; no timer ends it.
        chatEndedUnrevoked(now),
      ]),
    )
    .where((eb) => eb.or([eb("cleanupReason", "is", null), eb("cleanupReason", "=", "narrowed")]))
    .orderBy("id")
    .execute();
  for (const candidate of candidates)
    await commitPersonalMutation(database, async (tx) => {
      const row = await tx
        .selectFrom("agentConnections")
        .select([
          "id",
          "revokedAt",
          "expiresAt",
          "bridgeAccountId",
          "cleanupReason",
          "grantRevision",
          chatEndedUnrevoked(now).as("accountEnded"),
        ])
        .where("id", "=", candidate.id)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!row || (row.cleanupReason && row.cleanupReason !== "narrowed")) return;
      if (row.accountEnded) {
        await tx
          .updateTable("agentConnections")
          .set({
            revokedAt: now,
            grantRevision: row.grantRevision + 1,
            cleanupReason: "revoked",
            cleanupRequestedAt: now,
            cleanupCompletedAt: null,
            // Why it ended, from the facts that ended it, read now.
            bridgeEndedBy: chatEndReason(),
          })
          .where("id", "=", row.id)
          .execute();
        const originated = await tx
          .selectFrom("threads")
          .select("id")
          .where("originConnectionId", "=", row.id)
          .where("removedAt", "is", null)
          .orderBy("id")
          .execute();
        for (const { id: threadId } of originated) await publishThreadSummary(tx, threadId);
        return;
      }
      if (connectionActive(row, now)) return;
      await tx
        .updateTable("agentConnections")
        .set({
          cleanupReason: row.revokedAt ? "revoked" : "expired",
          cleanupRequestedAt: row.revokedAt ?? now,
          cleanupCompletedAt: null,
        })
        .where("id", "=", row.id)
        .execute();
      const originated = await tx
        .selectFrom("threads")
        .select("id")
        .where("originConnectionId", "=", row.id)
        .where("removedAt", "is", null)
        .orderBy("id")
        .execute();
      for (const { id: threadId } of originated) await publishThreadSummary(tx, threadId);
    });
}

export async function openCleanups(database: Kysely<DatabaseSchema>): Promise<string[]> {
  // Removing a connection hides it; it never stops or skips its Disconnect.
  const rows = await database
    .selectFrom("agentConnections")
    .select("id")
    .where("cleanupRequestedAt", "is not", null)
    .where((eb) => eb.or([eb("removedAt", "is", null), eb("cleanupCompletedAt", "is", null)]))
    .orderBy("cleanupRequestedAt")
    .orderBy("id")
    .execute();
  return rows.map(({ id }) => id);
}

export interface ConnectionCleanupClaim extends ConnectionCleanup {
  readonly token: string;
  readonly grantRevision: number;
}

const cleanupClaimDurationMs = 30_000;

export async function claimConnectionCleanup(
  database: Kysely<DatabaseSchema>,
  connectionId: string,
): Promise<ConnectionCleanupClaim | null> {
  const token = randomUUID();
  const now = new Date();
  const result = await database
    .updateTable("agentConnections")
    .set({
      cleanupClaimToken: token,
      cleanupClaimExpiresAt: new Date(now.getTime() + cleanupClaimDurationMs),
    })
    .where("id", "=", connectionId)
    .where((eb) =>
      eb.or([eb("cleanupClaimExpiresAt", "is", null), eb("cleanupClaimExpiresAt", "<=", now)]),
    )
    .returning([
      "userId",
      "grantRevision",
      "cleanupReason",
      "cleanupMinimumGrantRevision",
      "cleanupCompletedAt",
    ])
    .executeTakeFirst();
  return result?.cleanupReason
    ? {
        token,
        connectionId,
        userId: result.userId,
        reason: result.cleanupReason,
        minimumGrantRevision: result.cleanupMinimumGrantRevision ?? undefined,
        pending: result.cleanupCompletedAt === null,
        grantRevision: result.grantRevision,
      }
    : null;
}

export async function renewConnectionCleanupClaim(
  database: Kysely<DatabaseSchema>,
  claim: ConnectionCleanupClaim,
): Promise<boolean> {
  const now = new Date();
  const result = await database
    .updateTable("agentConnections")
    .set({ cleanupClaimExpiresAt: new Date(now.getTime() + cleanupClaimDurationMs) })
    .where("id", "=", claim.connectionId)
    .where("cleanupClaimToken", "=", claim.token)
    .where("cleanupClaimExpiresAt", ">", sql<Date>`clock_timestamp()`)
    .where("grantRevision", "=", claim.grantRevision)
    .where("cleanupReason", "=", claim.reason)
    .executeTakeFirst();
  return result.numUpdatedRows === 1n;
}

export async function recordConnectionStop(
  database: Kysely<DatabaseSchema>,
  claim: ConnectionCleanupClaim,
  attempt: LineageAttempt,
  result: "ended" | "contact-lost",
): Promise<void> {
  await commitPersonalMutation(database, async (tx) => {
    if (!(await renewConnectionCleanupClaim(tx, claim))) return;
    const current = outstandingAttempts(await connectionAttempts(tx, claim.connectionId)).some(
      (row) =>
        row.kind === attempt.kind &&
        row.id === attempt.id &&
        row.generation === attempt.generation &&
        row.runnerId === attempt.runnerId &&
        row.runnerBootId === attempt.runnerBootId &&
        (attempt.kind !== "standard-cdp" ||
          (row.kind === "standard-cdp" &&
            row.standardCdpRecovery?.sessionId === attempt.standardCdpRecovery?.sessionId &&
            row.standardCdpRecovery?.runtimeBootId === attempt.standardCdpRecovery?.runtimeBootId)),
    );
    if (!current) return;
    const now = new Date();
    const evidence = {
      terminalEvidenceAt: now,
      contactLostAt: result === "contact-lost" ? now : null,
    };
    if (attempt.kind === "standard-cdp" && attempt.standardCdpRecovery) {
      await tx
        .updateTable("browserSessions")
        .set({
          standardCdpAttempts: sql`jsonb_set(standard_cdp_attempts, array[${attempt.id}],
            ((standard_cdp_attempts -> ${attempt.id}::text) - 'contactLostAt') ||
            jsonb_build_object('terminalEvidenceAt', ${now.toISOString()}::text) ||
            case when ${result === "contact-lost"} then
              jsonb_build_object('contactLostAt', ${now.toISOString()}::text)
            else '{}'::jsonb end)`,
        })
        .where("id", "=", attempt.standardCdpRecovery.sessionId)
        .where(
          sql<boolean>`standard_cdp_attempts -> ${attempt.id}::text -> 'recovery' ->> 'runtimeBootId' =
          ${attempt.standardCdpRecovery.runtimeBootId} and
          not (standard_cdp_attempts -> ${attempt.id}::text ? 'terminalEvidenceAt')`,
        )
        .execute();
    } else if (attempt.kind === "plugin") {
      await tx
        .updateTable("pluginExecutions")
        .set({
          ...evidence,
          state: sql`case when state in ('running','waiting','answered')
          then ${result === "contact-lost" ? "interrupted" : "cancelled"} else state end`,
        })
        .where("id", "=", attempt.id)
        .where("terminalEvidenceAt", "is", null)
        .execute();
    } else if (attempt.kind === "run-attempt") {
      await tx
        .updateTable("runAttempts")
        .set(evidence)
        .where("id", "=", attempt.id as import("@opensteer/core").RunAttemptId)
        .where("bindingGeneration", "=", attempt.generation)
        .where("terminalEvidenceAt", "is", null)
        .execute();
    } else if (attempt.kind === "occurrence") {
      const settled = await tx
        .updateTable("triggerOccurrences")
        .set(evidence)
        .where("id", "=", attempt.id)
        .where("executionGeneration", "=", attempt.generation)
        .where("runnerId", "=", attempt.runnerId)
        .where("runnerBootId", "=", attempt.runnerBootId)
        .where("terminalEvidenceAt", "is", null)
        .executeTakeFirst();
      if (settled.numUpdatedRows === 0n) {
        await tx
          .updateTable("triggerOccurrenceAttempts")
          .set(evidence)
          .where("occurrenceId", "=", attempt.id)
          .where("executionGeneration", "=", attempt.generation)
          .where("runnerId", "=", attempt.runnerId)
          .where("runnerBootId", "=", attempt.runnerBootId)
          .where("terminalEvidenceAt", "is", null)
          .execute();
      }
    } else if (attempt.kind === "watch") {
      await tx
        .updateTable("triggerWatchActivations")
        .set({ ...evidence, observed: "stopped", updatedAt: now })
        .where("id", "=", attempt.id)
        .where("executionGeneration", "=", String(attempt.generation))
        .where("terminalEvidenceAt", "is", null)
        .execute();
    }
  });
}

export async function releaseConnectionCleanupClaim(
  database: Kysely<DatabaseSchema>,
  connectionId: string,
  token: string,
): Promise<void> {
  await database
    .updateTable("agentConnections")
    .set({ cleanupClaimToken: null, cleanupClaimExpiresAt: null })
    .where("id", "=", connectionId)
    .where("cleanupClaimToken", "=", token)
    .execute();
}

export async function completeCleanupIfSettled(
  database: Kysely<DatabaseSchema>,
  claim: ConnectionCleanupClaim,
): Promise<boolean> {
  const { connectionId, token } = claim;
  return commitPersonalMutation(database, async (tx) => {
    const connection = await tx
      .selectFrom("agentConnections")
      .select([
        "cleanupRequestedAt",
        "cleanupCompletedAt",
        "lastActionUncertainAt",
        "acknowledgedUncertaintyAt",
      ])
      .where("id", "=", connectionId)
      .where("cleanupClaimToken", "=", token)
      .where("cleanupClaimExpiresAt", ">", sql<Date>`clock_timestamp()`)
      .where("cleanupReason", "=", claim.reason)
      .where("grantRevision", "=", claim.grantRevision)
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (!connection?.cleanupRequestedAt) return false;
    const attempts = await connectionAttempts(tx, connectionId);
    const uncertainty = await latestConnectionUncertainty(tx, connection, attempts);
    if (uncertainty) {
      await tx
        .updateTable("agentConnections")
        .set(uncertainty)
        .where("id", "=", connectionId)
        .execute();
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

export async function latestConnectionUncertainty(
  database: Kysely<DatabaseSchema>,
  connection: {
    readonly acknowledgedUncertaintyAt: Date | null;
    readonly lastActionUncertainAt: Date | null;
  },
  attempts: readonly LineageAttempt[],
) {
  const latest = attempts.reduce<LineageAttempt | undefined>((previous, attempt) => {
    if (
      attempt.kind === "standard-cdp" &&
      attempt.standardCdpRecovery &&
      !attempt.terminalEvidenceAt
    )
      return previous;
    return attempt.contactLostAt && (!previous || attempt.contactLostAt > previous.contactLostAt!)
      ? attempt
      : previous;
  }, undefined);
  const at = latest?.contactLostAt;
  if (
    !latest ||
    !at ||
    (connection.acknowledgedUncertaintyAt && at <= connection.acknowledgedUncertaintyAt) ||
    (connection.lastActionUncertainAt && at <= connection.lastActionUncertainAt)
  )
    return;
  return {
    lastActionUncertainAt: at,
    lastActionUncertain: {
      attemptId: latest.id,
      generation: latest.generation,
      taskId: latest.threadId,
      reason: "Contact was lost before this attempt confirmed it ended.",
      ...(latest.runnerId
        ? {
            device:
              (
                await database
                  .selectFrom("runners")
                  .select("name")
                  .where("id", "=", latest.runnerId)
                  .executeTakeFirst()
              )?.name ?? null,
          }
        : {}),
      ...(latest.kind === "operation"
        ? await database
            .selectFrom("agentOperations")
            .select([
              "tool",
              sql<string>`target->>'name'`.as("target"),
              sql<string | null>`target->'device'->>'name'`.as("device"),
            ])
            .where("id", "=", latest.id as AgentOperationId)
            .executeTakeFirst()
        : {}),
    },
  };
}

export async function settleLineageRequests(
  database: Kysely<DatabaseSchema>,
  requestIds: readonly RequestId[],
  claim?: ConnectionCleanupClaim,
): Promise<void> {
  if (!requestIds.length) return;
  await commitPersonalMutation(database, async (tx) => {
    if (claim && !(await renewConnectionCleanupClaim(tx, claim))) return;
    const now = new Date();
    const linked = await tx
      .selectFrom("agentOperations")
      .select("id")
      .where("requestId", "in", requestIds)
      .where("state", "=", "pending")
      .where("handedOffAt", "is", null)
      .orderBy("id")
      .forNoKeyUpdate()
      .execute();
    if (linked.length)
      await tx
        .updateTable("agentOperations")
        .set({
          state: "refused",
          outcome: "refused",
          completedAt: now,
          terminalEvidenceAt: now,
          updatedAt: now,
        })
        .where(
          "id",
          "in",
          linked.map(({ id }) => id),
        )
        .execute();
    await cancelPending(tx, {
      reason: "authority-revoked",
      resolvedAt: new Date(),
      requestIds,
      cancelHandedOffPlugins: false,
    });
  });
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
    // The one liveness test: a bridge whose account was paused or removed hands nothing off. In
    // the same statement, the sender of a chat's message may still speak: a Run whose message
    // came from an identity no longer "me" is not sent (no other connection reads more).
    const connection = await tx
      .selectFrom("agentConnections")
      .select([
        "grantRevision",
        sql<boolean>`(agent_connections.bridge_senders is distinct from 'owner' or not exists (
          select 1 from runs speak_run
          join thread_inputs speak_input on speak_input.message_id = speak_run.seed_input_id
          where speak_run.id = ${input.runId}
            and speak_input.authority_source ? 'chat'
            and not exists (
              select 1 from channel_identities speak_me
              where speak_me.account_id = agent_connections.bridge_account_id
                and speak_me.external_user_id =
                  speak_input.authority_source->'chat'->>'externalUserId'
                and speak_me.status = 'linked'
                and speak_me.linked_user_id = agent_connections.user_id)))`.as("senderMaySpeak"),
      ])
      .select(connectionState().as("state"))
      .where("id", "=", input.connectionId)
      .forShare()
      .executeTakeFirst();
    // A chat paused while its Run was prepared is held, from this same read.
    if (connection?.state === "waiting") throw new ConnectionWaiting();
    if (
      !connection ||
      connection.state !== "live" ||
      connection.grantRevision !== input.grantRevision
    )
      throw new Error("The agent connection changed before this Run could be sent");
    if (!connection.senderMaySpeak)
      throw new OpensteerError({ code: "forbidden", message: senderUnlinkedFailure });
    const witness = {
      admittedGrantRevision: input.grantRevision,
      admittedAccessMode: input.mode,
    };
    const updated = await tx
      .updateTable("runs")
      .set(witness)
      .where("id", "=", input.runId)
      .where("connectionId", "=", input.connectionId)
      .where("bindingGeneration", "=", input.bindingGeneration)
      .where("status", "=", "starting")
      .executeTakeFirst();
    if (updated.numUpdatedRows !== 1n)
      throw new Error("The Run binding changed before it could be sent");
    const attempt = await tx
      .updateTable("runAttempts")
      .set({ ...witness, connectionId: input.connectionId })
      .where("runId", "=", input.runId)
      .where("bindingGeneration", "=", input.bindingGeneration)
      .executeTakeFirst();
    if (attempt.numUpdatedRows !== 1n)
      throw new Error("The Run attempt disappeared before it could be sent");
  });
}

export async function recordRunNotAdmitted(
  database: Kysely<DatabaseSchema>,
  runId: RunId,
  bindingGeneration: number,
): Promise<void> {
  await database
    .updateTable("runAttempts")
    .set({
      terminalEvidenceAt: new Date(),
      contactLostAt: null,
    })
    .where("runId", "=", runId)
    .where("bindingGeneration", "=", bindingGeneration)
    .where("connectionId", "is not", null)
    .where("terminalEvidenceAt", "is", null)
    .execute();
}

export async function markConnectionAttemptsContactLost(
  database: Kysely<DatabaseSchema>,
  input: { readonly runnerId: RunnerId; readonly runnerBootId: string },
): Promise<void> {
  await commitPersonalMutation(database, async (tx) => {
    const now = new Date();
    for (const table of ["triggerOccurrences", "triggerWatchActivations"] as const) {
      const affected = await tx
        .selectFrom(table)
        .select("id")
        .where("connectionId", "is not", null)
        .where("runnerId", "=", input.runnerId)
        .where("runnerBootId", "=", input.runnerBootId)
        .where("terminalEvidenceAt", "is", null)
        .where("contactLostAt", "is", null)
        .orderBy("id")
        .forNoKeyUpdate()
        .execute();
      if (affected.length === 0) continue;
      await tx
        .updateTable(table)
        .set({ contactLostAt: now })
        .where(
          "id",
          "in",
          affected.map(({ id }) => id),
        )
        .execute();
    }
    const retired = await tx
      .selectFrom("triggerOccurrenceAttempts")
      .select(["occurrenceId", "executionGeneration"])
      .where("runnerId", "=", input.runnerId)
      .where("runnerBootId", "=", input.runnerBootId)
      .where("terminalEvidenceAt", "is", null)
      .where("contactLostAt", "is", null)
      .orderBy("occurrenceId")
      .orderBy("executionGeneration")
      .forNoKeyUpdate()
      .execute();
    for (const { occurrenceId, executionGeneration } of retired) {
      await tx
        .updateTable("triggerOccurrenceAttempts")
        .set({ contactLostAt: now })
        .where("occurrenceId", "=", occurrenceId)
        .where("executionGeneration", "=", executionGeneration)
        .execute();
    }
    // The attempts in id order first, as the tables above: two Runs a connection started on one
    // boot are two rows, and an unordered update of both can deadlock against another writer.
    const attempts = await tx
      .selectFrom("runAttempts")
      .select("id")
      .where("connectionId", "is not", null)
      .where("runnerId", "=", input.runnerId)
      .where("runnerBootId", "=", input.runnerBootId)
      .where("terminalEvidenceAt", "is", null)
      .where("contactLostAt", "is", null)
      .orderBy("id")
      .forNoKeyUpdate()
      .execute();
    if (attempts.length > 0)
      await tx
        .updateTable("runAttempts")
        .set({ contactLostAt: now })
        .where(
          "id",
          "in",
          attempts.map(({ id }) => id),
        )
        .execute();
  });
}

export function connectionCdpAttempts(database: Kysely<DatabaseSchema>) {
  type Witness = {
    readonly connectionId: string;
    readonly grantRevision: number;
    readonly mode: ThreadAccessMode;
    readonly threadId: ThreadId | null;
    readonly recovery?: StandardCdpAttemptReconciliation;
  };
  return {
    async open(sessionId: BrowserSessionId, id: string, witness: Witness): Promise<void> {
      await commitPersonalMutation(database, async (tx) => {
        // Only a live connection opens one: a paused or ended chat opens nothing, by the one
        // state function.
        const connection = await tx
          .selectFrom("agentConnections")
          .select(["grantRevision", liveConnection().as("live")])
          .where("id", "=", witness.connectionId)
          .forShare()
          .executeTakeFirst();
        if (!connection || !connection.live || connection.grantRevision !== witness.grantRevision)
          throw new Error("This browser authority has ended");
        const changed = await tx
          .updateTable("browserSessions")
          .set({
            standardCdpAttempts: sql`standard_cdp_attempts ||
            jsonb_build_object(${id}::text, ${JSON.stringify(witness)}::jsonb)`,
          })
          .where("id", "=", sessionId)
          .where("state", "=", "ready")
          .executeTakeFirst();
        if (changed.numUpdatedRows !== 1n) throw new Error("The Browser Session ended");
      });
    },
    async settled(sessionId: BrowserSessionId, id: string): Promise<void> {
      await database
        .updateTable("browserSessions")
        .set({
          standardCdpAttempts: sql`case when standard_cdp_attempts -> ${id}::text ? 'contactLostAt'
          and not (standard_cdp_attempts -> ${id}::text ? 'recovery')
          then jsonb_set(standard_cdp_attempts, array[${id}, 'terminalEvidenceAt'], to_jsonb(now()))
          else standard_cdp_attempts - ${id}::text end`,
        })
        .where("id", "=", sessionId)
        .where(
          sql<boolean>`standard_cdp_attempts ? ${id} and
          not (standard_cdp_attempts -> ${id}::text ? 'terminalEvidenceAt')`,
        )
        .execute();
    },
    async lost(sessionId: BrowserSessionId, id: string): Promise<void> {
      await database
        .updateTable("browserSessions")
        .set({
          standardCdpAttempts: sql`jsonb_set(standard_cdp_attempts, array[${id}, 'contactLostAt'], to_jsonb(now()))`,
        })
        .where("id", "=", sessionId)
        .where(
          sql<boolean>`standard_cdp_attempts ? ${id} and
          not (standard_cdp_attempts -> ${id}::text ?| array['terminalEvidenceAt', 'contactLostAt'])`,
        )
        .execute();
    },
  };
}

export async function recordReconciledConnectionCdpAttempt(
  database: Kysely<DatabaseSchema>,
  sessionId: BrowserSessionId,
  id: string,
  contactLost: boolean,
): Promise<void> {
  await database
    .updateTable("browserSessions")
    .set({
      standardCdpAttempts: sql`jsonb_set(
        standard_cdp_attempts, array[${id}],
        standard_cdp_attempts -> ${id}::text ||
          jsonb_build_object('terminalEvidenceAt', now()) ||
          case when ${contactLost} then jsonb_build_object(
            'contactLostAt', coalesce(standard_cdp_attempts -> ${id}::text -> 'contactLostAt', to_jsonb(now()))
          ) else '{}'::jsonb end
      )`,
    })
    .where("id", "=", sessionId)
    .where(sql<boolean>`standard_cdp_attempts -> ${id}::text ? 'connectionId'`)
    .execute();
}

export async function recoverConnectionCdpAttempts(
  database: Kysely<DatabaseSchema>,
): Promise<void> {
  await sql`update browser_sessions b
    set standard_cdp_attempts = (
      select jsonb_object_agg(id, case when not (witness ? 'connectionId') or witness ?| array['terminalEvidenceAt', 'contactLostAt']
        then witness else witness || jsonb_build_object('contactLostAt', now()) end)
      from jsonb_each(b.standard_cdp_attempts) a(id, witness)
    ) where b.standard_cdp_attempts <> '{}'`.execute(database);
}

/**
 * Stop one chat attempt of a disconnected bridge: what has not left the Home is cancelled, known
 * never sent; one whose send began and whose lease ran out may have left, so it is unknown,
 * which ends it with contact lost. One still in the runtime's hands is waited for.
 */
export async function stopChatAttempt(
  tx: Kysely<DatabaseSchema>,
  deliveryId: string,
): Promise<void> {
  await tx
    .updateTable("bridgeDeliveries")
    .set({
      status: "cancelled",
      lastError: "Disconnected before it was sent",
      claimExpiresAt: null,
      claimOwner: null,
      claimTokenHash: null,
      updatedAt: new Date(),
    })
    .where("id", "=", deliveryId as never)
    .where("status", "in", ["pending", "leased", "retryable-failed"])
    .execute();
  await tx
    .updateTable("bridgeDeliveries")
    .set({
      status: "unknown",
      lastError: "Disconnected while it was being sent; it may have arrived",
      claimExpiresAt: null,
      claimOwner: null,
      claimTokenHash: null,
      updatedAt: new Date(),
    })
    .where("id", "=", deliveryId as never)
    .where("status", "=", "attempt-started")
    .where("claimExpiresAt", "<", sql<Date>`now()`)
    .execute();
}
