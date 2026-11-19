import type { ExecutionNodeId, ThreadId, UserId } from "@opensteer/core";
import type { Kysely } from "kysely";
import { readPersonalToolImage, resolvePersonalToolImages } from "./personal-tool-images.js";
import {
  authorizedDetail,
  authorizedSyncState,
  withPersonalSyncRead,
} from "./personal-sync-store.js";
import type { DatabaseSchema } from "./schema.js";

type ImageScope = { ownerId: UserId; threadId: ThreadId; nodeId?: ExecutionNodeId };

export function admitTranscriptFiles(
  database: Kysely<DatabaseSchema>,
  input: { ownerId: UserId; threadId: ThreadId | null },
) {
  return withPersonalSyncRead(database, async (tx) => {
    await authorizedSyncState(tx, input.ownerId);
    return (
      input.threadId === null ||
      Boolean(
        await authorizedDetail(tx, input.ownerId, { kind: "thread", threadId: input.threadId }),
      )
    );
  });
}

export function resolveThreadOutputImages(
  database: Kysely<DatabaseSchema>,
  { ownerId, ...input }: ImageScope & { paths: readonly string[] },
) {
  return resolvePersonalToolImages(database, {
    ...input,
    viewerId: ownerId,
    includeNodeOutputs: !input.nodeId,
  });
}

export async function resolveThreadOutputImage(
  database: Kysely<DatabaseSchema>,
  { path, ...input }: ImageScope & { path: string },
) {
  return (await resolveThreadOutputImages(database, { ...input, paths: [path] }))[0] ?? null;
}

export function readThreadOutputImage(
  database: Kysely<DatabaseSchema>,
  { ownerId, ...input }: ImageScope & { imageId: string },
) {
  return readPersonalToolImage(database, {
    ...input,
    viewerId: ownerId,
    includeNodeOutputs: !input.nodeId,
  });
}
