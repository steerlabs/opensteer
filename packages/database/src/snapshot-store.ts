import { withDatabaseTransaction } from "./connection.js";
import {
  type UserId,
  type AgentEvent,
  type Sequence,
  type ThreadId,
  type MessageView,
  type PendingRequest,
  type ThreadRunQueueEntry,
  type Thread,
  OpensteerError,
  type WorkspaceId,
  nonTerminalRunStatuses,
  PendingRequestSchema,
  ThreadIdSchema,
  type MessageId,
  SequenceSchema,
} from "@opensteer/core";
import {
  type WorkspaceSnapshot,
  type WorkspaceView,
  workspaceSnapshotMaxThreads,
  workspaceSnapshotMaxMessages,
  workspaceSnapshotMaxSerializedBytes,
  workspaceSnapshotMaxPendingRequests,
  workspaceViewFromWorkspace,
  threadPageMaxItems,
  type ThreadMessagePage,
  type ThreadEventPage,
  type TaskPage,
  eventPageMaxItems,
  taskLineMaxLength,
  turnPageMaxItems,
  turnPageMaxTurns,
} from "@opensteer/protocol";
import { plainTextExcerpt } from "@opensteer/shared/plainTextExcerpt";
import { serializedArrayBytes, boundedSerializedPrefix } from "./message-window.js";
import {
  encodeWindowCursor,
  boundedWindowLimit,
  boundedWindowBytes,
  messageWasNotWithdrawn,
  safeCount,
  decodeWindowCursor,
  invalidWindowCursor,
  eventFromRow,
  isLegacyLiveEventType,
} from "./store-primitives.js";
import { type Kysely, type Transaction, sql } from "kysely";
import { type DatabaseSchema, legacyLiveEventTypes } from "./schema.js";
import { NotificationStateStore } from "./notification-state.js";
import {
  threadPendingRequestsSelection,
  threadProviderSessionSelection,
  threadContinuationIdentitySelection,
  threadsFromRows,
  messageFromRow,
  threadRunQueueEntriesFromRows,
  threadFromRow,
} from "./thread-row-mappers.js";
import { requestFromRow } from "./request-store.js";
import { workspaceFromRow } from "./store-primitives.js";
import { type ThreadHistoryQuery, readThreadHistory } from "./thread-history.js";
import { publishedMessagePredicate } from "./message-visibility.js";

export interface DurableWindowReadOptions {
  readonly maxBytes?: number;
  readonly maxItems?: number;
}

export interface WorkspaceSnapshotReadOptions {
  /** Skip message history and its counts; clients must read durable history on open. */
  readonly omitMessages?: boolean;
  readonly viewerId?: UserId;
  readonly maxMessages?: number;
  readonly maxSerializedBytes?: number;
  readonly maxThreads?: number;
  /** Only the Threads navigation lists, which is what a person's client reads. */
  readonly listedOnly?: boolean;
}

export interface EventReplayWindow {
  readonly byteCount: number;
  readonly events: readonly AgentEvent[];
  readonly hasMore: boolean;
  /**
   * The last sequence this window accounts for, including skipped legacy
   * streaming rows. A reader resumes after it, never after the last event.
   */
  readonly scannedThrough: Sequence;
}

