import { deploymentEventsAfter } from "./deployment-events.js";
import { needsYouPage } from "./needs-you-store.js";
import { personalSettings } from "./personal-settings-store.js";
export { deploymentHead } from "./deployment-events.js";
import { requirePersonalOwner } from "./personal-settings-store.js";
import type { DeploymentId } from "@opensteer/core";
import { withPersonalReadTransaction } from "./personal-transaction.js";
import { type RunId } from "@opensteer/core";
import "./connection.js";
import {
  type UserId,
  type ExecutionNodeId,
  type AgentEvent,
  type Sequence,
  type ThreadId,
  type MessageView,
  type PendingRequest,
  type ThreadRunQueueEntry,
  type Thread,
  OpensteerError,
  nonTerminalRunStatuses,
  PendingRequestSchema,
  ThreadIdSchema,
  type MessageId,
  SequenceSchema,
} from "@opensteer/core";
import {
  type DeploymentSnapshot,
  deploymentSnapshotMaxRunQueueEntries,
  deploymentSnapshotMaxThreads,
  deploymentSnapshotMaxMessages,
  deploymentSnapshotMaxSerializedBytes,
  deploymentSnapshotMaxPendingRequests,
  threadPageMaxItems,
  type ThreadMessagePage,
  type ThreadEventPage,
  type NodeEventPage,
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
} from "./store-primitives.js";
import { type Kysely, type Transaction, sql } from "kysely";
import { type DatabaseSchema } from "./schema.js";
import { NotificationStateStore } from "./notification-state.js";
import {
  threadPendingRequestsSelection,
  threadProviderSessionSelection,
  threadContinuationIdentitySelection,
  threadsFromRows,
  messageFromRow,
  threadRunQueueEntriesFromRows,
  threadFromRow,
  executionNodeFromRow,
} from "./thread-row-mappers.js";
import { requestFromRow } from "./request-store.js";

