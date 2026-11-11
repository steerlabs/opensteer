import {
  createId,
  type TeamActor,
  type TeamAgentRequestId,
  type TeamBlobId,
  type TeamChannelId,
  type TeamMessageId,
} from "@opensteer/core";
import { TeamFileSchema, TeamBinaryUploadMetadataSchema } from "@opensteer/protocol";
import type { Selectable, Transaction } from "kysely";
import type { z } from "zod";
import type { DatabaseSchema, TeamBlobTable, TeamMessageTable } from "./schema.js";
import { TeamAccessStore, requireTeam } from "./team-access-store.js";
import { appendTeamAudit } from "./team-audit-store.js";

export function teamFileView(row: Selectable<TeamBlobTable>) {
  return TeamFileSchema.parse({
    id: row.id,
    channelId: row.channelId,
    filename: row.filename,
    mediaType: row.verifiedType ?? row.declaredType,
    sizeBytes: Number(row.sizeBytes),
    sha256: row.sha256,
    preview: row.previewStorageKey
      ? { mediaType: row.previewMediaType, sizeBytes: Number(row.previewSizeBytes) }
      : null,
  });
}
export async function bindTeamFiles(
  transaction: Transaction<DatabaseSchema>,
  actor: TeamActor,
  message: Selectable<TeamMessageTable>,
  ids: readonly TeamBlobId[],
) {
  requireTeam(ids.length <= 10 && new Set(ids).size === ids.length, "Invalid attachments");
  if (!ids.length) return;
  const rows = await transaction
    .selectFrom("teamBlobs")
    .selectAll()
    .where("id", "in", [...ids].sort())
    .orderBy("id")
    .forNoKeyUpdate()
    .execute();
  requireTeam(rows.length === ids.length);
  for (const row of rows)
    requireTeam(
      row.state === "ready" &&
        row.channelId === message.channelId &&
        row.uploaderUserId === actor.userId &&
        row.uploaderKind === actor.kind &&
        (actor.kind === "human" || row.agentRequestId === message.agentRequestId),
      "File cannot be attached to this message",
    );
  await transaction
    .insertInto("teamMessageAttachments")
    .values(
      ids.map((blobId, position) => ({
        messageId: message.id,
        position,
        blobId,
        channelId: message.channelId,
        createdAt: new Date(),
      })),
    )
    .execute();
}
async function activeUploadRequest(
  transaction: Transaction<DatabaseSchema>,
  access: TeamAccessStore,
  actor: TeamActor,
  channelId: TeamChannelId,
  requestId?: TeamAgentRequestId,
) {
  if (actor.kind === "human") {
    requireTeam(!requestId);
    return;
  }
  requireTeam(requestId);
  const request = await transaction
    .selectFrom("teamAgentRequests as r")
    .innerJoin("teamLinks as l", "l.id", "r.linkId")
    .selectAll("r")
    .where("r.id", "=", requestId)
    .where("r.ownerUserId", "=", actor.userId)
    .where("r.channelId", "=", channelId)
    .where("r.state", "in", ["working", "needs_you"])
    .where("r.expiresAt", ">", new Date())
    .where("l.state", "=", "active")
    .executeTakeFirst();
  requireTeam(
    request && (await access.channel(transaction, actor, channelId)).post,
    "Active request required",
  );
}

