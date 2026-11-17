import type { DeploymentId, RequestId, TeamAgentRequestId, ThreadId } from "@opensteer/core";
import { sql, type Insertable } from "kysely";
import type { PersonalMutation, PersonalMutationTransaction } from "./personal-mutation.js";
import type { PersonalAttentionTable } from "./personal-state-schema.js";

type Tx = PersonalMutationTransaction;
const liveLinkStates = ["active", "unreachable", "needs_update"] as const;
type LinkState =
  import("./personal-state-schema.js").PersonalStateSchema["personalTeamLinks"]["state"];

function eligibleLink(state: LinkState): boolean {
  return state === "active" || state === "unreachable" || state === "needs_update";
}

function needsYouChanged(mutation: PersonalMutation) {
  mutation.change(
    {
      scopeKey: "shell",
      entityKind: "collection",
      entityId: "needs-you",
      operation: "invalidate",
    },
    () => ({ revision: mutation.sequence }),
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

export async function refreshRequestAttention(
  tx: Tx,
  mutation: PersonalMutation,
  requestId: RequestId,
) {
  const source = await tx
    .selectFrom("requests")
    .select(["id", "status", "originatingThreadId", "createdAt"])
    .where("id", "=", requestId)
    .executeTakeFirst();
  if (!source) throw new Error("The Request must be refreshed before deleting its source");
  const id = `request:${requestId}`;
  const previous = await tx
    .selectFrom("personalAttention")
    .select("id")
    .where("id", "=", id)
    .executeTakeFirst();
  const pending = source.status === "pending";
  const delta = Number(pending) - Number(previous !== undefined);
  if (delta) {
    await tx
      .updateTable("threads")
      .set({
        pendingRequestCount: sql<number>`pending_request_count + ${delta}`,
        revision: mutation.sequence,
      })
      .where("id", "=", source.originatingThreadId)
      .execute();
    mutation.count("pendingRequestCount", delta);
    mutation.count("needsYouCount", delta);
  }
  if (pending || previous) {
    await writeAttention(
      tx,
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
    needsYouChanged(mutation);
  }
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
  const previous = await tx
    .selectFrom("personalAttention")
    .select("kind")
    .where("id", "=", id)
    .executeTakeFirst();
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
    source.consentExpiresAt > mutation.state.now;
  const bucketDelta = Number(ordinary) - Number(previous?.kind === "team-ask");
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
      Number(previous?.kind === "failed-ask") +
      (eligibleLink(link.state) ? bucketDelta : 0),
  );
  if (failed || ordinary || previous) {
    await writeAttention(
      tx,
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
            revision: mutation.sequence,
          }
        : null,
    );
    if (failed || previous?.kind === "failed-ask" || eligibleLink(link.state))
      needsYouChanged(mutation);
  }
}

export function updateAttentionLinkContribution(
  mutation: PersonalMutation,
  input: { readonly before: LinkState; readonly after: LinkState; readonly bucket: number },
) {
  const delta = Number(eligibleLink(input.after)) - Number(eligibleLink(input.before));
  if (delta && input.bucket) {
    mutation.count("needsYouCount", delta * input.bucket);
    needsYouChanged(mutation);
  }
}

export async function unreadTaskContribution(tx: Tx, threadId: ThreadId) {
  const unread = (
    await sql<{ unread: boolean }>`
    select listed and purpose='task' and status<>'archived' and removed_at is null and latest_run_completed_at is not null
      and (last_visited_at is null or latest_run_completed_at>last_visited_at) as unread
    from threads t left join thread_visits v on v.thread_id=t.id and v.user_id=t.created_by where t.id=${threadId}
  `.execute(tx)
  ).rows[0];
  return Number(unread?.unread ?? false);
}

export async function refreshLatestRunCompletion(
  tx: Tx,
  mutation: PersonalMutation,
  threadId: ThreadId,
  before: number,
) {
  await tx
    .updateTable("threads")
    .set({
      latestRunCompletedAt: sql<Date | null>`(select case when status in ('completed','interrupted','failed') then completed_at end
      from runs where thread_id=${threadId} and maintenance is null order by run_ordinal desc limit 1)`,
      revision: mutation.sequence,
    })
    .where("id", "=", threadId)
    .execute();
  const delta = (await unreadTaskContribution(tx, threadId)) - before;
  if (delta) {
    mutation.count("unreadTaskCount", delta);
    mutation.change(
      {
        scopeKey: "shell",
        entityKind: "collection",
        entityId: "unread-tasks",
        operation: "invalidate",
      },
      () => ({ revision: mutation.sequence }),
    );
  }
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
    ? sql`and (sort_at,id)<(${input.before.at}::timestamptz,${input.before.id})`
    : sql``;
  return (
    await sql<{
      id: string;
      kind: PersonalAttentionTable["kind"];
      at: string;
      requestId: RequestId | null;
      teamDeploymentId: DeploymentId | null;
      teamRequestId: TeamAgentRequestId | null;
    }>`
    select id,kind,request_id,team_deployment_id,team_request_id,
      to_char(sort_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at
    from (
      (select id,kind,request_id,team_deployment_id,team_request_id,sort_at from personal_attention
       where kind in ('request','failed-ask') ${seek} order by sort_at desc,id desc limit ${limit})
      union all
      (select ask.id,ask.kind,ask.request_id,ask.team_deployment_id,ask.team_request_id,ask.sort_at
       from personal_team_links link cross join lateral (
         select id,kind,request_id,team_deployment_id,team_request_id,sort_at from personal_attention
         where team_deployment_id=link.team_deployment_id and kind='team-ask' ${seek}
         order by sort_at desc,id desc limit ${limit}
       ) ask where link.approval_attention_count>0 and link.state in (${sql.join(liveLinkStates)})
      )
    ) selected order by sort_at desc,id desc limit ${limit}
  `.execute(tx)
  ).rows;
}
