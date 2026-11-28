import { boundedSerializedPrefix } from "./message-window.js";
import {
  OpensteerError,
  IsoDateTimeSchema,
  PendingRequestViewSchema,
  type ThreadId,
  type RequestId,
  type TaskPurpose,
  type UserId,
} from "@opensteer/core";
import { NeedsYouPageSchema, type NeedsYouPage, type NeedsYouEntry } from "@opensteer/protocol";
import { sql, type Kysely } from "kysely";
import { readAttentionKeys } from "./personal-attention-store.js";
import { authorizedSyncState, withPersonalSyncRead } from "./personal-sync-store.js";
import { requestFromRow } from "./request-persistence.js";
import type { DatabaseSchema } from "./schema.js";
import {
  boundedWindowBytes,
  boundedWindowLimit,
  decodeWindowCursor,
  encodeWindowCursor,
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
  const cursorAt = input.before
    ? IsoDateTimeSchema.parse(
        JSON.parse(Buffer.from(input.before, "base64url").toString()).timestamp,
      )
    : null;
  return withPersonalSyncRead(database, async (transaction) => {
    const state = await authorizedSyncState(transaction, input.userId);
    const keys = await readAttentionKeys(transaction, {
      limit,
      ...(cursor && cursorAt ? { before: { at: cursorAt, id: cursor.id } } : {}),
    });
    const requestIds = keys.flatMap((key) => (key.requestId ? [key.requestId] : []));
    const rows = requestIds.length
      ? await transaction.selectFrom("requests").selectAll().where("id", "in", requestIds).execute()
      : [];
    const selected = rows;
    const navigation = selected.length
      ? await sql<{
          requestId: RequestId;
          purpose: TaskPurpose;
          id: ThreadId;
          title: string;
        }>`with recursive navigation as (
      select request.id as request_id, origin.id, origin.title, origin.purpose,
        coalesce(held.parent_thread_id, origin.parent_thread_id) as next_thread_id,
        held.parent_assignment_id as next_assignment_id,
        (not origin.listed or held.id is not null) as roll_up,
        array[origin.id] as seen, 0 as depth
      from requests request join threads origin on origin.id = request.originating_thread_id
      left join runs origin_run on origin_run.id = request.originating_run_id
      left join delegations held on held.id = origin_run.assignment_id
      where request.id in (${sql.join(selected.map((row) => row.id))})
      union all
      select navigation.request_id, parent.id, parent.title, parent.purpose,
        coalesce(ancestor.parent_thread_id, parent.parent_thread_id), ancestor.parent_assignment_id,
        not parent.listed, navigation.seen || parent.id, navigation.depth + 1
      from navigation join threads parent on parent.id = navigation.next_thread_id
      left join delegations ancestor on ancestor.id = navigation.next_assignment_id
      where navigation.roll_up and not parent.id = any(navigation.seen)
    ) select distinct on (request_id) request_id as "requestId", purpose, id, title
      from navigation order by request_id, depth desc`.execute(transaction)
      : { rows: [] };
    const byRequest = new Map(navigation.rows.map((row) => [row.requestId, row]));
    const requests = selected.map((row) => {
      const target = byRequest.get(row.id);
      if (!target) throw new Error("Request lost its originating task");
      return {
        kind: "request" as const,
        request: PendingRequestViewSchema.parse(requestFromRow(row)),
        originThreadId: row.originatingThreadId,
        navigationThreadId: target.id,
        title: target.title,
        purpose: target.purpose,
      };
    });
    const byId = new Map<string, NeedsYouEntry>(
      requests.map((entry) => [`request:${entry.request.id}`, entry]),
    );
    const candidates = keys.map((key) => {
      const entry = byId.get(key.id);
      if (!entry) throw new Error("Attention lost its canonical source");
      return entry;
    });
    const bounded = boundedSerializedPrefix(candidates, limit, maxBytes);
    if (candidates.length && !bounded.items.length)
      throw new OpensteerError({
        code: "resource_exhausted",
        message: "A pending Request exceeds the page byte limit.",
      });
    const entries = [...bounded.items];
    const last = keys[entries.length - 1];
    const count = state.needsYouCount;
    return NeedsYouPageSchema.parse({
      count,
      entries,
      window: {
        byteCount: bounded.byteCount,
        hasMore: candidates.length > entries.length,
        itemCount: entries.length,
        totalItems: count,
        nextBefore:
          candidates.length > entries.length && last
            ? encodeWindowCursor("request", input.userId, last.at, last.id)
            : null,
      },
    });
  });
}