function buildWorkspaceSnapshot(input: {
  readonly readStates: WorkspaceSnapshot["readStates"];
  readonly notificationPreferences: WorkspaceSnapshot["notificationPreferences"];
  readonly messageTotals: ReadonlyMap<ThreadId, number>;
  readonly omitMessages: boolean;
  readonly messagesDesc: readonly MessageView[];
  readonly pendingRequestTotal: number;
  readonly pendingRequestsDesc: readonly PendingRequest[];
  readonly runQueue: readonly ThreadRunQueueEntry[];
  readonly sequence: Sequence;
  readonly threadTotal: number;
  readonly threads: readonly Thread[];
  readonly workspace: WorkspaceView;
}): WorkspaceSnapshot {
  const messages = [...input.messagesDesc].reverse();
  const pendingRequests = [...input.pendingRequestsDesc].reverse();
  const messageWindows = (input.omitMessages ? [] : input.threads).map((thread) => {
    const threadMessages = messages.filter((message) => message.threadId === thread.id);
    const totalItems = input.messageTotals.get(thread.id) ?? 0;
    const hasMore = totalItems > threadMessages.length;
    const oldest = threadMessages.at(0);
    return {
      byteCount: serializedArrayBytes(threadMessages),
      hasMore,
      itemCount: threadMessages.length,
      nextBefore:
        hasMore && oldest
          ? encodeWindowCursor("message", thread.id, oldest.createdAt, oldest.id)
          : null,
      threadId: thread.id,
      totalItems,
    };
  });
  const hasMoreThreads = input.threadTotal > input.threads.length;
  const oldestThread = input.threads.at(-1);
  let snapshot: WorkspaceSnapshot = {
    readStates: input.readStates,
    notificationPreferences: input.notificationPreferences,
    messages,
    messageWindows,
    ...(input.omitMessages ? { messagesOmitted: true } : {}),
    pendingRequests,
    pendingRequestWindow: {
      byteCount: serializedArrayBytes(pendingRequests),
      hasMore: input.pendingRequestTotal > pendingRequests.length,
      itemCount: pendingRequests.length,
      nextBefore: null,
      totalItems: input.pendingRequestTotal,
    },
    runQueue: [...input.runQueue],
    sequence: input.sequence,
    serializedBytes: 1,
    threads: [...input.threads],
    threadWindow: {
      byteCount: serializedArrayBytes(input.threads),
      hasMore: hasMoreThreads,
      itemCount: input.threads.length,
      nextBefore:
        hasMoreThreads && oldestThread
          ? encodeWindowCursor(
              "thread",
              input.workspace.id,
              oldestThread.updatedAt,
              oldestThread.id,
            )
          : null,
      totalItems: input.threadTotal,
    },
    workspace: input.workspace,
  };
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const serializedBytes = Buffer.byteLength(JSON.stringify(snapshot), "utf8");
    if (snapshot.serializedBytes === serializedBytes) return snapshot;
    snapshot = { ...snapshot, serializedBytes };
  }
  throw new OpensteerError({
    code: "internal",
    message: "Workspace snapshot byte accounting did not converge",
  });
}

