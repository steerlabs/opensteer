import {
  ContentPartSchema,
  MessageAuthorSchema,
  MessageContentSchema,
  MessageEditSchema,
  MessageViewSchema,
  MessageRevisionViewSchema,
  OpensteerError,
  createId,
  nonTerminalRunStatuses,
  threadInputEditLeaseMs,
  type AuthSessionId,
  type MessageId,
  type ThreadId,
  type UserId,
  type ThreadInputEditLeaseView,
  type AgentEvent,
} from "@opensteer/core";
import { messageRevisionsPageSize } from "@opensteer/protocol";
import { type Kysely, type Transaction, type Selectable } from "kysely";
import type { DatabaseSchema, ThreadRow, ThreadInputTable, MessageTable } from "./schema.js";
import {
  executionDate,
  withPersonalTransaction,
  withPersonalReadTransaction,
} from "./personal-transaction.js";
import { requirePersonalOwner } from "./personal-settings-store.js";
import {
  lockThreadRow,
  lockCommandIdempotency,
  jsonValue,
  idempotencyConflict,
} from "./store-primitives.js";
import { lockRunProjectionRows } from "./run-projection-locks.js";
import { appendHostDeploymentEvent } from "./deployment-events.js";
import { messageFromRow, messageViewFromRow, threadInputFromRow } from "./thread-row-mappers.js";
import {
  ensureQueuedRun,
  deliverConversationInputsInTransaction,
  assertThreadInputCapacity,
} from "./thread-inbox.js";
import { isDeepStrictEqual } from "node:util";

type InputRow = Selectable<ThreadInputTable>;
export const clearInputLease = {
  editLeaseId: null,
  editLeaseSessionId: null,
  editLeaseDeviceLabel: null,
  editLeaseExpiresAt: null,
} as const;

export function liveInputLease(
  database: Kysely<DatabaseSchema>,
  row: InputRow,
): ThreadInputEditLeaseView | null {
  return row.editLeaseId &&
    row.editLeaseExpiresAt &&
    row.editLeaseDeviceLabel &&
    row.editLeaseExpiresAt > executionDate(database)
    ? {
        leaseId: row.editLeaseId,
        deviceLabel: row.editLeaseDeviceLabel,
        expiresAt: row.editLeaseExpiresAt.toISOString(),
      }
    : null;
}

export function assertInputLease(
  database: Kysely<DatabaseSchema>,
  row: InputRow,
  leaseId?: string,
  sessionId?: AuthSessionId,
) {
  const lease = liveInputLease(database, row);
  if (lease && (lease.leaseId !== leaseId || row.editLeaseSessionId !== sessionId))
    throw new OpensteerError({
      code: "conflict",
      message: `Being edited on ${lease.deviceLabel}. Release that edit lease first.`,
    });
}

export async function inputLeaseBarrier(
  transaction: Transaction<DatabaseSchema>,
  threadId: ThreadId,
  queueRank: string,
): Promise<boolean> {
  return Boolean(
    await transaction
      .selectFrom("threadInputs")
      .select("messageId")
      .where("threadId", "=", threadId)
      .where("state", "=", "pending")
      .where("queueRank", "<=", queueRank)
      .where("editLeaseExpiresAt", ">", executionDate(transaction))
      .limit(1)
      .executeTakeFirst(),
  );
}

export async function lockInputQueueProjection(
  transaction: Transaction<DatabaseSchema>,
  threadId: ThreadId,
  includeRetiredInputs = false,
): Promise<ThreadRow> {
  const runs = await transaction
    .selectFrom("runs")
    .select("id")
    .where("threadId", "=", threadId)
    .where("status", "in", nonTerminalRunStatuses)
    .orderBy("id")
    .forNoKeyUpdate()
    .execute();
  await lockThreadRow(transaction, threadId);
  await lockRunProjectionRows(transaction, {
    threadIds: [threadId],
    runIds: runs.map((row) => row.id),
    includeRetiredInputs,
  });
  return transaction
    .selectFrom("threads")
    .selectAll()
    .where("id", "=", threadId)
    .executeTakeFirstOrThrow(
      () => new OpensteerError({ code: "not_found", message: "Task not found" }),
    );
}

/** Callers hold the full Run/Thread projection prefix before changing an input. */
export async function advanceThreadQueue(
  transaction: Transaction<DatabaseSchema>,
  thread: ThreadRow,
) {
  const queued = await ensureQueuedRun(transaction, thread);
  const active = await transaction
    .selectFrom("runs")
    .select("id")
    .where("threadId", "=", thread.id)
    .where("status", "=", "running")
    .executeTakeFirst();
  const handed = active
    ? await deliverConversationInputsInTransaction(transaction, active.id)
    : { events: [], revokedGrants: [] };
  return { events: [...queued.events, ...handed.events], revokedGrants: handed.revokedGrants };
}

