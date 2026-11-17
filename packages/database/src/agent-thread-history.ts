import {
  OpensteerError,
  requestTitleText,
  utf8Prefix,
  type ExecutionNodeId,
  type IntegrationCallSubject,
  type Message,
  type RequestId,
  type RunId,
  type ThreadId,
  type UserId,
} from "@opensteer/core";
import {
  TranscriptOrderCursorSchema,
  type TranscriptOrderCursor,
} from "@opensteer/protocol/transcript";
import { sql, type Kysely, type Transaction } from "kysely";
import { z } from "zod";
import type { PlaceView } from "./personal-state-schema.js";
import { authorizedDetail, authorizedSyncState } from "./personal-sync-store.js";
import { withPersonalReadTransaction } from "./personal-transaction.js";
import type { DatabaseSchema } from "./schema.js";
import { executionNodeFromRow, messageFromRow } from "./thread-row-mappers.js";

type Database = Kysely<DatabaseSchema>;
type Tx = Transaction<DatabaseSchema>;
type ActivityKey = Pick<TranscriptOrderCursor, "beforePosition" | "beforeId">;
type ActivityBase = {
  readonly id: string;
  readonly position: string;
  readonly runId: RunId | null;
  readonly createdAt: string;
};
export type AgentThreadActivityItem = ActivityBase &
  (
    | { type: "message"; message: Message }
    | {
        type: "tool.started" | "tool.completed";
        title: string | null;
        status: string;
        text: string | null;
        integration: IntegrationCallSubject | null;
      }
    | { type: "place.entered"; place: PlaceView }
    | { type: "node.message"; text: string }
    | {
        type: "app.published" | "node.started" | "node.completed";
        title: string | null;
        status: string;
      }
    | {
        type: "request.opened" | "request.resolved" | "request.cancelled";
        requestId: RequestId;
        title: string;
        requestKind: string;
      }
  );

export async function readAgentThreadRecent(
  database: Database,
  input: { threadId: ThreadId; ownerId: UserId; runLimit: number },
) {
  return withPersonalReadTransaction(database, async (tx) => {
    await authorizedSyncState(tx, input.ownerId);
    if (!(await authorizedDetail(tx, input.ownerId, { kind: "thread", threadId: input.threadId })))
      return null;
    const runs = await tx
      .selectFrom("runs")
      .select([
        "id as runId",
        "status",
        "assignmentId",
        "modelSelection",
        "createdAt",
        "startedAt",
        "completedAt",
      ])
      .where("threadId", "=", input.threadId)
      .orderBy("runOrdinal", "desc")
      .limit(Math.max(25, Math.min(50, input.runLimit)))
      .execute();
    const recent = runs.slice(0, 25).map(({ runId }) => runId);
    const places = recent.length
      ? (
          await sql<{ runId: RunId; body: PlaceView }>`
          select recent.run_id, place.body
          from unnest(${recent}::text[]) as recent(run_id)
          cross join lateral (
            select body, position, id from transcript_items
            where run_id=recent.run_id and visible and kind='place'
            order by position desc,id desc limit 8
          ) place
          order by place.position desc,place.id desc
        `.execute(tx)
        ).rows.map(({ runId, body }) => ({ runId, ...body }))
      : [];
    return {
      runs: runs.slice(0, Math.max(1, input.runLimit)).map((run) => ({
        ...run,
        createdAt: run.createdAt.toISOString(),
        startedAt: run.startedAt?.toISOString() ?? null,
        completedAt: run.completedAt?.toISOString() ?? null,
      })),
      places,
    };
  });
}

const activityPageBytes = 640 * 1024;
const activityCursorSchema = TranscriptOrderCursorSchema.extend({
  view: z.enum(["messages", "activity"]),
});

function activityCursor(before: string) {
  try {
    return activityCursorSchema.parse(
      JSON.parse(Buffer.from(before, "base64url").toString("utf8")),
    );
  } catch {
    throw new OpensteerError({ code: "bad_request", message: "Activity cursor is invalid" });
  }
}