export async function workspaceSnapshot(
  database: Kysely<DatabaseSchema>,
  notificationState: NotificationStateStore,
  workspaceId: WorkspaceId,
  options: WorkspaceSnapshotReadOptions = {},
): Promise<WorkspaceSnapshot> {
  const maxThreads = boundedWindowLimit(options.maxThreads, workspaceSnapshotMaxThreads);
  const maxMessages = boundedWindowLimit(options.maxMessages, workspaceSnapshotMaxMessages);
  const maxSerializedBytes = boundedWindowBytes(
    options.maxSerializedBytes,
    workspaceSnapshotMaxSerializedBytes,
  );
  return withDatabaseTransaction(
    database,
    async (transaction) => {
      const workspace = await transaction
        .selectFrom("workspaces")
        .selectAll()
        .where("id", "=", workspaceId)
        .executeTakeFirst();
      if (!workspace)
        throw new OpensteerError({ code: "not_found", message: "Workspace not found" });
      const [threadRows, threadCountRow] = await Promise.all([
        transaction
          .selectFrom("threads")
          .selectAll()
          .select([
            threadPendingRequestsSelection,
            threadProviderSessionSelection,
            threadContinuationIdentitySelection,
          ])
          .where("workspaceId", "=", workspaceId)
          .$if(options.listedOnly === true, (query) => query.where("listed", "=", true))
          .orderBy("updatedAt", "desc")
          .orderBy("id", "desc")
          .limit(maxThreads + 1)
          .execute(),
        transaction
          .selectFrom("threads")
          .select(({ fn }) => fn.countAll<string>().as("count"))
          .where("workspaceId", "=", workspaceId)
          .$if(options.listedOnly === true, (query) => query.where("listed", "=", true))
          .executeTakeFirstOrThrow(),
      ]);
      const threads = boundedSerializedPrefix(
        threadsFromRows(threadRows.slice(0, maxThreads)),
        maxThreads,
        Math.min(192 * 1_024, maxSerializedBytes),
      );
      const threadIds = threads.items.map(({ id }) => id);
      const [messageRows, messageCountRows, pendingRows, pendingCountRow, runQueueRows] =
        threadIds.length === 0
          ? [[], [], [], { count: "0" }, []]
          : await Promise.all([
              options.omitMessages
                ? []
                : transaction
                    .selectFrom("messages")
                    .leftJoin("threadInputs", "threadInputs.messageId", "messages.id")
                    .selectAll("messages")
                    .select("threadInputs.policy")
                    .select(publishedMessagePredicate("threadInputs").as("published"))
                    .where("messages.threadId", "in", threadIds)
                    .where(messageWasNotWithdrawn)
                    .orderBy("messages.createdAt", "desc")
                    .orderBy("messages.id", "desc")
                    .limit(maxMessages + 1)
                    .execute(),
              options.omitMessages
                ? []
                : transaction
                    .selectFrom("messages")
                    .select(["threadId", ({ fn }) => fn.countAll<string>().as("count")])
                    .where("threadId", "in", threadIds)
                    .where(messageWasNotWithdrawn)
                    .groupBy("threadId")
                    .execute(),
              transaction
                .selectFrom("requests")
                .selectAll()
                .where("originatingThreadId", "in", threadIds)
                .where("status", "=", "pending")
                .orderBy("createdAt", "desc")
                .orderBy("id", "desc")
                .limit(workspaceSnapshotMaxPendingRequests + 1)
                .execute(),
              transaction
                .selectFrom("requests")
                .select(({ fn }) => fn.countAll<string>().as("count"))
                .where("originatingThreadId", "in", threadIds)
                .where("status", "=", "pending")
                .executeTakeFirstOrThrow(),
              transaction
                .selectFrom("runs")
                .select(["createdAt", "id", "status", "threadId", "runOrdinal"])
                .where("threadId", "in", threadIds)
                .where("status", "in", nonTerminalRunStatuses)
                .orderBy("threadId", "asc")
                .orderBy("runOrdinal", "asc")
                .execute(),
            ]);
      const messageTotals = new Map(
        messageCountRows.map((row) => [row.threadId, safeCount(row.count)]),
      );
      let messagesDesc = boundedSerializedPrefix(
        messageRows.slice(0, maxMessages).map(({ policy, published, ...row }): MessageView => ({
          ...messageFromRow(row),
          ...(row.addressedToUserId ? { addressedToUserId: row.addressedToUserId } : {}),
          published,
          ...(policy ? { policy } : {}),
        })),
        maxMessages,
        Math.min(640 * 1_024, maxSerializedBytes),
      ).items;
      let pendingRequestsDesc = boundedSerializedPrefix(
        PendingRequestSchema.array().parse(
          pendingRows.slice(0, workspaceSnapshotMaxPendingRequests).map(requestFromRow),
        ),
        workspaceSnapshotMaxPendingRequests,
        Math.min(600 * 1_024, maxSerializedBytes),
      ).items;
      const runQueue = threadRunQueueEntriesFromRows(runQueueRows);

      const readStates = options.viewerId
        ? [
            ...(await notificationState.listReadStates({
              database: transaction,
              userId: options.viewerId,
              threadIds,
            })),
          ]
        : [];
      const notificationPreferences = options.viewerId
        ? [
            ...(await notificationState.listWorkspacePreferences({
              database: transaction,
              userId: options.viewerId,
              workspaceIds: [workspaceId],
            })),
          ]
        : [];
      const workspaceView = workspaceViewFromWorkspace(workspaceFromRow(workspace));
      let snapshot = buildWorkspaceSnapshot({
        readStates,
        notificationPreferences,
        messageTotals,
        omitMessages: options.omitMessages === true,
        messagesDesc,
        pendingRequestTotal: safeCount(pendingCountRow.count),
        pendingRequestsDesc,
        runQueue,
        sequence: workspace.eventSequence as Sequence,
        threadTotal: safeCount(threadCountRow.count),
        threads: threads.items,
        workspace: workspaceView,
      });
      while (snapshot.serializedBytes > maxSerializedBytes && messagesDesc.length > 0) {
        messagesDesc = messagesDesc.slice(0, -1);
        snapshot = buildWorkspaceSnapshot({
          readStates,
          notificationPreferences,
          messageTotals,
          omitMessages: options.omitMessages === true,
          messagesDesc,
          pendingRequestTotal: safeCount(pendingCountRow.count),
          pendingRequestsDesc,
          runQueue,
          sequence: workspace.eventSequence as Sequence,
          threadTotal: safeCount(threadCountRow.count),
          threads: threads.items,
          workspace: workspaceView,
        });
      }
      while (snapshot.serializedBytes > maxSerializedBytes && pendingRequestsDesc.length > 0) {
        pendingRequestsDesc = pendingRequestsDesc.slice(0, -1);
        snapshot = buildWorkspaceSnapshot({
          readStates,
          notificationPreferences,
          messageTotals,
          omitMessages: options.omitMessages === true,
          messagesDesc,
          pendingRequestTotal: safeCount(pendingCountRow.count),
          pendingRequestsDesc,
          runQueue,
          sequence: workspace.eventSequence as Sequence,
          threadTotal: safeCount(threadCountRow.count),
          threads: threads.items,
          workspace: workspaceView,
        });
      }
      if (snapshot.serializedBytes > maxSerializedBytes) {
        throw new OpensteerError({
          code: "internal",
          message: "Workspace snapshot metadata exceeds its serialized byte ceiling",
        });
      }
      return snapshot;
    },
    "repeatable read",
  );
}

