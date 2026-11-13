import { sql } from "kysely";
import { lockRunProjectionRows } from "./run-projection-locks.js";
import type { RevokedRunGrant } from "./run-grants.js";
import {
  OpensteerError,
  type AgentEvent,
  type DeploymentId,
  type ExecutionSelection,
  type TeamAgentRequestId,
  type TeamMessageId,
  type TeamSource,
  type TeamTaskOrigin,
  type UserId,
} from "@opensteer/core";
import type { Kysely, Transaction } from "kysely";
import { enqueueRunnerControlInTransaction } from "./command-store.js";
import { appendHostDeploymentEvent } from "./deployment-events.js";
import { requirePersonalOwner } from "./personal-settings-store.js";
import { withPersonalTransaction } from "./personal-transaction.js";
import type { DatabaseSchema } from "./schema.js";
import { lockCommandIdempotency, threadPathLinks } from "./store-primitives.js";
import {
  enqueueThreadInputInTransaction,
  ensureQueuedRun,
  teamReturnUndeliverableReason,
} from "./thread-inbox.js";
import { threadInputFromRow } from "./thread-row-mappers.js";
import { createThreadInTransaction } from "./thread-store.js";
import { projectThreadState } from "./thread-status.js";

interface TeamAdmissionInput {
  readonly bodyMarkdown: string;
  readonly attachments?: readonly { readonly id: string; readonly filename: string }[];
  readonly origin: TeamTaskOrigin;
  readonly requestId: TeamAgentRequestId;
  readonly triggerMessageId: TeamMessageId;
  readonly source: TeamSource;
}

export async function findTeamTaskAdmission(
  database: Kysely<DatabaseSchema>,
  input: Pick<TeamAdmissionInput, "origin" | "requestId" | "triggerMessageId">,
) {
  const existing = await database
    .selectFrom("personalTeamRequests")
    .selectAll()
    .where("teamDeploymentId", "=", input.origin.teamId)
    .where("requestId", "=", input.requestId)
    .executeTakeFirst();
  if (!existing) return null;
  if (existing.triggerMessageId !== input.triggerMessageId)
    throw new OpensteerError({
      code: "conflict",
      message: "This team request already names another triggering message.",
    });
  if (!existing.localTaskId || !existing.localInputId) return null;
  const task = await database
    .selectFrom("threads")
    .select(["teamId", "channelId", "threadRootId"])
    .where("id", "=", existing.localTaskId)
    .executeTakeFirstOrThrow();
  if (
    task.teamId !== input.origin.teamId ||
    task.channelId !== input.origin.channelId ||
    task.threadRootId !== input.origin.threadRootId
  )
    throw new OpensteerError({
      code: "conflict",
      message: "This team request already belongs to another thread.",
    });
  return { taskId: existing.localTaskId, inputId: existing.localInputId, runId: existing.runId };
}