export class TeamFilesStore {
  readonly access: TeamAccessStore;
  constructor(access: TeamAccessStore) {
    this.access = access;
  }
  async begin(
    actor: TeamActor,
    channelId: TeamChannelId,
    metadata: z.infer<typeof TeamBinaryUploadMetadataSchema>,
    requestId?: TeamAgentRequestId,
  ) {
    metadata = TeamBinaryUploadMetadataSchema.parse(metadata);
    return this.access.contentWrite(actor, channelId, async (t, a) => {
      requireTeam(a.post);
      await activeUploadRequest(t, this.access, actor, channelId, requestId);
      const prior = await t
        .selectFrom("teamBlobs")
        .selectAll()
        .where("channelId", "=", channelId)
        .where("uploaderUserId", "=", actor.userId)
        .where("clientUploadId", "=", metadata.clientUploadId)
        .executeTakeFirst();
      if (prior) {
        requireTeam(
          prior.uploaderKind === actor.kind && prior.agentRequestId === (requestId ?? null),
        );
        requireTeam(
          Number(prior.sizeBytes) === metadata.sizeBytes &&
            prior.sha256 === metadata.sha256 &&
            prior.filename === metadata.filename &&
            prior.declaredType === metadata.mediaType,
          "Upload identity already names different bytes",
        );
        return prior;
      }
      const id = createId("teamBlob");
      return t
        .insertInto("teamBlobs")
        .values({
          id,
          channelId,
          uploaderUserId: actor.userId,
          uploaderKind: actor.kind,
          agentRequestId: requestId ?? null,
          clientUploadId: metadata.clientUploadId,
          storageKey: id,
          filename: metadata.filename,
          declaredType: metadata.mediaType,
          verifiedType: null,
          sizeBytes: metadata.sizeBytes,
          sha256: metadata.sha256,
          state: "uploading",
          previewStorageKey: null,
          previewMediaType: null,
          previewSizeBytes: null,
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + 86400000),
          completedAt: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    });
  }
  async complete(
    actor: TeamActor,
    id: TeamBlobId,
    input: {
      receivedBytes: number;
      sha256: string;
      verifiedType: string;
      previewMediaType: "image/png" | "image/jpeg" | "image/webp" | null;
      previewSizeBytes: number;
      previewStorageKey: string | null;
    },
  ) {
    const observed = await this.access.database
      .selectFrom("teamBlobs")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    return this.access.contentWrite(actor, observed.channelId, async (t, a) => {
      requireTeam(a.post);
      await activeUploadRequest(
        t,
        this.access,
        actor,
        observed.channelId,
        observed.agentRequestId ?? undefined,
      );
      const row = await t
        .selectFrom("teamBlobs")
        .selectAll()
        .where("id", "=", id)
        .forNoKeyUpdate()
        .executeTakeFirstOrThrow();
      requireTeam(
        row.uploaderUserId === actor.userId &&
          row.uploaderKind === actor.kind &&
          row.state !== "deleting",
      );
      if (row.state === "ready") return teamFileView(row);
      requireTeam(
        input.receivedBytes === Number(row.sizeBytes) &&
          input.sha256 === row.sha256 &&
          input.previewSizeBytes <= 65536,
        "File size or digest mismatch",
      );
      const complete = await t
        .updateTable("teamBlobs")
        .set({
          state: "ready",
          receivedBytes: input.receivedBytes,
          verifiedType: input.verifiedType,
          previewStorageKey: input.previewStorageKey,
          previewMediaType: input.previewMediaType,
          previewSizeBytes: input.previewSizeBytes || null,
          completedAt: new Date(),
        })
        .where("id", "=", id)
        .returningAll()
        .executeTakeFirstOrThrow();
      if (actor.kind === "agent")
        await appendTeamAudit(t, {
          actor,
          action: "agent.file.upload",
          resourceKind: "file",
          resourceId: id,
          channelId: row.channelId,
          requestId: row.agentRequestId ?? undefined,
        });
      return teamFileView(complete);
    });
  }
  async cancel(actor: TeamActor, id: TeamBlobId) {
    const row = await this.access.database
      .selectFrom("teamBlobs")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    await this.access.contentWrite(actor, row.channelId, async (t, a) => {
      requireTeam(a.post && row.uploaderUserId === actor.userId && row.uploaderKind === actor.kind);
      const bound = await t
        .selectFrom("teamMessageAttachments")
        .select("blobId")
        .where("blobId", "=", id)
        .executeTakeFirst();
      requireTeam(!bound, "A sent attachment cannot be cancelled");
      await t.updateTable("teamBlobs").set({ state: "deleting" }).where("id", "=", id).execute();
    });
  }
  async authorized(actor: TeamActor, id: TeamBlobId, requestId?: TeamAgentRequestId) {
    return this.access.database
      .transaction()
      .execute(async (t) => {
        await this.access.checkSession(t);
        const row = await t
          .selectFrom("teamBlobs")
          .selectAll()
          .where("id", "=", id)
          .where("state", "=", "ready")
          .executeTakeFirst();
        requireTeam(row);
        requireTeam((await this.access.channel(t, actor, row.channelId)).read);
        const bound = await t
          .selectFrom("teamMessageAttachments as a")
          .innerJoin("teamMessages as m", "m.id", "a.messageId")
          .select("a.messageId")
          .where("a.blobId", "=", id)
          .where("m.deletedAt", "is", null)
          .executeTakeFirst();
        requireTeam(bound, "Only sent attachments can be downloaded");
        if (actor.kind === "agent") {
          requireTeam(requestId);
          const request = await t
            .selectFrom("teamAgentRequests as r")
            .innerJoin("teamLinks as l", "l.id", "r.linkId")
            .selectAll("r")
            .where("r.id", "=", requestId)
            .where("r.ownerUserId", "=", actor.userId)
            .where("r.state", "in", ["working", "needs_you"])
            .where("r.expiresAt", ">", new Date())
            .where("l.state", "=", "active")
            .executeTakeFirst();
          requireTeam(request && (await this.access.channel(t, actor, request.channelId)).read);
          await appendTeamAudit(t, {
            actor,
            action: "agent.file.read",
            resourceKind: "file",
            resourceId: id,
            channelId: row.channelId,
            requestId,
            linkId: request.linkId,
          });
        }
        return { ...row, messageId: bound.messageId };
      })
      .catch(async (error: unknown) => {
        if (actor.kind === "agent")
          await appendTeamAudit(this.access.database, {
            actor,
            action: "agent.file.read",
            resourceKind: "file",
            resourceId: id,
            outcome: "denied",
          });
        throw error;
      });
  }
  async page(actor: TeamActor, channelId: TeamChannelId, before?: TeamMessageId) {
    return this.access.database.transaction().execute(async (t) => {
      requireTeam((await this.access.channel(t, actor, channelId)).read);
      let messages = t
        .selectFrom("teamMessageAttachments as a")
        .innerJoin("teamMessages as m", "m.id", "a.messageId")
        .select("a.messageId")
        .distinct()
        .where("a.channelId", "=", channelId)
        .where("m.deletedAt", "is", null);
      if (before) messages = messages.where("a.messageId", "<", before);
      const ids = await messages.orderBy("a.messageId", "desc").limit(6).execute();
      const rows = ids.length
        ? await t
            .selectFrom("teamBlobs as b")
            .innerJoin("teamMessageAttachments as a", "a.blobId", "b.id")
            .selectAll("b")
            .select("a.messageId")
            .where(
              "a.messageId",
              "in",
              ids.slice(0, 5).map((r) => r.messageId),
            )
            .orderBy("a.messageId", "desc")
            .orderBy("a.position")
            .execute()
        : [];
      if (actor.kind === "agent")
        await appendTeamAudit(t, {
          actor,
          action: "agent.files",
          resourceKind: "channel",
          resourceId: channelId,
          channelId,
        });
      return {
        files: rows.map((r) => ({ messageId: r.messageId, file: teamFileView(r) })),
        hasMore: ids.length > 5,
      };
    });
  }
}