/**
 * How much of a reply or failure its task line is made from. Markdown comes
 * out of it after, so it is more than the line it makes; the database reads
 * at most eight times this of a message, never a large one whole.
 */
const taskLineSourceCharacters = 2_048;

/**
 * The reader's tasks across every Workspace they actively belong to, or in the
 * one named: listed, unarchived Threads, most recently updated first, each
 * with what it last said and why its latest Run failed when it did, and the
 * reader's read state. A cursor continues only the list it came from.
 */
export async function taskPageForUser(
  database: Kysely<DatabaseSchema>,
  notificationState: NotificationStateStore,
  input: {
    readonly active?: boolean;
    readonly before?: string;
    readonly maxBytes?: number;
    readonly maxItems?: number;
    readonly userId: UserId;
    readonly workspaceId?: WorkspaceId;
  },
): Promise<TaskPage> {
  const maxItems = boundedWindowLimit(input.maxItems, threadPageMaxItems);
  const maxBytes = boundedWindowBytes(input.maxBytes, 256 * 1_024);
  const readerScope = input.workspaceId ? `${input.userId}:${input.workspaceId}` : input.userId;
  const scope = input.active ? `${readerScope}:active` : readerScope;
  const anchor = input.before ? decodeWindowCursor(input.before, "task", scope) : null;
  if (anchor && !ThreadIdSchema.safeParse(anchor.id).success) throw invalidWindowCursor();
  // A Thread view carries its update time to the millisecond, so the list is
  // ordered at that precision: a cursor then names exactly the place the
  // reader stopped, even between Threads updated within one millisecond.
  const updatedAt = sql<Date>`date_trunc('milliseconds', threads.updated_at)`;
  return withDatabaseTransaction(
    database,
    async (transaction) => {
      let tasks = transaction
        .selectFrom("threads")
        .innerJoin("workspaces", "workspaces.id", "threads.workspaceId")
        .innerJoin(
          "workspaceMemberships",
          "workspaceMemberships.workspaceId",
          "threads.workspaceId",
        )
        .innerJoin("users", "users.id", "workspaceMemberships.userId")
        .where("workspaceMemberships.userId", "=", input.userId)
        .where("workspaceMemberships.state", "=", "active")
        .where("users.disabledAt", "is", null)
        .where("workspaces.status", "!=", "deleted")
        .where("threads.listed", "=", true)
        .where("threads.status", "!=", "archived");
      if (input.active) tasks = tasks.where("threads.status", "in", ["running", "waiting"]);
      if (input.workspaceId) {
        const member = await transaction
          .selectFrom("workspaceMemberships")
          .innerJoin("workspaces", "workspaces.id", "workspaceMemberships.workspaceId")
          .innerJoin("users", "users.id", "workspaceMemberships.userId")
          .select("workspaceMemberships.workspaceId")
          .where("workspaceMemberships.workspaceId", "=", input.workspaceId)
          .where("workspaceMemberships.userId", "=", input.userId)
          .where("workspaceMemberships.state", "=", "active")
          .where("users.disabledAt", "is", null)
          .where("workspaces.status", "!=", "deleted")
          .executeTakeFirst();
        if (!member)
          throw new OpensteerError({ code: "not_found", message: "Workspace not found" });
        tasks = tasks.where("threads.workspaceId", "=", input.workspaceId);
      }
      let page = tasks
        .selectAll("threads")
        .select([
          threadPendingRequestsSelection,
          threadProviderSessionSelection,
          threadContinuationIdentitySelection,
        ]);
      if (anchor) {
        page = page.where(
          sql<boolean>`(${updatedAt}, threads.id) < (${anchor.timestamp}::timestamptz, ${anchor.id}::text)`,
        );
      }
      const [rows, countRow] = await Promise.all([
        page
          .orderBy(updatedAt, "desc")
          .orderBy("threads.id", "desc")
          .limit(maxItems + 1)
          .execute(),
        tasks.select(({ fn }) => fn.countAll<string>().as("count")).executeTakeFirstOrThrow(),
      ]);
      const threads = threadsFromRows(rows.slice(0, maxItems));
      const lines = await taskLines(
        transaction,
        threads.map(({ id }) => id),
      );
      const window = boundedSerializedPrefix(
        threads.map((thread) => ({
          failure: lines.get(thread.id)?.failure ?? null,
          lastReply: lines.get(thread.id)?.lastReply ?? null,
          thread,
        })),
        maxItems,
        maxBytes,
      );
      const hasMore = rows.length > window.items.length;
      const oldest = window.items.at(-1)?.thread;
      return {
        readStates: [
          ...(await notificationState.listReadStates({
            database: transaction,
            userId: input.userId,
            threadIds: window.items.map(({ thread }) => thread.id),
          })),
        ],
        tasks: [...window.items],
        window: {
          byteCount: window.byteCount,
          hasMore,
          itemCount: window.items.length,
          nextBefore:
            hasMore && oldest
              ? encodeWindowCursor("task", scope, oldest.updatedAt, oldest.id)
              : null,
          totalItems: safeCount(countRow.count),
        },
      };
    },
    "repeatable read",
  );
}

