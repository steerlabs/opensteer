import { type RequestId, type ThreadId, type ExecutionNodeId, utf8Prefix } from "@opensteer/core";
import { sql, type Insertable } from "kysely";
import {
  commitPersonalMutation,
  type PersonalMutation,
  type PersonalMutationTransaction,
} from "./personal-mutation.js";
import type { PersonalAttentionTable } from "./personal-state-schema.js";
import { publishThreadSummary } from "./thread-status.js";

type Tx = PersonalMutationTransaction;

function attentionChanged(
  mutation: PersonalMutation,
  id: string,
  value: {
    readonly kind: PersonalAttentionTable["kind"];
    readonly threadId: ThreadId | null;
    readonly revision: string;
    readonly title: string | null;
    readonly preview?: string | null;
  } | null,
) {
  if (!value) {
    mutation.change({
      scopeKey: "shell",
      entityKind: "attention",
      entityId: id,
      operation: "remove",
    });
    return;
  }
  mutation.change(
    { scopeKey: "shell", entityKind: "attention", entityId: id, operation: "upsert" },
    () => ({
      id,
      kind: value.kind,
      threadId: value.threadId,
      revision: value.revision,
      title: utf8Prefix(value.title || "Request", 240),
      ...(value.preview ? { preview: utf8Prefix(value.preview, 500) } : {}),
    }),
  );
}

async function writeAttention(tx: Tx, id: string, row: Insertable<PersonalAttentionTable> | null) {
  if (row) {
    await tx
      .insertInto("personalAttention")
      .values(row)
      .onConflict((conflict) =>
        conflict.column("id").doUpdateSet({
          kind: row.kind,
          threadId: row.threadId,
          sortAt: row.sortAt,
          expiresAt: row.expiresAt,
          revision: row.revision,
        }),
      )
      .execute();
  } else await tx.deleteFrom("personalAttention").where("id", "=", id).execute();
}

async function previousAttentionKind(tx: Tx, mutation: PersonalMutation, id: string) {
  const staged = mutation.attentionKind(id);
  if (staged !== undefined) return staged;
  const row = await tx
    .selectFrom("personalAttention")
    .select("kind")
    .where("id", "=", id)
    .executeTakeFirst();
  return row?.kind ?? null;
}

function stageAttention(
  tx: Tx,
  mutation: PersonalMutation,
  id: string,
  row: Insertable<PersonalAttentionTable> | null,
) {
  mutation.stageAttention(id, row?.kind ?? null, () => writeAttention(tx, id, row));
}

/**
 * A pending Request's asker presentation (its node's title and the node it sits within) is read
 * with the Request list; when those change, its attention row moves forward so readers reread.
 * The move is stored on the attention row, so a repair reads the same revision as the feed.
 * Driven from pending Requests, so a node's history is never scanned.
 */
export async function republishAskerAttention(
  tx: Tx,
  mutation: PersonalMutation,
  nodeId: ExecutionNodeId,
  /** The node's title changed, which its children's Requests show as where they sit. */
  childrenToo: boolean,
) {
  const sits = childrenToo ? sql`or node.parent_node_id=${nodeId}` : sql``;
  const asking = (
    await sql<{ id: RequestId; originatingThreadId: ThreadId | null; title: string | null }>`
    with pending as materialized (
      select id,originating_node_id,originating_thread_id,presentation from requests
      where status='pending' and originating_node_id is not null
    )
    select pending.id,pending.originating_thread_id as "originatingThreadId",
      left(pending.presentation->>'title',192) as title
    from pending join execution_nodes node on node.id=pending.originating_node_id
    where node.id=${nodeId} ${sits}
  `.execute(tx)
  ).rows;
  if (!asking.length) return;
  mutation.pendingRequestsChanged();
  for (const request of asking) {
    const id = `request:${request.id}`;
    // Written with the commit's other attention rows, in their order; a row this commit
    // already writes carries this revision.
    if (mutation.attentionKind(id) === undefined)
      mutation.stageAttention(id, "request", async () => {
        await tx
          .updateTable("personalAttention")
          .set({ revision: mutation.sequence })
          .where("id", "=", id)
          .execute();
      });
    attentionChanged(mutation, id, {
      kind: "request",
      threadId: request.originatingThreadId,
      revision: mutation.sequence,
      title: request.title,
    });
  }
}

