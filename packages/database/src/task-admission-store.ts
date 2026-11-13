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
import type { Kysely } from "kysely";
import { enqueueRunnerControlInTransaction } from "./command-store.js";
import { appendHostDeploymentEvent } from "./deployment-events.js";
import { requirePersonalOwner } from "./personal-settings-store.js";
import { withPersonalTransaction } from "./personal-transaction.js";
import type { DatabaseSchema } from "./schema.js";
import { lockCommandIdempotency, threadPathLinks } from "./store-primitives.js";
import { enqueueThreadInputInTransaction, ensureQueuedRun } from "./thread-inbox.js";
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
  if (!existing.localTaskId || !existing.localInputId)
    throw new OpensteerError({
      code: "conflict",
      message: "This team request has not been admitted.",
    });
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
      source: { kind: "human" },
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
    if (!request) return { events: [], revokedGrants: [] };
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