/**
 * Each task's last reply and failure as plain lines. The reply is the first
 * words of the newest published assistant message that says something; the
 * failure is the newest Run's, only when that Run failed. Both are cut in the
 * database, so a large message never leaves it whole.
 */
async function taskLines(
  transaction: Transaction<DatabaseSchema>,
  threadIds: readonly ThreadId[],
): Promise<ReadonlyMap<ThreadId, { lastReply: string | null; failure: string | null }>> {
  if (threadIds.length === 0) return new Map();
  // Whitespace collapses before the line is cut, a run that holds a line
  // break into one break so Markdown that starts a line is still recognised
  // when the excerpt is made.
  const rows = await sql<{
    threadId: ThreadId;
    reply: string | null;
    failure: string | null;
  }>`
    select thread.id as thread_id,
      left(
        regexp_replace(
          regexp_replace(left(reply.text, ${8 * taskLineSourceCharacters}), '\\s*\\n\\s*', E'\\n', 'g'),
          '[[:blank:]]+', ' ', 'g'),
        ${taskLineSourceCharacters}) as reply,
      case when latest_run.status = 'failed'
        then left(latest_run.failure->>'message', ${taskLineSourceCharacters})
      end as failure
    from public.threads thread
    left join lateral (
      select (
        select part.value->>'text'
        from jsonb_array_elements(message.content) with ordinality as part(value, position)
        where part.value->>'type' = 'text' and part.value->>'text' ~ '\\S'
        order by part.position
        limit 1
      ) as text
      from public.messages message
      left join public.thread_inputs inbox on inbox.message_id = message.id
      where message.thread_id = thread.id
        and message.kind = 'assistant'
        and ${publishedMessagePredicate("inbox")}
        and exists (
          select 1 from jsonb_array_elements(message.content) as part(value)
          where part.value->>'type' in ('artifact', 'browser-page', 'computer-app', 'phone')
            or (part.value->>'type' = 'text' and part.value->>'text' ~ '\\S')
        )
      order by message.sequence desc
      limit 1
    ) reply on true
    left join lateral (
      select run.status, run.failure
      from public.runs run
      where run.thread_id = thread.id
      order by run.run_ordinal desc
      limit 1
    ) latest_run on true
    where thread.id in (${sql.join(threadIds)})
  `.execute(transaction);
  return new Map(
    rows.rows.map((row) => [
      row.threadId,
      {
        failure: row.failure === null ? null : plainTextExcerpt(row.failure, taskLineMaxLength),
        lastReply: row.reply === null ? null : plainTextExcerpt(row.reply, taskLineMaxLength),
      },
    ]),
  );
}

export async function threadMessagePageForOwner(
  database: Kysely<DatabaseSchema>,
  input: ThreadHistoryQuery,
): Promise<ThreadMessagePage | null> {
  return readThreadHistory(database, input);
}

/**
 * Where a history page may begin: where an input lands in the conversation.
 * A queued input lands where a Run placed it, every other one where it was
 * sent, so a queued input's creation is not a turn of its own.
 */
const turnStartSelection = sql<boolean>`(
  type = 'message.placed'
  or (
    type = 'message.created'
    and data #>> '{message,kind}' = 'input'
    and (data #>> '{input,policy}') is distinct from 'queue'
  )
)`;

/**
 * How many of `rows`, newest first, a history page keeps: whole turns until
 * `maxTurns`, or until the next whole turn would cross a bound. Only a newest
 * turn that alone crosses one is cut inside, and never below one event, so
 * paging always advances.
 */
function historyPageLength(
  rows: readonly { readonly bytes: number; readonly turnStart: boolean }[],
  bounds: { readonly maxBytes: number; readonly maxItems: number; readonly maxTurns: number },
): number {
  let bytes = 2;
  let turns = 0;
  let wholeTurns = 0;
  for (const [index, row] of rows.entries()) {
    bytes += row.bytes + (index === 0 ? 0 : 1);
    if (index >= bounds.maxItems || bytes > bounds.maxBytes) {
      return wholeTurns > 0 ? wholeTurns : Math.max(index, 1);
    }
    if (!row.turnStart) continue;
    wholeTurns = index + 1;
    turns += 1;
    if (turns >= bounds.maxTurns) return wholeTurns;
  }
  return rows.length;
}

