import {
  createId,
  OpensteerError,
  type DeploymentId,
  type TeamChannelId,
  type TeamMessageId,
  type UserId,
} from "@opensteer/core";
import { TeamShareFileSchema, type TeamShareFile } from "@opensteer/protocol";
import { sql, type Selectable, type Transaction } from "kysely";
import type { DatabaseSchema, TeamBlobTable, TeamMessageAttachmentTable } from "./schema.js";
import { shareNotFound } from "./team-share-access.js";

type Tx = Transaction<DatabaseSchema>;

export function teamShareFileView(
  row: Selectable<TeamBlobTable>,
  teamId: DeploymentId,
): TeamShareFile {
  return TeamShareFileSchema.parse({
    publicId: row.publicId,
    teamId,
    filename: row.filename,
    mediaType: row.verifiedType ?? row.declaredType,
    sizeBytes: Number(row.sizeBytes),
    sha256: row.sha256,
    preview: row.previewStorageKey
      ? {
          mediaType: row.previewMediaType,
          sizeBytes: Number(row.previewSizeBytes),
          sha256: row.previewSha256,
        }
      : null,
  });
}

export async function exportTeamShareFiles(t: Tx, ids: TeamMessageId[]) {
  if (!ids.length) return new Map<TeamMessageId, TeamShareFile[]>();
  const rows = await t
    .selectFrom("teamMessageAttachments as a")
    .innerJoin("teamBlobs as b", "b.id", "a.blobId")
    .innerJoin("teamPrincipals as p", "p.id", "b.uploaderUserId")
    .selectAll("b")
    .select(["a.messageId", "p.homeTeamId"])
    .where("a.messageId", "in", ids)
    .where("b.state", "=", "ready")
    .orderBy("a.position")
    .execute();
  const result = new Map<TeamMessageId, TeamShareFile[]>();
  for (const row of rows) {
    const files = result.get(row.messageId) ?? [];
    files.push(teamShareFileView(row, row.homeTeamId));
    result.set(row.messageId, files);
  }
  return result;
}