export function leaseChangedEvent(
  transaction: Transaction<DatabaseSchema>,
  thread: Pick<ThreadRow, "id" | "environmentId">,
  messageId: MessageId,
  lease: ThreadInputEditLeaseView | null,
) {
  return appendHostDeploymentEvent(transaction, {
    type: "thread-input.lease-changed",
    threadId: thread.id,
    environmentId: thread.environmentId,
    runId: null,
    data: { messageId, lease },
  });
}

export async function inputEditEligibility(
  transaction: Transaction<DatabaseSchema>,
  thread: ThreadRow,
  row: InputRow,
  message: Selectable<MessageTable>,
  requestedBy: UserId,
): Promise<boolean> {
  if (
    thread.createdBy !== requestedBy ||
    row.policy !== "queue" ||
    !["pending", "awaiting-approval"].includes(row.state) ||
    row.steerCommandId ||
    message.kind !== "input"
  )
    return false;
  if (
    await transaction
      .selectFrom("runs")
      .select("id")
      .where("seedInputId", "=", row.messageId)
      .where("status", "in", nonTerminalRunStatuses)
      .executeTakeFirst()
  )
    return false;
  const mirror = row.teamRequestId
    ? await transaction
        .selectFrom("personalTeamRequests")
        .selectAll()
        .where("localInputId", "=", row.messageId)
        .where("kind", "=", "ask")
        .executeTakeFirst()
    : null;
  if (mirror?.localDecision === "approve" && !mirror.releasedAt) return false;
  if (message.author.kind === "team-member")
    return Boolean(mirror && !mirror.terminalState && mirror.localDecision !== "decline");
  return (
    message.author.kind === "human" &&
    message.author.userId === requestedBy &&
    row.requestedBy === requestedBy &&
    ["user-session", "connection"].includes(String(row.authoritySource.kind))
  );
}

export interface WaitingInputIdentity {
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly requestedBy: UserId;
  readonly sessionId: AuthSessionId;
  readonly deviceLabel: string;
}

async function editable(transaction: Transaction<DatabaseSchema>, input: WaitingInputIdentity) {
  await requirePersonalOwner(transaction, input.requestedBy);
  const thread = await lockInputQueueProjection(transaction, input.threadId);
  const row = await transaction
    .selectFrom("threadInputs")
    .selectAll()
    .where("threadId", "=", input.threadId)
    .where("messageId", "=", input.messageId)
    .executeTakeFirst();
  const message = await transaction
    .selectFrom("messages")
    .selectAll()
    .where("threadId", "=", input.threadId)
    .where("id", "=", input.messageId)
    .executeTakeFirst();
  if (
    !row ||
    !message ||
    !(await inputEditEligibility(transaction, thread, row, message, input.requestedBy))
  )
    throw new OpensteerError({
      code: "conflict",
      message: "This input is no longer editable or its approval is being completed.",
    });
  return { thread, row, message };
}

export function takeThreadInputLease(
  database: Kysely<DatabaseSchema>,
  input: WaitingInputIdentity & { readonly leaseId: string; readonly takeOver: boolean },
) {
  return withPersonalTransaction(database, async (transaction) => {
    const { thread, row, message } = await editable(transaction, input);
    const live = liveInputLease(transaction, row);
    if (
      live &&
      (live.leaseId !== input.leaseId || row.editLeaseSessionId !== input.sessionId) &&
      !input.takeOver
    )
      assertInputLease(transaction, row, input.leaseId, input.sessionId);
    const lease = {
      leaseId: input.leaseId,
      deviceLabel: input.deviceLabel,
      expiresAt: new Date(
        executionDate(transaction).getTime() + threadInputEditLeaseMs,
      ).toISOString(),
    };
    await transaction
      .updateTable("threadInputs")
      .set({
        editLeaseId: lease.leaseId,
        editLeaseSessionId: input.sessionId,
        editLeaseDeviceLabel: lease.deviceLabel,
        editLeaseExpiresAt: new Date(lease.expiresAt),
      })
      .where("messageId", "=", row.messageId)
      .execute();
    return {
      lease,
      revision: message.revision,
      events: [await leaseChangedEvent(transaction, thread, row.messageId, lease)],
    };
  });
}

