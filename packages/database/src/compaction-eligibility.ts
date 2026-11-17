import { isDeepStrictEqual } from "node:util";
import {
  type CompactionReturnHint,
  compactionReturnEligibleAt,
  idleCompactionWindow,
  type RunId,
  type RunMaintenance,
  type ThreadId,
} from "@opensteer/core";
import { sql, type Kysely } from "kysely";
import type { DatabaseSchema } from "./schema.js";

export async function compactionIsEligible(
  database: Kysely<DatabaseSchema>,
  threadId: ThreadId,
  maintenance: RunMaintenance,
  nowMs: number,
  executingRunId?: RunId,
): Promise<boolean> {
  const thread = await database
    .selectFrom("threads")
    .selectAll()
    .where("id", "=", threadId)
    .executeTakeFirst();
  if (
    !thread ||
    !thread.listed ||
    thread.parentThreadId ||
    thread.teamId ||
    thread.purpose !== "task" ||
    thread.status === "archived" ||
    thread.doneAt ||
    thread.inputQueuePaused
  )
    return false;
  const policy = await database
    .selectFrom("personalSettings")
    .select("idleCompactionPolicy")
    .executeTakeFirst();
  if (
    policy?.idleCompactionPolicy.mode === "off" ||
    (maintenance.reason === "idle" && policy?.idleCompactionPolicy.mode !== "beforeCacheExpires")
  )
    return false;
  const harness = await database
    .selectFrom("harnessInstances")
    .select(["driverKind", "enabled"])
    .where("id", "=", thread.harnessInstanceId)
    .executeTakeFirst();
  if (!harness?.enabled || harness.driverKind !== "claude") return false;
  const session = await database
    .selectFrom("providerSessions")
    .selectAll()
    .where("id", "=", maintenance.providerSessionId)
    .where("threadId", "=", threadId)
    .executeTakeFirst();
  if (
    !session?.active ||
    !session.providerSessionReference ||
    session.harnessInstanceId !== thread.harnessInstanceId ||
    session.contextSnapshot?.sourceRunId !== maintenance.sourceRunId
  )
    return false;
  const owner = await database.selectFrom("personalSettings").select("ownerId").executeTakeFirst();
  if (owner?.ownerId !== thread.createdBy) return false;
  const origin = await database
    .selectFrom("personalTeamRequests")
    .select("requestId")
    .where("localTaskId", "=", threadId)
    .executeTakeFirst();
  if (origin) return false;
  const environment = await database
    .selectFrom("executionEnvironments")
    .innerJoin("runners", "runners.id", "executionEnvironments.runnerId")
    .select(["runners.capabilities", "runners.revokedAt"])
    .where("executionEnvironments.id", "=", thread.environmentId)
    .executeTakeFirst();
  if (
    !environment ||
    environment.revokedAt ||
    !environment.capabilities.includes("claude-compaction-v1")
  )
    return false;
  const assignments = await database
    .selectFrom("delegations")
    .select("id")
    .where((eb) => eb.or([eb("parentThreadId", "=", threadId), eb("childThreadId", "=", threadId)]))
    .where("status", "=", "open")
    .executeTakeFirst();
  if (assignments) return false;
  const nodes = await database
    .selectFrom("executionNodes")
    .innerJoin("runs", "runs.id", "executionNodes.runId")
    .select("executionNodes.id")
    .where("runs.threadId", "=", threadId)
    .where("executionNodes.status", "=", "running")
    .executeTakeFirst();
  if (nodes) return false;
  const snapshot = session.contextSnapshot;
  if (snapshot.usedTokens < 200_000) return false;
  if (maintenance.reason === "idle") {
    const window = idleCompactionWindow(snapshot, nowMs);
    if (!window || nowMs < window.startMs) return false;
  } else if (nowMs < compactionReturnEligibleAt(snapshot)) return false;
  const source = await database
    .selectFrom("runs")
    .selectAll()
    .where("id", "=", maintenance.sourceRunId)
    .where("threadId", "=", threadId)
    .executeTakeFirst();
  if (
    !source ||
    source.status !== "completed" ||
    source.harnessInstanceId !== thread.harnessInstanceId ||
    !isDeepStrictEqual(source.modelSelection, thread.modelSelection) ||
    source.maintenance ||
    source.voiceSessionId ||
    source.assignmentId ||
    source.replyTarget ||
    source.providerSessionId !== session.id
  )
    return false;
  const later = await database
    .selectFrom("runs")
    .select("id")
    .where("threadId", "=", threadId)
    .where("runOrdinal", ">", source.runOrdinal)
    .$if(executingRunId !== undefined, (q) => q.where("id", "!=", executingRunId!))
    .executeTakeFirst();
  if (later) return false;
  const busy = await database
    .selectFrom("runs")
    .select("id")
    .where("threadId", "=", threadId)
    .where("status", "in", ["queued", "starting", "running", "waiting"])
    .$if(executingRunId !== undefined, (q) => q.where("id", "!=", executingRunId!))
    .executeTakeFirst();
  if (busy || thread.pendingRequestCount > 0) return false;
  const inputs = await database
    .selectFrom("threadInputs")
    .select("messageId")
    .where("threadId", "=", threadId)
    .where("state", "in", ["pending", "claimed", "unknown"])
    .$if(
      executingRunId !== undefined &&
        maintenance.reason === "before-send" &&
        maintenance.pairedInputId !== undefined,
      (q) => q.where("messageId", "!=", maintenance.pairedInputId!),
    )
    .$if(executingRunId !== undefined, (q) =>
      q.where((eb) => eb.or([eb("runId", "is", null), eb("runId", "!=", executingRunId!)])),
    )
    .executeTakeFirst();
  return !inputs;
}