export async function threadEventPageForOwner(
  database: Kysely<DatabaseSchema>,
  notificationState: NotificationStateStore,
  input: {
    readonly aroundMessageId?: MessageId;
    readonly before?: string;
    readonly maxBytes?: number;
    readonly maxItems?: number;
    /** Whole turns rather than a count of events; such a page may hold up to `turnPageMaxItems`. */
    readonly maxTurns?: number;
    readonly ownerId: UserId;
    readonly threadId: ThreadId;
  },
): Promise<ThreadEventPage | null> {
  const maxItems = boundedWindowLimit(
    input.maxItems,
    input.maxTurns === undefined ? eventPageMaxItems : turnPageMaxItems,
  );
  const maxBytes = boundedWindowBytes(input.maxBytes, 640 * 1_024);
  const maxTurns =
    input.maxTurns === undefined
      ? Number.POSITIVE_INFINITY
      : boundedWindowLimit(input.maxTurns, turnPageMaxTurns);
  let anchor: Sequence | null = null;
  if (input.before !== undefined) {
    const parsed = SequenceSchema.safeParse(input.before);
    if (!parsed.success) throw invalidWindowCursor();
    anchor = parsed.data;
  }
  if (input.aroundMessageId && (anchor !== null || input.maxTurns !== undefined)) {
    throw new OpensteerError({
      code: "bad_request",
      message: "Choose an event cursor or a message anchor",
    });
  }
  return withDatabaseTransaction(
    database,
    async (transaction) => {
      const thread = await transaction
        .selectFrom("threads")
        .innerJoin(
          "workspaceMemberships",
          "workspaceMemberships.workspaceId",
          "threads.workspaceId",
        )
        .selectAll("threads")
        .select([
          threadPendingRequestsSelection,
          threadProviderSessionSelection,
          threadContinuationIdentitySelection,
        ])
        .where("threads.id", "=", input.threadId)
        .where("workspaceMemberships.userId", "=", input.ownerId)
        .where("workspaceMemberships.state", "=", "active")
        .executeTakeFirst();
      if (!thread) return null;
      const [{ events, hasMore }, countRow] = await Promise.all([
        input.aroundMessageId
          ? eventsAroundMessage(transaction, input.threadId, input.aroundMessageId, {
              maxBytes,
              maxItems,
            })
          : newestTurns(transaction, input.threadId, anchor, { maxBytes, maxItems, maxTurns }),
        transaction
          .selectFrom("workspaceEvents")
          .select(({ fn }) => fn.countAll<string>().as("count"))
          .where("threadId", "=", input.threadId)
          .where("type", "not in", legacyLiveEventTypes)
          .executeTakeFirstOrThrow(),
      ]);
      const oldest = events.at(0);
      return {
        readState: await notificationState.getReadState({
          database: transaction,
          userId: input.ownerId,
          threadId: input.threadId,
        }),
        events,
        thread: threadFromRow(thread),
        threadId: input.threadId,
        window: {
          byteCount: serializedArrayBytes(events),
          hasMore,
          itemCount: events.length,
          nextBefore: hasMore && oldest ? oldest.sequence : null,
          threadId: input.threadId,
          totalItems: safeCount(countRow.count),
        },
      };
    },
    "repeatable read",
  );
}

/**
 * The newest whole turns before `before`. Sizes are read first, so a page of
 * large tool calls fetches only the events it returns.
 */
