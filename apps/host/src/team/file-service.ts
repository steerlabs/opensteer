import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { link, mkdir, open, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { TeamActor, TeamAgentRequestId, TeamBlobId, TeamChannelId } from "@opensteer/core";
import type { TeamBinaryUploadMetadataSchema } from "@opensteer/protocol";
import { teamPreviewMaxBytes, teamUploadMaxBytes } from "@opensteer/protocol";
import { TeamFilesStore } from "@opensteer/database/team-files";
import { requireTeam, type TeamAccessStore } from "@opensteer/database/team-access";
import type { z } from "zod";
import sharp from "sharp";

interface ActiveFileTransfer {
  readonly actor: TeamActor;
  readonly channelId: TeamChannelId;
  readonly requestId?: TeamAgentRequestId;
  readonly controller: AbortController;
  readonly authorize: () => Promise<boolean>;
}
export class TeamFileService {
  readonly #directory: string;
  readonly #active = new Set<ActiveFileTransfer>();
  readonly #uploads = new Set<TeamBlobId>();
  readonly #unsubscribe: () => void;
  readonly store: TeamFilesStore;
  readonly access: TeamAccessStore;
  constructor(store: TeamFilesStore, access: TeamAccessStore, dataDirectory: string) {
    this.store = store;
    this.access = access;
    this.#directory = join(dataDirectory, "team-files");
    this.#unsubscribe = access.onRevoke(async (effects) => {
      await Promise.all(
        [...this.#active].map(async (transfer) => {
          try {
            if (!effects.users.includes(transfer.actor.userId) && (await transfer.authorize()))
              return;
          } catch {}
          transfer.controller.abort(new Error("Team file access revoked"));
          this.#active.delete(transfer);
        }),
      );
    });
  }
  async upload(
    actor: TeamActor,
    channelId: TeamChannelId,
    metadata: z.infer<typeof TeamBinaryUploadMetadataSchema>,
    parts: { original: AsyncIterable<Uint8Array>; preview?: AsyncIterable<Uint8Array> },
    requestId?: TeamAgentRequestId,
    signal?: AbortSignal,
  ) {
    requireTeam(
      !metadata.mediaType.startsWith("image/") || metadata.previewSizeBytes > 0,
      "Image preview required",
    );
    const row = await this.store.begin(actor, channelId, metadata, requestId);
    requireTeam(row.state !== "deleting");
    requireTeam(!this.#uploads.has(row.id), "Upload already in progress");
    this.#uploads.add(row.id);
    const controller = new AbortController();
    const authorize = () =>
      this.access.database.transaction().execute(async (t) => {
        if (!(await this.access.channel(t, actor, channelId)).post) return false;
        if (requestId)
          return !!(await t
            .selectFrom("teamAgentRequests as r")
            .innerJoin("teamLinks as l", "l.id", "r.linkId")
            .select("r.id")
            .where("r.id", "=", requestId)
            .where("r.ownerUserId", "=", actor.userId)
            .where("r.state", "in", ["working", "needs_you"])
            .where("r.expiresAt", ">", new Date())
            .where("l.state", "=", "active")
            .executeTakeFirst());
        return true;
      });
    const transfer: ActiveFileTransfer = {
      actor,
      channelId,
      controller,
      authorize,
      ...(requestId ? { requestId } : {}),
    };
    this.#active.add(transfer);
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const pending = join(this.#directory, `pending-${randomUUID()}`);
    const pendingPreview = `${pending}-preview`;
    const final = join(this.#directory, row.storageKey),
      previewFinal = `${final}-preview`;
    let installed = false;
    try {
      await mkdir(this.#directory, { recursive: true, mode: 0o700 });
      const original = await this.#write(
        pending,
        parts.original,
        metadata.sizeBytes,
        teamUploadMaxBytes,
        combined,
      );
      let previewMediaType: "image/jpeg" | "image/png" | "image/webp" | null = null;
      if (metadata.previewSizeBytes) {
        requireTeam(
          parts.preview && metadata.mediaType.startsWith("image/"),
          "Image preview required",
        );
        await this.#write(
          pendingPreview,
          parts.preview,
          metadata.previewSizeBytes,
          teamPreviewMaxBytes,
          combined,
        );
        const info = await sharp(pendingPreview, { limitInputPixels: 1024 * 1024 }).metadata();
        requireTeam(
          info.width &&
            info.height &&
            info.width <= 1024 &&
            info.height <= 1024 &&
            ["jpeg", "png", "webp"].includes(info.format ?? ""),
          "Invalid image preview",
        );
        previewMediaType =
          info.format === "jpeg"
            ? "image/jpeg"
            : info.format === "png"
              ? "image/png"
              : "image/webp";
      } else requireTeam(!parts.preview, "Unexpected preview");
      combined.throwIfAborted();
      requireTeam(await authorize());
      try {
        await link(pending, final);
        installed = true;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      }
      if (metadata.previewSizeBytes)
        try {
          await link(pendingPreview, previewFinal);
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
        }
      return await this.store.complete(actor, row.id, {
        receivedBytes: original.size,
        sha256: original.sha256,
        verifiedType: metadata.mediaType,
        previewSizeBytes: metadata.previewSizeBytes,
        previewMediaType,
        previewStorageKey: metadata.previewSizeBytes ? `${row.storageKey}-preview` : null,
      });
    } catch (error) {
      if (installed) {
        await rm(final, { force: true });
        await rm(previewFinal, { force: true });
      }
      throw error;
    } finally {
      this.#uploads.delete(row.id);
      this.#active.delete(transfer);
      await rm(pending, { force: true });
      await rm(pendingPreview, { force: true });
    }
  }
  async #write(
    path: string,
    body: AsyncIterable<Uint8Array>,
    expected: number,
    maximum: number,
    signal: AbortSignal,
  ) {
    const file = await open(path, "wx", 0o600);
    const hash = createHash("sha256");
    let size = 0;
    const iterator = body[Symbol.asyncIterator]();
    const cancelled = Promise.withResolvers<never>();
    const abort = () => {
      cancelled.reject(signal.reason ?? new Error("Upload cancelled"));
      if (body instanceof Readable) body.destroy();
    };
    try {
      signal.throwIfAborted();
      signal.addEventListener("abort", abort, { once: true });
      for (;;) {
        const next = await Promise.race([iterator.next(), cancelled.promise]);
        if (next.done) break;
        const chunk = next.value;
        signal.throwIfAborted();
        size += chunk.byteLength;
        requireTeam(size <= expected && size <= maximum, "Upload exceeds fixed byte limit");
        hash.update(chunk);
        let offset = 0;
        while (offset < chunk.byteLength) {
          const { bytesWritten } = await file.write(chunk, offset, chunk.byteLength - offset);
          requireTeam(bytesWritten > 0);
          offset += bytesWritten;
        }
      }
      requireTeam(size === expected, "Upload size mismatch");
      await file.sync();
      return { size, sha256: hash.digest("hex") };
    } finally {
      signal.removeEventListener("abort", abort);
      if (signal.aborted) void iterator.return?.().catch(() => {});
      await file.close();
    }
  }
  async download(
    actor: TeamActor,
    id: TeamBlobId,
    part: "original" | "preview",
    requestId?: TeamAgentRequestId,
    signal?: AbortSignal,
  ): Promise<{ body: Readable; sizeBytes: number; headers: Record<string, string> }> {
    const revision = this.access.revision;
    const row = await this.store.authorized(actor, id, requestId);
    requireTeam(part === "original" || row.previewStorageKey, "No image preview");
    const controller = new AbortController();
    let stream: Readable | undefined;
    const transfer: ActiveFileTransfer = {
      actor,
      channelId: row.channelId,
      ...(requestId ? { requestId } : {}),
      controller,
      authorize: async () => {
        await this.store.authorized(actor, id, requestId);
        return true;
      },
    };
    this.#active.add(transfer);
    try {
      return await this.access.handoff(revision, transfer.authorize, () => {
        requireTeam(!controller.signal.aborted);
        stream = createReadStream(
          join(this.#directory, part === "original" ? row.storageKey : row.previewStorageKey!),
          {
            highWaterMark: 64 * 1024,
            signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
          },
        );
        stream.once("close", () => this.#active.delete(transfer));
        return {
          body: stream,
          sizeBytes: part === "original" ? Number(row.sizeBytes) : Number(row.previewSizeBytes),
          headers: {
            "content-type":
              part === "original" ? "application/octet-stream" : row.previewMediaType!,
            "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(row.filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16)}`)}`,
            "x-content-type-options": "nosniff",
            "content-security-policy": "sandbox",
            "cache-control": "private, no-store",
          },
        };
      });
    } catch (error) {
      stream?.destroy();
      this.#active.delete(transfer);
      throw error;
    }
  }
  async collectGarbage() {
    await this.access.database
      .updateTable("teamBlobs")
      .set({ state: "deleting" })
      .where("expiresAt", "<", new Date())
      .where(
        "id",
        "not in",
        this.access.database.selectFrom("teamMessageAttachments").select("blobId"),
      )
      .execute();
    const rows = await this.access.database
      .selectFrom("teamBlobs")
      .selectAll()
      .where("state", "=", "deleting")
      .limit(100)
      .execute();
    for (const row of rows) {
      await rm(join(this.#directory, row.storageKey), { force: true });
      if (row.previewStorageKey)
        await rm(join(this.#directory, row.previewStorageKey), { force: true });
      await this.access.database
        .deleteFrom("teamBlobs")
        .where("id", "=", row.id)
        .where("state", "=", "deleting")
        .execute();
    }
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    for (const name of await readdir(this.#directory))
      if (/^pending-[0-9a-f-]{36}(-preview)?$/.test(name)) {
        const path = join(this.#directory, name);
        if ((await stat(path)).mtimeMs < Date.now() - 86400000) await rm(path, { force: true });
      }
  }
  close() {
    this.#unsubscribe();
    for (const transfer of this.#active) transfer.controller.abort();
    this.#active.clear();
  }
}
