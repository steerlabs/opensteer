import { isDeepStrictEqual } from "node:util";
import {
  type CompactionReturnHint,
  compactionReturnEligibleAt,
  idleCompactionWindow,
  type RunId,
  type RunMaintenance,
  type ThreadId,
} from "@opensteer/core";
import type { Kysely } from "kysely";
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