async function newestTurns(
  transaction: Transaction<DatabaseSchema>,
  threadId: ThreadId,
  before: Sequence | null,
  bounds: { readonly maxBytes: number; readonly maxItems: number; readonly maxTurns: number },
): Promise<{ readonly events: AgentEvent[]; readonly hasMore: boolean }> {
  let metadataQuery = transaction
    .selectFrom("workspaceEvents")
    .select([
      "sequence",
      // Stored JSON is written with `, ` and `: `, the wire's without spaces.
      // Dropping them keeps the estimate under what is sent, so the exact pass
      // below only ever trims and never loses a turn that fits.
      sql<number>`octet_length(replace(replace(data::text, ', ', ','), ': ', ':'))`.as("dataBytes"),
      turnStartSelection.as("turnStart"),
    ])
    .where("threadId", "=", threadId)
    .where("type", "not in", legacyLiveEventTypes);
  if (before !== null) metadataQuery = metadataQuery.where("sequence", "<", before);
  const metadata = await metadataQuery
    .orderBy("sequence", "desc")
    .limit(bounds.maxItems + 1)
    .execute();
  const estimated = historyPageLength(
    metadata.map((row) => ({ bytes: Number(row.dataBytes), turnStart: row.turnStart })),
    bounds,
  );
  const oldest = metadata[estimated - 1];
  if (!oldest) return { events: [], hasMore: false };
  let rowsQuery = transaction
    .selectFrom("workspaceEvents")
    .selectAll()
    .where("threadId", "=", threadId)
    .where("type", "not in", legacyLiveEventTypes)
    .where("sequence", ">=", oldest.sequence);
  if (before !== null) rowsQuery = rowsQuery.where("sequence", "<", before);
  const candidates = (await rowsQuery.orderBy("sequence", "desc").execute()).map(eventFromRow);
  // The page is bounded by what it sends, never by the estimate.
  const kept = historyPageLength(
    candidates.map((event, index) => ({
      bytes: Buffer.byteLength(JSON.stringify(event), "utf8"),
      turnStart: metadata[index]?.turnStart ?? false,
    })),
    bounds,
  );
  return {
    events: candidates.slice(0, kept).reverse(),
    hasMore: kept < metadata.length,
  };
}

/** The events nearest a message, which leads, then alternately older and newer. */
async function eventsAroundMessage(
  transaction: Transaction<DatabaseSchema>,
  threadId: ThreadId,
  messageId: MessageId,
  bounds: { readonly maxBytes: number; readonly maxItems: number },
): Promise<{ readonly events: AgentEvent[]; readonly hasMore: boolean }> {
  const { maxBytes, maxItems } = bounds;
  const visibleMessage = await transaction
    .selectFrom("messages")
    .leftJoin("threadInputs", "threadInputs.messageId", "messages.id")
    .select("messages.id")
    .where("messages.id", "=", messageId)
    .where("messages.threadId", "=", threadId)
    .where(publishedMessagePredicate("threadInputs"))
    .executeTakeFirst();
  if (!visibleMessage) {
    throw new OpensteerError({
      code: "not_found",
      message: "Message is unavailable in this conversation",
    });
  }
  const target = await transaction
    .selectFrom("workspaceEvents")
    .select("sequence")
    .where("threadId", "=", threadId)
    .where("type", "in", ["message.created", "message.placed", "assistant.message"])
    .where(
      sql<boolean>`(data #>> '{message,id}' = ${messageId} or data ->> 'messageId' = ${messageId})`,
    )
    .orderBy("sequence", "desc")
    .executeTakeFirst();
  if (!target) {
    throw new OpensteerError({
      code: "not_found",
      message: "Message has no retained event",
    });
  }
  const aroundSequence = target.sequence as Sequence;
  const query = transaction
    .selectFrom("workspaceEvents")
    .selectAll()
    .where("threadId", "=", threadId)
    .where("type", "not in", legacyLiveEventTypes);
  const [later, centre, earlier] = await Promise.all([
    query
      .where("sequence", ">", aroundSequence)
      .orderBy("sequence", "asc")
      .limit(Math.floor((maxItems - 1) / 2))
      .execute(),
    query.where("sequence", "=", aroundSequence).executeTakeFirstOrThrow(),
    query
      .where("sequence", "<", aroundSequence)
      .orderBy("sequence", "desc")
      .limit(Math.ceil((maxItems - 1) / 2))
      .execute(),
  ]);
  const prioritized = [centre];
  for (let index = 0; index < maxItems - 1; index += 1) {
    const older = earlier[index];
    const newer = later[index];
    if (older) prioritized.push(older);
    if (newer) prioritized.push(newer);
  }
  const selected: AgentEvent[] = [];
  let byteCount = 2;
  for (const candidate of prioritized.map(eventFromRow)) {
    if (selected.length >= maxItems) break;
    const nextBytes =
      byteCount +
      Buffer.byteLength(JSON.stringify(candidate), "utf8") +
      (selected.length === 0 ? 0 : 1);
    if (nextBytes > maxBytes) {
      if (selected.length === 0) {
        throw new OpensteerError({
          code: "internal",
          message: "The anchored event exceeds the history byte ceiling",
        });
      }
      continue;
    }
    selected.push(candidate);
    byteCount = nextBytes;
  }
  const events = selected.sort((left, right) =>
    BigInt(left.sequence) < BigInt(right.sequence)
      ? -1
      : BigInt(left.sequence) > BigInt(right.sequence)
        ? 1
        : 0,
  );
  const oldest = events.at(0);
  const hasMore = oldest
    ? Boolean(
        await query.select("eventId").where("sequence", "<", oldest.sequence).executeTakeFirst(),
      )
    : false;
  return { events, hasMore };
}

