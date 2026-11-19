import { OpensteerError, utf8Prefix, type ThreadId, type UserId } from "@opensteer/core";
import { PersonalRevisionSchema } from "@opensteer/protocol/resources";
import { TranscriptOrderCursorSchema } from "@opensteer/protocol/transcript";
import { sql, type Kysely, type Transaction } from "kysely";
import { z } from "zod";
import { boundedSerializedPrefix } from "./message-window.js";
import {
  authorizedDetail,
  authorizedSyncState,
  drawableItems,
  itemView,
  type PersonalReadScope,
  withPersonalSyncRead,
} from "./personal-sync-store.js";
import type { DatabaseSchema } from "./schema.js";

type DetailScope = Exclude<PersonalReadScope, { kind: "shell" }>;
type Read = Transaction<DatabaseSchema>;
const TranscriptOverlayKindSchema = z.enum(["requests", "tools", "nodes"]);
const TranscriptOverlayCursorSchema = TranscriptOrderCursorSchema.omit({
  beforePosition: true,
}).extend({ kind: TranscriptOverlayKindSchema, revision: PersonalRevisionSchema });
type TranscriptOverlayCursor = z.infer<typeof TranscriptOverlayCursorSchema>;
type TranscriptOverlayKind = z.infer<typeof TranscriptOverlayKindSchema>;
type Address = Omit<TranscriptOverlayCursor, "beforeId" | "kind">;

