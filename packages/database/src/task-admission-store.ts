import { refreshTeamAskAttention, unreadTaskContribution } from "./personal-attention-store.js";
import { commitPersonalMutation } from "./personal-mutation.js";
import { refreshInputQueue } from "./waiting-inputs.js";
import { requireThreadWriteAuthority } from "./task-done.js";
import {
  executionDate,
  personalTransactionDatabase,
  withPersonalReadTransaction,
} from "./personal-transaction.js";
import { advanceThreadQueue, lockInputQueueProjection, clearInputLease } from "./waiting-inputs.js";
import { personalTeamReturnPost } from "./personal-team-return-provenance.js";
import { sql } from "kysely";
import { lockRunProjectionRows } from "./run-projection-locks.js";
import type { RevokedRunGrant } from "./run-grants.js";
import {
  OpensteerError,
  type DeploymentId,
  type ExecutionSelection,
  type TeamAgentRequestId,
  type TeamMessageId,
  type TeamSource,
  type TeamTaskOrigin,
  type ThreadId,
  type UserId,
} from "@opensteer/core";
import type { Kysely, Transaction } from "kysely";
import { enqueueRunnerControlInTransaction } from "./command-store.js";
import { requirePersonalOwner } from "./personal-settings-store.js";
import type { DatabaseSchema } from "./schema.js";
import { lockCommandIdempotency, threadPathLinks } from "./store-primitives.js";
import { enqueueThreadInputInTransaction, teamReturnUndeliverableReason } from "./thread-inbox.js";
import { createThreadInTransaction } from "./thread-store.js";
import { projectThreadState, publishRunQueue, publishThreadSummary } from "./thread-status.js";

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
    .where("removedAt", "is", null)
    .executeTakeFirst();
  if (!task) return null;
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
  return commitPersonalMutation(database, async (transaction, mutation) => {
    await requirePersonalOwner(transaction, input.ownerId);
    for (const key of [
      `team-task:${input.origin.teamId}:${input.origin.channelId}:${input.origin.threadRootId}`,
      `team:${input.origin.teamId}:${input.requestId}`,
    ].sort())
      await lockCommandIdempotency(transaction, input.ownerId, key);
    const existing = await findTeamTaskAdmission(transaction, input);
    if (existing) return { receipt: existing };
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
    await refreshTeamAskAttention(transaction, mutation, input.origin.teamId, input.requestId);
    return { receipt: { taskId, inputId: queued.message.id, runId: queued.run?.id ?? null } };
  });
}

