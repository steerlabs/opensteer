import { OpensteerError, type ExecutionNodeId, type ThreadId, type UserId } from "@opensteer/core";
import { sql, type Kysely } from "kysely";
import type { PersonalStateSchema, ToolOutputImageTable } from "./personal-state-schema.js";
import {
  authorizedDetail,
  authorizedSyncState,
  withPersonalSyncRead,
} from "./personal-sync-store.js";
import { normalizeToolImagePath, outputImagePathHash } from "./transcript-store.js";

type ImageScope = {
  readonly viewerId: UserId;
  readonly threadId: ThreadId;
  readonly nodeId?: ExecutionNodeId;
};

function scopeOf(input: ImageScope) {
  return input.nodeId
    ? { kind: "node" as const, threadId: input.threadId, nodeId: input.nodeId }
    : { kind: "thread" as const, threadId: input.threadId };
}

type ImageView = Pick<ToolOutputImageTable, "id" | "path" | "mediaType" | "generated">;

export async function resolvePersonalToolImages(
  database: Kysely<PersonalStateSchema>,
  input: ImageScope & { readonly paths: readonly string[] },
) {
  if (input.paths.length > 32)
    throw new OpensteerError({ code: "bad_request", message: "Too many tool output image paths" });
  return withPersonalSyncRead(database, async (tx) => {
    await authorizedSyncState(tx, input.viewerId);
    if (!(await authorizedDetail(tx, input.viewerId, scopeOf(input)))) return [];
    const keys = [
      ...new Set(input.paths.map(normalizeToolImagePath).filter((path) => path !== null)),
    ].map((path) => ({ path, hash: outputImagePathHash(path).toString("hex") }));
    if (!keys.length) return [];
    const byNode = input.nodeId ? sql`image.node_id=${input.nodeId}` : sql`image.node_id is null`;
    const rows = await sql<ImageView>`
      select selected.id,selected.path,selected.media_type,selected.generated
      from jsonb_to_recordset(${JSON.stringify(keys)}::jsonb) as key(path text,hash text)
      cross join lateral (
        select image.id,image.path,image.media_type,image.generated from tool_output_images image
        join tool_calls call on call.id=image.tool_call_id and call.thread_id=image.thread_id
          and call.node_id is not distinct from image.node_id
        where image.thread_id=${input.threadId} and ${byNode}
          and image.path_hash=decode(key.hash,'hex') and image.path=key.path
        order by image.completion_order desc,image.image_index desc limit 1
      ) selected
    `.execute(tx);
    return rows.rows;
  });
}

export async function readPersonalToolImage(
  database: Kysely<PersonalStateSchema>,
  input: ImageScope & { readonly imageId: string },
) {
  return withPersonalSyncRead(database, async (tx) => {
    await authorizedSyncState(tx, input.viewerId);
    if (!(await authorizedDetail(tx, input.viewerId, scopeOf(input)))) return null;
    const query = tx
      .selectFrom("toolOutputImages as image")
      .innerJoin("toolCalls as call", (join) =>
        join
          .onRef("call.id", "=", "image.toolCallId")
          .onRef("call.threadId", "=", "image.threadId")
          .on(sql<boolean>`call.node_id is not distinct from image.node_id`),
      )
      .select(["image.id", "image.path", "image.mediaType", "image.generated"])
      .where("image.id", "=", input.imageId)
      .where("image.threadId", "=", input.threadId);
    return (
      (await (
        input.nodeId
          ? query.where("image.nodeId", "=", input.nodeId)
          : query.where("image.nodeId", "is", null)
      ).executeTakeFirst()) ?? null
    );
  });
}