export function encodeOverlayCursor(cursor: TranscriptOverlayCursor) {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeOverlayCursor(cursor: string) {
  try {
    return TranscriptOverlayCursorSchema.parse(
      JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")),
    );
  } catch {
    throw new OpensteerError({ code: "bad_request", message: "The overlay cursor is invalid" });
  }
}

export function activeRunQueue(tx: Read, threadId: ThreadId) {
  return tx
    .selectFrom("runs")
    .select(["id", "status", "revision", "createdAt", "runOrdinal"])
    .select(sql<boolean>`finish_intent is not null`.as("finishing"))
    .where("threadId", "=", threadId)
    .where(sql<boolean>`status in ('queued','starting','running','waiting')`)
    .orderBy("runOrdinal")
    .limit(2)
    .execute()
    .then((runs) => runs.map((run) => ({ ...run, createdAt: run.createdAt.toISOString() })));
}

export async function overlayPage(
  tx: Read,
  scope: DetailScope,
  address: Address,
  kind: TranscriptOverlayKind,
  limit = 20,
  budget = 16 * 1024 - 1024,
  beforeId?: string,
  /** The task's queued and running Runs, when the caller already read them in this cut. */
  activeRuns?: Awaited<ReturnType<typeof activeRunQueue>>,
) {
  const candidatesLimit = limit + 1;
  const page = <T>(rows: number, selected: readonly { id: string; value: T }[]) => {
    const oldest = selected.at(-1);
    const hasMore = rows > selected.length;
    return {
      items: selected.map(({ value }) => value),
      hasMore,
      nextBefore: hasMore && oldest ? { ...address, kind, beforeId: oldest.id } : null,
    };
  };
  if (kind === "requests") {
    let query = tx
      .selectFrom("requests")
      .select(["id", "kind", "status", "revision", "originatingThreadId as threadId"])
      .select(sql<string>`left(presentation->>'title',192)`.as("title"))
      .where("originatingThreadId", "=", scope.threadId)
      .where(sql<boolean>`status='pending'`);
    query =
      scope.kind === "thread"
        ? query.where("originatingNodeId", "is", null)
        : query.where("originatingNodeId", "=", scope.nodeId);
    if (beforeId) query = query.where(sql<boolean>`id > ${beforeId}`);
    const rows = await query.orderBy("id").limit(candidatesLimit).execute();
    const selected = boundedSerializedPrefix(
      rows.map((row) => ({
        id: row.id,
        value: { ...row, title: utf8Prefix(row.title || "Request", 240) },
      })),
      limit,
      budget,
    );
    return { kind: "requests" as const, ...page(rows.length, selected.items) };
  }
  const nodeId = scope.kind === "node" ? scope.nodeId : null;
  let ids: { id: string }[];
  if (kind === "tools") {
    let query = tx
      .selectFrom("toolCalls")
      .select("id")
      .where("threadId", "=", scope.threadId)
      .where(sql<boolean>`status='open'`);
    query = nodeId ? query.where("nodeId", "=", nodeId) : query.where("nodeId", "is", null);
    if (beforeId) query = query.where("id", ">", beforeId);
    ids = await query.orderBy("id").limit(candidatesLimit).execute();
  } else {
    const after = beforeId ? sql`and id>${beforeId}` : sql``;
    if (nodeId) {
      ids = (
        await sql<{ id: string }>`
        select id from execution_nodes where parent_node_id=${nodeId} and status='running' ${after}
        order by id limit ${candidatesLimit}
      `.execute(tx)
      ).rows;
    } else {
      const active = (activeRuns ?? (await activeRunQueue(tx, scope.threadId))).map(({ id }) => id);
      ids = active.length
        ? (
            await sql<{ id: string }>`
        select child.id from unnest(${active}::text[]) as run(id)
        cross join lateral (
          select id from execution_nodes where run_id=run.id and parent_node_id is null and status='running' ${after}
          order by id limit ${candidatesLimit}
        ) child order by child.id limit ${candidatesLimit}
      `.execute(tx)
          ).rows
        : [];
    }
  }
  const prefix = kind === "tools" ? "tool:" : "node:";
  const cards = ids.length
    ? await drawableItems(tx, scope)
        .where(
          "id",
          "in",
          ids.map(({ id }) => prefix + id),
        )
        .execute()
    : [];
  const byId = new Map(cards.map((card) => [card.id, itemView(card)]));
  const selected = boundedSerializedPrefix(
    ids.map(({ id }) => ({ id, value: byId.get(prefix + id) ?? null })),
    limit,
    budget,
  );
  const result = page(ids.length, selected.items);
  return {
    kind,
    ...result,
    items: result.items.filter((item) => item !== null),
  };
}

export function readTranscriptOverlays(
  database: Kysely<DatabaseSchema>,
  input: {
    viewerId: UserId;
    scope: DetailScope;
    kind: TranscriptOverlayKind;
    cursor?: string;
  },
) {
  return withPersonalSyncRead(database, async (tx) => {
    const state = await authorizedSyncState(tx, input.viewerId);
    const thread = await authorizedDetail(tx, input.viewerId, input.scope);
    if (!thread) return { kind: "unavailable" as const };
    const address = {
      deploymentId: state.deploymentId,
      epoch: state.epoch,
      viewerId: input.viewerId,
      threadId: thread.id,
      nodeId: input.scope.kind === "node" ? input.scope.nodeId : null,
      revision: thread.revision,
    };
    const cursor = input.cursor ? decodeOverlayCursor(input.cursor) : undefined;
    if (
      cursor &&
      (cursor.deploymentId !== address.deploymentId ||
        cursor.viewerId !== address.viewerId ||
        cursor.threadId !== address.threadId ||
        cursor.nodeId !== address.nodeId ||
        cursor.kind !== input.kind)
    )
      throw new OpensteerError({
        code: "forbidden",
        message: "The overlay cursor belongs to another scope",
      });
    if (cursor && (cursor.epoch !== address.epoch || cursor.revision !== address.revision))
      return { kind: "overlay-reset" as const, revision: address.revision };
    const overlay = await overlayPage(
      tx,
      input.scope,
      address,
      input.kind,
      undefined,
      undefined,
      cursor?.beforeId,
    );
    return {
      kind: "overlay" as const,
      revision: state.sequence,
      entries: overlay.items,
      next: overlay.nextBefore ? encodeOverlayCursor(overlay.nextBefore) : null,
    };
  });
}
