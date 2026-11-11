import { requirePersonalOwner } from "./personal-settings-store.js";
import { withPersonalTransaction } from "./personal-transaction.js";
import {
  administrationCommand,
  type AdministrationCommandIdentity,
} from "./administration-command.js";
import "./connection.js";
import {
  defaultQuietTaskDays,
  OpensteerError,
  QuietTaskDaysSchema,
  type QuietTaskDays,
  SequenceSchema,
  type Sequence,
  TimeZoneSchema,
  type TimeZone,
  ThreadReadStateSchema,
  type ThreadId,
  type ThreadReadState,
  type UserId,
} from "@opensteer/core";
import { sql, type Kysely } from "kysely";
import { conversationUnreadPredicate, publishedMessagePredicate } from "./message-visibility.js";
import type { DatabaseSchema } from "./schema.js";
interface ReadRow {
  threadId: ThreadId;
  readSequence: string | null;
  unreadSequence: string | null;
  asOfSequence: string;
}

/** Published conversation content, excluding pending or withdrawn work. */
const visibleMessage = sql<boolean>`message.kind in ('input', 'assistant', 'run-result')
  and ${publishedMessagePredicate("inbox")}`;

const humanSender = sql<string | null>`case when inbox.authority_source->>'kind' = 'channel-ingress'
  then message.author->>'userId' else coalesce(message.author->>'userId', inbox.requested_by) end`;

