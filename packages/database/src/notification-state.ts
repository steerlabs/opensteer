import { withDatabaseTransaction } from "./connection.js";
import {
  OpensteerError,
  SequenceSchema,
  type Sequence,
  TimeZoneSchema,
  type TimeZone,
  ThreadReadStateSchema,
  type ThreadId,
  type ThreadReadState,
  type UserId,
  type WorkspaceId,
  WorkspaceNotificationPreferenceSchema,
  type WorkspaceNotificationPreference,
} from "@opensteer/core";
import { sql, type Kysely } from "kysely";
import { publishedMessagePredicate } from "./message-visibility.js";
import type { DatabaseSchema } from "./schema.js";

interface ReadRow {
  threadId: ThreadId;
  readSequence: string | null;
  unreadSequence: string | null;
  asOfSequence: string;
  done: boolean;
}

/** Published conversation content, excluding pending or withdrawn work. */
const visibleMessage = sql<boolean>`message.kind in ('input', 'assistant', 'run-result')
  and ${publishedMessagePredicate("inbox")}`;

/** Durable per-person viewer state: read positions, alert mutes and time zone. */
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
      ...(input.database ? { database: input.database } : {}),
    });
    if (!state) throw new OpensteerError({ code: "not_found", message: "Thread not found" });
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
        unread.sequence::text as unread_sequence,
        workspace.event_sequence::text as as_of_sequence,
        (thread.done_at is not null) as done
      from public.threads thread
      join public.workspaces workspace on workspace.id = thread.workspace_id
      join public.workspace_memberships membership
        on membership.workspace_id = thread.workspace_id
        and membership.user_id = ${input.userId}
        and membership.state = 'active'
      join public.users person on person.id = membership.user_id and person.disabled_at is null
      left join public.thread_read_markers marker
        on marker.thread_id = thread.id and marker.user_id = ${input.userId}
      left join lateral (
        select message.sequence
        from public.messages message
        left join public.thread_inputs inbox on inbox.message_id = message.id
        where message.thread_id = thread.id
          and message.sequence > coalesce(marker.sequence, -1)
          and ${visibleMessage}
          and (message.author->>'kind' <> 'human'
            or coalesce(message.author->>'userId', inbox.requested_by) is distinct from ${input.userId})
        order by message.sequence desc
        limit 1
      ) unread on true
      where thread.id in (${sql.join(batch)})
    `.execute(input.database ?? this.#database);
      for (const row of rows.rows) {
        states.set(
          row.threadId,
          ThreadReadStateSchema.parse({
            ...row,
            placement:
              row.readSequence === null ? null : { done: row.done, sequence: row.readSequence },
            placementRevision: row.asOfSequence,
          }),
        );
      }
    }
    return input.threadIds.flatMap((threadId) => {
      const state = states.get(threadId);
      return state ? [state] : [];
    });
  }

  async readMarkerPage(input: {
    readonly workspaceId: WorkspaceId;
    readonly userId: UserId;
    readonly afterThreadId?: ThreadId | null;
    readonly limit?: number;
  }): Promise<{
    readonly markers: readonly { readonly threadId: ThreadId; readonly readSequence: Sequence }[];
    readonly nextAfterThreadId: ThreadId | null;
  }> {
    const limit = input.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new TypeError("Read marker page limit must be between 1 and 100");
    const authorized = await this.#database
      .selectFrom("workspaceMemberships")
      .innerJoin("users", "users.id", "workspaceMemberships.userId")
      .select("workspaceMemberships.workspaceId")
      .where("workspaceMemberships.workspaceId", "=", input.workspaceId)
      .where("workspaceMemberships.userId", "=", input.userId)
      .where("workspaceMemberships.state", "=", "active")
      .where("users.disabledAt", "is", null)
      .executeTakeFirst();
    if (!authorized)
      throw new OpensteerError({ code: "not_found", message: "Workspace not found" });
    let query = this.#database
      .selectFrom("threadReadMarkers")
      .innerJoin("threads", "threads.id", "threadReadMarkers.threadId")
      .select(["threadReadMarkers.threadId", "threadReadMarkers.sequence as readSequence"])
      .where("threadReadMarkers.userId", "=", input.userId)
      .where("threads.workspaceId", "=", input.workspaceId);
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
    await withDatabaseTransaction(this.#database, async (transaction) => {
      const authorized = await transaction
        .selectFrom("threads")
        .innerJoin(
          "workspaceMemberships",
          "workspaceMemberships.workspaceId",
          "threads.workspaceId",
        )
        .innerJoin("users", "users.id", "workspaceMemberships.userId")
        .select("threads.id")
        .where("threads.id", "=", input.threadId)
        .where("workspaceMemberships.userId", "=", input.userId)
        .where("workspaceMemberships.state", "=", "active")
        .where("users.disabledAt", "is", null)
        .forNoKeyUpdate("threads")
        .executeTakeFirst();
      if (!authorized) throw new OpensteerError({ code: "not_found", message: "Thread not found" });
      {
        const visible = await sql<{ id: string }>`
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

  async listWorkspacePreferences(input: {
    readonly userId: UserId;
    readonly workspaceIds: readonly WorkspaceId[];
    readonly database?: Kysely<DatabaseSchema>;
  }): Promise<readonly WorkspaceNotificationPreference[]> {
    if (input.workspaceIds.length === 0) return [];
    const preferences = new Map<WorkspaceId, WorkspaceNotificationPreference>();
    for (let start = 0; start < input.workspaceIds.length; start += 100) {
      const batch = input.workspaceIds.slice(start, start + 100);
      const rows = await (input.database ?? this.#database)
        .selectFrom("workspaces")
        .innerJoin("workspaceMemberships", "workspaceMemberships.workspaceId", "workspaces.id")
        .innerJoin("users", "users.id", "workspaceMemberships.userId")
        .leftJoin("agentNotificationMutes", (join) =>
          join
            .onRef("agentNotificationMutes.workspaceId", "=", "workspaces.id")
            .on("agentNotificationMutes.userId", "=", input.userId),
        )
        .select([
          "workspaces.id as workspaceId",
          "agentNotificationMutes.muted",
          "agentNotificationMutes.revision",
        ])
        .where("workspaces.id", "in", batch)
        .where("workspaceMemberships.userId", "=", input.userId)
        .where("workspaceMemberships.state", "=", "active")
        .where("users.disabledAt", "is", null)
        .execute();
      for (const row of rows) {
        preferences.set(
          row.workspaceId,
          WorkspaceNotificationPreferenceSchema.parse({
            workspaceId: row.workspaceId,
            muted: row.muted ?? false,
            revision: row.revision ?? "0",
          }),
        );
      }
    }
    return input.workspaceIds.flatMap((workspaceId) => {
      const preference = preferences.get(workspaceId);
      return preference ? [preference] : [];
    });
  }

  async workspacePreferencePage(input: {
    readonly userId: UserId;
    readonly afterWorkspaceId?: WorkspaceId | null;
    readonly limit?: number;
  }): Promise<{
    readonly preferences: readonly WorkspaceNotificationPreference[];
    readonly nextAfterWorkspaceId: WorkspaceId | null;
  }> {
    const limit = input.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new TypeError("Workspace preference page limit must be between 1 and 100");
    let query = this.#database
      .selectFrom("agentNotificationMutes")
      .innerJoin("workspaceMemberships", (join) =>
        join
          .onRef("workspaceMemberships.workspaceId", "=", "agentNotificationMutes.workspaceId")
          .onRef("workspaceMemberships.userId", "=", "agentNotificationMutes.userId"),
      )
      .innerJoin("users", "users.id", "agentNotificationMutes.userId")
      .select([
        "agentNotificationMutes.workspaceId",
        "agentNotificationMutes.muted",
        "agentNotificationMutes.revision",
      ])
      .where("agentNotificationMutes.userId", "=", input.userId)
      .where("workspaceMemberships.state", "=", "active")
      .where("users.disabledAt", "is", null);
    if (input.afterWorkspaceId)
      query = query.where("agentNotificationMutes.workspaceId", ">", input.afterWorkspaceId);
    const rows = await query
      .orderBy("agentNotificationMutes.workspaceId")
      .limit(limit + 1)
      .execute();
    const preferences = rows
      .slice(0, limit)
      .map((row) => WorkspaceNotificationPreferenceSchema.parse(row));
    return {
      preferences,
      nextAfterWorkspaceId: rows.length > limit ? (preferences.at(-1)?.workspaceId ?? null) : null,
    };
  }

  async setAgentNotificationMute(input: {
    readonly muted: boolean;
    readonly userId: UserId;
    readonly workspaceId: WorkspaceId;
  }): Promise<WorkspaceNotificationPreference> {
    return withDatabaseTransaction(this.#database, async (transaction) => {
      const authorized = await transaction
        .selectFrom("workspaceMemberships")
        .innerJoin("users", "users.id", "workspaceMemberships.userId")
        .select("workspaceMemberships.workspaceId")
        .where("workspaceMemberships.workspaceId", "=", input.workspaceId)
        .where("workspaceMemberships.userId", "=", input.userId)
        .where("workspaceMemberships.state", "=", "active")
        .where("users.disabledAt", "is", null)
        .executeTakeFirst();
      if (!authorized)
        throw new OpensteerError({ code: "not_found", message: "Workspace not found" });
      const updated = await transaction
        .insertInto("agentNotificationMutes")
        .values({ ...input, updatedAt: new Date() })
        .onConflict((conflict) =>
          conflict.columns(["workspaceId", "userId"]).doUpdateSet({
            muted: input.muted,
            revision: sql<string>`agent_notification_mutes.revision + 1`,
            updatedAt: new Date(),
          }),
        )
        .returning(["workspaceId", "muted", "revision"])
        .executeTakeFirstOrThrow();
      return WorkspaceNotificationPreferenceSchema.parse(updated);
    });
  }

  /** Records the zone a person's client reports, for whoever acts on their behalf. */
  async setTimeZone(input: {
    readonly timeZone: TimeZone;
    readonly userId: UserId;
  }): Promise<TimeZone> {
    const timeZone = TimeZoneSchema.parse(input.timeZone);
    const updated = await this.#database
      .updateTable("users")
      .set({ timeZone, updatedAt: new Date() })
      .where("id", "=", input.userId)
      .where("disabledAt", "is", null)
      .executeTakeFirst();
    if (updated.numUpdatedRows !== 1n) {
      throw new OpensteerError({ code: "not_found", message: "User not found" });
    }
    return timeZone;
  }

  /** The zone a person's client last reported, or null if none has. */
  async timeZoneFor(userId: UserId): Promise<TimeZone | null> {
    const row = await this.#database
      .selectFrom("users")
      .select("timeZone")
      .where("id", "=", userId)
      .executeTakeFirst();
    if (!row?.timeZone) return null;
    const parsed = TimeZoneSchema.safeParse(row.timeZone);
    return parsed.success ? parsed.data : null;
  }
}