function activityMetadata(
  tx: Tx,
  input: {
    threadId: ThreadId;
    nodeId?: ExecutionNodeId;
    messagesOnly?: boolean;
  },
) {
  const query = tx
    .selectFrom("transcriptItems as item")
    .leftJoin("messages as message", "message.id", "item.messageId")
    .select(["item.id", "item.position"])
    .select(
      sql<number>`coalesce(octet_length(jsonb_build_array(message.content,message.author,message.quote,message.origin)::text),0)`.as(
        "messageBytes",
      ),
    )
    .where("item.threadId", "=", input.threadId)
    .where(sql<boolean>`item.visible`);
  if (input.nodeId)
    return query
      .where("item.nodeId", "=", input.nodeId)
      .where(
        input.messagesOnly
          ? sql<boolean>`item.kind='node-message'`
          : sql<boolean>`item.kind in ('node-message','tool')`,
      );
  return query
    .where("item.nodeId", "is", null)
    .where(sql<boolean>`item.kind in ('message','tool','place','app','request','node')`)
    .where(sql<boolean>`item.kind <> 'message' or message.published`);
}

async function activityItems(
  tx: Tx,
  input: { threadId: ThreadId; ownerId: UserId; itemId?: string },
  ids: string[],
) {
  if (!ids.length) return [];
  const named = input.itemId !== undefined;
  const rows = await tx
    .selectFrom("transcriptItems as item")
    .leftJoin("runs as run", "run.id", "item.runId")
    .leftJoin("toolCalls as tool", "tool.id", "item.toolCallId")
    .leftJoin("requests as request", "request.id", "item.requestId")
    .leftJoin("executionNodes as node", "node.id", "item.executionNodeId")
    .select([
      "item.id",
      "item.position",
      "item.runId",
      "item.createdAt",
      "item.kind",
      "item.view",
      "item.messageId",
      "item.requestId",
      "tool.tool",
      "tool.status as toolStatus",
      "tool.integration",
      "tool.isError",
      "request.status as requestStatus",
      "request.kind as requestKind",
      "node.title as nodeTitle",
      "node.status as nodeStatus",
    ])
    .select([
      sql<boolean>`request.presentation->>'agentProposed' = 'true'`.as("agentProposed"),
      sql<string | null>`left(request.presentation->>'title',240)`.as("requestTitle"),
      sql<string | PlaceView | null>`case when item.kind='place' then item.body
        when item.kind='node-message' then case when ${named} and octet_length(item.body::text)<=491520 then item.body
          else to_jsonb(left(item.body#>>'{}',2048)) end end`.as("placeOrText"),
      sql<string | null>`case when run.requested_by=${input.ownerId} and tool.tool is not null then
        case when tool.status='completed' then
          case when ${named} and octet_length(tool.output->>'text')<=51200 then tool.output->>'text'
            else left(tool.output->>'text',501) end
        when ${named} and octet_length(tool.arguments::text)<=491520 then tool.arguments::text end
      end`.as("toolText"),
    ])
    .where("item.threadId", "=", input.threadId)
    .where("item.id", "in", ids)
    .orderBy("item.position", "desc")
    .orderBy("item.id", "desc")
    .execute();
  const messageIds = rows.flatMap((row) => (row.messageId ? [row.messageId] : []));
  const messages = messageIds.length
    ? await tx
        .selectFrom("messages")
        .select([
          "addressedToUserId",
          "quote",
          "author",
          "id",
          "threadId",
          "runId",
          "sequence",
          "kind",
          "actorPrincipalId",
          "origin",
          "revision",
          "editedAt",
          "createdAt",
          "published",
        ])
        .select(({ ref }) =>
          sql<
            Message["content"]
          >`case when octet_length(${ref("content")}::text)<=${activityPageBytes - 4096}
      then ${ref("content")} else '[{"type":"text","text":"[Message exceeds the history read limit]"}]'::jsonb end`.as(
            "content",
          ),
        )
        .where("threadId", "=", input.threadId)
        .where("id", "in", messageIds)
        .where(sql<boolean>`published`)
        .execute()
    : [];
  const byId = new Map(messages.map((row) => [row.id, messageFromRow(row)]));
  return rows.flatMap<AgentThreadActivityItem>((row) => {
    if (row.position === null) return [];
    const base = {
      id: row.id,
      position: row.position,
      runId: row.runId,
      createdAt: row.createdAt.toISOString(),
    };
    switch (row.kind) {
      case "message": {
        const message = row.messageId && byId.get(row.messageId);
        return message ? [{ ...base, type: "message", message }] : [];
      }
      case "tool":
        return [
          {
            ...base,
            type: row.toolStatus === "completed" ? "tool.completed" : "tool.started",
            status:
              row.toolStatus === "open"
                ? "started"
                : row.isError
                  ? "failed"
                  : (row.toolStatus ?? "interrupted"),
            title: row.tool?.name ?? null,
            text: row.toolText,
            integration: row.integration,
          },
        ];
      case "place":
        return row.placeOrText && typeof row.placeOrText === "object"
          ? [{ ...base, type: "place.entered", place: row.placeOrText }]
          : [];
      case "node-message":
        return typeof row.placeOrText === "string"
          ? [{ ...base, type: "node.message", text: row.placeOrText }]
          : [];
      case "app":
        return [
          { ...base, type: "app.published", status: "published", title: row.view.title ?? null },
        ];
      case "node":
        return row.nodeStatus
          ? [
              {
                ...base,
                type: row.nodeStatus === "running" ? "node.started" : "node.completed",
                status: row.nodeStatus === "running" ? "started" : row.nodeStatus,
                title: row.nodeTitle,
              },
            ]
          : [];
      case "request":
        return row.requestId && row.requestKind
          ? [
              {
                ...base,
                type:
                  row.requestStatus === "cancelled"
                    ? "request.cancelled"
                    : row.requestStatus === "pending"
                      ? "request.opened"
                      : "request.resolved",
                requestId: row.requestId,
                title: utf8Prefix(
                  requestTitleText({
                    title: row.requestTitle ?? "Request",
                    ...(row.agentProposed ? { agentProposed: true } : {}),
                  }),
                  240,
                ),
                requestKind: row.requestKind,
              },
            ]
          : [];
      default:
        return [];
    }
  });
}