export async function eventsAfter(
  database: Kysely<DatabaseSchema>,
  workspaceId: WorkspaceId,
  afterSequence: Sequence,
  limit = 500,
): Promise<readonly AgentEvent[]> {
  return (
    await eventsAfterWindow(database, workspaceId, afterSequence, {
      maxBytes: 8 * 1_024 * 1_024,
      maxItems: limit,
    })
  ).events;
}

export async function eventsAfterWindow(
  database: Kysely<DatabaseSchema>,
  workspaceId: WorkspaceId,
  afterSequence: Sequence,
  options: {
    readonly maxBytes: number;
    readonly maxItems: number;
    readonly throughSequence?: Sequence;
  },
): Promise<EventReplayWindow> {
  const maxItems = boundedWindowLimit(options.maxItems, 10_000);
  const maxBytes = boundedWindowBytes(options.maxBytes, 8 * 1_024 * 1_024);
  return withDatabaseTransaction(
    database,
    async (transaction) => {
      let metadataQuery = transaction
        .selectFrom("workspaceEvents")
        .select(["sequence", "type", sql<number>`pg_column_size(data)`.as("dataBytes")])
        .where("workspaceId", "=", workspaceId)
        .where("sequence", ">", afterSequence);
      if (options.throughSequence) {
        metadataQuery = metadataQuery.where("sequence", "<=", options.throughSequence);
      }
      const metadata = await metadataQuery
        .orderBy("sequence", "asc")
        .limit(maxItems + 1)
        .execute();
      // Rows are scanned in order; legacy streaming rows are skipped but still
      // scanned, so a window made only of them advances the reader instead of
      // looking like the end of the log.
      const scanned: { readonly sequence: Sequence; readonly selected: boolean }[] = [];
      const selectedSequences: Sequence[] = [];
      let estimatedBytes = 2;
      let fullWindow = false;
      for (const row of metadata.slice(0, maxItems)) {
        if (isLegacyLiveEventType(row.type)) {
          scanned.push({ selected: false, sequence: row.sequence as Sequence });
          continue;
        }
        const nextBytes = estimatedBytes + Number(row.dataBytes) + 2_048;
        if (nextBytes > maxBytes) {
          fullWindow = true;
          break;
        }
        selectedSequences.push(row.sequence as Sequence);
        scanned.push({ selected: true, sequence: row.sequence as Sequence });
        estimatedBytes = nextBytes;
      }
      if (fullWindow && selectedSequences.length === 0) {
        throw new OpensteerError({
          code: "internal",
          message: "A durable event exceeds the replay byte ceiling",
        });
      }
      const rows =
        selectedSequences.length === 0
          ? []
          : await transaction
              .selectFrom("workspaceEvents")
              .selectAll()
              .where("workspaceId", "=", workspaceId)
              .where("sequence", "in", selectedSequences)
              .orderBy("sequence", "asc")
              .execute();
      const exact = boundedSerializedPrefix(rows.map(eventFromRow), maxItems, maxBytes);
      if (rows.length > 0 && exact.items.length === 0) {
        throw new OpensteerError({
          code: "internal",
          message: "A durable event exceeds the replay byte ceiling",
        });
      }
      // The window ends at the last row it accounted for: every skipped
      // legacy row up to the first selected event the byte bound cut off.
      let scannedThrough = afterSequence;
      let included = 0;
      for (const row of scanned) {
        if (row.selected) {
          if (included >= exact.items.length) break;
          included += 1;
        }
        scannedThrough = row.sequence;
      }
      const reachedEnd =
        !fullWindow &&
        metadata.length <= maxItems &&
        included === scanned.filter((row) => row.selected).length;
      if (reachedEnd && options.throughSequence) scannedThrough = options.throughSequence;
      return {
        byteCount: exact.byteCount,
        events: exact.items,
        hasMore: !reachedEnd,
        scannedThrough,
      };
    },
    "repeatable read",
  );
}

export async function workspaceHead(
  database: Kysely<DatabaseSchema>,
  workspaceId: WorkspaceId,
): Promise<Sequence> {
  const row = await database
    .selectFrom("workspaces")
    .select("eventSequence")
    .where("id", "=", workspaceId)
    .executeTakeFirst();
  if (!row) throw new OpensteerError({ code: "not_found", message: "Workspace not found" });
  return row.eventSequence as Sequence;
}
