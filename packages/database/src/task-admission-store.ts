import { appendDoneState, requireThreadWriteAuthority } from "./task-done.js";
import { executionDate } from "./personal-transaction.js";
import { advanceThreadQueue, lockInputQueueProjection, clearInputLease } from "./waiting-inputs.js";
import { personalTeamReturnPost } from "./personal-team-return-provenance.js";
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
import { enqueueThreadInputInTransaction, teamReturnUndeliverableReason } from "./thread-inbox.js";
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
      (mirror.localDecision === "decline" ||
        mirror.terminalState ||
        !mirror.consentExpiresAt ||
        (mirror.localDecision !== "approve" &&
          mirror.consentExpiresAt <= executionDate(transaction)))
    )
      throw new OpensteerError({
        code: "forbidden",
        message: "Team ask is no longer awaiting a decision.",
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
          mirror?.kind === "ask" && mirror.presentation
            ? `${mirror.presentation.asker.displayName}${!["dm", "group_dm"].includes(mirror.presentation.audience.channelKind) ? ` · #${mirror.presentation.audience.channelName.replace(/^#/, "")}` : ""}`.slice(
                0,
                240,
              )
            : input.bodyMarkdown.trim().slice(0, 120) ||
              input.attachments?.[0]?.filename ||
              "Team ask",
        generateTitle: true,
      });
      taskId = created.thread.id;
      if (mirror?.kind === "ask")
        await transaction
          .updateTable("threads")
          .set({ teamAskOrigin: true })
          .where("id", "=", taskId)
          .execute();
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
          text: `Attached team file: ${JSON.stringify(file.filename)} (fileId: ${file.id}; use opensteer_team_file_download to download).`,
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
            blockedReason: null,
            localTaskId: taskId,
            localInputId: queued.message.id,
            runId: queued.run?.id ?? null,
          })
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
  input: {
    readonly teamId: DeploymentId;
    readonly requestId: TeamAgentRequestId;
    readonly reason?: string;
    readonly failureReason?: string;
  },
) {
  return withPersonalTransaction(database, async (transaction) => {
    const request = await transaction
      .selectFrom("personalTeamRequests")
      .selectAll()
      .where("teamDeploymentId", "=", input.teamId)
      .where("requestId", "=", input.requestId)
      .executeTakeFirst();
    if (!request) return { events: [], revokedGrants: [] };
    const terminalize = async () => {
      const failed = sql<boolean>`kind = 'ask' and released_at is null and (local_decision = 'approve' or ${input.failureReason !== undefined})`;
      await transaction
        .updateTable("personalTeamRequests")
        .set({
          terminalState: sql`coalesce(terminal_state, case when ${failed} then 'failed' else 'cancelled' end)`,
          finishedAt: sql`coalesce(finished_at, ${executionDate(transaction)})`,
          returnPayload: sql`case when kind = 'return' then return_payload || '{"bodyMarkdown":null,"attachments":[]}'::jsonb else return_payload end`,
          publicationState: sql`case when ${failed} or (kind = 'ask' and released_at is null) or local_task_id is null or publication_state <> 'accepted' then 'blocked' else publication_state end`,
          blockedReason: sql`case when (terminal_state is null and ${failed}) or ((released_at is not null or kind <> 'ask') and publication_state <> 'accepted') then ${input.failureReason ?? input.reason ?? "The team request was cancelled."} else blocked_reason end`,
        })
        .where("teamDeploymentId", "=", input.teamId)
        .where("requestId", "=", input.requestId)
        .execute();
    };
    if (!request.localTaskId || !request.localInputId || request.kind === "return") {
      await terminalize();
      return { events: [], revokedGrants: [] };
    }
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
    await lockInputQueueProjection(transaction, task.id, true);
    const cleanupChains = await transaction
      .selectFrom("causalChains")
      .select("id")
      .where(
        "rootMessageId",
        "in",
        transaction.selectFrom("messages").select("id").where("threadId", "=", task.id),
      )
      .execute();
    await terminalize();
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

      const cancelled = await transaction
        .updateTable("threadInputs")
        .set({
          ...clearInputLease,
          state: "cancelled",
          cancelReason: "team-request-cancelled",
          updatedAt: new Date(),
        })
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
      const advanced = await advanceThreadQueue(transaction, task);
      revokedGrants = [...revokedGrants, ...advanced.revokedGrants];
      events.push(...advanced.events);
      const removed = await removeAskTask(
        transaction,
        task.id,
        cleanupChains.map((row) => row.id),
      );
      if (removed) events.push(removed);
      else events.push(...(await projectThreadState(transaction, task.id)));
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
            returnPayload: sql`return_payload || '{"bodyMarkdown":null,"attachments":[]}'::jsonb`,
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
      const post = await personalTeamReturnPost(tx, {
        teamId: input.teamId,
        triggerMessageId: mirror.triggerMessageId,
        source: mirror.source,
        returnPayload: payload,
      });
      if (!post) return reject();
      if (post.messageId === null) return { events: [] };
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
            text: `Attached team file: ${JSON.stringify(file.filename)} (fileId: ${file.id}; use opensteer_team_file_download to download).`,
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
          returnPayload: sql`return_payload || '{"bodyMarkdown":null,"attachments":[]}'::jsonb`,
          returnAdmission: "admitted",
          publicationState: "accepted",
          terminalState: "done",
          finishedAt: new Date(),
        })
        .where("teamDeploymentId", "=", input.teamId)
        .where("requestId", "=", input.requestId)
        .execute();
      await consumeTeamPost(tx, input.teamId, payload.triggerClientMessageId, payload.originAskId);
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
          returnPayload: sql`return_payload || '{"bodyMarkdown":null,"attachments":[]}'::jsonb`,
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
          payload.originAskId,
        );
    });
    return { events: [] };
  }
}