export function admitTeamTaskRequest(
  database: Kysely<DatabaseSchema>,
  input: TeamAdmissionInput & { readonly ownerId: UserId; readonly execution: ExecutionSelection },
) {
  return withPersonalTransaction(database, async (transaction) => {
    await requirePersonalOwner(transaction, input.ownerId);
    for (const key of [
      `team-task:${input.origin.teamId}:${input.origin.channelId}:${input.origin.threadRootId}`,
      `team:${input.origin.teamId}:${input.requestId}`,
    ].sort())
      await lockCommandIdempotency(transaction, input.ownerId, key);
    const existing = await findTeamTaskAdmission(transaction, input);
    if (existing) return { receipt: existing, events: [] };
    const link = await transaction
      .selectFrom("personalTeamLinks")
      .select("id")
      .where("teamDeploymentId", "=", input.origin.teamId)
      .where("state", "in", ["active", "unreachable"])
      .executeTakeFirst();
    if (!link)
      throw new OpensteerError({
        code: "forbidden",
        message: "Connect your Opensteer to this team before asking your agent.",
      });
    const mirror = await transaction
      .selectFrom("personalTeamRequests")
      .selectAll()
      .where("teamDeploymentId", "=", input.origin.teamId)
      .where("requestId", "=", input.requestId)
      .executeTakeFirst();
    if (
      mirror?.kind === "ask" &&
      (mirror.localDecision !== "approve" ||
        mirror.terminalState ||
        !["queued", "working", "needs_you"].includes(mirror.remoteState))
    )
      throw new OpensteerError({
        code: "forbidden",
        message: "Team ask has not been approved and acknowledged.",
      });
    const bound = await transaction
      .selectFrom("threads")
      .select("id")
      .where("teamId", "=", input.origin.teamId)
      .where("channelId", "=", input.origin.channelId)
      .where("threadRootId", "=", input.origin.threadRootId)
      .executeTakeFirst();
    const events: AgentEvent[] = [];
    let taskId = bound?.id;
    if (!taskId) {
      const created = await createThreadInTransaction(transaction, {
        ...input.execution,
        createdBy: input.ownerId,
        teamOrigin: input.origin,
        idempotencyKey: `team-task:${input.origin.teamId}:${input.origin.channelId}:${input.origin.threadRootId}`,
        title:
          input.bodyMarkdown.trim().slice(0, 120) || input.attachments?.[0]?.filename || "Team ask",
        generateTitle: true,
      });
      taskId = created.thread.id;
      if (created.event) events.push(created.event);
    }
    const queued = await enqueueThreadInputInTransaction(transaction, {
      threadId: taskId,
      requestedBy: input.ownerId,
      source:
        mirror?.kind === "ask"
          ? { kind: "team-member", teamId: input.origin.teamId, requestId: input.requestId }
          : { kind: "human" },
      policy: "queue",
      content: [
        ...(input.bodyMarkdown.trim() ? [{ type: "text" as const, text: input.bodyMarkdown }] : []),
        ...(input.attachments ?? []).map((file) => ({
          type: "text" as const,
          text: `Attached team file: ${JSON.stringify(file.filename)} (fileId: ${file.id}; use team_read to download).`,
        })),
      ],
      idempotencyKey: `team:${input.origin.teamId}:${input.requestId}`,
      teamRequest: {
        id: input.requestId,
        triggerMessageId: input.triggerMessageId,
        source: input.source,
      },
    });
    if (queued.input.state === "cancelled")
      throw new OpensteerError({
        code: "conflict",
        message: "The bound task cannot accept this request.",
      });
    await transaction
      .insertInto("personalTeamRequests")
      .values({
        teamDeploymentId: input.origin.teamId,
        requestId: input.requestId,
        triggerMessageId: input.triggerMessageId,
        localTaskId: taskId,
        localInputId: queued.message.id,
        runId: queued.run?.id ?? null,
        publicationState: "pending",
        terminalState: null,
        acceptedMessageId: null,
        source: input.source,
        finishedAt: null,
      })
      .onConflict((conflict) =>
        conflict
          .columns(["teamDeploymentId", "requestId"])
          .doUpdateSet({
            localTaskId: taskId,
            localInputId: queued.message.id,
            runId: queued.run?.id ?? null,
          })
          .where("personalTeamRequests.localDecision", "=", "approve")
          .where("personalTeamRequests.remoteState", "in", ["queued", "working", "needs_you"])
          .where("personalTeamRequests.terminalState", "is", null),
      )
      .returning("requestId")
      .executeTakeFirstOrThrow();
    events.push(...queued.events);
    return {
      receipt: { taskId, inputId: queued.message.id, runId: queued.run?.id ?? null },
      events,
    };
  });
}

