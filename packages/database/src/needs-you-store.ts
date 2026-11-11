import { boundedSerializedPrefix } from "./message-window.js";
import {
  OpensteerError,
  PendingRequestSchema,
  RequestIdSchema,
  type ThreadId,
  type TaskPurpose,
  type UserId,
} from "@opensteer/core";
import { NeedsYouPageSchema, type NeedsYouPage } from "@opensteer/protocol";
import { sql, type Kysely } from "kysely";
import { requirePersonalOwner } from "./personal-settings-store.js";
import { withPersonalTransaction } from "./personal-transaction.js";
import { requestFromRow } from "./request-persistence.js";
import type { DatabaseSchema } from "./schema.js";
import {
  boundedWindowBytes,
  boundedWindowLimit,
  decodeWindowCursor,
  encodeWindowCursor,
  safeCount,
} from "./store-primitives.js";

export function needsYouPage(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly userId: UserId;
    readonly before?: string;
    readonly limit?: number;
    readonly maxBytes?: number;
  },
): Promise<NeedsYouPage> {
  const limit = boundedWindowLimit(input.limit, 50);
  const maxBytes = boundedWindowBytes(input.maxBytes, 256 * 1024);
  const cursor = input.before ? decodeWindowCursor(input.before, "request", input.userId) : null;
  return withPersonalTransaction(
    database,
    async (transaction) => {
      await requirePersonalOwner(transaction, input.userId);
      const pending = transaction.selectFrom("requests").where("status", "=", "pending");
      let query = pending
        .selectAll()
        .orderBy("createdAt", "desc")
        .orderBy("id", "desc")
        .limit(limit + 1);
      if (cursor)
        query = query.where((eb) =>
          eb.or([
            eb("createdAt", "<", cursor.timestamp),
            eb.and([
              eb("createdAt", "=", cursor.timestamp),
              eb("id", "<", RequestIdSchema.parse(cursor.id)),
            ]),
          ]),
        );
      const [rows, total] = await Promise.all([
        query.execute(),
        pending.select(({ fn }) => fn.countAll<string>().as("count")).executeTakeFirstOrThrow(),
      ]);
      const selected = rows.slice(0, limit);
      const navigation = selected.length
        ? await sql<{
            originId: ThreadId;
            originPurpose: TaskPurpose;
            id: ThreadId;
            title: string;
          }>`with recursive navigation as (
      select id as origin_id, purpose as origin_purpose, id, title, parent_thread_id, listed,
        array[id] as seen, 0 as depth
      from threads where id in (${sql.join(selected.map((row) => row.originatingThreadId))})
      union all
      select navigation.origin_id, navigation.origin_purpose, parent.id, parent.title,
        parent.parent_thread_id, parent.listed, navigation.seen || parent.id, navigation.depth + 1
      from navigation join threads parent on parent.id = navigation.parent_thread_id
      where not navigation.listed and not parent.id = any(navigation.seen)
    ) select distinct on (origin_id) origin_id as "originId", origin_purpose as "originPurpose", id, title
      from navigation order by origin_id, depth desc`.execute(transaction)
        : { rows: [] };
      const byOrigin = new Map(navigation.rows.map((row) => [row.originId, row]));
      const candidates = selected.map((row) => {
        const target = byOrigin.get(row.originatingThreadId);
        if (!target) throw new Error("Request lost its originating task");
        return {
          request: PendingRequestSchema.parse(requestFromRow(row)),
          originThreadId: row.originatingThreadId,
          navigationThreadId: target.id,
          title: target.title,
          purpose: target.originPurpose,
        };
      });
      const bounded = boundedSerializedPrefix(candidates, limit, maxBytes);
      if (candidates.length && !bounded.items.length)
        throw new OpensteerError({
          code: "resource_exhausted",
          message: "A pending Request exceeds the page byte limit.",
        });
      const entries = [...bounded.items];
      const last = entries.at(-1)?.request;
      const count = safeCount(total.count);
      return NeedsYouPageSchema.parse({
        count,
        entries,
        window: {
          byteCount: bounded.byteCount,
          hasMore: rows.length > entries.length,
          itemCount: entries.length,
          totalItems: count,
          nextBefore:
            rows.length > entries.length && last
              ? encodeWindowCursor("request", input.userId, last.createdAt, last.id)
              : null,
        },
      });
    },
    "repeatable read",
  );
}