async function consumeTeamPost(
  tx: Transaction<DatabaseSchema>,
  teamId: DeploymentId,
  clientMessageId: string,
  requestId: TeamAgentRequestId,
) {
  await tx
    .updateTable("personalTeamPosts")
    .set({
      targetBindings: sql`(select coalesce(jsonb_agg(target), '[]'::jsonb)
      from jsonb_array_elements(target_bindings) target where target->>'requestId' <> ${requestId})`,
    })
    .where("teamDeploymentId", "=", teamId)
    .where("clientMessageId", "=", clientMessageId)
    .execute();
  await tx
    .deleteFrom("personalTeamPosts")
    .where("teamDeploymentId", "=", teamId)
    .where("clientMessageId", "=", clientMessageId)
    .where(sql<number>`jsonb_array_length(target_bindings)`, "=", 0)
    .execute();
}

export function releaseTeamAsk(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly teamId: DeploymentId;
    readonly requestId: TeamAgentRequestId;
    readonly localLinkId: string;
    readonly remoteLinkId: string | null;
  },
) {
  return withPersonalTransaction(database, async (transaction) => {
    const observed = await transaction
      .selectFrom("personalTeamRequests")
      .selectAll()
      .where("teamDeploymentId", "=", input.teamId)
      .where("requestId", "=", input.requestId)
      .executeTakeFirst();
    if (
      !observed?.localTaskId ||
      !observed.localInputId ||
      observed.releasedAt ||
      observed.terminalState
    )
      return { events: [], revokedGrants: [] };
    let thread = await lockInputQueueProjection(transaction, observed.localTaskId);
    const mirror = await transaction
      .selectFrom("personalTeamRequests")
      .selectAll()
      .where("teamDeploymentId", "=", input.teamId)
      .where("requestId", "=", input.requestId)
      .forNoKeyUpdate()
      .executeTakeFirstOrThrow();
    const link = await transaction
      .selectFrom("personalTeamLinks")
      .selectAll()
      .where("teamDeploymentId", "=", input.teamId)
      .forShare()
      .executeTakeFirst();
    const inbox = await transaction
      .selectFrom("threadInputs")
      .selectAll()
      .where("messageId", "=", observed.localInputId)
      .executeTakeFirstOrThrow();
    const message = await transaction
      .selectFrom("messages")
      .selectAll()
      .where("id", "=", observed.localInputId)
      .executeTakeFirstOrThrow();
    if (mirror.terminalState || mirror.releasedAt) return { events: [], revokedGrants: [] };
    if (
      mirror.kind !== "ask" ||
      mirror.localDecision !== "approve" ||
      !link ||
      !["active", "unreachable"].includes(link.state) ||
      link.id !== input.localLinkId ||
      link.remoteLinkId !== input.remoteLinkId ||
      inbox.state !== "awaiting-approval" ||
      mirror.approvedRevision === null ||
      message.revision !== mirror.approvedRevision
    )
      throw new OpensteerError({
        code: "conflict",
        message: "The approved ask can no longer be released.",
      });
    const reopened = thread.doneAt !== null;
    if (reopened)
      await requireThreadWriteAuthority(
        transaction,
        thread,
        { requestedBy: thread.createdBy },
        "reopen",
      );
    const now = executionDate(transaction);
    const released = await transaction
      .updateTable("threadInputs")
      .set({
        state: "pending",
        queueRank: thread.nextMessageSequence,
        ...clearInputLease,
        updatedAt: now,
      })
      .where("messageId", "=", inbox.messageId)
      .returningAll()
      .executeTakeFirstOrThrow();
    thread = await transaction
      .updateTable("threads")
      .set({ nextMessageSequence: sql`next_message_sequence + 1`, doneAt: null, doneReason: null })
      .where("id", "=", thread.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    const reopenedEvents = reopened ? [await appendDoneState(transaction, thread.id)] : [];
    await transaction
      .updateTable("personalTeamRequests")
      .set({ releasedAt: now })
      .where("teamDeploymentId", "=", input.teamId)
      .where("requestId", "=", input.requestId)
      .execute();
    const event = await appendHostDeploymentEvent(transaction, {
      type: "thread-input.updated",
      threadId: thread.id,
      runId: null,
      environmentId: thread.environmentId,
      data: { input: threadInputFromRow(released) },
    });
    const advanced = await advanceThreadQueue(transaction, thread);
    return {
      ...advanced,
      events: [
        ...reopenedEvents,
        event,
        ...advanced.events,
        ...(await projectThreadState(transaction, thread.id)),
      ],
    };
  });
}

/** Only an unadopted task consisting entirely of terminal asks may disappear. */
async function removeAskTask(
  transaction: Transaction<DatabaseSchema>,
  threadId: import("@opensteer/core").ThreadId,
  causalChainIds: readonly import("@opensteer/core").CausalChainId[],
) {
  const eligible = await sql<{
    id: import("@opensteer/core").ThreadId;
  }>`select t.id from threads t where t.id = ${threadId}
    and t.team_ask_origin and t.title_source <> 'chosen' and t.status <> 'archived' and t.done_at is null
    and not exists(select 1 from runs where thread_id = t.id)
    and not exists(select 1 from personal_team_requests p where p.local_task_id = t.id and (p.kind <> 'ask' or p.terminal_state is null))
    and not exists(select 1 from messages m where m.thread_id = t.id and not exists (
      select 1 from personal_team_requests p join thread_inputs i on i.message_id = p.local_input_id
      where p.local_task_id = t.id and p.local_input_id = m.id and p.kind = 'ask' and i.state = 'cancelled'))
    and not exists(select 1 from commands c where c.thread_id = t.id and c.type in ('thread.rename', 'thread.done.set', 'thread.archive'))
    and not exists(select 1 from threads child where child.id <> t.id and (child.parent_thread_id = t.id or child.lineage_root_thread_id = t.id))
    and not exists(select 1 from triggers where anchor_thread_id = t.id or created_by_thread_id = t.id)
    and not exists(select 1 from trigger_watch_activations where anchor_thread_id = t.id)
    and not exists(select 1 from delegations where parent_thread_id = t.id or child_thread_id = t.id)
    and not exists(select 1 from requests where originating_thread_id = t.id)
    and not exists(select 1 from channel_conversations where active_thread_id = t.id)
    and not exists(select 1 from channel_deliveries d join messages m on m.id = d.message_id where m.thread_id = t.id)
    and not exists(select 1 from channel_ingress_events e join messages m on m.id = e.message_id where m.thread_id = t.id)
    and not exists(select 1 from personal_settings where voice_thread_id = t.id)
    and not exists(select 1 from causal_chains c where c.root_message_id in (select id from messages where thread_id = t.id)
      and (exists(select 1 from runs where causal_chain_id = c.id)
        or exists(select 1 from thread_inputs where causal_chain_id = c.id and thread_id <> t.id)
        or exists(select 1 from trigger_occurrences where causal_chain_id = c.id)))`.execute(
    transaction,
  );
  if (!eligible.rows.length) return null;
  await transaction
    .updateTable("personalTeamRequests")
    .set({ localTaskId: null, localInputId: null })
    .where("localTaskId", "=", threadId)
    .execute();
  // The chain roots point back at messages; remove inputs before their exclusive chains.
  await transaction.deleteFrom("threadInputs").where("threadId", "=", threadId).execute();
  if (causalChainIds.length)
    await transaction
      .deleteFrom("causalChains")
      .where("id", "in", [...causalChainIds])
      .execute();
  const task = await transaction
    .selectFrom("threads")
    .select("environmentId")
    .where("id", "=", threadId)
    .executeTakeFirstOrThrow();
  await transaction.deleteFrom("threads").where("id", "=", threadId).execute();
  return appendHostDeploymentEvent(transaction, {
    type: "task.removed",
    threadId,
    runId: null,
    environmentId: task.environmentId,
    data: {},
  });
}
