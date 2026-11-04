import {
  catalogDefaultModel,
  OpensteerError,
  selectionForModelEffort,
  type UserId,
  type EnvironmentId,
  type HarnessInstanceId,
  type RunId,
  type ThreadId,
  type AgentEvent,
} from "@opensteer/core";
import { sql, type Kysely, type Transaction } from "kysely";
import type { DatabaseSchema } from "./schema.js";
import { withDatabaseTransaction } from "./connection.js";
import { createThreadInTransaction } from "./thread-store.js";
import { prepareThreadInsertion } from "./thread-insertion.js";
import { enqueueThreadInputInTransaction } from "./thread-inbox.js";
import { enqueueRunnerControlInTransaction } from "./command-store.js";
import { lockCommandIdempotency, lockWorkspaceRow, type ChannelLinks } from "./store-primitives.js";

export function voiceCallForRun(database: Kysely<DatabaseSchema>, runId: RunId) {
  return database
    .selectFrom("threads")
    .innerJoin("runs", "runs.threadId", "threads.id")
    .select(["threads.voiceSessionId as sessionId", "runs.createdAt as admittedAt"])
    .where("runs.id", "=", runId)
    .where("threads.voiceSessionId", "is not", null)
    .executeTakeFirst();
}
export function resolveVoiceCall(
  database: Kysely<DatabaseSchema>,
  ownerId: UserId,
  sessionId: string,
) {
  return database
    .selectFrom("threads")
    .innerJoin("runs", "runs.threadId", "threads.id")
    .select([
      "threads.id as threadId",
      "threads.workspaceId",
      "threads.environmentId",
      "threads.voiceSessionId as sessionId",
      "runs.id as runId",
      "runs.createdAt as admittedAt",
      "runs.status",
      "threads.status as threadStatus",
    ])
    .where("threads.createdBy", "=", ownerId)
    .where("threads.voiceSessionId", "=", sessionId)
    .executeTakeFirst();
}
export async function stopVoiceCall(
  database: Kysely<DatabaseSchema>,
  links: ChannelLinks,
  ownerId: UserId,
  sessionId: string,
) {
  return withDatabaseTransaction(database, async (tx) => {
    await sql`select pg_advisory_xact_lock(hashtextextended(${`voice:${ownerId}`}, 0))`.execute(tx);
    const call = await resolveVoiceCall(tx, ownerId, sessionId);
    if (!call || call.threadStatus === "archived") return;
    await lockCommandIdempotency(tx, ownerId, `voice-stop:${call.runId}`);
    return stop(tx, links, ownerId, call);
  });
}
const liveRunStatuses: readonly string[] = ["queued", "starting", "running", "waiting"];

/**
 * Ends a call. Its Run can terminalize on its own (lease expiry, a lost Runner)
 * after the call was read, so the status is read again under the Run's lock:
 * a Run already over needs only its Thread closed.
 */