/**
 * A task's title or listing changed. The Waiting Requests list shows, for each pending Request,
 * the title of every worker task in the delegation chain it holds up, and, when it sits outside any
 * listed task, the title of the task just below the nearest listed one (`via`). So a rename moves
 * the list only if this task is one of those, and a listing change only if this task lies on a
 * pending Request's way up to its nearest listed task. Walks up from pending Requests only.
 */
export async function republishPendingRequestsShowing(
  tx: Tx,
  threadId: ThreadId,
  change: "title" | "listing",
) {
  const shown = await sql<{ shown: boolean }>`
    with recursive pending as materialized (
      select requests.id as request_id,requests.originating_thread_id,runs.assignment_id
      from requests left join runs on runs.id=requests.originating_run_id
      where requests.status='pending'
    ), chain(request_id, id, depth) as (
      select request_id, assignment_id, 0 from pending where assignment_id is not null
      union all
      select chain.request_id, held.parent_assignment_id, chain.depth + 1
      from chain join delegations held on held.id=chain.id
      where held.parent_assignment_id is not null and chain.depth < 64
    ), links as materialized (
      select chain.request_id, chain.depth, held.child_thread_id, held.parent_thread_id
      from chain join delegations held on held.id=chain.id
    ), outermost as (
      select pending.request_id, coalesce((
        select links.parent_thread_id from links where links.request_id=pending.request_id
        order by links.depth desc limit 1
      ), pending.originating_thread_id) as thread_id
      from pending
    ), lineage(request_id, thread_id, listed, parent_id, depth) as (
      select outermost.request_id, t.id, t.listed, t.parent_thread_id, 0
      from outermost join threads t on t.id=outermost.thread_id
      union all
      select lineage.request_id, t.id, t.listed, t.parent_thread_id, lineage.depth + 1
      from lineage join threads t on t.id=lineage.parent_id
      where not lineage.listed and lineage.depth < 64
    ), stops as (
      select request_id, min(depth) as depth from lineage
      where listed or parent_id is null group by request_id
    ), via as (
      select lineage.thread_id from lineage join stops using (request_id)
      where lineage.depth = stops.depth - 1
    )
    select exists (
      ${
        change === "title"
          ? sql`select 1 from links where child_thread_id=${threadId}
              union all select 1 from via where thread_id=${threadId}`
          : sql`select 1 from lineage where thread_id=${threadId}`
      }
    ) as shown
  `.execute(tx);
  if (!shown.rows[0]?.shown) return;
  await commitPersonalMutation(tx, async (_tx, mutation) => mutation.pendingRequestsChanged());
}

export async function refreshRequestAttention(
  tx: Tx,
  mutation: PersonalMutation,
  requestId: RequestId,
) {
  const source = await tx
    .selectFrom("requests")
    .select([
      "id",
      "kind",
      "status",
      "originatingThreadId",
      "originatingRunId",
      "createdAt",
      "revision",
    ])
    .select(sql<string | null>`left(presentation->>'title',192)`.as("title"))
    .where("id", "=", requestId)
    .executeTakeFirst();
  if (!source) throw new Error("The Request must be refreshed before deleting its source");
  const id = `request:${requestId}`;
  const previous = await previousAttentionKind(tx, mutation, id);
  const pending = source.status === "pending";
  const delta = Number(pending) - Number(previous !== null);
  if (delta) {
    mutation.touchThread(source.originatingThreadId);
    mutation.count("pendingRequestCount", delta);
    mutation.count("needsYouCount", delta);
  }
  if (pending || previous) {
    mutation.pendingRequestsChanged();
    stageAttention(
      tx,
      mutation,
      id,
      pending
        ? {
            id,
            kind: "request",
            requestId,
            threadId: source.originatingThreadId,
            sortAt: source.createdAt,
            expiresAt: null,
            revision: mutation.sequence,
          }
        : null,
    );
    attentionChanged(
      mutation,
      id,
      pending
        ? {
            kind: "request",
            threadId: source.originatingThreadId,
            // The staged attention row's revision, which a snapshot reads back.
            revision: mutation.sequence,
            title: source.title,
          }
        : null,
    );
  }
  mutation.react({
    type: "requestChanged",
    requestId,
    kind: source.kind,
    status: source.status,
    opened: pending && previous === null,
    threadId: source.originatingThreadId,
    runId: source.originatingRunId,
  });
}

