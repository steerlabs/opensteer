import type { DatabaseSchema } from "./schema.js";
import {
  type DeploymentId,
  type RequestId,
  type TeamAgentRequestId,
  type ThreadId,
  type ExecutionNodeId,
  utf8Prefix,
} from "@opensteer/core";
import { sql, type Insertable } from "kysely";
import {
  commitPersonalMutation,
  type PersonalMutation,
  type PersonalMutationTransaction,
} from "./personal-mutation.js";
import type { PersonalAttentionTable } from "./personal-state-schema.js";
import { executionDate } from "./personal-transaction.js";
import { publishThreadSummary } from "./thread-status.js";

type Tx = PersonalMutationTransaction;
const liveLinkStates = ["active", "unreachable", "needs_update"] as const;
type LinkState = DatabaseSchema["personalTeamLinks"]["state"];

function eligibleLink(state: LinkState): boolean {
  return state === "active" || state === "unreachable" || state === "needs_update";
}

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
      title: utf8Prefix(value.title || (value.kind === "request" ? "Request" : "Team ask"), 240),
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
  await tx
    .updateTable("personalAttention")
    .set({ revision: mutation.sequence })
    .where(
      "id",
      "in",
      asking.map((request) => `request:${request.id}`),
    )
    .execute();
  for (const request of asking)
    attentionChanged(mutation, `request:${request.id}`, {
      kind: "request",
      threadId: request.originatingThreadId,
      revision: mutation.sequence,
      title: request.title,
    });
}

/**
 * A task's title or listing changed. The Waiting Requests list names the tasks a pending Request
 * sits in, the work it holds up and the listed task above it, so if any pending Request is at or
 * below this task, the list changed. Walks up from pending Requests only.
 */
