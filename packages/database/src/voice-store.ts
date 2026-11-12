import { personalSettings } from "./personal-settings-store.js";
import { withPersonalTransaction } from "./personal-transaction.js";
import {
  nonTerminalRunStatuses,
  OpensteerError,
  voiceCallSeed,
  voiceModelSelection,
  type AgentEvent,
  type EnvironmentId,
  type HarnessInstanceId,
  type RunId,
  type ThreadAccessMode,
  type ThreadId,
  type UserId,
} from "@opensteer/core";
import { sql, type Kysely, type Transaction } from "kysely";
import type { DatabaseSchema } from "./schema.js";
import "./connection.js";
import { createThreadInTransaction } from "./thread-store.js";
import { enqueueThreadInputInTransaction } from "./thread-inbox.js";
import { enqueueRunnerControlInTransaction } from "./command-store.js";
import { lockCommandIdempotency, type ChannelLinks } from "./store-primitives.js";
import type { RevokedRunGrant } from "./run-grants.js";
const liveRunStatuses: readonly string[] = nonTerminalRunStatuses;
export function resolveVoiceCall(
  database: Kysely<DatabaseSchema>,
  ownerId: UserId,
  sessionId: string,
) {
  return database
    .selectFrom("runs")
    .innerJoin("threads", "threads.id", "runs.threadId")
    .select([
      "threads.id as threadId",
      "threads.environmentId",
      "runs.voiceSessionId as sessionId",
      "runs.id as runId",
      "runs.createdAt as admittedAt",
      "runs.status",
      "threads.status as threadStatus",
    ])
    .where("runs.requestedBy", "=", ownerId)
    .where("runs.voiceSessionId", "=", sessionId)
    .executeTakeFirst();
}

/** The person's one Voice Thread, created the first time it is needed. */
async function ensureVoiceThread(
  tx: Transaction<DatabaseSchema>,
  input: {
    readonly ownerId: UserId;
    readonly environmentId: EnvironmentId;
    readonly harnessInstanceId: HarnessInstanceId;
    readonly accessMode?: ThreadAccessMode;
  },
): Promise<{
  readonly threadId: ThreadId;
  readonly environmentId: EnvironmentId;
  readonly harnessInstanceId: HarnessInstanceId;
  readonly events: readonly AgentEvent[];
}> {
  const settings = await personalSettings(tx);
  if (settings.ownerId !== input.ownerId)
    throw new OpensteerError({
      code: "forbidden",
      message: "Voice belongs to the personal owner.",
    });
  if (settings.voiceThreadId) {
    const thread = await tx
      .selectFrom("threads")
      .select(["environmentId", "harnessInstanceId"])
      .where("id", "=", settings.voiceThreadId)
      .executeTakeFirstOrThrow();
    return { threadId: settings.voiceThreadId, ...thread, events: [] };
  }
  const catalog = await tx
    .selectFrom("harnessCatalogs")
    .select("catalog")
    .where("environmentId", "=", input.environmentId)
    .where("harnessInstanceId", "=", input.harnessInstanceId)
    .executeTakeFirst();
  const modelSelection = voiceModelSelection(catalog?.catalog ?? null);
  if (!modelSelection)
    throw new OpensteerError({
      code: "conflict",
      reason: "voice-account-unavailable",
      message: "Voice model unavailable.",
    });
  const created = await createThreadInTransaction(
    tx,
    {
      createdBy: input.ownerId,
      environmentId: input.environmentId,
      harnessInstanceId: input.harnessInstanceId,
      ...(input.accessMode
        ? {
            accessMode: input.accessMode,
          }
        : {}),
      idempotencyKey: `voice-thread:${input.ownerId}`,
      modelSelection,
      title: "Voice",
      purpose: "voice",
      folder: settings.agentHome,
    },
    {
      unlisted: true,
    },
  );
  return {
    threadId: created.thread.id,
    environmentId: input.environmentId,
    harnessInstanceId: input.harnessInstanceId,
    events: created.event ? [created.event] : [],
  };
}

/** Opens the person's Voice Thread without starting a call. */
export async function openVoiceThread(
  database: Kysely<DatabaseSchema>,
  input: Parameters<typeof ensureVoiceThread>[1],
) {
  return withPersonalTransaction(database, async (tx) => {
    await sql`select pg_advisory_xact_lock(hashtextextended(${`voice:${input.ownerId}`}, 0))`.execute(
      tx,
    );
    return ensureVoiceThread(tx, input);
  });
}

/**
 * Admits a call as one Run on the Voice Thread. Whatever else is running there,
 * another call or a reply to a finished task, is asked to stop and the answer
 * is `busy`; once that Run has ended, the next attempt takes the Thread.
 */