export function cancelTeamTaskRequest(
  database: Kysely<DatabaseSchema>,
  input: { readonly teamId: DeploymentId; readonly requestId: TeamAgentRequestId },
) {
  return withPersonalTransaction(database, async (transaction) => {
    const request = await transaction
      .selectFrom("personalTeamRequests")
      .selectAll()
      .where("teamDeploymentId", "=", input.teamId)
      .where("requestId", "=", input.requestId)
      .executeTakeFirst();
    if (!request?.localTaskId || !request.localInputId || request.kind === "return")
      return { events: [], revokedGrants: [] };
    const task = await transaction
      .selectFrom("threads")
      .selectAll()
      .where("id", "=", request.localTaskId)
      .executeTakeFirstOrThrow();
    await lockCommandIdempotency(
      transaction,
      task.createdBy,
      `team-cancel:${input.teamId}:${input.requestId}`,
    );
    const run = await transaction
      .selectFrom("runs")
      .selectAll()
      .where(sql<string>`reply_target->>'requestId'`, "=", input.requestId)
      .where("threadId", "=", request.localTaskId)
      .where("seedInputId", "=", request.localInputId)
      .forNoKeyUpdate()
      .executeTakeFirst();
    const events: AgentEvent[] = [];
    let revokedGrants: readonly RevokedRunGrant[] = [];
    if (run && ["starting", "running", "waiting"].includes(run.status)) {
      const stopped = await enqueueRunnerControlInTransaction(transaction, threadPathLinks, {
        type: "run.interrupt",
        threadId: task.id,
        runId: run.id,
        keepQueueRunning: true,
        requestedBy: run.requestedBy,
        idempotencyKey: `team-cancel:${input.teamId}:${input.requestId}`,
      });
      events.push(...stopped.events);
      revokedGrants = stopped.revokedGrants;
    } else if (!run || run.status === "queued") {
      await transaction
        .selectFrom("threads")
        .select("id")
        .where("id", "=", task.id)
        .forNoKeyUpdate()
        .executeTakeFirstOrThrow();
      await lockRunProjectionRows(transaction, {
        threadIds: [task.id],
        runIds: run ? [run.id] : [],
      });
      const inbox = await transaction
        .selectFrom("threadInputs")
        .selectAll()
        .where("messageId", "=", request.localInputId)
        .executeTakeFirstOrThrow();
      if (inbox.state === "cancelled") return { events: [], revokedGrants: [] };
      const cancelled = await transaction
        .updateTable("threadInputs")
        .set({ state: "cancelled", cancelReason: "team-request-cancelled", updatedAt: new Date() })
        .where("messageId", "=", inbox.messageId)
        .returningAll()
        .executeTakeFirstOrThrow();
      if (run) {
        await transaction
          .updateTable("runs")
          .set({ status: "interrupted", completedAt: new Date() })
          .where("id", "=", run.id)
          .execute();
        await transaction
          .updateTable("commands")
          .set({ status: "failed", updatedAt: new Date() })
          .where("runId", "=", run.id)
          .where("type", "=", "run.execute")
          .execute();
        events.push(
          await appendHostDeploymentEvent(transaction, {
            type: "run.interrupted",
            threadId: task.id,
            runId: run.id,
            environmentId: task.environmentId,
            data: { status: "interrupted" },
          }),
        );
      }
      events.push(
        await appendHostDeploymentEvent(transaction, {
          type: "thread-input.updated",
          threadId: task.id,
          runId: run?.id ?? null,
          environmentId: task.environmentId,
          data: { input: threadInputFromRow(cancelled) },
        }),
      );
      await transaction
        .selectFrom("personalTeamRequests")
        .select("requestId")
        .where("localTaskId", "=", task.id)
        .orderBy("teamDeploymentId")
        .orderBy("requestId")
        .forNoKeyUpdate()
        .execute();
      await transaction
        .updateTable("personalTeamRequests")
        .set({ terminalState: "cancelled", finishedAt: new Date() })
        .where("teamDeploymentId", "=", input.teamId)
        .where("requestId", "=", input.requestId)
        .execute();
      events.push(
        ...(await projectThreadState(transaction, task.id)),
        ...(await ensureQueuedRun(transaction, task)).events,
      );
    }
    return { events, revokedGrants };
  });
}

