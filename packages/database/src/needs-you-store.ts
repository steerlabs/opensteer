import { boundedSerializedPrefix } from "./message-window.js";
import {
  OpensteerError,
  PendingRequestViewSchema,
  type ThreadId,
  type RequestId,
  type TaskPurpose,
  type UserId,
} from "@opensteer/core";
import { NeedsYouPageSchema, type NeedsYouPage, type NeedsYouEntry } from "@opensteer/protocol";
import { sql, type Kysely } from "kysely";
import { requirePersonalOwner } from "./personal-settings-store.js";
import { withPersonalReadTransaction } from "./personal-transaction.js";
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
    readonly deviceAccessRequests?: "include";
    readonly before?: string;
    readonly limit?: number;
    readonly maxBytes?: number;
  },
): Promise<NeedsYouPage> {
  const limit = boundedWindowLimit(input.limit, 50);
  const maxBytes = boundedWindowBytes(input.maxBytes, 256 * 1024);
  const cursor = input.before ? decodeWindowCursor(input.before, "request", input.userId) : null;
  return withPersonalReadTransaction(
    database,
    async (transaction) => {
      await requirePersonalOwner(transaction, input.userId);
      let pending = transaction.selectFrom("requests").where("status", "=", "pending");
      if (input.deviceAccessRequests !== "include")
        pending = pending.where("kind", "!=", "device.access");
      let query = pending
        .selectAll()
        .orderBy("createdAt", "desc")
        .orderBy("id", "desc")
        .limit(limit + 1);
      if (cursor)
        query = query.where((eb) =>
          eb.or([
            eb("createdAt", "<", cursor.timestamp),
            eb.and([eb("createdAt", "=", cursor.timestamp), sql<boolean>`id < ${cursor.id}`]),
          ]),
        );
      const asks = transaction
        .selectFrom("personalTeamRequests")
        .where("kind", "=", "ask")
        .where((eb) =>
          eb.or([
            eb.and([
              eb(
                "teamDeploymentId",
                "in",
                transaction
                  .selectFrom("personalTeamLinks")
                  .select("teamDeploymentId")
                  .where("state", "in", ["active", "unreachable", "needs_update"]),
              ),
              eb("remoteState", "=", "awaiting_approval"),
              eb("localDecision", "is", null),
              eb("terminalState", "is", null),
              eb("consentExpiresAt", ">", new Date()),
            ]),
            eb.and([
              eb("terminalState", "=", "failed"),
              eb("localTaskId", "is", null),
              eb("blockedReason", "is not", null),
            ]),
          ]),
        );
      let askQuery = asks
        .selectAll()
        .orderBy("createdAt", "desc")
        .orderBy("teamDeploymentId", "desc")
        .orderBy("requestId", "desc")
        .limit(limit + 1);
      if (cursor)
        askQuery = askQuery.where((eb) =>
          eb.or([
            eb("createdAt", "<", cursor.timestamp),
            eb.and([
              eb("createdAt", "=", cursor.timestamp),
              sql<boolean>`concat('team:', team_deployment_id, ':', request_id) < ${cursor.id}`,
            ]),
          ]),
        );
      const [rows, total, askRows, askTotal] = await Promise.all([
        query.execute(),
        pending.select(({ fn }) => fn.countAll<string>().as("count")).executeTakeFirstOrThrow(),
        askQuery.execute(),
        asks.select(({ fn }) => fn.countAll<string>().as("count")).executeTakeFirstOrThrow(),
      ]);
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
      const candidates: { entry: NeedsYouEntry; createdAt: string; id: string }[] = [
        ...requests.map((entry) => ({
          entry,
          createdAt: entry.request.createdAt,
          id: entry.request.id,
        })),
        ...askRows.map((row) => ({
          entry: {
            kind: "team-ask" as const,
            teamId: row.teamDeploymentId,
            requestId: row.requestId,
            presentation: row.presentation!,
            createdAt: row.createdAt.toISOString(),
            consentExpiresAt: row.consentExpiresAt!.toISOString(),
            ...(row.terminalState === "failed" && row.blockedReason
              ? { failureReason: row.blockedReason }
              : {}),
          },
          createdAt: row.createdAt.toISOString(),
          id: `team:${row.teamDeploymentId}:${row.requestId}`,
        })),
      ].sort((a, b) =>
        a.createdAt === b.createdAt
          ? a.id < b.id
            ? 1
            : a.id > b.id
              ? -1
              : 0
          : a.createdAt < b.createdAt
            ? 1
            : -1,
      );
      const bounded = boundedSerializedPrefix(
        candidates.map((item) => item.entry),
        limit,
        maxBytes,
      );
      if (candidates.length && !bounded.items.length)
        throw new OpensteerError({
          code: "resource_exhausted",
          message: "A pending Request exceeds the page byte limit.",
        });
      const entries = [...bounded.items];
      const last = candidates[entries.length - 1];
      const count = safeCount(total.count) + safeCount(askTotal.count);
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
              ? encodeWindowCursor("request", input.userId, last.createdAt, last.id)
              : null,
        },
      });
    },
    "repeatable read",
  );
}