export async function bindTeamShareFiles(
  t: Tx,
  teamId: DeploymentId,
  channelId: TeamChannelId,
  shareId: string,
  messages: readonly {
    id: TeamMessageId;
    authorId: UserId;
    authorKind: "human" | "agent";
    authorTeamId: DeploymentId;
    files: readonly TeamShareFile[];
  }[],
) {
  if (!messages.length) return false;
  const ids = messages.map((m) => m.id).sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
  const files = messages.flatMap((m) => m.files.map((file) => ({ file, message: m })));
  const publicIds = files.map(({ file }) => file.publicId);
  if (new Set(publicIds).size !== publicIds.length) shareNotFound();
  const priorShare = files.some(({ file }) => file.teamId === teamId)
    ? await t
        .selectFrom("teamShares as s")
        .innerJoin("teamShares as previous", "previous.id", "s.historyFromShareId")
        .select("previous.channelId")
        .where("s.id", "=", shareId)
        .executeTakeFirst()
    : undefined;
  const existing = await t
    .selectFrom("teamBlobs")
    .selectAll()
    .where((eb) =>
      eb.or([
        eb.and([
          eb("channelId", "=", channelId),
          eb.or([
            ...(publicIds.length ? [eb("publicId", "in", publicIds)] : []),
            eb(
              "id",
              "in",
              eb
                .selectFrom("teamMessageAttachments")
                .select("blobId")
                .where("messageId", "in", ids),
            ),
          ]),
        ]),
        ...(publicIds.length && priorShare?.channelId
          ? [
              eb.and([
                eb("channelId", "=", priorShare.channelId),
                eb("publicId", "in", publicIds),
                eb("remoteShareId", "is", null),
                eb("state", "=", "ready"),
              ]),
            ]
          : []),
      ]),
    )
    .orderBy("id")
    .forNoKeyUpdate()
    .execute();
  const byPublic = new Map(
    existing.filter((r) => r.channelId === channelId).map((r) => [r.publicId, r]),
  );
  const insert: Selectable<TeamBlobTable>[] = [];
  const bindings: Selectable<TeamMessageAttachmentTable>[] = [];
  for (const { file, message } of files) {
    if (file.teamId !== message.authorTeamId) shareNotFound();
    let row = byPublic.get(file.publicId);
    if (row) {
      if (
        row.state !== "ready" ||
        row.uploaderUserId !== message.authorId ||
        row.uploaderKind !== message.authorKind ||
        JSON.stringify(teamShareFileView(row, file.teamId)) !== JSON.stringify(file)
      )
        shareNotFound();
    } else {
      const id = createId("teamBlob");
      const source =
        file.teamId === teamId
          ? existing.find(
              (r) =>
                r.channelId === priorShare?.channelId &&
                r.publicId === file.publicId &&
                !r.remoteShareId,
            )
          : undefined;
      if (
        file.teamId === teamId &&
        (!source ||
          source.uploaderUserId !== message.authorId ||
          source.uploaderKind !== message.authorKind ||
          JSON.stringify(teamShareFileView(source, teamId)) !== JSON.stringify(file))
      )
        shareNotFound();
      row = {
        cacheOriginalReserved: false,
        cachePreviewReserved: false,
        id,
        publicId: file.publicId,
        remoteShareId: source ? null : shareId,
        channelId,
        uploaderUserId: message.authorId,
        uploaderKind: message.authorKind,
        agentRequestId: null,
        agentLinkId: null,
        personalDeploymentId: null,
        callerRunId: null,
        operationId: null,
        clientUploadId: file.publicId,
        storageKey: source?.storageKey ?? id,
        filename: file.filename,
        declaredType: file.mediaType,
        verifiedType: file.mediaType,
        sizeBytes: file.sizeBytes,
        sha256: file.sha256,
        state: "ready",
        receivedBytes: 0,
        previewStorageKey: source?.previewStorageKey ?? (file.preview ? `${id}-preview` : null),
        previewMediaType: file.preview?.mediaType ?? null,
        previewSizeBytes: file.preview?.sizeBytes ?? null,
        previewSha256: file.preview?.sha256 ?? null,
        createdAt: new Date(),
        expiresAt: new Date(),
        completedAt: new Date(),
      };
      insert.push(row);
    }
    bindings.push({
      messageId: message.id,
      position: message.files.indexOf(file),
      blobId: row.id,
      channelId,
      createdAt: new Date(),
    });
  }
  if (insert.length) {
    const { bytes } = await t
      .selectFrom("teamBlobs")
      .select(sql<string>`coalesce(sum(size_bytes + coalesce(preview_size_bytes,0)),0)`.as("bytes"))
      .where("channelId", "=", channelId)
      .where("remoteShareId", "is not", null)
      .where("state", "!=", "deleting")
      .executeTakeFirstOrThrow();
    if (
      Number(bytes) + insert.reduce((n, r) => n + r.sizeBytes + (r.previewSizeBytes ?? 0), 0) >
      1024 * 1024 * 1024
    )
      throw new OpensteerError({
        code: "resource_exhausted",
        reason: "shared-channel-file-storage-full",
        message:
          "This shared channel's file limit is full. Delete messages with files to free space.",
      });
    await t.insertInto("teamBlobs").values(insert).execute();
  }
  await t
    .selectFrom("teamMessageAttachments")
    .select(["messageId", "position"])
    .where("messageId", "in", ids)
    .orderBy("messageId")
    .orderBy("position")
    // FOR UPDATE: Applying owner rows replaces their attachment bindings.
    .forUpdate()
    .execute();
  await t.deleteFrom("teamMessageAttachments").where("messageId", "in", ids).execute();
  if (bindings.length) await t.insertInto("teamMessageAttachments").values(bindings).execute();
  const removed = existing.filter(
    (r) => r.channelId === channelId && !bindings.some((b) => b.blobId === r.id),
  );
  if (removed.length)
    await t
      .updateTable("teamBlobs")
      .set({ state: "deleting" })
      .where(
        "id",
        "in",
        removed.map((r) => r.id),
      )
      .execute();
  return removed.length > 0;
}