export async function admitTeamReturn(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly ownerId: UserId;
    readonly teamId: DeploymentId;
    readonly requestId: TeamAgentRequestId;
  },
) {
  try {
    return await withPersonalTransaction(database, async (tx) => {
      await requirePersonalOwner(tx, input.ownerId);
      const mirror = await tx
        .selectFrom("personalTeamRequests")
        .selectAll()
        .where("teamDeploymentId", "=", input.teamId)
        .where("requestId", "=", input.requestId)
        .executeTakeFirstOrThrow();
      if (mirror.kind !== "return")
        throw new OpensteerError({ code: "bad_request", message: "Not a team return." });
      if (mirror.returnAdmission || mirror.terminalState) return { events: [] };
      const link = await tx
        .selectFrom("personalTeamLinks")
        .selectAll()
        .where("teamDeploymentId", "=", input.teamId)
        .executeTakeFirst();
      if (!link || !["active", "unreachable"].includes(link.state)) return { events: [] };
      const reject = async () => {
        await tx
          .updateTable("personalTeamRequests")
          .set({
            returnAdmission: "undeliverable",
            publicationState: "blocked",
            terminalState: "done",
            finishedAt: new Date(),
            blockedReason: "Return does not match an outstanding local ask.",
          })
          .where("teamDeploymentId", "=", input.teamId)
          .where("requestId", "=", input.requestId)
          .execute();
        return { events: [] };
      };
      const payload = mirror.returnPayload;
      if (!payload?.author || payload.author.actor !== "agent" || !payload.triggerClientMessageId)
        return reject();
      await lockCommandIdempotency(
        tx,
        input.ownerId,
        `team-return:${input.teamId}:${payload.originAskId}`,
      );
      const post = await tx
        .selectFrom("personalTeamPosts")
        .selectAll()
        .where("teamDeploymentId", "=", input.teamId)
        .where("clientMessageId", "=", payload.triggerClientMessageId)
        .where("localLinkId", "=", link.id)
        .where("remoteLinkId", "=", link.remoteLinkId)
        .where("runId", "=", payload.resumeRunId)
        .where("channelId", "=", mirror.source.channelId)
        .where("createdAt", ">", new Date(Date.now() - 14 * 86400000))
        .executeTakeFirst();
      if (
        !post ||
        payload.author.teamUserId === link.remoteOwnerUserId ||
        !payload.author.handle ||
        !post.mentionedAgentHandles.includes(`${payload.author.handle}-agent`) ||
        (post.threadRootId !== null && post.threadRootId !== mirror.source.threadRootId)
      )
        return reject();
      if (post.messageId === null) return { events: [] };
      if (
        !post.targetUserIds.includes(payload.author.teamUserId) ||
        post.messageId !== mirror.triggerMessageId ||
        (post.threadRootId ?? post.messageId) !== mirror.source.threadRootId
      )
        return reject();
      const consumed = await tx
        .selectFrom("personalTeamRequests")
        .select("requestId")
        .where("teamDeploymentId", "=", input.teamId)
        .where("returnAdmission", "=", "admitted")
        .where(
          sql<string>`return_payload->>'triggerClientMessageId'`,
          "=",
          payload.triggerClientMessageId,
        )
        .where(sql<string>`return_payload->'author'->>'handle'`, "=", payload.author.handle)
        .executeTakeFirst();
      if (consumed) return reject();
      const run = await tx
        .selectFrom("runs")
        .select(["threadId", "requestedBy"])
        .where("id", "=", payload.resumeRunId)
        .executeTakeFirst();
      if (!run || run.requestedBy !== input.ownerId)
        throw new OpensteerError({
          code: "conflict",
          reason: teamReturnUndeliverableReason,
          message: "Team return is undeliverable.",
        });
      const queued = await enqueueThreadInputInTransaction(tx, {
        threadId: run.threadId,
        requestedBy: input.ownerId,
        policy: "queue",
        source: {
          kind: "team-member",
          teamId: input.teamId,
          requestId: input.requestId,
          resumeRunId: payload.resumeRunId,
        },
        idempotencyKey: `team-return:${input.teamId}:${payload.originAskId}`,
        content: [
          {
            type: "text",
            text: `Team ask outcome: ${payload.outcome}. Source thread: ${JSON.stringify(mirror.source)}. Ask: ${payload.originAskId}. This is a private return; no answer auto-posts.`,
          },
          ...(payload.bodyMarkdown ? [{ type: "text" as const, text: payload.bodyMarkdown }] : []),
          ...payload.attachments.map((file) => ({
            type: "text" as const,
            text: `Attached team file: ${JSON.stringify(file.filename)} (fileId: ${file.id}; use team_read to download).`,
          })),
        ],
      });
      if (queued.input.state === "cancelled")
        throw new OpensteerError({
          code: "conflict",
          reason: teamReturnUndeliverableReason,
          message: "Team return is undeliverable.",
        });
      await tx
        .updateTable("personalTeamRequests")
        .set({
          localTaskId: run.threadId,
          localInputId: queued.message.id,
          runId: queued.run?.id ?? null,
          returnAdmission: "admitted",
          publicationState: "accepted",
          terminalState: "done",
          finishedAt: new Date(),
        })
        .where("teamDeploymentId", "=", input.teamId)
        .where("requestId", "=", input.requestId)
        .execute();
      await consumeTeamPost(
        tx,
        input.teamId,
        payload.triggerClientMessageId,
        payload.author.teamUserId,
      );
      return { events: queued.events };
    });
  } catch (error) {
    if (!(error instanceof OpensteerError) || error.reason !== teamReturnUndeliverableReason)
      throw error;
    await withPersonalTransaction(database, async (tx) => {
      const link = await tx
        .selectFrom("personalTeamLinks")
        .select("state")
        .where("teamDeploymentId", "=", input.teamId)
        .executeTakeFirst();
      if (!link || !["active", "unreachable"].includes(link.state)) return;
      await tx
        .updateTable("personalTeamRequests")
        .set({
          returnAdmission: "undeliverable",
          publicationState: "blocked",
          terminalState: "done",
          finishedAt: new Date(),
          blockedReason: "The asking task is Done, unavailable or its delegation is closed.",
        })
        .where("teamDeploymentId", "=", input.teamId)
        .where("requestId", "=", input.requestId)
        .where("returnAdmission", "is", null)
        .where("terminalState", "is", null)
        .execute();
      const mirror = await tx
        .selectFrom("personalTeamRequests")
        .select("returnPayload")
        .where("teamDeploymentId", "=", input.teamId)
        .where("requestId", "=", input.requestId)
        .executeTakeFirst();
      const payload = mirror?.returnPayload;
      if (payload?.triggerClientMessageId && payload.author)
        await consumeTeamPost(
          tx,
          input.teamId,
          payload.triggerClientMessageId,
          payload.author.teamUserId,
        );
    });
    return { events: [] };
  }
}

async function consumeTeamPost(
  tx: Transaction<DatabaseSchema>,
  teamId: DeploymentId,
  clientMessageId: string,
  userId: UserId,
) {
  await tx
    .updateTable("personalTeamPosts")
    .set({ targetUserIds: sql`array_remove(target_user_ids, ${userId})` })
    .where("teamDeploymentId", "=", teamId)
    .where("clientMessageId", "=", clientMessageId)
    .execute();
  await tx
    .deleteFrom("personalTeamPosts")
    .where("teamDeploymentId", "=", teamId)
    .where("clientMessageId", "=", clientMessageId)
    .where(sql<number>`cardinality(target_user_ids)`, "=", 0)
    .execute();
}
