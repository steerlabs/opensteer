import {
  createId,
  OpensteerError,
  type TeamActor,
  type TeamAgentRequestId,
  type TeamBlobId,
  type TeamChannelId,
  type TeamMessageId,
  type TeamLinkId,
  type RunId,
} from "@opensteer/core";
import { TeamFileSchema, TeamUploadMetadataSchema, teamPreviewMaxBytes } from "@opensteer/protocol";
import { sql, type ExpressionBuilder, type Selectable, type Transaction } from "kysely";
import type { z } from "zod";
import type { DatabaseSchema, TeamBlobTable, TeamMessageTable } from "./schema.js";
import { TeamAccessStore, requireTeam } from "./team-access-store.js";
import { appendTeamAudit } from "./team-audit-store.js";
import { shareNotFound } from "./team-share-access.js";
export { teamShareFileView } from "./team-share-files-store.js";

export interface TeamFileAgent {
  readonly linkId: TeamLinkId;
  readonly runId: RunId;
  readonly operationId: string;
}

export const teamStorageFullReason = "team-storage-full";
export const teamStorageFullMessage =
  "This team's file storage is full. Deleting messages with files frees space.";

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
        row.uploaderKind === actor.kind,
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

export class TeamFilesStore {
  readonly access: TeamAccessStore;
  /** Bytes every team file may hold together, previews and unfinished uploads included. */
  readonly #storageLimitBytes: number | undefined;
  constructor(access: TeamAccessStore, options: { storageLimitBytes?: number | undefined } = {}) {
    this.access = access;
    this.#storageLimitBytes = options.storageLimitBytes;
  }
  async #lockStorage(t: Transaction<DatabaseSchema>) {
    if (this.#storageLimitBytes !== undefined)
      await sql`select pg_advisory_xact_lock(hashtextextended('team-storage', 0))`.execute(t);
  }
  async #reserveStorage(t: Transaction<DatabaseSchema>, reserved: number) {
    if (this.#storageLimitBytes === undefined) return;
    // Reservations remain charged until their bytes have been removed, including failed uploads.
    const { used } = await t
      .selectFrom(
        t
          .selectFrom("teamBlobs")
          .select([
            "storageKey",
            sql<string>`max(case when remote_share_id is null then
              size_bytes + coalesce(preview_size_bytes, case when state = 'uploading' and declared_type like 'image/%' then ${teamPreviewMaxBytes} else 0 end)
              else (case when cache_original_reserved then size_bytes else 0 end) +
                   (case when cache_preview_reserved then coalesce(preview_size_bytes,0) else 0 end)
              end)`.as("reservedBytes"),
          ])
          .groupBy("storageKey")
          .as("files"),
      )
      .select(sql<string>`coalesce(sum(reserved_bytes),0)`.as("used"))
      .executeTakeFirstOrThrow();
    if (Number(used) + reserved > this.#storageLimitBytes)
      throw new OpensteerError({
        code: "resource_exhausted",
        reason: teamStorageFullReason,
        message: teamStorageFullMessage,
        details: { limitBytes: this.#storageLimitBytes },
      });
  }
  async cacheWrite<Value>(
    id: TeamBlobId,
    write: (t: Transaction<DatabaseSchema>, row: Selectable<TeamBlobTable>) => Promise<Value>,
  ) {
    return this.access.knowledgeWrite(async (t) => {
      await this.#lockStorage(t);
      const row = await t
        .selectFrom("teamBlobs")
        .selectAll()
        .where("id", "=", id)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!row || row.state !== "ready" || !row.remoteShareId || !(await remoteFileShare(t, row)))
        shareNotFound();
      const bound = await t
        .selectFrom("teamMessageAttachments as a")
        .innerJoin("teamMessages as m", "m.id", "a.messageId")
        .select("a.messageId")
        .where("a.blobId", "=", id)
        .where("m.deletedAt", "is", null)
        .executeTakeFirst();
      if (!bound) shareNotFound();
      return write(t, row);
    });
  }
  async reserveCache(id: TeamBlobId, part: "original" | "preview") {
    return this.cacheWrite(id, async (t, row) => {
      const column = part === "original" ? "cacheOriginalReserved" : "cachePreviewReserved";
      if (row[column]) return;
      await this.#reserveStorage(
        t,
        Number(part === "original" ? row.sizeBytes : row.previewSizeBytes),
      );
      await t
        .updateTable("teamBlobs")
        .set({ [column]: true })
        .where("id", "=", id)
        .execute();
    });
  }
  async releaseCache(id: TeamBlobId, part: "original" | "preview") {
    await this.access.database
      .updateTable("teamBlobs")
      .set(part === "original" ? { cacheOriginalReserved: false } : { cachePreviewReserved: false })
      .where("id", "=", id)
      .execute();
  }
  async evictInactiveCaches(remove: (row: Selectable<TeamBlobTable>) => Promise<void>) {
    await this.access.knowledgeWrite(async (t) => {
      const rows = await t
        .selectFrom("teamBlobs")
        .selectAll()
        .where("remoteShareId", "is not", null)
        .where("state", "!=", "deleting")
        .where((e) =>
          e.or([e("cacheOriginalReserved", "=", true), e("cachePreviewReserved", "=", true)]),
        )
        .orderBy("id")
        .forNoKeyUpdate()
        .execute();
      for (const row of rows) {
        if (await remoteFileShare(t, row)) continue;
        await remove(row);
        await t
          .updateTable("teamBlobs")
          .set({ cacheOriginalReserved: false, cachePreviewReserved: false })
          .where("id", "=", row.id)
          .execute();
      }
    });
  }
  async begin(
    actor: TeamActor,
    channelId: TeamChannelId,
    metadata: z.infer<typeof TeamUploadMetadataSchema>,
    requestId?: TeamAgentRequestId,
    agent?: TeamFileAgent,
  ) {
    metadata = TeamUploadMetadataSchema.parse(metadata);
    const image = metadata.mediaType.startsWith("image/");
    requireTeam(
      image === metadata.previewSizeBytes > 0,
      "Only images carry a preview, and need one",
    );
    return this.access.writeForPeer(actor, channelId, async (t, a) => {
      requireTeam(a.post);
      if (actor.kind === "agent") requireTeam(agent);
      else requireTeam(!requestId && !agent);
      const link = agent ? await this.access.link(t, actor, agent.linkId) : undefined;
      const provenance =
        requestId && link
          ? await t
              .selectFrom("teamAgentRequests")
              .select("id")
              .where("id", "=", requestId)
              .where("linkId", "=", link.id)
              .executeTakeFirst()
          : undefined;
      const prior = await t
        .selectFrom("teamBlobs")
        .selectAll()
        .where("channelId", "=", channelId)
        .where("uploaderUserId", "=", actor.userId)
        .where("clientUploadId", "=", metadata.clientUploadId)
        .executeTakeFirst();
      if (prior) {
        requireTeam(
          prior.uploaderKind === actor.kind && prior.agentLinkId === (agent?.linkId ?? null),
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
      await this.#lockStorage(t);
      await this.#reserveStorage(t, metadata.sizeBytes + (image ? teamPreviewMaxBytes : 0));
      const id = createId("teamBlob");
      return t
        .insertInto("teamBlobs")
        .values({
          id,
          channelId,
          uploaderUserId: actor.userId,
          uploaderKind: actor.kind,
          agentRequestId: provenance?.id ?? null,
          agentLinkId: link?.id ?? null,
          personalDeploymentId: link?.personalDeploymentId ?? null,
          callerRunId: agent?.runId ?? null,
          operationId: agent?.operationId ?? null,
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
      previewSha256?: string | null;
    },
  ) {
    const observed = await this.access.database
      .selectFrom("teamBlobs")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    return this.access.writeForPeer(actor, observed.channelId, async (t, a) => {
      requireTeam(a.post);
      let link;
      if (actor.kind === "agent") {
        requireTeam(observed.agentLinkId);
        link = await this.access.link(t, actor, observed.agentLinkId);
      }
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
          input.previewSizeBytes <=
            (row.declaredType.startsWith("image/") ? teamPreviewMaxBytes : 0),
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
          previewSha256: input.previewSha256 ?? null,
          completedAt: new Date(),
        })
        .where("id", "=", id)
        .returningAll()
        .executeTakeFirstOrThrow();
      if (actor.kind === "agent")
        await appendTeamAudit(t, {
          actor,
          action: "file.upload",
          resourceKind: "file",
          resourceId: row.id,
          channelId: row.channelId,
          linkId: link?.id,
          runId: row.callerRunId ?? undefined,
          operationId: row.operationId ?? undefined,
          requestId: row.agentRequestId ?? undefined,
          metadata: { personalDeploymentId: link?.personalDeploymentId ?? null },
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
    await this.access.writeForPeer(actor, row.channelId, async (t, a) => {
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
  /** Marks for removal unsent files no one can send any more: expired, or a removed member's. */
  async abandonUnsent() {
    const unbound = (e: ExpressionBuilder<DatabaseSchema, "teamBlobs">) =>
      e.not(
        e.exists(
          e
            .selectFrom("teamMessageAttachments as a")
            .select("a.blobId")
            .whereRef("a.blobId", "=", "teamBlobs.id"),
        ),
      );
    await this.access.database.transaction().execute(async (t) => {
      const candidates = await t
        .selectFrom("teamBlobs")
        .select("id")
        .where("state", "!=", "deleting")
        .where((e) =>
          e.or([
            e("expiresAt", "<", new Date()),
            e.exists(
              e
                .selectFrom("teamMembers as m")
                .select("m.userId")
                .whereRef("m.userId", "=", "teamBlobs.uploaderUserId")
                .where("m.state", "=", "removed"),
            ),
          ]),
        )
        .where(unbound)
        .orderBy("id")
        // An attach in flight holds its file; a later pass reconsiders it.
        .forNoKeyUpdate()
        .skipLocked()
        .execute();
      if (!candidates.length) return;
      // A new statement sees any attach that committed before these locks were granted.
      await t
        .updateTable("teamBlobs")
        .set({ state: "deleting" })
        .where(
          "id",
          "in",
          candidates.map((row) => row.id),
        )
        .where(unbound)
        .execute();
    });
  }
  async authorized(actor: TeamActor, id: TeamBlobId, agent?: TeamFileAgent, recordRead = false) {
    return this.access.database.transaction().execute(async (t) => {
      let link;
      if (actor.kind === "agent") {
        requireTeam(agent);
        link = await this.access.link(t, actor, agent.linkId);
      }
      await this.access.checkSession(t);
      const row = await t
        .selectFrom("teamBlobs")
        .selectAll()
        .where("id", "=", id)
        .where("state", "=", "ready")
        .executeTakeFirst();
      if (!row) shareNotFound();
      requireTeam((await this.access.peerChannel(t, actor, row.channelId)).read);
      let remoteShareId = row.remoteShareId;
      if (remoteShareId) {
        const share = await remoteFileShare(t, row);
        if (!share) shareNotFound();
        remoteShareId = share.id;
      }
      const bound = await t
        .selectFrom("teamMessageAttachments as a")
        .innerJoin("teamMessages as m", "m.id", "a.messageId")
        .select("a.messageId")
        .where("a.blobId", "=", id)
        .where("m.deletedAt", "is", null)
        .executeTakeFirst();
      if (!bound) shareNotFound();
      if (actor.kind === "agent" && recordRead)
        await appendTeamAudit(t, {
          actor,
          ...agent,
          linkId: link?.id,
          action: "file.read",
          resourceKind: "file",
          resourceId: row.id,
          channelId: row.channelId,
          metadata: { personalDeploymentId: link?.personalDeploymentId ?? null },
        });
      return { ...row, remoteShareId, messageId: bound.messageId };
    });
  }
  async page(actor: TeamActor, channelId: TeamChannelId, before?: TeamMessageId) {
    return this.access.database.transaction().execute(async (t) => {
      requireTeam((await this.access.peerChannel(t, actor, channelId)).read);
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

async function remoteFileShare(t: Transaction<DatabaseSchema>, row: Selectable<TeamBlobTable>) {
  return t
    .selectFrom("teamShares as s")
    .innerJoin("teamPartnerLinks as l", "l.id", "s.partnerLinkId")
    .innerJoin("teamPrincipals as p", (join) =>
      join.on("p.id", "=", row.uploaderUserId).onRef("p.homeTeamId", "=", "l.partnerTeamId"),
    )
    .select("s.id")
    .where("s.channelId", "=", row.channelId)
    .where("s.state", "=", "active")
    .where("l.state", "=", "active")
    .where((eb) =>
      eb.exists(
        eb.selectFrom("teamSharingSettings").select("singletonKey").where("policy", "!=", "off"),
      ),
    )
    .executeTakeFirst();
}