export async function compactionReturnHint(
  database: Kysely<DatabaseSchema>,
  threadId: ThreadId,
  nowMs = Date.now(),
): Promise<CompactionReturnHint | null> {
  const session = await database
    .selectFrom("providerSessions")
    .selectAll()
    .where("threadId", "=", threadId)
    .where("active", "=", true)
    .executeTakeFirst();
  const snapshot = session?.contextSnapshot;
  if (!snapshot) return null;
  const eligibleAt = compactionReturnEligibleAt(snapshot);
  return {
    eligible: await compactionIsEligible(
      database,
      threadId,
      {
        kind: "claude-compaction",
        reason: "before-send",
        providerSessionId: session.id,
        sourceRunId: snapshot.sourceRunId,
      },
      Math.max(nowMs, eligibleAt),
    ),
    eligibleAt,
    sourceRunId: snapshot.sourceRunId,
    sessionRevision: `${session.id}:${snapshot.bindingGeneration}:${snapshot.ordinal}`,
  };
}

export async function compactionReturnHints(
  database: Kysely<DatabaseSchema>,
  threadIds: readonly ThreadId[],
): Promise<ReadonlyMap<ThreadId, CompactionReturnHint>> {
  if (threadIds.length === 0) return new Map();
  const rows = await database
    .selectFrom("providerSessions as session")
    .innerJoin("threads as thread", "thread.id", "session.threadId")
    .leftJoin("harnessInstances as harness", "harness.id", "thread.harnessInstanceId")
    .leftJoin("executionEnvironments as environment", "environment.id", "thread.environmentId")
    .leftJoin("runners as runner", "runner.id", "environment.runnerId")
    .leftJoin("runs as source", (join) =>
      join.on("source.id", "=", sql<RunId>`session.context_snapshot->>'sourceRunId'`),
    )
    .select(["thread.id as threadId", "session.id", "session.contextSnapshot"])
    .select(
      sql<boolean>`coalesce(
      thread.listed and thread.parent_thread_id is null and thread.team_id is null
      and thread.purpose = 'task' and thread.status <> 'archived'
      and thread.done_at is null and not thread.input_queue_paused
      and exists (select 1 from personal_settings p where p.owner_id = thread.created_by
        and p.idle_compaction_policy->>'mode' <> 'off')
      and harness.enabled and harness.driver_kind = 'claude'
      and length(session.provider_session_reference) > 0
      and session.harness_instance_id = thread.harness_instance_id
      and runner.revoked_at is null and runner.capabilities @> '["claude-compaction-v1"]'::jsonb
      and not exists (select 1 from personal_team_requests r where r.local_task_id = thread.id)
      and not exists (select 1 from delegations d where
        (d.parent_thread_id = thread.id or d.child_thread_id = thread.id) and d.status = 'open')
      and not exists (select 1 from execution_nodes n join runs r on r.id = n.run_id
        where r.thread_id = thread.id and n.status = 'running')
      and (session.context_snapshot->>'usedTokens')::bigint >= 200000
      and source.thread_id = thread.id and source.status = 'completed'
      and source.harness_instance_id = thread.harness_instance_id
      and source.model_selection = thread.model_selection
      and source.maintenance is null and source.voice_session_id is null
      and source.assignment_id is null and source.reply_target is null
      and source.provider_session_id = session.id
      and not exists (select 1 from runs r where r.thread_id = thread.id
        and (r.run_ordinal > source.run_ordinal or r.status in ('queued','starting','running','waiting')))
      and thread.pending_request_count = 0
      and not exists (select 1 from thread_inputs i where i.thread_id = thread.id
        and i.state in ('pending','claimed','unknown')),
      false)`.as("eligible"),
    )
    .where("thread.id", "in", threadIds)
    .where("session.active", "=", true)
    .where("session.contextSnapshot", "is not", null)
    .execute();
  return new Map(
    rows.flatMap((row) => {
      const snapshot = row.contextSnapshot;
      return snapshot
        ? [
            [
              row.threadId,
              {
                eligible: row.eligible,
                eligibleAt: compactionReturnEligibleAt(snapshot),
                sourceRunId: snapshot.sourceRunId,
                sessionRevision: `${row.id}:${snapshot.bindingGeneration}:${snapshot.ordinal}`,
              },
            ] as const,
          ]
        : [];
    }),
  );
}