export const unreadTaskSql = sql<boolean>`(select listed and purpose='task' and status<>'archived'
    and removed_at is null and latest_run_completed_at is not null
    and (last_visited_at is null or latest_run_completed_at>last_visited_at)
  from threads t left join thread_visits v on v.thread_id=t.id and v.user_id=t.created_by
  where t.id=threads.id)`;

export async function unreadTaskContribution(tx: Tx, threadId: ThreadId) {
  const unread = await tx
    .selectFrom("threads")
    .select(unreadTaskSql.as("unread"))
    .where("id", "=", threadId)
    .executeTakeFirst();
  return Number(unread?.unread ?? false);
}

/**
 * When the end of the Run aliased `run` is news to its task's owner, or null. A Run that completed
 * or failed is news, as is one the Host, an agent or a teammate cut short after it started. One the
 * person stopped themselves is not, nor one that ended before it started: there is nothing to see.
 * A task's `latest_run_completed_at` is this for its latest Run, and unread compares it with the
 * owner's visit.
 */
export function runNewsAt(run: string) {
  const status = sql.ref(`${run}.status`);
  return sql<Date | null>`case when ${status} in ('completed','failed') or (${status}='interrupted'
    and ${sql.ref(`${run}.started_at`)} is not null
    and not exists (select from commands where commands.run_id=${sql.ref(`${run}.id`)}
      and commands.type='run.interrupt' and commands.authority_source->>'kind'='user-session'))
    then ${sql.ref(`${run}.completed_at`)} end`;
}

export async function refreshLatestRunCompletion(
  tx: Tx,
  mutation: PersonalMutation,
  threadId: ThreadId,
  before: number,
  /** The caller changed nothing else unread depends on, so an unchanged completion keeps it. */
  onlyCompletion = false,
): Promise<{ readonly latestRunCompletedAt: Date | null } | undefined> {
  const completion = sql<Date | null>`(select ${runNewsAt("runs")}
      from runs where thread_id=${threadId} and maintenance is null order by run_ordinal desc limit 1)`;
  const changed = await tx
    .updateTable("threads")
    .set({ latestRunCompletedAt: completion, revision: mutation.sequence })
    .where("id", "=", threadId)
    .where(sql<boolean>`latest_run_completed_at is distinct from ${completion}`)
    .returning("latestRunCompletedAt")
    .executeTakeFirst();
  if (!changed && onlyCompletion) return undefined;
  const delta = (await unreadTaskContribution(tx, threadId)) - before;
  if (delta) mutation.count("unreadTaskCount", delta);
  if (delta || changed) await publishThreadSummary(tx, threadId);
  return changed;
}

export async function readAttentionKeys(
  tx: Tx,
  input: {
    readonly before?: { readonly at: string; readonly id: string };
    readonly limit: number;
  },
) {
  const limit = Math.max(1, Math.min(input.limit, 50)) + 1;
  const seek = input.before
    ? sql`and (attention.sort_at,attention.id)<(${input.before.at}::timestamptz,${input.before.id})`
    : sql``;
  // Only Requests: an attention row of a kind this release no longer has is left out.
  return (
    await sql<{
      id: string;
      kind: PersonalAttentionTable["kind"];
      at: string;
      requestId: RequestId | null;
      threadId: ThreadId | null;
      revision: string;
      title: string | null;
    }>`
    select attention.id,attention.kind,attention.request_id,
      to_char(attention.sort_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at,
      attention.thread_id,greatest(request.revision,attention.revision)::text as revision,
      left(request.presentation->>'title',192) as title
    from personal_attention attention
    left join requests request on request.id=attention.request_id
    where attention.kind='request' ${seek}
    order by attention.sort_at desc,attention.id desc limit ${limit}
  `.execute(tx)
  ).rows;
}