export function renewThreadInputLease(
  database: Kysely<DatabaseSchema>,
  input: WaitingInputIdentity & { readonly leaseId: string },
) {
  return withPersonalTransaction(database, async (transaction) => {
    const { row } = await editable(transaction, input);
    if (!liveInputLease(transaction, row))
      throw new OpensteerError({ code: "conflict", message: "The edit lease expired." });
    assertInputLease(transaction, row, input.leaseId, input.sessionId);
    const expiresAt = new Date(executionDate(transaction).getTime() + threadInputEditLeaseMs);
    const saved = await transaction
      .updateTable("threadInputs")
      .set({ editLeaseExpiresAt: expiresAt })
      .where("messageId", "=", row.messageId)
      .returningAll()
      .executeTakeFirstOrThrow();
    return { lease: liveInputLease(transaction, saved)!, events: [] };
  });
}

export function releaseThreadInputLease(
  database: Kysely<DatabaseSchema>,
  input: WaitingInputIdentity & { readonly leaseId?: string },
) {
  return withPersonalTransaction(database, async (transaction) => {
    await requirePersonalOwner(transaction, input.requestedBy);
    const thread = await lockInputQueueProjection(transaction, input.threadId);
    const row = await transaction
      .selectFrom("threadInputs")
      .selectAll()
      .where("threadId", "=", input.threadId)
      .where("messageId", "=", input.messageId)
      .executeTakeFirst();
    if (
      !row ||
      !row.editLeaseId ||
      (input.leaseId &&
        (row.editLeaseId !== input.leaseId || row.editLeaseSessionId !== input.sessionId))
    )
      return { events: [], revokedGrants: [] };
    await transaction
      .updateTable("threadInputs")
      .set(clearInputLease)
      .where("messageId", "=", row.messageId)
      .execute();
    const event = await leaseChangedEvent(transaction, thread, row.messageId, null);
    const advanced = await advanceThreadQueue(transaction, thread);
    return { ...advanced, events: [event, ...advanced.events] };
  });
}