import { type ThreadHistoryQuery, readThreadHistory } from "./thread-history.js";
import { publishedMessagePredicate } from "./message-visibility.js";
export interface DurableWindowReadOptions {
  readonly maxBytes?: number;
  readonly maxItems?: number;
}
export type PersonalSnapshotResourcesReader = (input: {
  readonly database: Transaction<DatabaseSchema>;
  readonly ownerId: UserId;
  readonly maxBytes: number;
}) => Promise<DeploymentSnapshot["resources"]>;
export interface DeploymentSnapshotReadOptions {
  readonly readResources?: PersonalSnapshotResourcesReader;
  /** Skip message history and its counts; clients must read durable history on open. */
  readonly omitMessages?: boolean;
  readonly placeEvents?: "include";
  readonly deviceAccessRequests?: "include";
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
   * The last sequence this window accounts for, including filtered detail rows. A reader resumes after it, never after the last event.
   */
  readonly scannedThrough: Sequence;
}
function buildDeploymentSnapshot(input: {
  readonly readStates: DeploymentSnapshot["readStates"];
  readonly messageTotals: ReadonlyMap<ThreadId, number>;
  readonly omitMessages: boolean;
  readonly messagesDesc: readonly MessageView[];
  readonly pendingRequestTotal: number;
  readonly pendingRequestsDesc: readonly PendingRequest[];
  readonly runQueue: readonly ThreadRunQueueEntry[];
  readonly runPlaces: DeploymentSnapshot["runPlaces"];
  readonly sequence: Sequence;
  readonly threadTotal: number;
  readonly threads: readonly Thread[];
  readonly deploymentId: DeploymentId;
  readonly tasks: DeploymentSnapshot["tasks"];
  readonly needsYou: DeploymentSnapshot["needsYou"];
  readonly resources: DeploymentSnapshot["resources"];
}): DeploymentSnapshot {
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
  let snapshot: DeploymentSnapshot = {
    readStates: input.readStates,
    messages,
    messageWindows,
    ...(input.omitMessages
      ? {
          messagesOmitted: true,
        }
      : {}),
    pendingRequests,
    pendingRequestWindow: {
      byteCount: serializedArrayBytes(pendingRequests),
      hasMore: input.pendingRequestTotal > pendingRequests.length,
      itemCount: pendingRequests.length,
      nextBefore: null,
      totalItems: input.pendingRequestTotal,
    },
    runQueue: [...input.runQueue],
    ...(input.runPlaces === undefined
      ? {}
      : {
          runPlaces: input.runPlaces,
        }),
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
              input.deploymentId,
              oldestThread.updatedAt,
              oldestThread.id,
            )
          : null,
      totalItems: input.threadTotal,
    },
    deploymentId: input.deploymentId,
    tasks: input.tasks,
    needsYou: input.needsYou,
    resources: input.resources,
  };
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const serializedBytes = Buffer.byteLength(JSON.stringify(snapshot), "utf8");
    if (snapshot.serializedBytes === serializedBytes) return snapshot;
    snapshot = {
      ...snapshot,
      serializedBytes,
    };
  }
  throw new OpensteerError({
    code: "internal",
    message: "Deployment snapshot byte accounting did not converge",
  });
}
export async function deploymentSnapshot(
  database: Kysely<DatabaseSchema>,
  notificationState: NotificationStateStore,
  options: DeploymentSnapshotReadOptions = {},
): Promise<DeploymentSnapshot> {
  const maxThreads = boundedWindowLimit(options.maxThreads, deploymentSnapshotMaxThreads);
  const maxMessages = boundedWindowLimit(options.maxMessages, deploymentSnapshotMaxMessages);
  const maxSerializedBytes = boundedWindowBytes(
    options.maxSerializedBytes,
    deploymentSnapshotMaxSerializedBytes,
  );
  return withPersonalReadTransaction(
    database,
    async (transaction) => {
      const state = await transaction
        .selectFrom("deploymentEventState")
        .selectAll()
        .executeTakeFirstOrThrow();
      const ownerId = options.viewerId ?? (await personalSettings(transaction)).ownerId;
      await requirePersonalOwner(transaction, ownerId);
      if (!options.readResources)
        throw new OpensteerError({
          code: "internal",
          message: "Personal resource snapshots are not configured.",
        });
      const [recent, active, done, needsYou, resources] = await Promise.all([
        taskPageForUser(transaction, notificationState, {
          userId: ownerId,
          maxItems: 25,
          maxBytes: 48 * 1024,
        }),
        taskPageForUser(transaction, notificationState, {
          userId: ownerId,
          active: true,
          maxItems: 25,
          maxBytes: 48 * 1024,
        }),
        taskPageForUser(transaction, notificationState, {
          userId: ownerId,
          done: true,
          maxItems: 25,
          maxBytes: 48 * 1024,
        }),
        needsYouPage(transaction, {
          userId: ownerId,
          limit: 20,
          maxBytes: 64 * 1024,
          ...(options.deviceAccessRequests
            ? { deviceAccessRequests: options.deviceAccessRequests }
            : {}),
        }),
        options.readResources({ database: transaction, ownerId, maxBytes: 128 * 1024 }),
      ]);
      const tasks = { recent, active, done };
      if (Buffer.byteLength(JSON.stringify(resources)) > 128 * 1024)
        throw new OpensteerError({
          code: "resource_exhausted",
          message: "Personal resources exceed the snapshot byte limit.",
        });
      if (options.viewerId) await requirePersonalOwner(transaction, options.viewerId);
      // The lateral lookup uses deployment_events_run_places and reads only one
      // event per live Run, including Threads outside this snapshot's window.
      let runPlaces =
        options.placeEvents === "include"
          ? (
              await transaction
                .selectFrom("runs")
                .innerJoin("threads", "threads.id", "runs.threadId")
                .innerJoinLateral(
                  (query) =>
                    query
                      .selectFrom("deploymentEvents")
                      .selectAll("deploymentEvents")
                      .whereRef("deploymentEvents.runId", "=", "runs.id")
                      .where("deploymentEvents.type", "=", "place.entered")
                      .orderBy("deploymentEvents.sequence", "desc")
                      .limit(1)
                      .as("place"),
                  (join) => join.onTrue(),
                )
                .selectAll("place")
                .where("runs.status", "in", nonTerminalRunStatuses)
                .orderBy("place.sequence", "desc")
                .limit(deploymentSnapshotMaxRunQueueEntries + 1)
                .execute()
            )
              .map(eventFromRow)
              .filter((event) => event.type === "place.entered")
          : undefined;
      // Absence is unknown; a partial seed would falsely end every omitted Run on clients.
      if (runPlaces && runPlaces.length > deploymentSnapshotMaxRunQueueEntries)
        runPlaces = undefined;
      const [threadRows, threadCountRow] = await Promise.all([
        transaction
          .selectFrom("threads")
          .selectAll()
          .select([
            threadPendingRequestsSelection,
            threadProviderSessionSelection,
            threadContinuationIdentitySelection,
          ])
          .$if(options.listedOnly === true, (query) => query.where("listed", "=", true))
          .orderBy("updatedAt", "desc")
          .orderBy("id", "desc")
          .limit(maxThreads + 1)
          .execute(),
        transaction
          .selectFrom("threads")
          .select(({ fn }) => fn.countAll<string>().as("count"))
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
        await Promise.all([
          options.omitMessages || threadIds.length === 0
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
          options.omitMessages || threadIds.length === 0
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
            .where("status", "=", "pending")
            .$if(options.deviceAccessRequests !== "include", (query) =>
              query.where("kind", "!=", "device.access"),
            )
            .orderBy("createdAt", "desc")
            .orderBy("id", "desc")
            .limit(deploymentSnapshotMaxPendingRequests + 1)
            .execute(),
          transaction
            .selectFrom("requests")
            .select(({ fn }) => fn.countAll<string>().as("count"))
            .where("status", "=", "pending")
            .$if(options.deviceAccessRequests !== "include", (query) =>
              query.where("kind", "!=", "device.access"),
            )
            .executeTakeFirstOrThrow(),
          threadIds.length === 0
            ? []
            : transaction
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
          ...(row.addressedToUserId
            ? {
                addressedToUserId: row.addressedToUserId,
              }
            : {}),
          published,
          ...(policy
            ? {
                policy,
              }
            : {}),
        })),
        maxMessages,
        Math.min(640 * 1_024, maxSerializedBytes),
      ).items;
      let pendingRequestsDesc = boundedSerializedPrefix(
        PendingRequestSchema.array().parse(
          pendingRows.slice(0, deploymentSnapshotMaxPendingRequests).map(requestFromRow),
        ),
        deploymentSnapshotMaxPendingRequests,
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
      let snapshot = buildDeploymentSnapshot({
        readStates,
        messageTotals,
        omitMessages: options.omitMessages === true,
        messagesDesc,
        pendingRequestTotal: safeCount(pendingCountRow.count),
        pendingRequestsDesc,
        runQueue,
        runPlaces,
        sequence: state.sequence as Sequence,
        threadTotal: safeCount(threadCountRow.count),
        threads: threads.items,
        deploymentId: state.deploymentId,
        tasks,
        needsYou,
        resources,
      });
      while (snapshot.serializedBytes > maxSerializedBytes && messagesDesc.length > 0) {
        messagesDesc = messagesDesc.slice(0, -1);
        snapshot = buildDeploymentSnapshot({
          readStates,
          messageTotals,
          omitMessages: options.omitMessages === true,
          messagesDesc,
          pendingRequestTotal: safeCount(pendingCountRow.count),
          pendingRequestsDesc,
          runQueue,
          runPlaces,
          sequence: state.sequence as Sequence,
          threadTotal: safeCount(threadCountRow.count),
          threads: threads.items,
          deploymentId: state.deploymentId,
          tasks,
          needsYou,
          resources,
        });
      }
      while (snapshot.serializedBytes > maxSerializedBytes && pendingRequestsDesc.length > 0) {
        pendingRequestsDesc = pendingRequestsDesc.slice(0, -1);
        snapshot = buildDeploymentSnapshot({
          readStates,
          messageTotals,
          omitMessages: options.omitMessages === true,
          messagesDesc,
          pendingRequestTotal: safeCount(pendingCountRow.count),
          pendingRequestsDesc,
          runQueue,
          runPlaces,
          sequence: state.sequence as Sequence,
          threadTotal: safeCount(threadCountRow.count),
          threads: threads.items,
          deploymentId: state.deploymentId,
          tasks,
          needsYou,
          resources,
        });
      }
      if (runPlaces !== undefined && snapshot.serializedBytes > maxSerializedBytes) {
        runPlaces = undefined;
        snapshot = buildDeploymentSnapshot({
          readStates,
          messageTotals,
          omitMessages: options.omitMessages === true,
          messagesDesc,
          pendingRequestTotal: safeCount(pendingCountRow.count),
          pendingRequestsDesc,
          runQueue,
          runPlaces,
          sequence: state.sequence as Sequence,
          threadTotal: safeCount(threadCountRow.count),
          threads: threads.items,
          deploymentId: state.deploymentId,
          tasks,
          needsYou,
          resources,
        });
      }
      if (snapshot.serializedBytes > maxSerializedBytes) {
        throw new OpensteerError({
          code: "internal",
          message: "Deployment snapshot metadata exceeds its serialized byte ceiling",
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

export async function taskPageForUser(
  database: Kysely<DatabaseSchema>,
  notificationState: NotificationStateStore,
  input: {
    readonly active?: boolean;
    readonly before?: string;
    readonly done?: boolean;
    readonly maxBytes?: number;
    readonly maxItems?: number;
    readonly userId: UserId;
  },
): Promise<TaskPage> {
  const maxItems = boundedWindowLimit(input.maxItems, threadPageMaxItems);
  const maxBytes = boundedWindowBytes(input.maxBytes, 256 * 1_024);
  const readerScope = input.userId;
  const scope = input.active ? `${readerScope}:active` : readerScope;
  const cursorKind = input.done ? "task-done" : "task-asked";
  const anchor = input.before ? decodeWindowCursor(input.before, cursorKind, scope) : null;
  if (anchor && !ThreadIdSchema.safeParse(anchor.id).success) throw invalidWindowCursor();
  // A Thread view carries its times to the millisecond, so the list is
  // ordered at that precision: a cursor then names exactly the place the
  // reader stopped, even between Threads asked within one millisecond.
  const orderedAt = sql<Date>`date_trunc('milliseconds', ${sql.ref(input.done ? "threads.done_at" : "threads.asked_at")})`;
  return withPersonalReadTransaction(
    database,
    async (transaction) => {
      await requirePersonalOwner(transaction, input.userId);
      let tasks = transaction
        .selectFrom("threads")
        .where("threads.listed", "=", true)
        .where("threads.status", "!=", "archived");
      if (input.active) tasks = tasks.where("threads.status", "in", ["running", "waiting"]);
      if (input.done) tasks = tasks.where("threads.doneAt", "is not", null);
      else tasks = tasks.where("threads.doneAt", "is", null);
      let page = tasks
        .selectAll("threads")
        .select([
          threadPendingRequestsSelection,
          threadProviderSessionSelection,
          threadContinuationIdentitySelection,
        ]);
      if (anchor) {
        page = page.where(
          sql<boolean>`(${orderedAt}, threads.id) < (${anchor.timestamp}::timestamptz, ${anchor.id}::text)`,
        );
      }
      const [rows, countRow] = await Promise.all([
        page
          .orderBy(orderedAt, "desc")
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
              ? encodeWindowCursor(
                  cursorKind,
                  scope,
                  (input.done ? oldest.doneAt : oldest.askedAt)!,
                  oldest.id,
                )
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
): Promise<
  ReadonlyMap<
    ThreadId,
    {
      lastReply: string | null;
      failure: string | null;
    }
  >
> {
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
// Reports are updates, not turns. Automatic steers share the Run's row, so
// only their seed counts; this also covers queued messages placed by a steer.
const turnStartSelection = sql<boolean>`(
  (type = 'message.placed' or (
    type = 'message.created'
    and data #>> '{message,kind}' = 'input'
    and (data #>> '{input,policy}') is distinct from 'queue'
    and (data #>> '{input,policy}') is distinct from 'report'
  ))
  and (
    data #>> '{message,author,kind}' = 'human'
    or not exists (select 1 from runs started_run
      where started_run.id = coalesce(deployment_events.run_id, data #>> '{message,runId}')
      and started_run.seed_input_id is distinct from data #>> '{message,id}')
  )
)`;

/**
 * How many of `rows`, newest first, a history page keeps: whole turns until
 * `maxTurns`, or until the next whole turn would cross a bound. Only a newest
 * turn that alone crosses one is cut inside, and never below one event, so
 * paging always advances.
 */
function historyPageLength(
  rows: readonly {
    readonly bytes: number;
    readonly turnStart: boolean;
  }[],
  bounds: {
    readonly maxBytes: number;
    readonly maxItems: number;
    readonly maxTurns: number;
  },
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
    readonly placeEvents?: "include";
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
  return withPersonalReadTransaction(
    database,
    async (transaction) => {
      const thread = await transaction
        .selectFrom("threads")
        .selectAll("threads")
        .select([
          threadPendingRequestsSelection,
          threadProviderSessionSelection,
          threadContinuationIdentitySelection,
        ])
        .where("threads.id", "=", input.threadId)
        .executeTakeFirst();
      if (!thread) return null;
      const [page, countRow] = await Promise.all([
        input.aroundMessageId
          ? eventsAroundMessage(transaction, input.threadId, input.aroundMessageId, {
              maxBytes,
              maxItems,
              placeEvents: input.placeEvents,
            })
          : newestTurns(transaction, input.threadId, anchor, {
              maxBytes,
              maxItems,
              maxTurns,
              placeEvents: input.placeEvents,
            }),
        transaction
          .selectFrom("deploymentEvents")
          .select(({ fn }) => fn.countAll<string>().as("count"))
          .where("threadId", "=", input.threadId)
          .where("nodeDetailId", "is", null)
          .$if(input.placeEvents !== "include", (query) =>
            query.where("type", "<>", "place.entered"),
          )
          .executeTakeFirstOrThrow(),
      ]);
      const { events, hasMore } = page;
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
          nextBefore:
            "nextBefore" in page
              ? (page.nextBefore as string | null)
              : hasMore && oldest
                ? oldest.sequence
                : null,
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
  bounds: {
    readonly placeEvents?: "include" | undefined;
    readonly maxBytes: number;
    readonly maxItems: number;
    readonly maxTurns: number;
  },
): Promise<{
  readonly events: AgentEvent[];
  readonly hasMore: boolean;
}> {
  let metadataQuery = transaction
    .selectFrom("deploymentEvents")
    .select([
      "sequence",
      // Stored JSON is written with `, ` and `: `, the wire's without spaces.
      // Dropping them keeps the estimate under what is sent, so the exact pass
      // below only ever trims and never loses a turn that fits.
      sql<number>`octet_length(replace(replace(data::text, ', ', ','), ': ', ':'))`.as("dataBytes"),
      turnStartSelection.as("turnStart"),
    ])
    .where("threadId", "=", threadId)
    .where("nodeDetailId", "is", null)
    .$if(bounds.placeEvents !== "include", (query) => query.where("type", "<>", "place.entered"));
  if (before !== null) metadataQuery = metadataQuery.where("sequence", "<", before);
  const metadata = await metadataQuery
    .orderBy("sequence", "desc")
    .limit(bounds.maxItems + 1)
    .execute();
  const estimated = historyPageLength(
    metadata.map((row) => ({
      bytes: Number(row.dataBytes),
      turnStart: row.turnStart,
    })),
    bounds,
  );
  const oldest = metadata[estimated - 1];
  if (!oldest)
    return {
      events: [],
      hasMore: false,
    };
  let rowsQuery = transaction
    .selectFrom("deploymentEvents")
    .selectAll()
    .where("threadId", "=", threadId)
    .where("nodeDetailId", "is", null)
    .$if(bounds.placeEvents !== "include", (query) => query.where("type", "<>", "place.entered"))
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
  bounds: {
    readonly placeEvents?: "include" | undefined;
    readonly maxBytes: number;
    readonly maxItems: number;
  },
): Promise<{
  readonly events: AgentEvent[];
  readonly hasMore: boolean;
}> {
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
    .selectFrom("deploymentEvents")
    .select("sequence")
    .where("threadId", "=", threadId)
    .where("nodeDetailId", "is", null)
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
    .selectFrom("deploymentEvents")
    .selectAll()
    .where("threadId", "=", threadId)
    .where("nodeDetailId", "is", null)
    .$if(bounds.placeEvents !== "include", (query) => query.where("type", "<>", "place.entered"));
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
  return {
    events,
    hasMore,
  };
}
export async function nodeEventPageForOwner(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly ownerId: UserId;
    readonly threadId: ThreadId;
    readonly nodeId: ExecutionNodeId;
    readonly types?: readonly ("node.message" | "tool.started" | "tool.completed")[];
    readonly itemId?: string;
    readonly through?: Sequence;
    readonly before?: string;
    readonly maxItems?: number;
    readonly maxBytes?: number;
  },
): Promise<NodeEventPage | null> {
  const maxItems = boundedWindowLimit(input.maxItems, eventPageMaxItems);
  const maxBytes = boundedWindowBytes(input.maxBytes, 640 * 1_024);
  const before = input.before === undefined ? null : SequenceSchema.safeParse(input.before);
  if (before && !before.success) throw invalidWindowCursor();
  return withPersonalReadTransaction(
    database,
    async (transaction) => {
      await requirePersonalOwner(transaction, input.ownerId);
      const node = await transaction
        .selectFrom("executionNodes")
        .innerJoin("runs", "runs.id", "executionNodes.runId")
        .innerJoin("threads", "threads.id", "runs.threadId")
        .selectAll("executionNodes")
        .where("executionNodes.id", "=", input.nodeId)
        .where("threads.id", "=", input.threadId)
        .executeTakeFirst();
      if (!node) return null;
      let query = transaction
        .selectFrom("deploymentEvents")
        .where("threadId", "=", input.threadId)
        .where("nodeDetailId", "=", input.nodeId);
      if (input.types) query = query.where("type", "in", input.types);
      if (input.itemId) {
        const sequence = SequenceSchema.safeParse(input.itemId);
        if (!sequence.success) throw invalidWindowCursor();
        query = query.where("sequence", "=", sequence.data);
      }
      if (input.through !== undefined) query = query.where("sequence", "<=", input.through);
      const count = await query
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .executeTakeFirstOrThrow();
      if (before?.success) query = query.where("sequence", "<", before.data);
      const metadata = await query
        .select([
          "sequence",
          sql<number>`octet_length(replace(replace(data::text, ', ', ','), ': ', ':'))`.as(
            "dataBytes",
          ),
        ])
        .orderBy("sequence", "desc")
        .limit(maxItems + 1)
        .execute();
      const estimated = historyPageLength(
        metadata.map((row) => ({
          bytes: Number(row.dataBytes),
          turnStart: false,
        })),
        {
          maxBytes,
          maxItems,
          maxTurns: Number.POSITIVE_INFINITY,
        },
      );
      const sequences = metadata.slice(0, estimated).map((row) => row.sequence);
      const candidates =
        sequences.length === 0
          ? []
          : await query
              .selectAll()
              .where("sequence", "in", sequences)
              .orderBy("sequence", "desc")
              .execute();
      const window = boundedSerializedPrefix(candidates.map(eventFromRow), maxItems, maxBytes);
      const events = [...window.items].reverse();
      if (candidates.length > 0 && events.length === 0) {
        throw new OpensteerError({
          code: "internal",
          message: "A node event exceeds the history byte ceiling",
        });
      }
      const hasMore = metadata.length > events.length;
      return {
        threadId: input.threadId,
        nodeId: input.nodeId,
        node: executionNodeFromRow(node),
        events,
        window: {
          byteCount: window.byteCount,
          itemCount: events.length,
          hasMore,
          nextBefore: hasMore ? (events[0]?.sequence ?? null) : null,
          totalItems: safeCount(count.count),
        },
      };
    },
    "repeatable read",
  );
}
export async function eventsAfter(
  database: Kysely<DatabaseSchema>,
  afterSequence: Sequence,
  limit = 500,
): Promise<readonly AgentEvent[]> {
  return (
    await eventsAfterWindow(database, afterSequence, {
      maxBytes: 8 * 1_024 * 1_024,
      maxItems: limit,
    })
  ).events;
}
export async function eventsAfterWindow(
  database: Kysely<DatabaseSchema>,
  afterSequence: Sequence,
  options: {
    readonly maxBytes: number;
    readonly maxItems: number;
    readonly throughSequence?: Sequence;
  },
): Promise<EventReplayWindow> {
  const state = await database
    .selectFrom("deploymentEventState")
    .select("deploymentId")
    .executeTakeFirstOrThrow();
  const window = await deploymentEventsAfter(database, {
    deploymentId: state.deploymentId,
    afterSequence,
    ...options,
  });
  return {
    byteCount: window.byteCount,
    events: window.events,
    hasMore: window.hasMore,
    scannedThrough: window.resync ? afterSequence : window.throughSequence,
  };
}

export async function toolOutputForOwner(
  database: Kysely<DatabaseSchema>,
  input: {
    ownerId: UserId;
    threadId: ThreadId;
    runId: RunId;
    callId: string;
    nodeId?: ExecutionNodeId | undefined;
  },
) {
  const row = await database
    .selectFrom("deploymentEvents")
    .innerJoin("threads", "threads.id", "deploymentEvents.threadId")
    .innerJoin("personalSettings", "personalSettings.ownerId", "threads.createdBy")
    .innerJoin("users", "users.id", "personalSettings.ownerId")
    .selectAll("deploymentEvents")
    .where("personalSettings.ownerId", "=", input.ownerId)
    .where("users.disabledAt", "is", null)
    .where("threads.id", "=", input.threadId)
    .where("deploymentEvents.runId", "=", input.runId)
    .where("deploymentEvents.type", "=", "tool.completed")
    .where("deploymentEvents.nodeDetailId", input.nodeId ? "=" : "is", input.nodeId ?? null)
    .where(sql<string>`data->>'callId'`, "=", input.callId)
    .orderBy("deploymentEvents.sequence", "desc")
    .executeTakeFirst();
  if (!row) return null;
  const event = eventFromRow(row);
  return event.type === "tool.completed" ? event.data.output : null;
}