export async function startVoiceCall(
  database: Kysely<DatabaseSchema>,
  links: ChannelLinks,
  input: {
    ownerId: UserId;
    sessionId: string;
    environmentId: EnvironmentId;
    harnessInstanceId: HarnessInstanceId;
    accessMode?: ThreadAccessMode;
  },
) {
  return withPersonalTransaction(database, async (tx) => {
    await sql`select pg_advisory_xact_lock(hashtextextended(${`voice:${input.ownerId}`}, 0))`.execute(
      tx,
    );
    const existing = await resolveVoiceCall(tx, input.ownerId, input.sessionId);
    if (existing)
      return {
        busy: false as const,
        ...existing,
        revokedGrants: [],
        events: [],
      };
    await lockCommandIdempotency(tx, input.ownerId, `voice-seed:${input.sessionId}`);
    const opened = await ensureVoiceThread(tx, input);
    const events: AgentEvent[] = [...opened.events];
    const thread = await tx
      .selectFrom("threads")
      .select(["id", "environmentId", "harnessInstanceId"])
      .where("id", "=", opened.threadId)
      .executeTakeFirstOrThrow();
    if (
      thread.environmentId !== input.environmentId ||
      thread.harnessInstanceId !== input.harnessInstanceId
    )
      throw new OpensteerError({
        code: "conflict",
        reason: "voice-account-unavailable",
        message: "This voice account is not the one the Voice Thread uses.",
      });
    const running = await tx
      .selectFrom("runs")
      .select("id")
      .where("threadId", "=", thread.id)
      .where("status", "in", nonTerminalRunStatuses)
      .orderBy("id")
      .execute();
    if (running.length) {
      const revokedGrants: RevokedRunGrant[] = [];
      for (const { id } of running) {
        const stopped = await stopLiveRun(tx, links, input.ownerId, thread.id, id);
        revokedGrants.push(...stopped.revokedGrants);
        events.push(...stopped.events);
      }
      return {
        busy: true as const,
        revokedGrants,
        events,
      };
    }
    const seed = await enqueueThreadInputInTransaction(tx, {
      threadId: thread.id,
      requestedBy: input.ownerId,
      source: {
        kind: "human",
      },
      content: [
        {
          type: "text",
          text: voiceCallSeed,
        },
      ],
      policy: "queue",
      idempotencyKey: `voice-seed:${input.sessionId}`,
    });
    events.push(...seed.events);
    const queued = await tx
      .selectFrom("runs")
      .select("id")
      .where("threadId", "=", thread.id)
      .where("status", "=", "queued")
      .executeTakeFirst();
    if (!queued)
      throw new OpensteerError({
        code: "conflict",
        reason: "voice-refused",
        message: "The Voice Thread could not take this call.",
      });
    await tx
      .updateTable("runs")
      .set({
        voiceSessionId: input.sessionId,
      })
      .where("id", "=", queued.id)
      .execute();
    return {
      busy: false as const,
      ...(await resolveVoiceCall(tx, input.ownerId, input.sessionId))!,
      revokedGrants: seed.revokedGrants,
      events,
    };
  });
}
function stopRun(
  tx: Transaction<DatabaseSchema>,
  links: ChannelLinks,
  ownerId: UserId,
  threadId: ThreadId,
  runId: RunId,
) {
  return enqueueRunnerControlInTransaction(tx, links, {
    type: "run.interrupt",
    runId,
    threadId,
    requestedBy: ownerId,
    idempotencyKey: `voice-stop:${runId}`,
  });
}
async function stopLiveRun(
  tx: Transaction<DatabaseSchema>,
  links: ChannelLinks,
  ownerId: UserId,
  threadId: ThreadId,
  runId: RunId,
) {
  await lockCommandIdempotency(tx, ownerId, `voice-stop:${runId}`);
  const run = await tx
    .selectFrom("runs")
    .select("status")
    .where("id", "=", runId)
    .forNoKeyUpdate()
    .executeTakeFirstOrThrow();
  if (!liveRunStatuses.includes(run.status))
    return {
      revokedGrants: [],
      events: [],
    };
  return stopRun(tx, links, ownerId, threadId, runId);
}
export async function stopVoiceCall(
  database: Kysely<DatabaseSchema>,
  links: ChannelLinks,
  ownerId: UserId,
  sessionId: string,
) {
  return withPersonalTransaction(database, async (tx) => {
    await sql`select pg_advisory_xact_lock(hashtextextended(${`voice:${ownerId}`}, 0))`.execute(tx);
    const call = await resolveVoiceCall(tx, ownerId, sessionId);
    if (!call) return;
    return stopLiveRun(tx, links, ownerId, call.threadId, call.runId);
  });
}