export function editThreadInput(
  database: Kysely<DatabaseSchema>,
  input: WaitingInputIdentity & {
    readonly leaseId?: string | undefined;
    readonly expectedRevision: number;
    readonly content: readonly unknown[];
    readonly idempotencyKey: string;
  },
) {
  return withPersonalTransaction(database, async (transaction) => {
    await requirePersonalOwner(transaction, input.requestedBy);
    await lockCommandIdempotency(transaction, input.requestedBy, input.idempotencyKey);
    const request = {
      threadId: input.threadId,
      messageId: input.messageId,
      content: input.content,
      expectedRevision: input.expectedRevision,
      ...(input.leaseId ? { leaseId: input.leaseId } : {}),
    };
    const receipt = await transaction
      .selectFrom("commands")
      .selectAll()
      .where("requestedBy", "=", input.requestedBy)
      .where("idempotencyKey", "=", input.idempotencyKey)
      .executeTakeFirst();
    if (receipt) {
      const payload = receipt.payload as Record<string, unknown>;
      if (receipt.type !== "thread.input.edit" || !isDeepStrictEqual(payload.request, request))
        throw idempotencyConflict(input.idempotencyKey);
      return {
        message: MessageViewSchema.parse(payload.message),
        edit: MessageEditSchema.parse(payload.edit),
        events: [],
        revokedGrants: [],
      };
    }
    const { thread, row, message } = await editable(transaction, input);
    assertInputLease(transaction, row, input.leaseId, input.sessionId);
    if (message.revision !== input.expectedRevision)
      throw new OpensteerError({
        code: "conflict",
        message: "This message changed on another device.",
      });
    const content = MessageContentSchema.parse(input.content);
    const remaining = ContentPartSchema.array()
      .parse(message.content)
      .filter((part) => part.type !== "text");
    for (const part of content.filter((part) => part.type !== "text")) {
      const index = remaining.findIndex((original) => isDeepStrictEqual(original, part));
      if (index < 0)
        throw new OpensteerError({
          code: "bad_request",
          message: "An edit may only keep or remove existing attachments and places.",
        });
      remaining.splice(index, 1);
    }
    await assertThreadInputCapacity(
      transaction,
      thread.id,
      Buffer.byteLength(JSON.stringify(content)),
      "queue",
      message.id,
    );
    const now = executionDate(transaction);
    const principal = await transaction
      .selectFrom("principals")
      .select(["id", "displayName"])
      .where("kind", "=", "user")
      .where("userId", "=", input.requestedBy)
      .executeTakeFirstOrThrow();
    const author = MessageAuthorSchema.parse({
      kind: "human",
      userId: input.requestedBy,
      principalId: principal.id,
      displayName: principal.displayName,
    });
    if (message.revision === 0)
      await transaction
        .insertInto("messageRevisions")
        .values({
          messageId: message.id,
          revision: 0,
          content: jsonValue(message.content),
          author: jsonValue(message.author),
          deviceLabel: null,
          createdAt: message.createdAt,
        })
        .execute();
    await transaction
      .insertInto("messageRevisions")
      .values({
        messageId: message.id,
        revision: message.revision + 1,
        content: jsonValue(content),
        author: jsonValue(author),
        deviceLabel: input.deviceLabel,
        createdAt: now,
      })
      .execute();
    const updated = await transaction
      .updateTable("messages")
      .set({ content: jsonValue(content), revision: message.revision + 1, editedAt: now })
      .where("id", "=", message.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    const updatedInput = await transaction
      .updateTable("threadInputs")
      .set({ ...clearInputLease, updatedAt: now })
      .where("messageId", "=", message.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    const view = messageViewFromRow(updated);
    const edit = view.edit!;
    await transaction
      .insertInto("commands")
      .values({
        id: createId("command"),
        type: "thread.input.edit",
        requestedBy: input.requestedBy,
        idempotencyKey: input.idempotencyKey,
        threadId: thread.id,
        runId: null,
        environmentId: thread.environmentId,
        actorPrincipalId: row.actorPrincipalId,
        authoritySource: row.authoritySource,
        dispatcherId: null,
        status: "succeeded",
        lastError: null,
        payload: jsonValue({ request, message: view, edit }),
      })
      .execute();
    const events = [
      await appendHostDeploymentEvent(transaction, {
        type: "message.updated",
        threadId: thread.id,
        runId: null,
        environmentId: thread.environmentId,
        data: { message: messageFromRow(updated), input: threadInputFromRow(updatedInput), edit },
      }),
      await leaseChangedEvent(transaction, thread, row.messageId, null),
    ];
    const advanced = await advanceThreadQueue(transaction, thread);
    return { message: view, edit, ...advanced, events: [...events, ...advanced.events] };
  });
}

export function listMessageRevisions(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
    readonly requestedBy: UserId;
    readonly before?: number | undefined;
  },
) {
  return withPersonalReadTransaction(database, async (transaction) => {
    await requirePersonalOwner(transaction, input.requestedBy);
    const message = await transaction
      .selectFrom("messages")
      .selectAll()
      .where("threadId", "=", input.threadId)
      .where("id", "=", input.messageId)
      .executeTakeFirst();
    if (!message) throw new OpensteerError({ code: "not_found", message: "Message not found" });
    const rows = await transaction
      .selectFrom("messageRevisions")
      .selectAll()
      .where("messageId", "=", input.messageId)
      .$if(input.before !== undefined, (q) => q.where("revision", "<", input.before!))
      .orderBy("revision", "desc")
      .limit(messageRevisionsPageSize + 1)
      .execute();
    const revisions = [];
    let bytes = 0;
    for (const row of rows.slice(0, messageRevisionsPageSize)) {
      const item = MessageRevisionViewSchema.parse({
        ...row,
        createdAt: row.createdAt.toISOString(),
      });
      const size = Buffer.byteLength(JSON.stringify(item));
      if (bytes + size > 2 * 1024 * 1024) break;
      bytes += size;
      revisions.push(item);
    }
    if (rows.length && !revisions.length)
      throw new OpensteerError({
        code: "resource_exhausted",
        message: "Message revision exceeds the history byte window",
      });
    return { revisions, hasMore: revisions.length < rows.length };
  });
}

export async function expireThreadInputLeases(database: Kysely<DatabaseSchema>) {
  const affected = await database
    .selectFrom("threadInputs")
    .select("threadId")
    .distinct()
    .where("editLeaseExpiresAt", "<=", executionDate(database))
    .orderBy("threadId")
    .limit(100)
    .execute();
  const events: AgentEvent[] = [];
  const revokedGrants = [];
  for (const { threadId } of affected) {
    const result = await withPersonalTransaction(database, async (transaction) => {
      const thread = await lockInputQueueProjection(transaction, threadId);
      const expired = await transaction
        .selectFrom("threadInputs")
        .selectAll()
        .where("threadId", "=", threadId)
        .where("editLeaseExpiresAt", "<=", executionDate(transaction))
        .orderBy("messageId")
        .execute();
      const changed: AgentEvent[] = [];
      for (const row of expired) {
        await transaction
          .updateTable("threadInputs")
          .set(clearInputLease)
          .where("messageId", "=", row.messageId)
          .execute();
        changed.push(await leaseChangedEvent(transaction, thread, row.messageId, null));
      }
      const advanced = await advanceThreadQueue(transaction, thread);
      return { ...advanced, events: [...changed, ...advanced.events] };
    });
    events.push(...result.events);
    revokedGrants.push(...result.revokedGrants);
  }
  return { events, revokedGrants };
}
