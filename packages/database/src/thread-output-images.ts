import {
  SequenceSchema,
  ToolOutputImageSchema,
  type Sequence,
  type ThreadId,
  type UserId,
} from "@opensteer/core";
import { sql, type Kysely } from "kysely";
import type { DatabaseSchema } from "./schema.js";
import { requirePersonalOwner } from "./personal-settings-store.js";
import { withPersonalReadTransaction } from "./personal-transaction.js";

export async function admitTranscriptFiles(
  database: Kysely<DatabaseSchema>,
  input: { ownerId: UserId; threadId: ThreadId | null },
) {
  return withPersonalReadTransaction(database, async (tx) => {
    await requirePersonalOwner(tx, input.ownerId);
    if (input.threadId === null) return true;
    return !!(await tx
      .selectFrom("threads")
      .select("id")
      .where("id", "=", input.threadId)
      .where("createdBy", "=", input.ownerId)
      .executeTakeFirst());
  });
}
function outputs(database: Kysely<DatabaseSchema>, input: { ownerId: UserId; threadId: ThreadId }) {
  return database
    .selectFrom("deploymentEvents")
    .innerJoin("threads", "threads.id", "deploymentEvents.threadId")
    .innerJoin("personalSettings", "personalSettings.ownerId", "threads.createdBy")
    .innerJoin("users", "users.id", "personalSettings.ownerId")
    .where("personalSettings.ownerId", "=", input.ownerId)
    .where("users.disabledAt", "is", null)
    .where("threads.id", "=", input.threadId)
    .where("deploymentEvents.type", "=", "tool.completed");
}
/** Exact persisted image metadata only; a cache pathname by itself grants nothing. */
export async function resolveThreadOutputImages(
  database: Kysely<DatabaseSchema>,
  input: {
    ownerId: UserId;
    threadId: ThreadId;
    paths: readonly string[];
  },
) {
  if (input.paths.length > 32) throw new Error("Too many output image paths");
  if (!input.paths.length) return [];
  const rows = await outputs(database, input)
    .innerJoinLateral(
      sql<{ path: string; mediaType: string; index: string }>`(
      select image->>'path' as path, image->>'mediaType' as "mediaType", (ordinality - 1)::text as index
      from jsonb_array_elements(coalesce(data->'output'->'images', '[]'::jsonb)) with ordinality as images(image, ordinality)
    )`.as("image"),
      (join) => join.onTrue(),
    )
    .select(["deploymentEvents.sequence", "image.index", "image.path", "image.mediaType"])
    .where("image.path", "in", [...input.paths])
    .distinctOn("image.path")
    .orderBy("image.path")
    .orderBy("deploymentEvents.sequence", "desc")
    .execute();
  return rows.flatMap((row) => {
    const image = ToolOutputImageSchema.safeParse({ path: row.path, mediaType: row.mediaType });
    return image.success
      ? [{ sequence: SequenceSchema.parse(row.sequence), index: Number(row.index), ...image.data }]
      : [];
  });
}
export async function resolveThreadOutputImage(
  database: Kysely<DatabaseSchema>,
  input: {
    ownerId: UserId;
    threadId: ThreadId;
    path: string;
  },
) {
  return (await resolveThreadOutputImages(database, { ...input, paths: [input.path] }))[0] ?? null;
}
export async function readThreadOutputImage(
  database: Kysely<DatabaseSchema>,
  input: {
    ownerId: UserId;
    threadId: ThreadId;
    sequence: Sequence;
    index: number;
  },
) {
  const row = await outputs(database, input)
    .select(sql<unknown>`data->'output'->'images'->${input.index}::int`.as("image"))
    .where("deploymentEvents.sequence", "=", input.sequence)
    .executeTakeFirst();
  const image = ToolOutputImageSchema.safeParse(row?.image);
  return image.success ? image.data : null;
}