export async function cancelTeamTaskRequest(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly teamId: DeploymentId;
    readonly requestId: TeamAgentRequestId;
    readonly reason?: string;
    readonly failureReason?: string;
  },
) {
  const result = await commitPersonalMutation(database, async (transaction, mutation) => {
    const request = await transaction
      .selectFrom("personalTeamRequests")
      .selectAll()
      .where("teamDeploymentId", "=", input.teamId)
      .where("requestId", "=", input.requestId)
      .executeTakeFirst();
    if (!request) return { revokedGrants: [] };
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
      await refreshTeamAskAttention(transaction, mutation, input.teamId, input.requestId);
    };
    if (!request.localTaskId || !request.localInputId || request.kind === "return") {
      await terminalize();
      return { revokedGrants: [] };
    }
    const task = await transaction
      .selectFrom("threads")
      .selectAll()
      .where("id", "=", request.localTaskId)
      .where("removedAt", "is", null)
      .executeTakeFirst();
    if (!task) return { revokedGrants: [] };
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
    await lockInputQueueProjection(transaction, task.id);
    await terminalize();

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
      {
      }
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
        await publishRunQueue(transaction, task.id, run.id);
      }
      await refreshInputQueue(transaction, task.id, cancelled.messageId);
      const advanced = await advanceThreadQueue(transaction, task);
      revokedGrants = [...revokedGrants, ...advanced.revokedGrants];
      if (task.teamAskOrigin && !run) {
        const source = personalTransactionDatabase(transaction);
        if (database.isTransaction && source)
          mutation.reaction(() => removeAskTask(source, task.id));
        return { revokedGrants, removalCandidate: task.id };
      }
    }
    return { revokedGrants };
  });
  if (!database.isTransaction && result.removalCandidate)
    await removeAskTask(database, result.removalCandidate);
  return { revokedGrants: result.revokedGrants };
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
    await commitPersonalMutation(database, async (tx) => {
      await requirePersonalOwner(tx, input.ownerId);
      const mirror = await tx
        .selectFrom("personalTeamRequests")
        .selectAll()
        .where("teamDeploymentId", "=", input.teamId)
        .where("requestId", "=", input.requestId)
        .executeTakeFirstOrThrow();
      if (mirror.kind !== "return")
        throw new OpensteerError({ code: "bad_request", message: "Not a team return." });
      if (mirror.returnAdmission || mirror.terminalState) return;
      const link = await tx
        .selectFrom("personalTeamLinks")
        .selectAll()
        .where("teamDeploymentId", "=", input.teamId)
        .executeTakeFirst();
      if (!link || !["active", "unreachable"].includes(link.state)) return;
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
        return;
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
      if (post.messageId === null) return;
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
      return;
    });
  } catch (error) {
    if (!(error instanceof OpensteerError) || error.reason !== teamReturnUndeliverableReason)
      throw error;
    await commitPersonalMutation(database, async (tx) => {
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
    return;
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
  return commitPersonalMutation(database, async (transaction, mutation) => {
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
      return { revokedGrants: [] };
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
    if (mirror.terminalState || mirror.releasedAt) return { revokedGrants: [] };
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
    if (reopened) {
      await publishThreadSummary(transaction, thread.id);
    }
    await transaction
      .updateTable("personalTeamRequests")
      .set({ releasedAt: now })
      .where("teamDeploymentId", "=", input.teamId)
      .where("requestId", "=", input.requestId)
      .execute();
    await refreshTeamAskAttention(transaction, mutation, input.teamId, input.requestId);
    await refreshInputQueue(transaction, thread.id, released.messageId);
    const advanced = await advanceThreadQueue(transaction, thread);
    await projectThreadState(transaction, thread.id);
    return { ...advanced };
  });
}

/** Only an unadopted task consisting entirely of terminal asks may disappear. */
async function askRemovalRevision(
  transaction: Transaction<DatabaseSchema>,
  threadId: ThreadId,
  verifiedMessages = false,
) {
  const eligible = await sql<{
    revision: string;
  }>`select t.revision from threads t where t.id = ${threadId} and t.removed_at is null
    and t.team_ask_origin and t.title_source <> 'chosen' and t.status <> 'archived' and t.done_at is null
    and not exists(select 1 from runs where thread_id = t.id)
    and not exists(select 1 from personal_team_requests p where p.local_task_id = t.id and (p.kind <> 'ask' or p.terminal_state is null))
    ${
      verifiedMessages
        ? sql``
        : sql`and not exists(select 1 from messages m where m.thread_id = t.id and not exists (
      select 1 from personal_team_requests p join thread_inputs i on i.message_id = p.local_input_id
      where p.local_task_id = t.id and p.local_input_id = m.id and p.kind = 'ask' and i.state = 'cancelled'))`
    }
    and not exists(select 1 from commands c where c.thread_id = t.id and c.type in ('thread.rename', 'thread.done.set', 'thread.archive'))
    and not exists(select 1 from threads child where child.id <> t.id and (child.parent_thread_id = t.id or child.lineage_root_thread_id = t.id))
    and not exists(select 1 from triggers where anchor_thread_id = t.id or created_by_thread_id = t.id)
    and not exists(select 1 from trigger_watch_activations where anchor_thread_id = t.id)
    and not exists(select 1 from delegations where parent_thread_id = t.id or child_thread_id = t.id)
    and not exists(select 1 from requests where originating_thread_id = t.id)
    and not exists(select 1 from channel_conversations where active_thread_id = t.id)
    ${
      verifiedMessages
        ? sql``
        : sql`and not exists(select 1 from channel_deliveries d join messages m on m.id = d.message_id where m.thread_id = t.id)
    and not exists(select 1 from channel_ingress_events e join messages m on m.id = e.message_id where m.thread_id = t.id)
    and not exists(select 1 from causal_chains c where c.root_message_id in (select id from messages where thread_id = t.id)
      and (exists(select 1 from runs where causal_chain_id = c.id)
        or exists(select 1 from thread_inputs where causal_chain_id = c.id and thread_id <> t.id)
        or exists(select 1 from trigger_occurrences where causal_chain_id = c.id)))`
    }
    and not exists(select 1 from personal_settings where voice_thread_id = t.id)
    limit 1`.execute(transaction);
  return eligible.rows[0]?.revision;
}

async function removeAskTask(database: Kysely<DatabaseSchema>, threadId: ThreadId): Promise<void> {
  const verified = await withPersonalReadTransaction(database, (tx) =>
    askRemovalRevision(tx, threadId),
  );
  if (verified === undefined) return;
  const marked = await commitPersonalMutation(database, async (tx, mutation) => {
    if ((await askRemovalRevision(tx, threadId, true)) !== verified) return false;
    const before = await unreadTaskContribution(tx, threadId);
    await tx
      .updateTable("threads")
      .set({ removedAt: mutation.state.now })
      .where("id", "=", threadId)
      .execute();
    mutation.count("unreadTaskCount", -before);
    mutation.purge(`thread:${threadId}`);
    await publishThreadSummary(tx, threadId);
    return true;
  });
  if (marked) await recoverRemovedAskTasks(database, threadId);
}

const purgeBatch = 128;

function purgeRemovedAskTask(database: Kysely<DatabaseSchema>, threadId: ThreadId) {
  return commitPersonalMutation(database, async (tx, mutation) => {
    const removed = await tx
      .selectFrom("threads")
      .select("id")
      .where("id", "=", threadId)
      .where("removedAt", "is not", null)
      .forUpdate()
      .executeTakeFirst();
    if (!removed) return false;
    const asks = await sql<{
      teamDeploymentId: DeploymentId;
      requestId: TeamAgentRequestId;
    }>`update personal_team_requests set local_task_id = null, local_input_id = null
      where (team_deployment_id, request_id) in (
        select team_deployment_id, request_id from personal_team_requests
        where local_task_id = ${threadId} order by request_id, team_deployment_id limit ${purgeBatch}
      ) returning team_deployment_id, request_id`.execute(tx);
    for (const ask of asks.rows)
      await refreshTeamAskAttention(tx, mutation, ask.teamDeploymentId, ask.requestId);
    if (asks.rows.length) return true;
    const inputs = await tx
      .deleteFrom("threadInputs")
      .where(
        "messageId",
        "in",
        tx
          .selectFrom("threadInputs")
          .select("messageId")
          .where("threadId", "=", threadId)
          .orderBy("messageId")
          .limit(purgeBatch),
      )
      .executeTakeFirst();
    if (inputs.numDeletedRows) return true;
    const chains = await sql`delete from causal_chains where id in (
      select c.id from messages m join causal_chains c on c.root_message_id = m.id
      where m.thread_id = ${threadId} order by m.sequence, c.id limit ${purgeBatch}
    )`.execute(tx);
    if (chains.numAffectedRows) return true;
    const messages = await tx
      .deleteFrom("messages")
      .where(
        "id",
        "in",
        tx
          .selectFrom("messages")
          .select("id")
          .where("threadId", "=", threadId)
          .orderBy("sequence")
          .limit(purgeBatch),
      )
      .executeTakeFirst();
    if (messages.numDeletedRows) return true;
    const commands = await tx
      .deleteFrom("commands")
      .where(
        "id",
        "in",
        tx
          .selectFrom("commands")
          .select("id")
          .where("threadId", "=", threadId)
          .orderBy("id")
          .limit(purgeBatch),
      )
      .executeTakeFirst();
    if (commands.numDeletedRows) return true;
    const sessions = await tx
      .deleteFrom("providerSessions")
      .where(
        "id",
        "in",
        tx
          .selectFrom("providerSessions")
          .select("id")
          .where("threadId", "=", threadId)
          .orderBy("id")
          .limit(purgeBatch),
      )
      .executeTakeFirst();
    if (sessions.numDeletedRows) return true;
    await tx.deleteFrom("threads").where("id", "=", threadId).execute();
    return false;
  });
}

export async function recoverRemovedAskTasks(
  database: Kysely<DatabaseSchema>,
  onlyThreadId?: ThreadId,
): Promise<void> {
  let after: ThreadId | undefined;
  for (;;) {
    const rows = await database
      .selectFrom("threads")
      .select("id")
      .where("removedAt", "is not", null)
      .$if(onlyThreadId !== undefined, (query) => query.where("id", "=", onlyThreadId!))
      .$if(after !== undefined, (query) => query.where("id", ">", after!))
      .orderBy("id")
      .limit(purgeBatch)
      .execute();
    for (const { id } of rows) {
      while (await purgeRemovedAskTask(database, id)) {
        /* Each commit retires a bounded child batch. */
      }
      after = id;
    }
    if (rows.length < purgeBatch) return;
  }
}