export async function republishPendingRequestsShowing(tx: Tx, threadId: ThreadId) {
  const shown = await sql<{ shown: boolean }>`
    with recursive pending as materialized (
      select requests.originating_thread_id,runs.assignment_id from requests
      left join runs on runs.id=requests.originating_run_id
      where requests.status='pending'
    ), chain(id) as (
      select assignment_id from pending where assignment_id is not null
      union
      select held.parent_assignment_id from chain join delegations held on held.id=chain.id
      where held.parent_assignment_id is not null
    ), above(thread_id) as (
      (select originating_thread_id from pending where originating_thread_id is not null
       union
       select held.child_thread_id from chain join delegations held on held.id=chain.id
       union
       select held.parent_thread_id from chain join delegations held on held.id=chain.id)
      union
      select t.parent_thread_id from above join threads t on t.id=above.thread_id
      where t.parent_thread_id is not null
    )
    select exists (select 1 from above where thread_id=${threadId}) as shown
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
    if (source.kind === "device.access") mutation.count("pendingDeviceAccessRequestCount", delta);
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
            teamDeploymentId: null,
            teamRequestId: null,
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

export async function refreshTeamAskAttention(
  tx: Tx,
  mutation: PersonalMutation,
  teamDeploymentId: DeploymentId,
  requestId: TeamAgentRequestId,
) {
  const id = `team:${teamDeploymentId}:${requestId}`;
  const source = await tx
    .selectFrom("personalTeamRequests")
    .select([
      "kind",
      "terminalState",
      "remoteState",
      "localDecision",
      "releasedAt",
      "blockedReason",
      "localTaskId",
      "createdAt",
      "consentExpiresAt",
    ])
    .select(sql<string | null>`left(presentation->>'title',192)`.as("title"))
    .where("teamDeploymentId", "=", teamDeploymentId)
    .where("requestId", "=", requestId)
    .executeTakeFirst();
  if (!source) throw new Error("The team ask must be refreshed before deleting its source");
  const link = await tx
    .selectFrom("personalTeamLinks")
    .select(["id", "state"])
    .where("teamDeploymentId", "=", teamDeploymentId)
    .forNoKeyUpdate()
    .executeTakeFirstOrThrow();
  const previous = await previousAttentionKind(tx, mutation, id);
  const failed =
    source.kind === "ask" &&
    source.terminalState === "failed" &&
    source.releasedAt === null &&
    source.blockedReason !== null;
  const ordinary =
    source.kind === "ask" &&
    source.remoteState === "awaiting_approval" &&
    source.localDecision === null &&
    source.terminalState === null &&
    source.consentExpiresAt !== null &&
    // A team ask's expiry arrives as a time the Host compares on its own clock.
    source.consentExpiresAt > executionDate(tx);
  const bucketDelta = Number(ordinary) - Number(previous === "team-ask");
  if (bucketDelta) {
    await tx
      .updateTable("personalTeamLinks")
      .set({
        approvalAttentionCount: sql<number>`approval_attention_count + ${bucketDelta}`,
      })
      .where("id", "=", link.id)
      .execute();
  }
  mutation.count(
    "needsYouCount",
    Number(failed) -
      Number(previous === "failed-ask") +
      (eligibleLink(link.state) ? bucketDelta : 0),
  );
  if (failed || ordinary || previous) {
    const visible = failed || previous === "failed-ask" || eligibleLink(link.state);
    stageAttention(
      tx,
      mutation,
      id,
      failed || ordinary
        ? {
            id,
            kind: failed ? "failed-ask" : "team-ask",
            requestId: null,
            teamDeploymentId,
            teamRequestId: requestId,
            threadId: source.localTaskId,
            sortAt: source.createdAt,
            expiresAt: ordinary ? source.consentExpiresAt : null,
            revision: visible ? mutation.sequence : mutation.state.sequence,
          }
        : null,
    );
    if (visible)
      attentionChanged(
        mutation,
        id,
        failed || (ordinary && eligibleLink(link.state))
          ? {
              kind: failed ? "failed-ask" : "team-ask",
              threadId: source.localTaskId,
              revision: mutation.sequence,
              title: source.title,
              preview: failed ? utf8Prefix(source.blockedReason ?? "", 160) : null,
            }
          : null,
      );
  }
  if (source.kind === "ask") mutation.react({ type: "deadlinesChanged" });
}

export function updateAttentionLinkContribution(
  mutation: PersonalMutation,
  input: { readonly before: LinkState; readonly after: LinkState; readonly bucket: number },
) {
  const delta = Number(eligibleLink(input.after)) - Number(eligibleLink(input.before));
  if (delta && input.bucket) {
    mutation.count("needsYouCount", delta * input.bucket);
    // A whole team's approval asks appear or disappear: the shell is repaired by snapshot.
    mutation.resetScope("shell");
  }
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

export async function refreshLatestRunCompletion(
  tx: Tx,
  mutation: PersonalMutation,
  threadId: ThreadId,
  before: number,
  /** The caller changed nothing else unread depends on, so an unchanged completion keeps it. */
  onlyCompletion = false,
): Promise<{ readonly latestRunCompletedAt: Date | null } | undefined> {
  const completion = sql<Date | null>`(select case when status in ('completed','interrupted','failed') then completed_at end
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
    readonly excludeDeviceAccess?: boolean;
  },
) {
  const limit = Math.max(1, Math.min(input.limit, 50)) + 1;
  const seek = input.before
    ? sql`and (sort_at,id)<(${input.before.at}::timestamptz,${input.before.id})`
    : sql``;
  const deviceFilter = input.excludeDeviceAccess
    ? sql`and not exists (select 1 from requests r where r.id = personal_attention.request_id and r.kind = 'device.access')`
    : sql``;
  return (
    await sql<{
      id: string;
      kind: PersonalAttentionTable["kind"];
      at: string;
      requestId: RequestId | null;
      teamDeploymentId: DeploymentId | null;
      teamRequestId: TeamAgentRequestId | null;
      threadId: ThreadId | null;
      revision: string;
      title: string | null;
      blockedReason: string | null;
    }>`
    with selected as materialized (
      (select id,kind,request_id,team_deployment_id,team_request_id,sort_at from personal_attention
       where kind in ('request','failed-ask') ${seek} ${deviceFilter} order by sort_at desc,id desc limit ${limit})
      union all
      (select ask.id,ask.kind,ask.request_id,ask.team_deployment_id,ask.team_request_id,ask.sort_at
       from personal_team_links link cross join lateral (
         select id,kind,request_id,team_deployment_id,team_request_id,sort_at from personal_attention
         where team_deployment_id=link.team_deployment_id and kind='team-ask'
          ${seek}
         order by sort_at desc,id desc limit ${limit}
       ) ask where link.approval_attention_count>0 and link.state in (${sql.join(liveLinkStates)})
      )
      order by sort_at desc,id desc limit ${limit}
    )
    select selected.id,selected.kind,selected.request_id,selected.team_deployment_id,selected.team_request_id,
      to_char(selected.sort_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at,
      attention.thread_id,greatest(request.revision,attention.revision)::text as revision,
      left(coalesce(request.presentation->>'title',mirror.presentation->>'title'),192) as title,
      left(mirror.blocked_reason,160) as blocked_reason
    from selected join personal_attention attention on attention.id=selected.id
    left join requests request on request.id=selected.request_id
    left join personal_team_requests mirror
      on (mirror.team_deployment_id,mirror.request_id)=(selected.team_deployment_id,selected.team_request_id)
    order by selected.sort_at desc,selected.id desc
  `.execute(tx)
  ).rows;
}