async function stop(
  tx: Transaction<DatabaseSchema>,
  links: ChannelLinks,
  ownerId: UserId,
  call: NonNullable<Awaited<ReturnType<typeof resolveVoiceCall>>>,
) {
  const run = await tx
    .selectFrom("runs")
    .select("status")
    .where("id", "=", call.runId)
    .forNoKeyUpdate()
    .executeTakeFirstOrThrow();
  if (!liveRunStatuses.includes(run.status)) {
    await archive(tx, call.threadId);
    return { revokedGrants: [], events: [] };
  }
  const control = await enqueueRunnerControlInTransaction(tx, links, {
    type: "run.interrupt",
    runId: call.runId,
    threadId: call.threadId,
    requestedBy: ownerId,
    idempotencyKey: `voice-stop:${call.runId}`,
  });
  await archive(tx, call.threadId);
  return control;
}
async function archive(tx: Transaction<DatabaseSchema>, threadId: ThreadId) {
  await tx
    .updateTable("threads")
    .set({ status: "archived", updatedAt: new Date() })
    .where("id", "=", threadId)
    .where("status", "!=", "archived")
    .execute();
}
export async function startVoiceCall(
  database: Kysely<DatabaseSchema>,
  links: ChannelLinks,
  input: {
    ownerId: UserId;
    sessionId: string;
    environmentId: EnvironmentId;
    harnessInstanceId: HarnessInstanceId;
  },
) {
  return withDatabaseTransaction(database, async (tx) => {
    await sql`select pg_advisory_xact_lock(hashtextextended(${`voice:${input.ownerId}`}, 0))`.execute(
      tx,
    );
    const existing = await resolveVoiceCall(tx, input.ownerId, input.sessionId);
    if (existing) return { ...existing, revokedGrants: [], events: [] };
    const workspace = await tx
      .selectFrom("workspaces")
      .selectAll()
      .where("createdBy", "=", input.ownerId)
      .where("kind", "=", "main")
      .executeTakeFirst();
    if (!workspace?.homeThreadId)
      throw new OpensteerError({
        code: "conflict",
        reason: "voice-chat-required",
        message: "Set up Chat before starting voice.",
      });
    const chat = await tx
      .selectFrom("threads")
      .selectAll()
      .where("id", "=", workspace.homeThreadId)
      .executeTakeFirstOrThrow();
    const old = await tx
      .selectFrom("threads")
      .select("voiceSessionId")
      .where("createdBy", "=", input.ownerId)
      .where("voiceSessionId", "is not", null)
      .where("status", "!=", "archived")
      .executeTakeFirst();
    const oldCall = old?.voiceSessionId
      ? await resolveVoiceCall(tx, input.ownerId, old.voiceSessionId)
      : undefined;
    for (const key of [
      `voice:${input.sessionId}`,
      `voice-seed:${input.sessionId}`,
      ...(oldCall ? [`voice-stop:${oldCall.runId}`] : []),
    ].sort())
      await lockCommandIdempotency(tx, input.ownerId, key);
    if (oldCall)
      await tx
        .selectFrom("runs")
        .select("id")
        .where("id", "=", oldCall.runId)
        .forNoKeyUpdate()
        .execute();
    await lockWorkspaceRow(tx, workspace.id);
    await tx
      .selectFrom("workspaceMemberships")
      .select("userId")
      .where("workspaceId", "=", workspace.id)
      .where("userId", "=", input.ownerId)
      .forNoKeyUpdate()
      .execute();
    const catalog = await tx
      .selectFrom("harnessCatalogs")
      .select("catalog")
      .where("environmentId", "=", input.environmentId)
      .where("harnessInstanceId", "=", input.harnessInstanceId)
      .executeTakeFirst();
    // The call's own account only: its default model, at low effort for latency.
    const model = catalogDefaultModel(catalog?.catalog ?? null);
    if (!model)
      throw new OpensteerError({
        code: "conflict",
        reason: "voice-account-unavailable",
        message: "Voice model unavailable.",
      });
    const insertThread = await prepareThreadInsertion(tx, {
      createdBy: input.ownerId,
      environmentId: input.environmentId,
      harnessInstanceId: input.harnessInstanceId,
    });
    await tx
      .selectFrom("threads")
      .select("id")
      .where("id", "in", [chat.id, ...(oldCall ? [oldCall.threadId] : [])])
      .orderBy("id")
      .forNoKeyUpdate()
      .execute();
    const stopped = oldCall ? await stop(tx, links, input.ownerId, oldCall) : undefined;
    const revokedGrants = stopped?.revokedGrants ?? [];
    const events: AgentEvent[] = [...(stopped?.events ?? [])];
    const created = await createThreadInTransaction(
      tx,
      {
        createdBy: input.ownerId,
        environmentId: input.environmentId,
        harnessInstanceId: input.harnessInstanceId,
        accessMode: chat.accessMode,
        idempotencyKey: `voice:${input.sessionId}`,
        parentThreadId: chat.id,
        role: "work",
        title: "Voice call",
        workspaceId: workspace.id,
        modelSelection: selectionForModelEffort(model, "low"),
      },
      { insertThread, unlisted: true },
    );
    // Mark only after the sole seed has passed ordinary Inbox admission.
    const seed = await enqueueThreadInputInTransaction(tx, {
      threadId: created.thread.id,
      requestedBy: input.ownerId,
      source: { kind: "human" },
      content: [{ type: "text", text: "Voice call" }],
      policy: "queue",
      idempotencyKey: `voice-seed:${input.sessionId}`,
    });
    if (created.event) events.push(created.event);
    events.push(...seed.events);
    await tx
      .updateTable("threads")
      .set({ voiceSessionId: input.sessionId })
      .where("id", "=", created.thread.id)
      .execute();
    return {
      ...(await resolveVoiceCall(tx, input.ownerId, input.sessionId))!,
      revokedGrants,
      events,
    };
  });
}