export async function readAgentThreadActivity(
  database: Database,
  input: {
    threadId: ThreadId;
    ownerId: UserId;
    nodeId?: ExecutionNodeId;
    messagesOnly?: boolean;
    limit: number;
    before?: string;
    itemId?: string;
  },
) {
  return withPersonalReadTransaction(database, async (tx) => {
    const state = await authorizedSyncState(tx, input.ownerId);
    const scope = input.nodeId
      ? { kind: "node" as const, threadId: input.threadId, nodeId: input.nodeId }
      : { kind: "thread" as const, threadId: input.threadId };
    const thread = await authorizedDetail(tx, input.ownerId, scope);
    if (!thread) return null;
    const address = {
      deploymentId: state.deploymentId,
      epoch: state.epoch,
      viewerId: input.ownerId,
      threadId: input.threadId,
      nodeId: input.nodeId ?? null,
      orderRevision: thread.transcriptOrderRevision,
      view: input.messagesOnly ? ("messages" as const) : ("activity" as const),
    };
    const before = input.before === undefined ? null : activityCursor(input.before);
    if (
      before &&
      (before.deploymentId !== address.deploymentId ||
        before.epoch !== address.epoch ||
        before.viewerId !== address.viewerId ||
        before.threadId !== address.threadId ||
        before.nodeId !== address.nodeId ||
        before.view !== address.view ||
        before.orderRevision !== address.orderRevision)
    )
      throw new OpensteerError({
        code: "bad_request",
        message: "Activity changed. Read again without the cursor.",
      });
    const encodeCursor = (key: ActivityKey) =>
      Buffer.from(JSON.stringify({ ...address, ...key })).toString("base64url");
    const limit = Math.min(100, Math.max(1, input.limit));
    let query = activityMetadata(tx, input);
    if (input.itemId) query = query.where("item.id", "=", input.itemId);
    else if (before)
      query = query.where(
        sql<boolean>`(item.position,item.id)<(${before.beforePosition}::bigint,${before.beforeId})`,
      );
    const candidates = await query
      .orderBy("item.position", "desc")
      .orderBy("item.id", "desc")
      .limit(limit + 1)
      .execute();
    const picked = [];
    let bytes = 4096;
    for (const candidate of candidates) {
      if (candidate.position === null) continue;
      const size = candidate.messageBytes + 4096;
      if (picked.length && (picked.length >= limit || bytes + size > activityPageBytes)) break;
      picked.push(candidate);
      bytes += size;
    }
    const oldest = picked.at(-1);
    const hasMore = picked.length < candidates.length;
    const node = input.nodeId
      ? await tx
          .selectFrom("executionNodes")
          .selectAll()
          .where("id", "=", input.nodeId)
          .executeTakeFirstOrThrow()
      : undefined;
    return {
      items: await activityItems(
        tx,
        input,
        picked.map(({ id }) => id),
      ),
      node: node ? executionNodeFromRow(node) : null,
      hasMore,
      nextBefore:
        hasMore && oldest?.position
          ? encodeCursor({ beforePosition: oldest.position, beforeId: oldest.id })
          : null,
      encodeCursor,
    };
  });
}