/** Durable per-person viewer state: read positions, time zone and quiet tasks. */
export class NotificationStateStore {
  readonly #database: Kysely<DatabaseSchema>;
  constructor(database: Kysely<DatabaseSchema>) {
    this.#database = database;
  }
  async getReadState(input: {
    readonly threadId: ThreadId;
    readonly userId: UserId;
    readonly database?: Kysely<DatabaseSchema>;
  }): Promise<ThreadReadState> {
    const [state] = await this.listReadStates({
      threadIds: [input.threadId],
      userId: input.userId,
      ...(input.database
        ? {
            database: input.database,
          }
        : {}),
    });
    if (!state)
      throw new OpensteerError({
        code: "not_found",
        message: "Thread not found",
      });
    return state;
  }
  async listReadStates(input: {
    readonly threadIds: readonly ThreadId[];
    readonly userId: UserId;
    readonly database?: Kysely<DatabaseSchema>;
  }): Promise<readonly ThreadReadState[]> {
    if (input.threadIds.length === 0) return [];
    const states = new Map<ThreadId, ThreadReadState>();
    for (let start = 0; start < input.threadIds.length; start += 100) {
      const batch = input.threadIds.slice(start, start + 100);
      const rows = await sql<ReadRow>`
      select thread.id as thread_id,
        marker.sequence::text as read_sequence,
        coalesce(conversation_unread.sequence, work_unread.sequence)::text as unread_sequence,
        state.sequence::text as as_of_sequence
      from public.threads thread
      cross join public.deployment_event_state state
      join public.personal_settings settings on settings.owner_id = ${input.userId}
      join public.users person on person.id = settings.owner_id and person.disabled_at is null
      left join public.thread_read_markers marker
        on marker.thread_id = thread.id and marker.user_id = ${input.userId}
      left join lateral (
        select message.sequence
        from public.messages message
        left join public.thread_inputs inbox on inbox.message_id = message.id
        where thread.purpose = 'voice'
          and message.thread_id = thread.id
          and message.sequence > coalesce(marker.sequence, -1)
          and ${visibleMessage}
          and ${conversationUnreadPredicate("message")}
          and (message.author->>'kind' <> 'human'
            or ${humanSender} is distinct from ${input.userId})
        order by message.sequence desc
        limit 1
      ) conversation_unread on true
      left join lateral (
        select message.sequence
        from public.messages message
        left join public.thread_inputs inbox on inbox.message_id = message.id
        where thread.purpose <> 'voice'
          and message.thread_id = thread.id
          and message.sequence > coalesce(marker.sequence, -1)
          and ${visibleMessage}
          and (message.author->>'kind' <> 'human'
            or ${humanSender} is distinct from ${input.userId})
        order by message.sequence desc
        limit 1
      ) work_unread on true
      where thread.id in (${sql.join(batch)})
    `.execute(input.database ?? this.#database);
      for (const row of rows.rows) {
        states.set(row.threadId, ThreadReadStateSchema.parse(row));
      }
    }
    return input.threadIds.flatMap((threadId) => {
      const state = states.get(threadId);
      return state ? [state] : [];
    });
  }
  async readMarkerPage(input: {
    readonly userId: UserId;
    readonly afterThreadId?: ThreadId | null;
    readonly limit?: number;
  }): Promise<{
    readonly markers: readonly {
      readonly threadId: ThreadId;
      readonly readSequence: Sequence;
    }[];
    readonly nextAfterThreadId: ThreadId | null;
  }> {
    const limit = input.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new TypeError("Read marker page limit must be between 1 and 100");
    await requirePersonalOwner(this.#database, input.userId);
    let query = this.#database
      .selectFrom("threadReadMarkers")
      .innerJoin("threads", "threads.id", "threadReadMarkers.threadId")
      .select(["threadReadMarkers.threadId", "threadReadMarkers.sequence as readSequence"])
      .where("threadReadMarkers.userId", "=", input.userId);
    if (input.afterThreadId)
      query = query.where("threadReadMarkers.threadId", ">", input.afterThreadId);
    const rows = await query
      .orderBy("threadReadMarkers.threadId")
      .limit(limit + 1)
      .execute();
    const markers = rows.slice(0, limit).map((row) => ({
      threadId: row.threadId,
      readSequence: SequenceSchema.parse(row.readSequence),
    }));
    return {
      markers,
      nextAfterThreadId: rows.length > limit ? (markers.at(-1)?.threadId ?? null) : null,
    };
  }
  async markRead(input: {
    readonly threadId: ThreadId;
    readonly throughSequence: string;
    readonly userId: UserId;
  }): Promise<ThreadReadState> {
    const sequence = BigInt(input.throughSequence);
    if (sequence < 0n) throw new TypeError("Read sequence must be nonnegative");
    await withPersonalTransaction(this.#database, async (transaction) => {
      await requirePersonalOwner(transaction, input.userId);
      const authorized = await transaction
        .selectFrom("threads")
        .select("id")
        .where("id", "=", input.threadId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!authorized)
        throw new OpensteerError({
          code: "not_found",
          message: "Thread not found",
        });
      {
        const visible = await sql<{
          id: string;
        }>`
          select message.id from public.messages message
          left join public.thread_inputs inbox on inbox.message_id = message.id
          where message.thread_id = ${input.threadId}
            and message.sequence = ${input.throughSequence}
            and ${visibleMessage}
          limit 1
        `.execute(transaction);
        if (visible.rows.length === 0) {
          throw new OpensteerError({
            code: "conflict",
            message: "Read position must name a published message in this Thread",
          });
        }
      }
      await transaction
        .insertInto("threadReadMarkers")
        .values({
          sequence: input.throughSequence,
          threadId: input.threadId,
          updatedAt: new Date(),
          userId: input.userId,
        })
        .onConflict((conflict) =>
          conflict.columns(["threadId", "userId"]).doUpdateSet({
            sequence: sql`greatest(thread_read_markers.sequence, excluded.sequence)`,
            updatedAt: new Date(),
          }),
        )
        .execute();
    });
    return this.getReadState(input);
  }

  /** Records the zone a person's client reports, for whoever acts on their behalf. */
  async setTimeZone(input: {
    readonly administration?: AdministrationCommandIdentity | undefined;
    readonly timeZone: TimeZone;
    readonly userId: UserId;
  }): Promise<TimeZone> {
    return withPersonalTransaction(this.#database, (transaction) =>
      administrationCommand(transaction, input.administration, async () => {
        await requirePersonalOwner(transaction, input.userId);
        const timeZone = TimeZoneSchema.parse(input.timeZone);
        const updated = await transaction
          .updateTable("personalSettings")
          .set({ timeZone })
          .where("ownerId", "=", input.userId)
          .executeTakeFirst();
        if (updated.numUpdatedRows !== 1n) {
          throw new OpensteerError({
            code: "not_found",
            message: "User not found",
          });
        }
        return timeZone;
      }),
    );
  }

  /** The zone a person's client last reported, or null if none has. */
  async timeZoneFor(userId: UserId): Promise<TimeZone | null> {
    const row = await this.#database
      .selectFrom("personalSettings")
      .select("timeZone")
      .where("ownerId", "=", userId)
      .executeTakeFirst();
    if (!row?.timeZone) return null;
    const parsed = TimeZoneSchema.safeParse(row.timeZone);
    return parsed.success ? parsed.data : null;
  }
  async setQuietTaskDays(input: {
    readonly administration?: AdministrationCommandIdentity | undefined;
    readonly quietTaskDays: QuietTaskDays;
    readonly userId: UserId;
  }): Promise<QuietTaskDays> {
    return withPersonalTransaction(this.#database, (transaction) =>
      administrationCommand(transaction, input.administration, async () => {
        const quietTaskDays = QuietTaskDaysSchema.parse(input.quietTaskDays);
        const updated = await transaction
          .updateTable("personalSettings")
          .set({ quietTaskDays })
          .where("ownerId", "=", input.userId)
          .executeTakeFirst();
        if (updated.numUpdatedRows !== 1n) {
          throw new OpensteerError({
            code: "not_found",
            message: "User not found",
          });
        }
        return quietTaskDays;
      }),
    );
  }
  async quietTaskDaysFor(userId: UserId): Promise<QuietTaskDays> {
    const row = await this.#database
      .selectFrom("personalSettings")
      .select("quietTaskDays")
      .where("ownerId", "=", userId)
      .executeTakeFirst();
    return QuietTaskDaysSchema.catch(defaultQuietTaskDays).parse(row?.quietTaskDays);
  }
}
